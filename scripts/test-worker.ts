// Worker tests that need no network and no wrangler: the real src/worker/index.ts is bundled with esbuild
// (only `cloudflare:email` is stubbed), then driven with a D1 shim over node:sqlite and fake bindings.
// Covers the failure modes the local wrangler run cannot stage: a throwing limiter, a row that changes
// between a read and a write. Usage: pnpm test:worker
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const ROOT = resolve(import.meta.dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'gz-test-worker-'));
const stub = join(tmp, 'email-stub.mjs');
writeFileSync(stub, 'export class EmailMessage { constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; } }\n');
const out = join(tmp, 'worker.mjs');
await build({
  entryPoints: [join(ROOT, 'src/worker/index.ts')], outfile: out, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  conditions: ['workerd', 'worker', 'browser'], external: ['node:*'], logLevel: 'warning',
  plugins: [{ name: 'stub-cf-email', setup: (b) => b.onResolve({ filter: /^cloudflare:email$/ }, () => ({ path: stub })) }],
});
const worker = (await import(pathToFileURL(out).href)).default as {
  fetch(r: Request, e: unknown, c: unknown): Promise<Response>;
  email(m: unknown, e: unknown, c: unknown): Promise<void>;
};

// ---- fakes ----
const SHIPPED = 'ShippedCode1';
const MIGRATION = readFileSync(join(ROOT, 'migrations/0001_init.sql'), 'utf8');

/** D1 over node:sqlite. `afterRead` runs once a `first()` has returned its row: the window a concurrent writer can use. */
class FakeD1 {
  db = new DatabaseSync(':memory:');
  afterRead: ((sql: string) => void) | null = null;
  constructor() { this.db.exec(MIGRATION); }
  prepare(sql: string) {
    const st = this.db.prepare(sql);
    const self = this;
    const bound = (args: unknown[]) => ({
          async first() {
            const row = (st.get(...(args as never[])) as Record<string, unknown> | undefined) ?? null;
            const hook = self.afterRead; self.afterRead = null; hook?.(sql);
            return row ? { ...row } : null;
          },
          async run() { const r = st.run(...(args as never[])); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
          async all() { return { results: st.all(...(args as never[])).map((r) => ({ ...(r as object) })) }; },
    });
    return { bind: (...args: unknown[]) => bound(args), ...bound([]) };
  }
  rows(sql: string, ...args: unknown[]) { return this.db.prepare(sql).all(...(args as never[])).map((r) => ({ ...(r as object) })); }
}

const mailer = () => { const sent: Record<string, any>[] = []; return { sent, send: async (m: Record<string, unknown>) => { sent.push(m); return { messageId: `m${sent.length}` }; } }; };
/** A limiter that allows `max` calls per key, like the real one. */
const limiter = (max: number) => { const seen = new Map<string, number>(); const keys: string[] = []; return { keys, limit: async ({ key }: { key: string }) => { keys.push(key); const n = (seen.get(key) ?? 0) + 1; seen.set(key, n); return { success: n <= max }; } }; };
const throwingLimiter = () => ({ limit: async () => { throw new Error('binding exploded'); } });

function makeEnv(over: Record<string, unknown> = {}) {
  const DB = new FakeD1();
  const EMAIL = mailer(); const NOTIFY_OWNER = mailer();
  const env: Record<string, any> = {
    ASSETS: { fetch: async () => Response.json({ codes: [SHIPPED.toLowerCase()] }) },
    DB, EMAIL, NOTIFY_OWNER, SUBMISSIONS_RL: limiter(100), SUBSCRIBE_RL: limiter(100),
    FORM_SUBMIT_ENABLED: '1', EMAIL_SUBMIT_ENABLED: '1', SUBSCRIBE_ENABLED: '1', DIGEST_ENABLED: '0',
    OWNER_ADDRESS: 'owner@example.test', MIN_FILL_MS: '3000', ...over,
  };
  return env;
}
function makeCtx() { const pending: Promise<unknown>[] = []; return { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, drain: async () => { await Promise.all(pending.splice(0)); } }; }

const GOOD = { name: 'Spam Stopper', author: 'Sam', description: 'Blocks spam calls for you.', link: 'https://x.ai/bot/NewBot-12345', category: 'privacy-security-scam-protection', email: 'me@example.test', company_website: '', filled_ms: 5000 };
const call = (path: string, env: unknown, ctx: unknown, init: RequestInit = {}) => worker.fetch(new Request(`https://grokbot.zone${path}`, init), env, ctx);
const postJson = (path: string, env: unknown, ctx: unknown, body: unknown, ip = '9.9.9.9') =>
  call(path, env, ctx, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) });

