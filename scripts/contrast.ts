// WCAG 2.x contrast for every foreground/background pair the site uses.
// Alpha colours are composited onto their real background first. Exits 1 if any pair < 4.5.
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
  [`muted text on aqua glow (worst hero bg)`, muted(C.aqua), C.aqua],
  ['OLO links/labels on canvas', C.olo, C.canvas],
  ['OLO on panel', C.olo, C.panel],
  ['OLO on aqua glow (hero accent)', C.olo, C.aqua],
  ['ink-black label on OLO fill (buttons)', C['ink-black'], C.olo],
  ['hot fuchsia (author lines) on canvas', C.fuchsia, C.canvas],
  ['hot fuchsia on panel', C.fuchsia, C.panel],
  ['neon pink on canvas', C.pink, C.canvas],
  ['neon pink on panel', C.pink, C.panel],
  ['crimson (errors) on canvas', C.crimson, C.canvas],
  ['crimson on panel', C.crimson, C.panel],
];
let bad = 0;
for (const [name, fg, bg] of pairs) {
  const r = ratio(fg, bg);
  if (r < 4.5) bad++;
  console.log(`${r >= 4.5 ? 'PASS' : 'FAIL'}  ${r.toFixed(2).padStart(5)}:1  ${name}`);
}
console.log(bad ? `${bad} pair(s) below 4.5:1` : 'all pairs >= 4.5:1');
process.exit(bad ? 1 : 0);
