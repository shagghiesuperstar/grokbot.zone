// The */10 job (spec 07): discovery (daily), liveness, submissions and trending (hourly), purge (daily).
// Free-plan shape: at most 40 upstream requests and well under 50 D1 queries per run (a batch counts as one).
import classifierJson from '../../data/classifier.json';
import type { Classifier } from './classify';
import { discover } from './discovery';
import { denylist } from './ingest';
import { pullLists, queueCodes, type ListsStat } from './lists';
import { MAX_PENDING_PER_RUN, MAX_SUBMISSION_REQUESTS, MAX_UPSTREAM, THROTTLE_HOLD_MS, Upstream, runChecks, type BotRow, type Patch } from './liveness';
import { buildRecentPhase, buildTrendingPhase } from './trending';
import { HOUR, addDays, dayOf, iso, metaPut, readMeta, realClock, type Clock } from './util';

export interface CronEnv { DB?: D1Database; NOREF_TOKENS?: string; TELEMETRY_START?: string; LIST_SOURCES?: string }
export interface CronDeps { fetch: typeof fetch; clock: Clock }

const MODEL = classifierJson as unknown as Classifier;
const META_KEYS = ['throttled_until', 'trending_at', 'checks_hourly', 'stats', 'discovery_last_run', 'discovery_new', 'archive_resume', 'archive_from', 'last_run', 'rejected_unresolved', 'lists_stat'];
export const PHASES = ['discovery', 'lists', 'checks', 'submissions', 'trending', 'recent', 'purge'] as const;
export type Phase = (typeof PHASES)[number];
export const TRENDING_EVERY_MS = 55 * 60_000;

const COLS = 'code_lc, code, name, author, description, category, cats, source, status, first_seen, last_checked, last_live, fail_count, first_fail';
const updateSql = 'UPDATE bots SET code=?, name=?, author=?, description=?, category=?, cats=?, status=?, last_checked=?, last_live=?, fail_count=?, first_fail=? WHERE code_lc=?';

export interface Report { upstream: number; checked: number; discovered: number; throttled: boolean; hourly: boolean; queries: number; listed?: number; skipped?: string }

/** Wraps D1 so a run can report how many queries it issued (a batch counts as one). */
export function counted(db: D1Database): { db: D1Database; count: () => number } {
  let n = 0;
  const hook = (st: any): any => ({
    __st: st,
    bind: (...a: unknown[]) => hook(st.bind(...a)),
    first: (...a: unknown[]) => { n++; return st.first(...a); },
    all: (...a: unknown[]) => { n++; return st.all(...a); },
    run: (...a: unknown[]) => { n++; return st.run(...a); },
  });
  const wrapped = {
    prepare: (sql: string) => hook(db.prepare(sql)),
    batch: (sts: any[]) => { n++; return db.batch(sts.map((x) => x.__st ?? x)); },
  };
  return { db: wrapped as unknown as D1Database, count: () => n };
}

/** One line, no stack, no denylist token: what is safe to store and show in /api/health. */
export function safeMessage(e: unknown, list: string[]): string {
  let m = (e instanceof Error ? e.message : String(e)).split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 200);
  for (const w of list) m = m.split(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig')).join('[x]');
  return m;
}

