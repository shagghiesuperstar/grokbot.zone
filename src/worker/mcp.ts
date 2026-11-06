// Stateless Streamable HTTP MCP. JSON responses only.
// Protocols: 2025-11-25 (initialize → notifications/initialized → tools/list/tools/call)
// and 2026-07-28 server/discover. Tools are sorted by name.
import { codeOfId, normalize } from '../lib/search';

export const PROTOCOL_LEGACY = '2025-11-25';
export const PROTOCOL_DISCOVER = '2026-07-28';
const SUPPORTED = [PROTOCOL_DISCOVER, PROTOCOL_LEGACY, '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'grokbot.zone', title: 'GrokBot Zone', version: '1.0.0' };

const READ_ANN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_ANN = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
}

const str = (maxLength: number, extra: Record<string, unknown> = {}) => ({ type: 'string', maxLength, ...extra });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
});
const out = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  additionalProperties: true,
  properties,
  ...(required.length ? { required } : {}),
});

export const TOOLS: Tool[] = [
  {
    name: 'grokbot_check_listed',
    title: 'Check if a bot is listed',
    description: 'Reports whether a Grok bot code is already in the directory. Pass a link or a code.',
    inputSchema: obj({ link: str(200), code: str(64) }),
    outputSchema: out({ listed: { type: 'boolean' }, code: { type: 'string' } }, ['listed']),
    annotations: READ_ANN,
  },
  {
    name: 'grokbot_get_bot',
    title: 'Get one bot',
    description: 'Returns the public record for one bot id.',
    inputSchema: obj({ id: str(160) }, ['id']),
    outputSchema: out({ id: { type: 'string' }, name: { type: 'string' }, link: { type: 'string' } }, ['id', 'name']),
    annotations: READ_ANN,
  },
  {
    name: 'grokbot_get_category',
    title: 'Get one category',
    description: 'Returns the bots filed under one category slug.',
    inputSchema: obj({ slug: str(80) }, ['slug']),
    outputSchema: out({ slug: { type: 'string' }, label: { type: 'string' }, count: { type: 'integer' }, bots: { type: 'array' } }, ['slug']),
    annotations: READ_ANN,
  },
  {
    name: 'grokbot_health',
    title: 'Directory health',
    description: 'Reports whether the directory API and its database are up.',
    inputSchema: obj({}),
    outputSchema: out({ ok: { type: 'boolean' }, d1: { type: 'boolean' } }, ['ok', 'd1']),
    annotations: READ_ANN,
  },
  {
    name: 'grokbot_list_categories',
    title: 'List categories',
    description: 'Returns every category slug, label, count and purpose.',
    inputSchema: obj({}),
    outputSchema: out({ categories: { type: 'array' } }, ['categories']),
    annotations: READ_ANN,
  },
  {
    name: 'grokbot_search',
    title: 'Search bots',
    description: 'Scores public listings by how many query words appear in the name and description. Name matches count double. Optionally filter to one author. Returns at most 10.',
    inputSchema: obj({ query: str(200), category: str(80), author: str(80, { description: 'Filter to one author name (case-insensitive exact match).' }) }, ['query']),
    outputSchema: out({ bots: { type: 'array' } }, ['bots']),
    annotations: READ_ANN,
  },
  {
    name: 'grokbot_submit_bot',
    title: 'Submit a bot',
    description: 'Queues a public Grok bot for listing and sends a receipt to the given email. Uses the same checks and rate limit as the submit form.',
    inputSchema: obj({
      name: str(120, { minLength: 3 }),
      link: str(120),
      category: str(80),
      description: str(500, { minLength: 10 }),
      email: str(254),
      author: str(80),
    }, ['name', 'link', 'category', 'description', 'email']),
    outputSchema: out({ ok: { type: 'boolean' }, id: { type: 'integer' }, status: { type: 'string' }, errors: { type: 'object' } }, ['ok']),
    annotations: WRITE_ANN,
  },
  {
    name: 'grokbot_subscribe',
    title: 'Subscribe to updates',
    description: 'Starts a double opt-in for twice-weekly update emails. Nothing is sent until the confirm link is clicked. Uses the same rate limit as the subscribe form.',
    inputSchema: obj({ email: str(254) }, ['email']),
    outputSchema: out({ ok: { type: 'boolean' }, status: { type: 'string' }, errors: { type: 'object' } }, ['ok']),
    annotations: WRITE_ANN,
  },
  {
    name: 'grokbot_trending',
    title: 'Trending bot ids',
    description: 'Returns bot ids in trending order, optionally for one category.',
    inputSchema: obj({ category: str(80) }),
    outputSchema: out({ ids: { type: 'array', items: { type: 'string' } } }, ['ids']),
    annotations: READ_ANN,
  },
].sort((a, b) => a.name.localeCompare(b.name));

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export interface McpHooks {
  dispatch(req: Request): Promise<Response>;
  submit(req: Request): Promise<Response>;
  subscribe(req: Request): Promise<Response>;
}

