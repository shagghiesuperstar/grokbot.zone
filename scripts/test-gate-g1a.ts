// Regression: gate:deploy G1a must follow the build rule "seed + added - dead" (build-data.ts).
// An id in both `added` and `dead` is intentionally absent from bots.json, so it must not count as missing.
// Runs the real gate against changes.json-shaped fixtures (GATE_LIVE). Run after `pnpm build` for a full check;
// the other checks (G1, G1b, G2..G4) are compared against a control run so the result does not depend on build state.
// Usage: pnpm test:gate
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readLive, splitLiveAdded } from './lib-live';

const ROOT = resolve(import.meta.dirname, '..');
const categories = JSON.parse(readFileSync(join(ROOT, 'src/data/categories.json'), 'utf8')) as { slug: string }[];
const known = new Set(categories.map((c) => c.slug));
const cat = categories[0].slug;
const CODE = 'ZzGateG1aOverlapTest1'; // 21 chars, mixed case: dead matching must be case-insensitive
assert.equal(CODE.length, 21);
const entry = { code: CODE, category: cat, name: 'Gate G1a overlap fixture', author: 'fixture', description: 'Fixture bot present in added and dead.' };

const dir = mkdtempSync(join(tmpdir(), 'gate-g1a-'));
const fixture = (name: string, body: { added: unknown[]; dead: string[] }) => {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(body));
  return file;
};

// ---- unit: splitLiveAdded uses readLive's lowercased dead set ----
{
  const live = readLive(known, fixture('unit', { added: [entry], dead: [CODE.toLowerCase()] }));
  const { expected, deadExcluded } = splitLiveAdded(live);
  assert.equal(expected.length, 0);
  assert.deepEqual(deadExcluded.map((a) => a.code), [CODE]);
  const alive = splitLiveAdded(readLive(known, fixture('unit-alive', { added: [entry], dead: [] })));
  assert.equal(alive.expected.length, 1);
  assert.equal(alive.deadExcluded.length, 0);
}

// ---- integration: the real gate on fixtures ----
function gate(file: string) {
  const r = spawnSync(join(ROOT, 'node_modules/.bin/tsx'), ['scripts/verify-deploy-artifact.ts'], {
    cwd: ROOT,
    env: { ...process.env, GATE_LIVE: file },
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(r.error, undefined, String(r.error));
  const out = `${r.stdout}\n${r.stderr}`;
  const status = new Map<string, string>(); // check label -> PASS|FAIL
  for (const m of out.matchAll(/^gate:deploy (PASS|FAIL) (\S+)/gm)) status.set(m[2], m[1]);
  return { out, status };
}

const control = gate(fixture('control', { added: [], dead: [] }));
const overlap = gate(fixture('overlap', { added: [entry], dead: [CODE.toLowerCase()] }));
const alive = gate(fixture('alive', { added: [entry], dead: [] }));

assert.equal(control.status.get('G1a'), 'PASS', control.out);

// added AND dead: G1a passes, says so, and no other check changes versus the control.
assert.equal(overlap.status.get('G1a'), 'PASS', overlap.out);
assert.match(overlap.out, /INFO 1 accepted live-added ids also marked dead this snapshot, excluded from G1a/);
assert.deepEqual([...overlap.status].filter(([k]) => k !== 'G1a'), [...control.status].filter(([k]) => k !== 'G1a'), 'overlap fixture changed a non-G1a check');

// added and NOT dead, absent from bots.json: G1a still fails (the gate keeps its teeth).
assert.equal(alive.status.get('G1a'), 'FAIL', alive.out);
assert.ok(alive.out.includes(`${cat}-${CODE}`), 'failing G1a names the missing id');
assert.deepEqual([...alive.status].filter(([k]) => k !== 'G1a'), [...control.status].filter(([k]) => k !== 'G1a'), 'alive fixture changed a non-G1a check');

console.log(`test-gate-g1a OK: checks=${[...control.status.keys()].join(',')}`);
