// D24: the daily snapshot of what the data plane changed since the seed (data/live/changes.json),
// read by the static build. The build merges seed + added - dead; a missing file means no changes.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripEmails } from '../src/lib/strip-emails';

const ROOT = resolve(import.meta.dirname, '..');
export interface LiveAdded { id: string; slug: string; code: string; name: string; author: string; description: string; cat: string; cats: string[] }

/** Added bots that have a known category and a well-formed code, plus the lowercased codes of dead bots. */
export function readLive(knownCategories: Set<string>, file = join(ROOT, 'data/live/changes.json')): { added: LiveAdded[]; dead: Set<string> } {
  if (!existsSync(file)) return { added: [], dead: new Set() };
  const ch = JSON.parse(readFileSync(file, 'utf8')) as { added?: Record<string, unknown>[]; dead?: unknown[] };
  if (!Array.isArray(ch.added) || !Array.isArray(ch.dead)) throw new Error(`${file}: expected "added" and "dead" arrays`);
  const added: LiveAdded[] = [];
  const seen = new Set<string>();
  for (const a of ch.added) {
    const code = String(a.code ?? '');
    const cat = typeof a.category === 'string' ? a.category : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code) || !knownCategories.has(cat) || seen.has(code.toLowerCase())) continue; // no category = no static page
    const name = stripEmails(String(a.name ?? '')).trim();
    const description = stripEmails(String(a.description ?? '')).trim();
    if (!name || !description) continue;
    seen.add(code.toLowerCase());
    const id = `${cat}-${code}`;
    added.push({ id, slug: id, code, name, author: stripEmails(String(a.author ?? '')).trim(), description, cat, cats: [cat] });
  }
  return { added, dead: new Set(ch.dead.map((c) => String(c).toLowerCase())) };
}

/** The build rule "seed + added - dead" (build-data.ts): an added bot also dead in the same snapshot is not built. */
export function splitLiveAdded(live: { added: LiveAdded[]; dead: Set<string> }): { expected: LiveAdded[]; deadExcluded: LiveAdded[] } {
  const expected: LiveAdded[] = [];
  const deadExcluded: LiveAdded[] = [];
  for (const a of live.added) (live.dead.has(a.code.toLowerCase()) ? deadExcluded : expected).push(a);
  return { expected, deadExcluded };
}
