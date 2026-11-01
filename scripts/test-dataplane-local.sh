#!/usr/bin/env bash
# Spec 07 section 4, the `wrangler dev` half: local D1 only (no --remote), no upstream traffic.
# The cron is triggered with `throttled_until` set, so it makes zero requests to the platform but still runs
# the hourly job that fills trending / recent. Needs a fresh `pnpm build`. Usage: scripts/test-dataplane-local.sh
set -u
cd "$(dirname "$0")/.."
W="npx --yes wrangler@4.123.0"
PORT=${PORT:-8792}; B="http://localhost:$PORT"; LOG=$(mktemp); PASS=0; FAIL=0; PID=
LOCAL_COMPAT=${LOCAL_COMPAT:-2026-08-18}
LITE=$(mktemp -d); rsync -a --exclude='/bots/' --exclude='/api/v1/bots/' --exclude='/search/' --exclude='/categories/' dist/ "$LITE/"
# one real bot page so /bots/<id>/ has an asset to serve
FIRST=$(python3 -c "import json;b=json.load(open('src/data/bots.json'));print(b[0]['slug'],b[0]['code'],b[1]['slug'],b[1]['code'])")
read -r SLUG CODE SLUG2 CODE2 <<<"$FIRST"
for s in "$SLUG" "$SLUG2"; do mkdir -p "$LITE/bots/$s"; cp "dist/bots/$s/index.html" "$LITE/bots/$s/index.html"; done
check() { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); printf '%-62s %-14s %-14s PASS\n' "$1" "$2" "$3"; else FAIL=$((FAIL+1)); printf '%-62s %-14s %-14s FAIL\n' "$1" "$2" "$3"; fi; }
stop() { [[ -n "$PID" ]] && kill "$PID" 2>/dev/null; sleep 1; local l; for l in $(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null); do kill "$l" 2>/dev/null; done; PID=; }
trap stop EXIT
sql() { $W d1 execute grokbot-zone --local --json --command "$1" 2>/dev/null | python3 -c 'import json,sys; r=json.load(sys.stdin)[0]["results"]; print(json.dumps(r,separators=(",",":")))'; }
code() { curl -s -m 20 -o /dev/null -w '%{http_code}' "${@:2}" "$B$1"; }
UA='Mozilla/5.0 (Macintosh) AppleWebKit/605 Safari/605'

$W d1 execute grokbot-zone --local --command "DROP TABLE IF EXISTS bots; DROP TABLE IF EXISTS bot_daily; DROP TABLE IF EXISTS visit_seen; DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS submissions; DROP TABLE IF EXISTS subscribers; DROP TABLE IF EXISTS send_log; DROP TABLE IF EXISTS d1_migrations;" >/dev/null 2>&1
$W d1 migrations apply grokbot-zone --local >/dev/null 2>&1
SEED=$(npx tsx scripts/seed-d1.ts --dry | sed 's/.*-> //'); $W d1 execute grokbot-zone --local --file "$SEED" >/dev/null 2>&1
check "seed rows (local)" "$(python3 -c "import json;print(len(json.load(open('src/data/bots.json'))))")" "$(sql 'SELECT COUNT(*) AS n FROM bots' | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["n"])')"
# O13: the count is captured after the FIRST seed and compared after the second run. GZ_TEST_EXTRA_ROW=1 makes the
# second run insert one extra row, which proves this check can fail.
AFTER_FIRST=$(sql 'SELECT COUNT(*) AS n FROM bots')
SEED2="$SEED"
if [[ -n "${GZ_TEST_EXTRA_ROW:-}" ]]; then SEED2=$(mktemp); cp "$SEED" "$SEED2"; echo "INSERT INTO bots(code_lc, code, source, status, first_seen) VALUES('zzdupezzdupezzdupezz1','zzdupezzdupezzdupezz1','seed','live','2026-10-30');" >> "$SEED2"; fi
$W d1 execute grokbot-zone --local --file "$SEED2" >/dev/null 2>&1
check "seed run twice: count unchanged" "$AFTER_FIRST" "$(sql 'SELECT COUNT(*) AS n FROM bots')"
$W d1 execute grokbot-zone --local --command "INSERT INTO meta(k,v) VALUES('throttled_until','2099-01-01T00:00:00Z'); INSERT INTO meta(k,v) VALUES('discovery_last_run','2026-11-01T00:00:00Z');" >/dev/null 2>&1

: > "$LOG"
$W dev --port $PORT --test-scheduled --compatibility-date "$LOCAL_COMPAT" --assets "$LITE" --var NOREF_TOKENS:zzfaketokenzz --var TELEMETRY_START:"$(date -u +%F)" >"$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 90); do curl -s -o /dev/null "$B/api/flags" && break; sleep 1; done