const rpc = (id: unknown, result: unknown, status = 200) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const rpcError = (id: unknown, code: number, message: string, status = 200, data?: unknown) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

function originBlocked(req: Request): boolean {
  if (!req.headers.get('authorization') && !req.headers.get('cookie')) return false;
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return host !== 'grokbot.zone' && host !== 'www.grokbot.zone' && host !== 'localhost' && host !== '127.0.0.1';
  } catch {
    return true;
  }
}

function toolResult(id: unknown, structured: unknown, isError: boolean, text: string, status = 200) {
  return rpc(id, {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    isError,
  }, status);
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: 'bad_json', status: res.status, body: text.slice(0, 200) }; }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? 'unknown';
}

/** Write tools forward the caller's own Authorization header; submit()/subscribe() verify it against D1. */
function internalPost(path: string, body: unknown, ip: string, authorization: string | null = null): Request {
  return new Request(`https://grokbot.zone${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(authorization !== null ? { authorization } : {}) },
    body: JSON.stringify(body),
  });
}

async function siteGet(hooks: McpHooks, path: string): Promise<{ status: number; body: unknown }> {
  const res = await hooks.dispatch(new Request(`https://grokbot.zone${path}`));
  return { status: res.status, body: await readJson(res) };
}

function invalid(id: unknown, errors: Record<string, string>) {
  return toolResult(id, { ok: false, errors }, true, Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('; '));
}

function codeFrom(link: unknown, code: unknown): string | null {
  if (typeof code === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(code)) return code;
  if (typeof link === 'string') {
    const m = link.trim().match(/^https:\/\/x\.ai\/bot\/([A-Za-z0-9_-]{4,64})\/?$/i);
    if (m) return m[1];
  }
  return null;
}

interface SearchBot { i: string; n: string; a?: string; d?: string; r?: number; c?: string }

function scoreBots(bots: SearchBot[], query: string, slug: string): { id: string; name: string; author: string; description: string; category: string; score: number }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
  if (!words.length) return [];
  const ranked = bots.map((b) => {
    const name = (b.n ?? '').toLowerCase();
    const desc = (b.d ?? '').toLowerCase();
    const author = normalize(b.a ?? '');
    let score = 0;
    for (const w of words) {
      if (name.includes(w)) score += 2;
      if (desc.includes(w)) score += 1;
      const aw = normalize(w);
      if (aw && author.includes(aw)) score += 1;
    }
    return { id: b.i, name: b.n, author: b.a ?? '', description: b.d ?? '', category: b.c ?? slug, score };
  }).filter((b) => b.score > 0);
  ranked.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
  return ranked.slice(0, 10);
}

function searchResultText(bots: { id: string; name: string }[]): string {
  const lines = [`${bots.length} matches:`];
  for (let i = 0; i < bots.length; i++) {
    const b = bots[i];
    lines.push(`${i + 1}. ${b.name} \u2014 id: ${b.id} \u2014 https://grokbot.zone/bots/${b.id}/`);
  }
  return lines.join('\n');
}

