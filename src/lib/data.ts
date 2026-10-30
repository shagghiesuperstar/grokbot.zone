import bots from '../data/bots.json';
import categories from '../data/categories.json';
import related from '../data/related.json';
import trending from '../data/trending.json';
import recent from '../data/recent.json';
import meta from '../data/meta.json';

export interface Bot { id: string; slug: string; code: string; name: string; author: string; description: string; cat: string }
export interface Category { slug: string; label: string; count: number; purpose: string; updated: string }

export { meta, trending, recent };
export const allBots = bots as Bot[];
export const allCategories = categories as Category[];
export const botBySlug = new Map(allBots.map((b) => [b.slug, b]));
export const categoryBySlug = new Map(allCategories.map((c) => [c.slug, c]));
export const botsByCategory = (slug: string) => allBots.filter((b) => b.cat === slug);
export const botUrl = (b: Bot) => `https://x.ai/bot/${b.code}`;
export const relatedFor = (slug: string) =>
  ((related as Record<string, [string, 's' | 't'][]>)[slug] ?? []).map(([s, why]) => ({ bot: botBySlug.get(s)!, why }));
