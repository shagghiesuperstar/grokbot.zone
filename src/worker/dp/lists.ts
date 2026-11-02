// Nightly list pull: fetch each URL in the LIST_SOURCES secret, lift share codes out of the raw text, queue the new ones.
// The pending lane then checks each code on the platform exactly as for any other new row. Counts only in logs and health.
import { UA } from './ingest';
import { iso } from './util';

export const LIST_TIMEOUT_MS = 30_000;
export const LIST_MAX_BYTES = 20 * 1024 * 1024;
/** At most this many rows are queued in one run; the rest arrive the next night. */
export const LIST_ADD_CAP = 1000;
/** Entries per INSERT. One bound JSON string of ~45 bytes an entry: 2,000 entries is ~90 KB, far under D1's 2 MB string limit. */
export const LIST_CHUNK = 2000;
const CODE_IN_TEXT = /x\.ai\/bot\/([A-Za-z0-9_-]{21})(?![A-Za-z0-9_-])/g;

export interface ListsStat { last_run: string | null; sources: number; fetched_ok: number; added: number }

/** Newline-separated https URLs; anything else on a line is dropped. */
export function parseSources(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const line of (raw ?? '').split('\n')) {
    const u = line.trim();
    if (/^https:\/\/\S+$/i.test(u) && !out.includes(u)) out.push(u);
  }
  return out;
}

/** One regex over the raw text (JSON, Markdown or plain alike); deduped case-insensitively, first spelling kept. */
export function extractCodes(text: string, into: Map<string, string> = new Map()): Map<string, string> {
  for (const m of text.matchAll(CODE_IN_TEXT)) if (!into.has(m[1].toLowerCase())) into.set(m[1].toLowerCase(), m[1]);
  return into;
}

/** Body text, or null when it is over the byte cap (Content-Length first, then the bytes actually read). */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > maxBytes) { await res.body?.cancel().catch(() => {}); return null; }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(all);
}

export interface PullResult { codes: string[]; sources: number; fetchedOk: number }

/** GET each source once, one at a time. A non-200, a timeout, a failed read or an oversize body skips that source only. */
export async function pullLists(
  raw: string | undefined, f: typeof fetch, opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<PullResult> {
  const urls = parseSources(raw);
  const found = new Map<string, string>();
  let fetchedOk = 0;
  for (const [i, url] of urls.entries()) {
    try {
      const res = await f(url, { method: 'GET', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(opts.timeoutMs ?? LIST_TIMEOUT_MS) });
      if (res.status !== 200) { await res.body?.cancel().catch(() => {}); console.error(`lists: source ${i + 1} skipped, status ${res.status}`); continue; }
      const text = await readCapped(res, opts.maxBytes ?? LIST_MAX_BYTES);
      if (text === null) { console.error(`lists: source ${i + 1} skipped, body over the size cap`); continue; }
      extractCodes(text, found);
      fetchedOk++;
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      console.error(`lists: source ${i + 1} skipped, ${timedOut ? 'timeout' : 'fetch failed'}`);
    }
  }
  return { codes: [...found.values()], sources: urls.length, fetchedOk };
}

/** Queue codes not yet in `bots` as listing/pending, same shape as discovery. LIMIT keeps the run at or under the cap. */
export async function queueCodes(db: D1Database, codes: string[], nowMs: number, cap = LIST_ADD_CAP): Promise<number> {
  let added = 0;
  for (let i = 0; i < codes.length && added < cap; i += LIST_CHUNK) {
    const chunk = codes.slice(i, i + LIST_CHUNK).map((c) => ({ c }));
    const r = await db.prepare(
      `INSERT OR IGNORE INTO bots(code_lc, code, source, status, first_seen)
       SELECT lower(json_extract(value, '$.c')), json_extract(value, '$.c'), 'listing', 'pending', ? FROM json_each(?)
       WHERE lower(json_extract(value, '$.c')) NOT IN (SELECT code_lc FROM bots) LIMIT ?`,
    ).bind(iso(nowMs), JSON.stringify(chunk), cap - added).run();
    added += Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0);
  }
  return added;
}
