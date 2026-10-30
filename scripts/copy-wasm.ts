// Serve the Rive runtime's WASM from our own origin (no third-party fetch at runtime).
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
const ROOT = resolve(import.meta.dirname, '..');
mkdirSync(join(ROOT, 'public/riv'), { recursive: true });
copyFileSync(join(ROOT, 'node_modules/@rive-app/canvas/rive.wasm'), join(ROOT, 'public/riv/rive.wasm'));
console.log('copy-wasm: public/riv/rive.wasm');
