// Drops excluded bots (data/excluded-bots.json: ids like "<category>-<code>") from a changes.json snapshot.
// Usage: node scripts/exclude-listed-bots.mjs <changes.json>
// Removed objects are cut out of the raw text (comma-aware) so the rest of the file is never reformatted.
// Prints counts only, never entry fields.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

let ids;
try {
  ids = JSON.parse(readFileSync(join(ROOT, 'data/excluded-bots.json'), 'utf8'));
} catch {
  process.exit(2);
}
if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) process.exit(2);
const excluded = new Set(ids);

const file = process.argv[2];
if (!file) process.exit(2);
const text = readFileSync(file, 'utf8');
const doc = JSON.parse(text);
if (!Array.isArray(doc.added) || !Array.isArray(doc.dead)) {
  console.error('changes.json: added/dead arrays missing');
  process.exit(1);
}

const isExcluded = (e) => !!e && typeof e === 'object' && (excluded.has(e.id) || excluded.has(`${e.category}-${e.code}`));
const removedCount = doc.added.filter(isExcluded).length;

if (removedCount > 0) {
  // Scan the raw text for the span of each object element of the top-level "added" array.
  const spans = [];
  let depth = 0, inStr = false, esc = false, strStart = -1, lastKey = null, addedDepth = -1, objStart = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') {
        inStr = false;
        if (depth === 1) {
          let j = i + 1;
          while (/\s/.test(text[j] ?? '')) j++;
          if (text[j] === ':') lastKey = JSON.parse(text.slice(strStart, i + 1));
        }
      }
      continue;
    }
    if (ch === '"') { inStr = true; strStart = i; continue; }
    if (ch === '[' || ch === '{') {
      depth++;
      if (ch === '[' && depth === 2 && lastKey === 'added') addedDepth = 2;
      else if (ch === '{' && addedDepth === 2 && depth === 3) objStart = i;
    } else if (ch === ']' || ch === '}') {
      if (ch === '}' && addedDepth === 2 && depth === 3) spans.push([objStart, i + 1]);
      if (ch === ']' && depth === 2 && addedDepth === 2) addedDepth = -1;
      depth--;
    }
  }
  if (spans.length !== doc.added.length) { console.error('could not locate added objects'); process.exit(3); }
  let out = text;
  for (let k = spans.length - 1; k >= 0; k--) {
    if (!isExcluded(doc.added[k])) continue;
    let [s, e] = spans[k];
    let j = e;
    while (/\s/.test(out[j] ?? '')) j++;
    if (out[j] === ',') { // eat this element, its comma and the whitespace up to the next element
      j++;
      while (/\s/.test(out[j] ?? '')) j++;
      out = out.slice(0, s) + out.slice(j);
    } else { // last remaining element: eat the comma before it instead
      let p = s - 1;
      while (p >= 0 && /\s/.test(out[p])) p--;
      if (out[p] === ',') s = p;
      out = out.slice(0, s) + out.slice(e);
    }
  }
  // Safety net: the edited text must equal the filtered parse, or nothing is written.
  const check = JSON.parse(out);
  const want = { ...doc, added: doc.added.filter((e) => !isExcluded(e)) };
  if (JSON.stringify(check) !== JSON.stringify(want)) { console.error('verification failed; file left unchanged'); process.exit(3); }
  writeFileSync(file, out);
}
console.log(`removed_added=${removedCount} excluded_ids=${excluded.size}`);