async function callTool(name: string, args: Record<string, unknown>, req: Request, hooks: McpHooks, id: unknown): Promise<Response> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return toolResult(id, { ok: false, error: 'unknown_tool' }, true, `Unknown tool ${name}`);
  if (args && typeof args === 'object') {
    for (const key of Object.keys(args)) {
      if (!(tool.inputSchema.properties as Record<string, unknown>)[key]) return invalid(id, { [key]: 'unexpected property' });
    }
  }
  if (name === 'grokbot_health') {
    const { status, body } = await siteGet(hooks, '/api/health');
    const ok = status === 200 && asRecord(body).ok === true;
    return toolResult(id, body, !ok, ok ? 'ok' : `health ${status}`);
  }
  if (name === 'grokbot_list_categories') {
    const { status, body } = await siteGet(hooks, '/api/v1/categories.json');
    if (status !== 200 || !Array.isArray(body)) return toolResult(id, { ok: false, status }, true, `categories ${status}`);
    return toolResult(id, { categories: body }, false, `${body.length} categories`);
  }
  if (name === 'grokbot_get_category') {
    const slug = args.slug;
    if (typeof slug !== 'string' || !/^[a-z0-9-]{1,80}$/.test(slug)) return invalid(id, { slug: 'required, a category slug' });
    const { status, body } = await siteGet(hooks, `/api/v1/categories/${slug}.json`);
    if (status !== 200) return toolResult(id, { ok: false, status }, true, `category ${status}`);
    return toolResult(id, body, false, `category ${slug}`);
  }
  if (name === 'grokbot_get_bot') {
    const botId = args.id;
    if (typeof botId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(botId)) return invalid(id, { id: 'required' });
    const { status, body } = await siteGet(hooks, `/api/v1/bots/${botId}.json`);
    if (status !== 200) return toolResult(id, { ok: false, status }, true, `bot ${status}`);
    return toolResult(id, body, false, `bot ${botId}`);
  }
  if (name === 'grokbot_trending') {
    const category = args.category;
    if (category !== undefined && (typeof category !== 'string' || !/^[a-z0-9-]{1,80}$/.test(category))) return invalid(id, { category: 'must be a category slug' });
    const { status, body } = await siteGet(hooks, '/api/v1/trending.json');
    if (status !== 200) return toolResult(id, { ok: false, status }, true, `trending ${status}`);
    const doc = asRecord(body);
    const ids = category ? (asRecord(doc.perCategory)[category] ?? null) : doc.global;
    if (!Array.isArray(ids)) return invalid(id, { category: 'unknown category' });
    return toolResult(id, { ids, category: category ?? null }, false, `${ids.length} ids`);
  }
  if (name === 'grokbot_check_listed') {
    const code = codeFrom(args.link, args.code);
    if (!code) return invalid(id, { link: 'pass a link or a code' });
    const { status, body } = await siteGet(hooks, '/api/v1/codes.json');
    if (status !== 200) return toolResult(id, { ok: false, status }, true, `codes ${status}`);
    const codes = asRecord(body).codes;
    const listed = Array.isArray(codes) && codes.includes(code.toLowerCase());
    return toolResult(id, { listed, code: code.toLowerCase() }, false, listed ? 'listed' : 'not listed');
  }
  if (name === 'grokbot_search') {
    const query = args.query;
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 200) return invalid(id, { query: 'required, 2-200 characters' });
    const category = args.category;
    if (category !== undefined && (typeof category !== 'string' || !/^[a-z0-9-]{1,80}$/.test(category))) return invalid(id, { category: 'must be a category slug' });
    const author = args.author;
    if (author !== undefined && (typeof author !== 'string' || author.trim().length === 0 || author.length > 80)) {
      return invalid(id, { author: 'must be an author name of 1-80 characters' });
    }
    const wantAuthor = typeof author === 'string' ? author.trim().toLowerCase() : '';
    const slugs = category ? [category] : await categorySlugs(hooks);
    if (!slugs) return toolResult(id, { ok: false }, true, 'categories unavailable');
    const found: ReturnType<typeof scoreBots> = [];
    for (const slug of slugs) {
      const { status, body } = await siteGet(hooks, `/api/v1/categories/${slug}.json`);
      if (status !== 200) continue;
      const bots = asRecord(body).bots;
      if (!Array.isArray(bots)) continue;
      const candidates = wantAuthor
        ? (bots as SearchBot[]).filter((b) => (b.a ?? '').trim().toLowerCase() === wantAuthor)
        : bots as SearchBot[];
      found.push(...scoreBots(candidates, query, slug));
    }
    found.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name));
    const bots = found.slice(0, 10).map((b) => ({ ...b, link: `https://x.ai/bot/${codeOfId(b.id, slugs)}` }));
    return toolResult(id, { bots }, false, searchResultText(bots));
  }
  if (name === 'grokbot_submit_bot') {
    const errors: Record<string, string> = {};
    for (const key of ['name', 'link', 'category', 'description', 'email']) if (typeof args[key] !== 'string' || !(args[key] as string).trim()) errors[key] = 'required';
    if (Object.keys(errors).length) return invalid(id, errors);
    const body = {
      name: args.name,
      link: args.link,
      category: args.category,
      description: args.description,
      email: args.email,
      ...(typeof args.author === 'string' ? { author: args.author } : {}),
      company_website: '',
      // MCP exemption: a tool call has no form clock. The public skill documents this; REST callers must send the real elapsed time.
      filled_ms: 30000,
    };
    const res = await hooks.submit(internalPost('/api/v1/submissions', body, clientIp(req), req.headers.get('authorization')));
    return mapWrite(id, res);
  }
  if (name === 'grokbot_subscribe') {
    if (typeof args.email !== 'string' || !args.email.trim()) return invalid(id, { email: 'required' });
    const res = await hooks.subscribe(internalPost('/subscribe', { email: args.email, company_website: '' }, clientIp(req), req.headers.get('authorization')));
    return mapWrite(id, res);
  }
  return rpcError(id, -32601, 'Method not found');
}

