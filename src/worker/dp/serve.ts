// D22/D23: the read surface (health, trending, recent, signals, changes) and the live-rendered pages.
// Everything is read from meta, which the hourly job fills; when it is missing, stale or D1 fails, the
// static build answers instead.
import categories from '../../data/categories.json';
import { readMeta, type Meta } from './util';
import type { Card } from './trending';

const LABEL = new Map((categories as { slug: string; label: string }[]).map((c) => [c.slug, c.label]));
export const STALE_MS = 3 * 3600_000;
const jsonHeaders = (maxAge: number) => ({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${maxAge}` });

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---- stored JSON with a short in-isolate cache ----
let cache: { at: number; meta: Meta } | null = null;
export const resetServeCache = () => { cache = null; };
const KEYS = ['trending_json', 'recent_json', 'signals_json', 'changes_json', 'cards_json', 'trending_at'];
async function stored(db: D1Database, nowMs: number): Promise<Meta> {
  if (cache && nowMs - cache.at < 60_000) return cache.meta;
  const meta = await readMeta(db, KEYS);
  if (meta.trending_at) cache = { at: nowMs, meta }; // never pin an empty answer: the first cron run fills it
  return meta;
}
function fresh(meta: Meta, nowMs: number): boolean {
  return !!meta.trending_at && nowMs - Date.parse(meta.trending_at) <= STALE_MS;
}

const FILES: Record<string, string> = {
  '/api/v1/trending.json': 'trending_json', '/api/v1/recent.json': 'recent_json',
  '/api/v1/signals/daily.json': 'signals_json', '/api/v1/catalog/changes.json': 'changes_json',
};
export const isStoredFile = (path: string) => path in FILES;

/** The stored JSON for a read endpoint, or null to fall through to the static asset. */
export async function storedFile(db: D1Database | undefined, path: string, nowMs = Date.now()): Promise<Response | null> {
  if (!db) return null;
  try {
    const meta = await stored(db, nowMs);
    const body = meta[FILES[path]];
    // signals and changes have no static twin: serve whatever exists, however old.
    const hasTwin = path === '/api/v1/trending.json' || path === '/api/v1/recent.json';
    if (!body || (hasTwin && !fresh(meta, nowMs))) return null;
    return new Response(body + '\n', { headers: jsonHeaders(300) });
  } catch { return null; }
}

// ---- GET /api/health ----
export async function healthBody(db: D1Database | undefined, nowMs: number, nowIso: string, nosecret: boolean, switches: Record<string, string>) {
  let d1 = false;
  const m: Meta = {};
  let events = 0;
  try {
    d1 = !!db && !!(await db.prepare('SELECT 1 AS ok').first());
    if (db) {
      Object.assign(m, await readMeta(db, ['last_run', 'checks_hourly', 'stats', 'throttled_until', 'discovery_last_run', 'discovery_new', 'trending_at']));
      const day = nowIso.slice(0, 10);
      const e = await db.prepare('SELECT COALESCE(SUM(views + opens), 0) AS n FROM bot_daily WHERE day = ?').bind(day).first<{ n: number }>();
      events = e?.n ?? 0;
    }
  } catch { /* the d1 flag already says what failed */ }
  const parse = <T>(s: string | undefined, d: T): T => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
  const ch = parse<Record<string, number>>(m.checks_hourly, {});
  const cut = new Date(nowMs - 24 * 3600_000).toISOString().slice(0, 13);
  const checked = Object.entries(ch).filter(([k]) => k >= cut).reduce((n, [, v]) => n + v, 0);
  const st = parse<Record<string, number>>(m.stats, {});
  const dn = parse<Record<string, number>>(m.discovery_new, {});
  const wk = new Date(nowMs - 7 * 86400_000).toISOString().slice(0, 10);
  const held = m.throttled_until && Date.parse(m.throttled_until) > nowMs ? m.throttled_until : null;
  return {
    ok: d1, d1,
    liveness: { last_run: m.last_run ?? null, checked_24h: checked, live: st.live ?? 0, dead: st.dead ?? 0, pending: st.pending ?? 0, throttled_until: held },
    discovery: { last_run: m.discovery_last_run ?? null, new_7d: Object.entries(dn).filter(([k]) => k >= wk).reduce((n, [, v]) => n + v, 0) },
    telemetry: { events_today: events },
    trending: { generatedAt: m.trending_at ?? null },
    noref: nosecret ? 'ok' : 'missing',
    switches,
  };
}

// ---- live pages ----
const cardHtml = (id: string, c: Card, level: 2 | 3, trending: boolean, showCategory: boolean) => {
  const seed = c.s === 'seed';
  const href = seed ? `/bots/${esc(id)}/` : `/go/${esc(c.k)}`;
  const rel = seed ? '' : ' rel="nofollow noopener"';
  const label = c.c ? LABEL.get(c.c) : undefined;
  const foot = [
    trending ? '<span class="trend"><span class="dot" aria-hidden="true"></span>Trending</span>' : '',
    showCategory && c.c && label ? `<a class="cat" href="/categories/${esc(c.c)}/">${esc(label)}</a>` : '',
  ].join('');
  return `<article class="card panel gz-botcard"><h${level} class="name"><a href="${href}"${rel}>${esc(c.n)}</a></h${level}>` +
    (c.a ? `<p class="by">by ${esc(c.a)}</p>` : '') + `<p class="desc">${esc(c.d)}</p><p class="foot">${foot}</p></article>`;
};

export function trendingList(ids: string[], cards: Record<string, Card>, level: 2 | 3, limit: number, ranked: boolean): string {
  return ids.filter((i) => cards[i]).slice(0, limit).map((id, i) =>
    `<li data-rank="${i + 1}">${ranked ? `<span class="rank" aria-label="Rank ${i + 1}">${i + 1}</span>` : ''}${cardHtml(id, cards[id], level, true, true)}</li>`).join('');
}
export function recentList(ids: string[], cards: Record<string, Card>, level: 2 | 3, limit: number): string {
  return ids.filter((i) => cards[i]).slice(0, limit).map((id) => `<li>${cardHtml(id, cards[id], level, false, true)}</li>`).join('');
}

export const TRENDING_NOTE = 'Ranked by what grokbot.zone visitors opened and viewed in the last 14 days. Updated hourly.';
export const RECENT_NOTE = 'Newest additions to grokbot.zone first.';
const priorNote = (until: string) => ` Blended with our launch snapshot until ${esc(until)}.`;

/** Replace the marked containers of a static page with the live lists, or return the page untouched. */
export async function livePage(res: Response, db: D1Database | undefined, path: string, nowMs = Date.now()): Promise<Response> {
  if (!db || res.status !== 200 || !(res.headers.get('content-type') ?? '').includes('text/html')) return res;
  try {
    const meta = await stored(db, nowMs);
    if (!fresh(meta, nowMs) || !meta.trending_json || !meta.recent_json || !meta.cards_json) return res;
    const tr = JSON.parse(meta.trending_json), rc = JSON.parse(meta.recent_json), cards: Record<string, Card> = JSON.parse(meta.cards_json);
    const tnote = TRENDING_NOTE + (tr.method?.prior_until ? priorNote(tr.method.prior_until) : '');
    const rw = new HTMLRewriter();
    const trendHtml = (limit: number, level: 2 | 3, ranked: boolean) => trendingList(tr.global, cards, level, limit, ranked);
    if (path === '/trending/' || path === '/trending') {
      rw.on('[data-live="trending-list"]', { element(e) { e.setInnerContent(trendHtml(100, 2, true), { html: true }); } })
        .on('[data-live="trending-note"]', { element(e) { e.setInnerContent(tnote); } });
    } else if (path === '/recent/' || path === '/recent') {
      rw.on('[data-live="recent-list"]', { element(e) { e.setInnerContent(recentList(rc.bots, cards, 2, 60), { html: true }); } })
        .on('[data-live="recent-note"]', { element(e) { e.setInnerContent(RECENT_NOTE); } });
    } else if (path === '/') {
      rw.on('[data-live="trending-rail"]', { element(e) { e.setInnerContent(trendHtml(12, 3, false), { html: true }); } })
        .on('[data-live="trending-asof"]', { element(e) { e.setInnerContent(tnote); } })
        .on('[data-live="recent-rail"]', { element(e) { e.setInnerContent(recentList(rc.bots, cards, 3, 8), { html: true }); } })
        .on('[data-live="recent-asof"]', { element(e) { e.setInnerContent(RECENT_NOTE); } })
        .on('[data-live="recent-basis"]', { element(e) { e.remove(); } });
    } else return res;
    return rw.transform(res);
  } catch { return res; }
}

/** A dead bot's page: the normal page chrome with one line and a link to its category. */
export function gonePage(res: Response, id: string, categorySlug: string | null): Response {
  const label = categorySlug ? LABEL.get(categorySlug) : undefined;
  const link = categorySlug && label ? ` <a href="/categories/${esc(categorySlug)}/">More in ${esc(label)}</a>.` : ' <a href="/categories/">Browse categories</a>.';
  const rw = new HTMLRewriter().on('article.bot', { element(e) { e.setInnerContent(`<h1>This bot is no longer shared</h1><p class="desc">The bot's owner has stopped sharing it.${link}</p>`, { html: true }); } })
    .on('title', { element(e) { e.setInnerContent('Bot no longer shared | GrokBot Zone'); } })
    .on('meta[name="robots"]', { element(e) { e.remove(); } })
    .on('head', { element(e) { e.append('<meta name="robots" content="noindex">', { html: true }); } });
  const out = rw.transform(res);
  return new Response(out.body, { status: 410, headers: out.headers });
}