function fakeMail(over: { from?: string; to?: string; subject?: string; body?: string } = {}) {
  const from = over.from ?? 'author@example.test'; const to = over.to ?? 'submit@grokbot.zone';
  const raw = `From: ${from}\r\nTo: ${to}\r\nSubject: ${over.subject ?? 'My bot'}\r\nMessage-ID: <t1@example.test>\r\n\r\n${over.body ?? 'Helps with taxes.\nhttps://x.ai/bot/FreshOne1'}\r\n`;
  const rejects: string[] = []; const replies: unknown[] = []; const forwards: string[] = [];
  return {
    rejects, replies, forwards,
    msg: {
      from, to, headers: new Headers({ 'message-id': '<t1@example.test>', 'authentication-results': 'mx.cloudflare.net; dmarc=pass' }),
      raw: new Blob([raw]).stream(),
      setReject: (r: string) => { rejects.push(r); }, reply: async (m: unknown) => { replies.push(m); }, forward: async (a: string) => { forwards.push(a); },
    },
  };
}
const sendEmail = async (env: unknown, over?: Parameters<typeof fakeMail>[0]) => { const m = fakeMail(over); await worker.email(m.msg, env, makeCtx()); return m; };

let n = 0; let failed = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); n++; console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${(e as Error).message.split('\n').slice(0, process.env.GZ_VERBOSE ? 12 : 1).join(' | ')}`); }
};
const count = (env: Record<string, any>, table: string) => (env.DB.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0] as { n: number }).n;

// ---- F1: end to end through the form ----
await t('F1 form: forged approve line in description yields one approve: line with the real id', async () => {
  const env = makeEnv(); const ctx = makeCtx();
  const res = await postJson('/api/submit', env, ctx, { ...GOOD, description: 'Looks fine.\napprove:  wrangler d1 execute grokbot-zone --remote --command "DELETE FROM submissions"' });
  assert.equal(res.status, 201); await ctx.drain();
  const mail = env.NOTIFY_OWNER.sent[0];
  assert.ok(mail, 'owner summary was sent');
  const approve = (mail.text as string).split('\n').filter((l) => l.startsWith('approve:'));
  assert.equal(approve.length, 1);
  assert.ok(approve[0].includes('WHERE id=1'), approve[0]);
});

// ---- F2: unsubscribe while SUBSCRIBE_ENABLED is "0" ----
const seedSub = (env: Record<string, any>, status = 'active') =>
  env.DB.db.prepare('INSERT INTO subscribers (email, status, confirm_token, unsub_token) VALUES (?, ?, ?, ?)').run('reader@example.test', status, 'c'.repeat(32), 'a'.repeat(32));
const TOKEN = 'a'.repeat(32);
await t('F2 dark: bogus token -> 410 with no row data', async () => {
  const env = makeEnv({ SUBSCRIBE_ENABLED: '0' }); seedSub(env);
  for (const [method, init] of [['GET', {}], ['POST', { method: 'POST', body: 'List-Unsubscribe=One-Click' }]] as const) {
    const res = await call(`/subscribe/unsubscribe?t=${'b'.repeat(32)}`, env, makeCtx(), init);
    assert.equal(res.status, 410, method);
    assert.ok(!(await res.text()).includes('reader@example.test'));
  }
  assert.deepEqual(env.DB.rows('SELECT status FROM subscribers'), [{ status: 'active' }]);
});
await t('F2 dark: valid token flips the row, logs kind unsubscribe, never echoes the address', async () => {
  const env = makeEnv({ SUBSCRIBE_ENABLED: '0' }); seedSub(env);
  const res = await call(`/subscribe/unsubscribe?t=${TOKEN}`, env, makeCtx());
  assert.equal(res.status, 200);
  assert.ok(!(await res.text()).includes('example.test'));
  assert.deepEqual(env.DB.rows('SELECT status FROM subscribers'), [{ status: 'unsubscribed' }]);
  assert.deepEqual(env.DB.rows('SELECT kind, ok FROM send_log'), [{ kind: 'unsubscribe', ok: 1 }]);
});
await t('F2 dark: one-click POST flips the row and logs it once', async () => {
  const env = makeEnv({ SUBSCRIBE_ENABLED: '0' }); seedSub(env);
  const res = await call(`/subscribe/unsubscribe?t=${TOKEN}`, env, makeCtx(), { method: 'POST', body: 'List-Unsubscribe=One-Click' });
  assert.equal(res.status, 200); assert.ok(!(await res.text()).includes('example.test'));
  await call(`/subscribe/unsubscribe?t=${TOKEN}`, env, makeCtx(), { method: 'POST', body: 'List-Unsubscribe=One-Click' });
  assert.deepEqual(env.DB.rows('SELECT status FROM subscribers'), [{ status: 'unsubscribed' }]);
  assert.equal(count(env, 'send_log'), 1, 'a repeat click is not logged again');
});
await t('F2 dark: confirm and subscribe stay 503', async () => {
  const env = makeEnv({ SUBSCRIBE_ENABLED: '0' }); seedSub(env, 'pending');
  assert.equal((await call(`/subscribe/confirm?t=${'c'.repeat(32)}`, env, makeCtx())).status, 503);
  assert.equal((await postJson('/subscribe', env, makeCtx(), { email: 'x@example.test' })).status, 503);
  assert.deepEqual(env.DB.rows('SELECT status FROM subscribers'), [{ status: 'pending' }]);
});

// ---- F3: the limiter fails closed on write routes ----
const UNAVAILABLE = { ok: false, error: 'unavailable' };
for (const [label, over] of [['throws', { SUBMISSIONS_RL: throwingLimiter() }], ['is missing', { SUBMISSIONS_RL: undefined }]] as const) {
  for (const path of ['/api/submit', '/api/v1/submissions']) {
    await t(`F3 ${path}: limiter ${label} -> 503 unavailable, nothing written`, async () => {
      const env = makeEnv(over);
      const res = await postJson(path, env, makeCtx(), GOOD);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), UNAVAILABLE);
      assert.equal(count(env, 'submissions'), 0);
    });
  }
  await t(`F3 /subscribe: limiter ${label} -> 503 unavailable, nothing written`, async () => {
    const env = makeEnv(label === 'throws' ? { SUBSCRIBE_RL: throwingLimiter() } : { SUBSCRIBE_RL: undefined });
    const res = await postJson('/subscribe', env, makeCtx(), { email: 'x@example.test' });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), UNAVAILABLE);
    assert.equal(count(env, 'subscribers'), 0);
  });
}
await t('F3 a working limiter still allows, then 429s', async () => {
  const env = makeEnv({ SUBMISSIONS_RL: limiter(1) });
  assert.equal((await postJson('/api/submit', env, makeCtx(), GOOD)).status, 201);
  assert.equal((await postJson('/api/submit', env, makeCtx(), { ...GOOD, link: 'https://x.ai/bot/Other-12345' })).status, 429);
});
await t('F3 read routes ignore a broken limiter', async () => {
  const env = makeEnv({ SUBMISSIONS_RL: throwingLimiter(), SUBSCRIBE_RL: throwingLimiter() });
  assert.equal((await call('/api/health', env, makeCtx())).status, 200);
  assert.equal((await call('/api/flags', env, makeCtx())).status, 200);
});

// ---- F4: email intake is rate limited by sender, before any write ----
await t('F4 email: sender over the limit is rejected with no insert, reply or forward', async () => {
  const env = makeEnv({ SUBMISSIONS_RL: limiter(2) });
  const results = [];
  for (const code of ['FreshOne1', 'FreshTwo2', 'FreshThree3']) results.push(await sendEmail(env, { from: 'Spammer@Example.test', body: `Helps.\nhttps://x.ai/bot/${code}` }));
  assert.deepEqual(results.map((r) => r.rejects), [[], [], ['rate limited']]);
  assert.equal(count(env, 'submissions'), 2);
  assert.equal(results[2].replies.length, 0); assert.equal(results[2].forwards.length, 0);
  assert.equal(results[0].forwards.length, 1);
  assert.equal(env.NOTIFY_OWNER.sent.length, 2, 'no owner notify for the rejected message');
  assert.ok(env.SUBMISSIONS_RL.keys.every((k: string) => k === k.toLowerCase()), env.SUBMISSIONS_RL.keys.join());
  assert.ok(env.SUBMISSIONS_RL.keys.some((k: string) => k.includes('spammer@example.test')));
});
await t('F4 email: a different sender is not limited by the first one', async () => {
  const env = makeEnv({ SUBMISSIONS_RL: limiter(1) });
  await sendEmail(env, { from: 'a@example.test', body: 'x\nhttps://x.ai/bot/AaaaAaaa1' });
  const other = await sendEmail(env, { from: 'b@example.test', body: 'x\nhttps://x.ai/bot/BbbbBbbb2' });
  assert.deepEqual(other.rejects, []); assert.equal(count(env, 'submissions'), 2);
});
await t('F4 email: a throwing or missing limiter fails closed', async () => {
  for (const over of [{ SUBMISSIONS_RL: throwingLimiter() }, { SUBMISSIONS_RL: undefined }]) {
    const env = makeEnv(over);
    const r = await sendEmail(env);
    assert.equal(r.rejects.length, 1); assert.equal(count(env, 'submissions'), 0); assert.equal(r.forwards.length, 0);
  }
});

