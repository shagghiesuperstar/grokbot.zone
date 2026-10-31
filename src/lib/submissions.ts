// Pure helpers shared by the Worker and the unit tests (scripts/test-submissions.ts).
// Nothing here touches the network, the database or the clock.

export const BOT_LINK_RE = /^https:\/\/x\.ai\/bot\/([A-Za-z0-9_-]{4,64})$/i;
// Global scan used on email bodies; same code charset and length as BOT_LINK_RE.
export const BOT_LINK_SCAN = /https:\/\/x\.ai\/bot\/([A-Za-z0-9_-]{4,64})(?![A-Za-z0-9_-])/gi;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SubmissionInput {
  name?: unknown; author?: unknown; description?: unknown; link?: unknown;
  category?: unknown; email?: unknown; company_website?: unknown; filled_ms?: unknown;
}
export interface ValidSubmission {
  name: string; author: string | null; description: string; link: string; code: string;
  category: string; email: string;
}
export type Validation = { ok: true; value: ValidSubmission } | { ok: false; errors: Record<string, string> };

/** Every control character (C0, DEL, C1) plus the Unicode line and paragraph separators. */
const CONTROL_RUN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
/** One line: each run of control characters (CR, LF, tab, NUL...) becomes a single space, then the ends are trimmed. */
export const singleLine = (s: string) => s.replace(CONTROL_RUN, ' ').trim();

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
/** Free text that ends up in a mail body: collapsed to one line before any length rule is applied. */
const line = (v: unknown) => (typeof v === 'string' ? singleLine(v) : undefined);

export function isEmail(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);
}

/** The honeypot must be absent or an empty string. */
export function honeypotOk(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

export function fillTimeOk(v: unknown, minMs: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= minMs;
}

/** Lowercased link (the dedupe key) and the code with its original letter case. */
export function parseBotLink(link: string): { link: string; code: string } | null {
  const m = BOT_LINK_RE.exec(link);
  return m ? { link: `https://x.ai/bot/${m[1].toLowerCase()}`, code: m[1] } : null;
}

export function validateSubmission(body: unknown, categorySlugs: ReadonlySet<string>, minFillMs: number): Validation {
  const b = (body && typeof body === 'object' ? body : {}) as SubmissionInput;
  const errors: Record<string, string> = {};
  const name = line(b.name);
  if (!name || name.length < 3 || name.length > 120) errors.name = 'required, 3-120 characters';
  const author = b.author === undefined || b.author === null || b.author === '' ? null : line(b.author);
  if (author !== null && (author === undefined || author.length > 80)) errors.author = 'at most 80 characters';
  const description = line(b.description);
  if (!description || description.length < 10 || description.length > 500) errors.description = 'required, 10-500 characters';
  const linkRaw = str(b.link);
  const parsed = linkRaw ? parseBotLink(linkRaw) : null;
  if (!parsed) errors.link = 'must look like https://x.ai/bot/<code>';
  const category = str(b.category);
  if (!category || !categorySlugs.has(category)) errors.category = 'must be one of the listed categories';
  if (!isEmail(b.email)) errors.email = 'required, a valid email address';
  if (!honeypotOk(b.company_website)) errors.company_website = 'must be empty';
  if (!fillTimeOk(b.filled_ms, minFillMs)) errors.filled_ms = 'too fast';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: name!, author: author as string | null, description: description!, link: parsed!.link, code: parsed!.code,
      category: category!, email: (b.email as string).toLowerCase(),
    },
  };
}

/** 32 lowercase hex characters from 16 random bytes. */
export function makeToken(rand: (a: Uint8Array) => Uint8Array = (a) => crypto.getRandomValues(a)): string {
  return [...rand(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export const TOKEN_RE = /^[0-9a-f]{32}$/;

/** Distinct bot codes found in free text, first-seen order and original letter case (distinct by lowercase). */
export function extractCodes(...texts: (string | undefined | null)[]): string[] {
  const seen = new Map<string, string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(BOT_LINK_SCAN)) if (!seen.has(m[1].toLowerCase())) seen.set(m[1].toLowerCase(), m[1]);
  }
  return [...seen.values()];
}

/** How many digest sends one run may make. */
export function digestRecipientCount(active: number, cap: number): number {
  return Math.max(0, Math.min(active, Number.isFinite(cap) ? cap : 0));
}

export const isOn = (v: unknown) => v === '1';

/** First non-empty line of a body that is not just a bot link, capped at 500 characters. */
export function firstDescriptionLine(text: string | undefined | null): string {
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const text = singleLine(raw.replace(BOT_LINK_SCAN, '').replace(/\s+/g, ' '));
    if (text.length >= 3 && !text.startsWith('>')) return text.slice(0, 500);
  }
  return '(no description supplied)';
}

