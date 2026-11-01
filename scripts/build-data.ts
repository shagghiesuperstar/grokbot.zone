// R1: committed corpus -> validated, flattened site data.
// Usage: tsx scripts/build-data.ts [corpusDir]   (default: data/corpus, or $CORPUS_DIR)
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripEmails } from '../src/lib/strip-emails';

const ROOT = resolve(import.meta.dirname, '..');
const corpusDir = resolve(process.argv[2] ?? process.env.CORPUS_DIR ?? join(ROOT, 'data/corpus'));
const signalsDir = join(ROOT, 'data/signals');
const outData = process.env.OUT_DATA ? resolve(process.env.OUT_DATA) : join(ROOT, 'src/data');
const outSearch = process.env.OUT_SEARCH ? resolve(process.env.OUT_SEARCH) : join(ROOT, 'public/search');

const PURPOSE: Record<string, string> = {
  'business-operations': 'Run the back office: invoices, reports, vendors, process and team admin.',
  'calendar-meetings-scheduling': 'Book, move and prepare for meetings without the back-and-forth.',
  'coding-software': 'Write, review, debug and ship code with a bot at your side.',
  'email-inbox': 'Triage, draft and tame your inbox.',
  'everything-else': 'Bots that do not fit a box, from niche tools to one-off ideas.',
  'family-kids-learning': 'Homework help, learning plans, and family organising.',
  'food-recipes-dining': 'Plan meals, cook from what you have, and pick where to eat.',
  'fun-games-hobbies': 'Games, hobbies and play.',
  'grok-bot-helpers-bots-that-build-or-manage-bots': 'Bots that build, tune or manage other Grok bots.',
  'health-fitness-wellness': 'Training plans, nutrition, sleep and everyday wellness questions.',
  'home-garden-pets': 'Home projects, gardens and pet care.',
  'jobs-careers': 'Resumes, job search, interviews and career moves.',
  'legal-tax-paperwork': 'Understand forms, filings and everyday legal and tax paperwork.',
  'marketing-seo-ads': 'Campaigns, search visibility, ad copy and content plans.',
  'money-personal-finance': 'Budgets, bills, savings and everyday money decisions.',
  'privacy-security-scam-protection': 'Stop spam calls, spot scams, and lock down your data.',
  'productivity-personal-assistant': 'Tasks, notes, reminders and a personal assistant for the day.',
  'real-estate': 'Search, compare and manage property, as a buyer, seller or landlord.',
  'research-news-briefings': 'Research a topic, follow the news, and get a short briefing.',
  'sales-lead-generation': 'Find leads, write outreach and keep a pipeline moving.',
  'shopping-deals': 'Compare prices, find deals, and decide what to buy.',
  'trading-crypto-investing': 'Markets, crypto and investing research and tracking.',
  travel: 'Plan trips, find routes, and handle the details of getting there.',
  'video-images-audio-design': 'Make and edit video, images, audio and design work.',
  'writing-publishing': 'Draft, edit and publish writing of every length.',
  'x-twitter-social-media': 'Post, grow and manage your presence on X and other social platforms.',
};

class CorpusError extends Error {}
const fail = (file: string, where: string, msg: string): never => {
  throw new CorpusError(`MALFORMED CORPUS: ${file} ${where}: ${msg}`);
};
const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

interface Bot { id: string; slug: string; code: string; name: string; author: string; description: string; cat: string; cats: string[] }

const index = readJson(join(corpusDir, 'index.json'));
if (!Array.isArray(index.categories) || !isStr(index.asOf)) fail('index.json', '', 'missing asOf or categories');

const rawBots: Bot[] = [];
const categories: { slug: string; label: string; count: number; purpose: string; updated: string }[] = [];
const seenId = new Set<string>();

