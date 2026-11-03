// Spec 08 D28/O10: what the static build ships, merged at request time with what D1 knows since the deploy.
// The "extra" set is the live non-seed bots in the stored changes file (id, code, name, author, description,
// category, cats, first_seen) minus the codes the deployed site already has a page for; the dead set is the
// stored dead list. When nothing applies a path is passed through untouched, so a seed bot's static page and the
// static JSON stay byte-for-byte as built (O11).
import categories from '../../data/categories.json';
import { cardHtml, esc, liveState, type LiveAdded } from './serve';
import type { Card } from './trending';
import { CATEGORY_NONE } from './util';

const SLUGS = new Set((categories as { slug: string }[]).map((c) => c.slug));
const SITE = 'https://grokbot.zone';

/** "<category>-<code>" -> [category, code]. Codes contain "-", so strip a known category prefix instead of splitting. */
export function splitId(id: string): [string | null, string] {
  let best: string | null = null;
  for (const s of SLUGS) if (id.startsWith(`${s}-`) && (!best || s.length > best.length)) best = s;
  return best ? [best, id.slice(best.length + 1)] : id.startsWith(`${CATEGORY_NONE}-`) ? [null, id.slice(CATEGORY_NONE.length + 1)] : [null, id];
}

export interface SeedCatalog {
  map: Map<string, string>;
  /** Lowercased code -> category slugs the build listed that bot under. null when the file has no cats field. */
  cats: Map<string, string[]> | null;
}
let seedCache: { assets: unknown; catalog: SeedCatalog } | null = null;
const seedUnreadable = (why: string): null => { console.error(`seed-codes.json unreadable: ${why}`); return null; };
/** Shipped codes, and the categories each one is listed in, from the one seed file totalBots already reads. */
export async function seedCatalog(assets: { fetch(r: Request): Promise<Response> }): Promise<SeedCatalog | null> {
  if (seedCache && seedCache.assets === assets) return seedCache.catalog;
  let res: Response;
  try { res = await assets.fetch(new Request(`${SITE}/api/v1/seed-codes.json`)); }
  catch (e) { return seedUnreadable((e as Error).message); }
  if (!res.ok) return seedUnreadable(`HTTP ${res.status}`);
  let raw: { codes?: unknown; cats?: unknown };
  try { raw = await res.json() as { codes?: unknown; cats?: unknown }; }
  catch (e) { return seedUnreadable((e as Error).message); }
  if (!Array.isArray(raw.codes) || raw.codes.some((c) => typeof c !== 'string')) return seedUnreadable('codes is not a string array');
  const codes = raw.codes as string[];
  const map = new Map(codes.map((c) => [c.toLowerCase(), c]));
  if (raw.cats == null) { seedCache = { assets, catalog: { map, cats: null } }; return seedCache.catalog; }
  if (!Array.isArray(raw.cats) || raw.cats.length !== codes.length) return seedUnreadable('cats is not aligned with codes');
  const cats = new Map<string, string[]>();
  for (let i = 0; i < codes.length; i++) {
    const row = raw.cats[i];
    if (!Array.isArray(row) || row.some((s) => typeof s !== 'string')) return seedUnreadable('cats row is not a string array');
    cats.set(codes[i].toLowerCase(), [...new Set(row as string[])]);
  }
  seedCache = { assets, catalog: { map, cats } };
  return seedCache.catalog;
}
/** Lowercased code -> stored spelling for every bot the deployed site has a page for (built asset). */
export async function seedMap(assets: { fetch(r: Request): Promise<Response> }): Promise<Map<string, string> | null> {
  const catalog = await seedCatalog(assets);
  return catalog ? catalog.map : null;
}

export interface Merge { extras: LiveAdded[]; dead: Set<string> }
/** Live non-seed bots without a static page (newest first) and the dead codes; null when D1 has nothing stored. */
export async function mergeState(db: D1Database | undefined, assets: { fetch(r: Request): Promise<Response> }): Promise<Merge | null> {
  const st = await liveState(db);
  if (!st) return null;
  let seed: Map<string, string> | null = null;
  try { seed = await seedMap(assets); } catch (e) { console.error('seed-codes.json unreadable', (e as Error).message); seed = null; }
  // Without the built list a bot cannot be told from a static one, so no extra is added (a dead one is still dropped).
  const extras = seed ? st.added.filter((b) => !st.dead.has(b.code.toLowerCase()) && !seed!.has(b.code.toLowerCase()))
    .sort((a, b) => (a.first_seen < b.first_seen ? 1 : a.first_seen > b.first_seen ? -1 : a.code < b.code ? -1 : 1)) : [];
  return { extras, dead: st.dead };
}

