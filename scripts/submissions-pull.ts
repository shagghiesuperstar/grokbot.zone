// Owner tool: reads approved submissions from D1 into data/submissions/approved.json.
// Approval itself is one SQL line per bot (it is printed verbatim in the owner summary email).
// Usage: pnpm submissions:pull
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const sql = "SELECT id, created_at, source, name, author, description, code, link, category FROM submissions WHERE status='approved' ORDER BY id";
const out = execFileSync('npx', ['--yes', 'wrangler@4.123.0', 'd1', 'execute', 'grokbot-zone', '--remote', '--json', '--command', sql], { cwd: ROOT, encoding: 'utf8' });
const rows = JSON.parse(out)[0]?.results ?? [];
mkdirSync(join(ROOT, 'data/submissions'), { recursive: true });
writeFileSync(join(ROOT, 'data/submissions/approved.json'), JSON.stringify(rows, null, 1) + '\n');
console.log(`submissions-pull: ${rows.length} approved submissions -> data/submissions/approved.json`);
