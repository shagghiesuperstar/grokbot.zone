// Deploy gate. Replaces whole-bundle byte equality.
// A stale tracked snapshot must fail; a fresh build of the tracked inputs must pass.
// Live catalog movement is reported as INFO and is never a pass/fail condition.
//
// Usage: tsx scripts/verify-deploy-artifact.ts [--bundle PATH] [--bots PATH]
//   GATE_BUNDLE / GATE_BOTS override the same paths (discrimination proof only).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readLive } from './lib-live';

const ROOT = resolve(import.meta.dirname, '..');
const BASE = 'e760334a95393b08ff8fbf125d9fb3e85f24b114';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const bundlePath = arg('--bundle') ?? process.env.GATE_BUNDLE ?? join(ROOT, 'public/_worker.js/index.js');
const botsPath = arg('--bots') ?? process.env.GATE_BOTS ?? join(ROOT, 'src/data/bots.json');
const sourcePath = join(ROOT, 'src/worker/mcp.ts');
const categoriesPath = join(ROOT, 'src/data/categories.json');
const metaPath = join(ROOT, 'src/data/meta.json');
const distDir = join(ROOT, 'dist');

const fails: string[] = [];
const fail = (msg: string) => {
  fails.push(msg);
  console.error(`gate:deploy FAIL ${msg}`);
};
const pass = (msg: string) => console.log(`gate:deploy PASS ${msg}`);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

type Bot = { id?: unknown; code?: unknown; name?: unknown; author?: unknown; description?: unknown };
type Category = { slug: string; count: number };

function extractBundleCategoryMap(bundle: string): Map<string, number> {
  const marker = '// src/data/categories.json';
  const start = bundle.indexOf(marker);
  if (start < 0) throw new Error('bundle has no src/data/categories.json module');
  const next = bundle.indexOf('\n// ', start + marker.length);
  const section = next < 0 ? bundle.slice(start) : bundle.slice(start, next);
  const map = new Map<string, number>();
  const re = /slug:\s*"([^"]+)"[\s\S]*?count:\s*(\d+)/g;
  for (const m of section.matchAll(re)) map.set(m[1], Number(m[2]));
  if (map.size === 0) throw new Error('category extraction found 0 slugs; the extractor is not reading the embedded map');
  return map;
}

function toolNames(text: string): Set<string> {
  return new Set(text.match(/grokbot_[a-z_]+/g) ?? []);
}

function hasOutputMarker(text: string): boolean {
  // Source and bundle keep the unicode escape. A future source that writes the character also counts.
  return text.includes('\\u2014 id: ') || text.includes('\u2014 id: ');
}

