// D27/O9: a bot with no static page gets the same page, filled from D1. The template is built by Astro from the
// same BotArticle component as every static bot page; this module only fills its data-f hooks. Every platform
// string goes in as text (HTMLRewriter escapes it) or through esc().
import categories from '../../data/categories.json';
import { esc } from './serve';
import { botId } from './util';

const LABEL = new Map((categories as { slug: string; label: string }[]).map((c) => [c.slug, c.label]));
export const TEMPLATE_PATH = '/bot-template/';

export interface PageRow { code: string; name: string; author: string; description: string; category: string | null; cats: string | null; first_seen: string }

/** The category slugs a bot belongs to, known ones only, primary first. */
export function catsOf(r: Pick<PageRow, 'category' | 'cats'>): string[] {
  const all = [r.category, ...(r.cats ? r.cats.split(',') : [])].filter((s): s is string => !!s && LABEL.has(s));
  return [...new Set(all)];
}

export function seoLabel(r: PageRow): string {
  const cat = r.category ? LABEL.get(r.category) : undefined;
  return `${r.name}${r.author ? ` by ${r.author}` : ''}${cat ? ` (${cat})` : ''}`;
}

/** Fill the template response with one bot. The result is a 200 HTML response with the static page's head. */
export function renderBotPage(tpl: Response, r: PageRow): Response {
  const id = botId(r.category, r.code);
  const path = `/bots/${id}/`;
  const url = `https://grokbot.zone${path}`;
  const slugs = catsOf(r);
  const cat = slugs[0] ? LABEL.get(slugs[0])! : null;
  const date = (r.first_seen || '').slice(0, 10);
  const label = seoLabel(r);
  const title = `${label} | Grok bot | GrokBot Zone`;
  const description = `${label}: a Grok bot${cat ? ` in ${cat}` : ''}. First listed ${date}.`;
  const ld = [
    { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: r.name, description, url: `https://x.ai/bot/${r.code}`, ...(cat ? { applicationCategory: cat } : {}),
      ...(r.author ? { author: { '@type': 'Person', name: r.author } } : {}), operatingSystem: 'Web', mainEntityOfPage: url },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://grokbot.zone/' },
      ...(slugs[0] ? [{ '@type': 'ListItem', position: 2, name: cat, item: `https://grokbot.zone/categories/${slugs[0]}/` }] : []),
      { '@type': 'ListItem', position: slugs[0] ? 3 : 2, name: r.name, item: url },
    ] },
  ].map((o) => JSON.stringify(o).replace(/</g, '\\u003c'));
  let ldAt = 0;
  const attr = (name: string, value: string) => ({ element(e: Element) { e.setAttribute(name, value); } });
  const text = (v: string) => ({ element(e: Element) { e.setInnerContent(v); } });
  const drop = { element(e: Element) { e.remove(); } };
  const rw = new HTMLRewriter()
    .on('meta[name="robots"]', drop) // the template is noindex; a filled page is not
    .on('title', text(title))
    .on('meta[name="description"]', attr('content', description))
    .on('meta[property="og:title"]', attr('content', title))
    .on('meta[property="og:description"]', attr('content', description))
    .on('meta[property="og:url"]', attr('content', url))
    .on('link[rel="canonical"]', attr('href', url))
    .on('script[type="application/ld+json"]', { element(e) { e.setInnerContent(ld[ldAt++] ?? '{}', { html: true }); } })
    .on('[data-f="crumb"]', slugs[0] ? {} : drop)
    .on('[data-f="crumb-link"]', slugs[0] ? { element(e) { e.setAttribute('href', `/categories/${slugs[0]}/`); e.setInnerContent(cat!); } } : {})
    .on('[data-f="name"]', text(r.name))
    .on('[data-f="by"]', r.author ? text(`by ${r.author}`) : drop)
    .on('[data-f="desc"]', text(r.description))
    .on('[data-f="cats-row"]', slugs.length ? {} : drop)
    .on('[data-f="cats-row"] dt', text(slugs.length === 1 ? 'Category' : 'Categories'))
    .on('[data-f="cats"]', { element(e) { e.setInnerContent(slugs.map((s) => `<a href="/categories/${esc(s)}/">${esc(LABEL.get(s)!)}</a>`).join(' · '), { html: true }); } })
    .on('[data-f="author-row"]', r.author ? {} : drop)
    .on('[data-f="author"]', text(r.author))
    .on('[data-f="date-label"]', text('First listed'))
    .on('[data-f="date"]', { element(e) { e.setAttribute('datetime', date); e.setInnerContent(date); } })
    .on('[data-f="open"]', attr('href', `/go/${r.code}`))
    .on('[data-f="share"]', { element(e) { e.setAttribute('data-title', r.name); e.setAttribute('data-url', url); } })
    .on('[data-f="note"]', text(`This description is a snapshot from ${date}. The bot's own page has the current details.`));
  const out = rw.transform(tpl);
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, s-maxage=3600' });
  return new Response(out.body, { status: 200, headers });
}
