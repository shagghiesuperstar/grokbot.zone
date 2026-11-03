// Agent discovery documents and HTML-to-markdown negotiation.
// Served by the Worker so content-types match the scanners. No postal location and no mailbox
// in these bodies (assert-no-emails scans dist text; the contact mailbox stays in the Worker-only security.txt).
import { SITE } from '../lib/submissions';

export const LINK_HEADER =
  '</.well-known/api-catalog>; rel="api-catalog", </openapi.json>; rel="service-desc", </llms.txt>; rel="describedby"; type="text/markdown", </.well-known/ai-catalog.json>; rel="ai-catalog", </mcp/server-card>; rel="mcp-server-card"';

const SKILL_PATH = '/.well-known/agent-skills/grokbot-zone-onboarding/SKILL.md';
const MCP_URL = `${SITE}/mcp`;

export interface AssetEnv {
  ASSETS: { fetch(r: Request | string): Promise<Response> };
}

export function isHtml(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
}

function mediaQ(accept: string, type: string): number {
  let best = 0;
  for (const part of accept.split(',')) {
    const [raw, ...params] = part.split(';').map((s) => s.trim());
    if (raw.toLowerCase() !== type) continue;
    const q = params.find((p) => p.toLowerCase().startsWith('q='));
    const n = q ? Number(q.slice(2)) : 1;
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best;
}

/** True only when the client explicitly asks for markdown at least as strongly as HTML. */
export function wantsMarkdown(req: Request): boolean {
  const accept = req.headers.get('accept') ?? '';
  if (!accept.toLowerCase().includes('text/markdown')) return false;
  return mediaQ(accept, 'text/markdown') >= mediaQ(accept, 'text/html');
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function textOf(s: string): string {
  return decode(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
}

/** Enough of a page to be markdown: title, headings, links, list items. Scripts and styles are dropped. */
export function htmlToMarkdown(html: string): string {
  const title = textOf(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  return structuredMarkdown(html, title);
}

function structuredMarkdown(html: string, title: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, inner) => `\n${'#'.repeat(Number(n))} ${textOf(inner)}\n\n`);
  s = s.replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const label = textOf(inner);
    return label ? `[${label}](${href})` : href;
  });
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${textOf(inner)}`);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|li|tr)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decode(s).replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const head = title ? `# ${title}\n\n` : '';
  return `${head}${s}\n`;
}

const text = (body: string, type: string, status = 200) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=300' },
  });

const jsonDoc = (body: unknown, type: string) =>
  text(JSON.stringify(body) + '\n', type);

export const SERVER_CARD = {
  name: 'grokbot.zone',
  title: 'GrokBot Zone',
  version: '1.0.0',
  description: 'Search and list public Grok bot listings. Read tools need no account. Submit and subscribe use the same limits as the site forms.',
  websiteUrl: `${SITE}/`,
  serverInfo: { name: 'grokbot.zone', version: '1.0.0', title: 'GrokBot Zone' },
  remotes: [{ type: 'streamable-http', url: MCP_URL }],
};

const LLMS = `# GrokBot Zone

> A searchable directory of public Grok bot listings. Agents can search, read, submit and subscribe with no browser.

The catalog is a snapshot, refreshed Monday and Thursday. A submitted bot is queued and checked before it is public. This site is not a store. The contact path is the submit form.

## Products / Services
- [Categories](${SITE}/categories/): bots grouped by the job they do
- [Search](${SITE}/bots/): find a bot by name or job
- [Submit a bot](${SITE}/submit/): list a public Grok bot
- [Read API](${SITE}/api/): static JSON catalog

## Policies
- [FAQ](${SITE}/faq/): what the directory lists, and what it does not run or host

## Help
- [For AI agents](${SITE}/agents/): MCP endpoint, HTTP API and the onboarding skill
- [Submit](${SITE}/submit/): the contact path on this site

## Agent context
- Prices and stock: not a store. Listing is free.
- Actions: MCP at ${MCP_URL} (Streamable HTTP, JSON responses). Read tools need no auth. Submit and subscribe use the same rate limits and double opt-in as the site forms.

## Optional
- [Full agent notes](${SITE}/llms-full.txt)
- [OpenAPI](${SITE}/openapi.json)
- [API catalog](${SITE}/.well-known/api-catalog)
`;

