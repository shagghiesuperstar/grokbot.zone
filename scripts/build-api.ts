// Step 12: static read API + feeds, written into public/ so astro copies them to dist/.
// Runs after build-data and build-trending (it copies their outputs) and fails the build on
// a malformed record or a count that does not match the dataset.
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripEmails } from '../src/lib/strip-emails';

const ROOT = resolve(import.meta.dirname, '..');
const SITE = 'https://grokbot.zone';
const read = (f: string) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));

interface Bot { id: string; slug: string; code: string; name: string; author: string; description: string; cat: string; cats: string[] }
// src/data/bots.json stays as harvested; every public output gets the scrubbed copy.
const bots: Bot[] = (read('src/data/bots.json') as Bot[]).map((b) => ({ ...b, author: stripEmails(b.author), description: stripEmails(b.description) }));
const cats: { slug: string; label: string; count: number }[] = read('src/data/categories.json');
const trending = read('src/data/trending.json');
const recent = read('src/data/recent.json');
const meta = read('src/data/meta.json');
const label = new Map(cats.map((c) => [c.slug, c.label]));
const asOf: string = meta.asOf;

const fails: string[] = [];
for (const b of bots) {
  for (const k of ['id', 'code', 'name', 'description', 'cat'] as const) {
    if (typeof b[k] !== 'string' || !b[k]) fails.push(`bot ${b.id ?? '?'} has no ${k}`);
  }
  if (typeof b.author !== 'string') fails.push(`bot ${b.id} has no author field`);
  if (!label.has(b.cat)) fails.push(`bot ${b.id} names unknown category ${b.cat}`);
}
if (fails.length) {
  for (const f of fails.slice(0, 20)) console.error(`build-api: FAIL ${f}`);
  process.exit(1);
}

const apiDir = join(ROOT, 'public/api/v1');
rmSync(join(ROOT, 'public/api'), { recursive: true, force: true });
mkdirSync(join(apiDir, 'categories'), { recursive: true });
mkdirSync(join(apiDir, 'bots'), { recursive: true });
const put = (f: string, v: unknown) => writeFileSync(f, JSON.stringify(v) + '\n');

put(join(apiDir, 'index.json'), {
  name: 'GrokBot Zone read API',
  description: 'A static, read-only JSON catalog of public Grok bot listings. Documentation: ' + SITE + '/api/',
  asOf,
  totalBots: meta.totalBots,
  endpoints: {
    categories: '/api/v1/categories.json',
    category: '/api/v1/categories/{slug}.json',
    trending: '/api/v1/trending.json',
    recent: '/api/v1/recent.json',
    bot: '/api/v1/bots/{id}.json',
    codes: '/api/v1/codes.json',
    feedAtom: '/feed.xml',
    feedJson: '/feed.json',
    health: '/api/health',
  },
});
copyFileSync(join(ROOT, 'src/data/categories.json'), join(apiDir, 'categories.json'));
copyFileSync(join(ROOT, 'src/data/trending.json'), join(apiDir, 'trending.json'));
copyFileSync(join(ROOT, 'src/data/recent.json'), join(apiDir, 'recent.json'));

let catFiles = 0;
for (const c of cats) {
  copyFileSync(join(ROOT, 'public/search', `${c.slug}.json`), join(apiDir, 'categories', `${c.slug}.json`));
  catFiles++;
}
for (const b of bots) {
  put(join(apiDir, 'bots', `${b.id}.json`), {
    id: b.id,
    name: b.name,
    author: b.author,
    description: b.description,
    category: { slug: b.cat, label: label.get(b.cat) },
    code: b.code,
    link: `https://x.ai/bot/${b.code}`,
    asOf,
  });
}
put(join(apiDir, 'codes.json'), { codes: [...new Set(bots.map((b) => b.code.toLowerCase()))].sort() });

// Count guard: files emitted == dataset == meta.totalBots.
const botFiles = readdirSync(join(apiDir, 'bots')).length;
if (botFiles !== bots.length || bots.length !== meta.totalBots) {
  console.error(`build-api: FAIL ${botFiles} bot files, ${bots.length} dataset records, meta.totalBots ${meta.totalBots}`);
  process.exit(1);
}
if (catFiles !== cats.length) {
  console.error(`build-api: FAIL ${catFiles} category files for ${cats.length} categories`);
  process.exit(1);
}

// Feeds: the first 50 bots in trending.global order (the signal holds fewer today).
const bySlug = new Map(bots.map((b) => [b.slug, b]));
const entries = (trending.global as string[]).slice(0, 50).map((s) => {
  const b = bySlug.get(s);
  if (!b) throw new Error(`build-api: trending names unknown bot ${s}`);
  return b;
});
const stamp = `${trending.asOf}T00:00:00Z`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
writeFileSync(join(ROOT, 'public/feed.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n` +
  `  <title>GrokBot Zone: trending Grok bots</title>\n  <subtitle>${esc(trending.basis)}</subtitle>\n` +
  `  <link href="${SITE}/feed.xml" rel="self"/>\n  <link href="${SITE}/trending/"/>\n  <id>${SITE}/</id>\n  <updated>${stamp}</updated>\n` +
  entries.map((b) =>
    `  <entry>\n    <title>${esc(b.name)}</title>\n    <link href="${SITE}/bots/${b.slug}/"/>\n    <id>${SITE}/bots/${b.slug}/</id>\n` +
    `    <updated>${stamp}</updated>\n    <summary>${esc(b.description)}</summary>\n  </entry>\n`).join('') +
  `</feed>\n`);
writeFileSync(join(ROOT, 'public/feed.json'), JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'GrokBot Zone: trending Grok bots',
  home_page_url: `${SITE}/`,
  feed_url: `${SITE}/feed.json`,
  description: trending.basis,
  items: entries.map((b) => ({
    id: `${SITE}/bots/${b.slug}/`,
    url: `${SITE}/bots/${b.slug}/`,
    title: b.name,
    summary: b.description,
    date_modified: stamp,
  })),
}, null, 1) + '\n');

// Digest payload read by the Worker's scheduled() handler.
mkdirSync(join(ROOT, 'public/digests'), { recursive: true });
put(join(ROOT, 'public/digests/latest.json'), {
  asOf,
  totalBots: meta.totalBots,
  categoryCount: cats.length,
  top: entries.slice(0, 10).map((b) => ({ id: b.slug, name: b.name, description: b.description })),
});

console.log(`build-api: ${botFiles} bot files, ${catFiles} category files, ${entries.length} feed entries, asOf ${asOf}`);
