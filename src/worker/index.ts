// Edge Worker for grokbot.zone. Pages and the read API are static assets; this handles the
// www redirect, security headers, and the four dynamic jobs: submissions, subscriptions,
// incoming mail and the digest cron. Every dynamic feature is behind a "0"/"1" switch.
import { EmailMessage } from 'cloudflare:email';
import PostalMime from 'postal-mime';
import categories from '../data/categories.json';
import {
  SITE, rawReply, ackText, confirmText, digestMail, digestRecipientCount, extractCodes, firstDescriptionLine, htmlNote,
  isEmail, honeypotOk, isOn, makeToken, oneLine, ownerSummary, validateSubmission, TOKEN_RE,
  type DigestPayload,
} from '../lib/submissions';
import { isMediaRequest, serveMedia } from './media';
import { runDataPlane } from './dp/cron';
import { denylist } from './dp/ingest';
import { gonePage, healthBody, isStoredFile, livePage, storedFile } from './dp/serve';
import { go, isDead, record } from './dp/telemetry';
import { CATEGORY_NONE } from './dp/util';

interface Mailer { send(m: Record<string, unknown>): Promise<{ messageId?: string }> }
interface Limiter { limit(o: { key: string }): Promise<{ success: boolean }> }
interface Env {
  ASSETS: { fetch(r: Request | string): Promise<Response> };
  DB?: D1Database;
  EMAIL?: Mailer;
  NOTIFY_OWNER?: Mailer;
  SUBMISSIONS_RL?: Limiter;
  SUBSCRIBE_RL?: Limiter;
  FORM_SUBMIT_ENABLED?: string;
  EMAIL_SUBMIT_ENABLED?: string;
  SUBSCRIBE_ENABLED?: string;
  DIGEST_ENABLED?: string;
  OWNER_ADDRESS?: string;
  MIN_FILL_MS?: string;
  DIGEST_MAX_SENDS?: string;
  NOREF_TOKENS?: string;
  TELEMETRY_START?: string;
}
type Kind = 'ack' | 'owner_summary' | 'confirm' | 'digest' | 'unsubscribe';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const DIGEST_CRON = '0 13 * * MON,THU';
const SUBMIT_FROM = 'submit@grokbot.zone';
const UPDATES_FROM = 'updates@grokbot.zone';
const CATEGORY_SLUGS = new Set((categories as { slug: string }[]).map((c) => c.slug));

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
const disabled = () => json(503, { ok: false, error: 'disabled' });

