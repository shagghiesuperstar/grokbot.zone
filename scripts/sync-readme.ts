// Writes the published counts into README.md from the generated data, so the numbers quoted
// in the README can never drift away from the dataset they describe.
// Usage: tsx scripts/sync-readme.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const readJson = (f: string) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
const fmt = (n: number) => n.toLocaleString('en-US');

const meta = readJson('src/data/meta.json');
const corpus = readJson('data/corpus/index.json');

// Each block is generated: the prose quotes the numbers, it never hardcodes them.
const blocks: [string, string][] = [
  [
    'counts',
    '- ' +
      `${fmt(meta.totalBots)} distinct bots published from a raw corpus snapshot of ${fmt(corpus.rawTotalBots)} listings, ` +
      `in ${meta.categoryCount} function categories, as of ${meta.asOf} (see \`data/corpus/index.json\`).`,
  ],
  [
    'layers',
    `- \`data/corpus/index.json\` \`rawTotalBots\` (${fmt(corpus.rawTotalBots)}) is the **raw snapshot**: listing records.\n` +
      `- \`src/data/meta.json\` \`totalBots\` (${fmt(meta.totalBots)}) is the **published** count: distinct bots.\n` +
      `- \`src/data/meta.json\` \`totalListings\` (${fmt(meta.totalListings)}) is the category listings: a bot in two\n` +
      `  categories is listed in both, so it is counted twice.`,
  ],
];

let readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
let changed = false;
for (const [name, body] of blocks) {
  const START = `<!-- ${name}:start -->`;
  const END = `<!-- ${name}:end -->`;
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < 0) throw new Error(`sync-readme: README.md is missing the ${name} markers`);
  const next = readme.slice(0, start + START.length) + '\n' + body + '\n' + readme.slice(end);
  if (next !== readme) {
    readme = next;
    changed = true;
    console.log(`sync-readme: README ${name} updated`);
  }
}
if (changed) {
  writeFileSync(join(ROOT, 'README.md'), readme);
  console.log('sync-readme: README counts updated');
} else {
  console.log('sync-readme: README counts already current');
}
