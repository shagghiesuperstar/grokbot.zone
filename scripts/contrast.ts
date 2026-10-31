// WCAG 2.x contrast for every foreground/background pair the site uses.
// Alpha colours are composited onto their real background first. Exits 1 if any pair < 4.5.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const css = readFileSync(join(resolve(import.meta.dirname, '..'), 'src/styles/tokens.css'), 'utf8');
type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const token = (n: string) => css.match(new RegExp(`--${n}:\\s*(#[0-9a-fA-F]{6})`))![1];
const mix = (fg: RGB, a: number, bg: RGB): RGB => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a))) as RGB;
const lum = ([r, g, b]: RGB) => {
  const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const C = Object.fromEntries(['olo', 'ink-black', 'canvas', 'panel', 'fuchsia', 'pink', 'crimson', 'aqua'].map((n) => [n, hex(token(n))]));
const white: RGB = [255, 255, 255];
const mutedA = Number(css.match(/--text-muted:\s*rgb\(255 255 255 \/ ([0-9.]+)\)/)![1]);
const muted = (bg: RGB) => mix(white, mutedA, bg);

const pairs: [string, RGB, RGB][] = [
  ['body text on canvas', white, C.canvas],
  ['body text on panel', white, C.panel],
  [`muted text (${mutedA * 100}% white) on canvas`, muted(C.canvas), C.canvas],
  [`muted text on panel`, muted(C.panel), C.panel],
  ['OLO links/labels on canvas', C.olo, C.canvas],
  ['OLO on panel', C.olo, C.panel],
  ['ink-black label on OLO fill (buttons)', C['ink-black'], C.olo],
  ['hot fuchsia (author lines) on canvas', C.fuchsia, C.canvas],
  ['hot fuchsia on panel', C.fuchsia, C.panel],
  ['neon pink on canvas', C.pink, C.canvas],
  ['neon pink on panel', C.pink, C.panel],
  ['crimson (errors) on canvas', C.crimson, C.canvas],
  ['crimson on panel', C.crimson, C.panel],
];
// ---- On glass, worst case. The backdrop is the brightest pixel of the shipped 1088 loop after cover at 1440x900,
// the 1.5 zoom, blur and saturate (scripts/measure-glass-backdrop.ts). Then brightness(b), then the tint over it.
const glass = JSON.parse(readFileSync(join(resolve(import.meta.dirname, '..'), 'scripts/glass-backdrop.json'), 'utf8'));
const tint = css.match(/--glass-tint:\s*rgb\((\d+) (\d+) (\d+) \/ ([0-9.]+)\)/)!;
const filt = css.match(/--glass-filter:\s*blur\(([\d.]+)px\)\s*saturate\(([\d.]+)\)\s*brightness\(([\d.]+)\)/)!;
const [tintRgb, tintA, blurPx, satur, bright] = [[1, 2, 3].map((i) => Number(tint[i])) as RGB, Number(tint[4]), Number(filt[1]), Number(filt[2]), Number(filt[3])];
const videoSha = createHash('sha256').update(readFileSync(join(resolve(import.meta.dirname, '..'), glass.video))).digest('hex');
if (glass.sha256 !== videoSha || glass.blurPx !== blurPx || glass.saturate !== satur) {
  console.log('FAIL  glass-backdrop.json is stale (video, blur or saturate changed): run `pnpm tsx scripts/measure-glass-backdrop.ts`');
  process.exit(1);
}
const behind = (glass.worstBeforeBrightness.rgb as RGB).map((c) => c * bright) as RGB;
const onGlass: RGB = mix(tintRgb, tintA, behind);
console.log(`glass: a=${tintA} b=${bright} blur=${blurPx}px; worst backdrop ${JSON.stringify(glass.worstBeforeBrightness.rgb)} -> x b -> ${JSON.stringify(behind.map(Math.round))} -> under tint ${JSON.stringify(onGlass)}`);
pairs.push(
  ['on glass, worst case: body text (white)', white, onGlass],
  [`on glass, worst case: muted text (${mutedA * 100}% white)`, muted(onGlass), onGlass],
  ['on glass, worst case: OLO links/labels', C.olo, onGlass],
  ['on glass, worst case: hot fuchsia (author lines)', C.fuchsia, onGlass],
  ['on glass, worst case: neon pink', C.pink, onGlass],
  ['on glass, worst case: crimson (errors)', C.crimson, onGlass],
);

let bad = 0;
for (const [name, fg, bg] of pairs) {
  const r = ratio(fg, bg);
  if (r < 4.5) bad++;
  console.log(`${r >= 4.5 ? 'PASS' : 'FAIL'}  ${r.toFixed(2).padStart(5)}:1  ${name}`);
}
console.log(bad ? `${bad} pair(s) below 4.5:1` : 'all pairs >= 4.5:1');
process.exit(bad ? 1 : 0);
