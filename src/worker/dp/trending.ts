// D20-D22: trending, recent, signals and changes, computed from D1 and handed back as plain objects
// that the hourly job stores in meta. Scoring is pure so the tests can check it by hand.
import pop from '../../../data/signals/popularity.json';
import recentStatic from '../../data/recent.json';
import { addDays, botId, dayDiff, dayOf, daysBack, iso } from './util';

export const WINDOW = 14;
export const HALF_LIFE = 3;
export const W_OPEN = 3;
export const W_VIEW = 1;
export const PRIOR_MAX = 10;
export const GLOBAL_N = 300;
export const CATEGORY_N = 50;
export const CARD_N = 100;
export const RECENT_N = 60;

/** Decay weight for a day d days before today. */
export const decay = (d: number) => Math.pow(0.5, d / HALF_LIFE);

/** Seed popularity order: lowercased code -> 1-based global rank, and the list length N. */
export const SEED_RANK: Map<string, number> = new Map((pop.global as string[]).map((c, i) => [c.toLowerCase(), i + 1]));
export const SEED_N = (pop.global as string[]).length;

/** Cold-start prior (D20): 10 * (1 - (r-1)/N) * 0.5^(t/3), zero once t >= 14. t is whole UTC days since TELEMETRY_START. */
export function prior(rank: number | undefined, n: number, t: number): number {
  if (!rank || t >= WINDOW) return 0;
  return PRIOR_MAX * (1 - (rank - 1) / n) * Math.pow(0.5, Math.max(t, 0) / HALF_LIFE);
}

export interface Scored { code_lc: string; code: string; category: string | null; cats: string | null; first_seen: string; score: number; o14: number; prior: number }

/** score desc, then more opens over 14 d, then newer first_seen, then code ascending. */
export function order(rows: Scored[]): Scored[] {
  const r6 = (n: number) => Math.round(n * 1e6);
  return rows.filter((r) => r.score > 0).sort((a, b) =>
    r6(b.score) - r6(a.score) || b.o14 - a.o14 || (a.first_seen < b.first_seen ? 1 : a.first_seen > b.first_seen ? -1 : 0) || (a.code_lc < b.code_lc ? -1 : 1));
}

export interface TrendingPayload {
  asOf: string; basis: string; global: string[]; perCategory: Record<string, string[]>;
  method: { window_days: number; half_life_days: number; weights: { opens: number; views: number }; source: string; telemetry_start: string; prior_until: string | null; prior_share: number };
  generatedAt: string;
}
export interface Card { n: string; a: string; d: string; c: string | null; k: string; s: string }

const CARD_COLS = 'code_lc, code, name, author, description, category, source';
const cardOf = (r: Record<string, string | null>): Card => ({ n: r.name ?? '', a: r.author ?? '', d: (r.description ?? '').slice(0, 220), c: r.category ?? null, k: r.code ?? '', s: r.source ?? '' });

export interface BuiltTrending { trending: TrendingPayload; signals: Record<string, unknown>; cards: Record<string, Card> }
export interface BuiltRecent { recent: Record<string, unknown>; changes: Record<string, unknown>; cards: Record<string, Card>; dead: string[]; stats: Record<string, number> }
export type Built = BuiltTrending & BuiltRecent;
/** Largest stored changes blob (D1 allows 2,000,000 bytes per row; spec 08 O10 keeps well under it). */
export const MAX_CHANGES_BYTES = 1_200_000;