export async function runDataPlane(env: CronEnv, scheduledTime: number, deps: CronDeps = { fetch: (...a) => fetch(...a), clock: realClock }): Promise<Report> {
  if (!env.DB) return { upstream: 0, checked: 0, discovered: 0, throttled: false, hourly: false, queries: 0, skipped: 'no DB binding' };
  const { db, count } = counted(env.DB);
  const { clock } = deps;
  const now = clock.now();
  const start = env.TELEMETRY_START || dayOf(now);
  const list = denylist(env.NOREF_TOKENS);
  const meta = await readMeta(db, META_KEYS);
  const report: Report = { upstream: 0, checked: 0, discovered: 0, throttled: false, hourly: false, queries: 0 };
  const writes: D1PreparedStatement[] = [];
  const setMeta = (k: string, v: string) => writes.push(metaPut(db, k, v));
  let lastError: { phase: Phase; at: string; message: string } | null = null;
  /** O7: each phase has its own try; a failure is recorded and the run goes on. */
  const phase = async <T>(name: Phase, fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn(); } catch (e) {
      lastError = { phase: name, at: iso(clock.now()), message: safeMessage(e, list) };
      console.error(`dataplane phase ${name} failed:`, lastError.message);
      report.skipped = `${name} failed`;
      return undefined;
    }
  };

  const stats: Record<string, number> = meta.stats ? JSON.parse(meta.stats) : { live: 0, dead: 0, pending: 0, excluded: 0 };
  const heldUntil = meta.throttled_until ? Date.parse(meta.throttled_until) : 0;
  const up = new Upstream(deps.fetch, clock, MAX_UPSTREAM);

  if (heldUntil > now) {
    report.throttled = true;
  } else {
    // ---- discovery: the daily 04:10 run, and once on a fresh database (no earlier discovery recorded) ----
    const t = new Date(scheduledTime);
    const inWindow = t.getUTCHours() === 4 && t.getUTCMinutes() >= 10 && t.getUTCMinutes() < 20;
    const doDiscovery = inWindow || !meta.discovery_last_run;
    if (doDiscovery) await phase('discovery', async () => {
      const found = await discover(up, { archive_resume: meta.archive_resume, archive_from: meta.archive_from }, now);
      if (found.found.length) {
        const r = await db.prepare(
          `INSERT OR IGNORE INTO bots(code_lc, code, source, status, first_seen)
           SELECT lower(json_extract(value, '$.c')), json_extract(value, '$.c'), json_extract(value, '$.s'), 'pending', ? FROM json_each(?)`,
        ).bind(iso(now), JSON.stringify(found.found.map((f) => ({ c: f.code, s: f.source })))).run();
        report.discovered = Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0);
        stats.pending += report.discovered;
      }
      for (const [k, v] of Object.entries(found.state)) setMeta(k, v);
      setMeta('discovery_last_run', iso(now));
      const dn: Record<string, number> = meta.discovery_new ? JSON.parse(meta.discovery_new) : {};
      dn[dayOf(now)] = (dn[dayOf(now)] ?? 0) + report.discovered;
      for (const k of Object.keys(dn)) if (k < addDays(dayOf(now), -8)) delete dn[k];
      setMeta('discovery_new', JSON.stringify(dn));
    });

    // ---- lists: the LIST_SOURCES pull rides on the same nightly run; unset or empty means no fetch at all ----
    if (doDiscovery && env.LIST_SOURCES?.trim()) await phase('lists', async () => {
      const pull = await pullLists(env.LIST_SOURCES, deps.fetch);
      let added = 0;
      try { added = await queueCodes(db, pull.codes, now); } finally {
        const stat: ListsStat = { last_run: iso(now), sources: pull.sources, fetched_ok: pull.fetchedOk, added };
        setMeta('lists_stat', JSON.stringify(stat));
      }
      report.listed = added;
      stats.pending += added;
    });

    // ---- liveness: submissions and pending first, then live and dead by oldest check ----
    const room = up.left;
    if (room > 0) await phase('checks', async () => {
      const pend = list.length ? 1 : 0; // an empty denylist closes ingest: no pending row is read
      const subCap = pend * Math.min(room, MAX_SUBMISSION_REQUESTS);
      const otherCap = pend * Math.min(room, MAX_PENDING_PER_RUN);
      const sel = (status: string, n: number) => db.prepare(`SELECT ${COLS} FROM bots WHERE status = ? ORDER BY last_checked LIMIT ?`).bind(status, n);
      // Submission-sourced pending rows take at most 10 rows (and 10 requests); the others fill the rest of the 30 pending slots.
      const pendSql = (cmp: string, n: number) => db.prepare(
        `SELECT ${COLS} FROM bots WHERE status = 'pending' AND source ${cmp} 'submission' ORDER BY last_checked LIMIT ${n}`);
      const [subs, others, live, dead] = await db.batch<BotRow>([
        pendSql('=', subCap),
        db.prepare(`SELECT ${COLS} FROM bots WHERE status = 'pending' AND source != 'submission' ORDER BY last_checked LIMIT MAX(0, MIN(?, ? - (SELECT MIN(?, COUNT(*)) FROM bots WHERE status = 'pending' AND source = 'submission')))`)
          .bind(otherCap, MAX_PENDING_PER_RUN, subCap),
        sel('live', room), sel('dead', room)]);
      const cmp = (a: BotRow, b: BotRow) => (a.last_checked ?? '').localeCompare(b.last_checked ?? '') || (a.code_lc < b.code_lc ? -1 : 1);
      const rows = [...subs.results, ...others.results, ...[...live.results, ...dead.results].sort(cmp)];
      const run = await runChecks(up, rows, clock, list, MODEL);
      report.checked = run.checked;
      if (run.patches.length) {
        const st: D1PreparedStatement[] = run.patches.map(({ row, patch }) => {
          const m: BotRow = { ...row, ...(patch as Partial<BotRow>) };
          return db.prepare(updateSql).bind(m.code, m.name, m.author, m.description, m.category, m.cats, m.status, m.last_checked, m.last_live, m.fail_count, m.first_fail, m.code_lc);
        });
        await db.batch(st);
        for (const { row, patch } of run.patches) {
          const to = (patch as Patch).status ?? row.status;
          if (to !== row.status) { stats[row.status] = Math.max(0, (stats[row.status] ?? 0) - 1); stats[to] = (stats[to] ?? 0) + 1; }
        }
        const bucket = iso(now).slice(0, 13);
        const ch: Record<string, number> = meta.checks_hourly ? JSON.parse(meta.checks_hourly) : {};
        ch[bucket] = (ch[bucket] ?? 0) + run.checked;
        const cutoff = iso(now - 25 * HOUR).slice(0, 13);
        for (const k of Object.keys(ch)) if (k < cutoff) delete ch[k];
        meta.checks_hourly = JSON.stringify(ch);
        setMeta('checks_hourly', meta.checks_hourly);
      }
      if (run.stoppedThrottled) { report.throttled = true; setMeta('throttled_until', iso(now + THROTTLE_HOLD_MS)); }
    });
    report.upstream = up.used;
  }

  // ---- hourly: submissions settle, then trending / recent / signals / changes / stats ----
  const due = !meta.trending_at || now - Date.parse(meta.trending_at) >= TRENDING_EVERY_MS;
  if (due) {
    report.hourly = true;
    // D30: a submission's row follows its bot, no person involved.
    await phase('submissions', async () => {
      const n = await settleSubmissions(db, now);
      if (n) setMeta('rejected_unresolved', String(Number(meta.rejected_unresolved ?? 0) + n));
    });
    const tr = await phase('trending', () => buildTrendingPhase(db, now, start));
    const rc = await phase('recent', () => buildRecentPhase(db, now));
    if (tr) {
      setMeta('trending_json', JSON.stringify(tr.trending));
      setMeta('signals_json', JSON.stringify(tr.signals));
      setMeta('cards_json', JSON.stringify({ ...(rc?.cards ?? {}), ...tr.cards }));
      if (rc) setMeta('recent_json', JSON.stringify(rc.recent));
      setMeta('trending_at', iso(now));
    }
    if (rc) {
      setMeta('changes_json', JSON.stringify(rc.changes));
      setMeta('dead_json', JSON.stringify(rc.dead));
      Object.assign(stats, rc.stats);
    }
    // Daily purge rides on the discovery window run.
    if (new Date(scheduledTime).getUTCHours() === 4) await phase('purge', async () => {
      const today = dayOf(now);
      await db.batch([
        db.prepare('DELETE FROM visit_seen WHERE day < ?').bind(addDays(today, -2)),
        db.prepare("DELETE FROM meta WHERE k LIKE 'salt:%' AND k < ?").bind(`salt:${addDays(today, -2)}`),
        db.prepare('DELETE FROM bot_daily WHERE day < ?').bind(addDays(today, -60)),
      ]);
    });
  }
  setMeta('stats', JSON.stringify(stats));
  setMeta('last_run', iso(clock.now()));
  if (lastError) setMeta('last_error', JSON.stringify(lastError));
  try { await db.batch(writes); } catch (e) {
    // One bad value (say an oversized blob) must not cost the run its timestamp or its error record.
    const le = { phase: 'recent', at: iso(clock.now()), message: safeMessage(e, list) };
    await db.batch([metaPut(db, 'last_error', JSON.stringify(le)), metaPut(db, 'last_run', iso(clock.now()))]);
    report.skipped = 'meta write failed';
  }
  report.queries = count();
  return report;
}