const cardOf = (b: LiveAdded): Card => ({ n: b.name, a: b.author, d: b.description.slice(0, 220), c: b.category, k: b.code, s: b.source });
const catsOfEntry = (b: LiveAdded) => (b.cats?.length ? b.cats : b.category ? [b.category] : []).filter((s) => SLUGS.has(s));

// ---- search: /search/live.json (the client merges it with the per-category files) ----
export function searchLive(m: Merge): Response {
  const bots = m.extras.map((b) => ({
    i: b.id, n: b.name, a: b.author, d: b.description.length > 140 ? b.description.slice(0, 139) + '…' : b.description, r: 1_000_000,
    ...(b.category ? { c: b.category } : {}), cats: catsOfEntry(b),
  }));
  return new Response(JSON.stringify({ bots, dead: [...m.dead] }) + '\n', { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}

// ---- category pages ----
// String work, not HTMLRewriter: the page is read once, dead bots' <li data-code="..."> items are cut out, the live bots'
// items are added at the end of the list, and the printed count follows. Cheap enough for the Free plan's CPU limit.
export async function categoryPage(res: Response, slug: string, m: Merge): Promise<Response> {
  if (res.status !== 200) return res;
  let text = await res.text();
  const add = m.extras.filter((b) => catsOfEntry(b).includes(slug));
  let removed = 0;
  if (m.dead.size) text = text.replace(/<li data-code="([a-z0-9_-]+)">[\s\S]*?<\/li>/g, (all, c: string) => (m.dead.has(c) ? (removed++, '') : all));
  if (!add.length && !removed) return new Response(text, { status: 200, headers: res.headers });
  if (add.length) {
    const html = add.map((b) => `<li data-code="${esc(b.code.toLowerCase())}">${cardHtml(b.id, cardOf(b), 2, false, false)}</li>`).join('');
    const at = text.indexOf('data-bot-list');
    const end = at >= 0 ? text.indexOf('</ul>', at) : -1;
    if (end >= 0) text = text.slice(0, end) + html + text.slice(end);
    else add.length = 0;
  }
  text = text.replace(/(data-count[^>]*><span class="num"[^>]*>)(\d+)(<\/span>)/, (_a, x: string, n: string, y: string) => `${x}${Number(n) - removed + add.length}${y}`);
  return new Response(text, { status: 200, headers: res.headers });
}

// ---- D2: /categories/uncategorized/ ----
// Live bots whose platform page named no category are not in any category list. This page lists them. It is built
// from a real category page (same head, styles, header and footer) by string work: head tags are retitled, the
// structured data is dropped and the page is noindex (it is a live list, not a stable one).
export async function uncategorizedPage(tpl: Response, m: Merge | null): Promise<Response> {
  if (tpl.status !== 200) return tpl;
  const text = await tpl.text();
  const list = (m?.extras ?? []).filter((b) => !catsOfEntry(b).length);
  const title = 'Uncategorized Grok bots | GrokBot Zone';
  const desc = `${list.length} live Grok bots that have not been sorted into a category yet.`;
  const items = list.map((b) => `<li data-code="${esc(b.code.toLowerCase())}">${cardHtml(b.id, cardOf(b), 2, false, false)}</li>`).join('');
  const main = '<main id="main"><div class="wrap page-head"><p class="crumbs"><a href="/categories/">Categories</a> / Uncategorized</p><h1>Uncategorized</h1>' +
    '<p>Bots that have not been sorted into a category yet.</p>' +
    `<p data-count><span class="num">${list.length}</span> bots · live list</p></div><div class="wrap block">` +
    (list.length ? `<ul class="grid" data-bot-list>${items}</ul>` : '<p>No bots are waiting for a category right now.</p>') + '</div></main>';
  const out = text
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(desc)}">`)
    .replace(/<link rel="canonical" href="[^"]*">/, '<link rel="canonical" href="https://grokbot.zone/categories/uncategorized/"><meta name="robots" content="noindex">')
    .replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${title}">`)
    .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(desc)}">`)
    .replace(/<meta property="og:url" content="[^"]*">/, '<meta property="og:url" content="https://grokbot.zone/categories/uncategorized/">')
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '')
    .replace(/<main id="main">[\s\S]*?<\/main>/, () => main);
  const h = new Headers(tpl.headers);
  for (const k of ['etag', 'last-modified', 'content-length']) h.delete(k);
  h.set('Cache-Control', 'no-cache');
  return new Response(out, { status: 200, headers: h });
}