const LLMS_FULL = `${LLMS}
## MCP tools
POST ${MCP_URL}. Protocol 2025-11-25 (initialize, notifications/initialized, tools/list, tools/call) and 2026-07-28 (server/discover). Stateless. GET returns 405.

| Tool | Input | Effect |
|---|---|---|
| grokbot_health | none | Worker and database check |
| grokbot_list_categories | none | Category slugs, labels, counts |
| grokbot_get_category | slug | Bots in one category |
| grokbot_search | query, optional category | Up to 5 bots scored on name and description |
| grokbot_trending | optional category | Ordered bot ids |
| grokbot_get_bot | id | One bot record |
| grokbot_check_listed | link or code | Whether that bot is already listed |
| grokbot_submit_bot | name, link, category, description, email, optional author | Queue a listing. Same handler as the form |
| grokbot_subscribe | email | Double opt-in. Nothing is sent until the confirm link is clicked |

## HTTP reads
- GET /api/v1/index.json
- GET /api/v1/categories.json
- GET /api/v1/categories/{slug}.json
- GET /api/v1/trending.json
- GET /api/v1/recent.json
- GET /api/v1/bots/{id}.json
- GET /api/v1/codes.json
- GET /api/health
- GET /feed.json and GET /feed.xml

## HTTP writes
- POST /api/v1/submissions (alias POST /api/submit), JSON, content-type application/json
- POST /subscribe, JSON

Errors are JSON \`{ok:false, error}\` or \`{ok:false, errors}\`. Send \`Accept: application/problem+json\` for an RFC 9457 body.
`;

const PROBLEM = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
  },
  required: ['type', 'title', 'status'],
  additionalProperties: true,
};
const ERR_JSON = {
  type: 'object',
  properties: { ok: { const: false }, error: { type: 'string' }, errors: { type: 'object', additionalProperties: { type: 'string' } } },
  required: ['ok'],
  additionalProperties: true,
};
const errorContent = {
  'application/json': { schema: ERR_JSON },
  'application/problem+json': { schema: PROBLEM },
};

export const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'GrokBot Zone',
    version: '1.0.0',
    summary: 'Read the public Grok bot directory, submit a bot, or subscribe to updates.',
    description: 'Static JSON reads plus two write endpoints. Write errors are JSON by default. Send Accept: application/problem+json for an RFC 9457 problem body.',
  },
  servers: [{ url: SITE }],
  paths: {
    '/api/health': { get: op('getHealth', 'Worker and database health', { ok: { type: 'boolean' }, d1: { type: 'boolean' } }, ['ok', 'd1']) },
    '/api/flags': { get: op('getFlags', 'Which write features are switched on', { form: { type: 'boolean' }, subscribe: { type: 'boolean' }, email: { type: 'boolean' } }, ['form', 'subscribe', 'email']) },
    '/api/v1/index.json': { get: op('getApiIndex', 'Endpoint map, asOf and total bot count', { asOf: { type: 'string' }, totalBots: { type: 'integer' } }, ['asOf', 'totalBots']) },
    '/api/v1/categories.json': { get: op('listCategories', 'Every category', { type: 'array', items: { type: 'object' } }) },
    '/api/v1/categories/{slug}.json': { get: op('getCategory', 'Bots in one category', { slug: { type: 'string' }, bots: { type: 'array' } }, ['slug'], [{ name: 'slug', in: 'path', required: true, schema: { type: 'string', maxLength: 80 } }]) },
    '/api/v1/trending.json': { get: op('getTrending', 'Ordered bot ids, global and per category', { global: { type: 'array', items: { type: 'string' } } }, ['global']) },
    '/api/v1/recent.json': { get: op('getRecent', 'Categories in refresh order', { type: 'object' }) },
    '/api/v1/bots/{id}.json': { get: op('getBot', 'One bot record', { id: { type: 'string' }, name: { type: 'string' }, link: { type: 'string' } }, ['id', 'name'], [{ name: 'id', in: 'path', required: true, schema: { type: 'string', maxLength: 160 } }]) },
    '/api/v1/codes.json': { get: op('listCodes', 'Every listed bot code, lowercased', { codes: { type: 'array', items: { type: 'string' } } }, ['codes']) },
    '/api/v1/submissions': { post: writeOp('submitBot', 'Queue a public Grok bot for listing', submissionSchema()) },
    '/subscribe': { post: writeOp('subscribe', 'Start a double opt-in for update emails', { type: 'object', additionalProperties: false, required: ['email'], properties: { email: { type: 'string', format: 'email', maxLength: 254 }, company_website: { type: 'string', maxLength: 0 } } }) },
  },
};