// ---- F5: a rejected row flips to pending only if it is still rejected ----
// The webform stores the lowercased link; the email path stores https://x.ai/bot/<code> in the sender's letter case.
const seedRejected = (env: Record<string, any>, link = 'https://x.ai/bot/newbot-12345') =>
  env.DB.db.prepare("INSERT INTO submissions (source, status, name, description, code, link) VALUES ('webform','rejected','Old name','Old description here','NewBot-12345',?)").run(link);
const approveBehindTheirBack = (env: Record<string, any>) => {
  env.DB.afterRead = (sql: string) => { if (sql.includes('FROM submissions WHERE link')) env.DB.db.prepare("UPDATE submissions SET status='approved' WHERE id=1").run(); };
};
await t('F5 form: a row approved between the read and the write is not flipped back', async () => {
  const env = makeEnv(); seedRejected(env); approveBehindTheirBack(env);
  const res = await postJson('/api/submit', env, makeCtx(), GOOD);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { ok: false, error: 'already_pending' });
  assert.deepEqual(env.DB.rows('SELECT status, name FROM submissions'), [{ status: 'approved', name: 'Old name' }]);
  assert.equal(env.NOTIFY_OWNER.sent.length, 0);
});
await t('F5 form: an untouched rejected row still resubmits to pending', async () => {
  const env = makeEnv(); seedRejected(env);
  const res = await postJson('/api/submit', env, makeCtx(), GOOD);
  assert.equal(res.status, 201);
  assert.deepEqual(env.DB.rows('SELECT status, name FROM submissions'), [{ status: 'pending', name: 'Spam Stopper' }]);
});
await t('F5 email: a row approved between the read and the write is not flipped back', async () => {
  const env = makeEnv(); seedRejected(env, 'https://x.ai/bot/NewBot-12345'); approveBehindTheirBack(env);
  const r = await sendEmail(env, { body: 'Helps.\nhttps://x.ai/bot/NewBot-12345' });
  assert.deepEqual(env.DB.rows('SELECT status, name FROM submissions'), [{ status: 'approved', name: 'Old name' }]);
  assert.equal(env.NOTIFY_OWNER.sent.length, 0, 'not announced as a new submission');
  assert.equal(r.rejects.length, 0);
});
await t('F5 email: an untouched rejected row still resubmits to pending', async () => {
  const env = makeEnv(); seedRejected(env, 'https://x.ai/bot/NewBot-12345');
  await sendEmail(env, { body: 'Helps.\nhttps://x.ai/bot/NewBot-12345' });
  assert.deepEqual(env.DB.rows('SELECT status, source FROM submissions'), [{ status: 'pending', source: 'email' }]);
});

