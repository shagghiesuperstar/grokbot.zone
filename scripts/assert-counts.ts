// Verifies the counts published in the repo still match the generated data, so a published
// number can never drift away from the set it describes.
// Usage: tsx scripts/assert-counts.ts
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readLive } from './lib-live';

const ROOT = resolve(import.meta.dirname, '..');
const readJson = (f: string) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
const fmt = (n: number) => n.toLocaleString('en-US');

const meta = readJson('src/data/meta.json');
const corpus = readJson('data/corpus/index.json');
const bots = readJson('src/data/bots.json');
const categories = readJson('src/data/categories.json');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

const published = meta.totalBots as number; // distinct bots
const listings = meta.totalListings as number; // category listings (a bot in two categories counts twice)
const raw = corpus.rawTotalBots as number; // raw corpus listing records
const fails: string[] = [];

if (bots.length !== published) fails.push(`src/data/bots.json has ${bots.length} records, meta.totalBots says ${published}`);
const sum = (categories as { count: number }[]).reduce((n, c) => n + c.count, 0);
if (sum !== listings) fails.push(`category counts sum to ${sum}, meta.totalListings says ${listings}`);
// Bots the data plane added after the seed are published without being in the raw corpus.
const liveAdded = readLive(new Set((readJson('src/data/categories.json') as { slug: string }[]).map((c) => c.slug))).added.length;
if (published > raw + liveAdded) fails.push(`published ${published} exceeds the raw corpus ${raw} plus ${liveAdded} added since`);
if (listings < published) fails.push(`listing total ${listings} is below the bot total ${published}`);

// Every category count is the number of bots whose category set contains it, and every bot
// names only categories that exist.
const known = new Set((categories as { slug: string }[]).map((c) => c.slug));
for (const b of bots as { cat: string; cats: string[] }[]) {
  if (!b.cats.includes(b.cat)) fails.push(`bot ${b.cat} does not include its own category`);
  for (const c of b.cats) if (!known.has(c)) fails.push(`bot names unknown category ${c}`);
}
for (const c of categories as { slug: string; count: number }[]) {
  const n = (bots as { cats: string[] }[]).filter((b) => b.cats.includes(c.slug)).length;
  if (n !== c.count) fails.push(`category ${c.slug} says ${c.count} bots, ${n} bots list it`);
}

// The search payloads carry one record per category listing, and every bot appears once per
// category it belongs to: the listings add up, and the distinct bots do not.
const searchDir = join(ROOT, 'public/search');
if (existsSync(searchDir)) {
  const files = readdirSync(searchDir).filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'live.json'); // live.json is the Worker's merge file, not a category
  const ids = new Set<string>();
  let recs = 0;
  for (const f of files) {
    const p = readJson(`public/search/${f}`);
    recs += p.bots.length;
    if (p.bots.length !== p.count) fails.push(`search payload ${f} says ${p.count} bots, holds ${p.bots.length}`);
    for (const b of p.bots) ids.add(b.i);
  }
  if (recs !== listings) fails.push(`search payloads hold ${recs} records, meta.totalListings says ${listings}`);
  if (ids.size !== published) fails.push(`search payloads hold ${ids.size} distinct bots, meta.totalBots says ${published}`);
}

// The README quotes both numbers; the raw one must be labelled as the raw corpus count.
if (!readme.includes(fmt(published))) fails.push(`README.md does not state the published count ${fmt(published)}`);
if (!readme.includes(fmt(raw))) fails.push(`README.md does not state the raw corpus count ${fmt(raw)}`);
for (const line of readme.split('\n')) {
  if (line.includes(fmt(raw)) && !/raw/i.test(line)) fails.push(`README.md states ${fmt(raw)} without labelling it as the raw corpus count: ${line.trim()}`);
}
// The layer list quotes the listing total too, so it cannot drift either.
if (!readme.includes(fmt(listings))) fails.push(`README.md does not state the category listing count ${fmt(listings)}`);

if (fails.length) {
  for (const f of fails) console.error(`assert-counts: FAIL ${f}`);
  process.exit(1);
}
console.log(
  `assert-counts: ${fmt(published)} published bots, ${fmt(listings)} category listings (raw corpus ${fmt(raw)}), ${categories.length} categories, README in sync`,
);
