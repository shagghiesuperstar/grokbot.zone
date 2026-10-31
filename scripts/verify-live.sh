#!/usr/bin/env bash
# Post-deploy check: fetches pages from a deployed origin and asserts the build is serving.
# Usage: scripts/verify-live.sh <origin>      e.g. scripts/verify-live.sh https://grokbot.zone
# Exit 0 = every check passed, 1 = a check failed, 2 = usage.
set -euo pipefail
ORIGIN="${1:-}"
[ -n "$ORIGIN" ] || { echo "usage: $0 <origin>" >&2; exit 2; }
ORIGIN="${ORIGIN%/}"

# A fresh Worker version can take a moment to serve, so retry before failing.
fetch() {
  local url="$ORIGIN$1" body status
  body="$(mktemp)"
  status="$(curl -sS -o "$body" -w '%{http_code}' --retry 5 --retry-delay 5 --retry-all-errors "$url" || true)"
  if [ "$status" != "200" ]; then
    echo "FAIL: $url returned HTTP ${status:-000}" >&2
    rm -f "$body"
    return 1
  fi
  cat "$body"
  rm -f "$body"
}
# <loc> values are absolute; keep only the path so every fetch targets the origin under test.
paths() { grep -o "<loc>[^<]*$1[^<]*</loc>" <<< "$2" | sed 's|<loc>||; s|</loc>||; s|https\{0,1\}://[^/]*||'; }
fail() { echo "FAIL: $1" >&2; exit 1; }

home="$(fetch /)"
grep -q '<title>GrokBot Zone' <<< "$home" || fail "home page title missing"
grep -q 'https://grok.com/refer/bot?code=B4ZFFHHS64AC' <<< "$home" || fail "referral link missing from home page"

sitemap="$(fetch /sitemap-0.xml)"
category_path="$(paths '/categories/' "$sitemap" | grep -v '^/categories/$' | sed -n '1p')"
[ -n "$category_path" ] || fail "no category URL in deployed sitemap"
grep -q '<h1' <<< "$(fetch "$category_path")" || fail "category heading missing at $category_path"

bot_paths="$(paths '/bots/' "$sitemap" | grep -v '^/bots/$')"
bot_path="$(sed -n '1p' <<< "$bot_paths")"
[ -n "$bot_path" ] || fail "no bot URL in deployed sitemap"
grep -q '<h1' <<< "$(fetch "$bot_path")" || fail "bot heading missing at $bot_path"

# The search index, the sitemap and the home page must all describe the same set of bots.
index="$(fetch /search/index.json)"
total="$(grep -o '"totalBots":[0-9]*' <<< "$index" | head -1 | cut -d: -f2)"
[ -n "$total" ] || fail "search index missing totalBots"
sitemap_bots="$(grep -c . <<< "$bot_paths")"
[ "$sitemap_bots" = "$total" ] || fail "sitemap lists $sitemap_bots bot URLs, search index says $total bots"

# Backend layer: static discovery pages, read API, feeds, Worker health, and the dark-state submit route.
for p in /trending/ /recent/ /api/; do grep -q '<h1' <<< "$(fetch "$p")" || fail "heading missing at $p"; done
api_total="$(grep -o '"totalBots":[0-9]*' <<< "$(fetch /api/v1/index.json)" | head -1 | cut -d: -f2)"
[ "$api_total" = "$total" ] || fail "/api/v1/index.json says $api_total bots, search index says $total"
grep -q 'jsonfeed.org/version/1.1' <<< "$(fetch /feed.json)" || fail "/feed.json version missing"
grep -q '<feed xmlns=' <<< "$(fetch /feed.xml)" || fail "/feed.xml is not an Atom feed"
grep -q '"ok":true' <<< "$(fetch /api/health)" || fail "/api/health not ok"
grep -qiE '<form[^>]+action="/api/submit"' <<< "$(fetch /submit/)" || fail "/submit/ form missing"

echo "PASS: $ORIGIN verified (home, category page, bot page, $total bots in sitemap and search index, referral link)"
