// D19: learn per-category token weights from the labelled corpus and write a small JSON the Worker
// uses to file a newly found bot under a category (argmax over name + description tokens).
// Reads data/corpus directly (not src/data/bots.json), so bots added later never train it.
// Usage: tsx scripts/build-classifier.ts
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tokenize } from '../src/worker/dp/classify';

const ROOT = resolve(import.meta.dirname, '..');
const dir = join(ROOT, 'data/corpus');
const slugs: string[] = (JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).categories as { slug: string }[]).map((c) => c.slug);
interface Doc { toks: Set<string>; c: number }
const docs: Doc[] = [];
slugs.forEach((slug, c) => {
  const p = JSON.parse(readFileSync(join(dir, `${slug}.json`), 'utf8'));
  for (const b of p.bots as { name: string; description: string }[]) docs.push({ toks: new Set(tokenize(`${b.name} ${b.description}`)), c });
});

const VOCAB = Number(process.env.VOCAB ?? 1400);
const C = slugs.length;
// Deterministic 80/20 split by index, to report an honest hold-out figure.
const train = docs.filter((_, i) => i % 5 !== 0);
const test = docs.filter((_, i) => i % 5 === 0);

function fit(set: Doc[]) {
  const N = set.length;
  const nc = new Array(C).fill(0);
  const df = new Map<string, number>();
  const dfc = new Map<string, number[]>();
  for (const d of set) {
    nc[d.c]++;
    for (const t of d.toks) {
      df.set(t, (df.get(t) ?? 0) + 1);
      let a = dfc.get(t);
      if (!a) dfc.set(t, (a = new Array(C).fill(0)));
      a[d.c]++;
    }
  }
  const cand: { t: string; best: number; w: number[] }[] = [];
  for (const [t, n] of df) {
    if (n < 5 || n > N * 0.25) continue;
    const a = dfc.get(t)!;
    const w = a.map((k, c) => Math.log(((k + 0.5) / (nc[c] + 1)) / ((n - k + 0.5) / (N - nc[c] + 1))));
    let best = 0;
    a.forEach((k, c) => { best = Math.max(best, k * w[c]); });
    cand.push({ t, best, w });
  }
  cand.sort((x, y) => y.best - x.best || (x.t < y.t ? -1 : 1));
  const tokens: Record<string, number[]> = {};
  for (const { t, w } of cand.slice(0, VOCAB)) {
    const top = w.map((v, c) => [c, v] as const).filter(([, v]) => v > 0.8).sort((p, q) => q[1] - p[1]).slice(0, 2);
    if (top.length) tokens[t] = top.flatMap(([c, v]) => [c, Math.round(v * 4)]);
  }
  return tokens;
}

function scoreDoc(tokens: Record<string, number[]>, d: Doc) {
  const s = new Array(C).fill(0);
  for (const t of d.toks) { const e = tokens[t]; if (e) for (let i = 0; i < e.length; i += 2) s[e[i]] += e[i + 1]; }
  let b = 0, sec = 0, bc = -1;
  s.forEach((v, c) => { if (v > b) { sec = b; b = v; bc = c; } else if (v > sec) sec = v; });
  return { bc, b, margin: b - sec };
}

// Tune the acceptance rule on the hold-out: the loosest rule that keeps precision >= 0.65.
const trial = fit(train);
let min = 8, margin = 4, cov = 0, prec = 0;
for (const mi of [4, 6, 8, 10, 12, 16, 20, 24]) for (const mg of [0, 2, 4, 6, 8, 10, 12, 16]) {
  let acc = 0, ok = 0;
  for (const d of test) { const r = scoreDoc(trial, d); if (r.bc >= 0 && r.b >= mi && r.margin >= mg) { acc++; if (r.bc === d.c) ok++; } }
  const p = acc ? ok / acc : 0, cv = acc / test.length;
  if (p >= 0.65 && cv > cov) { cov = cv; prec = p; min = mi; margin = mg; }
}
const tokens = fit(docs);
const out = { v: 1, cats: slugs, min, margin, tokens };
const file = join(ROOT, 'src/data/classifier.json');
writeFileSync(file, JSON.stringify(out) + '\n');
const bytes = statSync(file).size;
console.log(`build-classifier: ${Object.keys(tokens).length} tokens, ${bytes} bytes, hold-out coverage ${(cov * 100).toFixed(1)}% precision ${(prec * 100).toFixed(1)}% (min ${min}, margin ${margin})`);
if (bytes >= 60 * 1024) { console.error('build-classifier: FAIL classifier is 60 KB or larger'); process.exit(1); }
