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

/**
 * A1: may we send an acknowledgment to the envelope sender? Only when Cloudflare's own first
 * Authentication-Results value says spf=pass AND dkim=pass AND dmarc=pass, and the header From is exactly one
 * address and the same one as the envelope sender. Cloudflare's header does not carry smtp.mailfrom, so the
 * envelope binding comes from From == envelope plus DMARC alignment; a smtp.mailfrom that IS present must equal the envelope. Anything else (a missing or non-pass method,
 * no header, a forged second header, a From that differs from the envelope) -> false.
 */
export function ackAuthorized(authResults: string | null, envelopeFrom: string, headerFromRaw: string | null): boolean {
  const env = envelopeFrom.trim().toLowerCase();
  if (!env || !authResults) return false;
  // Headers.get() joins repeated headers with ", ". Keep only the first value (Cloudflare's; later ones may be sender-supplied):
  // cut at the first comma of the RAW string, then drop comments from that segment only. A genuine result has no comma and
  // balanced parentheses, so a comma inside a comment or an unclosed "(" can only fail closed.
  const seg = authResults.trim().split(',')[0];
  if ((seg.match(/\(/g) ?? []).length !== (seg.match(/\)/g) ?? []).length) return false;
  const first = seg.replace(/\([^)]*\)/g, ' ');
  // The authserv-id must be exactly mx.cloudflare.net, optionally followed by an RFC 8601 version integer, then ";".
  // (A bare \b would let "mx.cloudflare.net.evil.example" through, since "." is not a word character.)
  if (!/^\s*mx\.cloudflare\.net(?:\s+\d+)?\s*;/i.test(first)) return false;
  const clauses = first.split(';');
  // Cloudflare's documented header carries no smtp.mailfrom; if one is present it must name the envelope sender.
  for (const m of first.matchAll(/smtp\.mailfrom\s*=\s*("?)<?([^\s;"<>]*)>?\1/gi)) if (m[2].toLowerCase() !== env) return false;
  for (const method of ['spf', 'dkim', 'dmarc']) {
    const c = clauses.find((x) => new RegExp(`^\\s*${method}=`, 'i').test(x));
    if (!c || !new RegExp(`^\\s*${method}=pass\\b`, 'i').test(c)) return false;
  }
  // Header From: strip quoted display names and comments, then exactly one addr-spec must remain.
  const bare = (headerFromRaw ?? '').replace(/"(?:[^"\\]|\\.)*"/g, ' ').replace(/\([^)]*\)/g, ' ');
  const addrs = bare.match(/[^\s<>@,;:"()]+@[^\s<>@,;:"()]+/g) ?? [];
  return addrs.length === 1 && addrs[0].toLowerCase() === env;
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
export function ackText(name: string, link: string): string {
  return `Hi — we got "${name}" (${link}).\nIt is queued. Once the platform page checks out, the bot is added to the site automatically, usually within an hour.\n— GrokBot Zone · ${SITE}/recent/`;
}

/**
 * The owner mail (spec 08 D30: for your information only, nothing to approve). Every submitted field is
 * collapsed to one line under an "untrusted" heading, so submitted text can never add a line of its own.
 */
export function ownerSummary(r: { id: number; name: string; author: string | null; category: string | null; link: string; submitter: string; ip: string; description: string; source: string }) {
  const f = (label: string, v: string | null) => `${label}: ${v === null ? '—' : singleLine(v)}`;
  return {
    subject: oneLine(`[GZ] new submission #${r.id} — ${r.name} (${r.source})`),
    text: [
      'FYI: processed automatically, nothing to approve. It goes live when the platform page checks out.',
      '',
      'Submitted fields (untrusted):',
      f('name', r.name), f('author', r.author), f('category', r.category), f('link', r.link),
      f('submitter', r.submitter), f('ip', r.ip), f('source', r.source), f('description', r.description),
    ].join('\n'),
  };
}

/** The optional one-line postal address for the footer, from env MAIL_POSTAL_ADDRESS. Empty when unset: the footer line is then omitted. */
export const postalLine = (v: unknown) => (typeof v === 'string' ? singleLine(v) : '');

export function confirmMail(token: string, postal = '') {
  const url = `${SITE}/subscribe/confirm?t=${token}`;
  const addr = postalLine(postal);
  const foot = ['If you did not ask for this, ignore this email and nothing will happen.', addr ? `GrokBot Zone, ${addr}` : ''].filter(Boolean);
  const text = `Confirm: ${url}\nYou'll get an update email Monday and Thursday. Nothing happens until you confirm.\n\n-- \n${foot.join('\n')}`;
  const html = `<p>Confirm your subscription to GrokBot Zone updates:</p><p><a href="${url}">Confirm my subscription</a></p><p>You'll get an update email Monday and Thursday. Nothing happens until you confirm.</p><hr><p style="color:#666;font-size:12px">${foot.map(esc).join('<br>')}</p>`;
  return { subject: 'Confirm your GrokBot Zone update emails', text, html };
}
export const confirmText = (token: string, postal = '') => confirmMail(token, postal).text;

export interface DigestPayload { asOf: string; totalBots: number; categoryCount: number; top: { id: string; name: string; description: string }[] }
const firstSentence = (s: string) => (/^.*?[.!?](?=\s|$)/.exec(s)?.[0] ?? s).slice(0, 200);

export function digestMail(p: DigestPayload, weekday: 'Monday' | 'Thursday', unsubToken: string, postal = '') {
  const addr = postalLine(postal);
  const unsub = `${SITE}/subscribe/unsubscribe?t=${unsubToken}`;
  const lines = p.top.slice(0, 10).map((b, i) => `${i + 1}. ${b.name} — ${firstSentence(b.description)} → ${SITE}/bots/${b.id}/`);
  const head = `${p.asOf} — ${p.totalBots} bots in ${p.categoryCount} categories.`;
  return {
    subject: `GrokBot Zone: ${p.totalBots} bots tracked + the ${weekday} top 10`,
    text: `${head}\n${lines.join('\n')}\n\n-- \n${addr ? `GrokBot Zone, ${addr}\n` : ''}You get this because you confirmed a subscription.\nUnsubscribe: ${unsub}`,
    html: `<p>${esc(head)}</p><table>${p.top.slice(0, 10).map((b, i) => `<tr><td>${i + 1}.</td><td><a href="${SITE}/bots/${esc(b.id)}/">${esc(b.name)}</a> — ${esc(firstSentence(b.description))}</td></tr>`).join('')}</table><hr><p style="color:#666;font-size:12px">${addr ? `GrokBot Zone, ${esc(addr)}<br>` : ''}You get this because you confirmed a subscription.<br><a href="${unsub}">Unsubscribe</a></p>`,
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
