export const HOUR = 3600_000;
export const DAY = 86_400_000;
export const iso = (ms: number) => new Date(ms).toISOString();
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const daysBack = (ms: number, n: number) => dayOf(ms - n * DAY);
/** Whole UTC days between two YYYY-MM-DD dates. */
export const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
export const addDays = (d: string, n: number) => dayOf(Date.parse(`${d}T00:00:00Z`) + n * DAY);
export const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export const realClock: Clock = { now: () => Date.now(), sleep: sleepReal };

export const CATEGORY_NONE = 'uncategorized';
/** The public id of a bot: "<category>-<code>" (seed ids keep this format). */
export const botId = (category: string | null, code: string) => `${category ?? CATEGORY_NONE}-${code}`;

export type Meta = Record<string, string>;
export async function readMeta(db: D1Database, keys: string[]): Promise<Meta> {
  const { results } = await db.prepare(`SELECT k, v FROM meta WHERE k IN (${keys.map(() => '?').join(',')})`).bind(...keys).all<{ k: string; v: string }>();
  return Object.fromEntries(results.map((r) => [r.k, r.v]));
}
export const metaPut = (db: D1Database, k: string, v: string) =>
  db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v);
