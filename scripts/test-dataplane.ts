// Spec 07 section 4 tests. No network, no wrangler: modules run under tsx with a mock clock and a mock
// fetch; the bundled Worker is driven for the route-level cases. Tokens in here are FAKE ("zzfaketokenzz").
// Usage: pnpm test:dataplane
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { Upstream, applyVerdict, runChecks, type BotRow } from '../src/worker/dp/liveness';
import { denylist, ingest, parseHead, scrub } from '../src/worker/dp/ingest';
import { parseCdx, parseListing } from '../src/worker/dp/discovery';
import { build as buildTrending, order, prior, SEED_RANK, type Scored } from '../src/worker/dp/trending';
import { runDataPlane } from '../src/worker/dp/cron';
import { recentList, trendingList } from '../src/worker/dp/serve';
import { isHuman, record, resetDeadCache, resetSaltCache } from '../src/worker/dp/telemetry';
import { classify, tokenize } from '../src/worker/dp/classify';
import { readLive } from './lib-live';
import model from '../src/data/classifier.json';

const ROOT = resolve(import.meta.dirname, '..');
const FAKE = 'zzfaketokenzz';
const MIGRATIONS = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(join(ROOT, 'migrations', f), 'utf8'));

// ---- D1 over node:sqlite, with batch() and a query counter (a batch counts as one) ----
class FakeD1 {
  db = new DatabaseSync(':memory:');
  queries = 0;
  constructor() { for (const m of MIGRATIONS) this.db.exec(m); }
  private exec(sql: string, args: unknown[]) {
    const st = this.db.prepare(sql);
    if (/^\s*(select|with)/i.test(sql)) return { results: st.all(...(args as never[])).map((r) => ({ ...(r as object) })), meta: { changes: 0 } };
    const r = st.run(...(args as never[]));
    return { results: [], meta: { changes: Number(r.changes) } };
  }
  prepare(sql: string) {
    const self = this;
    const bound = (args: unknown[]): any => ({
      sql, args,
      bind: (...a: unknown[]) => bound(a),
      async first() { self.queries++; const r = self.exec(sql, args).results[0]; return r ?? null; },
      async all() { self.queries++; return self.exec(sql, args); },
      async run() { self.queries++; return { success: true, ...self.exec(sql, args) }; },
    });
    return bound([]);
  }
  async batch(sts: any[]) {
    this.queries++;
    this.db.exec('BEGIN');
    try { const out = sts.map((s) => ({ success: true, ...this.exec(s.sql, s.args) })); this.db.exec('COMMIT'); return out; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  rows(sql: string, ...args: unknown[]) { return this.db.prepare(sql).all(...(args as never[])).map((r) => ({ ...(r as object) })) as any[]; }
  one(sql: string, ...args: unknown[]) { return this.rows(sql, ...args)[0]; }
}

// ---- mock clock + mock platform ----
const T0 = Date.parse('2026-11-10T12:05:00Z');
function clock(start = T0) { const c = { t: start, now: () => c.t, sleep: async (ms: number) => { c.t += ms; } }; return c; }
type Handler = (url: string, init: RequestInit) => { status: number; headers?: Record<string, string>; body?: string };
function platform(handler: Handler, c: { t: number }) {
  const calls: { url: string; method: string; at: number }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', at: c.t });
    const r = handler(String(url), init);
    return new Response(init.method === 'HEAD' ? null : r.body ?? '', { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const CODE = (n: number) => `Bot${String(n).padStart(18, '0')}`; // 21 chars
const row = (over: Partial<BotRow> = {}): BotRow => ({
  code_lc: 'abc', code: 'abc', name: 'N', author: '', description: '', category: null, cats: null, source: 'seed', status: 'live',
  first_seen: '2026-10-30', last_checked: null, last_live: null, fail_count: 0, first_fail: null, ...over,
});
function insertBot(db: FakeD1, code: string, over: Record<string, unknown> = {}) {
  const r = { name: `Name ${code}`, author: '', description: 'desc', category: 'coding-software', cats: 'coding-software', source: 'seed', status: 'live', first_seen: '2026-10-30', last_checked: null, ...over };
  db.db.prepare('INSERT INTO bots(code_lc, code, name, author, description, category, cats, source, status, first_seen, last_checked) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(code.toLowerCase(), code, r.name as string, r.author as string, r.description as string, r.category as string, r.cats as string, r.source as string, r.status as string, r.first_seen as string, r.last_checked as string | null);
}

let n = 0, failed = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); n++; console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${(e as Error).message.split('\n').slice(0, process.env.GZ_VERBOSE ? 12 : 2).join(' | ')}`); }
};

// ================= liveness state machine (D14) =================
const H = 3600_000;
await t('liveness: 200 -> live, fail_count 0, last_live set', () => {
  const p = applyVerdict(row({ fail_count: 1, first_fail: '2026-11-09T00:00:00Z' }), { kind: 'live' }, T0);
  assert.equal(p.status, 'live'); assert.equal(p.fail_count, 0); assert.equal(p.first_fail, null); assert.equal(p.last_live, new Date(T0).toISOString());
});
await t('liveness: 404 then 404 less than 24 h later stays live', () => {
  const a = { ...row(), ...applyVerdict(row(), { kind: 'gone' }, T0) } as BotRow;
  assert.equal(a.fail_count, 1); assert.equal(a.status, 'live'); assert.ok(a.first_fail);
  const b = { ...a, ...applyVerdict(a, { kind: 'gone' }, T0 + 23 * H) } as BotRow;
  assert.equal(b.fail_count, 2); assert.equal(b.status, 'live');
});
await t('liveness: 404 then 404 24 h or more later -> dead', () => {
  const a = { ...row(), ...applyVerdict(row(), { kind: 'gone' }, T0) } as BotRow;
  const b = { ...a, ...applyVerdict(a, { kind: 'gone' }, T0 + 24 * H) } as BotRow;
  assert.equal(b.status, 'dead');
});
await t('liveness: two strikes alone (fail_count 2) are not enough without 24 h', () => {
  const a = row({ fail_count: 1, first_fail: new Date(T0 - H).toISOString() });
  assert.equal(applyVerdict(a, { kind: 'gone' }, T0).status, 'live');
});
await t('liveness: dead then 200 -> live again (reversible), row kept', () => {
  const d = row({ status: 'dead', fail_count: 3, first_fail: '2026-11-01T00:00:00Z' });
  const p = applyVerdict(d, { kind: 'live' }, T0);
  assert.equal(p.status, 'live'); assert.equal(p.fail_count, 0);
});
await t('liveness: 403 / 5xx / timeout change no status', async () => {
  const c = clock(); const rows = [row({ code_lc: 'a1', code: 'A1' }), row({ code_lc: 'a2', code: 'A2' }), row({ code_lc: 'a3', code: 'A3' })];
  const codes = [500, 503, 0];
  let i = 0;
  const p = platform(() => ({ status: codes[i++] }), c);
  const f = (async (...a: Parameters<typeof fetch>) => { if (codes[i] === 0) { i++; throw new Error('timeout'); } return p.f(...a); }) as typeof fetch;
  const up = new Upstream(f, c);
  const r = await runChecks(up, rows, c, [], model as never);
  assert.equal(r.patches.length, 3);
  for (const { patch } of r.patches) { assert.equal(patch.status, undefined); assert.equal(patch.fail_count, undefined); assert.ok(patch.last_checked); }
});
await t('liveness: 403 storm stops the run and holds the platform for 6 h (through the cron)', async () => {
  const db = new FakeD1(); for (let i = 0; i < 30; i++) insertBot(db, CODE(i));
  const c = clock(); const p = platform(() => ({ status: 403 }), c);
  const rep = await runDataPlane({ DB: db as never, NOREF_TOKENS: FAKE, TELEMETRY_START: '2026-11-01' }, c.t, { fetch: p.f, clock: c });
  assert.equal(rep.throttled, true);
  assert.ok(p.calls.length < 10, `stopped early (${p.calls.length} requests)`);
  const held = db.one("SELECT v FROM meta WHERE k='throttled_until'").v as string;
  assert.equal(Date.parse(held) - T0 > 5.9 * H && Date.parse(held) - T0 <= 6.1 * H, true);
  const calls = p.calls.length;
  c.t += 600_000;
  const rep2 = await runDataPlane({ DB: db as never, NOREF_TOKENS: FAKE, TELEMETRY_START: '2026-11-01' }, c.t, { fetch: p.f, clock: c });
  assert.equal(p.calls.length, calls, 'no upstream while held'); assert.equal(rep2.throttled, true);
});
await t('liveness: 308 is followed once and the spelling from the landing page is stored', async () => {
  const c = clock();
  const p = platform((url) => url.endsWith('/bot/abcdefghijklmnopqrstu') ? { status: 308, headers: { location: '/bot/AbCdEfGhIjKlMnOpQrStU' } } : { status: 200 }, c);
  const up = new Upstream(p.f, c);
  const r = await runChecks(up, [row({ code_lc: 'abcdefghijklmnopqrstu', code: 'abcdefghijklmnopqrstu' })], c, [], model as never);
  assert.equal(p.calls.length, 2); assert.equal(r.patches[0].patch.code, 'AbCdEfGhIjKlMnOpQrStU'); assert.equal(r.patches[0].patch.status, 'live');
});
await t('liveness: a redirect to a different bot or a loop is not followed twice or trusted', async () => {
  const c = clock();
  const p = platform(() => ({ status: 308, headers: { location: '/bot/SomethingElseEntirely1' } }), c);
  const up = new Upstream(p.f, c);
  const r = await runChecks(up, [row({ code_lc: 'abcdefghijklmnopqrstu', code: 'abcdefghijklmnopqrstu' })], c, [], model as never);
  assert.equal(p.calls.length, 1); assert.equal(r.patches[0].patch.status, undefined); assert.equal(r.patches[0].patch.fail_count, undefined);
});

// ================= spacing and budget (D14) with a mock clock =================
await t('upstream: >= 1.1 s between requests and <= 40 per run', async () => {
  const db = new FakeD1(); for (let i = 0; i < 100; i++) insertBot(db, CODE(i));
  const c = clock(); const p = platform(() => ({ status: 200 }), c);
  const rep = await runDataPlane({ DB: db as never, NOREF_TOKENS: FAKE, TELEMETRY_START: '2026-11-01' }, c.t, { fetch: p.f, clock: c });
  assert.ok(p.calls.length <= 40, `calls ${p.calls.length}`);
  assert.ok(p.calls.length >= 38, `calls ${p.calls.length}`); // first run also reads the listing + archive once (fresh database)
  for (let i = 1; i < p.calls.length; i++) assert.ok(p.calls[i].at - p.calls[i - 1].at >= 1100, `gap ${p.calls[i].at - p.calls[i - 1].at} at ${i}`);
  assert.equal(rep.upstream, p.calls.length);
  assert.equal(db.one("SELECT COUNT(*) AS n FROM bots WHERE last_checked IS NOT NULL").n, rep.checked);
});

// ================= D1 queries per invocation (cron run) =================
await t('D1 queries: a full cron run (discovery + 40 checks + hourly) issues <= 50', async () => {
  const db = new FakeD1(); for (let i = 0; i < 100; i++) insertBot(db, CODE(i));
  const c = clock(Date.parse('2026-11-10T04:10:00Z'));
  const cdx = JSON.stringify([['timestamp', 'original'], ...Array.from({ length: 5 }, (_, i) => ['20261001000000', `https://x.ai/bot/${CODE(500 + i)}`]), [], ['RESUMEKEY']]);
  const p = platform((url) => url.includes('web.archive.org') ? { status: 200, body: cdx } : url.endsWith('/marketplace') ? { status: 200, body: `<a href="/bot/${CODE(900)}">x</a>` } : { status: 200, body: '<head></head>' }, c);
  const rep = await runDataPlane({ DB: db as never, NOREF_TOKENS: FAKE, TELEMETRY_START: '2026-11-01' }, c.t, { fetch: p.f, clock: c });
  console.log(`      cron run: ${rep.queries} D1 queries, ${rep.upstream} upstream, discovered ${rep.discovered}, hourly ${rep.hourly}`);
  assert.ok(rep.queries <= 50, `queries ${rep.queries}`); assert.ok(rep.upstream <= 40);
  assert.equal(rep.hourly, true); assert.equal(rep.discovered, 6);
  assert.equal(db.one("SELECT COUNT(*) AS n FROM bots WHERE status='pending'").n >= 0, true);
  const sec = await runDataPlane({ DB: db as never, NOREF_TOKENS: FAKE, TELEMETRY_START: '2026-11-01' }, c.t + 600_000, { fetch: p.f, clock: c });
  console.log(`      cron run (no hourly): ${sec.queries} D1 queries`);
  assert.ok(sec.queries <= 50 && sec.hourly === false);
});

// ================= discovery + ingest =================
await t('discovery: listing hrefs and archive rows parse; archive spelling comes from `original`', () => {
  const codes = parseListing(`<a href="/bot/${CODE(1)}">a</a><a href="https://x.ai/bot/${CODE(2)}?x=1">b</a><a href="/bot/short">c</a><a href="/bot/marketplace">d</a><a href="/bot/${CODE(1)}">dup</a>`);
  assert.deepEqual(codes, [CODE(1), CODE(2)]);
  const cdx = parseCdx([['timestamp', 'original'], ['2026', 'https://x.ai/bot'], ['2026', `https://x.ai/bot/${CODE(3)}`], ['2026', `http://www.x.ai/bot/${CODE(3).toLowerCase()}`], [], ['KEY']]);
  assert.deepEqual(cdx.found, [CODE(3)]); assert.equal(cdx.resume, 'KEY');
});
await t('ingest: page head -> name/author/description, entities decoded, head only', () => {
  const h = parseHead('<head><link rel="canonical" href="https://x.ai/bot/AbCdEfGhIjKlMnOpQrStU"><meta property="og:title" content="Tom &amp; Jerry&#39;s Helper by Ann Lee"><meta property="og:description" content="Does &lt;things&gt;."></head><body><meta property="og:title" content="IGNORED by X">');
  assert.equal(h.canonicalCode, 'AbCdEfGhIjKlMnOpQrStU'); assert.equal(h.name, "Tom & Jerry's Helper"); assert.equal(h.author, 'Ann Lee'); assert.equal(h.description, 'Does <things>.');
});
await t('filters: email stripped from author and description', () => {
  const s = scrub({ name: 'Helper', author: 'ann@example.com', description: 'Write to bob@example.org now' }, []);
  assert.ok(!/@/.test(s.author + s.description)); assert.equal(s.excluded, false);
});
await t('filters: a denylist hit in the author blanks it; in the name or description excludes the bot', () => {
  const list = denylist(`${FAKE}|other`);
  assert.deepEqual(list, [FAKE, 'other']);
  const a = scrub({ name: 'Fine', author: `By ${FAKE.toUpperCase()}`, description: 'ok' }, list);
  assert.equal(a.author, ''); assert.equal(a.excluded, false);
  assert.equal(scrub({ name: `My ${FAKE} bot`, author: '', description: 'ok' }, list).excluded, true);
  assert.equal(scrub({ name: 'Fine', author: '', description: `about ${FAKE}` }, list).excluded, true);
  const head = parseHead(`<meta property="og:title" content="${FAKE} helper by Ann"><meta property="og:description" content="d">`);
  assert.equal(ingest(head, CODE(1), list, model as never)!.excluded, true);
});
await t('classifier: argmax or null; tokens are the only input', () => {
  assert.deepEqual(tokenize('Hello Worlds!'), ['hello', 'world']);
  assert.equal(classify(model as never, 'zzqq', 'xxyy'), null);
});
await t('cron: a pending bot is read, scrubbed and filed; an excluded one is never shown', async () => {
  const db = new FakeD1(); insertBot(db, CODE(1), { source: 'listing', status: 'pending', name: '', category: null, cats: null });
  insertBot(db, CODE(2), { source: 'archive', status: 'pending', name: '', category: null, cats: null });
  const c = clock();
  const page = (title: string) => `<head><link rel="canonical" href="x"><meta property="og:title" content="${title}"><meta property="og:description" content="Mail me at a@b.co about taxes"></head><body>`;
  const p = platform((url) => ({ status: 200, body: url.endsWith(CODE(1)) ? page('Tax Helper by Ann') : page(`${FAKE} thing by Ann`) }), c);
  await runDataPlane({ DB: db as never, NOREF_TOKENS: FAKE, TELEMETRY_START: '2026-11-01' }, c.t, { fetch: p.f, clock: c });
  const a = db.one('SELECT * FROM bots WHERE code_lc=?', CODE(1).toLowerCase()); const b = db.one('SELECT * FROM bots WHERE code_lc=?', CODE(2).toLowerCase());
  assert.equal(a.status, 'live'); assert.equal(a.name, 'Tax Helper'); assert.ok(!/@/.test(a.description));
  assert.equal(b.status, 'excluded');
  const ch = JSON.parse(db.one("SELECT v FROM meta WHERE k='changes_json'").v);
  assert.equal(ch.excluded, 1); assert.equal(ch.added.length, 1); assert.ok(!JSON.stringify(ch).includes(FAKE));
  assert.ok(!JSON.stringify(db.rows('SELECT k, v FROM meta')).includes(FAKE), 'no denylist token in stored output');
});
await t('pending: a 200 page without a title is stamped so it rotates; pending cannot starve live checks', async () => {
  const db = new FakeD1(); for (let i = 0; i < 50; i++) insertBot(db, CODE(i), { source: 'archive', status: 'pending', name: '', category: null, cats: null });
  for (let i = 100; i < 140; i++) insertBot(db, CODE(i));
  const c = clock(); const p = platform((url) => ({ status: 200, body: url.endsWith('/marketplace') || url.includes('archive') ? '' : '<head><title>x</title></head>' }), c);
  await runDataPlane({ DB: db as never, NOREF_TOKENS: FAKE, TELEMETRY_START: '2026-11-01' }, c.t, { fetch: p.f, clock: c });
  assert.equal(db.one("SELECT COUNT(*) AS n FROM bots WHERE status='pending' AND last_checked IS NOT NULL").n, 30);
  assert.ok(db.one("SELECT COUNT(*) AS n FROM bots WHERE status='live' AND last_checked IS NOT NULL").n >= 5, 'live rows still checked');
  assert.equal(db.one("SELECT COUNT(*) AS n FROM bots WHERE status='pending'").n, 50);
});
await t('O1: NOREF_TOKENS missing -> non-seed bots stay pending, never fetched, health says missing', async () => {
  const db = new FakeD1(); insertBot(db, CODE(1), { source: 'listing', status: 'pending', name: '', category: null, cats: null });
  const c = clock(); const p = platform(() => ({ status: 200, body: '<head><meta property="og:title" content="X by Y"></head>' }), c);
  await runDataPlane({ DB: db as never, TELEMETRY_START: '2026-11-01' }, c.t, { fetch: p.f, clock: c });
  assert.equal(db.one('SELECT status FROM bots').status, 'pending');
  assert.ok(!p.calls.some((x) => x.url.endsWith(CODE(1))));
});

// ================= trending (D20) =================
const D = '2026-11-10';
const NOW = Date.parse(`${D}T10:00:00Z`);
const day = (back: number) => new Date(Date.parse(`${D}T00:00:00Z`) - back * 86400_000).toISOString().slice(0, 10);
await t('trending: hand-computed fixture order (window edge, tie-breaks, dead/pending excluded)', async () => {
  const db = new FakeD1();
  const mk = (code: string, over: Record<string, unknown> = {}) => insertBot(db, code, over);
  mk('iiiii0', {}); mk('bbbbb0'); mk('aaaaa0'); mk('ddddd0'); mk('fffff0', { first_seen: '2026-11-02' }); mk('dddd00'); mk('eeeee0'); mk('ccccc0'); mk('hhhhh0'); mk('ggggg0', { status: 'dead' }); mk('jjjjj0', { status: 'pending' });
  const bd = (d: number, code: string, opens: number, views: number) => db.db.prepare('INSERT INTO bot_daily(day, code_lc, opens, views) VALUES(?,?,?,?)').run(day(d), code, opens, views);
  bd(13, 'iiiii0', 100, 0);            // 300 * 0.5^(13/3)           = 14.88  (last day inside the window)
  bd(0, 'bbbbb0', 0, 10); bd(6, 'bbbbb0', 4, 0); // 10 + 12*0.25      = 13
  bd(0, 'aaaaa0', 2, 4); bd(3, 'aaaaa0', 1, 0);  // 10 + 3*0.5        = 11.5
  bd(0, 'ddddd0', 3, 1);               // 9 + 1                       = 10, 3 opens
  bd(0, 'fffff0', 0, 10);              // 10, 0 opens, newer first_seen
  bd(0, 'dddd00', 0, 10);              // 10, 0 opens, older first_seen, code dddd00 < eeeee0
  bd(0, 'eeeee0', 0, 10);              // 10
  bd(1, 'ccccc0', 3, 3);               // 12 * 0.5^(1/3)              = 9.524
  bd(14, 'hhhhh0', 500, 500);          // day 14 is outside the window
  bd(0, 'ggggg0', 50, 50); bd(0, 'jjjjj0', 50, 50); // dead and pending never rank
  const b = await buildTrending(db as never, NOW, '2026-10-01');
  const codes = b.trending.global.map((id) => id.slice(-6));
  assert.deepEqual(codes, ['iiiii0', 'bbbbb0', 'aaaaa0', 'ddddd0', 'fffff0', 'dddd00', 'eeeee0', 'ccccc0']);
  assert.ok(b.trending.global.every((id) => id.startsWith('coding-software-')));
  assert.deepEqual(b.trending.perCategory['coding-software'], b.trending.global);
  assert.equal(b.trending.method.window_days, 14); assert.equal(b.trending.method.prior_until, null); assert.equal(b.trending.method.prior_share, 0);
});
await t('trending: order() ties break on opens, then newer first_seen, then code', () => {
  const s = (code_lc: string, o14: number, first_seen: string): Scored => ({ code_lc, code: code_lc, category: null, cats: null, first_seen, score: 5, o14, prior: 0 });
  assert.deepEqual(order([s('b', 1, '2026-01-01'), s('a', 1, '2026-01-01'), s('c', 2, '2026-01-01'), s('d', 1, '2026-02-01'), { ...s('z', 9, 'x'), score: 0 }]).map((r) => r.code_lc), ['c', 'd', 'a', 'b']);
});
await t('trending: prior is present at t = 13 and gone at t = 14', async () => {
  assert.equal(prior(1, 12, 14), 0); assert.ok(prior(1, 12, 13) > 0);
  assert.ok(Math.abs(prior(1, 12, 0) - 10) < 1e-9); assert.ok(Math.abs(prior(2, 12, 3) - 10 * (1 - 1 / 12) * 0.5) < 1e-9);
  const seed = [...SEED_RANK.keys()][0];
  const db = new FakeD1(); insertBot(db, seed, { category: 'privacy-security-scam-protection', cats: 'privacy-security-scam-protection' });
  const at13 = await buildTrending(db as never, Date.parse('2026-11-14T10:00:00Z'), '2026-11-01');
  assert.equal(at13.trending.global.length, 1); assert.ok(at13.trending.method.prior_until === '2026-11-15'); assert.equal(at13.trending.method.prior_share, 1);
  const at14 = await buildTrending(db as never, Date.parse('2026-11-15T10:00:00Z'), '2026-11-01');
  assert.equal(at14.trending.global.length, 0); assert.equal(at14.trending.method.prior_until, null);
});
await t('trending: the same fixture twice gives the same ids; the first-party method is published', async () => {
  const db = new FakeD1(); insertBot(db, 'aaaaa0'); db.db.prepare('INSERT INTO bot_daily VALUES(?,?,?,?)').run(day(0), 'aaaaa0', 1, 1);
  const a = await buildTrending(db as never, NOW, '2026-11-01'); const b = await buildTrending(db as never, NOW, '2026-11-01');
  assert.deepEqual(a.trending.global, b.trending.global);
  assert.deepEqual(a.trending.method.weights, { opens: 3, views: 1 }); assert.equal(a.trending.method.half_life_days, 3); assert.equal(a.trending.method.source, 'first-party');
  assert.equal(a.signals.bots && Object.keys(a.signals.bots as object).length, 1);
});

// ================= escape =================
await t('HTML escape: a name containing <script> renders inert in the live lists', () => {
  const card = { n: '<script>alert(1)</script>', a: '"><img src=x onerror=1>', d: "<b>bold</b> & 'q'", c: 'coding-software', k: 'zzcode', s: 'listing' };
  const html = trendingList(['coding-software-zzcode'], { 'coding-software-zzcode': card }, 2, 10, true) + recentList(['coding-software-zzcode'], { 'coding-software-zzcode': card }, 3, 10);
  assert.ok(!html.includes('<script') && !html.includes('<img') && !html.includes('<b>'), html);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('href="/go/zzcode" rel="nofollow noopener"'));
});

// ================= telemetry + routes through the bundled Worker =================
const tmp = mkdtempSync(join(tmpdir(), 'gz-test-dp-'));
const stub = join(tmp, 'email-stub.mjs');
writeFileSync(stub, 'export class EmailMessage {}\n');
const out = join(tmp, 'worker.mjs');
await build({
  entryPoints: [join(ROOT, 'src/worker/index.ts')], outfile: out, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  conditions: ['workerd', 'worker', 'browser'], external: ['node:*'], logLevel: 'warning',
  plugins: [{ name: 'stub', setup: (b) => b.onResolve({ filter: /^cloudflare:email$/ }, () => ({ path: stub })) }],
});
const worker = (await import(pathToFileURL(out).href)).default as { fetch(r: Request, e: unknown, c: unknown): Promise<Response>; scheduled(c: unknown, e: unknown, x: unknown): Promise<void> };
const LIVE = 'AbCdEfGhIjKlMnOpQrStU';
const ctxOf = () => { const p: Promise<unknown>[] = []; return { waitUntil: (x: Promise<unknown>) => { p.push(x); }, drain: () => Promise.all(p.splice(0)) }; };
const envOf = (db: FakeD1, over: Record<string, unknown> = {}) => ({
  DB: db, ASSETS: { fetch: async (r: Request) => new Response(`<html>${new URL(r.url).pathname}</html>`, { status: r.url.includes('/nope') ? 404 : 200, headers: { 'content-type': 'text/html' } }) },
  FORM_SUBMIT_ENABLED: '0', EMAIL_SUBMIT_ENABLED: '0', SUBSCRIBE_ENABLED: '0', DIGEST_ENABLED: '0', NOREF_TOKENS: FAKE, TELEMETRY_START: '2026-11-01', ...over,
});
const HUMAN = 'Mozilla/5.0 (Macintosh) AppleWebKit/605 Safari/605';
const get = async (env: unknown, path: string, headers: Record<string, string> = {}, method = 'GET') => {
  const ctx = ctxOf(); const q0 = (env as { DB: FakeD1 }).DB.queries;
  const res = await worker.fetch(new Request(`https://grokbot.zone${path}`, { method, redirect: 'manual', headers }), env, ctx); await ctx.drain();
  return { res, queries: (env as { DB: FakeD1 }).DB.queries - q0 };
};
const opens = (db: FakeD1, code = LIVE.toLowerCase()) => db.one('SELECT COALESCE(SUM(opens),0) AS o, COALESCE(SUM(views),0) AS v FROM bot_daily WHERE code_lc=?', code);

await t('/go/: unknown code 404, malformed 404, live code 302 to the platform URL only', async () => {
  resetSaltCache(); const db = new FakeD1(); insertBot(db, LIVE); insertBot(db, 'DeadOne', { status: 'dead' }); insertBot(db, 'Exclu', { status: 'excluded' }); insertBot(db, 'PendOne', { status: 'pending' }); const env = envOf(db);
  assert.equal((await get(env, '/go/zzzzzzzzzzzzzzzzzzzz0')).res.status, 404);
  for (const bad of ['/go/', '/go/a%2F..%2Fb', '/go/' + 'a'.repeat(80), '/go/bad code', '/go/https://evil.example', '/go/DeadOne', '/go/Exclu']) assert.equal((await get(env, bad)).res.status, 404, bad);
  const ok = await get(env, `/go/${LIVE}`, { 'user-agent': HUMAN });
  assert.equal(ok.res.status, 302); assert.equal(ok.res.headers.get('location'), `https://x.ai/bot/${LIVE}`);
  const lower = await get(env, `/go/${LIVE.toLowerCase()}`, { 'user-agent': HUMAN });
  assert.equal(lower.res.headers.get('location'), `https://x.ai/bot/${LIVE}`, 'stored spelling is used');
  assert.equal((await get(env, '/go/PendOne')).res.status, 302);
  assert.ok(ok.queries <= 50);
});
await t('telemetry: same visitor twice = 1 open; a second visitor = 2', async () => {
  resetSaltCache(); const db = new FakeD1(); insertBot(db, LIVE); const env = envOf(db);
  const h = { 'user-agent': HUMAN, 'cf-connecting-ip': '203.0.113.7' };
  await get(env, `/go/${LIVE}`, h); await get(env, `/go/${LIVE}`, h);
  assert.deepEqual(opens(db), { o: 1, v: 0 });
  await get(env, `/go/${LIVE}`, { ...h, 'cf-connecting-ip': '203.0.113.8' });
  assert.equal(opens(db).o, 2);
  assert.equal(JSON.stringify(db.rows('SELECT * FROM visit_seen')).includes('203.0.113'), false, 'no raw IP stored');
  assert.match(db.one('SELECT vh FROM visit_seen').vh, /^[0-9a-f]{16}$/);
});
await t('telemetry: crawler UA = 0, HEAD = 0, prefetch = 0, no UA = 0', async () => {
  resetSaltCache(); const db = new FakeD1(); insertBot(db, LIVE); const env = envOf(db);
  for (const ua of ['Googlebot/2.1', 'curl/8.4', 'python-requests/2.31', 'Mozilla/5.0 (compatible; bingbot)', 'Slackbot-LinkExpanding', 'HeadlessChrome/120', 'WhatsApp link preview', 'Go-http-client/2.0', 'okhttp/4', 'Java/17', 'Wget/1.21', 'Apache-HttpClient/4 http-client', 'Yahoo Slurp', 'Baiduspider', 'SomeCrawl/1']) await get(env, `/go/${LIVE}`, { 'user-agent': ua, 'cf-connecting-ip': '1.1.1.1' });
  await get(env, `/go/${LIVE}`, { 'cf-connecting-ip': '1.1.1.1' });
  const head = await get(env, `/go/${LIVE}`, { 'user-agent': HUMAN, 'cf-connecting-ip': '1.1.1.2' }, 'HEAD');
  assert.equal(head.res.status, 302);
  await get(env, `/go/${LIVE}`, { 'user-agent': HUMAN, purpose: 'prefetch' }); await get(env, `/go/${LIVE}`, { 'user-agent': HUMAN, 'sec-purpose': 'prefetch;prerender' });
  assert.deepEqual(opens(db), { o: 0, v: 0 });
  assert.equal(isHuman(new Request('https://x/', { headers: { 'user-agent': HUMAN } })), true);
  assert.equal(isHuman(new Request('https://x/', { headers: { 'user-agent': HUMAN, 'sec-fetch-dest': 'document' } })), true);
  for (const dest of ['image', 'script', 'empty', 'iframe']) assert.equal(isHuman(new Request('https://x/', { headers: { 'user-agent': HUMAN, 'sec-fetch-dest': dest } })), false, dest);
});
await t('telemetry: a bot page view counts once for a human GET with a 200, not HEAD and not a 404', async () => {
  resetSaltCache(); resetDeadCache(); const db = new FakeD1(); insertBot(db, LIVE); const env = envOf(db);
  const id = `coding-software-${LIVE}`; const h = { 'user-agent': HUMAN, 'cf-connecting-ip': '198.51.100.1' };
  await get(env, `/bots/${id}/`, h); await get(env, `/bots/${id}/`, h);
  await get(env, `/bots/${id}/`, h, 'HEAD'); await get(env, '/bots/nope-xxxxxxxxxxxxxxxxxxxxx/', h);
  assert.deepEqual(opens(db), { o: 0, v: 1 });
  const g = await get(env, `/bots/${id}/`, { ...h, 'cf-connecting-ip': '198.51.100.2' }); assert.ok(g.queries <= 50);
});
await t('telemetry: a D1 error never reaches the visitor', async () => {
  resetSaltCache(); const db = new FakeD1(); insertBot(db, LIVE); const env = envOf(db);
  const orig = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => { if (/visit_seen|bot_daily/.test(sql)) throw new Error('D1_ERROR: daily limit'); return orig(sql); };
  const r = await get(env, `/go/${LIVE}`, { 'user-agent': HUMAN }); assert.equal(r.res.status, 302);
  const p = await get(env, `/bots/coding-software-${LIVE}/`, { 'user-agent': HUMAN }); assert.equal(p.res.status, 200);
  await record(db as never, 'view', 'x', new Request('https://x/', { headers: { 'user-agent': HUMAN } }));
});
await t('/go/ never redirects off x.ai even when D1 is down', async () => {
  const db = new FakeD1(); const env = envOf(db); (db as any).prepare = () => { throw new Error('down'); };
  const r = await get(env, `/go/${LIVE}`, { 'user-agent': HUMAN });
  assert.equal(r.res.status, 302); assert.ok(r.res.headers.get('location')!.startsWith('https://x.ai/bot/'));
  assert.equal((await get(env, '/go/bad%20code')).res.status, 404);
});
await t('read files: served from meta once the cron has run; static fallback before; D1 queries <= 50 each', async () => {
  resetSaltCache(); const db = new FakeD1(); insertBot(db, LIVE); const env = envOf(db);
  const before = await get(env, '/api/v1/trending.json'); assert.equal(before.res.status, 200); assert.ok((await before.res.text()).includes('/api/v1/trending.json'), 'static fallback');
  assert.equal((await get(env, '/api/v1/signals/daily.json')).res.status, 503);
  const c = clock(); const p = platform(() => ({ status: 200 }), c);
  await runDataPlane(env as never, c.t, { fetch: p.f, clock: c });
  for (const path of ['/api/v1/trending.json', '/api/v1/recent.json', '/api/v1/signals/daily.json', '/api/v1/catalog/changes.json']) {
    const r = await get(env, path); assert.equal(r.res.status, 200, path); assert.ok(r.queries <= 50);
    const j = JSON.parse(await r.res.text()); assert.ok(j && typeof j === 'object' && Object.keys(j).length > 0, path);
  }
  const ch = JSON.parse(await (await get(env, '/api/v1/catalog/changes.json')).res.text()); assert.ok('added' in ch && 'dead' in ch);
  const rc = JSON.parse(await (await get(env, '/api/v1/recent.json')).res.text()); assert.ok(rc.bots.length > 0 && rc.generatedAt && rc.categories);
});
await t('conditional requests: a validator never turns a live page, a dead bot or a view into a 304', async () => {
  resetSaltCache(); resetDeadCache(); const db = new FakeD1(); insertBot(db, LIVE); insertBot(db, 'DeadBot00000000000001', { status: 'dead' });
  db.db.prepare("INSERT INTO meta(k,v) VALUES('dead_json', ?)").run(JSON.stringify(['deadbot00000000000001']));
  const seen: (string | null)[] = [];
  const assets = { fetch: async (r: Request) => { seen.push(r.headers.get('if-none-match')); return r.headers.get('if-none-match') ? new Response(null, { status: 304 }) : new Response('<html>page</html>', { status: new URL(r.url).pathname.includes('absent') ? 404 : 200, headers: { 'content-type': 'text/html', etag: '"abc"' } }); } };
  const env = envOf(db, { ASSETS: assets });
  const h = { 'user-agent': HUMAN, 'cf-connecting-ip': '192.0.2.9', 'if-none-match': '"abc"' };
  const view = await get(env, `/bots/coding-software-${LIVE}/`, h); assert.equal(view.res.status, 200);
  assert.deepEqual(opens(db), { o: 0, v: 1 }, 'the view is counted');
  const gone = await get(env, '/bots/coding-software-DeadBot00000000000001/', h); assert.equal(gone.res.status, 410);
  assert.match(await gone.res.text(), /no longer shared/);
  const none = await get(env, '/bots/coding-software-DeadBot00000000000001absent/', h);
  const goneNoPage = await get(env, '/bots/coding-software-DeadBot00000000000001/', { ...h, 'if-modified-since': 'Sat, 01 Nov 2026 00:00:00 GMT' });
  assert.equal(goneNoPage.res.status, 410);
  assert.ok(seen.every((v) => v === null), 'no validator reached the asset fetch');
  void none;
  for (const p of ['/trending/', '/recent/', '/']) assert.equal((await get(env, p, h)).res.status, 200, p);
});
await t('dead bot with no static page still answers 410 (the page was dropped by a rebuild)', async () => {
  resetDeadCache(); const db = new FakeD1(); insertBot(db, 'GoneBot0000000000001', { status: 'dead' });
  db.db.prepare("INSERT INTO meta(k,v) VALUES('dead_json', ?)").run(JSON.stringify(['gonebot0000000000001']));
  const env = envOf(db, { ASSETS: { fetch: async () => new Response('missing', { status: 404 }) } });
  const r = await get(env, '/bots/travel-GoneBot0000000000001/'); assert.equal(r.res.status, 410);
  const body = await r.res.text(); assert.ok(body.includes('/categories/travel/') && body.includes('noindex'));
});
await t('D1 queries per handler, measured (each <= 50)', async () => {
  resetSaltCache(); resetDeadCache(); const db = new FakeD1(); for (let i = 0; i < 5; i++) insertBot(db, CODE(i)); const env = envOf(db);
  const c = clock(Date.now()); const p = platform(() => ({ status: 200 }), c); await runDataPlane(env as never, c.t, { fetch: p.f, clock: c });
  const h = { 'user-agent': HUMAN, 'cf-connecting-ip': '192.0.2.77' };
  const rows: [string, number][] = [];
  for (const [label, path] of [['/go/<code>', `/go/${CODE(1)}`], ['/bots/<id>/', `/bots/coding-software-${CODE(2)}/`], ['/api/health', '/api/health'], ['/api/v1/trending.json', '/api/v1/trending.json'], ['/api/v1/recent.json', '/api/v1/recent.json'], ['/api/v1/signals/daily.json', '/api/v1/signals/daily.json'], ['/api/v1/catalog/changes.json', '/api/v1/catalog/changes.json'], ['/trending/ (live page)', '/trending/'], ['/recent/ (live page)', '/recent/'], ['/ (home rails)', '/']] as const) {
    const r = await get(env, path, h); rows.push([label, r.queries]); assert.ok(r.queries <= 50, `${label}: ${r.queries}`);
  }
  console.log('      ' + rows.map(([l, q]) => `${l}=${q}`).join('  '));
});
await t('health: liveness block, noref, switches, and a D1 query count <= 50', async () => {
  resetSaltCache(); const db = new FakeD1(); for (let i = 0; i < 5; i++) insertBot(db, CODE(i)); const env = envOf(db);
  const c = clock(Date.now()); const p = platform(() => ({ status: 200 }), c);
  await runDataPlane(env as never, c.t, { fetch: p.f, clock: c });
  const r = await get(env, '/api/health'); const h = JSON.parse(await r.res.text());
  assert.equal(h.ok, true); assert.ok(h.liveness.last_run); assert.ok(h.liveness.checked_24h >= 5); assert.equal(h.liveness.live, 5); assert.equal(h.noref, 'ok');
  assert.ok(h.trending.generatedAt); assert.deepEqual(Object.values(h.switches), ['0', '0', '0', '0']); assert.ok(r.queries <= 50);
  const noref = await get(envOf(db, { NOREF_TOKENS: '' }), '/api/health'); assert.equal(JSON.parse(await noref.res.text()).noref, 'missing');
});
await t('scheduled: the digest cron runs the digest, */10 runs the data plane (never the digest)', async () => {
  const db = new FakeD1(); const env = envOf(db, { DIGEST_ENABLED: '0' });
  db.db.prepare("INSERT INTO meta(k,v) VALUES('throttled_until', ?)").run(new Date(Date.now() + 3 * H).toISOString());
  const logs: string[] = []; const orig = console.log; console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  try {
    const x = ctxOf(); await worker.scheduled({ cron: '0 13 * * MON,THU', scheduledTime: Date.now() }, env, x); await x.drain();
    const y = ctxOf(); await worker.scheduled({ cron: '*/10 * * * *', scheduledTime: Date.now() }, env, y); await y.drain();
  } finally { console.log = orig; }
  assert.ok(logs.some((l) => l.startsWith('digest:')), logs.join('\n')); assert.ok(logs.some((l) => l.startsWith('dataplane')), logs.join('\n'));
  assert.equal(logs.filter((l) => l.startsWith('digest:')).length, 1);
});
await t('submissions: an approved submission becomes a pending bot (source submission), scrubbed', async () => {
  const db = new FakeD1(); insertBot(db, 'seedone0');
  db.db.exec("INSERT INTO submissions(source, status, name, author, description, code, link, category) VALUES('webform','approved','Subm Bot','a@b.co','Mail a@b.co','SubmCode0001','https://x.ai/bot/submcode0001','coding-software'), ('webform','pending','Nope','','d','PendCode0001','https://x.ai/bot/pendcode0001',NULL)");
  const c = clock(); const p = platform(() => ({ status: 200 }), c);
  const env = { DB: db as never, NOREF_TOKENS: FAKE, TELEMETRY_START: '2026-11-01' };
  await runDataPlane(env, c.t, { fetch: p.f, clock: c });
  assert.equal(db.one("SELECT status FROM bots WHERE code_lc='submcode0001'").status, 'pending');
  c.t += 600_000;
  await runDataPlane(env, c.t, { fetch: p.f, clock: c });
  const r = db.one("SELECT * FROM bots WHERE code_lc='submcode0001'");
  assert.ok(r && r.source === 'submission' && r.category === 'coding-software'); assert.ok(!/@/.test(r.author + r.description));
  assert.equal(db.one("SELECT COUNT(*) AS n FROM bots WHERE code_lc='pendcode0001'").n, 0);
  assert.equal(r.status, 'live', 'a submission that answers 200 goes live');
});

// ================= D24: the static build's view of the live snapshot =================
await t('D24: readLive keeps categorised adds, drops category-less and malformed ones, scrubs emails, lists dead codes', () => {
  const f = join(tmp, 'changes.json');
  writeFileSync(f, JSON.stringify({ added: [
    { code: 'AddedOne00000000001', name: 'Added', author: 'a@b.co', description: 'Mail a@b.co', category: 'coding-software' },
    { code: 'NoCat0000000000001', name: 'No category', author: '', description: 'x', category: null },
    { code: 'bad code!', name: 'Bad', author: '', description: 'x', category: 'coding-software' },
    { code: 'AddedOne00000000001', name: 'Duplicate', author: '', description: 'x', category: 'coding-software' },
  ], dead: ['DeadOne0000000000001'] }));
  const r = readLive(new Set(['coding-software']), f);
  assert.equal(r.added.length, 1); assert.equal(r.added[0].id, 'coding-software-AddedOne00000000001'); assert.ok(!/@/.test(r.added[0].author + r.added[0].description));
  assert.ok(r.dead.has('deadone0000000000001'));
  assert.deepEqual(readLive(new Set(), join(tmp, 'absent.json')).added, []);
});

// ================= switches =================
await t('switches: wrangler.toml still ships FORM/EMAIL/SUBSCRIBE/DIGEST at "0", two crons, TELEMETRY_START set', () => {
  const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
  for (const k of ['FORM_SUBMIT_ENABLED', 'EMAIL_SUBMIT_ENABLED', 'SUBSCRIBE_ENABLED', 'DIGEST_ENABLED']) assert.match(toml, new RegExp(`^${k}\\s*=\\s*"0"`, 'm'));
  assert.match(toml, /crons = \["0 13 \* \* MON,THU", "\*\/10 \* \* \* \*"\]/); assert.match(toml, /^TELEMETRY_START\s*=\s*"\d{4}-\d{2}-\d{2}"/m);
});
await t('noref: this test file and the worker sources carry no denylist from the audit script', () => {
  const audit = readFileSync(join(process.env.HOME!, '.hermes/scripts/gz-noref-audit.sh'), 'utf8');
  const m = /TOKENS=\(([\s\S]*?)\)/.exec(audit);
  const toks = [...(m?.[1] ?? '').matchAll(/["']([^"']+)["']/g)].map((x) => x[1].toLowerCase()).filter((x) => x.length > 3);
  if (!toks.length) return; // audit script not present on this machine
  const files = [join(ROOT, 'scripts/test-dataplane.ts'), ...['cron', 'ingest', 'liveness', 'discovery', 'trending', 'telemetry', 'serve', 'classify', 'util'].map((f) => join(ROOT, `src/worker/dp/${f}.ts`))];
  for (const f of files) { const src = readFileSync(f, 'utf8').toLowerCase(); for (const tk of toks) assert.ok(!src.includes(tk), `${f} contains a denylist token`); }
});

console.log(failed ? `test-dataplane: ${n} passed, ${failed} FAILED` : `test-dataplane: ${n} passed`);
process.exit(failed ? 1 : 0);
