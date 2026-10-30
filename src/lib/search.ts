// R2: client-side search. AND-match over whitespace tokens, substring match,
// minimum 2 characters, name-prefix results rank above body matches.
export interface SearchRecord { i: string; n: string; a: string; d: string; r: number }
export interface IndexedRecord extends SearchRecord { cat: string; catLabel: string; nameNorm: string; hay: string }
export interface Hit { rec: IndexedRecord; tier: 0 | 1 | 2 }

export const MIN_CHARS = 2;
export const PAGE_SIZE = 50;

/** Lowercase, strip diacritics, turn every non-alphanumeric run into one space. */
export function normalize(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function indexRecord(r: SearchRecord, cat: string, catLabel: string): IndexedRecord {
  const nameNorm = normalize(r.n);
  return { ...r, cat, catLabel, nameNorm, hay: `${nameNorm} ${normalize(r.a)} ${normalize(r.d)} ${normalize(catLabel)}` };
}

export function search(records: IndexedRecord[], query: string): Hit[] {
  const q = normalize(query);
  if (q.replace(/ /g, '').length < MIN_CHARS) return [];
  const tokens = q.split(' ');
  const hits: Hit[] = [];
  for (const rec of records) {
    if (!tokens.every((t) => rec.hay.includes(t))) continue;
    const tier = rec.nameNorm.startsWith(q) ? 0 : tokens.every((t) => rec.nameNorm.includes(t)) ? 1 : 2;
    hits.push({ rec, tier });
  }
  // Tier first, then the committed popularity signal, then name, then id: fully deterministic.
  return hits.sort(
    (x, y) => x.tier - y.tier || x.rec.r - y.rec.r || x.rec.nameNorm.localeCompare(y.rec.nameNorm) || (x.rec.i < y.rec.i ? -1 : 1),
  );
}
