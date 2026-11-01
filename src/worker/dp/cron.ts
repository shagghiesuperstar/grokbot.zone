// The */10 job (spec 07): discovery (daily), liveness, submissions and trending (hourly), purge (daily).
// Free-plan shape: at most 40 upstream requests and well under 50 D1 queries per run (a batch counts as one).
import categories from '../../data/categories.json';
import classifierJson from '../../data/classifier.json';
import type { Classifier } from './classify';
import { discover } from './discovery';
import { denylist, scrub } from './ingest';
import { MAX_UPSTREAM, THROTTLE_HOLD_MS, Upstream, runChecks, type BotRow, type Patch } from './liveness';
import { build } from './trending';
import { HOUR, addDays, dayOf, iso, metaPut, readMeta, realClock, type Clock } from './util';

export interface CronEnv { DB?: D1Database; NOREF_TOKENS?: string; TELEMETRY_START?: string }
export interface CronDeps { fetch: typeof fetch; clock: Clock }

const MODEL = classifierJson as unknown as Classifier;
const SLUGS = new Set((categories as { slug: string }[]).map((c) => c.slug));
const META_KEYS = ['throttled_until', 'trending_at', 'checks_hourly', 'stats', 'discovery_last_run', 'discovery_new', 'archive_resume', 'archive_from', 'last_run'];
export const TRENDING_EVERY_MS = 55 * 60_000;

const COLS = 'code_lc, code, name, author, description, category, cats, source, status, first_seen, last_checked, last_live, fail_count, first_fail';
const updateSql = 'UPDATE bots SET code=?, name=?, author=?, description=?, category=?, cats=?, status=?, last_checked=?, last_live=?, fail_count=?, first_fail=? WHERE code_lc=?';

export interface Report { upstream: number; checked: number; discovered: number; throttled: boolean; hourly: boolean; queries: number; skipped?: string }

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
    if (doDiscovery) {
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
    }

    // ---- liveness: pending first, then live and dead by oldest check ----
    const room = up.left;
    if (room > 0) {
      const sel = (status: string, n: number) => db.prepare(`SELECT ${COLS} FROM bots WHERE status = ? ORDER BY last_checked LIMIT ?`).bind(status, n);
      const [pending, live, dead] = await db.batch<BotRow>([sel('pending', list.length ? room : 0), sel('live', room), sel('dead', room)]);
      const cmp = (a: BotRow, b: BotRow) => (a.last_checked ?? '').localeCompare(b.last_checked ?? '') || (a.code_lc < b.code_lc ? -1 : 1);
      const rows = [...pending.results, ...[...live.results, ...dead.results].sort(cmp)];
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
    }
    report.upstream = up.used;
  }

  // ---- hourly: submissions -> bots, then trending / recent / signals / changes / stats ----
  const due = !meta.trending_at || now - Date.parse(meta.trending_at) >= TRENDING_EVERY_MS;
  if (due) {
    report.hourly = true;
    try {
    if (list.length) await upsertSubmissions(db, list, now);
    const b = await build(db, now, start);
    setMeta('trending_json', JSON.stringify(b.trending));
    setMeta('recent_json', JSON.stringify(b.recent));
    setMeta('signals_json', JSON.stringify(b.signals));
    setMeta('changes_json', JSON.stringify(b.changes));
    setMeta('cards_json', JSON.stringify(b.cards));
    setMeta('dead_json', JSON.stringify(b.dead));
    setMeta('trending_at', iso(now));
    Object.assign(stats, b.stats);
    // Daily purge rides on the discovery window run.
    const t = new Date(scheduledTime);
    if (t.getUTCHours() === 4) {
      const today = dayOf(now);
      await db.batch([
        db.prepare('DELETE FROM visit_seen WHERE day < ?').bind(addDays(today, -2)),
        db.prepare("DELETE FROM meta WHERE k LIKE 'salt:%' AND k < ?").bind(`salt:${addDays(today, -2)}`),
        db.prepare('DELETE FROM bot_daily WHERE day < ?').bind(addDays(today, -60)),
      ]);
    }
    } catch (e) {
      // The next run retries the hourly job; the liveness work above is already stored.
      console.error('dataplane hourly failed:', (e as Error).message);
      report.skipped = 'hourly failed';
    }
  }
  setMeta('stats', JSON.stringify(stats));
  setMeta('last_run', iso(clock.now()));
  await db.batch(writes);
  report.queries = count();
  return report;
}

/** D16: an approved submission becomes a bot row, scrubbed like any other ingest. */
async function upsertSubmissions(db: D1Database, list: string[], now: number) {
  const { results } = await db.prepare(
    `SELECT s.name, s.author, s.description, s.code, s.category FROM submissions s
       LEFT JOIN bots b ON b.code_lc = lower(s.code) WHERE s.status = 'approved' AND b.code_lc IS NULL LIMIT 50`,
  ).all<{ name: string; author: string | null; description: string; code: string; category: string | null }>();
  if (!results.length) return;
  await db.batch(results.map((s) => {
    const c = scrub({ name: s.name, author: s.author ?? '', description: s.description }, list);
    const cat = s.category && SLUGS.has(s.category) ? s.category : null;
    return db.prepare(`INSERT OR IGNORE INTO bots(code_lc, code, name, author, description, category, cats, source, status, first_seen) VALUES(?,?,?,?,?,?,?,'submission',?,?)`)
      .bind(s.code.toLowerCase(), s.code, c.name, c.author, c.description, cat, cat, c.excluded ? 'excluded' : 'pending', iso(now));
  }));
}
