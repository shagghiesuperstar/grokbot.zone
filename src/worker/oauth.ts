// OAuth 2.1 authorization server for the MCP write tools: RFC 7591 dynamic client registration for public clients,
// authorization code + PKCE S256, email magic-link login, bearer tokens. Everything advertised is served from here.
//
// Secrets: every plaintext secret (magic token, auth code, access token) is 32 bytes from crypto.getRandomValues,
// base64url. Only SHA-256 hex digests are stored or looked up. A lookup by digest of a 256-bit random value leaks
// nothing useful through timing; the one comparison of two attacker-influenced strings (the PKCE challenge) uses
// timingSafeEqual below. Plaintext secrets are never logged.
import { isEmail } from '../lib/submissions';

interface Mailer { send(m: Record<string, unknown>): Promise<unknown> }
export interface OAuthEnv { DB?: D1Database; EMAIL?: Mailer; /** Sender address for the magic-link mail; supplied by index.ts so no address literal lives here. */ mailFrom: string }

const HOSTS = new Set(['grokbot.zone', 'www.grokbot.zone', '127.0.0.1', 'localhost']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost']);
const SCOPE = 'mcp:write';
const MAGIC_TTL_MS = 15 * 60_000;
const CODE_TTL_MS = 60_000;
const TOKEN_TTL_S = 3600;
const TOKEN_WRITES_PER_MIN = 30;
const REGISTRATIONS_PER_HOUR = 10;
const MAILS_PER_IP_HOUR = 30;
const MAILS_PER_ADDRESS_HOUR = 5;
/** Pending-row client_id for agent-identity logins that carry no OAuth client: the magic link only proves the address. */
const IDENTITY_CLIENT = 'agent-identity';
const BODY_MAX = 8192;
/** DCR documents 5 redirect_uris of 2048 characters. JSON overhead puts that just over BODY_MAX. */
const REGISTER_BODY_MAX = 16384;

// ---- small helpers ----

const enc = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = (s: string) => crypto.subtle.digest('SHA-256', enc.encode(s));
const sha256hex = async (s: string) => hex(await sha256(s));
const randomSecret = (bytes = 32) => b64u(crypto.getRandomValues(new Uint8Array(bytes)));

/** Compares in time that depends only on the longer length, never on where the strings differ. */
function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a); const y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

const oj = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });
const oerr = (status: number, error: string, description?: string, extra: Record<string, string> = {}) =>
  oj(status, description ? { error, error_description: description } : { error }, extra);
const unavailable = () => oerr(503, 'temporarily_unavailable');
const notAllowed = (allow: string) => oerr(405, 'method_not_allowed', undefined, { Allow: allow });

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
function htmlPage(status: number, title: string, bodyHtml: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} | GrokBot Zone</title><style>body{background:#030203;color:#f4f1f4;font:16px/1.5 Inter,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:36rem;padding:2rem}input{font:inherit;padding:.6rem;border-radius:.4rem;border:1px solid #555;width:100%;box-sizing:border-box;margin:.5rem 0 1rem}button{font:inherit;font-weight:600;padding:.6rem 1.2rem;border:0;border-radius:.4rem;background:#00ffcc;color:#030203;cursor:pointer}a{color:#00ffcc}</style></head><body><main><h1>${esc(title)}</h1>${bodyHtml}</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': HTML_CSP } });
}
const wantsJson = (req: Request) => (req.headers.get('accept') ?? '').includes('application/json');
/** An error that suits the caller: JSON for API clients, a plain page for a browser. Never a redirect. */
const failFor = (req: Request, status: number, error: string, description: string) =>
  wantsJson(req) ? oerr(status, error, description) : htmlPage(status, 'Request not valid', `<p>${esc(description)}</p>`);

/** The origin every advertised URL is built from. null = host not allowed (never echoed anywhere). */
function originOf(url: URL): string | null {
  if (!HOSTS.has(url.hostname)) return null;
  return LOOPBACK.has(url.hostname) ? url.origin : 'https://grokbot.zone';
}