function op(operationId: string, summary: string, schema: unknown, required?: string[], parameters?: unknown[]) {
  const respSchema = required ? { type: 'object', properties: schema, required, additionalProperties: true } : schema;
  return {
    operationId,
    summary,
    ...(parameters ? { parameters } : {}),
    responses: {
      '200': { description: 'OK', content: { 'application/json': { schema: respSchema } } },
      '404': { description: 'Not found', content: errorContent },
      '503': { description: 'Not ready or disabled', content: errorContent },
    },
  };
}

function submissionSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'link', 'category', 'description', 'email'],
    properties: {
      name: { type: 'string', minLength: 3, maxLength: 120 },
      author: { type: 'string', maxLength: 80 },
      link: { type: 'string', maxLength: 120 },
      category: { type: 'string', maxLength: 80 },
      description: { type: 'string', minLength: 10, maxLength: 500 },
      email: { type: 'string', format: 'email', maxLength: 254 },
      company_website: { type: 'string', maxLength: 0 },
      filled_ms: { type: 'integer', minimum: 3000 },
    },
  };
}

function writeOp(operationId: string, summary: string, schema: unknown) {
  return {
    operationId,
    summary,
    requestBody: { required: true, content: { 'application/json': { schema } } },
    responses: {
      '201': { description: 'Accepted', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, status: { type: 'string' } }, required: ['ok'] } } } },
      '200': { description: 'Already pending', content: { 'application/json': { schema: { type: 'object' } } } },
      '400': { description: 'Invalid fields', content: errorContent },
      '409': { description: 'Already listed, pending, or subscribed', content: errorContent },
      '415': { description: 'Content type must be application/json', content: errorContent },
      '429': { description: 'Rate limited', content: errorContent },
      '503': { description: 'Disabled or limiter unavailable', content: errorContent },
    },
  };
}

function apiCatalog() {
  return {
    linkset: [
      {
        anchor: `${SITE}/api/v1/index.json`,
        'service-desc': [{ href: `${SITE}/openapi.json`, type: 'application/vnd.oai.openapi+json' }],
        'service-doc': [{ href: `${SITE}/api/`, type: 'text/html' }, { href: `${SITE}/agents/`, type: 'text/html' }],
        status: [{ href: `${SITE}/api/health`, type: 'application/json' }],
        'mcp-server': [{ href: MCP_URL, type: 'application/json' }],
      },
    ],
  };
}

