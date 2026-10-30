// R1: committed corpus -> validated, flattened site data.
// Usage: tsx scripts/build-data.ts [corpusDir]   (default: data/corpus, or $CORPUS_DIR)
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

interface Bot { id: string; slug: string; code: string; name: string; author: string; description: string; cat: string }

const index = readJson(join(corpusDir, 'index.json'));
if (!Array.isArray(index.categories) || !isStr(index.asOf)) fail('index.json', '', 'missing asOf or categories');

const bots: Bot[] = [];
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
    for (const k of ['id', 'code', 'name', 'author', 'description', 'url'])
      if (!isStr(b[k])) fail(file, where, `field "${k}" missing or empty`);
    const r = b as Record<string, string>;
    if (r.id !== `${c.slug}-${r.code}`) fail(file, where, `id must be "${c.slug}-<code>"`);
    if (r.url !== `https://x.ai/bot/${r.code}`) fail(file, where, `url must be https://x.ai/bot/<code>`);
    if (!/^[A-Za-z0-9_-]+$/.test(r.code)) fail(file, where, 'code has unexpected characters');
    if (seenId.has(r.id)) fail(file, where, 'duplicate id');
    seenId.add(r.id);
    bots.push({ id: r.id, slug: r.id, code: r.code, name: r.name, author: r.author, description: r.description, cat: c.slug });
  });
  categories.push({ slug: c.slug, label: c.label, count: c.count, purpose: PURPOSE[c.slug], updated: payload.asOf });
}
if (bots.length !== index.totalBots) fail('index.json', 'totalBots', `index says ${index.totalBots}, found ${bots.length}`);

// ---- URL slugs ----
// Ids are case-sensitive upstream, but URL paths must stay unique on case-insensitive
// filesystems and CDNs. Where ids differ only by letter case, the first (by byte order) keeps
// its id as slug and the rest get a numeric suffix. Dataset ids are never altered.
{
  const groups = new Map<string, Bot[]>();
  for (const b of bots) (groups.get(b.id.toLowerCase()) ?? groups.set(b.id.toLowerCase(), []).get(b.id.toLowerCase())!).push(b);
  const taken = new Set(bots.map((b) => b.id.toLowerCase()));
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => (a.id < b.id ? -1 : 1));
    g.slice(1).forEach((b, k) => {
      let n = k + 2;
      while (taken.has(`${b.id.toLowerCase()}-${n}`)) n++;
      b.slug = `${b.id}-${n}`;
      taken.add(b.slug.toLowerCase());
    });
  }
  const seen = new Set<string>();
  for (const b of bots) {
    if (seen.has(b.slug.toLowerCase())) fail('corpus', b.id, 'slug collision after disambiguation');
    seen.add(b.slug.toLowerCase());
  }
}

// ---- popularity rank for search tie-breaks (lower is better) ----
const pop = readJson(join(signalsDir, 'popularity.json'));
const byCode = new Map(bots.map((b) => [b.code, b]));
const labelToSlug = new Map(categories.map((c) => [c.label, c.slug]));
const rank = new Map<string, number>();
(pop.global as string[]).forEach((code, i) => {
  if (!byCode.has(code)) fail('popularity.json', 'global', `unknown code ${code}`);
  rank.set(code, i);
});
for (const [label, codes] of Object.entries(pop.perCategory as Record<string, string[]>)) {
  if (!labelToSlug.has(label)) fail('popularity.json', 'perCategory', `unknown category ${label}`);
  codes.forEach((code, i) => {
    if (!byCode.has(code)) fail('popularity.json', label, `unknown code ${code}`);
    if (!rank.has(code)) rank.set(code, 100 + i);
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
    (score.get(c) ?? 0) - (score.get(a) ?? 0) || (rank.get(bots[a].code) ?? NO_RANK) - (rank.get(bots[c].code) ?? NO_RANK) || (bots[a].slug < bots[c].slug ? -1 : 1);
  const same = bots.map((_, j) => j).filter((j) => j !== i && bots[j].cat === b.cat).sort(order).slice(0, SAME);
  const cross = [...score.keys()].filter((j) => bots[j].cat !== b.cat).sort(order).slice(0, CROSS);
  related[b.slug] = [...same.map((j) => [bots[j].slug, 's'] as [string, 's']), ...cross.map((j) => [bots[j].slug, 't'] as [string, 't'])];
});

// ---- write ----
mkdirSync(outData, { recursive: true });
rmSync(outSearch, { recursive: true, force: true });
mkdirSync(outSearch, { recursive: true });
const meta = { asOf: index.asOf as string, totalBots: bots.length, categoryCount: categories.length };
writeFileSync(join(outData, 'meta.json'), JSON.stringify(meta, null, 1) + '\n');
writeFileSync(join(outData, 'bots.json'), JSON.stringify(bots) + '\n');
writeFileSync(join(outData, 'categories.json'), JSON.stringify(categories, null, 1) + '\n');
writeFileSync(join(outData, 'related.json'), JSON.stringify(related) + '\n');

// Per-category search payloads (lazy-fetched by the browser) + tiny index.
for (const c of categories) {
  const recs = bots.filter((b) => b.cat === c.slug).map((b) => ({ i: b.slug, n: b.name, a: b.author, d: b.description, r: rank.get(b.code) ?? NO_RANK }));
  writeFileSync(join(outSearch, `${c.slug}.json`), JSON.stringify({ slug: c.slug, label: c.label, count: c.count, bots: recs }));
}
writeFileSync(join(outSearch, 'index.json'), JSON.stringify({ asOf: meta.asOf, totalBots: meta.totalBots, categories: categories.map((c) => ({ slug: c.slug, label: c.label, count: c.count, path: `/search/${c.slug}.json` })) }));
console.log(`build-data: ${bots.length} bots, ${categories.length} categories (corpus: ${corpusDir})`);
