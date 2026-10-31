import bots from '../data/bots.json';
import categories from '../data/categories.json';
import related from '../data/related.json';
import trending from '../data/trending.json';
import recent from '../data/recent.json';
import meta from '../data/meta.json';

export interface Bot { id: string; slug: string; code: string; name: string; author: string; description: string; cat: string; cats: string[] }
export interface Category { slug: string; label: string; count: number; purpose: string; updated: string }

export { meta, trending, recent };
export const allBots = bots as Bot[];
export const allCategories = categories as Category[];
export const botBySlug = new Map(allBots.map((b) => [b.slug, b]));
export const categoryBySlug = new Map(allCategories.map((c) => [c.slug, c]));
// A bot listed in two categories belongs to both, so a category page lists every bot whose
// category set contains it.
export const botsByCategory = (slug: string) => allBots.filter((b) => b.cats.includes(slug));
export const botUrl = (b: Bot) => `https://x.ai/bot/${b.code}`;
export const relatedFor = (slug: string) =>
  ((related as Record<string, [string, 's' | 't'][]>)[slug] ?? []).map(([s, why]) => ({ bot: botBySlug.get(s)!, why }));

// Unique <title> and description per bot page. Many listings share a name, so qualify with the
// category, then the author, then a short code prefix, only as far as needed to be unique.
const catLabel = (b: Bot) => categoryBySlug.get(b.cat)!.label;
const titleV: ((b: Bot) => string)[] = [
  (b) => b.name,
  (b) => `${b.name} (${catLabel(b)})`,
  (b) => `${b.name} by ${b.author} (${catLabel(b)})`,
  (b) => `${b.name} by ${b.author} (${catLabel(b)}, ${b.code.slice(0, 6)})`,
];
export const seoTitle = (() => {
  const out = new Map<string, number>();
  for (let v = 0; v < titleV.length; v++) {
    const counts = new Map<string, number>();
    for (const b of allBots) counts.set(titleV[v](b).toLowerCase(), (counts.get(titleV[v](b).toLowerCase()) ?? 0) + 1);
    for (const b of allBots) if (!out.has(b.slug) && (counts.get(titleV[v](b).toLowerCase()) === 1 || v === titleV.length - 1)) out.set(b.slug, v);
  }
  return (b: Bot) => titleV[out.get(b.slug)!](b);
})();