check "health before cron: ok" true "$(curl -s "$B/api/health" | python3 -c 'import json,sys;print(str(json.load(sys.stdin)["ok"]).lower())')"
check "trending page before cron: static fallback (snapshot copy)" 1 "$(curl -s "$B/trending/" | grep -c 'A dated snapshot')"
check "cron */10 (throttled, no upstream)" 200 "$(code '/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*')"
sleep 4
H=$(curl -s "$B/api/health")
check "health liveness.last_run set" true "$(echo "$H" | python3 -c 'import json,sys;print(str(bool(json.load(sys.stdin)["liveness"]["last_run"])).lower())')"
check "health live count = seed count" "$(python3 -c "import json;print(len(json.load(open('src/data/bots.json'))))")" "$(echo "$H" | python3 -c 'import json,sys;print(json.load(sys.stdin)["liveness"]["live"])')"
check "health throttled_until shown" 2099 "$(echo "$H" | python3 -c 'import json,sys;print(json.load(sys.stdin)["liveness"]["throttled_until"][:4])')"
T=$(curl -s "$B/api/v1/trending.json")
check "trending.json method.window_days" 14 "$(echo "$T" | python3 -c 'import json,sys;print(json.load(sys.stdin)["method"]["window_days"])')"
check "trending.json global = 12 seed prior bots" 12 "$(echo "$T" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["global"]))')"
check "recent.json has bots" true "$(curl -s "$B/api/v1/recent.json" | python3 -c 'import json,sys;print(str(len(json.load(sys.stdin)["bots"])>0).lower())')"
check "signals/daily.json 200" 200 "$(code /api/v1/signals/daily.json)"
check "catalog/changes.json has added+dead" true "$(curl -s "$B/api/v1/catalog/changes.json" | python3 -c 'import json,sys;j=json.load(sys.stdin);print(str("added" in j and "dead" in j).lower())')"
P=$(curl -s "$B/trending/")
check "trending page: live note" 1 "$(echo "$P" | grep -c 'Updated hourly')"
check "trending page: 12 cards, no static snapshot copy" "12 0" "$(echo "$P" | grep -o '<article class="card panel gz-botcard">' | wc -l | tr -d ' ') $(echo "$P" | grep -c 'A dated snapshot')"
check "home: trending rail live (12 cards) + recent rail cards" "12 8" "$(curl -s "$B/" | python3 -c '
import sys,re
h=sys.stdin.read()
t=re.search(r"data-live=\"?trending-rail\"?[^>]*>(.*?)</ul>",h,re.S).group(1); r=re.search(r"data-live=\"?recent-rail\"?[^>]*>(.*?)</ul>",h,re.S).group(1)
print(t.count("<article"), r.count("<article"))')"
check "recent page: live note" 1 "$(curl -s "$B/recent/" | grep -c 'Newest additions to grokbot.zone first')"
$W d1 execute grokbot-zone --local --command "UPDATE bots SET status='dead' WHERE code_lc=lower('$CODE2'); DELETE FROM meta WHERE k='trending_at';" >/dev/null 2>&1
code '/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*' >/dev/null; sleep 4
check "dead bot page -> 410" 410 "$(code "/bots/$SLUG2/")"
check "dead bot page text" 1 "$(curl -s "$B/bots/$SLUG2/" | grep -q 'This bot is no longer shared' && echo 1 || echo 0)"
check "conditional GET (If-None-Match/If-Modified-Since): live list still 200" 200 "$(code /trending/ -H 'If-None-Match: "x"' -H 'If-Modified-Since: Sat, 01 Nov 2026 00:00:00 GMT')"
check "conditional GET: dead bot page still 410" 410 "$(code "/bots/$SLUG2/" -H 'If-None-Match: "x"' -H 'If-Modified-Since: Sat, 01 Nov 2026 00:00:00 GMT')"
check "live bot page still 200" 200 "$(code "/bots/$SLUG/")"
check "/go/<live> HEAD -> 302" 302 "$(curl -sI -o /dev/null -w '%{http_code}' -A "$UA" "$B/go/$CODE")"
check "/go/<live> Location" "https://x.ai/bot/$CODE" "$(curl -sI -A "$UA" "$B/go/$CODE" | tr -d '\r' | awk -F': ' 'tolower($1)=="location"{print $2}')"
check "/go/<unknown> -> 404" 404 "$(code /go/zzzzzzzzzzzzzzzzzzzz0)"
check "/go/<live> GET (human) -> 302" 302 "$(code "/go/$CODE" -A "$UA" -H 'cf-connecting-ip: 203.0.113.5')"
code "/go/$CODE" -A "$UA" -H 'cf-connecting-ip: 203.0.113.5' >/dev/null
code "/bots/$SLUG/" -A "$UA" -H 'cf-connecting-ip: 203.0.113.5' >/dev/null
sleep 2
check "opens=1 views=1 after repeats (once per visitor per day)" '[{"o":1,"v":1}]' "$(sql "SELECT SUM(opens) AS o, SUM(views) AS v FROM bot_daily")"
check "visit_seen holds no raw IP" 0 "$(sql "SELECT COUNT(*) AS n FROM visit_seen WHERE vh LIKE '%203.0%'" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["n"])')"
check "robots.txt Disallow /go/" 1 "$(curl -s "$B/robots.txt" | grep -c '^Disallow: /go/')"
check "switches in health all 0" "0 0 0 0" "$(curl -s "$B/api/health" | python3 -c 'import json,sys;print(" ".join(json.load(sys.stdin)["switches"].values()))')"
echo "test-dataplane-local: PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]]
