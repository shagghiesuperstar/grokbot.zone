// Renders the two subscription emails from the real templates (src/lib/submissions.ts) for the owner's review.
// Nothing is sent. The footer address is a placeholder: the real one comes from env MAIL_POSTAL_ADDRESS.
// Usage: tsx scripts/render-samples.ts <outDir>   (needs dist/digests/latest.json from `pnpm build`)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { confirmMail, digestMail, type DigestPayload } from '../src/lib/submissions';

const ROOT = resolve(import.meta.dirname, '..');
const outDir = resolve(process.argv[2] ?? join(ROOT, 'samples'));
const PLACEHOLDER = '[MAILING ADDRESS - owner to confirm]';
const payload = JSON.parse(readFileSync(join(ROOT, 'dist/digests/latest.json'), 'utf8')) as DigestPayload;
mkdirSync(outDir, { recursive: true });

const page = (title: string, m: { subject: string; html: string; headers?: Record<string, string> }) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem">` +
  `<p style="background:#f3f3f3;padding:.6rem .8rem;font-size:13px"><b>Subject:</b> ${m.subject.replace(/</g, '&lt;')}<br><b>From:</b> updates@grokbot.zone` +
  (m.headers ? `<br><b>List-Unsubscribe:</b> ${m.headers['List-Unsubscribe'].replace(/</g, '&lt;')}<br><b>List-Unsubscribe-Post:</b> ${m.headers['List-Unsubscribe-Post']}` : '') +
  `</p>${m.html}</body>`;

const confirm = confirmMail('0'.repeat(32), PLACEHOLDER);
const digest = digestMail(payload, 'Monday', '1'.repeat(32), PLACEHOLDER);
writeFileSync(join(outDir, 'confirm.html'), page('Sample: confirm email', confirm));
writeFileSync(join(outDir, 'confirm.txt'), `Subject: ${confirm.subject}\n\n${confirm.text}\n`);
writeFileSync(join(outDir, 'digest.html'), page('Sample: digest email', digest));
writeFileSync(join(outDir, 'digest.txt'), `Subject: ${digest.subject}\nList-Unsubscribe: ${digest.headers['List-Unsubscribe']}\nList-Unsubscribe-Post: ${digest.headers['List-Unsubscribe-Post']}\n\n${digest.text}\n`);
console.log(`render-samples: ${outDir} (digest data as of ${payload.asOf}, ${payload.totalBots} bots)`);