// ---- feeds ----
const codeOfUrl = (u: string): string | null => { const x = /\/bots\/([^/]+)\/?$/.exec(u); return x ? splitId(x[1])[1].toLowerCase() : null; };
const MAX_FEED_EXTRAS = 50;

export function feedJson(body: string, m: Merge): string {
  const j = JSON.parse(body) as { items: { id: string; url: string; title: string; summary: string; date_modified: string }[] };
  const keep = j.items.filter((it) => !m.dead.has(codeOfUrl(it.url) ?? ''));
  const add = m.extras.slice(0, MAX_FEED_EXTRAS).map((b) => ({ id: `${SITE}/bots/${b.id}/`, url: `${SITE}/bots/${b.id}/`, title: b.name, summary: b.description, date_modified: b.first_seen }));
  return JSON.stringify({ ...j, items: [...add, ...keep] }, null, 1) + '\n';
}
export function feedXml(body: string, m: Merge, generatedAt: string): string {
  const entries = [...body.matchAll(/ {2}<entry>[\s\S]*?<\/entry>\n/g)];
  let out = body;
  for (const e of entries) { const c = /<id>[^<]*\/bots\/([^/<]+)\/<\/id>/.exec(e[0]); if (c && m.dead.has(splitId(c[1])[1].toLowerCase())) out = out.replace(e[0], ''); }
  const add = m.extras.slice(0, MAX_FEED_EXTRAS).map((b) =>
    `  <entry>\n    <title>${esc(b.name)}</title>\n    <link href="${SITE}/bots/${esc(b.id)}/"/>\n    <id>${SITE}/bots/${esc(b.id)}/</id>\n    <updated>${esc(b.first_seen)}</updated>\n    <summary>${esc(b.description)}</summary>\n  </entry>\n`).join('');
  if (add) { const i = out.indexOf('  <entry>'); out = i >= 0 ? out.slice(0, i) + add + out.slice(i) : out.replace('</feed>', add + '</feed>'); out = out.replace(/<updated>[^<]*<\/updated>/, `<updated>${generatedAt}</updated>`); }
  return out;
}

// ---- sitemap ----
export function sitemapIndex(body: string, m: Merge): string {
  return m.extras.length ? body.replace('</sitemapindex>', `<sitemap><loc>${SITE}/sitemap-live.xml</loc></sitemap></sitemapindex>`) : body;
}
/** Drop the dead bots' URLs from a static sitemap file. */
export function sitemapStatic(body: string, m: Merge): string {
  if (!m.dead.size) return body;
  return body.split('</url>').filter((u) => { const x = /\/bots\/([^/<]+)\/<\/loc>/.exec(u); return !(x && m.dead.has(splitId(x[1])[1].toLowerCase())); }).join('</url>');
}

