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
import { LIST_ADD_CAP, extractCodes, parseSources, pullLists, queueCodes } from '../src/worker/dp/lists';
import { build as buildTrending, order, prior, SEED_RANK, type Scored } from '../src/worker/dp/trending';
import { runDataPlane } from '../src/worker/dp/cron';
import { healthBody, recentList, trendingList } from '../src/worker/dp/serve';
import { clientKey, isHuman, record, resetDeadCache, resetSaltCache } from '../src/worker/dp/telemetry';
import { classify, tokenize } from '../src/worker/dp/classify';
import { readLive } from './lib-live';
import { categoriesWithoutDead, deadSeedCount, indexWithoutDead } from '../src/worker/dp/merge';
import model from '../src/data/classifier.json';

// workerd provides HTMLRewriter; under Node the test uses the same lol-html engine from the `htmlrewriter` package.
(globalThis as unknown as { HTMLRewriter: unknown }).HTMLRewriter = (await import('htmlrewriter')).HTMLRewriter;
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

await t('category counts: a dead bot in category X drops X by 1, from the same dead set as totalBots', () => {
  const dead = new Set(['deadcode000000000001', 'nevershipped000000001']);
  const seed = new Map([['deadcode000000000001', 'DeadCode000000000001'], ['livecode0000000000001', 'LiveCode0000000000001']]);
  const cats = new Map([['deadcode000000000001', ['travel']], ['livecode0000000000001', ['travel']]]);
  const index = JSON.stringify({ asOf: '2026-10-28', totalBots: 2, categories: [
    { slug: 'travel', label: 'Travel', count: 2, path: '/search/travel.json' },
    { slug: 'food-recipes-dining', label: 'Food', count: 4, path: '/search/food-recipes-dining.json' },
  ] });
  const out = JSON.parse(indexWithoutDead(index, dead, seed, cats));
  assert.equal(out.categories.find((c: { slug: string }) => c.slug === 'travel').count, 1, 'X drops by 1');
  assert.equal(out.categories.find((c: { slug: string }) => c.slug === 'food-recipes-dining').count, 4, 'a category with no dead bot is unchanged');
  assert.equal(out.totalBots, 1, 'an unshipped dead code does not change totalBots');
  const api = JSON.parse(categoriesWithoutDead(JSON.stringify([
    { slug: 'travel', label: 'Travel', count: 2, purpose: 'p', updated: '2026-10-28' },
    { slug: 'food-recipes-dining', label: 'Food', count: 4, purpose: 'p', updated: '2026-10-28' },
  ]), dead, cats));
  assert.equal(api.find((c: { slug: string }) => c.slug === 'travel').count, 1);
  assert.equal(api.find((c: { slug: string }) => c.slug === 'food-recipes-dining').count, 4);
});
await t('category counts: a bot in two categories drops each listing, totalBots drops once', () => {
  const dead = new Set(['both00000000000000001']);
  const seed = new Map([['both00000000000000001', 'Both00000000000000001']]);
  const cats = new Map([['both00000000000000001', ['travel', 'food-recipes-dining']]]);
  const out = JSON.parse(indexWithoutDead(JSON.stringify({ totalBots: 5, categories: [{ slug: 'travel', count: 3 }, { slug: 'food-recipes-dining', count: 2 }] }), dead, seed, cats));
  assert.equal(out.totalBots, 4);
  assert.equal(out.categories[0].count, 2);
  assert.equal(out.categories[1].count, 1);
  const listings = out.categories.reduce((n: number, c: { count: number }) => n + c.count, 0);
  assert.equal(listings, 3);
  assert.notEqual(listings, out.totalBots, 'sum of category counts is listings, not distinct bots');
});
await t('missing seed-codes.json logs and throws; it does not report 0 dead', () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try {
    let threw = false;
    try { deadSeedCount(new Set(['abc']), null); } catch { threw = true; }
    assert.equal(threw, true);
    assert.ok(logs.some((l) => l.includes('seed-codes.json')), logs.join('\n') || '(no log)');
    assert.equal(deadSeedCount(new Set(), null), 0, 'no dead codes: nothing to subtract');
  } finally { console.error = orig; }
});

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
await t('filters: a denylist hit in the author, name or description excludes the bot (author is also blanked); empty list excludes nothing', () => {
  const list = denylist(`${FAKE}|other`);
  assert.deepEqual(list, [FAKE, 'other']);
  const a = scrub({ name: 'Fine', author: `By ${FAKE.toUpperCase()}`, description: 'ok' }, list);
  assert.equal(a.author, ''); assert.equal(a.excluded, true);
  assert.equal(scrub({ name: 'Fine', author: 'Ann', description: 'ok' }, list).excluded, false);
  assert.equal(scrub({ name: `My ${FAKE}`, author: `By ${FAKE}`, description: `${FAKE}` }, denylist('')).excluded, false);
  assert.equal(scrub({ name: `My ${FAKE}`, author: '', description: '' }, denylist(undefined)).excluded, false);
  assert.equal(scrub({ name: `My ${FAKE} bot`, author: '', description: 'ok' }, list).excluded, true);
  assert.equal(scrub({ name: 'Fine', author: '', description: `about ${FAKE}` }, list).excluded, true);
  const head = parseHead(`<meta property="og:title" content="${FAKE} helper by Ann"><meta property="og:description" content="d">`);
  assert.equal(ingest(head, CODE(1), list, model as never)!.excluded, true);
});
await t('cron: an author-only denylist hit publishes nothing: the row is excluded, not live', async () => {
  const db = new FakeD1(); insertBot(db, CODE(1), { source: 'listing', status: 'pending', name: '', category: null, cats: null });
  const c = clock();
  const p = platform(() => ({ status: 200, body: `<head><link rel="canonical" href="x"><meta property="og:title" content="Fine Helper by ${FAKE} Co"><meta property="og:description" content="ok"></head><body>` }), c);
  await runDataPlane({ DB: db as never, NOREF_TOKENS: FAKE, TELEMETRY_START: '2026-11-01' }, c.t, { fetch: p.f, clock: c });
  assert.equal(db.one('SELECT status FROM bots WHERE code_lc=?', CODE(1).toLowerCase()).status, 'excluded');
  const h = await healthBody(db as never, c.t, new Date(c.t).toISOString(), true, {});
  assert.deepEqual(h.discovery.noref, { configured: true, excluded: 1 });
  assert.equal((await healthBody(new FakeD1() as never, c.t, new Date(c.t).toISOString(), false, {})).discovery.noref.configured, false);
  assert.ok(!JSON.stringify(h).includes(FAKE), 'health carries counts only');
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
  assert.ok(html.includes('href="/bots/coding-software-zzcode/"'), 'every live card links to its own page (D27)');
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
  const ctx = ctxOf(); const q0 = (env as { DB?: FakeD1 }).DB?.queries ?? 0;
  const res = await worker.fetch(new Request(`https://grokbot.zone${path}`, { method, redirect: 'manual', headers }), env, ctx); await ctx.drain();
  return { res, queries: ((env as { DB?: FakeD1 }).DB?.queries ?? 0) - q0 };
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
await t('A0/B1 telemetry (AR-08 F2): one client rotating its user agent is still one open and one view per bot per day', async () => {
  resetSaltCache(); const db = new FakeD1(); insertBot(db, LIVE); const env = envOf(db);
  const id = `coding-software-${LIVE}`;
  for (const ua of [HUMAN, HUMAN + ' Edg/1', 'Mozilla/5.0 (X11; Linux) Firefox/130', 'Mozilla/5.0 (iPhone) Mobile/15E148']) {
    const h = { 'user-agent': ua, 'cf-connecting-ip': '203.0.113.50' };
    await get(env, `/go/${LIVE}`, h); await get(env, `/bots/${id}/`, h);
  }
  assert.deepEqual(opens(db), { o: 1, v: 1 });
  assert.equal(db.rows('SELECT * FROM visit_seen').length, 2, 'one row per kind');
  assert.equal(JSON.stringify(db.rows('SELECT * FROM visit_seen')).includes('203.0.113'), false, 'no raw IP stored');
  // a different client is still a different visitor; the same client on the next UTC day counts again
  await get(env, `/go/${LIVE}`, { 'user-agent': HUMAN, 'cf-connecting-ip': '203.0.113.51' });
  assert.equal(opens(db).o, 2);
  const h2 = { 'user-agent': 'Other/1', 'cf-connecting-ip': '203.0.113.50' };
  await record(db as never, 'open', LIVE.toLowerCase(), new Request('https://x/', { headers: h2 }), Date.now() + 86_400_000);
  assert.equal(opens(db).o, 3, 'next day, same client: a new visit');
});
await t('B1 telemetry: an IPv6 client is its /64 (rotating the host part is one visitor); IPv4 stays whole', async () => {
  assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
  const same = ['2001:db8:abcd:12:1:2:3:4', '2001:DB8:ABCD:0012:ffff::1', '2001:db8:abcd:12::'].map(clientKey);
  assert.deepEqual(new Set(same).size, 1, same.join(' | '));
  assert.notEqual(clientKey('2001:db8:abcd:13::1'), clientKey('2001:db8:abcd:12::1'));
  assert.equal(clientKey('::1'), '0:0:0:0'); assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0');
  resetSaltCache(); const db = new FakeD1(); insertBot(db, LIVE); const env = envOf(db);
  for (const ip of ['2001:db8:abcd:12::1', '2001:db8:abcd:12:aaaa:bbbb:cccc:dddd']) await get(env, `/go/${LIVE}`, { 'user-agent': HUMAN, 'cf-connecting-ip': ip });
  assert.equal(opens(db).o, 1);
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
const SEED_JSON = JSON.stringify({ codes: ['SeedCodeAbCdEfGhIjKl1', 'ShortSeed11'] });
const seedAssets = { fetch: async (r: Request) => new URL(r.url).pathname === '/api/v1/seed-codes.json' ? new Response(SEED_JSON, { headers: { 'content-type': 'application/json' } }) : new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }) };
for (const [label, mode] of [['D1 throws', 'throw'], ['D1 binding missing', 'missing']] as const) {
  await t(`O6 /go/ fails closed when ${label}: seed codes 302 to their own spelling, every other code 404, nothing recorded`, async () => {
    resetSaltCache();
    const db = new FakeD1(); const env = envOf(db, { ASSETS: seedAssets }); const writes: string[] = [];
    if (mode === 'throw') (db as any).prepare = (sql: string) => { writes.push(sql); throw new Error('down'); }; else delete (env as any).DB;
    for (const bad of [`/go/zzzzzzzzzzzzzzzzzzzz0`, '/go/short', '/go/' + 'a'.repeat(64), '/go/bad%20code']) { const r = await get(env, bad, { 'user-agent': HUMAN }); assert.equal(r.res.status, 404, bad); assert.equal(r.res.headers.get('location'), null, bad); }
    const ok = await get(env, '/go/seedcodeabcdefghijkl1', { 'user-agent': HUMAN });
    assert.equal(ok.res.status, 302); assert.equal(ok.res.headers.get('location'), 'https://x.ai/bot/SeedCodeAbCdEfGhIjKl1', 'the spelling comes from the built list, not the request');
    assert.equal((await get(env, '/go/ShortSeed11', { 'user-agent': HUMAN })).res.status, 302, 'the 11-character seed bot still opens');
    assert.ok(!writes.some((q) => /INSERT|UPDATE/i.test(q)), 'no telemetry write on the fallback path');
  });
}
await t('O6 /go/ fails closed when D1 is down and the seed list cannot be read: 404, never a 5xx', async () => {
  const db = new FakeD1(); (db as any).prepare = () => { throw new Error('down'); };
  const env = envOf(db, { ASSETS: { fetch: async () => { throw new Error('assets down'); } } });
  for (const p of [`/go/${LIVE}`, '/go/seedcodeabcdefghijkl1']) assert.equal((await get(env, p)).res.status, 404, p);
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
  const assets = { fetch: async (r: Request) => { seen.push(r.headers.get('if-none-match')); return r.headers.get('if-none-match') ? new Response(null, { status: 304 }) : new Response('<html><head><title>x</title></head><body><article class="wrap bot"><h1>X</h1></article></body></html>', { status: new URL(r.url).pathname.includes('absent') ? 404 : 200, headers: { 'content-type': 'text/html', etag: '"abc"' } }); } };
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
// ================= D27/D28/O10/O11: pages and lists without a deploy =================
import { existsSync } from 'node:fs';
import { indexRecord, mergeLive, search } from '../src/lib/search';
const DIST = join(ROOT, 'dist');
if (!existsSync(join(DIST, 'bot-template/index.html'))) throw new Error('run `pnpm build` before the dataplane tests (they read dist/)');
const distFile = (p: string) => readFileSync(join(DIST, p), 'utf8');
const SEED_BOT = (JSON.parse(readFileSync(join(ROOT, 'src/data/bots.json'), 'utf8')) as { slug: string; code: string; cat: string }[])[0];
const SEED_BOT2 = (JSON.parse(readFileSync(join(ROOT, 'src/data/bots.json'), 'utf8')) as { slug: string; code: string; cat: string }[]).find((b) => b.cat === SEED_BOT.cat && b.slug !== SEED_BOT.slug)!;
const STATIC: Record<string, [string, string]> = {
  '/bot-template/': ['bot-template/index.html', 'text/html'], '/api/v1/seed-codes.json': ['api/v1/seed-codes.json', 'application/json'],
  '/feed.json': ['feed.json', 'application/json'], '/feed.xml': ['feed.xml', 'application/xml'], '/sitemap-index.xml': ['sitemap-index.xml', 'application/xml'], '/sitemap-0.xml': ['sitemap-0.xml', 'application/xml'],
  '/search/live.json': ['search/live.json', 'application/json'], '/search/index.json': ['search/index.json', 'application/json'],
  '/api/v1/index.json': ['api/v1/index.json', 'application/json'], '/api/v1/codes.json': ['api/v1/codes.json', 'application/json'],
  '/api/v1/categories.json': ['api/v1/categories.json', 'application/json'],
  [`/search/${SEED_BOT2.cat}.json`]: [`search/${SEED_BOT2.cat}.json`, 'application/json'],
  [`/api/v1/categories/${SEED_BOT2.cat}.json`]: [`api/v1/categories/${SEED_BOT2.cat}.json`, 'application/json'],
  '/categories/travel/': ['categories/travel/index.html', 'text/html'], [`/bots/${SEED_BOT.slug}/`]: [`bots/${SEED_BOT.slug}/index.html`, 'text/html'], [`/categories/${SEED_BOT.cat}/`]: [`categories/${SEED_BOT.cat}/index.html`, 'text/html'],
};
const distAssets = { fetch: async (r: Request) => {
  const p = new URL(r.url).pathname; const hit = STATIC[p];
  return hit ? new Response(distFile(hit[0]), { headers: { 'content-type': hit[1] } }) : new Response(distFile('404.html'), { status: 404, headers: { 'content-type': 'text/html' } });
} };
const NEW_A = 'NewTravel000000000001', NEW_B = 'NewNoCat0000000000001', NEW_X = 'NewScript00000000001', NEW_DEAD = 'NewDead00000000000001', NEW_EXC = 'NewExcl00000000000001', NEW_PEND = 'NewPend0000000000001';
function liveDb() {
  resetDeadCache(); resetSaltCache(); const db = new FakeD1();
  insertBot(db, SEED_BOT.code, { category: SEED_BOT.cat, cats: SEED_BOT.cat }); insertBot(db, SEED_BOT2.code, { category: SEED_BOT2.cat, cats: SEED_BOT2.cat });
  insertBot(db, NEW_A, { source: 'listing', name: 'Fresh Trip Bot', author: 'Mia', description: 'Plans trips quickly.', category: 'travel', cats: 'travel', first_seen: '2026-11-05' });
  insertBot(db, NEW_B, { source: 'archive', name: 'No Category Bot', author: '', description: 'Does odd jobs.', category: null, cats: null, first_seen: '2026-11-04' });
  insertBot(db, NEW_X, { source: 'listing', name: '"><script>alert(1)</script>', author: '<b>x</b>', description: 'a & b <i>', category: 'travel', cats: 'travel', first_seen: '2026-11-03' });
  insertBot(db, NEW_DEAD, { source: 'listing', status: 'dead', name: 'Gone Bot', category: 'travel', cats: 'travel' });
  insertBot(db, NEW_EXC, { source: 'listing', status: 'excluded', name: 'Hidden Bot', category: 'travel', cats: 'travel' });
  insertBot(db, NEW_PEND, { source: 'listing', status: 'pending', name: '', category: null, cats: null });
  db.db.prepare("UPDATE bots SET last_live='2026-11-02T00:00:00Z' WHERE source != 'seed' AND status IN ('live','dead','excluded')").run();
  return db;
}
const fillStore = async (db: FakeD1, over: Record<string, unknown> = {}) => {
  const c = clock(Date.parse('2026-11-10T12:05:00Z'));
  // the dead seed bot answers 404 so it stays dead; everything else answers 200
  const p = platform((u) => (u.endsWith(SEED_BOT2.code) || u.endsWith(NEW_DEAD)) ? { status: 404 } : { status: 200, body: '<head></head>' }, c);
  db.db.prepare("UPDATE bots SET status='dead' WHERE code_lc=?").run(SEED_BOT2.code.toLowerCase());
  const env = envOf(db, { ASSETS: distAssets, ...over }); await runDataPlane(env as never, c.t, { fetch: p.f, clock: c });
  db.db.prepare("UPDATE bots SET status='dead', fail_count=3, first_fail='2026-10-01T00:00:00Z' WHERE code_lc=?").run(NEW_DEAD.toLowerCase());
  return env;
};
await t('D27: a live D1-only bot gets its page (200, escaped, head, /go/ link); a <script> name renders inert', async () => {
  const db = liveDb(); const env = envOf(db, { ASSETS: distAssets }); const h = { 'user-agent': HUMAN, 'cf-connecting-ip': '198.51.100.9' };
  const ok = await get(env, `/bots/travel-${NEW_A}/`, h); const html = await ok.res.text();
  assert.equal(ok.res.status, 200); assert.equal(ok.res.headers.get('cache-control'), 'public, s-maxage=3600'); assert.ok(ok.queries <= 50, `${ok.queries}`); console.log(`      D1-rendered bot page: ${ok.queries} D1 queries`);
  assert.ok(html.includes('<title>Fresh Trip Bot by Mia (Travel) | Grok bot | GrokBot Zone</title>') && html.includes(`rel="canonical" href="https://grokbot.zone/bots/travel-${NEW_A}/"`));
  assert.ok(html.includes(`href="/go/${NEW_A}"`) && /rel="nofollow noopener"[^>]*data-open-bot|data-open-bot[^>]*rel="nofollow noopener"|rel="nofollow noopener" target="_blank"/.test(html));
  assert.ok(!/name="robots"/.test(html), 'a filled page is indexable'); assert.ok(html.includes('og:title') && html.includes('application/ld+json'));
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  assert.equal(ld[0]['@type'], 'SoftwareApplication'); assert.equal(ld[1].itemListElement.length, 3);
  assert.deepEqual(opens(db, NEW_A.toLowerCase()), { o: 0, v: 1 }, 'the view is counted (D17b)');
  const xs = await (await get(env, `/bots/travel-${NEW_X}/`, h)).res.text();
  // Inside a double-quoted attribute `<` is inert (the quote is escaped), so look at the markup with attribute values removed.
  const markup = xs.replace(/="[^"]*"/g, '=""').replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
  assert.ok(!markup.includes('<script>alert(1)') && !markup.includes('<b>x</b>') && xs.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'name is inert');
  const scripts = (h: string) => (h.replace(/="[^"]*"/g, '=""').match(/<script\b/g) ?? []).length;
  assert.equal(scripts(xs), scripts(distFile('bot-template/index.html')), 'no extra script element'); assert.ok(!/<script>alert/.test(markup));
  const ldx = [...xs.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])); assert.equal(ldx[0].name, '"><script>alert(1)</script>');
  const nocat = await get(env, `/bots/uncategorized-${NEW_B}/`, h); const nc = await nocat.res.text();
  assert.equal(nocat.res.status, 200); assert.ok(!nc.includes('/categories/travel/') && JSON.parse([...nc.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)][1][1]).itemListElement.length === 2);
});
await t('D2 /categories/uncategorized/: lists the live bots without a category, escaped, noindex, no category structured data; empty -> a note', async () => {
  const db = liveDb(); const env = await fillStore(db); resetDeadCache();
  for (const path of ['/categories/uncategorized/', '/categories/uncategorized']) {
    const r = await get(env, path); const html = await r.res.text();
    assert.equal(r.res.status, 200, path); assert.ok(r.queries <= 50);
    assert.ok(html.includes('<h1>Uncategorized</h1>') && html.includes(`href="/bots/uncategorized-${NEW_B}/"`) && html.includes('No Category Bot'));
    assert.ok(!html.includes('Fresh Trip Bot') && !html.includes('Gone Bot') && !html.includes('Hidden Bot'), 'only live bots without a category');
    assert.match(html, /data-count><span class="num">1<\/span>/); assert.match(html, /name="robots" content="noindex"/);
    assert.ok(!html.includes('application/ld+json') && !html.includes('/categories/travel/"'), 'nothing left of the frame category');
    assert.ok(html.includes('rel="canonical" href="https://grokbot.zone/categories/uncategorized/"'));
  }
  const empty = await get(envOf(new FakeD1(), { ASSETS: distAssets }), '/categories/uncategorized/');
  assert.equal(empty.res.status, 200); assert.match(await empty.res.text(), /No bots are waiting for a category/);
  assert.match(distFile('categories/index.html'), /href="\/categories\/uncategorized\/"/, 'the categories index links to it');
  assert.ok(!/<span class="num">\d+<\/span> bots<\/p>/.test(distFile('categories/index.html')), 'D1: no static per-category counts on the index');
});
await t('D27: dead -> 410, excluded / pending / unknown / wrong id -> 404, the template URL -> 404', async () => {
  const db = liveDb(); const env = envOf(db, { ASSETS: distAssets }); db.db.prepare("INSERT INTO meta(k,v) VALUES('dead_json', ?)").run(JSON.stringify([NEW_DEAD.toLowerCase()]));
  assert.equal((await get(env, `/bots/travel-${NEW_DEAD}/`)).res.status, 410);
  for (const id of [`travel-${NEW_EXC}`, `uncategorized-${NEW_PEND}`, 'travel-ZZZZZZZZZZZZZZZZZZZZZ', `coding-software-${NEW_A}`, `uncategorized-${NEW_A}`, NEW_A]) assert.equal((await get(env, `/bots/${id}/`)).res.status, 404, id);
  assert.equal((await get(env, '/bot-template/')).res.status, 404); assert.equal((await get(env, '/bot-template')).res.status, 404);
  assert.match(distFile('bot-template/index.html'), /name="robots" content="noindex"/); assert.ok(!distFile('sitemap-0.xml').includes('bot-template'));
});
await t('D27: only a missing page falls through to D1; the asset binding\'s redirect for a no-slash seed URL is returned as is', async () => {
  const db = liveDb(); const redir = { fetch: async (r: Request) => new URL(r.url).pathname === `/bots/${SEED_BOT.slug}` ? new Response(null, { status: 307, headers: { location: `/bots/${SEED_BOT.slug}/` } }) : distAssets.fetch(r) };
  const r = await get(envOf(db, { ASSETS: redir }), `/bots/${SEED_BOT.slug}`); assert.equal(r.res.status, 307);
  assert.equal(r.res.headers.get('location'), `/bots/${SEED_BOT.slug}/`);
});
await t('O11: a seed bot page and the static JSON/feeds/sitemaps are byte-for-byte the built files when D1 has nothing for them', async () => {
  const db = liveDb(); const env = envOf(db, { ASSETS: distAssets });
  const page = await get(env, `/bots/${SEED_BOT.slug}/`, { 'user-agent': HUMAN }); assert.equal(await page.res.text(), distFile(`bots/${SEED_BOT.slug}/index.html`));
  for (const [path, file] of [['/feed.json', 'feed.json'], ['/feed.xml', 'feed.xml'], ['/sitemap-index.xml', 'sitemap-index.xml'], ['/sitemap-0.xml', 'sitemap-0.xml'], [`/categories/${SEED_BOT.cat}/`, `categories/${SEED_BOT.cat}/index.html`], ['/search/live.json', 'search/live.json']] as const)
    assert.equal(await (await get(env, path)).res.text(), distFile(file), `${path} before the first hourly job`);
  const filled = await fillStore(liveDb());
  const page2 = await get(filled, `/bots/${SEED_BOT.slug}/`, { 'user-agent': HUMAN }); assert.equal(await page2.res.text(), distFile(`bots/${SEED_BOT.slug}/index.html`), 'a live seed page is never touched');
});
await t('D28/O10: search, category page, feeds and sitemap gain live D1-only bots and lose dead ones, each within 50 D1 queries', async () => {
  const db = liveDb(); const env = await fillStore(db); resetDeadCache(); const q: [string, number][] = [];
  const g = async (path: string) => { const r = await get(env, path); q.push([path, r.queries]); assert.ok(r.queries <= 50, `${path} ${r.queries}`); return r.res.text(); };
  const live = JSON.parse(await g('/search/live.json')) as { bots: { i: string; n: string; cats: string[]; c?: string }[]; dead: string[] };
  const ids = live.bots.map((b) => b.i);
  assert.deepEqual(ids.sort(), [`travel-${NEW_A}`, `travel-${NEW_X}`, `uncategorized-${NEW_B}`].sort());
  assert.ok(live.dead.includes(NEW_DEAD.toLowerCase()) && live.dead.includes(SEED_BOT2.code.toLowerCase()) && !JSON.stringify(live).includes('Hidden Bot') && !JSON.stringify(live).includes('Gone Bot'));
  assert.deepEqual(live.bots.find((b) => b.i === `uncategorized-${NEW_B}`)!.cats, []);
  const byId = new Map<string, { rec: never; cats: string[] }>([[SEED_BOT2.slug, { rec: { i: SEED_BOT2.slug, n: 'x', a: '', d: '', r: 1 } as never, cats: [SEED_BOT2.cat] }]]);
  mergeLive(byId, live as never, ['travel', SEED_BOT.cat]);
  assert.ok(!byId.has(SEED_BOT2.slug), 'a dead seed bot leaves search'); assert.ok(byId.has(`travel-${NEW_A}`) && byId.get(`uncategorized-${NEW_B}`)!.cats[0] === 'uncategorized');
  // a bot with a category is on its category page, linked to its own page, and the printed count follows
  const tv = await g('/categories/travel/'); const tvStatic = distFile('categories/travel/index.html');
  assert.ok(tv.includes(`<li data-code="${NEW_A.toLowerCase()}">`) && tv.includes(`href="/bots/travel-${NEW_A}/"`), 'the live bot is on its category page');
  assert.ok(tv.includes(`<li data-code="${NEW_X.toLowerCase()}">`) && !tv.includes('<script>alert(1)') && !tv.includes(NEW_DEAD) && !tv.includes(NEW_EXC), 'escaped; dead and excluded are absent');
  const tn0 = Number(/data-count[^>]*><span class="num"[^>]*>(\d+)</.exec(tvStatic)![1]); const tn1 = Number(/data-count[^>]*><span class="num"[^>]*>(\d+)</.exec(tv)![1]);
  assert.equal(tn1, tn0 + 2, 'travel: static + two live bots');
  assert.ok(!(await g('/categories/travel/')).includes(`data-code="${NEW_B.toLowerCase()}"`), 'a bot with no category has no category page');
  // search finds the live D1-only bot (the real index + search code, fed the merged map); a dead one is gone
  const recs = [...byId.values()].map(({ rec, cats }) => indexRecord(rec as never, (rec as { c?: string }).c ?? cats[0], cats[0] === 'uncategorized' ? 'Uncategorized' : cats[0], []));
  assert.deepEqual(search(recs, 'Fresh Trip').map((h) => h.rec.i), [`travel-${NEW_A}`]); assert.equal(search(recs, 'No Category').length, 1); assert.equal(search(recs, 'Gone Bot').length, 0);
  const sc = await g(`/categories/${SEED_BOT.cat}/`); const stat = distFile(`categories/${SEED_BOT.cat}/index.html`);
  assert.ok(!sc.includes(`data-code="${SEED_BOT2.code.toLowerCase()}"`) && stat.includes(`data-code="${SEED_BOT2.code.toLowerCase()}"`), 'the dead seed bot is dropped from its category page');
  const n0 = Number(/data-count[^>]*><span class="num"[^>]*>(\d+)</.exec(stat)![1]); const n1 = Number(/data-count[^>]*><span class="num"[^>]*>(\d+)</.exec(sc)![1]);
  assert.equal(n1, n0 - 1 + (SEED_BOT.cat === 'travel' ? 2 : 0));
  const nodes = await Promise.all(['/feed.json', '/feed.xml', '/sitemap-index.xml', '/sitemap-0.xml', '/sitemap-live.xml'].map(g));
  const [fj, fx, si, s0, sl] = nodes;
  const items = JSON.parse(fj).items.map((i: { url: string }) => i.url);
  assert.ok(items.includes(`https://grokbot.zone/bots/travel-${NEW_A}/`) && !items.some((u: string) => u.toLowerCase().endsWith(`-${SEED_BOT2.code.toLowerCase()}/`)));
  assert.ok(fx.includes(`/bots/travel-${NEW_A}/`) && !fx.toLowerCase().includes(SEED_BOT2.code.toLowerCase()) && !fx.includes('<script>'));
  assert.ok(si.includes('sitemap-live.xml')); assert.ok(!s0.toLowerCase().includes(`-${SEED_BOT2.code.toLowerCase()}/`) && distFile('sitemap-0.xml').toLowerCase().includes(`-${SEED_BOT2.code.toLowerCase()}/`));
  assert.ok(sl.includes(`/bots/travel-${NEW_A}/`) && sl.includes(`/bots/uncategorized-${NEW_B}/`) && !sl.includes(NEW_DEAD) && !sl.includes(NEW_EXC));
  // same dead set on the search index, codes.json and totalBots: sitemap bot count == search index totalBots
  const idx = JSON.parse(await g('/search/index.json')) as { totalBots: number; categories: { slug: string; count: number }[] };
  const builtIdx = JSON.parse(distFile('search/index.json')) as { totalBots: number };
  const sitemapBots = (s0.match(/\/bots\/[^/<]+\//g) ?? []).length;
  assert.equal(idx.totalBots, builtIdx.totalBots - 1, 'totalBots drops the one dead seed bot, not the dead bot the build never shipped');
  assert.equal(sitemapBots, idx.totalBots, 'sitemap bot count == search index totalBots');
  const api = JSON.parse(await g('/api/v1/index.json')) as { totalBots: number };
  assert.equal(api.totalBots, idx.totalBots, '/api/v1/index.json totalBots matches the search index');
  const codes = JSON.parse(await g('/api/v1/codes.json')) as { codes: string[] };
  assert.equal(codes.codes.length, idx.totalBots);
  assert.ok(!codes.codes.includes(SEED_BOT2.code.toLowerCase()), 'codes.json drops the dead seed code');
  const builtCats = (builtIdx as { categories: { slug: string; count: number }[] }).categories;
  assert.equal(idx.categories.find((c) => c.slug === SEED_BOT2.cat)!.count, builtCats.find((c) => c.slug === SEED_BOT2.cat)!.count - 1, 'search index category count drops the dead seed bot');
  const apiCats = JSON.parse(await g('/api/v1/categories.json')) as { slug: string; count: number }[];
  const builtApi = JSON.parse(distFile('api/v1/categories.json')) as { slug: string; count: number }[];
  assert.equal(apiCats.find((c) => c.slug === SEED_BOT2.cat)!.count, builtApi.find((c) => c.slug === SEED_BOT2.cat)!.count - 1, '/api/v1/categories.json drops the same dead bot');
  const catSearch = JSON.parse(await g(`/search/${SEED_BOT2.cat}.json`)) as { count: number; bots: { i: string }[] };
  const apiCat = JSON.parse(await g(`/api/v1/categories/${SEED_BOT2.cat}.json`)) as { bots: { i: string }[] };
  assert.ok(!catSearch.bots.some((b) => b.i === SEED_BOT2.slug) && !apiCat.bots.some((b) => b.i === SEED_BOT2.slug), 'dead seed bot leaves the search payloads');
  assert.equal(catSearch.count, catSearch.bots.length);
  console.log('      ' + q.map(([p, n]) => `${p}=${n}`).join('  '));
});
await t('D27a: changes.json added lists every bot that was live once (id + code), keeps a dead one, never an excluded or pending one', async () => {
  const db = liveDb(); const env = await fillStore(db);
  const ch = JSON.parse(await (await get(env, '/api/v1/catalog/changes.json')).res.text()) as { added: { id: string; code: string }[]; dead: string[] };
  const codes = ch.added.map((a) => a.code);
  assert.ok(codes.includes(NEW_A) && codes.includes(NEW_B) && codes.includes(NEW_DEAD)); assert.ok(!codes.includes(NEW_EXC) && !codes.includes(NEW_PEND));
  assert.ok(ch.dead.includes(NEW_DEAD)); assert.ok(ch.added.every((a) => a.id.endsWith(a.code) && /^[a-z-]+-/.test(a.id)));
  assert.ok(!JSON.stringify(ch).includes('Hidden Bot'));
});
await t('D28: a live non-seed bot is in the stored extras only until the build ships a page; a static one is not duplicated', async () => {
  const db = liveDb(); const env = await fillStore(db);
  const only = { fetch: async (r: Request) => { const p = new URL(r.url).pathname; if (p === '/api/v1/seed-codes.json') return new Response(JSON.stringify({ codes: [NEW_A] })); return distAssets.fetch(r); } };
  const e2 = { ...(env as object), ASSETS: only } as never; resetDeadCache();
  const live = JSON.parse(await (await get(e2, '/search/live.json')).res.text()); assert.ok(!live.bots.some((b: { i: string }) => b.i.endsWith(NEW_A)), 'already in the static files');
});
await t('missing seed-codes.json logs and the count endpoints refuse instead of reporting 0 dead', async () => {
  const db = liveDb(); const filled = await fillStore(db);
  const broken = { fetch: async (r: Request) => new URL(r.url).pathname === '/api/v1/seed-codes.json' ? new Response('no', { status: 404 }) : distAssets.fetch(r) };
  const env = { ...(filled as object), ASSETS: broken };
  const logs: string[] = []; const orig = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try {
    resetDeadCache();
    assert.equal((await get(env, '/search/index.json')).res.status, 503);
    assert.equal((await get(env, '/api/v1/categories.json')).res.status, 503);
    assert.ok(logs.some((l) => l.includes('seed-codes.json')), logs.join('\n') || '(no log)');
  } finally { console.error = orig; }
});

// ================= D30: submissions are processed like discovery =================
const SUB = (n: number) => `SubCode${String(n).padStart(14, '0')}`; // 21 chars
const subRow = (db: FakeD1, code: string, status = 'pending') => db.db.prepare("INSERT INTO submissions(source, status, name, author, description, code, link, category, submitter_email) VALUES('webform',?,'Typed Name','Typed Author','Typed description text',?,?,'travel','typed@example.test')").run(status, code, `https://x.ai/bot/${code.toLowerCase()}`);
const subBot = (db: FakeD1, code: string) => insertBot(db, code, { source: 'submission', status: 'pending', name: '', author: '', description: '', category: null, cats: null });
const headPage = (title: string) => `<head><link rel="canonical" href="x"><meta property="og:title" content="${title}"><meta property="og:description" content="Plans trips."></head><body>`;
await t('D30: a submitted bot goes live with the x.ai page title, its submission is approved, and the typed text is nowhere public', async () => {
  const db = new FakeD1(); insertBot(db, 'seedone0'); subRow(db, SUB(1)); subBot(db, SUB(1));
  const c = clock(Date.parse('2026-11-10T12:05:00Z')); const p = platform(() => ({ status: 200, body: headPage('Trip Planner Pro by Mia') }), c);
  const env = envOf(db); await runDataPlane(env as never, c.t, { fetch: p.f, clock: c });
  const r = db.one('SELECT * FROM bots WHERE code_lc=?', SUB(1).toLowerCase());
  assert.deepEqual([r.status, r.source, r.name, r.author], ['live', 'submission', 'Trip Planner Pro', 'Mia']);
  assert.equal(db.one('SELECT status FROM submissions').status, 'approved', 'settled in the same hourly pass, no person');
  const stored = db.rows('SELECT k, v FROM meta').map((x) => x.v).join('\n');
  for (const typed of ['Typed Name', 'Typed Author', 'Typed description', 'typed@example.test']) assert.ok(!stored.includes(typed), typed);
  for (const path of ['/api/v1/catalog/changes.json', '/api/v1/recent.json', '/api/v1/trending.json']) assert.ok(!(await (await get(env, path)).res.text()).includes('Typed'), path);
});
await t('D30: a submission whose bot ends dead or excluded is rejected automatically', async () => {
  const db = new FakeD1(); insertBot(db, 'seedone0'); subRow(db, SUB(2)); subBot(db, SUB(2)); subRow(db, SUB(3)); subBot(db, SUB(3));
  const c = clock(Date.parse('2026-11-10T12:05:00Z'));
  const p = platform((u) => u.endsWith(SUB(3)) ? { status: 404 } : u.endsWith(SUB(2)) ? { status: 200, body: headPage(`${FAKE} thing by Ann`) } : { status: 200, body: headPage('Fine Bot by Ann') }, c);
  db.db.prepare("UPDATE bots SET status='dead' WHERE code_lc=?").run(SUB(3).toLowerCase());
  const env = envOf(db); await runDataPlane(env as never, c.t, { fetch: p.f, clock: c });
  assert.equal(db.one('SELECT status FROM bots WHERE code_lc=?', SUB(2).toLowerCase()).status, 'excluded');
  assert.deepEqual(db.rows('SELECT code, status FROM submissions ORDER BY id').map((x) => x.status), ['rejected', 'rejected']);
});
await t('D3: a submission pending for more than 7 days is rejected as unresolved, its bot row is excluded, /api/health counts it; a younger one is left alone', async () => {
  const db = new FakeD1(); insertBot(db, 'seedone0'); subRow(db, SUB(40)); subBot(db, SUB(40)); subRow(db, SUB(41)); subBot(db, SUB(41));
  const c = clock(Date.parse('2026-11-10T12:05:00Z'));
  db.db.prepare("UPDATE submissions SET created_at='2026-11-01T00:00:00Z' WHERE code=?").run(SUB(40)); db.db.prepare("UPDATE bots SET first_seen='2026-11-01T00:00:00Z' WHERE code_lc=?").run(SUB(40).toLowerCase());
  db.db.prepare("UPDATE submissions SET created_at='2026-11-08T00:00:00Z' WHERE code=?").run(SUB(41)); db.db.prepare("UPDATE bots SET first_seen='2026-11-08T00:00:00Z' WHERE code_lc=?").run(SUB(41).toLowerCase());
  const p = platform(() => ({ status: 200, body: '<head></head>' }), c); // 200 without a title: never resolves
  const env = envOf(db); await runDataPlane(env as never, c.t, { fetch: p.f, clock: c });
  assert.deepEqual(db.rows('SELECT code, status FROM submissions ORDER BY id').map((x) => x.status), ['rejected', 'pending']);
  assert.deepEqual(db.rows('SELECT code_lc, status FROM bots WHERE source = ? ORDER BY first_seen', 'submission').map((x) => x.status), ['excluded', 'pending']);
  const h = await (await get(env, '/api/health')).res.json() as { submissions: { rejected_unresolved: number } };
  assert.equal(h.submissions.rejected_unresolved, 1);
});
await t('D30 budget: with 100 submission-sourced pending rows a run sends <= 10 requests for them and <= 40 in total', async () => {
  const db = new FakeD1(); for (let i = 0; i < 100; i++) subBot(db, SUB(100 + i)); for (let i = 0; i < 60; i++) insertBot(db, CODE(i));
  const c = clock(Date.parse('2026-11-10T12:05:00Z'));
  const p = platform((u) => u.includes('/bot/' + SUB(0).slice(0, 7)) ? { status: 308, headers: { location: '/bot/' + u.split('/bot/')[1].toLowerCase() } } : { status: 200, body: headPage('X by Y') }, c);
  const rep = await runDataPlane({ DB: db as never, NOREF_TOKENS: FAKE, TELEMETRY_START: '2026-11-01', ...{} } as never, c.t, { fetch: p.f, clock: c });
  const forSub = p.calls.filter((x) => x.url.includes('/bot/SubCode') || x.url.includes('/bot/subcode')).length;
  assert.ok(forSub <= 10 && forSub >= 5, `submission requests ${forSub}`); assert.ok(p.calls.length <= 40, `total ${p.calls.length}`); assert.ok(rep.queries <= 50);
  assert.ok(p.calls.filter((x) => x.url.includes('/bot/Bot')).length >= 15, 'live rows still get the rest of the run');
});
await t('D30 budget: a redirect follow costs a request, so 10 redirecting submissions stop at 10 requests', async () => {
  const db = new FakeD1(); for (let i = 0; i < 20; i++) subBot(db, SUB(200 + i));
  const c = clock(Date.parse('2026-11-10T12:05:00Z'));
  const p = platform((u) => { const code = u.split('/bot/')[1]; return code === code.toLowerCase() ? { status: 200, body: headPage('X by Y') } : { status: 308, headers: { location: '/bot/' + code.toLowerCase() } }; }, c);
  await runDataPlane({ DB: db as never, NOREF_TOKENS: FAKE, TELEMETRY_START: '2026-11-01' }, c.t, { fetch: p.f, clock: c });
  const forSub = p.calls.filter((x) => /\/bot\/[Ss]ub[Cc]ode/.test(x.url)).length;
  assert.ok(forSub <= 10, `submission requests ${forSub}`);
});

// ================= O7: one failed body read never ends the run =================
const brokenBody = () => new ReadableStream({ pull() { throw new Error('connection reset'); } });
function brokenPlatform(c: { t: number }, broken: (url: string) => boolean, ok: (url: string) => { status: number; body?: string }) {
  const calls: string[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push(String(url));
    if (broken(String(url))) return new Response(brokenBody(), { status: 200 });
    const r = ok(String(url)); return new Response(init.method === 'HEAD' ? null : r.body ?? '', { status: r.status });
  }) as unknown as typeof fetch;
  void c; return { f, calls };
}
await t('O7 F2: a listing page whose body read throws does not end the run (liveness and last_run still happen)', async () => {
  const db = new FakeD1(); for (let i = 0; i < 5; i++) insertBot(db, CODE(i));
  const c = clock(Date.parse('2026-11-10T04:10:00Z'));
  const p = brokenPlatform(c, (u) => u.endsWith('/marketplace'), () => ({ status: 200 }));
  const rep = await runDataPlane({ DB: db as never, NOREF_TOKENS: FAKE, TELEMETRY_START: '2026-11-01' }, c.t, { fetch: p.f, clock: c });
  assert.ok(rep.checked >= 5, `checked ${rep.checked}`); assert.ok(db.one("SELECT v FROM meta WHERE k='last_run'"), 'last_run stamped');
  assert.equal(db.one('SELECT COUNT(*) AS n FROM bots WHERE last_checked IS NOT NULL').n >= 5, true);
});
await t('O7 F2: a pending bot whose page body throws is stamped and stays pending; the next rows are still checked', async () => {
  const db = new FakeD1(); insertBot(db, CODE(1), { source: 'listing', status: 'pending', name: '', category: null, cats: null });
  insertBot(db, CODE(2), { source: 'listing', status: 'pending', name: '', category: null, cats: null }); for (let i = 10; i < 14; i++) insertBot(db, CODE(i));
  const c = clock(); const page = '<head><meta property="og:title" content="Tax Helper by Ann"><meta property="og:description" content="d"></head>';
  const p = brokenPlatform(c, (u) => u.endsWith(CODE(1)), (u) => ({ status: 200, body: u.endsWith(CODE(2)) ? page : '' }));
  const rep = await runDataPlane({ DB: db as never, NOREF_TOKENS: FAKE, TELEMETRY_START: '2026-11-01' }, c.t, { fetch: p.f, clock: c });
  const a = db.one('SELECT * FROM bots WHERE code_lc=?', CODE(1).toLowerCase());
  assert.equal(a.status, 'pending'); assert.ok(a.last_checked, 'stamped so it rotates'); assert.equal(db.one('SELECT status FROM bots WHERE code_lc=?', CODE(2).toLowerCase()).status, 'live');
  assert.ok(db.one("SELECT v FROM meta WHERE k='last_run'")); assert.ok(rep.checked >= 6, `checked ${rep.checked}`);
});
await t('O7: each phase has its own try; a failing phase is recorded as last_error and the run goes on', async () => {
  const db = new FakeD1(); for (let i = 0; i < 3; i++) insertBot(db, CODE(i));
  const orig = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => { if (/FROM bot_daily d JOIN bots/.test(sql)) throw new Error('D1_ERROR: boom sk-secret-stack\n    at x (file.js:1:1)'); return orig(sql); };
  const c = clock(Date.parse('2026-11-10T12:05:00Z')); const p = platform(() => ({ status: 200 }), c);
  const env = envOf(db); await runDataPlane(env as never, c.t, { fetch: p.f, clock: c });
  const le = JSON.parse(db.one("SELECT v FROM meta WHERE k='last_error'").v);
  assert.equal(le.phase, 'trending'); assert.ok(le.at); assert.ok(!le.message.includes('\n') && !le.message.includes(' at x'), 'no stack');
  assert.ok(db.one("SELECT v FROM meta WHERE k='last_run'"), 'last_run still stamped'); assert.ok(db.one("SELECT v FROM meta WHERE k='changes_json'"), 'recent/changes phase still ran');
  const h = JSON.parse(await (await get(env, '/api/health')).res.text()); assert.equal(h.last_error.phase, 'trending');
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
await t('switches: wrangler.toml ships FORM/EMAIL at "1", SUBSCRIBE/DIGEST at "0", no owner address, two crons, TELEMETRY_START set', () => {
  const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
  for (const [k, v] of [['FORM_SUBMIT_ENABLED', '1'], ['EMAIL_SUBMIT_ENABLED', '1'], ['SUBSCRIBE_ENABLED', '0'], ['DIGEST_ENABLED', '0'], ['OWNER_ADDRESS', '']]) assert.match(toml, new RegExp(`^${k}\\s*=\\s*"${v}"`, 'm'));
  assert.match(toml, /crons = \["0 13 \* \* MON,THU", "\*\/10 \* \* \* \*"\]/); assert.match(toml, /^TELEMETRY_START\s*=\s*"\d{4}-\d{2}-\d{2}"/m);
});

// ================= build 11: nightly list pull (LIST_SOURCES) =================
const LC = (n: number) => `Lst${String(n).padStart(18, '0')}`; // 21 chars
const lnk = (code: string) => `https://x.ai/bot/${code}`;
const SRC_A = 'https://example.test/a.json', SRC_B = 'https://example.test/b.txt';
const listRun = async (db: FakeD1, env: Record<string, unknown>, handler: (url: string) => { status: number; body?: string; headers?: Record<string, string> }) => {
  const c = clock(); const p = platform((url) => (url.startsWith('https://example.test/') ? handler(url) : { status: 200, body: '' }), c);
  const rep = await runDataPlane({ DB: db as never, TELEMETRY_START: '2026-11-01', ...env }, c.t, { fetch: p.f, clock: c });
  return { rep, calls: p.calls.filter((x) => x.url.startsWith('https://example.test/')), c };
};
await t('lists: unset, empty or blank LIST_SOURCES = zero fetches and no meta row', async () => {
  for (const v of [undefined, '', '  \n ']) {
    const db = new FakeD1(); const { calls, rep } = await listRun(db, v === undefined ? {} : { LIST_SOURCES: v }, () => ({ status: 200, body: lnk(LC(1)) }));
    assert.equal(calls.length, 0); assert.equal(rep.listed, undefined); assert.equal(db.one("SELECT COUNT(*) AS n FROM meta WHERE k='lists_stat'").n, 0);
  }
  let hit = 0; const r = await pullLists(undefined, (async () => { hit++; return new Response(''); }) as typeof fetch);
  assert.equal(hit, 0); assert.equal(r.sources, 0);
  assert.deepEqual(parseSources('http://example.test/x\nnot a url\n https://example.test/y \nhttps://example.test/y'), ['https://example.test/y']);
});
await t('lists: codes come out of a JSON body and a plain-text body, one GET per source, listing/pending rows', async () => {
  const db = new FakeD1();
  const json = JSON.stringify({ items: [{ name: 'x', link: lnk(LC(1)) }, { link: `${lnk(LC(2))}?ref=1` }, { link: lnk('short') }, { link: `${lnk(LC(3))}X` }] });
  const { rep, calls } = await listRun(db, { LIST_SOURCES: `${SRC_A}\n${SRC_B}` }, (u) => ({ status: 200, body: u === SRC_A ? json : `see ${lnk(LC(4))}, and\nx.ai/bot/${LC(5)}\n` }));
  assert.deepEqual(calls.map((x) => x.url), [SRC_A, SRC_B]); assert.ok(calls.every((x) => x.method === 'GET'));
  assert.equal(rep.listed, 4);
  const rows = db.rows("SELECT code, source, status, first_seen FROM bots ORDER BY code");
  assert.deepEqual(rows.map((r) => r.code), [LC(1), LC(2), LC(4), LC(5)]);
  for (const r of rows) { assert.equal(r.source, 'listing'); assert.equal(r.status, 'pending'); assert.equal(r.first_seen, new Date(T0).toISOString()); }
  assert.equal(db.one("SELECT COUNT(*) AS n FROM bots WHERE source='submission'").n, 0);
});
await t('lists: case-insensitive dedupe in the run; codes already in bots are not re-added or rewritten', async () => {
  const db = new FakeD1(); insertBot(db, LC(7), { source: 'seed', status: 'live', name: 'Kept' });
  const body = [lnk(LC(6)), lnk(LC(6).toUpperCase()), lnk(LC(6).toLowerCase()), lnk(LC(7).toUpperCase()), lnk(LC(7))].join('\n');
  const { rep } = await listRun(db, { LIST_SOURCES: `${SRC_A}\n${SRC_B}` }, () => ({ status: 200, body }));
  assert.equal(rep.listed, 1);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM bots').n, 2);
  const kept = db.one('SELECT * FROM bots WHERE code_lc=?', LC(7).toLowerCase()); assert.equal(kept.source, 'seed'); assert.equal(kept.name, 'Kept'); assert.equal(kept.status, 'live');
  assert.equal(db.one('SELECT code FROM bots WHERE code_lc=?', LC(6).toLowerCase()).code, LC(6));
  assert.deepEqual([...extractCodes(`${lnk('A'.repeat(21))} ${lnk('a'.repeat(21))}`).values()], ['A'.repeat(21)]);
});
await t('lists: at most 1,000 rows are added in one run; the rest arrive the next run', async () => {
  const db = new FakeD1(); const body = Array.from({ length: 1300 }, (_, i) => lnk(LC(i))).join('\n');
  const first = await listRun(db, { LIST_SOURCES: SRC_A }, () => ({ status: 200, body }));
  assert.equal(first.rep.listed, LIST_ADD_CAP); assert.equal(db.one("SELECT COUNT(*) AS n FROM bots WHERE source='listing'").n, 1000);
  db.db.exec("DELETE FROM meta WHERE k='discovery_last_run'"); // next night
  const second = await listRun(db, { LIST_SOURCES: SRC_A }, () => ({ status: 200, body }));
  assert.equal(second.rep.listed, 300); assert.equal(db.one("SELECT COUNT(*) AS n FROM bots WHERE source='listing'").n, 1300);
  // several chunks, cap inside the second chunk, known codes ahead of the new ones
  const db2 = new FakeD1(); for (let i = 0; i < 100; i++) insertBot(db2, LC(i));
  const added = await queueCodes(db2 as never, Array.from({ length: 4500 }, (_, i) => LC(i)), T0, 3000);
  assert.equal(added, 3000); assert.equal(db2.one("SELECT COUNT(*) AS n FROM bots WHERE source='listing'").n, 3000);
});
await t('lists: non-200, timeout and oversize are logged and skipped; the other sources and phases still run', async () => {
  const errs: string[] = []; const orig = console.error; console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  try {
    const db = new FakeD1(); insertBot(db, LC(50)); // a live row the checks phase must still reach
    const S = ['https://example.test/404', 'https://example.test/big', 'https://example.test/boom', 'https://example.test/ok'];
    const { rep } = await listRun(db, { LIST_SOURCES: S.join('\n'), NOREF_TOKENS: FAKE }, (u) => {
      if (u.endsWith('/404')) return { status: 404, body: lnk(LC(60)) };
      if (u.endsWith('/big')) return { status: 200, body: lnk(LC(61)), headers: { 'content-length': String(25 * 1024 * 1024) } };
      if (u.endsWith('/boom')) throw new DOMException('timed out', 'TimeoutError');
      return { status: 200, body: lnk(LC(62)) };
    });
    assert.deepEqual(db.rows("SELECT code FROM bots WHERE source='listing'").map((r) => r.code), [LC(62)]);
    const st = JSON.parse(db.one("SELECT v FROM meta WHERE k='lists_stat'").v);
    assert.deepEqual([st.sources, st.fetched_ok, st.added], [4, 1, 1]);
    assert.ok(db.one('SELECT last_checked FROM bots WHERE code_lc=?', LC(50).toLowerCase()).last_checked, 'checks phase still ran');
    assert.ok(db.one("SELECT v FROM meta WHERE k='discovery_last_run'"), 'discovery phase still ran'); assert.equal(rep.skipped, undefined);
    const log = errs.join('\n');
    assert.match(log, /status 404/); assert.match(log, /size cap/); assert.match(log, /timeout/); assert.ok(!log.includes('example.test'), 'no URL in logs');
    // health: counts only, never a URL
    const h = await healthBody(db as never, T0, new Date(T0).toISOString(), true, {});
    assert.deepEqual(h.discovery.lists, { last_run: st.last_run, sources: 4, fetched_ok: 1, added: 1 });
    assert.ok(!JSON.stringify(h).includes('example.test'));
    assert.deepEqual((await healthBody(new FakeD1() as never, T0, new Date(T0).toISOString(), true, {})).discovery.lists, { last_run: null, sources: 0, fetched_ok: 0, added: 0 });
  } finally { console.error = orig; }
});
await t('lists: a hanging source hits the timeout, a chunked body over the cap is dropped mid-read', async () => {
  const orig = console.error; console.error = () => {};
  try {
    const hang = (async (_u: string, init?: RequestInit) => new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)))) as typeof fetch;
    const keep = setInterval(() => {}, 10); // AbortSignal.timeout is unref'd under Node: keep the loop alive while the hang waits
    const a = await pullLists('https://example.test/slow', hang, { timeoutMs: 40 });
    clearInterval(keep);
    assert.deepEqual([a.sources, a.fetchedOk, a.codes.length], [1, 0, 0]);
    const big = (async () => new Response(lnk(LC(1)).repeat(200))) as typeof fetch; // no Content-Length on a string body? read path is checked either way
    const b = await pullLists('https://example.test/big', big, { maxBytes: 1000 });
    assert.deepEqual([b.fetchedOk, b.codes.length], [0, 0]);
    const ok = await pullLists('https://example.test/big', big, { maxBytes: 100_000 });
    assert.deepEqual([ok.fetchedOk, ok.codes.length], [1, 1]);
  } finally { console.error = orig; }
});
await t('noref: this test file and the worker sources carry no denylist from the audit script', () => {
  const audit = readFileSync(join(process.env.HOME!, '.hermes/scripts/gz-noref-audit.sh'), 'utf8');
  const m = /TOKENS=\(([\s\S]*?)\)/.exec(audit);
  const toks = [...(m?.[1] ?? '').matchAll(/["']([^"']+)["']/g)].map((x) => x[1].toLowerCase()).filter((x) => x.length > 3);
  if (!toks.length) return; // audit script not present on this machine
  const files = [join(ROOT, 'scripts/test-dataplane.ts'), ...['cron', 'ingest', 'liveness', 'discovery', 'lists', 'trending', 'telemetry', 'serve', 'classify', 'util', 'page', 'merge', 'lists'].map((f) => join(ROOT, `src/worker/dp/${f}.ts`))];
  for (const f of files) { const src = readFileSync(f, 'utf8').toLowerCase(); for (const tk of toks) assert.ok(!src.includes(tk), `${f} contains a denylist token`); }
});

console.log(failed ? `test-dataplane: ${n} passed, ${failed} FAILED` : `test-dataplane: ${n} passed`);
process.exit(failed ? 1 : 0);
