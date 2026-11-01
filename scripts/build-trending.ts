// R4/R5: dated signal files -> trending.json + recent.json. Every output carries its own asOf.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readLive } from './lib-live';

const ROOT = resolve(import.meta.dirname, '..');
const outData = process.env.OUT_DATA ? resolve(process.env.OUT_DATA) : join(ROOT, 'src/data');
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const bots: { slug: string; code: string }[] = read(join(outData, 'bots.json'));
const cats: { slug: string; label: string; count: number }[] = read(join(outData, 'categories.json'));
// Look up by lowercased code: a signal entry may name the spelling that the dedupe
// dropped; the survivor of that group differs only by letter case, so the lowercased key
// resolves both spellings to the same bot and the signal keeps its bot and its order.
const dead = readLive(new Set(cats.map((c) => c.slug))).dead; // bots dropped as dead leave the seed order
const idOf = new Map(bots.map((b) => [b.code.toLowerCase(), b.slug]));
const codeOf = new Map(bots.map((b) => [b.code.toLowerCase(), b.code]));
const slugOf = new Map(cats.map((c) => [c.label, c.slug]));
const countOf = new Map(cats.map((c) => [c.slug, c.count]));
const must = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`build-trending: unknown ${what}`);
  return v;
};

// A signal entry that names the dropped spelling still resolves to its bot, so the entry
// is kept and remapped to the survivor rather than dropped. Count them so the build says
// how much of the signal was affected.
let remapped = 0;
const slugFor = (code: string): string => {
  const k = code.toLowerCase();
  if (codeOf.get(k) !== code) remapped++;
  return must(idOf.get(k), `code ${code}`);
};
// One bot per entry: the same bot must not be listed twice in one trending list.
const unique = (slugs: string[], what: string): string[] => {
  const seen = new Set<string>();
  for (const s of slugs) {
    if (seen.has(s)) throw new Error(`build-trending: ${what} lists ${s} twice`);
    seen.add(s);
  }
  return slugs;
};

const pop = read(join(ROOT, 'data/signals/popularity.json'));
const trending = {
  asOf: pop.asOf as string,
  basis: pop.basis as string,
  global: unique((pop.global as string[]).filter((c) => !dead.has(c.toLowerCase())).map((c) => slugFor(c)), 'global trending'),
  perCategory: Object.fromEntries(
    Object.entries(pop.perCategory as Record<string, string[]>).map(([label, codes]) => [
      must(slugOf.get(label), `category ${label}`),
      unique(codes.filter((c) => !dead.has(c.toLowerCase())).map((c) => slugFor(c)), `category ${label}`),
    ]),
  ),
};
if (!trending.global.length) throw new Error('build-trending: trending is empty');

const rec = read(join(ROOT, 'data/signals/recency.json'));
const recent = {
  asOf: rec.asOf as string,
  basis: rec.basis as string,
  // The count of a category is taken from the generated category data, so the recently
  // refreshed rail shows the same number as the category page it links to.
  categories: [...(rec.categories as { slug: string; label: string; count: number; asOf: string }[])].map((c) => ({
    ...c,
    count: must(countOf.get(c.slug), `category ${c.slug}`),
  })).sort((a, b) => b.asOf.localeCompare(a.asOf) || b.count - a.count || a.slug.localeCompare(b.slug)),
};
if (!recent.categories.length) throw new Error('build-trending: recent is empty');

writeFileSync(join(outData, 'trending.json'), JSON.stringify(trending) + '\n');
writeFileSync(join(outData, 'recent.json'), JSON.stringify(recent, null, 1) + '\n');
console.log(
  `build-trending: ${trending.global.length} global trending, ${recent.categories.length} recent categories (asOf ${trending.asOf}), ${remapped} signal entries remapped to a survivor code`,
);
