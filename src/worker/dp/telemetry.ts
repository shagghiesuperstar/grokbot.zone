// D17: first-party telemetry. No cookies, no stored IP: a visitor is a daily-salted hash, counted once
// per bot per kind per UTC day. Every write is best effort and never slows or breaks a page.
import { botUrl } from './ingest';
import { dayOf } from './util';

const BLOCKED_UA = /bot|crawl|spider|slurp|preview|headless|curl|wget|python|go-http|okhttp|java|http-client/i;

export function isHuman(req: Request): boolean {
  if (req.method !== 'GET') return false;
  const ua = req.headers.get('user-agent') ?? '';
  if (!ua || BLOCKED_UA.test(ua)) return false;
  // A page load is a document navigation; an <img>, <script> or fetch() from another site is not a visit.
  const dest = req.headers.get('sec-fetch-dest');
  if (dest && dest !== 'document') return false;
  if (/prefetch/i.test(req.headers.get('purpose') ?? '') || /prefetch/i.test(req.headers.get('sec-purpose') ?? '')) return false;
  return true;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export async function visitorHash(salt: string, ip: string, ua: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${ip}|${ua}`))).slice(0, 16);
}

let saltCache: { db: D1Database; day: string; salt: string } | null = null;
export const resetSaltCache = () => { saltCache = null; };
async function dailySalt(db: D1Database, day: string): Promise<string> {
  if (saltCache?.db === db && saltCache.day === day) return saltCache.salt;
  const fresh = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  await db.prepare('INSERT OR IGNORE INTO meta(k, v) VALUES(?, ?)').bind(`salt:${day}`, fresh).run();
  const row = await db.prepare('SELECT v FROM meta WHERE k = ?').bind(`salt:${day}`).first<{ v: string }>();
  saltCache = { db, day, salt: row?.v ?? fresh };
  return saltCache.salt;
}

export type Kind = 'open' | 'view';
/** Count one open or view. Swallows every error: telemetry must never reach the visitor. */
export async function record(db: D1Database | undefined, kind: Kind, codeLc: string, req: Request, nowMs = Date.now()): Promise<void> {
  try {
    if (!db || !isHuman(req)) return;
    const day = dayOf(nowMs);
    const vh = await visitorHash(await dailySalt(db, day), req.headers.get('cf-connecting-ip') ?? '', req.headers.get('user-agent') ?? '');
    const ins = await db.prepare('INSERT OR IGNORE INTO visit_seen(day, code_lc, kind, vh) VALUES(?, ?, ?, ?)').bind(day, codeLc, kind, vh).run();
    if (!Number((ins as { meta?: { changes?: number } }).meta?.changes ?? 0)) return;
    const col = kind === 'open' ? 'opens' : 'views';
    await db.prepare(`INSERT INTO bot_daily(day, code_lc, ${col}) VALUES(?, ?, 1) ON CONFLICT(day, code_lc) DO UPDATE SET ${col} = ${col} + 1`).bind(day, codeLc).run();
  } catch (e) {
    console.error('telemetry write skipped:', (e as Error).message);
  }
}

const GO_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** GET /go/<code>: 302 to the platform page for a catalog code; 404 for everything else. */
export async function go(req: Request, db: D1Database | undefined, code: string, wait: (p: Promise<unknown>) => void): Promise<Response> {
  const notFound = () => new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed\n', { status: 405, headers: { Allow: 'GET, HEAD' } });
  if (!GO_RE.test(code)) return notFound();
  let target = code;
  if (db) {
    try {
      const row = await db.prepare("SELECT code FROM bots WHERE code_lc = ? AND status IN ('live', 'pending')").bind(code.toLowerCase()).first<{ code: string }>();
      if (!row) return notFound();
      target = row.code;
    } catch (e) {
      // A database error must not strand a visitor; the shape check above keeps this on x.ai/bot/.
      console.error('go lookup failed:', (e as Error).message);
    }
  }
  wait(record(db, 'open', code.toLowerCase(), req));
  return new Response(null, { status: 302, headers: { Location: botUrl(target), 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' } });
}

// ---- dead bots: the cron stores the list; handlers keep it for a few minutes ----
let deadCache: { db: D1Database; at: number; set: Set<string> } | null = null;
export const resetDeadCache = () => { deadCache = null; };
export async function isDead(db: D1Database | undefined, codeLc: string, nowMs = Date.now()): Promise<boolean> {
  if (!db) return false;
  try {
    if (!deadCache || deadCache.db !== db || nowMs - deadCache.at > 300_000) {
      const row = await db.prepare("SELECT v FROM meta WHERE k = 'dead_json'").first<{ v: string }>();
      deadCache = { db, at: nowMs, set: new Set<string>(row ? JSON.parse(row.v) : []) };
    }
    return deadCache.set.has(codeLc);
  } catch { return false; }
}
