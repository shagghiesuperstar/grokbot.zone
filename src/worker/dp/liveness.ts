// D14: the liveness state machine and the paced upstream client that feeds it.
import { CODE_RE, UA, botUrl, ingest, parseHead, readHead } from './ingest';
import type { Classifier } from './classify';
import { DAY, iso, type Clock } from './util';

export interface BotRow {
  code_lc: string; code: string; name: string; author: string; description: string;
  category: string | null; cats: string | null; source: string; status: string; first_seen: string;
  last_checked: string | null; last_live: string | null; fail_count: number; first_fail: string | null;
}

export const MAX_UPSTREAM = 40;
export const GAP_MS = 1100;
export const THROTTLE_HOLD_MS = 6 * 3600_000;
const MIN_SAMPLE = 4; // a 403/429 share is only meaningful over a handful of answers

/** Sequential, paced, capped upstream client. Every request to a platform host goes through here. */
export class Upstream {
  left: number;
  used = 0;
  responses = 0;
  blocked = 0;
  private last = -Infinity;
  constructor(private f: typeof fetch, private clock: Clock, limit = MAX_UPSTREAM) { this.left = limit; }

  get throttled() { return this.responses >= MIN_SAMPLE && this.blocked / this.responses >= 0.5; }

  /** null = budget spent or throttled; status 0 = network error or timeout. */
  async request(url: string, init: RequestInit = {}, track = true): Promise<{ status: number; res: Response | null } | null> {
    if (this.left <= 0 || this.throttled) return null;
    this.left--; this.used++;
    const wait = GAP_MS - (this.clock.now() - this.last);
    if (wait > 0) await this.clock.sleep(wait);
    this.last = this.clock.now();
    try {
      const res = await this.f(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(9000) });
      if (track) { this.responses++; if (res.status === 403 || res.status === 429) this.blocked++; }
      return { status: res.status, res };
    } catch {
      return { status: 0, res: null };
    }
  }
}

export type Verdict = { kind: 'live'; code?: string } | { kind: 'gone' } | { kind: 'none' };

export type Patch = Partial<Pick<BotRow, 'status' | 'fail_count' | 'first_fail' | 'last_live' | 'last_checked' | 'code' | 'name' | 'author' | 'description' | 'category' | 'cats'>>;

/** The D14 state machine, pure. A dead bot that answers 200 comes back to live; nothing is ever deleted. */
export function applyVerdict(row: BotRow, v: Verdict, nowMs: number): Patch {
  const now = iso(nowMs);
  if (v.kind === 'live') {
    return { status: 'live', fail_count: 0, first_fail: null, last_live: now, last_checked: now, ...(v.code ? { code: v.code } : {}) };
  }
  if (v.kind === 'gone') {
    const fail_count = row.fail_count + 1;
    const first_fail = row.first_fail ?? now;
    const dead = fail_count >= 2 && nowMs - Date.parse(first_fail) >= DAY;
    return { fail_count, first_fail, last_checked: now, status: dead ? 'dead' : row.status };
  }
  return { last_checked: now };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Where a platform redirect lands, when it lands on another /bot/<code> page. */
function target(res: Response): string | null {
  const loc = res.headers.get('location');
  if (!loc) return null;
  try {
    const u = new URL(loc, 'https://x.ai/');
    const m = /^\/bot\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname);
    return u.hostname === 'x.ai' && m ? m[1] : null;
  } catch { return null; }
}

/** HEAD a known bot. A redirect is followed once; it only counts when it lands on the same bot (letter case aside). */
async function headCheck(up: Upstream, row: BotRow): Promise<Verdict> {
  const r = await up.request(botUrl(row.code), { method: 'HEAD', redirect: 'manual' });
  if (!r) return { kind: 'none' };
  return judge(up, row, r, 'HEAD');
}

async function judge(up: Upstream, row: BotRow, r: { status: number; res: Response | null }, method: 'HEAD' | 'GET'): Promise<Verdict> {
  if (r.status === 200) return { kind: 'live' };
  if (r.status === 404 || r.status === 410) return { kind: 'gone' };
  if (REDIRECTS.has(r.status) && r.res) {
    const code2 = target(r.res);
    if (!code2 || code2.toLowerCase() !== row.code_lc) return { kind: 'none' };
    const r2 = await up.request(botUrl(code2), { method, redirect: 'manual' });
    if (!r2) return { kind: 'none' };
    if (r2.status === 200) return { kind: 'live', code: code2 };
    if (r2.status === 404 || r2.status === 410) return { kind: 'gone' };
  }
  return { kind: 'none' };
}

/** A pending bot found by discovery: read its page head, scrub it, file it. */
async function ingestCheck(up: Upstream, row: BotRow, clock: Clock, list: string[], model: Classifier): Promise<Patch> {
  const r = await up.request(botUrl(row.code), { method: 'GET', redirect: 'manual' });
  if (!r) return {};
  const v = await judge(up, row, r, 'GET');
  if (v.kind === 'live') {
    // judge() only read the status; the page is parsed here from whichever response answered 200.
    let res = r.status === 200 ? r.res : null;
    let code = row.code;
    if (!res && v.code) {
      const r2 = await up.request(botUrl(v.code), { method: 'GET', redirect: 'manual' });
      if (!r2 || r2.status !== 200) return {};
      res = r2.res; code = v.code;
    } else if (!res) return {};
    const head = parseHead(await readHead(res!));
    const got = ingest(head, code, list, model);
    if (!got) return {}; // 200 without a title: leave it pending, it is looked at again later
    return {
      ...applyVerdict(row, { kind: 'live', code }, clock.now()),
      name: got.name, author: got.author, description: got.description,
      category: got.category, cats: got.category,
      status: got.excluded ? 'excluded' : 'live',
    };
  }
  return applyVerdict(row, v, clock.now());
}

export interface RunResult { patches: { row: BotRow; patch: Patch }[]; checked: number; stoppedThrottled: boolean }

/** Check rows in the order given until the budget or the throttle stops the run. */
export async function runChecks(up: Upstream, rows: BotRow[], clock: Clock, list: string[], model: Classifier): Promise<RunResult> {
  const patches: RunResult['patches'] = [];
  for (const row of rows) {
    if (up.left <= 0 || up.throttled) break;
    let patch: Patch;
    if (row.status === 'pending' && row.name === '') {
      patch = await ingestCheck(up, row, clock, list, model);
    } else {
      patch = applyVerdict(row, await headCheck(up, row), clock.now());
    }
    if (Object.keys(patch).length) patches.push({ row, patch });
  }
  return { patches, checked: patches.length, stoppedThrottled: up.throttled };
}

export const isCode = (s: string) => CODE_RE.test(s);
