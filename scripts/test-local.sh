#!/usr/bin/env bash
# Local suite for the Worker (spec 06 section 9). Runs `wrangler dev` on this machine only: no --remote,
# no real mail (the email bindings are simulated), switches flipped with --var on the command line.
# Needs a fresh `pnpm build` and a migrated local database. Usage: scripts/test-local.sh
set -u
cd "$(dirname "$0")/.."
W="npx --yes wrangler@4.123.0"
PORT=8791; B="http://localhost:$PORT"; LOG=$(mktemp); PASS=0; FAIL=0; PID=
CODE_SHIPPED=7PyUClpHZH-lavGlXGRVg
# The local workerd in this wrangler is older than the deployed compatibility date, so local runs pin an
# older date. Assets: a copy of dist without the ~14k per-bot files, which only slow the local server down.
LOCAL_COMPAT=${LOCAL_COMPAT:-2026-08-18}
LITE=$(mktemp -d); rsync -a --exclude='/bots/' --exclude='/api/v1/bots/' --exclude='/search/' --exclude='/categories/' dist/ "$LITE/"
say() { printf '%-62s %-10s %-10s %s\n' "$1" "$2" "$3" "$4"; }
check() { # name expected got
  if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); say "$1" "$2" "$3" PASS; else FAIL=$((FAIL+1)); say "$1" "$2" "$3" FAIL; fi
}
start() { # extra wrangler args...
  : > "$LOG"
  $W dev --port $PORT --test-scheduled --compatibility-date "$LOCAL_COMPAT" --assets "$LITE" "$@" >"$LOG" 2>&1 &
  PID=$!
  for _ in $(seq 1 60); do curl -s -o /dev/null "$B/api/flags" && return 0; sleep 1; done
  echo "wrangler dev did not start"; cat "$LOG"; exit 1
}
stop() { [[ -n "$PID" ]] && kill "$PID" 2>/dev/null; sleep 1; pkill -f "wrangler-dist/cli.js dev --port $PORT" 2>/dev/null; sleep 1; PID=; }
trap stop EXIT
sql() { $W d1 execute grokbot-zone --local --json --command "$1" 2>/dev/null | python3 -c 'import json,sys; r=json.load(sys.stdin)[0]["results"]; print(json.dumps(r,separators=(",",":")))'; }
reset_db() { $W d1 execute grokbot-zone --local --command "DELETE FROM submissions; DELETE FROM subscribers; DELETE FROM send_log; DELETE FROM sqlite_sequence;" >/dev/null 2>&1; }
post() { # path ip body [ctype]  -> "status body"
  curl -s -m 20 -w ' %{http_code}' -X POST "$B$1" -H "cf-connecting-ip: $2" -H "Content-Type: ${4:-application/json}" --data "$3"
}
status() { echo "${1##* }"; }
GOOD='{"name":"Spam Stopper","author":"Sam","description":"Blocks spam calls for you.","link":"https://x.ai/bot/NewBot-12345","category":"privacy-security-scam-protection","email":"me@example.test","company_website":"","filled_ms":5000}'
mail() { # to from subject body [extra headers]
  printf 'From: %s\r\nTo: %s\r\nSubject: %s\r\nMessage-ID: <t%s@example.test>\r\n%b\r\n%b\r\n' "$2" "$1" "$3" "$RANDOM" "${5:-}" "$4"
}
email() { # raw -> http status of the local email endpoint
  curl -s -m 30 -o /tmp/gz-email-out -w '%{http_code}' -X POST "$B/cdn-cgi/handler/email" --url-query "from=$2" --url-query "to=$1" --data-binary "$3"
}

