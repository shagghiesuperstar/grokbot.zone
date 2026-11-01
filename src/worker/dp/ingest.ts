// D15/D18: read a bot page head, scrub it, and decide what the catalog does with it.
import { stripEmails } from '../../lib/strip-emails';
import { classify, type Classifier } from './classify';

export const CODE_RE = /^[A-Za-z0-9_-]{21}$/;
export const UA = 'GrokBotZone/1.0 (+https://grokbot.zone/faq/)';
export const botUrl = (code: string) => `https://x.ai/bot/${code}`;

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENT[e.toLowerCase()] ?? m;
  });

export interface Head { canonicalCode: string | null; name: string; author: string; description: string }

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] ?? m[3]) : null;
};

/** F3: canonical, og:title ("<Name> by <Author>") and og:description from the first part of the page. */
export function parseHead(html: string): Head {
  const end = html.toLowerCase().indexOf('</head>');
  const head = end >= 0 ? html.slice(0, end) : html;
  let canonical: string | null = null;
  const og: Record<string, string> = {};
  for (const m of head.matchAll(/<(link|meta)\b[^>]*>/gi)) {
    const tag = m[0];
    if (m[1].toLowerCase() === 'link') {
      if ((attr(tag, 'rel') ?? '').toLowerCase() === 'canonical') canonical = attr(tag, 'href');
    } else {
      const p = attr(tag, 'property') ?? attr(tag, 'name');
      const c = attr(tag, 'content');
      if (p && c !== null && !(p in og)) og[p.toLowerCase()] = c;
    }
  }
  const cm = canonical ? /\/bot\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/.exec(canonical) : null;
  const title = decodeEntities(og['og:title'] ?? '').replace(/\s+/g, ' ').trim();
  const i = title.lastIndexOf(' by ');
  return {
    canonicalCode: cm && CODE_RE.test(cm[1]) ? cm[1] : null,
    name: (i > 0 ? title.slice(0, i) : title).trim(),
    author: i > 0 ? title.slice(i + 4).trim() : '',
    description: decodeEntities(og['og:description'] ?? '').replace(/\s+/g, ' ').trim(),
  };
}

/** Read a response body only until the head ends (or `max` bytes), then cancel the stream. */
export async function readHead(res: Response, max = 16384): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
      if (/<\/head>/i.test(out) || out.length >= max) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return out;
}

/** D18: the denylist comes only from the Worker secret; an empty list means ingest is closed. */
export const denylist = (secret: string | undefined): string[] =>
  (secret ?? '').split('|').map((t) => t.trim().toLowerCase()).filter(Boolean);
const hits = (text: string, list: string[]) => { const t = text.toLowerCase(); return list.some((w) => t.includes(w)); };

export interface Scrubbed { name: string; author: string; description: string; excluded: boolean }
/** Strip email addresses; an author hit blanks the author; a name or description hit excludes the bot. */
export function scrub(f: { name: string; author: string; description: string }, list: string[]): Scrubbed {
  const name = stripEmails(f.name).slice(0, 200);
  let author = stripEmails(f.author).slice(0, 200);
  const description = stripEmails(f.description).slice(0, 2000);
  if (hits(author, list)) author = '';
  return { name, author, description, excluded: hits(name, list) || hits(description, list) };
}

export interface Ingested extends Scrubbed { category: string | null; code: string }
export function ingest(head: Head, requestedCode: string, list: string[], model: Classifier): Ingested | null {
  if (!head.name) return null;
  const s = scrub(head, list);
  return { ...s, code: requestedCode, category: s.excluded ? null : classify(model, s.name, s.description) };
}
