# GrokBot Zone

A static, searchable directory of public Grok bot listings, live at https://grokbot.zone.

- 7,415 listings in 26 function categories, as a dated snapshot (see `data/corpus/index.json`, `asOf`).
- Search, categories, Trending, Recent, Related, a page for every bot, FAQ, submit page.
- Trending and Recent come from committed, dated signal files in `data/signals/`. There is no live popularity feed, and the site says so.

## Develop

```bash
pnpm install
pnpm build      # validates the corpus, generates site data, builds static HTML into dist/
pnpm preview    # serves dist/
```

`pnpm build` first runs `scripts/build-data.ts` (fails loudly, naming the file and record, on any malformed record), `scripts/build-trending.ts`, and copies the Rive WASM runtime into `public/riv/`.

Other scripts: `pnpm check:contrast` (WCAG ratio for every text colour pair), `pnpm riv:build` (re-author the Rive assets with the Rive CLI), `scripts/assert-search.sh [origin]` (browser DOM assertions for search).

## Layout

```
data/            committed corpus and dated signals (input)
scripts/         data pipeline, contrast check, Rive source generator
rive/            RML sources for the motion assets
src/             Astro pages, components, search and related logic
public/riv/      hero-grid.riv, bot-pulse.riv
public/_worker.js/  minimal edge handler (www redirect, security headers)
```

Bot URLs use the dataset id. Where two ids differ only by letter case, the later one gets a numeric suffix so paths stay unique on case-insensitive systems.

## Deploy

Cloudflare Workers with static assets, custom domains `grokbot.zone` and `www.grokbot.zone` (see `wrangler.toml`).

```bash
pnpm build && pnpm deploy
```

`.github/workflows/deploy.yml` builds and deploys on every push to `main`. It needs two repository secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token must be a scoped Cloudflare API token with **Workers Scripts: Edit** and **DNS: Edit** for the `grokbot.zone` zone. No credential is stored in this repository.