async function readText(req: Request, max = BODY_MAX): Promise<string | null> {
  const t = await req.text();
  return t.length > max ? null : t;
}
async function readJsonObject(req: Request, max = BODY_MAX): Promise<Record<string, unknown> | null> {
  const t = await readText(req, max);
  if (t === null) return null;
  try { const v = JSON.parse(t) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
}
const ctype = (req: Request) => (req.headers.get('content-type') ?? '').toLowerCase();

/** Fixed-window counter in D1. One conditional upsert, so concurrent requests cannot overshoot. Throws on a D1 error (callers fail closed). */
async function take(db: D1Database, key: string, cap: number, windowSec: number, now = Date.now()): Promise<boolean> {
  const cutoff = now - windowSec * 1000;
  const r = await db.prepare(
    `INSERT INTO oauth_rl (k, n, window_start) VALUES (?, 1, ?)
     ON CONFLICT(k) DO UPDATE SET
       n = CASE WHEN window_start <= ? THEN 1 ELSE n + 1 END,
       window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
     WHERE window_start <= ? OR n < ?`,
  ).bind(key, now, cutoff, cutoff, now, cutoff, cap).run();
  return Number(r.meta.changes) > 0;
}

// ---- discovery documents ----

function authServerDoc(o: string) {
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    revocation_endpoint: `${o}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
    agent_auth: {
      skill: `${o}/auth.md`,
      register_uri: `${o}/oauth/agent/identity`,
      identity_endpoint: `${o}/oauth/agent/identity`,
      claim_uri: `${o}/oauth/agent/claim`,
      claim_endpoint: `${o}/oauth/agent/claim`,
      revocation_uri: `${o}/oauth/revoke`,
      identity_types_supported: ['service_auth'],
      assertion_types_supported: ['verified_email'],
      credential_types_supported: ['access_token'],
    },
  };
}

function authMd(o: string): string {
  return `# Authorization for the GrokBot Zone MCP server

Reading the directory needs no account. Anonymous writes still work at the usual per-IP rate limit. A bearer
token from the flow below raises the write limit for the two MCP write tools, \`grokbot_submit_bot\` and
\`grokbot_subscribe\`, and for the matching REST routes. Read tools stay anonymous either way.

## Flow

1. Discovery. Fetch \`${o}/.well-known/oauth-protected-resource\` (names the resource and its authorization server)
   and \`${o}/.well-known/oauth-authorization-server\` (RFC 8414 metadata with every endpoint).
2. Register a public client at \`${o}/oauth/register\` (RFC 7591). POST JSON with \`redirect_uris\`
   (https, or http on 127.0.0.1 or localhost; exact strings, no fragments, no wildcards) and optionally
   \`client_name\`. The reply has a \`client_id\`. There is no client secret.
3. Authorize with PKCE. Open \`${o}/oauth/authorize\` with \`response_type=code\`, \`client_id\`, \`redirect_uri\`,
   \`code_challenge\` (base64url SHA-256 of a random verifier of 43 to 128 characters), \`code_challenge_method=S256\`,
   optional \`state\`, and optional \`scope=mcp:write\`. Plain PKCE is refused.
4. Email magic link. Submit the account's email address on that page (or POST \`{"email": ...}\` as JSON to the same URL).
   A single-use sign-in link valid for 15 minutes is mailed there. Opening it redirects to your registered
   \`redirect_uri\` with \`code\` (valid for 60 seconds) and your \`state\`.
5. Exchange the code at \`${o}/oauth/token\` with a form body: \`grant_type=authorization_code\`, \`code\`,
   \`redirect_uri\`, \`client_id\`, \`code_verifier\`. The reply carries \`access_token\`, \`token_type\` Bearer,
   \`expires_in\` 3600 and \`scope\` mcp:write.
6. Send \`Authorization: Bearer <access_token>\` with POST requests to \`${o}/mcp\` for the write tools.
   A bearer that is missing from our records, expired or revoked is answered with 401 and the write is not stored.
7. Revoke with a form POST of \`token=<access_token>\` to \`${o}/oauth/revoke\`.

## Agent identity

A service that wants to start the email login without a browser can POST \`{"type": "service_auth", "login_hint": "<email>"}\`
to \`${o}/oauth/agent/identity\`. The reply names a claim page at \`${o}/oauth/agent/claim\`; the person finishes by
opening the emailed link.

## Limits

Registrations: 10 per IP per hour. Sign-in emails: 5 per address per hour. Writes with a token: 30 per 60 seconds per verified email, shared by every token for that email. The per-IP limiter still applies underneath; a token raises that ceiling, it does not remove it.
Access tokens last one hour and are stored only as SHA-256 digests.
`;
}

// ---- client registration (RFC 7591) ----

function validRedirect(u: unknown): u is string {
  if (typeof u !== 'string' || u.length === 0 || u.length > 2048) return false;
  if (/[#*\\\s\u0000-\u001f\u007f]/.test(u)) return false;
  if (!u.startsWith('https://') && !u.startsWith('http://')) return false;
  let p: URL;
  try { p = new URL(u); } catch { return false; }
  if (p.username || p.password) return false;
  if (p.protocol === 'https:') return true;
  return p.protocol === 'http:' && LOOPBACK.has(p.hostname);
}
const onlyAllowed = (v: unknown, allowed: string) => v === undefined || (Array.isArray(v) && v.length > 0 && v.every((x) => x === allowed));

async function register(req: Request, env: OAuthEnv): Promise<Response> {
  if (!ctype(req).startsWith('application/json')) return oerr(415, 'invalid_client_metadata', 'content type must be application/json');
  const b = await readJsonObject(req, REGISTER_BODY_MAX);
  if (!b) return oerr(400, 'invalid_client_metadata', 'invalid JSON body');
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every(validRedirect) || new Set(uris).size !== uris.length) {
    return oerr(400, 'invalid_redirect_uri', 'redirect_uris must be 1 to 5 exact https URIs, or http on 127.0.0.1 or localhost, with no fragment or wildcard');
  }
  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none') return oerr(400, 'invalid_client_metadata', 'only token_endpoint_auth_method "none" is supported');
  if (!onlyAllowed(b.grant_types, 'authorization_code')) return oerr(400, 'invalid_client_metadata', 'only the authorization_code grant is supported');
  if (!onlyAllowed(b.response_types, 'code')) return oerr(400, 'invalid_client_metadata', 'only the code response type is supported');
  if (b.client_name !== undefined && typeof b.client_name !== 'string') return oerr(400, 'invalid_client_metadata', 'client_name must be a string');
  const name = typeof b.client_name === 'string' ? b.client_name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, 100) : '';
  if (!env.DB) return unavailable();
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const ipHash = await sha256hex(ip);
  if (!(await take(env.DB, `reg:${ipHash}`, REGISTRATIONS_PER_HOUR, 3600))) return oerr(429, 'rate_limited', undefined, { 'Retry-After': '3600' });
  const clientId = `gz_${randomSecret(16)}`;
  await env.DB.prepare('INSERT INTO oauth_client (client_id, redirect_uris, client_name, created_at, ip_hash) VALUES (?, ?, ?, ?, ?)')
    .bind(clientId, JSON.stringify(uris), name || null, Date.now(), ipHash).run();
  return oj(201, {
    client_id: clientId,
    ...(name ? { client_name: name } : {}),
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  });
}

// ---- authorize + magic link ----

interface AuthParams { client_id: string; redirect_uri: string; code_challenge: string; state: string | null; scope: string }
type Checked = { ok: true; p: AuthParams } | { ok: false; res: Response };

/** Shared by GET and POST /oauth/authorize and the identity endpoint. Never redirects: an error is a 400 (or 503) page. */
async function checkAuthParams(req: Request, db: D1Database, q: URLSearchParams): Promise<Checked> {
  const bad = (msg: string, error = 'invalid_request'): Checked => ({ ok: false, res: failFor(req, 400, error, msg) });
  if (q.get('response_type') !== 'code') return bad('response_type must be code', 'unsupported_response_type');
  const clientId = q.get('client_id') ?? '';
  const redirect = q.get('redirect_uri') ?? '';
  const challenge = q.get('code_challenge') ?? '';
  const method = q.get('code_challenge_method');
  const state = q.get('state');
  const scope = q.get('scope');
  if (!clientId || clientId.length > 128) return bad('unknown client_id', 'invalid_client');
  const row = await db.prepare('SELECT redirect_uris FROM oauth_client WHERE client_id = ?').bind(clientId).first<{ redirect_uris: string }>();
  if (!row) return bad('unknown client_id', 'invalid_client');
  let uris: unknown;
  try { uris = JSON.parse(row.redirect_uris); } catch { uris = []; }
  if (!redirect || !Array.isArray(uris) || !uris.includes(redirect)) return bad('redirect_uri does not match a registered URI');
  if (method !== 'S256') return bad('code_challenge_method must be S256');
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return bad('code_challenge must be a base64url SHA-256 digest');
  if (scope !== null && scope !== SCOPE) return bad(`scope must be ${SCOPE}`, 'invalid_scope');
  if (state !== null && state.length > 512) return bad('state is too long');
  return { ok: true, p: { client_id: clientId, redirect_uri: redirect, code_challenge: challenge, state, scope: SCOPE } };
}

function authorizeForm(p: AuthParams): Response {
  // Rebuild the query from validated values only, then attribute-escape the whole action.
  const keep = new URLSearchParams({ response_type: 'code', client_id: p.client_id, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge, code_challenge_method: 'S256', scope: p.scope });
  if (p.state !== null) keep.set('state', p.state);
  return htmlPage(200, 'Sign in to GrokBot Zone', `<p>Enter your email address. We will send a single-use sign-in link.</p><form method="post" action="${esc(`/oauth/authorize?${keep.toString()}`)}"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email" maxlength="254"><button type="submit">Send sign-in link</button></form>`);
}

interface Login { ok: true; id: string; magicUrl: string }

/** Rate-limits, stores the pending row (magic hash only), mails the link. A failed send leaves no usable row. */
async function startLogin(env: OAuthEnv, origin: string, p: AuthParams, email: string, ip: string, id = randomSecret(16)): Promise<Login | Response> {
  const db = env.DB;
  if (!db) return unavailable();
  const now = Date.now();
  if (!(await take(db, `mail-ip:${await sha256hex(ip)}`, MAILS_PER_IP_HOUR, 3600, now)) || !(await take(db, `mail-em:${await sha256hex(email)}`, MAILS_PER_ADDRESS_HOUR, 3600, now))) {
    return oerr(429, 'rate_limited', 'too many sign-in emails; try again later', { 'Retry-After': '3600' });
  }
  const token = randomSecret(32);
  await db.prepare('INSERT INTO oauth_pending (id, client_id, redirect_uri, code_challenge, state, scope, email, magic_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, p.client_id, p.redirect_uri, p.code_challenge, p.state, p.scope, email, await sha256hex(token), now + MAGIC_TTL_MS).run();
  const magicUrl = `${origin}/oauth/magic?token=${token}`;
  let sent = false;
  try {
    if (env.EMAIL) {
      await env.EMAIL.send({
        to: email, from: env.mailFrom, subject: 'Your GrokBot Zone sign-in link',
        text: `Open this link within 15 minutes to finish signing in to GrokBot Zone:\n\n${magicUrl}\n\nIt works once. If you did not ask for it, ignore this message and nothing happens.\n`,
      });
      sent = true;
    }
  } catch (e) {
    console.error('oauth magic send failed:', (e as { code?: string }).code ?? 'E_SEND_FAILED');
  }
  if (!sent) {
    try { await db.prepare('DELETE FROM oauth_pending WHERE id = ?').bind(id).run(); } catch {
      try { await db.prepare('UPDATE oauth_pending SET magic_hash = NULL, expires_at = 0 WHERE id = ?').bind(id).run(); } catch { /* the row's expiry still bounds it */ }
    }
    return unavailable();
  }
  // Housekeeping, best effort.
  try {
    await db.prepare('DELETE FROM oauth_pending WHERE expires_at < ?').bind(now - 3600_000).run();
    await db.prepare('DELETE FROM oauth_rl WHERE window_start < ?').bind(now - 86_400_000).run();
  } catch { /* ignore */ }
  return { ok: true, id, magicUrl };
}

async function authorize(req: Request, env: OAuthEnv, url: URL, origin: string): Promise<Response> {
  if (!env.DB) return unavailable();
  const checked = await checkAuthParams(req, env.DB, url.searchParams);
  if (!checked.ok) return checked.res;
  if (req.method === 'GET') return authorizeForm(checked.p);
  let rawEmail: unknown;
  if (ctype(req).startsWith('application/json')) rawEmail = (await readJsonObject(req))?.email;
  else if (ctype(req).startsWith('application/x-www-form-urlencoded')) { const t = await readText(req); rawEmail = t === null ? undefined : new URLSearchParams(t).get('email'); }
  else return failFor(req, 415, 'invalid_request', 'send JSON or a form body');
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if (!isEmail(email)) return failFor(req, 400, 'invalid_request', 'a valid email address is required');
  const login = await startLogin(env, origin, checked.p, email, req.headers.get('cf-connecting-ip') ?? 'unknown');
  if (login instanceof Response) return login;
  if (wantsJson(req)) return oj(200, { ok: true, ...(LOOPBACK.has(url.hostname) ? { dev_magic_url: login.magicUrl } : {}) });
  return htmlPage(200, 'Check your email', '<p>If the address is valid, a sign-in link is on its way. It works once and expires in 15 minutes.</p>');
}

function withParams(uri: string, params: Record<string, string>) {
  const q = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${uri}${uri.includes('?') ? '&' : '?'}${q}`;
}

async function magic(url: URL, env: OAuthEnv): Promise<Response> {
  if (!env.DB) return unavailable();
  const token = url.searchParams.get('token') ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return oerr(400, 'invalid_grant', 'invalid or expired link');
  const now = Date.now();
  const code = randomSecret(32);
  // Single use: the same statement that checks the magic hash removes it and installs the code hash.
  const r = await env.DB.prepare('UPDATE oauth_pending SET magic_hash = NULL, code_hash = ?, expires_at = ? WHERE magic_hash = ? AND expires_at > ? AND consumed_at IS NULL')
    .bind(await sha256hex(code), now + CODE_TTL_MS, await sha256hex(token), now).run();
  if (Number(r.meta.changes) !== 1) return oerr(400, 'invalid_grant', 'invalid or expired link');
  const row = await env.DB.prepare('SELECT client_id, redirect_uri, state FROM oauth_pending WHERE code_hash = ?').bind(await sha256hex(code)).first<{ client_id: string; redirect_uri: string; state: string | null }>();
  if (!row) return oerr(400, 'invalid_grant', 'invalid or expired link');
  const params: Record<string, string> = row.client_id === IDENTITY_CLIENT ? { verified: '1' } : { code, ...(row.state !== null ? { state: row.state } : {}) };
  return new Response(null, { status: 302, headers: { Location: withParams(row.redirect_uri, params), 'Cache-Control': 'no-store' } });
}

// ---- token + revoke ----

const tokenErr = (status: number, error: string, description?: string) => oerr(status, error, description, { Pragma: 'no-cache' });

async function token(req: Request, env: OAuthEnv): Promise<Response> {
  if (!ctype(req).startsWith('application/x-www-form-urlencoded')) return tokenErr(400, 'invalid_request', 'content type must be application/x-www-form-urlencoded');
  const text = await readText(req);
  if (text === null) return tokenErr(400, 'invalid_request');
  const f = new URLSearchParams(text);
  if (f.get('grant_type') !== 'authorization_code') return tokenErr(400, 'unsupported_grant_type');
  const code = f.get('code') ?? ''; const redirect = f.get('redirect_uri') ?? ''; const clientId = f.get('client_id') ?? ''; const verifier = f.get('code_verifier') ?? '';
  if (!code || !redirect || !clientId) return tokenErr(400, 'invalid_request', 'code, redirect_uri and client_id are required');
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return tokenErr(400, 'invalid_grant', 'code_verifier must be 43 to 128 unreserved characters');
  if (!env.DB) return unavailable();
  const now = Date.now();
  const codeHash = await sha256hex(code);
  const row = await env.DB.prepare('SELECT id, client_id, redirect_uri, code_challenge, scope, email FROM oauth_pending WHERE code_hash = ?')
    .bind(codeHash).first<{ id: string; client_id: string; redirect_uri: string; code_challenge: string; scope: string; email: string | null }>();
  if (!row || !row.email) return tokenErr(400, 'invalid_grant');
  // Single use: whoever flips consumed_at wins. A failed verifier burns the code too (OAuth 2.1 guidance).
  const spent = await env.DB.prepare('UPDATE oauth_pending SET consumed_at = ? WHERE id = ? AND code_hash = ? AND consumed_at IS NULL AND expires_at > ?').bind(now, row.id, codeHash, now).run();
  if (Number(spent.meta.changes) !== 1) return tokenErr(400, 'invalid_grant');
  const challenge = b64u(new Uint8Array(await sha256(verifier)));
  // Evaluate every check so the response time does not reveal which one failed.
  const okClient = timingSafeEqual(row.client_id, clientId);
  const okRedirect = timingSafeEqual(row.redirect_uri, redirect);
  const okPkce = timingSafeEqual(challenge, row.code_challenge);
  if (!(okClient && okRedirect && okPkce)) return tokenErr(400, 'invalid_grant');
  const access = randomSecret(32);
  await env.DB.prepare('INSERT INTO oauth_token (token_hash, client_id, email, scope, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256hex(access), row.client_id, row.email, row.scope, now + TOKEN_TTL_S * 1000).run();
  return oj(200, { access_token: access, token_type: 'Bearer', expires_in: TOKEN_TTL_S, scope: row.scope }, { Pragma: 'no-cache' });
}

async function revoke(req: Request, env: OAuthEnv): Promise<Response> {
  if (!ctype(req).startsWith('application/x-www-form-urlencoded')) return oerr(400, 'invalid_request', 'content type must be application/x-www-form-urlencoded');
  const text = await readText(req);
  const t = text === null ? '' : new URLSearchParams(text).get('token') ?? '';
  if (!t) return oerr(400, 'invalid_request', 'token is required');
  if (!env.DB) return unavailable();
  await env.DB.prepare('UPDATE oauth_token SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').bind(Date.now(), await sha256hex(t)).run();
  return oj(200, {});
}

// ---- agent identity + claim ----

async function identity(req: Request, env: OAuthEnv, url: URL, origin: string): Promise<Response> {
  if (!ctype(req).startsWith('application/json')) return oerr(415, 'invalid_request', 'content type must be application/json');
  const b = await readJsonObject(req);
  if (!b) return oerr(400, 'invalid_request', 'invalid JSON body');
  if (b.type !== 'service_auth') return oerr(400, 'invalid_request', 'type must be service_auth');
  const email = typeof b.login_hint === 'string' ? b.login_hint.trim().toLowerCase() : '';
  if (!isEmail(email)) return oerr(400, 'invalid_request', 'login_hint must be a valid email address');
  if (!env.DB) return unavailable();
  const id = randomSecret(16);
  let params: AuthParams;
  if (b.client_id === undefined) {
    // No OAuth client: the emailed link only proves the address and lands on the claim page. The challenge is random
    // and nobody holds a matching verifier, so no code from this row can be exchanged.
    params = { client_id: IDENTITY_CLIENT, redirect_uri: `${origin}/oauth/agent/claim?registration_id=${id}`, code_challenge: randomSecret(32), state: null, scope: SCOPE };
  } else {
    const q = new URLSearchParams({ response_type: 'code' });
    for (const k of ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope']) if (typeof b[k] === 'string') q.set(k, b[k] as string);
    const checked = await checkAuthParams(new Request(req.url, { headers: { accept: 'application/json' } }), env.DB, q);
    if (!checked.ok) return checked.res;
    params = checked.p;
  }
  const login = await startLogin(env, origin, params, email, req.headers.get('cf-connecting-ip') ?? 'unknown', id);
  if (login instanceof Response) return login;
  return oj(200, {
    registration_id: login.id,
    registration_type: 'service_auth',
    expires_in: MAGIC_TTL_MS / 1000,
    claim: { verification_uri: `${origin}/oauth/agent/claim?registration_id=${login.id}`, expires_in: MAGIC_TTL_MS / 1000, interval: 5 },
    ...(LOOPBACK.has(url.hostname) ? { dev_magic_url: login.magicUrl } : {}),
  });
}

function claim(req: Request): Response {
  const msg = 'Finish by opening the sign-in link we emailed to the address you gave. The link works once and expires in 15 minutes.';
  if (wantsJson(req)) return oj(200, { status: 'pending_email_verification', message: msg });
  return htmlPage(200, 'Check your email', `<p>${esc(msg)}</p>`);
}

// ---- bearer verification for the write routes ----

const invalidToken = () => oj(401, { ok: false, error: 'invalid_token' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });

/**
 * For a request that carries an Authorization header. Returns the verified email when the bearer is a live token,
 * otherwise the response that stops the request: 401 for anything that is not a live token (never falls through to the
 * anonymous path), 503 when D1 fails (fail closed). Does not consume a rate-limit bucket — the caller applies the
 * per-IP floor first, then takeIdentityWrite, so a bad token touches neither limiter.
 */
export async function verifiedBearer(req: Request, db: D1Database | undefined): Promise<{ email: string } | Response> {
  const m = /^Bearer ([A-Za-z0-9_-]{16,128})$/i.exec((req.headers.get('authorization') ?? '').trim());
  if (!m) return invalidToken();
  if (!db) return unavailable();
  try {
    const hash = await sha256hex(m[1]);
    const now = Date.now();
    const row = await db.prepare('SELECT email FROM oauth_token WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?').bind(hash, now).first<{ email: string }>();
    if (!row?.email) return invalidToken();
    return { email: row.email };
  } catch (e) {
    console.error('bearer check failed:', (e as Error).message);
    return oj(503, { ok: false, error: 'unavailable' });
  }
}

/** One 30/60s write budget per verified email. Every token for that email shares it. Throws on a D1 error (caller fails closed). */
export async function takeIdentityWrite(db: D1Database, email: string, now = Date.now()): Promise<Response | null> {
  const key = `id:${await sha256hex(email.trim().toLowerCase())}`;
  if (!(await take(db, key, TOKEN_WRITES_PER_MIN, 60, now))) return oj(429, { ok: false, error: 'rate_limited' }, { 'Retry-After': '60' });
  return null;
}

// ---- router ----

/** null = not an OAuth path; the caller carries on. */
export async function handleOAuth(req: Request, env: OAuthEnv, url: URL, path: string): Promise<Response | null> {
  const wellKnown = path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-protected-resource';
  if (!wellKnown && path !== '/auth.md' && !path.startsWith('/oauth/')) return null;
  const origin = originOf(url);
  if (!origin) return oerr(400, 'invalid_request', 'host not allowed');
  const m = req.method;
  const read = m === 'GET' || m === 'HEAD';
  const doc = (body: string, type: string) => new Response(m === 'HEAD' ? null : body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
  try {
    switch (path) {
      case '/.well-known/oauth-authorization-server':
        return read ? doc(JSON.stringify(authServerDoc(origin)), 'application/json') : notAllowed('GET, HEAD');
      case '/.well-known/oauth-protected-resource':
        return read ? doc(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: [SCOPE], bearer_methods_supported: ['header'] }), 'application/json') : notAllowed('GET, HEAD');
      case '/auth.md':
        return read ? doc(authMd(origin), 'text/markdown; charset=utf-8') : notAllowed('GET, HEAD');
      case '/oauth/register':
        return m === 'POST' ? await register(req, env) : notAllowed('POST');
      case '/oauth/authorize':
        return m === 'GET' || m === 'POST' ? await authorize(req, env, url, origin) : notAllowed('GET, POST');
      case '/oauth/magic':
        return m === 'GET' ? await magic(url, env) : notAllowed('GET');
      case '/oauth/token':
        return m === 'POST' ? await token(req, env) : notAllowed('POST');
      case '/oauth/revoke':
        return m === 'POST' ? await revoke(req, env) : notAllowed('POST');
      case '/oauth/agent/identity':
        return m === 'POST' ? await identity(req, env, url, origin) : notAllowed('POST');
      case '/oauth/agent/claim':
        return m === 'GET' || m === 'POST' || m === 'HEAD' ? claim(req) : notAllowed('GET, POST');
      default:
        return null;
    }
  } catch (e) {
    console.error('oauth error', path, (e as Error).message); // fail closed; messages never carry a secret
    return unavailable();
  }
}
