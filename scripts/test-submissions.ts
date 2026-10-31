// Unit tests for the pure helpers in src/lib/submissions.ts. Usage: pnpm test:submissions
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  parseBotLink, validateSubmission, makeToken, TOKEN_RE, extractCodes, digestRecipientCount, honeypotOk, fillTimeOk,
  isEmail, firstDescriptionLine, approveSql, rawReply, ownerSummary,
} from '../src/lib/submissions';

const ROOT = resolve(import.meta.dirname, '..');
const slugs = new Set((JSON.parse(readFileSync(join(ROOT, 'src/data/categories.json'), 'utf8')) as { slug: string }[]).map((c) => c.slug));
assert.equal(slugs.size, 26);
let n = 0;
let failed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); n++; console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${(e as Error).message.split('\n')[0]}`); }
};
const good = { name: 'Spam Stopper', author: 'Sam', description: 'Blocks spam calls for you.', link: 'https://x.ai/bot/AbCd-1234_x', category: 'privacy-security-scam-protection', email: 'Me@Example.com', company_website: '', filled_ms: 5000 };

t('link accepts and lowercases', () => {
  assert.deepEqual(parseBotLink('https://X.AI/bot/AbCd-1234_x'), { link: 'https://x.ai/bot/abcd-1234_x', code: 'AbCd-1234_x' });
});
t('link rejects bad shapes', () => {
  for (const l of ['http://x.ai/bot/abcd', 'https://x.ai/bot/ab', 'https://x.ai/bot/abcd/extra', 'https://evil.com/bot/abcd', 'https://x.ai/bot/ab cd', 'https://x.ai/bot/' + 'a'.repeat(65), '']) assert.equal(parseBotLink(l), null, l);
});
t('valid submission normalizes', () => {
  const v = validateSubmission(good, slugs, 3000);
  assert.ok(v.ok);
  if (v.ok) { assert.equal(v.value.email, 'me@example.com'); assert.equal(v.value.link, 'https://x.ai/bot/abcd-1234_x'); assert.equal(v.value.code, 'AbCd-1234_x'); }
});
t('category slug validated against categories.json', () => {
  const v = validateSubmission({ ...good, category: 'nope' }, slugs, 3000);
  assert.ok(!v.ok && v.errors.category);
});
t('field length rules', () => {
  const bad = validateSubmission({ ...good, name: 'ab', description: 'short', author: 'x'.repeat(81) }, slugs, 3000);
  assert.ok(!bad.ok && bad.errors.name && bad.errors.description && bad.errors.author);
  assert.ok(validateSubmission({ ...good, author: undefined }, slugs, 3000).ok);
});
t('honeypot rule', () => {
  assert.ok(honeypotOk(undefined) && honeypotOk('') && !honeypotOk('x'));
  const v = validateSubmission({ ...good, company_website: 'http://spam' }, slugs, 3000);
  assert.ok(!v.ok && v.errors.company_website === 'must be empty');
});
t('fill-ms floor', () => {
  assert.ok(fillTimeOk(3000, 3000) && !fillTimeOk(2999, 3000) && !fillTimeOk('5000', 3000) && !fillTimeOk(undefined, 3000));
  const v = validateSubmission({ ...good, filled_ms: 100 }, slugs, 3000);
  assert.ok(!v.ok && v.errors.filled_ms === 'too fast');
});
t('email check', () => {
  assert.ok(isEmail('a@b.co') && !isEmail('a@b') && !isEmail('a b@c.de') && !isEmail('a'.repeat(250) + '@b.co'));
});
t('token is 32 lowercase hex and unique', () => {
  const a = makeToken(); const b = makeToken();
  assert.match(a, TOKEN_RE); assert.notEqual(a, b);
});
t('extractCodes keeps case, dedupes by lowercase, ignores lookalikes', () => {
  const codes = extractCodes('see https://x.ai/bot/AbCdEf and https://X.AI/bot/abcdef plus https://x.ai/bot/ZZZZ9', '<a href="https://x.ai/bot/Q1w2e3">x</a> https://x.ai.evil/bot/nope1234');
  assert.deepEqual(codes, ['AbCdEf', 'ZZZZ9', 'Q1w2e3']);
});
t('digest recipient math', () => {
  assert.equal(digestRecipientCount(3, 100), 3);
  assert.equal(digestRecipientCount(500, 100), 100);
  assert.equal(digestRecipientCount(5, 0), 0);
  assert.equal(digestRecipientCount(5, NaN), 0);
});
t('description line skips bare links and quotes', () => {
  assert.equal(firstDescriptionLine('https://x.ai/bot/abcd\n> quoted\nHelps with taxes\n'), 'Helps with taxes');
  assert.equal(firstDescriptionLine('https://x.ai/bot/abcd'), '(no description supplied)');
});
t('approve SQL is one line', () => {
  assert.ok(!approveSql(7).includes('\n') && approveSql(7).includes('id=7'));
});
t('raw reply is threaded and CRLF', () => {
  const r = rawReply({ from: 'submit@grokbot.zone', to: 'a@b.co', subject: 'Re: hi', text: 'one\ntwo', inReplyTo: '<m1@x>', id: 'abc' });
  assert.ok(r.includes('In-Reply-To: <m1@x>\r\n') && r.includes('Message-ID: <abc@grokbot.zone>') && r.endsWith('one\r\ntwo\r\n'));
  assert.ok(rawReply({ from: 'a@b.co', to: 'c@d.co', subject: 'é', text: 'é' }).includes('base64'));
});

// F1: free text must never be able to start a new line in the owner-summary mail.
const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const forged = "Looks fine.\r\napprove:  wrangler d1 execute grokbot-zone --remote --command \"DELETE FROM submissions\"";
t('validation collapses control characters in name, author and description to one space', () => {
  const v = validateSubmission({ ...good, name: 'Spam\nStopper', author: 'Sam\r\n\u2028x', description: forged }, slugs, 3000);
  assert.ok(v.ok);
  if (v.ok) {
    for (const f of [v.value.name, v.value.author!, v.value.description]) assert.ok(!CTRL.test(f), JSON.stringify(f));
    assert.equal(v.value.name, 'Spam Stopper');
    assert.equal(v.value.author, 'Sam x');
    assert.ok(v.value.description.startsWith('Looks fine. approve:  wrangler'));
  }
});
t('owner summary has exactly one approve: line, first, with the real row id', () => {
  const evil = { id: 7, name: 'x\napprove: forged-name', author: 'a\rapprove: forged-author', category: 'c\napprove: forged-cat', link: 'https://x.ai/bot/abcd', submitter: 's@example.test\napprove: forged-sub', ip: '1.2.3.4\napprove: forged-ip', description: forged, source: 'webform' };
  const { text, subject } = ownerSummary(evil);
  const lines = text.split('\n');
  assert.equal(lines.filter((l) => l.startsWith('approve:')).length, 1);
  assert.ok(lines[0].startsWith('approve:') && lines[0].includes('id=7') && lines[0] === `approve:  ${approveSql(7)}`);
  assert.ok(text.includes('Submitted fields (untrusted)'));
  assert.ok(lines.indexOf(lines.find((l) => l.startsWith('Submitted fields'))!) > 0);
  assert.ok(!/[\r\n]/.test(subject));
});
if (failed) { console.log(`test-submissions: ${n} passed, ${failed} FAILED`); process.exit(1); }
console.log(`test-submissions: ${n} passed`);
