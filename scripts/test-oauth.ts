// OAuth 2.1 tests for the Worker (DCR, PKCE S256, email magic link, bearer on MCP writes).
// Same approach as test-worker.ts: bundle the real src/worker/index.ts with esbuild (stub cloudflare:email),
// drive it with a D1 shim over node:sqlite and fake bindings. No network. Usage: pnpm exec tsx scripts/test-oauth.ts
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const ROOT = resolve(import.meta.dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'gz-test-oauth-'));
const stub = join(tmp, 'email-stub.mjs');
writeFileSync(stub, 'export class EmailMessage { constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; } }\n');
const out = join(tmp, 'worker.mjs');
await build({
  entryPoints: [join(ROOT, 'src/worker/index.ts')], outfile: out, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  conditions: ['workerd', 'worker', 'browser'], external: ['node:*'], logLevel: 'warning',
  plugins: [{ name: 'stub-cf-email', setup: (b) => b.onResolve({ filter: /^cloudflare:email$/ }, () => ({ path: stub })) }],
});
const worker = (await import(pathToFileURL(out).href)).default as { fetch(r: Request, e: unknown, c: unknown): Promise<Response> };

// ---- fakes (small copies of the test-worker.ts ones) ----
const SHIPPED = 'ShippedCode1000000000';
const MIGRATIONS = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(join(ROOT, 'migrations', f), 'utf8'));
class FakeD1 {
  db = new DatabaseSync(':memory:');
  constructor() { for (const m of MIGRATIONS) this.db.exec(m); }
  prepare(sql: string) {
    const st = this.db.prepare(sql);
    const bound = (args: unknown[]) => ({
      async first() { const row = (st.get(...(args as never[])) as Record<string, unknown> | undefined) ?? null; return row ? { ...row } : null; },
      async run() { const r = st.run(...(args as never[])); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      async all() { return { results: st.all(...(args as never[])).map((r) => ({ ...(r as object) })) }; },
    });
    return { bind: (...args: unknown[]) => bound(args), ...bound([]) };
  }
  rows(sql: string, ...args: unknown[]) { return this.db.prepare(sql).all(...(args as never[])).map((r) => ({ ...(r as object) })) as Record<string, any>[]; }
}
const mailer = () => { const sent: Record<string, any>[] = []; return { sent, send: async (m: Record<string, unknown>) => { sent.push(m); return { messageId: `m${sent.length}` }; } }; };
const limiter = (max: number) => { const seen = new Map<string, number>(); const keys: string[] = []; return { keys, limit: async ({ key }: { key: string }) => { keys.push(key); const n = (seen.get(key) ?? 0) + 1; seen.set(key, n); return { success: n <= max }; } }; };
function makeEnv(over: Record<string, unknown> = {}) {
  const DB = new FakeD1(); const EMAIL = mailer();
  const env: Record<string, any> = {
    ASSETS: { fetch: async (r: Request | string) => {
      const p = new URL(typeof r === 'string' ? r : r.url).pathname;
      if (p === '/api/v1/categories.json') return Response.json([{ slug: 'privacy-security-scam-protection', name: 'Privacy' }]);
      if (p === '/') return new Response('<!doctype html><title>home</title>', { headers: { 'content-type': 'text/html' } }); // the static site root (the issuer URL)
      if (p === '/api/v1/codes.json') return Response.json({ codes: [SHIPPED.toLowerCase()] });
      return new Response('not found', { status: 404 });
    } },
    DB, EMAIL, SUBMISSIONS_RL: limiter(100), SUBSCRIBE_RL: limiter(100),
    FORM_SUBMIT_ENABLED: '1', EMAIL_SUBMIT_ENABLED: '1', SUBSCRIBE_ENABLED: '1', DIGEST_ENABLED: '0', MIN_FILL_MS: '3000', ...over,
  };
  return env;
}
function makeCtx() { const pending: Promise<unknown>[] = []; return { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, drain: async () => { await Promise.all(pending.splice(0)); } }; }

const PROD = 'https://grokbot.zone';
const LOCAL = 'http://127.0.0.1:8787';
const at = (base: string, path: string, env: unknown, init: RequestInit = {}) => worker.fetch(new Request(base + path, { redirect: 'manual', ...init }), env, makeCtx());
const b64u = (b: Buffer) => b.toString('base64url');
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const GOOD = { name: 'Spam Stopper', author: 'Sam', description: 'Blocks spam calls for you.', link: 'https://x.ai/bot/NewBot-12345000000000', category: 'privacy-security-scam-protection', email: 'me@example.test', company_website: '', filled_ms: 5000 };
const jpost = (base: string, path: string, env: unknown, body: unknown, headers: Record<string, string> = {}) =>
  at(base, path, env, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.9', ...headers }, body: JSON.stringify(body) });
const count = (env: Record<string, any>, table: string) => env.DB.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n as number;

let n = 0; let failed = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); n++; console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${(e as Error).message.split('\n').slice(0, process.env.GZ_VERBOSE ? 12 : 1).join(' | ')}`); }
};

// ---- OAuth helpers ----
const pkce = () => { const verifier = b64u(randomBytes(32)); return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) }; };
let emailSeq = 0;
const freshEmail = () => `user${++emailSeq}@example.test`;
async function register(env: unknown, base = LOCAL, redirect = 'http://127.0.0.1:9999/cb') {
  const res = await jpost(base, '/oauth/register', env, { redirect_uris: [redirect], client_name: 'Test Agent', token_endpoint_auth_method: 'none' });
  assert.equal(res.status, 201, `register ${res.status}`);
  return { client_id: (await res.json() as { client_id: string }).client_id, redirect };
}
const authQuery = (c: { client_id: string; redirect: string }, challenge: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({ response_type: 'code', client_id: c.client_id, redirect_uri: c.redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', ...extra }).toString();
async function login(env: unknown, c: { client_id: string; redirect: string }, challenge: string, base = LOCAL, email = freshEmail()) {
  const res = await jpost(base, `/oauth/authorize?${authQuery(c, challenge)}`, env, { email }, { accept: 'application/json' });
  return { res, body: (await res.json()) as Record<string, any>, email };
}
async function magicToCode(env: unknown, magicUrl: string, base = LOCAL) {
  const u = new URL(magicUrl);
  const res = await at(base, u.pathname + u.search, env);
  return res;
}
async function getToken(env: unknown, c: { client_id: string; redirect: string }, base = LOCAL, email?: string) {
  const { verifier, challenge } = pkce();
  const { body } = await login(env, c, challenge, base, email);
  const mr = await magicToCode(env, body.dev_magic_url, base);
  assert.equal(mr.status, 302);
  const code = new URL(mr.headers.get('location')!).searchParams.get('code')!;
  const tr = await tokenReq(env, { grant_type: 'authorization_code', code, redirect_uri: c.redirect, client_id: c.client_id, code_verifier: verifier }, base);
  assert.equal(tr.status, 200, `token ${tr.status}`);
  return ((await tr.json()) as { access_token: string }).access_token;
}
const tokenReq = (env: unknown, form: Record<string, string>, base = LOCAL) =>
  at(base, '/oauth/token', env, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });

const mcp = (env: unknown, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) =>
  jpost(PROD, '/mcp', env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { accept: 'application/json, text/event-stream', ...headers });
const MCP_SUBMIT = { name: GOOD.name, link: GOOD.link, category: GOOD.category, description: GOOD.description, email: GOOD.email };

// ---- discovery ----
await t('discovery: authorization-server doc has every required key and static values', async () => {
  const res = await at(PROD, '/.well-known/oauth-authorization-server', makeEnv());
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'application/json'); assert.equal(res.headers.get('cache-control'), 'no-store');
  const d = await res.json() as Record<string, any>;
  assert.equal(d.issuer, PROD);
  for (const [k, p] of [['authorization_endpoint', '/oauth/authorize'], ['token_endpoint', '/oauth/token'], ['registration_endpoint', '/oauth/register'], ['revocation_endpoint', '/oauth/revoke']]) assert.equal(d[k], PROD + p, k);
  assert.deepEqual(d.response_types_supported, ['code']); assert.deepEqual(d.grant_types_supported, ['authorization_code']);
  assert.deepEqual(d.code_challenge_methods_supported, ['S256']); assert.deepEqual(d.token_endpoint_auth_methods_supported, ['none']); assert.deepEqual(d.scopes_supported, ['mcp:write']);
  assert.deepEqual(d.agent_auth, {
    skill: `${PROD}/auth.md`, register_uri: `${PROD}/oauth/agent/identity`, identity_endpoint: `${PROD}/oauth/agent/identity`, claim_uri: `${PROD}/oauth/agent/claim`, claim_endpoint: `${PROD}/oauth/agent/claim`,
    revocation_uri: `${PROD}/oauth/revoke`, identity_types_supported: ['service_auth'], assertion_types_supported: ['verified_email'], credential_types_supported: ['access_token'],
  });
});
await t('discovery: protected-resource doc', async () => {
  const res = await at(PROD, '/.well-known/oauth-protected-resource', makeEnv());
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type')!, /^application\/json/);
  assert.deepEqual(await res.json(), { resource: `${PROD}/mcp`, authorization_servers: [PROD], scopes_supported: ['mcp:write'], bearer_methods_supported: ['header'] });
});
await t('discovery: /auth.md is markdown, > 20 bytes, no address, no internal host, names the flow', async () => {
  const res = await at(PROD, '/auth.md', makeEnv());
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
  const body = await res.text(); assert.ok(body.length > 20);
  for (const s of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/oauth/register', 'S256', '/oauth/token', 'grokbot_submit_bot', 'grokbot_subscribe']) assert.ok(body.includes(s), s);
  assert.ok(!/[^\s@]+@[^\s@]+\.[^\s@]+/.test(body), 'no email-shaped text'); assert.ok(!/tail[0-9a-f]+\.ts\.net|\.internal|ss\.tail/.test(body));
});
await t('discovery: every URL in the AS document is served (GET or empty POST is not a 404)', async () => {
  const env = makeEnv();
  const d = await (await at(PROD, '/.well-known/oauth-authorization-server', env)).json();
  const urls = new Set<string>(); const walk = (v: unknown) => { if (typeof v === 'string' && v.startsWith('http')) urls.add(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); }; walk(d);
  assert.ok(urls.size >= 8);
  for (const u of urls) {
    const p = new URL(u); assert.equal(p.origin, PROD, u);
    const g = await at(PROD, p.pathname + p.search, env);
    if (g.status === 404) { const post = await at(PROD, p.pathname + p.search, env, { method: 'POST' }); assert.notEqual(post.status, 404, `${u} 404 on GET and POST`); }
  }
  const r = await at(PROD, '/.well-known/oauth-protected-resource', env); const pr = await r.json() as { resource: string; authorization_servers: string[] };
  assert.equal(pr.authorization_servers[0], (d as { issuer: string }).issuer);
  assert.notEqual((await at(PROD, new URL(pr.resource).pathname, env, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
});
await t('discovery: loopback origin is derived from the request; other hosts get 400 JSON and are never echoed', async () => {
  const env = makeEnv();
  const d = await (await at(LOCAL, '/.well-known/oauth-authorization-server', env)).json() as Record<string, any>;
  assert.equal(d.issuer, LOCAL); assert.equal(d.token_endpoint, `${LOCAL}/oauth/token`); assert.equal(d.agent_auth.claim_uri, `${LOCAL}/oauth/agent/claim`);
  const loc = await (await at('http://localhost:8799', '/.well-known/oauth-protected-resource', env)).json() as Record<string, any>;
  assert.equal(loc.resource, 'http://localhost:8799/mcp');
  for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/auth.md', '/oauth/register', '/oauth/authorize']) {
    const res = await at('https://evil.example', p, env);
    assert.equal(res.status, 400, p); assert.match(res.headers.get('content-type')!, /json/);
    assert.ok(!(await res.text()).includes('evil.example'), p);
  }
});

// ---- DCR ----
await t('DCR: valid public client -> 201 with the fixed shape and no secret', async () => {
  const env = makeEnv();
  const res = await jpost(PROD, '/oauth/register', env, { redirect_uris: ['https://app.example/cb', 'http://localhost:3000/cb?x=1'], client_name: 'A' });
  assert.equal(res.status, 201); const b = await res.json() as Record<string, any>;
  assert.match(b.client_id, /^[A-Za-z0-9_-]{16,}$/); assert.equal(b.client_secret, undefined);
  assert.equal(b.token_endpoint_auth_method, 'none'); assert.deepEqual(b.grant_types, ['authorization_code']); assert.deepEqual(b.response_types, ['code']);
  assert.deepEqual(b.redirect_uris, ['https://app.example/cb', 'http://localhost:3000/cb?x=1']);
});
await t('DCR: rejects http (non-loopback), fragments, wildcards, other schemes, bad auth method, no uris', async () => {
  const env = makeEnv();
  const bad: unknown[] = [
    { redirect_uris: ['http://example.com/cb'] }, { redirect_uris: ['https://app.example/cb#frag'] }, { redirect_uris: ['https://app.example/cb#'] },
    { redirect_uris: ['https://*.example/cb'] }, { redirect_uris: ['https://app.example/*'] }, { redirect_uris: ['javascript:alert(1)'] }, { redirect_uris: ['myapp://cb'] },
    { redirect_uris: ['http://127.0.0.1.evil.example/cb'] }, { redirect_uris: ['https://user:pw@app.example/cb'] }, { redirect_uris: [] }, { redirect_uris: 'https://app.example/cb' }, {},
    { redirect_uris: ['https://app.example/cb'], token_endpoint_auth_method: 'client_secret_basic' }, { redirect_uris: ['https://app.example/cb', 'http://example.com/cb'] },
  ];
  for (const b of bad) assert.equal((await jpost(PROD, '/oauth/register', env, b)).status, 400, JSON.stringify(b));
  assert.equal(count(env, 'oauth_client'), 0);
  assert.equal((await at(PROD, '/oauth/register', env, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status >= 400, true);
});
await t('DCR: 5 redirect_uris of 2048 characters are accepted (documented max)', async () => {
  const env = makeEnv();
  const uris = [0, 1, 2, 3, 4].map((i) => {
    const prefix = `https://app${i}.example/`;
    return prefix + 'a'.repeat(2048 - prefix.length);
  });
  const res = await jpost(PROD, '/oauth/register', env, { redirect_uris: uris });
  const text = await res.text();
  assert.equal(res.status, 201, text.slice(0, 180));
});
await t('DCR: 10 per IP per hour, the 11th is 429; another IP is unaffected; D1 failure -> 503', async () => {
  const env = makeEnv();
  for (let i = 0; i < 10; i++) assert.equal((await jpost(PROD, '/oauth/register', env, { redirect_uris: ['https://app.example/cb'] }, { 'cf-connecting-ip': '5.5.5.5' })).status, 201);
  assert.equal((await jpost(PROD, '/oauth/register', env, { redirect_uris: ['https://app.example/cb'] }, { 'cf-connecting-ip': '5.5.5.5' })).status, 429);
  assert.equal((await jpost(PROD, '/oauth/register', env, { redirect_uris: ['https://app.example/cb'] }, { 'cf-connecting-ip': '6.6.6.6' })).status, 201);
  const env2 = makeEnv(); env2.DB.db.exec('DROP TABLE oauth_rl');
  assert.equal((await jpost(PROD, '/oauth/register', env2, { redirect_uris: ['https://app.example/cb'] })).status, 503);
  assert.equal(count(env2, 'oauth_client'), 0);
});

