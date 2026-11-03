// Build guard: the home hero is the background video and its poster. The grid animation stays
// unmounted. The bot-pulse Rive asset must still ship in dist/. Fails the build otherwise.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const DIST = resolve(root, 'dist');
const fail: string[] = [];

const base = readFileSync(resolve(root, 'src/layouts/Base.astro'), 'utf8');
const mount = base.match(/<div id="([^"]+)"[^>]*>\s*<video\b([^>]*)>/);
const videoId = mount?.[1] ?? '';
const poster = mount?.[2].match(/poster="\/media\/([^"]+)"/)?.[1] ?? '';
if (!videoId) fail.push('Base.astro has no background video id');
if (!poster) fail.push('Base.astro has no poster file name');

const html = readFileSync(resolve(DIST, 'index.html'), 'utf8');
if (html.includes('hero-grid.riv')) fail.push('home HTML references hero-grid.riv');
if (videoId && !html.includes(`id="${videoId}"`)) fail.push(`home HTML lacks video id ${videoId}`);
if (poster && !html.includes(poster)) fail.push(`home HTML lacks poster ${poster}`);

const pulse = resolve(DIST, 'riv', 'bot-pulse.riv');
if (!existsSync(pulse) || statSync(pulse).size === 0) fail.push('dist/riv/bot-pulse.riv missing or empty');

if (fail.length) {
  console.error(`assert-hero: ${fail.join('; ')}`);
  process.exit(1);
}
console.log(`assert-hero: home HTML has video id ${videoId} and poster ${poster}, no hero-grid.riv; bot-pulse.riv is in dist/riv`);