/** Header-safe single line. */
export const oneLine = singleLine;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const htmlNote = (text: string) => `<p>${esc(text).replace(/\n/g, '<br>')}</p>`;

export const SITE = 'https://grokbot.zone';
export const approveSql = (id: number) =>
  `wrangler d1 execute grokbot-zone --remote --command "UPDATE submissions SET status='approved' WHERE id=${id}"`;

export function ackText(name: string, link: string): string {
  return `Hi — we got "${name}" (${link}).\nIt is queued for review. If it is approved it appears with the next refresh;\nthe list updates twice a week, Monday and Thursday.\n— GrokBot Zone · ${SITE}/trending/`;
}

/**
 * The owner mail. The approve: command goes first and every submitted field is collapsed to one line
 * under an "untrusted" heading, so submitted text can never add a second approve: line.
 */
export function ownerSummary(r: { id: number; name: string; author: string | null; category: string | null; link: string; submitter: string; ip: string; description: string; source: string }) {
  const f = (label: string, v: string | null) => `${label}: ${v === null ? '—' : singleLine(v)}`;
  return {
    subject: oneLine(`[GZ] new submission #${r.id} — ${r.name} (${r.source})`),
    text: [
      `approve:  ${approveSql(r.id)}`,
      '',
      'Submitted fields (untrusted):',
      f('name', r.name), f('author', r.author), f('category', r.category), f('link', r.link),
      f('submitter', r.submitter), f('ip', r.ip), f('source', r.source), f('description', r.description),
    ].join('\n'),
  };
}

export const confirmText = (token: string) =>
  `Confirm: ${SITE}/subscribe/confirm?t=${token}\nYou'll get an update email Monday and Thursday. Nothing happens until you confirm.`;

export interface DigestPayload { asOf: string; totalBots: number; categoryCount: number; top: { id: string; name: string; description: string }[] }
const firstSentence = (s: string) => (/^.*?[.!?](?=\s|$)/.exec(s)?.[0] ?? s).slice(0, 200);

export function digestMail(p: DigestPayload, weekday: 'Monday' | 'Thursday', unsubToken: string) {
  const unsub = `${SITE}/subscribe/unsubscribe?t=${unsubToken}`;
  const lines = p.top.slice(0, 10).map((b, i) => `${i + 1}. ${b.name} — ${firstSentence(b.description)} → ${SITE}/bots/${b.id}/`);
  const head = `${p.asOf} — ${p.totalBots} bots in ${p.categoryCount} categories.`;
  return {
    subject: `GrokBot Zone: ${p.totalBots} bots tracked + the ${weekday} top 10`,
    text: `${head}\n${lines.join('\n')}\nUnsubscribe: ${unsub}`,
    html: `<p>${esc(head)}</p><table>${p.top.slice(0, 10).map((b, i) => `<tr><td>${i + 1}.</td><td><a href="${SITE}/bots/${esc(b.id)}/">${esc(b.name)}</a> — ${esc(firstSentence(b.description))}</td></tr>`).join('')}</table><p><a href="${unsub}">Unsubscribe</a></p>`,
    headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/.{1,76}/g, '$&\r\n').trimEnd();
};
const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** A minimal RFC 5322 reply for message.reply(): threaded, UTF-8 safe, no MIME library needed. */
export function rawReply(r: { from: string; to: string; subject: string; text: string; inReplyTo?: string | null; now?: Date; id?: string }): string {
  const subject = oneLine(r.subject);
  const domain = r.from.split('@')[1] ?? 'grokbot.zone';
  const h = [
    `From: <${r.from}>`,
    `To: <${r.to}>`,
    `Subject: ${ascii(subject) ? subject : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(subject)))}?=`}`,
    `Date: ${(r.now ?? new Date()).toUTCString()}`,
    `Message-ID: <${r.id ?? makeToken()}@${domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-replied',
  ];
  if (r.inReplyTo) h.push(`In-Reply-To: ${oneLine(r.inReplyTo)}`, `References: ${oneLine(r.inReplyTo)}`);
  const body = r.text.replace(/\r?\n/g, '\r\n');
  if (ascii(body.replace(/\r\n/g, ''))) h.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 7bit', '', body);
  else h.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(body));
  return h.join('\r\n') + '\r\n';
}