/** A submission still pending after this long is given up on (its platform page never gave a title). */
export const UNRESOLVED_AFTER_DAYS = 7;
/** D30: a submission is approved when its bot goes live, rejected when it ends dead or excluded. One batch, no person.
 *  D3: whatever is still pending after 7 days is rejected as unresolved and its submission-sourced bot row is excluded so it
 *  is not polled forever. Returns how many submissions that was (counted in meta `rejected_unresolved`, shown by /api/health). */
async function settleSubmissions(db: D1Database, nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - UNRESOLVED_AFTER_DAYS * 86400_000).toISOString();
  const out = await db.batch([
    db.prepare(`UPDATE submissions SET status = 'approved' WHERE status = 'pending' AND lower(code) IN (SELECT code_lc FROM bots WHERE status = 'live')`),
    db.prepare(`UPDATE submissions SET status = 'rejected' WHERE status = 'pending' AND lower(code) IN (SELECT code_lc FROM bots WHERE status IN ('dead', 'excluded'))`),
    db.prepare(`UPDATE submissions SET status = 'rejected' WHERE status = 'pending' AND created_at < ?`).bind(cutoff),
    db.prepare(`UPDATE bots SET status = 'excluded' WHERE status = 'pending' AND source = 'submission' AND first_seen < ?`).bind(cutoff),
  ]);
  return Number((out[2] as { meta?: { changes?: number } }).meta?.changes ?? 0);
}
