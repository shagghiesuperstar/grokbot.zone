// R4/R5: dated signal files -> trending.json + recent.json. Every output carries its own asOf.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const outData = process.env.OUT_DATA ? resolve(process.env.OUT_DATA) : join(ROOT, 'src/data');
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const bots: { slug: string; code: string }[] = read(join(outData, 'bots.json'));
const cats: { slug: string; label: string; count: number }[] = read(join(outData, 'categories.json'));
const idOf = new Map(bots.map((b) => [b.code, b.slug]));
const slugOf = new Map(cats.map((c) => [c.label, c.slug]));
const must = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`build-trending: unknown ${what}`);
  return v;
};

const pop = read(join(ROOT, 'data/signals/popularity.json'));
const trending = {
  asOf: pop.asOf as string,
  basis: pop.basis as string,
  global: (pop.global as string[]).map((c) => must(idOf.get(c), `code ${c}`)),
  perCategory: Object.fromEntries(
    Object.entries(pop.perCategory as Record<string, string[]>).map(([label, codes]) => [
      must(slugOf.get(label), `category ${label}`),
      codes.map((c) => must(idOf.get(c), `code ${c}`)),
    ]),
  ),
};
if (!trending.global.length) throw new Error('build-trending: trending is empty');

const rec = read(join(ROOT, 'data/signals/recency.json'));
const recent = {
  asOf: rec.asOf as string,
  basis: rec.basis as string,
  categories: [...(rec.categories as { slug: string; label: string; count: number; asOf: string }[])].sort(
    (a, b) => b.asOf.localeCompare(a.asOf) || b.count - a.count || a.slug.localeCompare(b.slug),
  ),
};
if (!recent.categories.length) throw new Error('build-trending: recent is empty');

writeFileSync(join(outData, 'trending.json'), JSON.stringify(trending) + '\n');
writeFileSync(join(outData, 'recent.json'), JSON.stringify(recent, null, 1) + '\n');
console.log(`build-trending: ${trending.global.length} global trending, ${recent.categories.length} recent categories (asOf ${trending.asOf})`);