// ---- authorize ----
await t('authorize GET: valid request -> HTML form with an email field; state is attribute-escaped; no address in the page', async () => {
  const env = makeEnv(); const c = await register(env); const { challenge } = pkce();
  const evil = '"><script>alert(1)</script>';
  const res = await at(LOCAL, `/oauth/authorize?${authQuery(c, challenge, { state: evil })}`, env);
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type')!, /text\/html/);
  const html = await res.text(); assert.match(html, /<input[^>]+name="email"/); assert.ok(!html.includes('<script>alert'), 'state not reflected raw'); assert.ok(!/[^\s@]+@[^\s@]+\.[^\s@]+/.test(html));
});
await t('authorize: plain / missing method, missing challenge, wrong response_type, bad scope, unknown client -> 400', async () => {
  const env = makeEnv(); const c = await register(env); const { challenge } = pkce();
  const q = (over: Record<string, string>, drop: string[] = []) => { const p = new URLSearchParams(authQuery(c, challenge)); for (const [k, v] of Object.entries(over)) p.set(k, v); drop.forEach((k) => p.delete(k)); return p.toString(); };
  const cases = [q({ code_challenge_method: 'plain' }), q({}, ['code_challenge_method']), q({}, ['code_challenge']), q({ response_type: 'token' }), q({ scope: 'admin' }), q({ client_id: 'nope' }), q({ code_challenge: 'short' })];
  for (const query of cases) {
    assert.equal((await at(LOCAL, `/oauth/authorize?${query}`, env)).status, 400, `GET ${query}`);
    assert.equal((await jpost(LOCAL, `/oauth/authorize?${query}`, env, { email: freshEmail() }, { accept: 'application/json' })).status, 400, `POST ${query}`);
  }
  assert.equal(count(env, 'oauth_pending'), 0); assert.equal(env.EMAIL.sent.length, 0);
});
await t('authorize: unregistered redirect_uri is rejected with no Location (no open redirect), GET and POST', async () => {
  const env = makeEnv(); const c = await register(env); const { challenge } = pkce();
  for (const ru of ['https://evil.example/cb', 'http://127.0.0.1:9999/cb/', 'http://127.0.0.1:9999/cb?x=1', 'http://127.0.0.1:9999/CB']) {
    const query = authQuery({ ...c, redirect: ru }, challenge);
    const g = await at(LOCAL, `/oauth/authorize?${query}`, env); assert.equal(g.status, 400); assert.equal(g.headers.get('location'), null);
    const p = await jpost(LOCAL, `/oauth/authorize?${query}`, env, { email: freshEmail() }, { accept: 'application/json' }); assert.equal(p.status, 400); assert.equal(p.headers.get('location'), null);
  }
  assert.equal(env.EMAIL.sent.length, 0);
});
await t('authorize POST: email shape is the submissions.ts shape; JSON and form bodies both work; HTML says "Check your email" with no token', async () => {
  const env = makeEnv(); const c = await register(env); const { challenge } = pkce(); const url = `/oauth/authorize?${authQuery(c, challenge)}`;
  for (const bad of ['', 'nope', 'a b@c.d', 'a@b', '@x.y', 'x'.repeat(250) + '@e.test']) assert.equal((await jpost(LOCAL, url, env, { email: bad }, { accept: 'application/json' })).status, 400, bad);
  assert.equal(env.EMAIL.sent.length, 0);
  const form = await at(LOCAL, url, env, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' }, body: new URLSearchParams({ email: freshEmail() }).toString() });
  assert.equal(form.status, 200); const html = await form.text(); assert.match(html, /Check your email/); assert.ok(!html.includes('/oauth/magic'), 'no token in HTML'); assert.ok(!html.includes('dev_magic_url'));
  assert.equal(env.EMAIL.sent.length, 1);
});
await t('authorize POST: dev_magic_url only on 127.0.0.1 / localhost, never on grokbot.zone even with Accept JSON', async () => {
  const env = makeEnv(); const c = await register(env, LOCAL); const { challenge } = pkce();
  const loc = await login(env, c, challenge, LOCAL); assert.equal(loc.res.status, 200); assert.equal(loc.body.ok, true); assert.match(loc.body.dev_magic_url, new RegExp(`^${LOCAL}/oauth/magic\\?token=[A-Za-z0-9_-]{43}$`));
  const lh = await login(env, { client_id: c.client_id, redirect: c.redirect }, challenge, 'http://localhost:8787'); assert.equal(lh.body.ok, true); assert.match(lh.body.dev_magic_url, /^http:\/\/localhost:8787\/oauth\/magic\?token=/);
  const envP = makeEnv(); const cp = await register(envP, PROD, 'https://app.example/cb');
  const prod = await login(envP, cp, challenge, PROD); assert.equal(prod.res.status, 200); assert.deepEqual(prod.body, { ok: true });
  const sent = envP.EMAIL.sent[0]; assert.equal(sent.to, prod.email); assert.match(sent.text, new RegExp(`${PROD}/oauth/magic\\?token=[A-Za-z0-9_-]{43}`));
  const www = await at('https://www.grokbot.zone', '/oauth/register', envP, { method: 'POST' }); assert.equal(www.status, 301);
});
await t('authorize POST: EMAIL missing or throwing -> 503 and no usable magic row', async () => {
  for (const over of [{ EMAIL: undefined }, { EMAIL: { send: async () => { throw new Error('refused'); } } }]) {
    const env = makeEnv(over); const c = await register(env); const { challenge } = pkce();
    const { res, body } = await login(env, c, challenge); assert.equal(res.status, 503); assert.equal(body.dev_magic_url, undefined);
    assert.equal(env.DB.rows('SELECT * FROM oauth_pending WHERE magic_hash IS NOT NULL').length, 0);
  }
});
await t('authorize POST: does not touch send_log and the magic token is stored only as a sha256', async () => {
  const env = makeEnv(); const c = await register(env); const { challenge } = pkce();
  const { body } = await login(env, c, challenge); const token = new URL(body.dev_magic_url).searchParams.get('token')!;
  assert.equal(count(env, 'send_log'), 0);
  const row = env.DB.rows('SELECT * FROM oauth_pending')[0];
  assert.equal(row.magic_hash, sha256hex(token)); assert.ok(!Object.values(row).some((v) => v === token));
  assert.ok(env.EMAIL.sent[0].text.includes(token));
});
await t('authorize POST: mail-bomb guard (5 sends per address per hour) -> 429', async () => {
  const env = makeEnv(); const c = await register(env); const { challenge } = pkce(); const email = 'target@example.test';
  for (let i = 0; i < 5; i++) assert.equal((await login(env, c, challenge, LOCAL, email)).res.status, 200);
  assert.equal((await login(env, c, challenge, LOCAL, email)).res.status, 429); assert.equal(env.EMAIL.sent.length, 5);
});

// ---- magic + token ----
await t('full flow: DCR + PKCE S256 + magic + token exchange -> Bearer token, hash only in D1', async () => {
  const env = makeEnv(); const c = await register(env); const { verifier, challenge } = pkce();
  const { body, email } = await login(env, c, challenge);
  const mr = await magicToCode(env, body.dev_magic_url); assert.equal(mr.status, 302);
  const loc = new URL(mr.headers.get('location')!); assert.equal(loc.origin + loc.pathname, c.redirect); assert.equal(loc.searchParams.get('state'), 'st-1');
  const code = loc.searchParams.get('code')!; assert.ok(code.length >= 32);
  const tr = await tokenReq(env, { grant_type: 'authorization_code', code, redirect_uri: c.redirect, client_id: c.client_id, code_verifier: verifier });
  assert.equal(tr.status, 200); assert.match(tr.headers.get('cache-control')!, /no-store/);
  const tok = await tr.json() as Record<string, any>;
  assert.equal(tok.token_type, 'Bearer'); assert.equal(tok.expires_in, 3600); assert.equal(tok.scope, 'mcp:write'); assert.match(tok.access_token, /^[A-Za-z0-9_-]{43}$/);
  const rows = env.DB.rows('SELECT * FROM oauth_token'); assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, sha256hex(tok.access_token)); assert.ok(!Object.values(rows[0]).some((v) => v === tok.access_token));
  assert.equal(rows[0].client_id, c.client_id); assert.equal(rows[0].email, email); assert.equal(rows[0].scope, 'mcp:write');
  assert.ok(Math.abs(rows[0].expires_at - (Date.now() + 3600_000)) < 60_000);
  const pend = JSON.stringify(env.DB.rows('SELECT * FROM oauth_pending')); assert.ok(!pend.includes(code) && !pend.includes(new URL(body.dev_magic_url).searchParams.get('token')!));
  assert.ok(!env.DB.rows('SELECT * FROM oauth_client').some((r) => JSON.stringify(r).includes(tok.access_token)));
});
await t('magic: redirect keeps an existing query on the registered URI; state omitted when not given', async () => {
  const env = makeEnv(); const c = await register(env, LOCAL, 'http://127.0.0.1:9999/cb?app=1'); const { challenge } = pkce();
  const res = await jpost(LOCAL, `/oauth/authorize?${authQuery(c, challenge).replace('&state=st-1', '')}`, env, { email: freshEmail() }, { accept: 'application/json' });
  const mr = await magicToCode(env, ((await res.json()) as { dev_magic_url: string }).dev_magic_url);
  const loc = mr.headers.get('location')!; assert.match(loc, /^http:\/\/127\.0\.0\.1:9999\/cb\?app=1&code=[A-Za-z0-9_-]+$/);
});
await t('magic: replay, garbage, and expired tokens -> 400 JSON, no redirect', async () => {
  const env = makeEnv(); const c = await register(env); const { challenge } = pkce();
  const { body } = await login(env, c, challenge);
  assert.equal((await magicToCode(env, body.dev_magic_url)).status, 302);
  const again = await magicToCode(env, body.dev_magic_url); assert.equal(again.status, 400); assert.equal(again.headers.get('location'), null); assert.match(again.headers.get('content-type')!, /json/);
  for (const q of ['', '?token=', '?token=abc', `?token=${'A'.repeat(43)}`]) { const r = await at(LOCAL, `/oauth/magic${q}`, env); assert.equal(r.status, 400, q); assert.equal(r.headers.get('location'), null); }
  const b2 = await login(env, c, challenge); env.DB.db.exec('UPDATE oauth_pending SET expires_at = 1');
  const exp = await magicToCode(env, b2.body.dev_magic_url); assert.equal(exp.status, 400); assert.equal(exp.headers.get('location'), null);
});
await t('token: wrong verifier fails; the code is spent afterwards even for the right verifier', async () => {
  const env = makeEnv(); const c = await register(env); const { verifier, challenge } = pkce();
  const { body } = await login(env, c, challenge); const code = new URL((await magicToCode(env, body.dev_magic_url)).headers.get('location')!).searchParams.get('code')!;
  const form = { grant_type: 'authorization_code', code, redirect_uri: c.redirect, client_id: c.client_id };
  const bad = await tokenReq(env, { ...form, code_verifier: b64u(randomBytes(32)) }); assert.equal(bad.status, 400); assert.equal(((await bad.json()) as { error: string }).error, 'invalid_grant');
  assert.equal((await tokenReq(env, { ...form, code_verifier: verifier })).status, 400);
  assert.equal(count(env, 'oauth_token'), 0);
});
await t('token: replayed code fails and a second token is never minted', async () => {
  const env = makeEnv(); const c = await register(env); const { verifier, challenge } = pkce();
  const { body } = await login(env, c, challenge); const code = new URL((await magicToCode(env, body.dev_magic_url)).headers.get('location')!).searchParams.get('code')!;
  const form = { grant_type: 'authorization_code', code, redirect_uri: c.redirect, client_id: c.client_id, code_verifier: verifier };
  assert.equal((await tokenReq(env, form)).status, 200); assert.equal((await tokenReq(env, form)).status, 400); assert.equal(count(env, 'oauth_token'), 1);
});
await t('token: redirect_uri mismatch, wrong client_id, bad verifier shape, missing fields, wrong grant, wrong content type, expired code all fail', async () => {
  const env = makeEnv(); const c = await register(env); const c2 = await register(env, LOCAL, 'http://127.0.0.1:9998/cb');
  const mint = async () => { const p = pkce(); const { body } = await login(env, c, p.challenge); const code = new URL((await magicToCode(env, body.dev_magic_url)).headers.get('location')!).searchParams.get('code')!; return { ...p, code }; };
  const okForm = (m: { code: string; verifier: string }) => ({ grant_type: 'authorization_code', code: m.code, redirect_uri: c.redirect, client_id: c.client_id, code_verifier: m.verifier });
  let m = await mint(); assert.equal((await tokenReq(env, { ...okForm(m), redirect_uri: 'http://127.0.0.1:9999/cb/' })).status, 400);
  m = await mint(); assert.equal((await tokenReq(env, { ...okForm(m), client_id: c2.client_id })).status, 400);
  m = await mint(); assert.equal((await tokenReq(env, { ...okForm(m), code_verifier: 'short' })).status, 400);
  m = await mint(); assert.equal((await tokenReq(env, { ...okForm(m), code_verifier: m.verifier + '!' })).status, 400);
  m = await mint(); const { code: _c, ...noCode } = okForm(m); assert.equal((await tokenReq(env, noCode)).status, 400);
  m = await mint(); assert.equal((await tokenReq(env, { ...okForm(m), grant_type: 'password' })).status, 400);
  m = await mint(); assert.equal((await jpost(LOCAL, '/oauth/token', env, okForm(m))).status, 400);
  m = await mint(); env.DB.db.exec('UPDATE oauth_pending SET expires_at = 1'); assert.equal((await tokenReq(env, okForm(m))).status, 400);
  assert.equal(count(env, 'oauth_token'), 0);
});
await t('token: a magic token cannot be used as an auth code', async () => {
  const env = makeEnv(); const c = await register(env); const { verifier, challenge } = pkce(); const { body } = await login(env, c, challenge);
  const magic = new URL(body.dev_magic_url).searchParams.get('token')!;
  assert.equal((await tokenReq(env, { grant_type: 'authorization_code', code: magic, redirect_uri: c.redirect, client_id: c.client_id, code_verifier: verifier })).status, 400);
});
await t('revoke: marks the hash revoked, 200 for unknown tokens, and the bearer then gets 401', async () => {
  const env = makeEnv(); const c = await register(env); const token = await getToken(env, c);
  const rv = (tok: string) => at(LOCAL, '/oauth/revoke', env, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tok }).toString() });
  assert.equal((await rv('totally-unknown-token')).status, 200);
  assert.equal((await rv(token)).status, 200); assert.ok(env.DB.rows('SELECT revoked_at FROM oauth_token')[0].revoked_at > 0);
  const res = await jpost(PROD, '/api/v1/submissions', env, GOOD, { authorization: `Bearer ${token}` }); assert.equal(res.status, 401);
});