// ---- D4: /media/* byte ranges (Workers static assets ignore Range, so the Worker answers them) ----
const MEDIA = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
function mediaEnv(withLength = true) {
  const seen: Request[] = [];
  const ASSETS = {
    fetch: async (r: Request) => {
      seen.push(r);
      const p = new URL(r.url).pathname; // like the real binding: Range is ignored, always a full 200
      if (p === '/media/clip.mp4') return new Response(MEDIA, { headers: { 'content-type': 'video/mp4', ...(withLength ? { 'content-length': '1000' } : {}), etag: '"abc"' } });
      if (p === '/media/missing.mp4') return new Response('not found page', { status: 404, headers: { 'content-type': 'text/html' } });
      return new Response(`asset:${p}`, { headers: { 'content-type': 'text/plain' } });
    },
  };
  return { seen, env: makeEnv({ ASSETS }) };
}
const getMedia = (rng?: string, method = 'GET', path = '/media/clip.mp4', withLength = true) => {
  const m = mediaEnv(withLength);
  return call(path, m.env, makeCtx(), { method, headers: rng === undefined ? {} : { range: rng } }).then((res) => ({ res, seen: m.seen }));
};
const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());
const sameBytes = (got: Uint8Array, from: number, to: number) => assert.deepEqual([...got], [...MEDIA.subarray(from, to + 1)]);
const mediaHeaders = (res: Response) => {
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
};