// Assembled so the source does not contain the contiguous phrases this scan rejects.
const SAFETY_NEEDLES = [
  ['po', 'box'].join(' '),
  ['p.o.', 'box'].join(' '),
  ['street', 'address'].join(' '),
  ['2900', 'NASA'].join(' '),
  ['7482', 'Harwin'].join(' '),
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function safetyHits(label: string, text: string): string[] {
  const lower = text.toLowerCase();
  return SAFETY_NEEDLES.filter((n) => lower.includes(n.toLowerCase())).map((n) => `${label} contains ${JSON.stringify(n)}`);
}

async function liveDelta(built: Map<string, number>, builtListings: number): Promise<string> {
  try {
    const res = await fetch('https://grokbot.zone/api/v1/categories.json', {
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': 'grokbot-zone-gate/1.0' },
    });
    if (!res.ok) return `INFO live delta unavailable: HTTP ${res.status} (not a pass/fail check)`;
    const data = (await res.json()) as { categories?: unknown } | unknown[];
    const cats = Array.isArray(data) ? data : Array.isArray(data.categories) ? data.categories : null;
    if (!cats) return 'INFO live delta unavailable: unusable payload (not a pass/fail check)';
    let liveListings = 0;
    let mismatches = 0;
    const examples: string[] = [];
    for (const raw of cats) {
      const c = raw as { slug?: unknown; count?: unknown };
      const slug = typeof c.slug === 'string' ? c.slug : '';
      const count = Number(c.count ?? 0);
      liveListings += Number.isFinite(count) ? count : 0;
      if (built.get(slug) !== count) {
        mismatches++;
        if (examples.length < 5) examples.push(`${slug || '?'} built=${built.get(slug) ?? 'missing'} live=${count}`);
      }
    }
    const eg = examples.length ? ` e.g. ${examples.join('; ')}` : '';
    return `INFO live delta: live_categories=${cats.length} live_listings=${liveListings} built_listings=${builtListings} category_mismatches=${mismatches}${eg} (not a pass/fail check; the crawler may move between refreshes)`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `INFO live delta unavailable: ${msg} (not a pass/fail check)`;
  }
}

const categories = readJson(categoriesPath) as Category[];
const meta = readJson(metaPath) as { totalBots: number; totalListings: number };
const bots = readJson(botsPath) as Bot[];
const known = new Set(categories.map((c) => c.slug));
const live = readLive(known);
const builtIds = new Set(bots.map((b) => String(b.id ?? '')));
const missing = live.added.filter((a) => !builtIds.has(a.id));
const extra = bots.filter((b) => !live.added.some((a) => a.id === b.id)).length;

console.log(`gate:deploy live-added expected: ${live.added.length}`);
console.log(`gate:deploy missing: ${missing.length}`);
console.log(`gate:deploy built-bot count: ${bots.length}`);
if (botsPath !== join(ROOT, 'src/data/bots.json')) console.log(`gate:deploy bots override: ${botsPath}`);
if (bundlePath !== join(ROOT, 'public/_worker.js/index.js')) console.log(`gate:deploy bundle override: ${bundlePath}`);

if (missing.length) {
  const examples = missing.slice(0, 10).map((a) => a.id);
  fail(`G1a ${missing.length} accepted live-added ids missing from bots.json; examples: ${examples.join(', ')}`);
  console.error('gate:deploy missing ids:');
  for (const a of missing) console.error(a.id);
} else {
  pass(`G1a every accepted live-added id is in bots.json (${live.added.length})`);
}
console.log(`gate:deploy INFO extra built ids not in accepted live-added: ${extra} (not a failure; corpus bots are expected)`);

for (const b of bots) {
  for (const k of ['id', 'code', 'name', 'author', 'description'] as const) {
    if (typeof b[k] !== 'string') {
      fail(`G1 bot lacks ${k}`);
      break;
    }
  }
  if (typeof b.id === 'string' && !b.id) fail('G1 bot has empty id');
  if (typeof b.code === 'string' && !b.code) fail('G1 bot has empty code');
  if (typeof b.name === 'string' && !b.name) fail('G1 bot has empty name');
  if (typeof b.description === 'string' && !b.description) fail('G1 bot has empty description');
}

if (bots.length !== meta.totalBots) fail(`G1 built bots.json length ${bots.length} != meta.totalBots ${meta.totalBots}`);
else pass(`G1 built bots.json length matches meta.totalBots (${meta.totalBots})`);

const listingSum = categories.reduce((n, c) => n + c.count, 0);
if (listingSum !== meta.totalListings) fail(`G1 category counts sum ${listingSum} != meta.totalListings ${meta.totalListings}`);
else pass(`G1 category counts sum matches meta.totalListings (${meta.totalListings})`);

if (!existsSync(bundlePath)) fail(`G1b bundle missing: ${bundlePath}`);
const bundle = existsSync(bundlePath) ? readFileSync(bundlePath, 'utf8') : '';
let coverage = '0/0';
try {
  const embedded = bundle ? extractBundleCategoryMap(bundle) : new Map<string, number>();
  const builtMap = new Map(categories.map((c) => [c.slug, c.count]));
  let matched = 0;
  const mismatches: string[] = [];
  for (const [slug, count] of builtMap) {
    if (embedded.get(slug) === count) matched++;
    else if (mismatches.length < 10) mismatches.push(`${slug} built=${count} bundle=${embedded.get(slug) ?? 'missing'}`);
  }
  for (const slug of embedded.keys()) {
    if (!builtMap.has(slug) && mismatches.length < 10) mismatches.push(`${slug} extra in bundle`);
  }
  coverage = `${matched}/${builtMap.size}`;
  console.log(`gate:deploy category-map coverage: ${coverage}`);
  if (matched !== builtMap.size || embedded.size !== builtMap.size) {
    fail(`G1b category map ${coverage} does not equal built categories.json (${embedded.size} bundle slugs); ${mismatches.join('; ')}`);
  } else {
    pass(`G1b bundle category map equals built categories.json (${coverage})`);
  }
} catch (e) {
  console.log(`gate:deploy category-map coverage: ${coverage}`);
  fail(`G1b ${e instanceof Error ? e.message : String(e)}`);
}

const source = readFileSync(sourcePath, 'utf8');
const sourceTools = toolNames(source);
const bundleTools = toolNames(bundle);
console.log(`gate:deploy tool count: ${bundleTools.size}`);
const sourceList = [...sourceTools].sort();
const bundleList = [...bundleTools].sort();
if (sourceTools.size !== 9) fail(`G2 reviewed source grokbot_* set is ${sourceTools.size}, expected 9: ${sourceList.join(', ')}`);
if (bundleTools.size !== 9 || sourceList.join('\n') !== bundleList.join('\n')) {
  const onlyBundle = bundleList.filter((n) => !sourceTools.has(n));
  const onlySource = sourceList.filter((n) => !bundleTools.has(n));
  fail(`G2 bundle tool set != source set (source ${sourceTools.size}, bundle ${bundleTools.size}); only-bundle: ${onlyBundle.join(', ') || 'none'}; only-source: ${onlySource.join(', ') || 'none'}`);
} else {
  pass(`G2 bundle grokbot_* set equals reviewed source (${bundleTools.size})`);
}

const markers = ['matches:', 'additionalProperties', 'maxLength', 'required'] as const;
for (const marker of markers) {
  if (!source.includes(marker)) fail(`G2 source missing contract marker ${marker}`);
  if (!bundle.includes(marker)) fail(`G2 bundle missing contract marker ${marker}`);
}
if (!hasOutputMarker(source)) fail('G2 source missing output-format marker (escaped or literal em dash + id:)');
if (!hasOutputMarker(bundle)) fail('G2 bundle missing output-format marker (escaped or literal em dash + id:)');
if (fails.every((f) => !f.startsWith('G2 source missing') && !f.startsWith('G2 bundle missing'))) {
  pass('G2 contract markers present in source and bundle');
}

const safety: string[] = [];
if (bundle) safety.push(...safetyHits('bundle', bundle));
if (!existsSync(distDir)) fail('G3 dist/ missing; gate runs after pnpm build');
else {
  for (const file of walk(distDir)) safety.push(...safetyHits(file, readFileSync(file).toString('latin1')));
}
if (safety.length) fail(`G3 content safety: ${safety.join('; ')}`);
else pass('G3 content safety clean');

const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' });
const dirty = status
  .split('\n')
  .filter(Boolean)
  .map((line: string) => {
    const body = line.slice(3);
    const arrow = body.indexOf(' -> ');
    return (arrow >= 0 ? body.slice(arrow + 4) : body).trim();
  })
  .filter((path: string) => path !== 'README.md');
if (dirty.length) fail(`G4 tracked drift besides README.md: ${dirty.join(', ')}`);
else pass(`G4 no tracked drift besides README.md${status.trim() ? ' (README.md changed)' : ''}`);

const delta = await liveDelta(new Map(categories.map((c) => [c.slug, c.count])), listingSum);
console.log(`gate:deploy ${delta}`);
console.log(`gate:deploy discrimination base (not consulted): ${BASE}`);

if (fails.length) {
  console.error(`gate:deploy RESULT=FAIL failed_checks=${fails.length}`);
  process.exit(1);
}
console.log('gate:deploy RESULT=PASS');
