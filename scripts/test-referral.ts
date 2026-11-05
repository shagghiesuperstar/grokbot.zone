// GET /go/grok: one deduped referral click per visitor per UTC day, then 302 to REFERRAL_URL.
// Usage: pnpm exec tsx scripts/test-referral.ts
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { REFERRAL_URL } from '../src/lib/referral';

const EXPECTED = 'https://grok.com/refer/bot?code=B4ZFFHHS64AC';
const ROOT = resolve(import.meta.dirname, '..');
const MIGRATIONS = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(join(ROOT, 'migrations', f), 'utf8'));
const HUMAN = 'Mozilla/5.0 (Macintosh) AppleWebKit/605 Safari/605';
const BOT = 'curl/8.4';

class FakeD1 {
  db = new DatabaseSync(':memory:');
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
      async first() { const r = self.exec(sql, args).results[0]; return r ?? null; },
      async all() { return self.exec(sql, args); },
      async run() { return { success: true, ...self.exec(sql, args) }; },
    });
    return bound([]);
  }
  rows(sql: string, ...args: unknown[]) { return this.db.prepare(sql).all(...(args as never[])).map((r) => ({ ...(r as object) })) as any[]; }
}

const tmp = mkdtempSync(join(tmpdir(), 'gz-test-referral-'));
writeFileSync(join(tmp, 'email-stub.mjs'), 'export class EmailMessage {}\n');
const out = join(tmp, 'worker.mjs');
await build({
  entryPoints: [join(ROOT, 'src/worker/index.ts')], outfile: out, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  conditions: ['workerd', 'worker', 'browser'], external: ['node:*'], logLevel: 'warning',
  plugins: [{ name: 'stub', setup: (b) => b.onResolve({ filter: /^cloudflare:email$/ }, () => ({ path: join(tmp, 'email-stub.mjs') })) }],
});
const worker = (await import(pathToFileURL(out).href)).default as { fetch(r: Request, e: unknown, c: unknown): Promise<Response> };

const envOf = (db: FakeD1) => ({
  DB: db,
  ASSETS: { fetch: async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }) },
  FORM_SUBMIT_ENABLED: '0', EMAIL_SUBMIT_ENABLED: '0', SUBSCRIBE_ENABLED: '0', DIGEST_ENABLED: '0',
});
async function get(env: ReturnType<typeof envOf>, headers: Record<string, string>, path = '/go/grok') {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
  const res = await worker.fetch(new Request(`https://grokbot.zone${path}`, { method: 'GET', redirect: 'manual', headers }), env, ctx);
  await Promise.all(pending);
  return res;
}
const clicks = (db: FakeD1) => db.rows('SELECT day, vh FROM referral_clicks ORDER BY vh');

let failed = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${(e as Error).message.split('\n').slice(0, 4).join(' | ')}`); }
};

await t('Location of /go/grok is byte-identical to the referral URL, with no-store redirect headers', async () => {
  assert.equal(REFERRAL_URL, EXPECTED, 'src/lib/referral.ts is still the single source');
  const db = new FakeD1();
  const res = await get(envOf(db), { 'user-agent': HUMAN, 'cf-connecting-ip': '203.0.113.7' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), EXPECTED);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

await t('same-day double click is one row; a second visitor is a second row; neither lands in bot_daily or visit_seen', async () => {
  const db = new FakeD1();
  const env = envOf(db);
  const a = { 'user-agent': HUMAN, 'cf-connecting-ip': '203.0.113.7' };
  await get(env, a);
  await get(env, a);
  assert.equal(clicks(db).length, 1, 'same visitor, same UTC day');
  await get(env, { ...a, 'cf-connecting-ip': '203.0.113.8' });
  assert.equal(clicks(db).length, 2, 'second visitor');
  assert.equal(new Set(clicks(db).map((r) => r.vh)).size, 2);
  assert.equal(db.rows('SELECT * FROM visit_seen').length, 0);
  assert.equal(db.rows('SELECT * FROM bot_daily').length, 0);
  assert.equal(JSON.stringify(clicks(db)).includes('203.0.113'), false, 'no raw IP stored');
});

await t('a bot user-agent is redirected and writes zero rows', async () => {
  const db = new FakeD1();
  const res = await get(envOf(db), { 'user-agent': BOT, 'cf-connecting-ip': '203.0.113.9' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), EXPECTED);
  assert.equal(clicks(db).length, 0);
  assert.equal(db.rows('SELECT * FROM visit_seen').length, 0);
  assert.equal(db.rows('SELECT * FROM bot_daily').length, 0);
});

await t('a referral write failure still redirects', async () => {
  const db = new FakeD1();
  const orig = db.prepare.bind(db);
  db.prepare = (sql: string) => { if (/referral_clicks/.test(sql)) throw new Error('D1_ERROR: down'); return orig(sql); };
  const res = await get(envOf(db), { 'user-agent': HUMAN, 'cf-connecting-ip': '203.0.113.10' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), EXPECTED);
});

await t('both ReferralCTA renderings point at /go/grok and the worker does not hardcode the URL', async () => {
  const cta = readFileSync(join(ROOT, 'src/components/ReferralCTA.astro'), 'utf8');
  const home = readFileSync(join(ROOT, 'src/pages/index.astro'), 'utf8');
  const article = readFileSync(join(ROOT, 'src/components/BotArticle.astro'), 'utf8');
  const faq = readFileSync(join(ROOT, 'src/pages/faq.astro'), 'utf8');
  const telemetry = readFileSync(join(ROOT, 'src/worker/dp/telemetry.ts'), 'utf8');
  assert.match(cta, /href="\/go\/grok"/);
  assert.match(cta, /rel="sponsored noopener"/);
  assert.match(cta, /target="_blank"/);
  assert.ok(!cta.includes('grok.com/refer'), 'CTA must not bypass /go/grok');
  assert.match(home, /<ReferralCTA\s*\/>/);
  assert.match(article, /<ReferralCTA compact\s*\/>/);
  assert.match(faq, /referral link to Grok Bot/);
  assert.ok(!faq.includes('/go/grok'), 'FAQ copy is unchanged');
  assert.match(telemetry, /REFERRAL_URL/);
  assert.ok(!telemetry.includes('B4ZFFHHS64AC'), 'referral code stays in src/lib/referral.ts');
  assert.ok(!telemetry.includes('grok.com/refer'), 'referral URL stays in src/lib/referral.ts');
});

console.log(failed ? `test-referral: ${5 - failed} passed, ${failed} FAILED` : 'test-referral: 5 passed');
process.exit(failed ? 1 : 0);