function aiCatalog(skillUrl: string) {
  const entry = (name: string, displayName: string, type: string, url: string) => ({
    id: `urn:air:grokbot.zone:discovery:${name}`,
    displayName,
    type,
    url,
  });
  return {
    specVersion: '0.1',
    host: { name: 'grokbot.zone', url: `${SITE}/` },
    entries: [
      entry('mcp-server-card', 'MCP server card', 'application/mcp-server-card+json', `${SITE}/mcp/server-card`),
      entry('openapi', 'OpenAPI description', 'application/vnd.oai.openapi+json', `${SITE}/openapi.json`),
      entry('llms', 'llms.txt', 'text/markdown', `${SITE}/llms.txt`),
      entry('onboarding-skill', 'Onboarding skill', 'text/markdown', skillUrl),
    ],
  };
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function securityTxt(): string {
  const exp = new Date(Date.now() + 180 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `Contact: mailto:submit@grokbot.zone\nExpires: ${exp}\nPreferred-Languages: en\nCanonical: ${SITE}/.well-known/security.txt\n`;
}

function allowGet(req: Request): Response | null {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }) + '\n', {
    status: 405,
    headers: { Allow: 'GET, HEAD', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function head(req: Request, res: Response): Response {
  if (req.method !== 'HEAD') return res;
  const headers = new Headers(res.headers);
  if (!headers.has('content-length')) headers.set('content-length', '0');
  return new Response(null, { status: res.status, headers });
}

/** Discovery documents the Worker must serve with a specific content-type. Null = not our path. */
export async function agentResponse(request: Request, env: AssetEnv, path: string): Promise<Response | null> {
  const denied = allowGet(request);
  const skillUrl = `${SITE}${SKILL_PATH}`;
  if (path === '/sitemap.xml') {
    if (denied) return denied;
    const asset = await env.ASSETS.fetch(new Request(new URL('/sitemap-index.xml', request.url), { headers: request.headers }));
    if (!asset.ok) return new Response('sitemap unavailable\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    const body = await asset.text();
    return head(request, text(body, 'application/xml; charset=utf-8'));
  }
  if (path === '/llms.txt') return denied ?? head(request, text(LLMS, 'text/markdown; charset=utf-8'));
  if (path === '/llms-full.txt') return denied ?? head(request, text(LLMS_FULL, 'text/markdown; charset=utf-8'));
  if (path === '/openapi.json') return denied ?? head(request, jsonDoc(OPENAPI, 'application/vnd.oai.openapi+json; charset=utf-8'));
  if (path === '/.well-known/api-catalog') return denied ?? head(request, jsonDoc(apiCatalog(), 'application/linkset+json; charset=utf-8'));
  if (path === '/.well-known/ai-catalog.json') return denied ?? head(request, jsonDoc(aiCatalog(skillUrl), 'application/ai-catalog+json; charset=utf-8'));
  if (path === '/.well-known/mcp/server-card.json' || path === '/mcp/server-card') {
    return denied ?? head(request, jsonDoc(SERVER_CARD, 'application/mcp-server-card+json; charset=utf-8'));
  }
  if (path === '/.well-known/security.txt') {
    if (denied) return denied;
    return head(request, text(securityTxt(), 'text/plain; charset=utf-8'));
  }
  if (path === SKILL_PATH) {
    if (denied) return denied;
    const asset = await env.ASSETS.fetch(new Request(new URL(SKILL_PATH, request.url)));
    if (!asset.ok) return new Response('skill missing\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    const body = await asset.text();
    return head(request, text(body.endsWith('\n') ? body : body + '\n', 'text/markdown; charset=utf-8'));
  }
  if (path === '/.well-known/agent-skills/index.json') {
    if (denied) return denied;
    const asset = await env.ASSETS.fetch(new Request(new URL(SKILL_PATH, request.url)));
    if (!asset.ok) return new Response(JSON.stringify({ ok: false, error: 'skill_missing' }) + '\n', { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    const body = await asset.text();
    const digest = `sha256:${await sha256(body)}`;
    const index = {
      $schema: 'https://agentskills.io/schema/index.json',
      skills: [{
        name: 'grokbot-zone-onboarding',
        type: 'skill',
        description: 'Use when finding or listing bots on grokbot.zone.',
        url: skillUrl,
        digest,
      }],
    };
    return head(request, jsonDoc(index, 'application/json; charset=utf-8'));
  }
  return null;
}
