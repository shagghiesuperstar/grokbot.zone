// D19 classifier runtime: tokenise, sum the learned token weights per category, take the argmax.
// Below the acceptance rule the category is null (the bot is still listed, just in no category).
export const tokenize = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).map((t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));

export interface Classifier { cats: string[]; min: number; margin: number; tokens: Record<string, number[]> }

export function classify(model: Classifier, name: string, description: string): string | null {
  const s = new Array(model.cats.length).fill(0);
  for (const t of new Set(tokenize(`${name} ${description}`))) {
    const e = model.tokens[t];
    if (e) for (let i = 0; i < e.length; i += 2) s[e[i]] += e[i + 1];
  }
  let best = 0, second = 0, bc = -1;
  s.forEach((v, c) => { if (v > best) { second = best; best = v; bc = c; } else if (v > second) second = v; });
  return bc >= 0 && best >= model.min && best - second >= model.margin ? model.cats[bc] : null;
}