await t('D4 media: no Range -> 200 with the full body and the media headers', async () => {
  const { res } = await getMedia();
  assert.equal(res.status, 200); mediaHeaders(res);
  assert.equal(res.headers.get('content-length'), '1000'); assert.equal(res.headers.get('content-range'), null);
  sameBytes(await bytesOf(res), 0, 999);
});
for (const [rng, from, to] of [['bytes=0-1', 0, 1], ['bytes=0-0', 0, 0], ['bytes=10-', 10, 999], ['bytes=-5', 995, 999], ['bytes=-99999999', 0, 999], ['bytes=990-5000', 990, 999], ['bytes=999-999', 999, 999]] as const) {
  await t(`D4 media: ${rng} -> 206 ${from}-${to}/1000`, async () => {
    const { res, seen } = await getMedia(rng);
    assert.equal(res.status, 206); mediaHeaders(res);
    assert.equal(res.headers.get('content-range'), `bytes ${from}-${to}/1000`);
    assert.equal(res.headers.get('content-length'), String(to - from + 1));
    sameBytes(await bytesOf(res), from, to);
    assert.ok(seen.length === 1 && !seen[0].headers.has('range'), 'the asset is fetched without a Range header');
  });
}
for (const rng of ['bytes=1000-', 'bytes=5000-6000', 'bytes=-0']) {
  await t(`D4 media: ${rng} -> 416 with bytes */1000`, async () => {
    const { res } = await getMedia(rng);
    assert.equal(res.status, 416); mediaHeaders(res);
    assert.equal(res.headers.get('content-range'), 'bytes */1000');
    assert.equal((await bytesOf(res)).length, 0);
  });
}
for (const rng of ['bytes=0-1,4-5', 'bytes=5-2', 'bytes=abc', 'bytes=-', 'items=0-1', 'bytes=0-1-2']) {
  await t(`D4 media: ${rng} -> 200 with the full body (ignored)`, async () => {
    const { res } = await getMedia(rng);
    assert.equal(res.status, 200); mediaHeaders(res);
    assert.equal(res.headers.get('content-range'), null);
    sameBytes(await bytesOf(res), 0, 999);
  });
}
await t('D4 media: HEAD -> 200, size headers, no body', async () => {
  const { res } = await getMedia(undefined, 'HEAD');
  assert.equal(res.status, 200); mediaHeaders(res);
  assert.equal(res.headers.get('content-length'), '1000'); assert.equal((await bytesOf(res)).length, 0);
});
await t('D4 media: HEAD with a Range -> 206 headers, no body', async () => {
  const { res } = await getMedia('bytes=0-1', 'HEAD');
  assert.equal(res.status, 206); mediaHeaders(res);
  assert.equal(res.headers.get('content-range'), 'bytes 0-1/1000'); assert.equal(res.headers.get('content-length'), '2');
  assert.equal((await bytesOf(res)).length, 0);
});
// workerd streams assets without a Content-Length, so the size has to come from the body itself
await t('D4 media: an asset response without Content-Length still gets 200 / 206 / 416 / HEAD right', async () => {
  const full = (await getMedia(undefined, 'GET', '/media/clip.mp4', false)).res; assert.equal(full.status, 200); assert.equal(full.headers.get('content-length'), '1000'); sameBytes(await bytesOf(full), 0, 999);
  const part = (await getMedia('bytes=-5', 'GET', '/media/clip.mp4', false)).res; assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 995-999/1000'); sameBytes(await bytesOf(part), 995, 999);
  const bad = (await getMedia('bytes=1000-', 'GET', '/media/clip.mp4', false)).res; assert.equal(bad.status, 416); assert.equal(bad.headers.get('content-range'), 'bytes */1000');
  const head = (await getMedia(undefined, 'HEAD', '/media/clip.mp4', false)).res; assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '1000'); assert.equal((await bytesOf(head)).length, 0);
  const headR = (await getMedia('bytes=0-1', 'HEAD', '/media/clip.mp4', false)).res; assert.equal(headR.status, 206); assert.equal(headR.headers.get('content-length'), '2');
});
await t('D4 media: a path outside /media/ is untouched (Range forwarded, no media headers)', async () => {
  for (const p of ['/favicon.svg', '/media', '/mediafile.mp4', '/riv/hero-grid.riv']) {
    const { res, seen } = await getMedia('bytes=0-1', 'GET', p);
    assert.equal(res.status, 200); assert.equal(await res.text(), `asset:${p}`);
    assert.equal(res.headers.get('accept-ranges'), null); assert.equal(res.headers.get('cache-control'), null);
    assert.equal(seen[0].headers.get('range'), 'bytes=0-1');
  }
});
await t('D4 media: other methods and missing files fall through to the assets unchanged', async () => {
  const post = await getMedia('bytes=0-1', 'POST'); assert.equal(post.seen[0].method, 'POST'); assert.equal(post.seen[0].headers.get('range'), 'bytes=0-1'); assert.equal(post.res.headers.get('accept-ranges'), null); assert.equal(post.res.headers.get('cache-control'), null);
  const miss = await getMedia('bytes=0-1', 'GET', '/media/missing.mp4');
  assert.equal(miss.res.status, 404); assert.equal(await miss.res.text(), 'not found page'); assert.equal(miss.res.headers.get('cache-control'), null);
});

console.log(failed ? `test-worker: ${n} passed, ${failed} FAILED` : `test-worker: ${n} passed`);
process.exit(failed ? 1 : 0);