/** Trending, its card text and the signals file (spec 08 O7: its own phase). */
export async function buildTrendingPhase(db: D1Database, nowMs: number, telemetryStart: string): Promise<BuiltTrending> {
  const today = dayOf(nowMs);
  const generatedAt = iso(nowMs);
  const t = dayDiff(telemetryStart, today);
  const days = Array.from({ length: WINDOW }, (_, d) => daysBack(nowMs, d)); // days[0] = today
  const caseSql = `CASE d.day ${days.map(() => 'WHEN ? THEN ?').join(' ')} ELSE 0 END`;
  const binds: (string | number)[] = [];
  days.forEach((day, d) => binds.push(day, decay(d)));

  // Q1: aggregate in SQL, weights computed here and passed in.
  const tel = await db.prepare(
    `SELECT b.code_lc, b.code, b.category, b.cats, b.first_seen,
            SUM((${W_OPEN} * d.opens + ${W_VIEW} * d.views) * ${caseSql}) AS score, SUM(d.opens) AS o14
       FROM bot_daily d JOIN bots b ON b.code_lc = d.code_lc
      WHERE d.day >= ? AND d.day <= ? AND b.status = 'live'
      GROUP BY d.code_lc HAVING score > 0 ORDER BY score DESC LIMIT 2000`,
  ).bind(...binds, days[WINDOW - 1], today).all<Omit<Scored, 'prior'>>();
  const rows = new Map<string, Scored>(tel.results.map((r) => [r.code_lc, { ...r, prior: 0 }]));

  // Q2: seed bots that carry a prior (live ones only).
  if (t < WINDOW) {
    const seedCodes = [...SEED_RANK.keys()];
    const p = await db.prepare(`SELECT code_lc, code, category, cats, first_seen FROM bots WHERE status = 'live' AND code_lc IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(seedCodes)).all<Omit<Scored, 'prior' | 'score' | 'o14'>>();
    for (const r of p.results) {
      const pr = prior(SEED_RANK.get(r.code_lc), SEED_N, t);
      const cur = rows.get(r.code_lc);
      if (cur) { cur.prior = pr; cur.score += pr; } else rows.set(r.code_lc, { ...r, score: pr, o14: 0, prior: pr });
    }
  }
  const ranked = order([...rows.values()]);
  const idOf = (r: Scored) => botId(r.category, r.code);
  const global = ranked.slice(0, GLOBAL_N);
  const perCategory: Record<string, string[]> = {};
  for (const r of ranked) {
    const slugs = (r.cats ? r.cats.split(',') : r.category ? [r.category] : []).filter(Boolean);
    for (const s of slugs) { const a = (perCategory[s] ??= []); if (a.length < CATEGORY_N) a.push(idOf(r)); }
  }
  const sumPrior = ranked.reduce((n, r) => n + r.prior, 0);
  const sumAll = ranked.reduce((n, r) => n + r.score, 0);
  const trending: TrendingPayload = {
    asOf: today,
    basis: 'first-party opens and views on grokbot.zone over the last 14 days, recomputed hourly',
    global: global.map(idOf),
    perCategory,
    method: {
      window_days: WINDOW, half_life_days: HALF_LIFE, weights: { opens: W_OPEN, views: W_VIEW }, source: 'first-party',
      telemetry_start: telemetryStart, prior_until: t < WINDOW ? addDays(telemetryStart, WINDOW) : null,
      prior_share: sumAll ? Math.round((sumPrior / sumAll) * 1000) / 1000 : 0,
    },
    generatedAt,
  };

  // Q3: card text for the lists the pages show.
  const cards: Record<string, Card> = {};
  const shown = global.slice(0, CARD_N);
  if (shown.length) {
    const c = await db.prepare(`SELECT ${CARD_COLS} FROM bots WHERE code_lc IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(shown.map((r) => r.code_lc))).all<Record<string, string | null>>();
    const by = new Map(c.results.map((r) => [r.code_lc as string, r]));
    for (const r of shown) { const row = by.get(r.code_lc); if (row) cards[idOf(r)] = cardOf(row); }
  }

  // Q4: per-day opens/views for the ranked bots that have any (so the ranking can be recomputed by anyone).
  const sig = global.length
    ? await db.prepare(`SELECT day, code_lc, views, opens FROM bot_daily WHERE day >= ? AND code_lc IN (SELECT value FROM json_each(?)) ORDER BY code_lc, day`)
      .bind(days[WINDOW - 1], JSON.stringify(global.map((r) => r.code_lc))).all<{ day: string; code_lc: string; views: number; opens: number }>()
    : { results: [] as { day: string; code_lc: string; views: number; opens: number }[] };
  const idByLc = new Map(global.map((r) => [r.code_lc, idOf(r)]));
  const botsSig: Record<string, Record<string, [number, number]>> = {};
  for (const r of sig.results) (botsSig[idByLc.get(r.code_lc)!] ??= {})[r.day] = [r.opens, r.views];
  const signals = {
    generatedAt, window_days: WINDOW, days: [...days].reverse(), fields: ['opens', 'views'],
    method: trending.method, bots: botsSig,
  };
  return { trending, signals, cards };
}

