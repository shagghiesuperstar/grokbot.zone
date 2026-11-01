// D12/section 3: write an idempotent INSERT OR IGNORE seed from src/data/bots.json and apply it to D1.
// Seed bots are live, first seen 2026-10-30. Re-running changes nothing (existing rows are ignored).
// Usage: tsx scripts/seed-d1.ts --remote | --local | --dry   (--dry writes the file and prints its path)
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripEmails } from '../src/lib/strip-emails';

const ROOT = resolve(import.meta.dirname, '..');
const mode = process.argv[2] ?? '--dry';
if (!['--remote', '--local', '--dry'].includes(mode)) { console.error('usage: seed-d1.ts --remote | --local | --dry'); process.exit(2); }
const FIRST_SEEN = '2026-10-30';
const bots = JSON.parse(readFileSync(join(ROOT, 'src/data/bots.json'), 'utf8')) as { code: string; name: string; author: string; description: string; cat: string; cats: string[] }[];

const q = (s: string | null) => (s === null ? 'NULL' : `'${s.replace(/\0/g, '').replace(/'/g, "''")}'`);
const rowSql = (b: (typeof bots)[number]) =>
  `(${[b.code.toLowerCase(), b.code, stripEmails(b.name), stripEmails(b.author), stripEmails(b.description), b.cat, b.cats.join(','), 'seed', 'live', FIRST_SEEN].map(q).join(', ')})`;

const head = 'INSERT OR IGNORE INTO bots (code_lc, code, name, author, description, category, cats, source, status, first_seen) VALUES\n';
const stmts: string[] = [];
let cur: string[] = [], size = 0;
for (const b of bots) {
  const r = rowSql(b);
  if (cur.length && size + r.length > 60_000) { stmts.push(head + cur.join(',\n') + ';'); cur = []; size = 0; }
  cur.push(r); size += r.length + 2;
}
if (cur.length) stmts.push(head + cur.join(',\n') + ';');

const dir = mkdtempSync(join(tmpdir(), 'gz-seed-'));
const file = join(dir, 'seed.sql');
writeFileSync(file, stmts.join('\n') + '\n');
console.log(`seed-d1: ${bots.length} bots in ${stmts.length} statements -> ${file}`);
if (mode === '--dry') process.exit(0);
const r = spawnSync('npx', ['--yes', 'wrangler@4.123.0', 'd1', 'execute', 'grokbot-zone', mode, '--yes', '--file', file], { stdio: 'inherit', cwd: ROOT });
process.exit(r.status ?? 1);
