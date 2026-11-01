#!/usr/bin/env bash
# Spec 08 section 2, the `wrangler dev --local` half: Worker-rendered bot pages, merged lists and the submission
# intake, against a local D1 only. POST goes to the LOCAL dev server and nowhere else. The cron runs with
# `throttled_until` set, so it makes zero requests to any platform host (the mocked-x.ai half lives in
# scripts/test-dataplane.ts). FORM_SUBMIT_ENABLED=1 is a local --var here; wrangler.toml keeps "0".
# Needs a fresh `pnpm build`. Usage: scripts/test-no-deploy-local.sh
set -u
cd "$(dirname "$0")/.."
W="npx --yes wrangler@4.123.0"
PORT=${PORT:-8793}; B="http://localhost:$PORT"; LOG=$(mktemp); PASS=0; FAIL=0; PID=
LOCAL_COMPAT=${LOCAL_COMPAT:-2026-08-18}
read -r SEEDSLUG SEEDCAT SEEDCODE DEADSLUG DEADCODE < <(python3 -c "
import json;b=json.load(open('src/data/bots.json'));a=b[0];c=[x for x in b if x['cat']==a['cat'] and x['slug']!=a['slug']][0]
print(a['slug'],a['cat'],a['code'],c['slug'],c['code'])")
LITE=$(mktemp -d); rsync -a --exclude='/bots/' --exclude='/api/v1/bots/' --exclude='/search/' --exclude='/categories/' dist/ "$LITE/"
mkdir -p "$LITE/bots/$SEEDSLUG" "$LITE/categories/$SEEDCAT" "$LITE/search"
cp "dist/bots/$SEEDSLUG/index.html" "$LITE/bots/$SEEDSLUG/"; cp "dist/categories/$SEEDCAT/index.html" "$LITE/categories/$SEEDCAT/"; cp dist/search/live.json "$LITE/search/"
check() { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); printf '%-66s %-12s %-12s PASS\n' "$1" "$2" "$3"; else FAIL=$((FAIL+1)); printf '%-66s %-12s %-12s FAIL\n' "$1" "$2" "$3"; fi; }
stop() { [[ -n "$PID" ]] && kill "$PID" 2>/dev/null; sleep 1; local l; for l in $(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null); do kill "$l" 2>/dev/null; done; PID=; }
trap stop EXIT
sqlx() { $W d1 execute grokbot-zone --local --command "$1" >/dev/null 2>&1; }
sql() { $W d1 execute grokbot-zone --local --json --command "$1" 2>/dev/null | python3 -c 'import json,sys; r=json.load(sys.stdin)[0]["results"]; print(json.dumps(r,separators=(",",":")))'; }
code() { curl -s -m 20 -o /dev/null -w '%{http_code}' "${@:2}" "$B$1"; }
UA='Mozilla/5.0 (Macintosh) AppleWebKit/605 Safari/605'
NEWA=NewTravel000000000001; NEWB=NewNoCat0000000000001; NEWX=NewScript00000000001; NEWD=NewDead00000000000001; NEWE=NewExcl00000000000001; NEWP=NewPend0000000000001; SUBC=SubmitMe0000000000001

sqlx "DROP TABLE IF EXISTS bots; DROP TABLE IF EXISTS bot_daily; DROP TABLE IF EXISTS visit_seen; DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS submissions; DROP TABLE IF EXISTS subscribers; DROP TABLE IF EXISTS send_log; DROP TABLE IF EXISTS d1_migrations;"
$W d1 migrations apply grokbot-zone --local >/dev/null 2>&1
SEED=$(npx tsx scripts/seed-d1.ts --dry | sed 's/.*-> //'); $W d1 execute grokbot-zone --local --file "$SEED" >/dev/null 2>&1
INS="INSERT INTO bots(code_lc, code, name, author, description, category, cats, source, status, first_seen, last_live)"
sqlx "$INS VALUES(lower('$NEWA'),'$NEWA','Fresh Trip Bot','Mia','Plans trips quickly.','travel','travel','listing','live','2026-11-05','2026-11-05T00:00:00Z'),
 (lower('$NEWB'),'$NEWB','No Category Bot','','Does odd jobs.',NULL,NULL,'archive','live','2026-11-04','2026-11-04T00:00:00Z'),
 (lower('$NEWX'),'$NEWX','\"><script>alert(1)</script>','<b>x</b>','a & b <i>','travel','travel','listing','live','2026-11-03','2026-11-03T00:00:00Z'),
 (lower('$NEWD'),'$NEWD','Gone Bot','','d','travel','travel','listing','dead','2026-11-02','2026-11-02T00:00:00Z'),
 (lower('$NEWE'),'$NEWE','Hidden Bot','','d','travel','travel','listing','excluded','2026-11-02','2026-11-02T00:00:00Z'),
 (lower('$NEWP'),'$NEWP','','','',NULL,NULL,'listing','pending','2026-11-02',NULL);
 UPDATE bots SET status='dead' WHERE code_lc=lower('$DEADCODE');
 INSERT INTO meta(k,v) VALUES('throttled_until','2099-01-01T00:00:00Z'); INSERT INTO meta(k,v) VALUES('discovery_last_run','2026-11-01T00:00:00Z');"