// ---- agent identity / claim ----
await t('agent identity: service_auth -> 200 shape, claim URL has no secret, mail sent, dev_magic_url loopback only; bad input 400', async () => {
  const env = makeEnv();
  const res = await jpost(LOCAL, '/oauth/agent/identity', env, { type: 'service_auth', login_hint: freshEmail() }); assert.equal(res.status, 200);
  const b = await res.json() as Record<string, any>;
  assert.match(b.registration_id, /^[A-Za-z0-9_-]{16,}$/); assert.equal(b.registration_type, 'service_auth'); assert.equal(b.expires_in, 900);
  assert.deepEqual(b.claim, { verification_uri: `${LOCAL}/oauth/agent/claim?registration_id=${b.registration_id}`, expires_in: 900, interval: 5 });
  assert.match(b.dev_magic_url, /^http:\/\/127\.0\.0\.1:8787\/oauth\/magic\?token=/); assert.equal(env.EMAIL.sent.length, 1);
  const magic = await magicToCode(env, b.dev_magic_url); assert.equal(magic.status, 302); assert.ok(magic.headers.get('location')!.startsWith(`${LOCAL}/oauth/agent/claim?registration_id=${b.registration_id}`));
  assert.equal(new URL(magic.headers.get('location')!).searchParams.get('code'), null);
  const prod = await (await jpost(PROD, '/oauth/agent/identity', env, { type: 'service_auth', login_hint: freshEmail() })).json() as Record<string, any>;
  assert.equal(prod.dev_magic_url, undefined); assert.equal(prod.claim.verification_uri, `${PROD}/oauth/agent/claim?registration_id=${prod.registration_id}`);
  for (const bad of [{ type: 'other', login_hint: 'a@b.co' }, { type: 'service_auth', login_hint: 'nope' }, { login_hint: 'a@b.co' }, {}]) assert.equal((await jpost(PROD, '/oauth/agent/identity', env, bad)).status, 400, JSON.stringify(bad));
});
await t('agent claim: GET and POST answer 200 (HTML or JSON), never 404', async () => {
  const env = makeEnv();
  for (const [method, accept] of [['GET', 'text/html'], ['GET', 'application/json'], ['POST', 'text/html'], ['POST', 'application/json']]) {
    const res = await at(PROD, '/oauth/agent/claim?registration_id=abc', env, { method, headers: { accept } }); assert.equal(res.status, 200, `${method} ${accept}`);
    assert.match(res.headers.get('content-type')!, accept.includes('json') ? /json/ : /html/);
  }
});