function page(status: number, title: string, line: string, wantsText: boolean): Response {
  if (wantsText) return new Response(`${title}\n${line}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} | GrokBot Zone</title><style>body{background:#030203;color:#f4f1f4;font:16px/1.5 Inter,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:36rem;padding:2rem}a{color:#00ffcc}</style></head><body><main><h1>${title}</h1><p>${line}</p><p><a href="/">Back to GrokBot Zone</a></p></main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
const wantsText = (req: Request) => {
  const a = req.headers.get('accept') ?? '';
  return a.includes('text/plain') && !a.includes('text/html');
};

// ---- shared helpers ----

let codesCache: Set<string> | null = null;
async function shippedCodes(env: Env): Promise<Set<string>> {
  if (codesCache) return codesCache;
  const res = await env.ASSETS.fetch(new Request(`${SITE}/api/v1/codes.json`));
  if (!res.ok) throw new Error(`codes.json ${res.status}`);
  codesCache = new Set(((await res.json()) as { codes: string[] }).codes);
  return codesCache;
}

async function logSend(env: Env, kind: Kind, recipient: string, messageId: string | null, ok: boolean, errorCode: string | null) {
  if (!env.DB) return;
  try {
    await env.DB.prepare('INSERT INTO send_log (kind, recipient, message_id, ok, error_code) VALUES (?, ?, ?, ?, ?)')
      .bind(kind, recipient, messageId, ok ? 1 : 0, errorCode).run();
  } catch (e) {
    console.error('send_log insert failed', (e as Error).message);
  }
}

/** Sends one message and logs the outcome. Never throws: a mail failure must not change an HTTP result. */
async function sendMail(env: Env, via: Mailer | undefined, kind: Kind, msg: { to: string; from: string; subject: string; text: string; html?: string; headers?: Record<string, string> }) {
  if (!via) { await logSend(env, kind, msg.to, null, false, 'E_NO_BINDING'); return { ok: false, code: 'E_NO_BINDING' }; }
  try {
    const r = await via.send({ ...msg, subject: oneLine(msg.subject) });
    await logSend(env, kind, msg.to, r?.messageId ?? null, true, null);
    return { ok: true, code: null as string | null };
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'E_SEND_FAILED';
    console.error(`send ${kind} failed:`, code, (e as Error).message);
    await logSend(env, kind, msg.to, null, false, code);
    return { ok: false, code };
  }
}

/** Write routes fail CLOSED: a missing or broken limiter must never mean "no limit". */
async function gate(rl: Limiter | undefined, key: string): Promise<'ok' | 'limited' | 'unavailable'> {
  if (!rl) return 'unavailable';
  try { return (await rl.limit({ key })).success ? 'ok' : 'limited'; } catch { return 'unavailable'; }
}
const unavailable = () => json(503, { ok: false, error: 'unavailable' });
/** The response that stops a write request at the limiter, or null to let it through. */
async function writeGate(rl: Limiter | undefined, key: string): Promise<Response | null> {
  const g = await gate(rl, key);
  if (g === 'unavailable') return unavailable();
  return g === 'limited' ? json(429, { ok: false, error: 'rate_limited' }, { 'Retry-After': '60' }) : null;
}
const clientIp = (req: Request) => req.headers.get('cf-connecting-ip') ?? 'unknown';
const isJson = (req: Request) => (req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json');
async function readJson(req: Request): Promise<unknown | undefined> {
  try { return await req.json(); } catch { return undefined; }
}

// ---- GET /api/health ----

async function health(env: Env): Promise<Response> {
  const switches = { FORM_SUBMIT_ENABLED: env.FORM_SUBMIT_ENABLED ?? '0', EMAIL_SUBMIT_ENABLED: env.EMAIL_SUBMIT_ENABLED ?? '0', SUBSCRIBE_ENABLED: env.SUBSCRIBE_ENABLED ?? '0', DIGEST_ENABLED: env.DIGEST_ENABLED ?? '0' };
  const now = Date.now();
  const body = await healthBody(env.DB, now, new Date(now).toISOString(), denylist(env.NOREF_TOKENS).length > 0, switches);
  return json(body.ok ? 200 : 503, body);
}

// GET /api/flags: which dynamic features are switched on. The static submit page and footer
// read it to decide whether to show a form, so a dark switch never shows a dead form.
function flags(env: Env): Response {
  return json(200, { form: isOn(env.FORM_SUBMIT_ENABLED), subscribe: isOn(env.SUBSCRIBE_ENABLED), email: isOn(env.EMAIL_SUBMIT_ENABLED) });
}

// ---- POST /api/submit, /api/v1/submissions ----

async function submit(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!isOn(env.FORM_SUBMIT_ENABLED)) return disabled();
  if (!env.DB) return disabled();
  if (!isJson(req)) return json(415, { ok: false, error: 'content type must be application/json' });
  const ip = clientIp(req);
  const stop = await writeGate(env.SUBMISSIONS_RL, `${ip}:submit`);
  if (stop) return stop;
  const body = await readJson(req);
  if (body === undefined) return json(400, { ok: false, errors: { body: 'invalid JSON' } });
  const v = validateSubmission(body, CATEGORY_SLUGS, Number(env.MIN_FILL_MS ?? '3000'));
  if (!v.ok) return json(400, { ok: false, errors: v.errors });
  const s = v.value;

  if ((await shippedCodes(env)).has(s.code.toLowerCase())) return json(409, { ok: false, error: 'already_listed' });
  const existing = await env.DB.prepare('SELECT id, status FROM submissions WHERE link = ?').bind(s.link).first<{ id: number; status: string }>();
  let id: number;
  if (existing && existing.status !== 'rejected') return json(409, { ok: false, error: 'already_pending' });
  if (existing) {
    // One conditional statement: a row approved since the SELECT above is left alone.
    const r = await env.DB.prepare("UPDATE submissions SET status='pending', source='webform', name=?, author=?, description=?, code=?, category=?, submitter_email=?, ip=? WHERE id=? AND status='rejected'")
      .bind(s.name, s.author, s.description, s.code, s.category, s.email, ip, existing.id).run();
    if (!r.meta.changes) return json(409, { ok: false, error: 'already_pending' });
    id = existing.id;
  } else {
    const r = await env.DB.prepare("INSERT INTO submissions (source, name, author, description, code, link, category, submitter_email, ip) VALUES ('webform', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(link) DO NOTHING")
      .bind(s.name, s.author, s.description, s.code, s.link, s.category, s.email, ip).run();
    if (!r.meta.changes) return json(409, { ok: false, error: 'already_pending' });
    id = r.meta.last_row_id as number;
  }

  ctx.waitUntil((async () => {
    await sendMail(env, env.EMAIL, 'ack', { to: s.email, from: SUBMIT_FROM, subject: 'Your bot submission to GrokBot Zone', text: ackText(s.name, s.link), html: htmlNote(ackText(s.name, s.link)) });
    await notifyOwner(env, { id, name: s.name, author: s.author, category: s.category, link: s.link, submitter: s.email, ip, description: s.description, source: 'webform' });
  })());
  return json(201, { ok: true, id, status: 'pending' });
}

async function notifyOwner(env: Env, r: Parameters<typeof ownerSummary>[0]) {
  const to = (env.OWNER_ADDRESS ?? '').trim();
  const m = ownerSummary(r);
  if (!to) { await logSend(env, 'owner_summary', '(unset)', null, false, 'E_NO_OWNER_ADDRESS'); return; }
  await sendMail(env, env.NOTIFY_OWNER ?? env.EMAIL, 'owner_summary', { to, from: UPDATES_FROM, subject: m.subject, text: m.text, html: htmlNote(m.text) });
}

// ---- subscriptions ----

async function subscribe(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!isOn(env.SUBSCRIBE_ENABLED)) return disabled();
  if (!env.DB) return disabled();
  if (!isJson(req)) return json(415, { ok: false, error: 'content type must be application/json' });
  const stop = await writeGate(env.SUBSCRIBE_RL, `${clientIp(req)}:subscribe`);
  if (stop) return stop;
  const body = (await readJson(req)) as { email?: unknown; company_website?: unknown } | undefined;
  if (!body || typeof body !== 'object') return json(400, { ok: false, errors: { body: 'invalid JSON' } });
  const errors: Record<string, string> = {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!isEmail(email)) errors.email = 'required, a valid email address';
  if (!honeypotOk(body.company_website)) errors.company_website = 'must be empty';
  if (Object.keys(errors).length) return json(400, { ok: false, errors });

  const row = await env.DB.prepare('SELECT id, status FROM subscribers WHERE email = ?').bind(email).first<{ id: number; status: string }>();
  if (row?.status === 'pending') return json(200, { ok: true, status: 'already_pending' });
  if (row?.status === 'active') return json(409, { ok: false, error: 'already_subscribed' });
  if (row?.status === 'bounced') return json(409, { ok: false, error: 'unavailable' });
  const confirm = makeToken();
  const unsub = makeToken();
  if (row) { // unsubscribed earlier: start a fresh double opt-in with new tokens
    await env.DB.prepare("UPDATE subscribers SET status='pending', confirm_token=?, unsub_token=?, confirmed_at=NULL, unsubscribed_at=NULL WHERE id=?").bind(confirm, unsub, row.id).run();
  } else {
    const r = await env.DB.prepare('INSERT INTO subscribers (email, confirm_token, unsub_token) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING').bind(email, confirm, unsub).run();
    if (!r.meta.changes) return json(200, { ok: true, status: 'already_pending' });
  }
  const text = confirmText(confirm);
  ctx.waitUntil(sendMail(env, env.EMAIL, 'confirm', { to: email, from: UPDATES_FROM, subject: 'Confirm your GrokBot Zone update emails', text, html: htmlNote(text) }).then(() => undefined));
  return json(201, { ok: true, status: 'pending_confirm' });
}

const tokenOf = (url: URL) => { const t = url.searchParams.get('t') ?? ''; return TOKEN_RE.test(t) ? t : ''; };
const badToken = (req: Request) => wantsText(req) || (req.headers.get('accept') ?? '').includes('json') ? json(410, { ok: false, error: 'bad_token' }) : page(410, 'Link not valid', 'This link is not valid or has expired.', false);

async function confirm(req: Request, env: Env, url: URL): Promise<Response> {
  if (!isOn(env.SUBSCRIBE_ENABLED) || !env.DB) return disabled();
  const t = tokenOf(url);
  const row = t ? await env.DB.prepare('SELECT id, status FROM subscribers WHERE confirm_token = ?').bind(t).first<{ id: number; status: string }>() : null;
  if (!row || (row.status !== 'pending' && row.status !== 'active')) return badToken(req);
  if (row.status === 'pending') {
    await env.DB.prepare("UPDATE subscribers SET status='active', confirmed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?").bind(row.id).run();
  }
  return page(200, 'You are subscribed', 'Thanks. You will get an update email on Monday and Thursday.', wantsText(req));
}

// Unsubscribing is deliberately not behind the subscribe switch: a reader must always be able to leave.
async function unsubscribe(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.DB) return disabled();
  const t = tokenOf(url);
  const row = t ? await env.DB.prepare('SELECT id, status, email FROM subscribers WHERE unsub_token = ?').bind(t).first<{ id: number; status: string; email: string }>() : null;
  if (!row) return req.method === 'POST' ? json(410, { ok: false, error: 'bad_token' }) : badToken(req);
  if (req.method === 'POST') {
    const body = await req.text();
    if (!/List-Unsubscribe=One-Click/.test(body)) return json(400, { ok: false, error: 'expected List-Unsubscribe=One-Click' });
  }
  if (row.status === 'pending' || row.status === 'active') {
    const r = await env.DB.prepare("UPDATE subscribers SET status='unsubscribed', unsubscribed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND status IN ('pending','active')").bind(row.id).run();
    if (r.meta.changes) await logSend(env, 'unsubscribe', row.email, null, true, null); // audit row; nothing is sent
  }
  if (req.method === 'POST') return new Response('Unsubscribed.', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return page(200, 'You are unsubscribed', 'You will not get any more update emails.', wantsText(req));
}

// ---- incoming mail: submit@grokbot.zone ----

async function email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
  if (!isOn(env.EMAIL_SUBMIT_ENABLED)) { message.setReject('submissions closed'); return; }
  if (message.to.split('@')[0].toLowerCase() !== 'submit') { message.setReject('unknown mailbox'); return; }
  const auth = (message.headers.get('authentication-results') ?? '').trim();
  if (/^mx\.cloudflare\.net\b/i.test(auth) && /dmarc=fail/i.test(auth)) { message.setReject('dmarc'); return; }
  if (!env.DB) { message.setReject('submissions closed'); return; }
  // Per envelope sender, before anything is parsed or written. Same binding as the form (5 per 60 s, keyed apart).
  const sender = message.from.trim().toLowerCase();
  const stop = await gate(env.SUBMISSIONS_RL, `${sender}:email`);
  if (stop !== 'ok') { message.setReject(stop === 'limited' ? 'rate limited' : 'temporarily unavailable'); return; }

  const parsed = await new (PostalMime as unknown as new () => { parse(b: ArrayBuffer): Promise<{ subject?: string; text?: string; html?: string }> })()
    .parse(await new Response(message.raw).arrayBuffer());
  const found = extractCodes(parsed.text, parsed.html);
  if (!found.length) { message.setReject('no bot link found'); return; }
  const shipped = await shippedCodes(env);
  const fresh = found.filter((c) => !shipped.has(c.toLowerCase()));
  const skipped = found.filter((c) => shipped.has(c.toLowerCase()));
  if (fresh.length > 5) { message.setReject('too many links in one message'); return; }

  const subject = oneLine(parsed.subject ?? message.headers.get('subject') ?? '');
  const desc = firstDescriptionLine(parsed.text ?? parsed.html?.replace(/<[^>]*>/g, ' '));
  const excerpt = (parsed.text ?? '').slice(0, 1500);
  const queued: string[] = [];
  for (const code of fresh) {
    const link = `https://x.ai/bot/${code}`;
    const name = (subject || desc).slice(0, 120).padEnd(3, '.');
    const existing = await env.DB.prepare('SELECT id, status FROM submissions WHERE link = ?').bind(link).first<{ id: number; status: string }>();
    if (existing && existing.status !== 'rejected') { skipped.push(code); continue; }
    let id: number;
    if (existing) {
      const r = await env.DB.prepare("UPDATE submissions SET status='pending', source='email', name=?, description=?, code=?, submitter_email=?, raw_excerpt=? WHERE id=? AND status='rejected'")
        .bind(name, desc, code, message.from, excerpt, existing.id).run();
      if (!r.meta.changes) { skipped.push(code); continue; }
      id = existing.id;
    } else {
      const r = await env.DB.prepare("INSERT INTO submissions (source, name, description, code, link, submitter_email, raw_excerpt) VALUES ('email', ?, ?, ?, ?, ?, ?) ON CONFLICT(link) DO NOTHING")
        .bind(name, desc, code, link, message.from, excerpt).run();
      if (!r.meta.changes) { skipped.push(code); continue; }
      id = r.meta.last_row_id as number;
    }
    queued.push(code);
    await notifyOwner(env, { id, name, author: null, category: null, link, submitter: message.from, ip: '—', description: desc, source: 'email' });
  }

  // One ack per event. Skip it for automated senders so two robots never loop.
  const auto = (message.headers.get('auto-submitted') ?? 'no').toLowerCase() !== 'no' || /no-?reply|mailer-daemon/i.test(message.from);
  if (!auto) {
    const lines = [`Hi — we got your message for GrokBot Zone.`];
    if (queued.length) lines.push(`Queued for review: ${queued.map((c) => `https://x.ai/bot/${c}`).join(', ')}`);
    if (skipped.length) lines.push(`Already listed or already queued: ${skipped.map((c) => `https://x.ai/bot/${c}`).join(', ')}`);
    lines.push('If a bot is approved it appears with the next refresh; the list updates twice a week, Monday and Thursday.', `— GrokBot Zone · ${SITE}/trending/`);
    const text = lines.join('\n');
    const replySubject = `Re: ${subject || 'your submission'}`;
    try {
      const raw = rawReply({ from: message.to, to: message.from, subject: replySubject, text, inReplyTo: message.headers.get('message-id') });
      await message.reply(new EmailMessage(message.to, message.from, raw));
      await logSend(env, 'ack', message.from, null, true, null);
    } catch (e) {
      console.error('reply failed, falling back to send:', (e as Error).message);
      await sendMail(env, env.EMAIL, 'ack', { to: message.from, from: SUBMIT_FROM, subject: replySubject, text });
    }
  }

  const owner = (env.OWNER_ADDRESS ?? '').trim();
  if (!owner) { await logSend(env, 'owner_summary', '(unset)', null, false, 'E_NO_OWNER_ADDRESS'); return; }
  try {
    await message.forward(owner);
    await logSend(env, 'owner_summary', owner, null, true, null);
  } catch (e) {
    console.error('forward failed:', (e as Error).message);
    await logSend(env, 'owner_summary', owner, null, false, (e as { code?: string }).code ?? 'E_FORWARD_FAILED');
  }
}

// ---- cron: Monday + Thursday digest ----

async function digest(controller: ScheduledController, env: Env): Promise<void> {
  if (!isOn(env.DIGEST_ENABLED)) { console.log('digest: dark (DIGEST_ENABLED != 1), 0 sends'); return; }
  if (!env.DB) { console.log('digest: no DB binding, 0 sends'); return; }
  const res = await env.ASSETS.fetch(new Request(`${SITE}/digests/latest.json`));
  if (!res.ok) { console.error(`digest: payload ${res.status}, 0 sends`); return; }
  const payload = (await res.json()) as DigestPayload;
  const cap = Number(env.DIGEST_MAX_SENDS ?? '100');
  const { results } = await env.DB.prepare("SELECT email, unsub_token FROM subscribers WHERE status='active' ORDER BY id LIMIT ?").bind(digestRecipientCount(1e9, cap)).all<{ email: string; unsub_token: string }>();
  const weekday = new Date(controller.scheduledTime).getUTCDay() === 4 ? 'Thursday' : 'Monday';
  let sent = 0;
  for (const s of results) {
    const m = digestMail(payload, weekday, s.unsub_token);
    const r = await sendMail(env, env.EMAIL, 'digest', { to: s.email, from: UPDATES_FROM, subject: m.subject, text: m.text, html: m.html, headers: m.headers });
    if (r.ok) sent++;
    if (r.code === 'E_RATE_LIMIT_EXCEEDED' || r.code?.startsWith('E_QUOTA')) { console.error(`digest: stopped on ${r.code}`); break; }
  }
  console.log(`digest: ${weekday} sent=${sent} active_considered=${results.length} cap=${cap}`);
}

// ---- entry ----

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === 'www.grokbot.zone') {
      url.hostname = 'grokbot.zone';
      return Response.redirect(url.toString(), 301);
    }
    const res = await route(request, env, ctx, url);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
  email,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Two triggers share this handler: the digest keeps its own expression, everything else is the data plane.
    if (controller.cron === DIGEST_CRON) ctx.waitUntil(digest(controller, env));
    else ctx.waitUntil(runDataPlane(env, controller.scheduledTime).then((r) => console.log('dataplane', JSON.stringify(r))).catch((e) => console.error('dataplane failed:', (e as Error).message)));
  },
};

