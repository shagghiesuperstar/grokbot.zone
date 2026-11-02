# GrokBot Zone

A static, searchable directory of public Grok bot listings, live at https://grokbot.zone.

<!-- counts:start -->
- 7,292 distinct bots published from a raw corpus snapshot of 7,414 listings, in 26 function categories, as of 2026-10-28 (see `data/corpus/index.json`).
<!-- counts:end -->
- Search, categories, Trending, Recent, Related, a page for every bot, FAQ, submit page.
- Trending and Recent come from committed, dated signal files in `data/signals/`. There is no live popularity feed, and the site says so.

## Develop

```bash
pnpm install
pnpm build      # validates the corpus, generates site data, builds static HTML into dist/
pnpm preview    # serves dist/
```

`pnpm build` first runs `scripts/build-data.ts` (fails loudly, naming the file and record, on any malformed record), `scripts/build-trending.ts`, `scripts/sync-readme.ts` (writes the counts above from the generated data), `scripts/assert-counts.ts` (fails if a published number drifts from the data it describes), and copies the Rive WASM runtime into `public/riv/`.

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

`data/corpus/` is a raw snapshot of the upstream listings: one record per (category, bot)
listing, so a bot that belongs to two categories appears there twice, and the same bot can
appear twice with a code that differs only in letter case. The build merges those into one
record per bot, so every bot has exactly one page and one URL. A bot in two categories is
listed in both, so the category listings add up to more than the number of bots.

Two counts, two layers, and they are never interchangeable:

<!-- layers:start -->
- `data/corpus/index.json` `rawTotalBots` (7,414) is the **raw snapshot**: listing records.
- `src/data/meta.json` `totalBots` (7,292) is the **published** count: distinct bots.
- `src/data/meta.json` `totalListings` (7,331) is the category listings: a bot in two
  categories is listed in both, so it is counted twice.
<!-- layers:end -->

`scripts/assert-counts.ts` fails the build if any of those three drifts from the data it
describes, and `scripts/sync-readme.ts` writes the counts above from the generated files
so the prose cannot drift either.

## New bots need no deploy

The Worker's `*/10` job finds bots and writes them to D1. A bot that has no static page gets its page rendered from D1 into the built `/bot-template/` (never indexed itself, answered 404 publicly), and search, category pages, the feeds and the sitemap merge D1's live and dead bots at request time. A submitted bot link becomes a pending row and is handled like a discovered one, with no person approving it. `.github/workflows/refresh.yml` only backs the live catalog up into `data/live/` once a day; it does not deploy.

## Deploy

Cloudflare Workers with static assets, custom domains `grokbot.zone` and `www.grokbot.zone` (see `wrangler.toml`).

```bash
pnpm build && pnpm deploy
```

`.github/workflows/deploy.yml` builds and checks on every push to `main` but deploys **only when started by hand** (`workflow_dispatch` from `main`); a push never deploys. The manual deploy needs two repository secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token must be a scoped Cloudflare API token with **Workers Scripts: Edit** and **DNS: Edit** for the `grokbot.zone` zone. No credential is stored in this repository.

## Update emails (dark) and acknowledgments

- `SUBSCRIBE_ENABLED` and `DIGEST_ENABLED` stay `"0"` until the owner approves the sample emails. Unsubscribe: the link in a mail opens a confirm page (a GET changes nothing); the button, or an RFC 8058 one-click `POST` with `List-Unsubscribe=One-Click`, unsubscribes.
- `MAIL_POSTAL_ADDRESS` is the optional postal address printed in the footer of the confirm and digest mails. It is **not** in `wrangler.toml` (this repo is public): the operator sets it as a Worker secret, `wrangler secret put MAIL_POSTAL_ADDRESS`. It is **optional**: when empty or unset the digest sends normally and the footer address line is omitted entirely.
- Acknowledgment mails: an email submission is acknowledged only when Cloudflare's first `Authentication-Results` shows `spf=pass` for the envelope address and the header `From` is that same single address; otherwise the submission is stored and nothing is sent. All acks (email and form) share one budget of `ACK_DAILY_BUDGET` (default 200) per UTC day.