// ---- MCP / REST writes ----
await t('read tool with no Authorization still succeeds; tools/list is unchanged', async () => {
  const env = makeEnv();
  const res = await mcp(env, 'grokbot_list_categories', {}); assert.equal(res.status, 200);
  const r = (await res.json() as any).result; assert.equal(r.isError, false); assert.equal(r.structuredContent.categories.length, 1);
  const bad = await mcp(env, 'grokbot_list_categories', {}, { authorization: 'Bearer garbage' }); assert.equal((await bad.json() as any).result.isError, false, 'reads ignore Authorization');
});
await t('anonymous submit still accepted through REST and MCP; invalid email still isError; IP limiter key consumed', async () => {
  const env = makeEnv();
  assert.equal((await jpost(PROD, '/api/v1/submissions', env, GOOD)).status, 201); assert.deepEqual(env.SUBMISSIONS_RL.keys, ['9.9.9.9:submit']);
  const ok = await mcp(env, 'grokbot_submit_bot', { ...MCP_SUBMIT, link: 'https://x.ai/bot/Anothr-12345000000000' }); assert.equal((await ok.json() as any).result.isError, false);
  const bad = await mcp(env, 'grokbot_submit_bot', { ...MCP_SUBMIT, email: 'not-an-email' }); assert.equal((await bad.json() as any).result.isError, true);
  assert.equal(count(env, 'submissions'), 2);
  assert.equal((await jpost(PROD, '/subscribe', env, { email: 'sub@example.test', company_website: '' })).status, 201);
});
await t('valid bearer on submit: identity bucket used, IP floor consumed, validation still runs, row stored', async () => {
  const env = makeEnv(); const c = await register(env); const token = await getToken(env, c); const auth = { authorization: `Bearer ${token}` };
  const res = await jpost(PROD, '/api/v1/submissions', env, GOOD, auth); assert.equal(res.status, 201);
  assert.deepEqual(env.SUBMISSIONS_RL.keys, ['9.9.9.9:submit'], 'IP floor consumed under a valid token');
  const email = env.DB.rows('SELECT email FROM oauth_token')[0].email as string;
  const rl = env.DB.rows('SELECT * FROM oauth_rl WHERE k = ?', `id:${sha256hex(email)}`); assert.equal(rl.length, 1); assert.equal(rl[0].n, 1);
  assert.equal((await jpost(PROD, '/api/v1/submissions', env, { ...GOOD, link: 'https://x.ai/bot/Other-12345000000000', email: 'bad' }, auth)).status, 400);
  assert.equal((await jpost(PROD, '/api/v1/submissions', env, { ...GOOD, link: 'https://x.ai/bot/Third-12345000000000', company_website: 'spam.example' }, auth)).status, 400);
  assert.equal((await jpost(PROD, '/api/v1/submissions', env, { ...GOOD, link: 'https://x.ai/bot/Fourth-1234500000000', filled_ms: 10 }, auth)).status, 400);
  assert.equal(count(env, 'submissions'), 1); assert.equal(env.DB.rows('SELECT n FROM oauth_rl WHERE k = ?', `id:${sha256hex(email)}`)[0].n, 4);
  const viaMcp = await mcp(env, 'grokbot_submit_bot', { ...MCP_SUBMIT, link: 'https://x.ai/bot/ViaMcp-12345000000000' }, auth); assert.equal((await viaMcp.json() as any).result.isError, false);
  assert.ok(env.SUBMISSIONS_RL.keys.every((k: string) => k === '9.9.9.9:submit')); assert.equal(count(env, 'submissions'), 2);
  const badMcp = await mcp(env, 'grokbot_submit_bot', { ...MCP_SUBMIT, email: 'not-an-email' }, auth); assert.equal((await badMcp.json() as any).result.isError, true);
});
await t('valid bearer on subscribe: still a double opt-in (pending + confirm mail), IP floor consumed', async () => {
  const env = makeEnv(); const c = await register(env); const token = await getToken(env, c); const auth = { authorization: `Bearer ${token}` };
  const ctx = makeCtx();
  const res = await worker.fetch(new Request(`${PROD}/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ email: 'Reader@Example.test', company_website: '' }) }), env, ctx);
  assert.equal(res.status, 201); assert.deepEqual(await res.json(), { ok: true, status: 'pending_confirm' }); await ctx.drain();
  assert.deepEqual(env.DB.rows('SELECT email, status FROM subscribers'), [{ email: 'reader@example.test', status: 'pending' }]);
  assert.ok(env.EMAIL.sent.some((m: any) => m.to === 'reader@example.test' && /confirm/i.test(m.text)));
  assert.deepEqual(env.SUBSCRIBE_RL.keys, ['unknown:subscribe'], 'IP floor consumed under a valid token');
  const viaMcp = await mcp(env, 'grokbot_subscribe', { email: 'nope' }, auth); assert.equal((await viaMcp.json() as any).result.isError, true);
});
await t('invalid bearer on a write -> 401 invalid_token, nothing stored, no fall-through to the anonymous limiter (REST and MCP)', async () => {
  const env = makeEnv(); const c = await register(env); const good = await getToken(env, c);
  const variants = ['Bearer garbage', 'Bearer ' + 'A'.repeat(43), 'Basic dXNlcjpwdw==', 'Bearer', `bearer ${good}x`, ''];
  for (const a of variants) {
    const r1 = await jpost(PROD, '/api/v1/submissions', env, GOOD, { authorization: a }); assert.equal(r1.status, 401, `submit [${a}]`); assert.deepEqual(await r1.json(), { ok: false, error: 'invalid_token' });
    const r2 = await jpost(PROD, '/subscribe', env, { email: 'x@example.test', company_website: '' }, { authorization: a }); assert.equal(r2.status, 401, `subscribe [${a}]`);
    const r3 = await mcp(env, 'grokbot_submit_bot', MCP_SUBMIT, { authorization: a }); assert.equal(r3.status, 401, `mcp [${a}]`); const j = (await r3.json() as any).result; assert.equal(j.isError, true); assert.equal(j.structuredContent.error, 'invalid_token');
    const r4 = await jpost(PROD, '/api/submit', env, GOOD, { authorization: a }); assert.equal(r4.status, 401);
  }
  assert.equal(count(env, 'submissions'), 0); assert.equal(count(env, 'bots'), 0); assert.equal(count(env, 'subscribers'), 0);
  assert.deepEqual(env.SUBMISSIONS_RL.keys, []); assert.deepEqual(env.SUBSCRIBE_RL.keys, []);
});
await t('expired bearer -> 401', async () => {
  const env = makeEnv(); const c = await register(env); const token = await getToken(env, c); env.DB.db.exec('UPDATE oauth_token SET expires_at = 1');
  assert.equal((await jpost(PROD, '/api/v1/submissions', env, GOOD, { authorization: `Bearer ${token}` })).status, 401);
});
await t('bearer bucket: 30 writes per 60 s per verified email, the 31st is 429 with Retry-After; a different email is unaffected; D1 failure -> 503', async () => {
  const env = makeEnv(); const c = await register(env); const token = await getToken(env, c); const other = await getToken(env, c);
  const auth = { authorization: `Bearer ${token}` };
  for (let i = 0; i < 30; i++) assert.equal((await jpost(PROD, '/api/v1/submissions', env, { ...GOOD, email: 'bad' }, auth)).status, 400, `write ${i + 1}`);
  const lim = await jpost(PROD, '/api/v1/submissions', env, { ...GOOD, email: 'bad' }, auth); assert.equal(lim.status, 429); assert.ok(lim.headers.get('retry-after'));
  assert.equal((await jpost(PROD, '/api/v1/submissions', env, { ...GOOD, email: 'bad' }, { authorization: `Bearer ${other}` })).status, 400);
  env.DB.db.exec('UPDATE oauth_rl SET window_start = window_start - 61000'); // the window rolls over
  assert.equal((await jpost(PROD, '/api/v1/submissions', env, { ...GOOD, email: 'bad' }, auth)).status, 400);
  env.DB.db.exec('DROP TABLE oauth_rl');
  assert.equal((await jpost(PROD, '/api/v1/submissions', env, GOOD, auth)).status, 503); assert.equal(count(env, 'submissions'), 0);
});
await t('a foreign Origin with Authorization is still 403 before the tool runs; no Origin works', async () => {
  const env = makeEnv(); const c = await register(env); const token = await getToken(env, c);
  const res = await mcp(env, 'grokbot_submit_bot', MCP_SUBMIT, { authorization: `Bearer ${token}`, origin: 'https://evil.example' }); assert.equal(res.status, 403); assert.equal(count(env, 'submissions'), 0);
  const ok = await mcp(env, 'grokbot_submit_bot', MCP_SUBMIT, { authorization: `Bearer ${token}` }); assert.equal((await ok.json() as any).result.isError, false);
});
await t('no Authorization header: the IP limiter path still returns 429 when exhausted', async () => {
  const env = makeEnv({ SUBMISSIONS_RL: limiter(1) });
  assert.equal((await jpost(PROD, '/api/v1/submissions', env, GOOD)).status, 201);
  assert.equal((await jpost(PROD, '/api/v1/submissions', env, { ...GOOD, link: 'https://x.ai/bot/Second-1234500000000' })).status, 429);
});
await t('two tokens for the same email share one 30/min write bucket; a different email does not', async () => {
  const env = makeEnv({ SUBMISSIONS_RL: limiter(1000), AUTH_SUBMIT_RL: limiter(1000) });
  const c = await register(env);
  const email = freshEmail();
  const otherEmail = freshEmail();
  const a = await getToken(env, c, LOCAL, email);
  const b = await getToken(env, c, LOCAL, email);
  const other = await getToken(env, c, LOCAL, otherEmail);
  const bad = { ...GOOD, email: 'bad' };
  for (let i = 0; i < 30; i++) assert.equal((await jpost(PROD, '/api/v1/submissions', env, bad, { authorization: `Bearer ${a}` })).status, 400, `write ${i + 1}`);
  const again = await jpost(PROD, '/api/v1/submissions', env, bad, { authorization: `Bearer ${b}` });
  assert.equal(again.status, 429, 'minting a second token must not mint another 30/min');
  assert.ok(again.headers.get('retry-after'));
  const shared = env.DB.rows('SELECT n FROM oauth_rl WHERE k = ?', `id:${sha256hex(email)}`);
  assert.equal(shared.length, 1, 'bucket must be keyed on the verified email, not the token hash');
  assert.equal(shared[0].n, 30);
  assert.equal(env.DB.rows("SELECT k FROM oauth_rl WHERE k LIKE 'tok:%'").length, 0, 'a token hash must not be its own write bucket');
  assert.equal((await jpost(PROD, '/api/v1/submissions', env, bad, { authorization: `Bearer ${other}` })).status, 400, 'a different email keeps its own budget');
  assert.equal(env.DB.rows('SELECT n FROM oauth_rl WHERE k = ?', `id:${sha256hex(otherEmail)}`)[0].n, 1);
});
await t('per-IP floor still rejects a valid bearer once that IP cap is spent', async () => {
  const floor = limiter(1);
  const env = makeEnv({ SUBMISSIONS_RL: floor });
  const c = await register(env);
  const token = await getToken(env, c);
  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await jpost(PROD, '/api/v1/submissions', env, { ...GOOD, email: 'bad' }, auth)).status, 400);
  const second = await jpost(PROD, '/api/v1/submissions', env, { ...GOOD, email: 'bad' }, auth);
  assert.equal(second.status, 429, 'a valid token must not remove the per-IP floor');
  assert.ok(second.headers.get('retry-after'));
  assert.ok(floor.keys.length >= 2, 'the IP limiter must actually be called');
  assert.equal(env.DB.rows("SELECT n FROM oauth_rl WHERE k LIKE 'id:%'")[0].n, 1, 'the 429 is the IP floor, not a spent identity bucket');
});
await t('a token raises the submit ceiling above the anonymous per-IP cap; the raised IP floor still bites', async () => {
  const anon = limiter(2);
  const raised = limiter(5);
  const env = makeEnv({ SUBMISSIONS_RL: anon, AUTH_SUBMIT_RL: raised });
  const c = await register(env);
  const token = await getToken(env, c);
  const auth = { authorization: `Bearer ${token}` };
  const bad = { ...GOOD, email: 'bad' };
  for (let i = 0; i < 5; i++) assert.equal((await jpost(PROD, '/api/v1/submissions', env, bad, auth)).status, 400, `auth write ${i + 1}`);
  assert.equal((await jpost(PROD, '/api/v1/submissions', env, bad, auth)).status, 429);
  assert.deepEqual(anon.keys, [], 'a bearer must not spend the anonymous 5/min bucket');
  assert.equal(raised.keys.length, 6);
});

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