async function categorySlugs(hooks: McpHooks): Promise<string[] | null> {
  const { status, body } = await siteGet(hooks, '/api/v1/categories.json');
  if (status !== 200 || !Array.isArray(body)) return null;
  return body.map((c) => asRecord(c).slug).filter((s): s is string => typeof s === 'string');
}

async function mapWrite(id: unknown, res: Response): Promise<Response> {
  const body = await readJson(res);
  const ok = res.status >= 200 && res.status < 300;
  const text = ok ? `status ${res.status}` : `error ${res.status}`;
  // 401/429 must be visible to status-gating proxies. Field errors stay HTTP 200 + isError (the MCP shape).
  const status = res.status === 401 || res.status === 429 ? res.status : 200;
  return toolResult(id, body, !ok, text, status);
}

export async function handleMcp(request: Request, hooks: McpHooks): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed', hint: 'POST a JSON-RPC body to this URL. Streamable HTTP, JSON responses, no session.' }) + '\n', {
      status: 405,
      headers: { Allow: 'POST', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  if (originBlocked(request)) {
    return new Response(JSON.stringify({ ok: false, error: 'origin_not_allowed' }) + '\n', {
      status: 403,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  let msg: unknown;
  try { msg = await request.json(); } catch { return rpcError(null, -32700, 'Parse error', 400); }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid Request', 400);
  const rec = msg as Record<string, unknown>;
  const id = rec.id;
  const method = rec.method;
  if (typeof method !== 'string') return rpcError(id ?? null, -32600, 'Invalid Request', 400);
  const headerMethod = request.headers.get('mcp-method');
  if (headerMethod && headerMethod !== method) return rpcError(id ?? null, -32600, 'Mcp-Method does not match the JSON-RPC method', 400);
  const headerVersion = request.headers.get('mcp-protocol-version');
  if (headerVersion && !SUPPORTED.includes(headerVersion)) {
    return rpcError(id ?? null, -32022, 'Unsupported protocol version', 400, { supported: SUPPORTED });
  }
  const isNotification = id === undefined;
  if (method === 'notifications/initialized' || (isNotification && method.startsWith('notifications/'))) {
    return new Response(null, { status: 202 });
  }
  if (method === 'initialize') {
    const params = asRecord(rec.params);
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_LEGACY;
    const protocolVersion = SUPPORTED.includes(asked) && asked !== PROTOCOL_DISCOVER ? asked : PROTOCOL_LEGACY;
    return rpc(id ?? null, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'server/discover') {
    return rpc(id ?? null, {
      resultType: 'complete',
      supportedVersions: [PROTOCOL_DISCOVER, PROTOCOL_LEGACY],
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_INFO.name, version: SERVER_INFO.version } },
      ttlMs: 3600000,
      cacheScope: 'public',
    });
  }
  if (method === 'ping') return rpc(id ?? null, {});
  if (method === 'tools/list') {
    return rpc(id ?? null, {
      tools: TOOLS.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({ name, title, description, inputSchema, outputSchema, annotations })),
    });
  }
  if (method === 'tools/call') {
    const params = asRecord(rec.params);
    const name = params.name;
    const args = asRecord(params.arguments);
    if (typeof name !== 'string') return invalid(id ?? null, { name: 'required' });
    try {
      return await callTool(name, args, request, hooks, id ?? null);
    } catch (e) {
      console.error('mcp tools/call', name, (e as Error).message);
      return rpcError(id ?? null, -32603, 'Internal error');
    }
  }
  return rpcError(id ?? null, -32601, 'Method not found');
}