for (const c of index.categories) {
  const file = `${c.slug}.json`;
  const payload = readJson(join(corpusDir, file));
  if (payload.slug !== c.slug) fail(file, 'slug', `expected ${c.slug}, got ${payload.slug}`);
  if (!Array.isArray(payload.bots)) fail(file, 'bots', 'not an array');
  if (payload.bots.length !== c.count || payload.count !== c.count)
    fail(file, 'count', `index says ${c.count}, file has ${payload.bots.length} (declares ${payload.count})`);
  if (!PURPOSE[c.slug]) fail(file, 'slug', 'no purpose line defined for this category');
  payload.bots.forEach((b: Record<string, unknown>, i: number) => {
    const where = `record #${i} (${String(b?.id ?? 'no id')})`;
    for (const k of ['id', 'code', 'name', 'description', 'url'])
      if (!isStr(b[k])) fail(file, where, `field "${k}" missing or empty`);
    // An empty author is valid: the listing simply shows no author line.
    if (typeof b.author !== 'string') fail(file, where, 'field "author" must be a string');
    const r = b as Record<string, string>;
    if (r.id !== `${c.slug}-${r.code}`) fail(file, where, `id must be "${c.slug}-<code>"`);
    if (r.url !== `https://x.ai/bot/${r.code}`) fail(file, where, 'url must be https://x.ai/bot/<code>');
    if (!/^[A-Za-z0-9_-]+$/.test(r.code)) fail(file, where, 'code has unexpected characters');
    if (seenId.has(r.id)) fail(file, where, 'duplicate id');
    seenId.add(r.id);
    rawBots.push({ id: r.id, slug: r.id, code: r.code, name: r.name, author: r.author, description: r.description, cat: c.slug, cats: [c.slug] });
  });
  categories.push({ slug: c.slug, label: c.label, count: c.count, purpose: PURPOSE[c.slug], updated: payload.asOf });
}
if (rawBots.length !== index.rawTotalBots) fail('index.json', 'rawTotalBots', `index says ${index.rawTotalBots}, found ${rawBots.length}`);