: > "$LOG"
$W dev --port $PORT --test-scheduled --compatibility-date "$LOCAL_COMPAT" --assets "$LITE" --var NOREF_TOKENS:zzfaketokenzz --var FORM_SUBMIT_ENABLED:1 --var MIN_FILL_MS:0 --var TELEMETRY_START:"$(date -u +%F)" >"$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 90); do curl -s -o /dev/null "$B/api/flags" && break; sleep 1; done
check "cron */10 (throttled, no upstream)" 200 "$(code '/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*')"; sleep 4

# ---- D27: Worker-rendered pages ----
P=$(curl -s -A "$UA" "$B/bots/travel-$NEWA/")
check "D1-only live bot page -> 200" 200 "$(code "/bots/travel-$NEWA/")"
check "page: title, canonical, /go/ link, nofollow" "1 1 1 1" "$(echo "$P" | python3 -c '
import sys,re;h=sys.stdin.read();a="'$NEWA'"
print(int("<title>Fresh Trip Bot by Mia (Travel) | Grok bot | GrokBot Zone</title>" in h), int("rel=\"canonical\" href=\"https://grokbot.zone/bots/travel-"+a+"/\"" in h), int("href=\"/go/"+a+"\"" in h), int("nofollow noopener" in h))')"
check "page: no robots noindex, JSON-LD present" "0 2" "$(echo "$P" | python3 -c 'import sys;h=sys.stdin.read();print(h.count("name=\"robots\""), h.count("application/ld+json\">"))')"
check "page: Cache-Control public, s-maxage=3600" "public, s-maxage=3600" "$(curl -sI -A "$UA" "$B/bots/travel-$NEWA/" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')"
X=$(curl -s -A "$UA" "$B/bots/travel-$NEWX/")
check "<script> name renders inert (escaped, no extra script element)" "1 0" "$(echo "$X" | python3 -c '
import sys,re;h=sys.stdin.read();t=open("dist/bot-template/index.html").read()
f=lambda s:len(re.findall(r"<script\b",re.sub(r"=\"[^\"]*\"","=\"\"",s)))
print(int("&lt;script&gt;alert(1)&lt;/script&gt;" in h), f(h)-f(t))')"
check "uncategorized bot page -> 200" 200 "$(code "/bots/uncategorized-$NEWB/")"
check "dead bot -> 410" 410 "$(code "/bots/travel-$NEWD/")"
check "excluded bot -> 404" 404 "$(code "/bots/travel-$NEWE/")"
check "pending bot -> 404" 404 "$(code "/bots/uncategorized-$NEWP/")"
check "unknown bot -> 404" 404 "$(code /bots/travel-ZZZZZZZZZZZZZZZZZZZZZ/)"
check "template URL not reachable -> 404" 404 "$(code /bot-template/)"
check "seed bot static page byte-for-byte" 0 "$(curl -s -A "$UA" "$B/bots/$SEEDSLUG/" | cmp - "dist/bots/$SEEDSLUG/index.html" >/dev/null 2>&1; echo $?)"
sleep 2
check "view counted for the D1 page (once per visitor)" '[{"v":1}]' "$(sql "SELECT SUM(views) AS v FROM bot_daily WHERE code_lc=lower('$NEWA')")"