/** Recent, the changes file, the dead list and the status counts (spec 08 O7: its own phase). */
export async function buildRecentPhase(db: D1Database, nowMs: number): Promise<BuiltRecent> {
  const today = dayOf(nowMs);
  const generatedAt = iso(nowMs);
  const cards: Record<string, Card> = {};
  // Q5: Recent = live bots, newest first_seen first, then code ascending.
  const rec = await db.prepare(`SELECT ${CARD_COLS}, first_seen FROM bots WHERE status = 'live' ORDER BY first_seen DESC, code_lc ASC LIMIT ?`).bind(RECENT_N).all<Record<string, string | null>>();
  const recentIds: string[] = [];
  for (const r of rec.results) {
    const id = botId(r.category as string | null, r.code as string);
    recentIds.push(id);
    cards[id] ??= cardOf(r);
  }
  const recent = { ...recentStatic, asOf: today, basis: 'live bots, newest additions first', bots: recentIds, generatedAt };

  // Q6/Q7/Q8: what changed since the seed.
  // D27a: a bot that has been live at least once stays in `added` after it dies (its code is then in `dead` too).
  // `excluded` rows also carry last_live, so the status filter is what keeps them out.
  const added = await db.prepare(`SELECT code, name, author, description, category, cats, source, first_seen FROM bots WHERE source != 'seed' AND last_live IS NOT NULL AND status IN ('live', 'dead') ORDER BY first_seen, code_lc`).all<Record<string, string | null>>();
  const deadRows = await db.prepare(`SELECT code, code_lc FROM bots WHERE status = 'dead' ORDER BY code_lc`).all<{ code: string; code_lc: string }>();
  const st = await db.prepare(`SELECT status, COUNT(*) AS n FROM bots GROUP BY status`).all<{ status: string; n: number }>();
  const stats: Record<string, number> = { live: 0, dead: 0, pending: 0, excluded: 0 };
  for (const r of st.results) stats[r.status] = r.n;
  let list = added.results;
  const row = (r: Record<string, string | null>) => ({ id: botId(r.category, r.code as string), code: r.code, name: r.name, author: r.author, description: r.description, category: r.category, cats: r.cats ? r.cats.split(',') : [], source: r.source, first_seen: r.first_seen });
  // Keep the stored blob far below the 2,000,000-byte row limit: oldest entries go first.
  let truncated = 0;
  while (list.length > 1 && JSON.stringify(list.map(row)).length > MAX_CHANGES_BYTES) { const drop = Math.ceil(list.length / 10); truncated += drop; list = list.slice(drop); }
  const changes = {
    generatedAt, since: '2026-10-30',
    ...(truncated ? { truncated } : {}),
    added: list.map((r) => ({ id: botId(r.category, r.code as string), code: r.code, name: r.name, author: r.author, description: r.description, category: r.category, cats: r.cats ? r.cats.split(',') : [], source: r.source, first_seen: r.first_seen })),
    dead: deadRows.results.map((r) => r.code),
    excluded: stats.excluded,
  };
  return { recent, changes, cards, dead: deadRows.results.map((r) => r.code_lc), stats };
}

export async function build(db: D1Database, nowMs: number, telemetryStart: string): Promise<Built> {
  const t = await buildTrendingPhase(db, nowMs, telemetryStart);
  const r = await buildRecentPhase(db, nowMs);
  return { ...t, ...r, cards: { ...r.cards, ...t.cards } };
}
