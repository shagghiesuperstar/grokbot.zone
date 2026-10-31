// Bundles src/worker/index.ts into public/_worker.js/index.js, the entry wrangler.toml deploys.
// Runtime modules provided by Workers (cloudflare:*, node:*) stay external.
import { build } from 'esbuild';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
await build({
  entryPoints: [join(ROOT, 'src/worker/index.ts')],
  outfile: join(ROOT, 'public/_worker.js/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  conditions: ['workerd', 'worker', 'browser'],
  external: ['cloudflare:*', 'node:*'],
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('build-worker: public/_worker.js/index.js');