# ---- D28 / O10: merges ----
L=$(curl -s "$B/search/live.json")
check "search/live.json: 3 live bots in, dead ones listed" "3 1 1" "$(echo "$L" | python3 -c '
import json,sys;j=json.load(sys.stdin);print(len(j["bots"]), int("'$DEADCODE'".lower() in j["dead"]), int("'$NEWD'".lower() in j["dead"]))')"
C=$(curl -s "$B/categories/$SEEDCAT/")
check "category page: dead seed bot dropped" 0 "$(echo "$C" | grep -c "data-code=\"$(echo $DEADCODE | tr 'A-Z' 'a-z')\"")"
check "feed.json has the new bot, not the dead one" "1 0" "$(curl -s "$B/feed.json" | python3 -c '
import json,sys;u=[i["url"] for i in json.load(sys.stdin)["items"]];print(int(any("'$NEWA'" in x for x in u)), int(any("'$DEADCODE'".lower() in x.lower() for x in u)))')"
check "sitemap-index lists sitemap-live.xml" 1 "$(curl -s "$B/sitemap-index.xml" | grep -c sitemap-live.xml)"
check "sitemap-live.xml lists new live bots only" "1 1 0 0" "$(curl -s "$B/sitemap-live.xml" | python3 -c 'import sys;h=sys.stdin.read();print(int("travel-'$NEWA'" in h),int("uncategorized-'$NEWB'" in h),int("'$NEWD'" in h),int("'$NEWE'" in h))')"
check "changes.json: id + code on each added entry, dead one kept, excluded not" "1 1 0" "$(curl -s "$B/api/v1/catalog/changes.json" | python3 -c '
import json,sys;a=json.load(sys.stdin)["added"];c=[x["code"] for x in a];print(int(all(x["id"].endswith(x["code"]) for x in a)), int("'$NEWD'" in c), int("'$NEWE'" in c))')"

# ---- D30: intake (POST goes to the LOCAL server only) ----
post() { curl -s -m 20 -o /tmp/gz-nd-body -w '%{http_code}' -X POST -H 'content-type: application/json' "$B/api/submit" --data "$1"; }
GOODJ='{"name":"Typed Name","author":"Typed","description":"Typed description text here.","link":"https://x.ai/bot/'$SUBC'","category":"travel","email":"typed@example.test","company_website":"","filled_ms":9000}'
check "form: valid new code -> 201" 201 "$(post "$GOODJ")"
check "bots row: pending, source submission, nothing typed stored" '[{"status":"pending","source":"submission","name":"","author":"","description":"","category":null}]' "$(sql "SELECT status, source, name, author, description, category FROM bots WHERE code_lc=lower('$SUBC')")"
check "form: invalid code -> 400" 400 "$(post "${GOODJ//$SUBC/short-code}")"
check "form: known code -> 409, no new row" "409 1" "$(post "$GOODJ") $(sql "SELECT COUNT(*) AS n FROM bots WHERE code_lc=lower('$SUBC')" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["n"])')"
check "pending submission bot has no public page" 404 "$(code "/bots/uncategorized-$SUBC/")"
for i in $(seq 1 200); do printf "INSERT INTO bots(code_lc, code, source, status, first_seen) VALUES('cap%018d','Cap%018d','submission','pending','%s');\n" $i $i "$(date -u +%FT%TZ)"; done > /tmp/gz-nd-cap.sql
$W d1 execute grokbot-zone --local --file /tmp/gz-nd-cap.sql >/dev/null 2>&1
check "form: the 201st new row of the day -> 429" 429 "$(post "${GOODJ//$SUBC/CapOverflow0000000001}")"
check "429 stored nothing" 0 "$(sql "SELECT COUNT(*) AS n FROM bots WHERE code_lc=lower('CapOverflow0000000001')" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["n"])')"
check "typed text appears in no public page or API output" 0 "$( (curl -s "$B/api/v1/catalog/changes.json"; curl -s "$B/search/live.json"; curl -s "$B/feed.xml"; curl -s "$B/recent/"; curl -s "$B/") | grep -c 'Typed Name\|typed@example')"
check "switches in health all 0 by default (this run sets FORM only as a local var)" "1 0 0 0" "$(curl -s "$B/api/health" | python3 -c 'import json,sys;print(" ".join(json.load(sys.stdin)["switches"].values()))')"
grep -E '^(FORM_SUBMIT_ENABLED|EMAIL_SUBMIT_ENABLED|SUBSCRIBE_ENABLED|DIGEST_ENABLED)\s*=\s*"0"' wrangler.toml | wc -l | tr -d ' ' | { read n; check "wrangler.toml keeps all four switches at \"0\"" 4 "$n"; }
echo "test-no-deploy-local: PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]]
