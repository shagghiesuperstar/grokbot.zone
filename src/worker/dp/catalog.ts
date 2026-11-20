// The read API (index, categories, category files, bot records, codes, recent) from one live query:
// bots WHERE status = 'live'. Each bot is filed under exactly one slug, so the sum of category
// counts equals totalBots by construction. Static files remain the fallback when D1 is down.
import categories from '../../data/categories.json';
import { catalogGuardMessage } from '../../lib/catalog-guard';
import { stripEmails } from '../../lib/strip-emails';
import { splitId } from './merge';
import { SEED_RANK } from './trending';
import { CATEGORY_NONE, botId, dayOf, iso } from './util';

const TAXONOMY = categories as { slug: string; label: string; purpose: string }[];
const KNOWN = new Set(TAXONOMY.map((c) => c.slug));
const LABEL = new Map(TAXONOMY.map((c) => [c.slug, c.label]));
const PURPOSE = new Map(TAXONOMY.map((c) => [c.slug, c.purpose]));
LABEL.set(CATEGORY_NONE, 'Uncategorized');
PURPOSE.set(CATEGORY_NONE, 'Live bots that have not been filed in a category yet.');

const NO_RANK = 1_000_000;
const SITE = 'https://grokbot.zone';
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' };
const BOT_JSON = /^\/api\/v1\/bots\/([A-Za-z0-9_-]{1,160})\.json$/;
const CAT_JSON = /^\/api\/v1\/categories\/([a-z0-9-]{1,80})\.json$/;

const ENDPOINTS = {
  categories: '/api/v1/categories.json',
  category: '/api/v1/categories/{slug}.json',
  trending: '/api/v1/trending.json',
  recent: '/api/v1/recent.json',
  bot: '/api/v1/bots/{id}.json',
  codes: '/api/v1/codes.json',
  feedAtom: '/feed.xml',
  feedJson: '/feed.json',
  health: '/api/health',
};

interface CountRow { slug: string; n: number }
interface BotRow { code: string; name: string; author: string; description: string; category: string | null; status?: string }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body) + '\n', { status, headers: JSON_HEADERS });
const guardFail = (msg: string) => {
  console.error(`live catalog: FAIL ${msg}`);
  return json({ ok: false, error: 'catalog_guard' }, 503);
};

/** Known taxonomy slug, or uncategorized. An unknown stored category is filed with the uncategorized set so the partition still covers every live row. */
export function filingSlug(category: string | null): string {
  if (category && KNOWN.has(category)) return category;
  return CATEGORY_NONE;
}

export async function liveCounts(db: D1Database): Promise<{ total: number; counts: Map<string, number> }> {
  const totalRow = await db.prepare(`SELECT COUNT(*) AS n FROM bots WHERE status = 'live'`).first<{ n: number }>();
  const grouped = await db.prepare(
    `SELECT CASE WHEN category IS NULL OR category = '' THEN 'uncategorized' ELSE category END AS slug, COUNT(*) AS n
       FROM bots WHERE status = 'live' GROUP BY 1`,
  ).all<CountRow>();
  const counts = new Map<string, number>();
  for (const row of grouped.results) {
    const slug = filingSlug(row.slug === CATEGORY_NONE ? null : row.slug);
    counts.set(slug, (counts.get(slug) ?? 0) + Number(row.n));
  }
  return { total: Number(totalRow?.n ?? 0), counts };
}

function categoryRows(counts: Map<string, number>, asOf: string) {
  const rows = TAXONOMY.map((c) => ({ slug: c.slug, label: c.label, count: counts.get(c.slug) ?? 0, purpose: c.purpose, updated: asOf }));
  rows.push({
    slug: CATEGORY_NONE,
    label: LABEL.get(CATEGORY_NONE)!,
    count: counts.get(CATEGORY_NONE) ?? 0,
    purpose: PURPOSE.get(CATEGORY_NONE)!,
    updated: asOf,
  });
  return rows;
}

function card(row: BotRow) {
  const slug = filingSlug(row.category);
  return {
    i: botId(row.category, row.code),
    n: stripEmails(row.name ?? ''),
    a: stripEmails(row.author ?? ''),
    d: stripEmails(row.description ?? ''),
    r: SEED_RANK.get(row.code.toLowerCase()) ?? NO_RANK,
    c: slug,
  };
}

function record(row: BotRow, asOf: string) {
  const slug = filingSlug(row.category);
  return {
    id: botId(row.category, row.code),
    name: stripEmails(row.name ?? ''),
    author: stripEmails(row.author ?? ''),
    description: stripEmails(row.description ?? ''),
    category: { slug, label: LABEL.get(slug) ?? slug },
    code: row.code,
    link: `https://x.ai/bot/${row.code}`,
    asOf,
  };
}

/** Public id the HTML pages already use. Listed only when splitId can hand that id back to this row. */
function listedId(category: string | null, code: string): string | null {
  const id = botId(category, code);
  const [, got] = splitId(id);
  return got.toLowerCase() === code.toLowerCase() ? id : null;
}