printf '%-62s %-10s %-10s %s\n' CASE EXPECT GOT RESULT
echo "--- phase 1: every switch dark (the shipped config)"
reset_db; start
check "GET /api/health" 200 "$(curl -s -o /dev/null -w '%{http_code}' $B/api/health)"
check "health body ok+d1" '{"ok":true,"d1":true}' "$(curl -s $B/api/health)"
check "POST /api/submit empty body (dark)" 503 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/submit)"
check "POST /api/v1/submissions (dark)" 503 "$(status "$(post /api/v1/submissions 10.0.0.1 "$GOOD")")"
check "POST /subscribe (dark)" 503 "$(status "$(post /subscribe 10.0.0.1 '{"email":"a@example.test"}')")"
check "GET /subscribe/confirm (dark)" 503 "$(curl -s -o /dev/null -w '%{http_code}' "$B/subscribe/confirm?t=00000000000000000000000000000000")"
check "dark body is disabled" '{"ok":false,"error":"disabled"}' "$(curl -s -X POST $B/api/submit)"
check "email intake (dark) rejected" 200 "$(email submit@grokbot.zone a@example.test "$(mail submit@grokbot.zone a@example.test hi "https://x.ai/bot/NewBot-12345")")"
check "email dark: no rows" '[{"n":0}]' "$(sql 'SELECT COUNT(*) AS n FROM submissions')"
curl -s -o /dev/null "$B/cdn-cgi/handler/scheduled?cron=0+13+*+*+MON"; sleep 2
check "cron while dark sends nothing" 1 "$(grep -c 'digest: dark' "$LOG")"
check "static: /api/ docs 200 through Worker" 200 "$(curl -s -o /dev/null -w '%{http_code}' $B/api/)"
check "static: /api/v1/index.json 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' $B/api/v1/index.json)"
check "static: /trending/ 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' $B/trending/)"
check "static: /feed.json 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' $B/feed.json)"
check "security header on asset" nosniff "$(curl -sI $B/ | tr -d '\r' | awk -F': ' 'tolower($1)=="x-content-type-options"{print $2}')"
stop

echo "--- phase 2: switches flipped LOCALLY (command line only)"
reset_db
start --var FORM_SUBMIT_ENABLED:1 --var EMAIL_SUBMIT_ENABLED:1 --var SUBSCRIBE_ENABLED:1 --var OWNER_ADDRESS:owner@example.test
check "flags endpoint" '{"form":true,"subscribe":true,"email":true}' "$(curl -s $B/api/flags)"
r=$(post /api/submit 10.1.0.1 "$GOOD"); check "valid submission -> 201" 201 "$(status "$r")"
check "201 body" '{"ok":true,"id":1,"status":"pending"}' "${r% *}"
check "row in D1" '[{"n":1,"s":"pending","l":"https://x.ai/bot/newbot-12345","c":"NewBot-12345"}]' "$(sql "SELECT COUNT(*) AS n, status AS s, link AS l, code AS c FROM submissions")"
sleep 2
check "ack + owner summary logged" '[{"kind":"ack","ok":1},{"kind":"owner_summary","ok":1}]' "$(sql "SELECT kind, ok FROM send_log WHERE kind IN ('ack','owner_summary') ORDER BY id")"
check "owner summary mail logged with subject" 1 "$(grep -c 'Subject: \[GZ\] new submission #1 ' "$LOG")"
check "owner mail body carries the approve SQL" yes "$([[ $(grep -rl "UPDATE submissions SET status='approved' WHERE id=1" .wrangler/tmp/email 2>/dev/null | wc -l) -ge 1 ]] && echo yes || echo no)"
r=$(post /api/submit 10.1.0.2 "$GOOD"); check "same link again -> 409" 409 "$(status "$r")"
check "409 already_pending" '{"ok":false,"error":"already_pending"}' "${r% *}"
r=$(post /api/submit 10.1.0.3 "${GOOD/NewBot-12345/$CODE_SHIPPED}"); check "shipped code -> 409" 409 "$(status "$r")"
check "409 already_listed" '{"ok":false,"error":"already_listed"}' "${r% *}"
r=$(post /api/submit 10.1.0.3 "${GOOD/NewBot-12345/NEWBOT-12345}"); check "case-variant of pending -> 409" 409 "$(status "$r")"
sql "UPDATE submissions SET status='rejected' WHERE id=1" >/dev/null; $W d1 execute grokbot-zone --local --command "UPDATE submissions SET status='rejected' WHERE id=1" >/dev/null 2>&1
r=$(post /api/submit 10.1.0.4 "$GOOD"); check "resubmit a rejected row -> 201" 201 "$(status "$r")"
check "rejected row flipped back to pending" '[{"id":1,"status":"pending"}]' "$(sql 'SELECT id, status FROM submissions')"
r=$(post /api/submit 10.1.0.5 "${GOOD/\"company_website\":\"\"/\"company_website\":\"http://spam\"}"); check "honeypot filled -> 400" 400 "$(status "$r")"
check "400 names company_website" 1 "$(grep -c 'company_website' <<<"$r")"
r=$(post /api/submit 10.1.0.5 "${GOOD/5000/100}"); check "filled_ms 100 -> 400" 400 "$(status "$r")"
check "400 too fast" 1 "$(grep -c 'too fast' <<<"$r")"
check "bad link -> 400" 400 "$(status "$(post /api/submit 10.1.0.5 "${GOOD/https:\/\/x.ai/https://evil.com}")")"
check "bad category -> 400" 400 "$(status "$(post /api/submit 10.1.0.5 "${GOOD/privacy-security-scam-protection/nope}")")"
check "invalid JSON -> 400" 400 "$(status "$(post /api/submit 10.1.0.5 '{nope')")"
check "text/plain body -> 415" 415 "$(status "$(post /api/submit 10.1.0.6 "$GOOD" text/plain)")"
check "GET /api/submit -> 405" 405 "$(curl -s -o /dev/null -w '%{http_code}' $B/api/submit)"
codes=""; for i in 1 2 3 4 5 6; do codes="$codes $(status "$(post /api/submit 10.9.9.9 "${GOOD/NewBot-12345/Flood-$i-abcd}")")"; done
check "6 POSTs in 60s from one IP: 201x5 then 429" "201 201 201 201 201 429" "$(echo $codes)"
check "429 carries Retry-After" 60 "$(curl -s -D - -o /dev/null -X POST $B/api/submit -H 'cf-connecting-ip: 10.9.9.9' -H 'Content-Type: application/json' --data "$GOOD" | tr -d '\r' | awk -F': ' 'tolower($1)=="retry-after"{print $2}')"

