// Build guard: dist/ must not contain an email-shaped string, except on the pages that show
// our own mailbox (flags.email-gated mailto: links). Fails the build otherwise.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { EMAIL_RE } from '../src/lib/strip-emails';

const DIST = resolve(import.meta.dirname, '../dist');
const ALLOW = new Set(['submit/index.html', 'api/index.html']);
const TEXT = /\.(html|json|xml|txt|css|js|mjs|svg|webmanifest)$/;
// Bundled code (the Worker, hashed assets) contains address-shaped literals in library code.
const SKIP = (rel: string) => rel.startsWith('_worker.js') || rel.startsWith('_astro/');

const bad: string[] = [];
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    const rel = relative(DIST, p);
    if (!TEXT.test(n) || SKIP(rel) || ALLOW.has(rel)) continue;
    const hits = readFileSync(p, 'utf8').match(EMAIL_RE);
    if (hits) bad.push(`${rel}: ${[...new Set(hits)].slice(0, 3).join(', ')}`);
  }
};
walk(DIST);
if (bad.length) {
  for (const b of bad.slice(0, 30)) console.error(`assert-no-emails: FAIL ${b}`);
  console.error(`assert-no-emails: ${bad.length} file(s) contain an email address`);
  process.exit(1);
}
console.log('assert-no-emails: dist/ clean');
