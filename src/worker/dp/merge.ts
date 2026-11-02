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

export interface Seed { assets: unknown; map: Map<string, string> }
let seedCache: Seed | null = null;
/** Lowercased code -> stored spelling for every bot the deployed site has a page for (built asset). */
export async function seedMap(assets: { fetch(r: Request): Promise<Response> }): Promise<Map<string, string> | null> {
  if (seedCache && seedCache.assets === assets) return seedCache.map;
  const res = await assets.fetch(new Request(`${SITE}/api/v1/seed-codes.json`));
  if (!res.ok) return null;
  const codes = ((await res.json()) as { codes: string[] }).codes;
  seedCache = { assets, map: new Map(codes.map((c) => [c.toLowerCase(), c])) };
  return seedCache.map;
}

export interface Merge { extras: LiveAdded[]; dead: Set<string> }
/** Live non-seed bots without a static page (newest first) and the dead codes; null when D1 has nothing stored. */
export async function mergeState(db: D1Database | undefined, assets: { fetch(r: Request): Promise<Response> }): Promise<Merge | null> {
  const st = await liveState(db);
  if (!st) return null;
  let seed: Map<string, string> | null = null;
  try { seed = await seedMap(assets); } catch { seed = null; }
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
export function sitemapLive(m: Merge): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${m.extras.map((b) => `<url><loc>${SITE}/bots/${esc(b.id)}/</loc></url>`).join('')}</urlset>`;
}