// Dead set (same D1 list as sitemapStatic) applied at request time: /search/<slug>.json and
// /api/v1/categories/<slug>.json drop dead seed bots; /search/index.json, /api/v1/index.json and
// /api/v1/categories.json lower counts by how many of those codes the build shipped; /api/v1/codes.json drops them.
// Category count is listings, not distinct bots: a bot in two categories is listed in both, so the sum of
// category counts is totalListings, not totalBots. A bot in none is not in these files. One dead set, no second list.
/** Dead codes the deployed build listed. A dead bot the build never shipped is not in the sitemap, so it must not change a count. A missing seed is an error, not zero dead. */
export function deadSeedCount(dead: Set<string>, seed: Map<string, string> | null): number {
  if (!dead.size) return 0;
  if (!seed) {
    console.error('seed-codes.json unreadable; refusing to report 0 dead shipped bots');
    throw new Error('seed-codes.json unreadable');
  }
  let n = 0;
  for (const c of dead) if (seed.has(c.toLowerCase())) n++;
  return n;
}
/** How many shipped dead bots each category lists. Same intersection as deadSeedCount: a code absent from the seed was never shipped. */
export function categoryDrops(dead: Set<string>, seedCats: Map<string, string[]>): Map<string, number> {
  const drop = new Map<string, number>();
  for (const code of dead) {
    const listed = seedCats.get(code.toLowerCase());
    if (!listed) continue;
    for (const slug of listed) drop.set(slug, (drop.get(slug) ?? 0) + 1);
  }
  return drop;
}
const withNl = (body: string, json: string) => json + (body.endsWith('\n') ? '\n' : '');
/** totalBots minus the dead seed bots sitemapStatic removes. */
export function totalWithoutDead(body: string, removed: number): string {
  if (!removed) return body;
  const j = JSON.parse(body) as { totalBots?: number };
  if (typeof j.totalBots !== 'number') return body;
  return withNl(body, JSON.stringify({ ...j, totalBots: j.totalBots - removed }));
}
const dropCounts = (rows: { slug?: string; count?: number }[], drop: Map<string, number>): boolean => {
  let changed = false;
  for (const row of rows) {
    const n = row.slug ? drop.get(row.slug) : 0;
    if (n && typeof row.count === 'number') { row.count -= n; changed = true; }
  }
  return changed;
};
/** Search index (and /api/v1/index.json): totalBots and, when present, each category count, from the same dead set. */
export function indexWithoutDead(body: string, dead: Set<string>, seed: Map<string, string>, seedCats: Map<string, string[]> | null): string {
  const removed = deadSeedCount(dead, seed);
  const j = JSON.parse(body) as { totalBots?: number; categories?: { slug: string; count?: number }[] };
  let changed = false;
  if (typeof j.totalBots === 'number' && removed) { j.totalBots -= removed; changed = true; }
  if (Array.isArray(j.categories)) {
    if (!seedCats) {
      console.error('seed-codes.json unreadable: no category list; refusing to report counts that include dead bots');
      throw new Error('seed-codes.json unreadable');
    }
    if (dropCounts(j.categories, categoryDrops(dead, seedCats))) changed = true;
  }
  return changed ? withNl(body, JSON.stringify(j)) : body;
}
/** /api/v1/categories.json: each category's count minus the shipped dead bots listed in it. */
export function categoriesWithoutDead(body: string, dead: Set<string>, seedCats: Map<string, string[]>): string {
  const j = JSON.parse(body) as { slug?: string; count?: number }[];
  if (!Array.isArray(j)) return body;
  if (!dropCounts(j, categoryDrops(dead, seedCats))) return body;
  return withNl(body, JSON.stringify(j));
}
/** codes.json: drop dead codes. Codes the build never shipped are already absent. */
export function codesWithoutDead(body: string, dead: Set<string>): string {
  if (!dead.size) return body;
  const j = JSON.parse(body) as { codes?: string[] };
  if (!Array.isArray(j.codes)) return body;
  const codes = j.codes.filter((c) => !dead.has(c.toLowerCase()));
  if (codes.length === j.codes.length) return body;
  return withNl(body, JSON.stringify({ ...j, codes }));
}
/** A per-category search payload: drop dead bots and fix its count. */
export function searchPayload(body: string, dead: Set<string>): string {
  if (!dead.size) return body;
  const j = JSON.parse(body) as { bots?: { i: string }[]; count?: number };
  if (!Array.isArray(j.bots)) return body;
  const bots = j.bots.filter((b) => !dead.has(splitId(b.i)[1].toLowerCase()));
  if (bots.length === j.bots.length) return body;
  return withNl(body, JSON.stringify({ ...j, count: bots.length, bots }));
}
export function sitemapLive(m: Merge): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${m.extras.map((b) => `<url><loc>${SITE}/bots/${esc(b.id)}/</loc></url>`).join('')}</urlset>`;
}