async function route(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const m = request.method;
  if (isMediaRequest(request, url)) return serveMedia(request, env.ASSETS, url);
  try {
    if (path === '/api/health' && (m === 'GET' || m === 'HEAD')) return await health(env);
    if (path === '/api/flags' && m === 'GET') return flags(env);
    if (path === '/api/submit' || path === '/api/v1/submissions') {
      if (m === 'POST') return await submit(request, env, ctx);
      return json(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' });
    }
    if (path === '/subscribe') {
      if (m === 'POST') return await subscribe(request, env, ctx);
      return json(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' });
    }
    if (path === '/subscribe/confirm' && m === 'GET') return await confirm(request, env, url);
    if (path === '/subscribe/unsubscribe' && (m === 'GET' || m === 'POST')) return await unsubscribe(request, env, url);
  } catch (e) {
    console.error('route error', path, (e as Error).message);
    return json(500, { ok: false, error: 'internal' });
  }
  return dataPlane(request, env, ctx, path);
}

// ---- data plane: /go/, stored read files, live pages, dead bots, view counting ----

const BOT_PAGE_RE = /^\/bots\/([^/]+)$/;
/** "<category>-<code>" -> [category, code]. Codes contain "-", so strip a known category prefix instead of splitting. */
function splitId(id: string): [string | null, string] {
  let best: string | null = null;
  for (const s of CATEGORY_SLUGS) if (id.startsWith(`${s}-`) && (!best || s.length > best.length)) best = s;
  return best ? [best, id.slice(best.length + 1)] : id.startsWith(`${CATEGORY_NONE}-`) ? [null, id.slice(CATEGORY_NONE.length + 1)] : [null, id];
}

async function dataPlane(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  // Whatever goes wrong in the data plane, the static site still answers.
  try { return await dataPlaneInner(request, env, ctx, path); } catch (e) {
    console.error('dataplane route error', path, (e as Error).message);
    return path === '/go' || path.startsWith('/go/') ? new Response('Not found\n', { status: 404 }) : env.ASSETS.fetch(request);
  }
}

async function dataPlaneInner(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  const get = request.method === 'GET' || request.method === 'HEAD';
  if (path === '/go' || path.startsWith('/go/')) return go(request, env.DB, decodeURIComponent(path.slice(4)).replace(/\/+$/, ''), (p) => ctx.waitUntil(p));
  if (get && isStoredFile(path)) {
    const stored = await storedFile(env.DB, path);
    if (stored) return stored;
    if (path !== '/api/v1/trending.json' && path !== '/api/v1/recent.json') return json(503, { ok: false, error: 'not_ready' }, { 'Retry-After': '600' });
  }
  const res = await env.ASSETS.fetch(request);
  if (!get) return res;
  const m = BOT_PAGE_RE.exec(path);
  if (m && res.status === 200) {
    const [cat, code] = splitId(m[1]);
    const lc = code.toLowerCase();
    if (await isDead(env.DB, lc)) return gonePage(res, m[1], cat);
    if (request.method === 'GET') ctx.waitUntil(record(env.DB, 'view', lc, request));
    return res;
  }
  if (request.method === 'GET' && (path === '/' || path === '/trending' || path === '/recent')) return livePage(res, env.DB, path);
  return res;
}
