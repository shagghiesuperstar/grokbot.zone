// Worst-case backdrop behind the glass, measured from the SHIPPED 1088 loop. Writes scripts/glass-backdrop.json.
//   1. a frame every 0.25 s;
//   2. each frame scaled to its largest on-screen size: cover at 1440x900, times the 1.5 zoom;
//   3. Gaussian blur, sigma = the blur px of --glass-filter (then saturate, as the filter chain does);
//   4. the brightest pixel (WCAG relative luminance) inside the 1440x900 viewport.
// The brightness() factor b and the tint are applied later by contrast.ts, so tuning them needs no re-measure:
// brightness scales every channel equally, which never changes which pixel is brightest.
// Usage: pnpm tsx scripts/measure-glass-backdrop.ts   (needs ffmpeg)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const VIDEO = 'public/media/hero-loop-v1-1088.mp4';
const [VW, VH] = [1440, 900], ZOOM = 1.5, STEP = 0.25, SRC = [1088, 1920];
const tokens = readFileSync(join(ROOT, 'src/styles/tokens.css'), 'utf8');
const f = tokens.match(/--glass-filter:\s*blur\(([\d.]+)px\)\s*saturate\(([\d.]+)\)/)!;
const sigma = Number(f[1]), sat = Number(f[2]);

const cover = Math.max(VW / SRC[0], VH / SRC[1]);
const W = Math.round(SRC[0] * cover * ZOOM), H = Math.round(SRC[1] * cover * ZOOM);
const pad = Math.ceil(sigma * 3); // blur margin so the viewport edge is not biased by the crop
const ox = Math.round((W - VW) / 2), oy = Math.round((H - VH) / 2);
const vf = [
  `fps=${1 / STEP}`, `scale=${W}:${H}:flags=bicubic`,
  `crop=${VW + 2 * pad}:${VH + 2 * pad}:${ox - pad}:${oy - pad}`,
  'format=gbrp', `gblur=sigma=${sigma}:steps=4`, `crop=${VW}:${VH}:${pad}:${pad}`, 'format=rgb24',
].join(',');
const r = spawnSync('ffmpeg', ['-v', 'error', '-i', join(ROOT, VIDEO), '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
if (r.status !== 0) throw new Error(String(r.stderr));
const frameBytes = VW * VH * 3, frames = r.stdout.length / frameBytes;
if (!Number.isInteger(frames)) throw new Error('unexpected raw size');

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
// CSS saturate() matrix (Filter Effects 1), on sRGB-encoded values.
const m = [
  [0.213 + 0.787 * sat, 0.715 - 0.715 * sat, 0.072 - 0.072 * sat],
  [0.213 - 0.213 * sat, 0.715 + 0.285 * sat, 0.072 - 0.072 * sat],
  [0.213 - 0.213 * sat, 0.715 - 0.715 * sat, 0.072 + 0.928 * sat],
];
let best = { lum: -1, rgb: [0, 0, 0], t: 0, x: 0, y: 0 };
for (let k = 0; k < frames; k++) {
  const base = k * frameBytes;
  for (let i = 0; i < VW * VH; i++) {
    const o = base + i * 3, a = r.stdout[o] / 255, b = r.stdout[o + 1] / 255, c = r.stdout[o + 2] / 255;
    if (Math.max(a, b, c) * 255 < 24) continue; // cannot beat a bright pixel; skips the black field fast
    const p = m.map((row) => Math.min(1, Math.max(0, row[0] * a + row[1] * b + row[2] * c)));
    const L = 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
    if (L > best.lum) best = { lum: L, rgb: p.map((v) => Math.round(v * 255 * 100) / 100), t: k * STEP, x: i % VW, y: Math.floor(i / VW) };
  }
}
const out = {
  video: VIDEO, sha256: createHash('sha256').update(readFileSync(join(ROOT, VIDEO))).digest('hex'),
  viewport: [VW, VH], zoom: ZOOM, sampleEverySec: STEP, frames, blurPx: sigma, saturate: sat,
  worstBeforeBrightness: { rgb: best.rgb, luminance: Number(best.lum.toFixed(5)), atSec: best.t, atPx: [best.x, best.y] },
};
writeFileSync(join(ROOT, 'scripts/glass-backdrop.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`measured ${frames} frames at ${W}x${H}, sigma ${sigma}px, saturate ${sat}`);
console.log('worst backdrop before brightness():', JSON.stringify(out.worstBeforeBrightness));