const knownJson = JSON.stringify([...KNOWN]);

async function categoryFile(db: D1Database, slug: string): Promise<Response | null> {
  if (slug !== CATEGORY_NONE && !KNOWN.has(slug)) return null;
  const sql = slug === CATEGORY_NONE
    ? `SELECT code, name, author, description, category FROM bots WHERE status = 'live' AND (category IS NULL OR category = '' OR category NOT IN (SELECT value FROM json_each(?))) ORDER BY code_lc`
    : `SELECT code, name, author, description, category FROM bots WHERE status = 'live' AND category = ? ORDER BY code_lc`;
  const rows = await db.prepare(sql).bind(slug === CATEGORY_NONE ? knownJson : slug).all<BotRow>();
  const bots = rows.results.map(card);
  return json({ slug, label: LABEL.get(slug) ?? slug, count: bots.length, bots });
}

async function botFile(db: D1Database, id: string, asOf: string): Promise<Response | null> {
  const [, code] = splitId(id);
  if (!code) return null;
  const row = await db.prepare(
    `SELECT code, name, author, description, category, status FROM bots WHERE code_lc = ?`,
  ).bind(code.toLowerCase()).first<BotRow>();
  if (!row || row.status !== 'live') return null;
  const expect = listedId(row.category, row.code);
  if (!expect || expect.toLowerCase() !== id.toLowerCase()) return null;
  return json(record(row, asOf));
}

async function codesFile(db: D1Database): Promise<Response> {
  const rows = await db.prepare(`SELECT lower(code) AS code FROM bots WHERE status = 'live' ORDER BY code_lc`).all<{ code: string }>();
  return json({ codes: rows.results.map((r) => r.code) });
}

async function indexAndCategories(db: D1Database, path: string, asOf: string): Promise<Response> {
  const { total, counts } = await liveCounts(db);
  const rows = categoryRows(counts, asOf);
  const sum = rows.reduce((n, c) => n + c.count, 0);
  const guard = catalogGuardMessage(sum, total, total);
  if (guard) return guardFail(guard);
  if (path === '/api/v1/categories.json') return json(rows);
  return json({
    name: 'GrokBot Zone read API',
    description: 'A read-only JSON catalog of public Grok bot listings, generated from the live directory. Documentation: ' + SITE + '/api/',
    asOf,
    totalBots: total,
    endpoints: ENDPOINTS,
  });
}

async function recentFile(db: D1Database, asOf: string, nowMs: number): Promise<Response> {
  const { total, counts } = await liveCounts(db);
  const rows = categoryRows(counts, asOf);
  const sum = rows.reduce((n, c) => n + c.count, 0);
  const guard = catalogGuardMessage(sum, total, total);
  if (guard) return guardFail(guard);
  const rec = await db.prepare(
    `SELECT code, category FROM bots WHERE status = 'live' ORDER BY first_seen DESC, code_lc ASC LIMIT 60`,
  ).all<{ code: string; category: string | null }>();
  const bots: string[] = [];
  for (const r of rec.results) {
    const id = listedId(r.category, r.code);
    if (id) bots.push(id);
  }
  return json({
    asOf,
    basis: 'live bots, newest additions first',
    bots,
    categories: rows.map((c) => ({ slug: c.slug, label: c.label, count: c.count, asOf })),
    generatedAt: iso(nowMs),
  });
}

/** Live catalog response, or null to fall through to the static asset. A guard failure is a 503, not the stale file. */
export async function liveCatalog(db: D1Database | undefined, path: string, nowMs = Date.now()): Promise<Response | null> {
  if (!db) return null;
  const cat = CAT_JSON.exec(path);
  const bot = BOT_JSON.exec(path);
  const known = path === '/api/v1/index.json' || path === '/api/v1/categories.json' || path === '/api/v1/codes.json' || path === '/api/v1/recent.json' || !!cat || !!bot;
  if (!known) return null;
  const asOf = dayOf(nowMs);
  try {
    // An empty live table is an unseeded database: the static files (and the test fixtures) still answer.
    // Production always has live rows, so this is not a second catalog.
    const totalRow = await db.prepare(`SELECT COUNT(*) AS n FROM bots WHERE status = 'live'`).first<{ n: number }>();
    if (!Number(totalRow?.n)) return null;
    if (path === '/api/v1/index.json' || path === '/api/v1/categories.json') return await indexAndCategories(db, path, asOf);
    if (path === '/api/v1/codes.json') return await codesFile(db);
    if (path === '/api/v1/recent.json') return await recentFile(db, asOf, nowMs);
    if (cat) return await categoryFile(db, cat[1]);
    if (bot) return await botFile(db, bot[1], asOf);
    return null;
  } catch (e) {
    console.error('live catalog', path, (e as Error).message);
    return null;
  }
}
