// D15: find codes the catalog does not hold yet. Runs once a day inside the */10 cron and shares its budget.
import { CODE_RE } from './ingest';
import type { Upstream } from './liveness';
import { iso } from './util';

export const LISTING_URL = 'https://x.ai/bot/marketplace';
const CDX = 'https://web.archive.org/cdx/search/cdx';
export const CDX_ROWS = 500;
const ARCHIVE_TIMEOUT_MS = 90_000;

export interface Found { code: string; source: 'listing' | 'archive' }

/** F5: every /bot/<code> href on the platform listing page. */
export function parseListing(html: string): string[] {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/href=["'](?:https?:\/\/(?:www\.)?x\.ai)?\/bot\/([A-Za-z0-9_-]+)["'/?#]/g)) {
    if (CODE_RE.test(m[1]) && !out.has(m[1].toLowerCase())) out.set(m[1].toLowerCase(), m[1]);
  }
  return [...out.values()];
}

/** F6: archive rows [timestamp, original]; the spelling comes from `original`, the urlkey is lowercased. */
export function parseCdx(rows: unknown): { found: string[]; resume: string | null; lastTs: string | null } {
  const found = new Map<string, string>();
  let resume: string | null = null, lastTs: string | null = null;
  if (!Array.isArray(rows)) return { found: [], resume, lastTs };
  const body = rows.slice(1) as unknown[];
  // showResumeKey appends an empty row, then a one-element row holding the key.
  const tail = body.length >= 2 && Array.isArray(body[body.length - 2]) && (body[body.length - 2] as unknown[]).length === 0 ? body[body.length - 1] : null;
  if (Array.isArray(tail) && typeof tail[0] === 'string') resume = tail[0];
  for (const r of body) {
    if (!Array.isArray(r) || r.length < 2) continue;
    lastTs = typeof r[0] === 'string' ? r[0] : lastTs;
    const m = /^https?:\/\/(?:www\.)?x\.ai\/bot\/([A-Za-z0-9_-]+)(?:[/?#].*)?$/i.exec(String(r[1]));
    if (m && CODE_RE.test(m[1]) && !found.has(m[1].toLowerCase())) found.set(m[1].toLowerCase(), m[1]);
  }
  return { found: [...found.values()], resume, lastTs };
}

const cdxStamp = (ms: number) => iso(ms).replace(/\D/g, '').slice(0, 14);

export interface DiscoveryState { archive_resume?: string; archive_from?: string }
export interface DiscoveryResult { found: Found[]; state: Record<string, string> }

/** One listing GET and one archive query, both inside the run's shared budget. */
export async function discover(up: Upstream, st: DiscoveryState, nowMs: number): Promise<DiscoveryResult> {
  const found: Found[] = [];
  const state: Record<string, string> = {};
  const l = await up.request(LISTING_URL, { method: 'GET' }, true);
  if (l && l.status === 200 && l.res) {
    let html = '';
    try { html = await l.res.text(); } catch { /* a reset body read: no listing today, the archive part still runs (O7) */ }
    for (const code of parseListing(html)) found.push({ code, source: 'listing' });
  }

  // Backfill with resume keys until the archive is read through, then ask only for what is newer.
  const q = new URLSearchParams({ url: 'x.ai/bot/', matchType: 'prefix', output: 'json', fl: 'timestamp,original', 'filter': 'statuscode:200', collapse: 'urlkey', limit: String(CDX_ROWS) });
  if (st.archive_from) q.set('from', st.archive_from);
  else { q.set('showResumeKey', 'true'); if (st.archive_resume) q.set('resumeKey', st.archive_resume); }
  // A 500-row archive page takes ~40 s (measured), far beyond the 9 s a platform HEAD gets.
  const a = await up.request(`${CDX}?${q}`, { method: 'GET' }, false, ARCHIVE_TIMEOUT_MS);
  if (a && a.status === 200 && a.res) {
    let rows: unknown = null;
    try { rows = await a.res.json(); } catch { /* an unreadable page is retried tomorrow */ }
    if (rows) {
      const p = parseCdx(rows);
      for (const code of p.found) found.push({ code, source: 'archive' });
      if (st.archive_from) state.archive_from = cdxStamp(nowMs);
      else if (p.resume) state.archive_resume = p.resume;
      else state.archive_from = cdxStamp(nowMs);
    }
  }
  return { found, state };
}