echo "--- subscribe suite"
r=$(post /subscribe 10.2.0.1 '{"email":"Sub@Example.test","company_website":""}'); check "new subscriber -> 201" 201 "$(status "$r")"
check "201 pending_confirm" '{"ok":true,"status":"pending_confirm"}' "${r% *}"
sleep 1
check "confirm mail logged" '[{"kind":"confirm","recipient":"sub@example.test","ok":1}]' "$(sql "SELECT kind, recipient, ok FROM send_log WHERE kind='confirm'")"
r=$(post /subscribe 10.2.0.2 '{"email":"sub@example.test"}'); check "pending -> 200 no resend" 200 "$(status "$r")"
check "no second confirm mail" '[{"n":1}]' "$(sql "SELECT COUNT(*) AS n FROM send_log WHERE kind='confirm'")"
check "honeypot on subscribe -> 400" 400 "$(status "$(post /subscribe 10.2.0.3 '{"email":"x@example.test","company_website":"y"}')")"
check "bad email -> 400" 400 "$(status "$(post /subscribe 10.2.0.3 '{"email":"nope"}')")"
CT=$(sql "SELECT confirm_token AS t FROM subscribers" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["t"])')
UT=$(sql "SELECT unsub_token AS t FROM subscribers" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["t"])')
check "tokens are 32 hex" 1 "$(echo "$CT$UT" | grep -cE '^[0-9a-f]{64}$')"
check "GET confirm?t=bogus -> 410" 410 "$(curl -s -o /dev/null -w '%{http_code}' "$B/subscribe/confirm?t=bogus")"
check "GET confirm -> 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$B/subscribe/confirm?t=$CT")"
check "row flipped to active" '[{"status":"active"}]' "$(sql 'SELECT status FROM subscribers')"
check "re-confirm is idempotent 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$B/subscribe/confirm?t=$CT")"
check "active -> 409 already_subscribed" 409 "$(status "$(post /subscribe 10.2.0.4 '{"email":"sub@example.test"}')")"
check "GET unsubscribe bogus -> 410" 410 "$(curl -s -o /dev/null -w '%{http_code}' "$B/subscribe/unsubscribe?t=bogus")"
check "GET unsubscribe -> 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$B/subscribe/unsubscribe?t=$UT")"
check "row flipped to unsubscribed" '[{"status":"unsubscribed"}]' "$(sql 'SELECT status FROM subscribers')"
post /subscribe 10.2.0.5 '{"email":"sub@example.test"}' >/dev/null
CT=$(sql "SELECT confirm_token AS t FROM subscribers" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["t"])')
UT=$(sql "SELECT unsub_token AS t FROM subscribers" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["t"])')
curl -s -o /dev/null "$B/subscribe/confirm?t=$CT"
check "POST one-click unsubscribe -> 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/subscribe/unsubscribe?t=$UT" -d 'List-Unsubscribe=One-Click')"
check "POST flipped row" '[{"status":"unsubscribed"}]' "$(sql 'SELECT status FROM subscribers')"
check "POST unsubscribe bogus -> 410" 410 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/subscribe/unsubscribe?t=bogus" -d 'List-Unsubscribe=One-Click')"