// ---- dedupe: one bot listed twice with codes differing only by letter case ----
// The corpus stores one record per (category, bot) listing, so a bot that belongs to two
// categories is stored twice, under spellings that differ only by letter case. They are the
// same bot on x.ai, so one record survives. Survivor: longest description, then longest
// author (the shorter author is the shortened form), then first code by byte order. The
// survivor keeps its corpus casing, so https://x.ai/bot/<code> still resolves.
//
// A bot listed in two categories keeps both: the survivor takes the union of the group's
// categories, so no listing is lost. `cat` stays the survivor's own category (it names the
// page and the SEO category); `cats` is the union, used for listing a bot under each
// category it belongs to.
const bots: Bot[] = [];
{
  const groups = new Map<string, Bot[]>();
  for (const b of rawBots) {
    const k = b.code.toLowerCase();
    const g = groups.get(k);
    if (g) g.push(b);
    else groups.set(k, [b]);
  }
  const merged = new Map<string, Bot>(); // lowercased code -> surviving record
  for (const g of groups.values()) {
    // Codes are ASCII (validated above), so code-unit order is byte order.
    const sorted = [...g].sort(
      (a, b) =>
        b.description.length - a.description.length ||
        b.author.length - a.author.length ||
        (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
    );
    const [winner, ...losers] = sorted;
    const cats = [winner.cat, ...[...new Set(losers.map((l) => l.cat))].filter((c) => c !== winner.cat).sort()];
    merged.set(winner.code.toLowerCase(), { ...winner, cats });
  }
  // Keep the corpus order: each bot is emitted at the position of its first listing.
  const emitted = new Set<string>();
  for (const b of rawBots) {
    const k = b.code.toLowerCase();
    if (emitted.has(k)) continue;
    emitted.add(k);
    bots.push(merged.get(k)!);
  }
}
// A category lists every bot that belongs to it, so its count is the number of listings,
// not the number of distinct bots: a bot in two categories is listed in both.
const catCounts = new Map<string, number>();
for (const b of bots) for (const c of b.cats) catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
for (const c of categories) c.count = catCounts.get(c.slug) ?? 0;

// ---- URL slugs ----
// The slug is the dataset id. The dedupe above leaves one record per code.toLowerCase(), so no
// two ids can differ only by letter case: the slug is unique as-is, with no numeric suffix.
// The check below stays as the guard that proves it.
{
  const seen = new Set<string>();
  for (const b of bots) {
    if (seen.has(b.slug.toLowerCase())) fail('corpus', b.id, 'duplicate slug after dedupe');
    seen.add(b.slug.toLowerCase());
  }
}

// ---- popularity rank for search tie-breaks (lower is better) ----
// Lookups are by lowercased code. A signal entry may name the spelling that the dedupe
// dropped; the survivor of that group differs only by letter case, so the lowercased key
// resolves both spellings to the same bot and the signal keeps its bot and its order.
const pop = readJson(join(signalsDir, 'popularity.json'));
const byCode = new Map(bots.map((b) => [b.code.toLowerCase(), b]));
const labelToSlug = new Map(categories.map((c) => [c.label, c.slug]));
const rank = new Map<string, number>();
const seenGlobal = new Set<string>();
(pop.global as string[]).forEach((code, i) => {
  const k = code.toLowerCase();
  if (!byCode.has(k)) fail('popularity.json', 'global', `unknown code ${code}`);
  if (seenGlobal.has(k)) fail('popularity.json', 'global', `duplicate code ${code} after dedupe`);
  seenGlobal.add(k);
  rank.set(k, i);
});
for (const [label, codes] of Object.entries(pop.perCategory as Record<string, string[]>)) {
  if (!labelToSlug.has(label)) fail('popularity.json', 'perCategory', `unknown category ${label}`);
  const seen = new Set<string>();
  codes.forEach((code, i) => {
    const k = code.toLowerCase();
    if (!byCode.has(k)) fail('popularity.json', label, `unknown code ${code}`);
    if (seen.has(k)) fail('popularity.json', label, `duplicate code ${code} after dedupe`);
    seen.add(k);
    if (!rank.has(k)) rank.set(k, 100 + i);
  });
}
const NO_RANK = 1_000_000;

// ---- related (R6): same category first, then description-token overlap ----
const STOP = new Set('the and for with your you that this from are can has have into out all any more most not but its their them they then than who how what when where will also about get gets use uses using make makes made one two bot bots grok help helps helper based'.split(' '));
const tokenize = (b: Bot) => [...new Set(`${b.name} ${b.description}`.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter((t) => !STOP.has(t));
const toks = bots.map(tokenize);
const post = new Map<string, number[]>();
toks.forEach((ts, i) => ts.forEach((t) => (post.get(t) ?? post.set(t, []).get(t)!).push(i)));
const idf = (t: string) => Math.log(bots.length / post.get(t)!.length);
const SAME = 4, CROSS = 2;
const related: Record<string, [string, 's' | 't'][]> = {};
bots.forEach((b, i) => {
  const score = new Map<number, number>();
  for (const t of toks[i]) {
    const p = post.get(t)!;
    if (p.length > 800) continue;
    const w = idf(t);
    for (const j of p) if (j !== i) score.set(j, (score.get(j) ?? 0) + w);
  }
  const order = (a: number, c: number) =>
    (score.get(c) ?? 0) - (score.get(a) ?? 0) || (rank.get(bots[a].code.toLowerCase()) ?? NO_RANK) - (rank.get(bots[c].code.toLowerCase()) ?? NO_RANK) || (bots[a].slug < bots[c].slug ? -1 : 1);
  // "Same" is the bot's own category (the page it sits on); "cross" is a bot it shares no
  // category with, so a bot listed in two categories never appears as an outsider.
  const same = bots.map((_, j) => j).filter((j) => j !== i && bots[j].cat === b.cat).sort(order).slice(0, SAME);
  const cross = [...score.keys()].filter((j) => !bots[j].cats.some((c) => b.cats.includes(c))).sort(order).slice(0, CROSS);
  related[b.slug] = [...same.map((j) => [bots[j].slug, 's'] as [string, 's']), ...cross.map((j) => [bots[j].slug, 't'] as [string, 't'])];
});

// ---- write ----
mkdirSync(outData, { recursive: true });
rmSync(outSearch, { recursive: true, force: true });
mkdirSync(outSearch, { recursive: true });
// totalBots counts distinct bots; totalListings counts category listings, which is higher
// because a bot in two categories is listed twice.
const totalListings = categories.reduce((n, c) => n + c.count, 0);
const meta = { asOf: index.asOf as string, totalBots: bots.length, totalListings, categoryCount: categories.length };
writeFileSync(join(outData, 'meta.json'), JSON.stringify(meta, null, 1) + '\n');
writeFileSync(join(outData, 'bots.json'), JSON.stringify(bots) + '\n');
writeFileSync(join(outData, 'categories.json'), JSON.stringify(categories, null, 1) + '\n');
writeFileSync(join(outData, 'related.json'), JSON.stringify(related) + '\n');

// Per-category search payloads (lazy-fetched by the browser) + tiny index.
// A category's payload holds every bot LISTED in that category, so a bot that belongs to
// two categories appears in both payloads and `count` is the category's listing count.
// The browser indexes one row per bot, so a name never returns the same bot twice.
for (const c of categories) {
  const recs = bots
    .filter((b) => b.cats.includes(c.slug))
    .map((b) => ({ i: b.slug, n: b.name, a: stripEmails(b.author), d: stripEmails(b.description), r: rank.get(b.code.toLowerCase()) ?? NO_RANK, c: b.cat }));
  writeFileSync(join(outSearch, `${c.slug}.json`), JSON.stringify({ slug: c.slug, label: c.label, count: recs.length, bots: recs }));
}
writeFileSync(join(outSearch, 'index.json'), JSON.stringify({ asOf: meta.asOf, totalBots: meta.totalBots, categories: categories.map((c) => ({ slug: c.slug, label: c.label, count: c.count, path: `/search/${c.slug}.json` })) }));
console.log(`build-data: ${bots.length} bots, ${categories.length} categories (corpus: ${corpusDir})`);