echo "--- email intake"
reset_db
OK=$(mail submit@grokbot.zone author@example.test "My bot" "Helps with taxes.\nhttps://x.ai/bot/FreshOne1 and https://x.ai/bot/FreshTwo2\nalso https://x.ai/bot/$CODE_SHIPPED" 'Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass\r\n')
check "email: 2 fresh + 1 shipped accepted" 200 "$(email submit@grokbot.zone author@example.test "$OK")"
sleep 1
check "email: 2 pending rows source=email, category NULL" '[{"n":2,"src":"email","c":null}]' "$(sql "SELECT COUNT(*) AS n, MIN(source) AS src, MAX(category) AS c FROM submissions")"
check "email: row name from subject" '[{"name":"My bot","description":"Helps with taxes."}]' "$(sql "SELECT name, description FROM submissions WHERE code='FreshOne1'")"
check "email: ack logged once" '[{"n":1}]' "$(sql "SELECT COUNT(*) AS n FROM send_log WHERE kind='ack'")"
check "email: forward to owner logged" '[{"ok":1}]' "$(sql "SELECT ok FROM send_log WHERE kind='owner_summary' AND recipient='owner@example.test' AND message_id IS NULL AND id=(SELECT MAX(id) FROM send_log)")"
check "email: other mailbox rejected" 0 "$(email info@grokbot.zone a@example.test "$(mail info@grokbot.zone a@example.test hi 'https://x.ai/bot/Other1234')" >/dev/null; sql "SELECT COUNT(*) AS n FROM submissions WHERE code='Other1234'" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["n"])')"
check "email: DMARC fail rejected" 0 "$(email submit@grokbot.zone a@example.test "$(mail submit@grokbot.zone a@example.test hi 'https://x.ai/bot/DmarcFail1' 'Authentication-Results: mx.cloudflare.net; dmarc=fail\r\n')" >/dev/null; sql "SELECT COUNT(*) AS n FROM submissions WHERE code='DmarcFail1'" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["n"])')"
SEVEN=""; for i in 1 2 3 4 5 6 7; do SEVEN="$SEVEN https://x.ai/bot/Seven$i-abcd"; done
check "email: 7 new links rejected" 0 "$(email submit@grokbot.zone a@example.test "$(mail submit@grokbot.zone a@example.test hi "$SEVEN")" >/dev/null; sql "SELECT COUNT(*) AS n FROM submissions WHERE code LIKE 'Seven%'" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["n"])')"
check "email: no link rejected" 0 "$(email submit@grokbot.zone a@example.test "$(mail submit@grokbot.zone a@example.test hi 'no link here')" >/dev/null; sql "SELECT COUNT(*) AS n FROM submissions" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["n"]-2)')"
check "email: worker saw setReject reasons" 4 "$(grep -cE "unknown mailbox|dmarc|too many links|no bot link" "$LOG")"

echo "--- cron with the digest switch on (sends are simulated, nothing is delivered)"
reset_db
for e in a b c d; do post /subscribe 10.3.0.$RANDOM "{\"email\":\"$e@example.test\"}" >/dev/null; done
$W d1 execute grokbot-zone --local --command "UPDATE subscribers SET status='active'" >/dev/null 2>&1
stop
start --var SUBSCRIBE_ENABLED:1 --var DIGEST_ENABLED:1 --var DIGEST_MAX_SENDS:3
curl -s -o /dev/null "$B/cdn-cgi/handler/scheduled?cron=0+13+*+*+MON"; sleep 3
check "4 active, cap 3: exactly 3 digest sends" '[{"n":3}]' "$(sql "SELECT COUNT(*) AS n FROM send_log WHERE kind='digest' AND ok=1")"
check "digest log line" 1 "$(grep -c 'digest: Monday sent=3' "$LOG")"
stop
start --var SUBSCRIBE_ENABLED:1 --var DIGEST_ENABLED:1 --var DIGEST_MAX_SENDS:100
$W d1 execute grokbot-zone --local --command "DELETE FROM send_log" >/dev/null 2>&1
curl -s -o /dev/null "$B/cdn-cgi/handler/scheduled?cron=0+13+*+*+THU"; sleep 3
check "4 active, cap 100: 4 sends" '[{"n":4}]' "$(sql "SELECT COUNT(*) AS n FROM send_log WHERE kind='digest' AND ok=1")"
stop
start --var SUBSCRIBE_ENABLED:1
$W d1 execute grokbot-zone --local --command "DELETE FROM send_log" >/dev/null 2>&1
curl -s -o /dev/null "$B/cdn-cgi/handler/scheduled?cron=0+13+*+*+MON"; sleep 2
check "switch 0 again: zero sends" '[{"n":0}]' "$(sql "SELECT COUNT(*) AS n FROM send_log WHERE kind='digest'")"
stop
reset_db
echo; echo "PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]]
