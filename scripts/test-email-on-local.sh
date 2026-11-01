#!/usr/bin/env bash
# Email-on, the `wrangler dev --local` half: the SHIPPED wrangler.toml switches (no switch --var), a local D1 only,
# and Cloudflare's local email endpoint (/cdn-cgi/handler/email) fed an RFC 5322 message with a Message-ID.
# POST goes to the LOCAL dev server and nowhere else; the cron is throttled so no platform host is contacted.
# Needs a fresh `pnpm build`. Usage: scripts/test-email-on-local.sh
set -u
cd "$(dirname "$0")/.."
W="npx --yes wrangler@4.123.0"
PORT=${PORT:-8794}; B="http://localhost:$PORT"; LOG=$(mktemp); PASS=0; FAIL=0; PID=
LOCAL_COMPAT=${LOCAL_COMPAT:-2026-08-18}
LITE=$(mktemp -d); rsync -a --exclude='/bots/' --exclude='/api/v1/bots/' --exclude='/search/' --exclude='/categories/' dist/ "$LITE/"
check() { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); printf '%-70s %-14s %-14s PASS\n' "$1" "$2" "$3"; else FAIL=$((FAIL+1)); printf '%-70s %-14s %-14s FAIL\n' "$1" "$2" "$3"; fi; }
stop() { [[ -n "$PID" ]] && kill "$PID" 2>/dev/null; sleep 1; local l; for l in $(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null); do kill "$l" 2>/dev/null; done; PID=; }
trap stop EXIT
sqlx() { $W d1 execute grokbot-zone --local --command "$1" >/dev/null 2>&1; }
sql() { $W d1 execute grokbot-zone --local --json --command "$1" 2>/dev/null | python3 -c 'import json,sys; r=json.load(sys.stdin)[0]["results"]; print(json.dumps(r,separators=(",",":")))'; }
n() { sql "$1" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["n"])'; }
code() { curl -s -m 20 -o /dev/null -w '%{http_code}' "${@:2}" "$B$1"; }
mail() { printf 'From: %s\r\nTo: %s\r\nSubject: %s\r\nMessage-ID: <t%s@example.test>\r\nDate: Sun, 01 Nov 2026 12:00:00 +0000\r\n\r\n%b\r\n' "$2" "$1" "$3" "$RANDOM" "$4"; }
email() { curl -s -m 30 -o /tmp/gz-emailon-out -w '%{http_code}' -X POST "$B/cdn-cgi/handler/email" --url-query "from=$2" --url-query "to=$1" --data-binary "$3"; }
FORMC=EmailOnForm0000000001; MAILC=EmailOnMail0000000001
GOODJ="{\"name\":\"Spam Stopper\",\"author\":\"Sam\",\"description\":\"Blocks spam calls.\",\"link\":\"https://x.ai/bot/$FORMC\",\"category\":\"privacy-security-scam-protection\",\"email\":\"me@example.test\",\"company_website\":\"\",\"filled_ms\":5000}"

sqlx "DROP TABLE IF EXISTS bots; DROP TABLE IF EXISTS bot_daily; DROP TABLE IF EXISTS visit_seen; DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS submissions; DROP TABLE IF EXISTS subscribers; DROP TABLE IF EXISTS send_log; DROP TABLE IF EXISTS d1_migrations;"
$W d1 migrations apply grokbot-zone --local >/dev/null 2>&1
sqlx "INSERT INTO meta(k,v) VALUES('throttled_until','2099-01-01T00:00:00Z');"
: > "$LOG"
$W dev --port $PORT --test-scheduled --compatibility-date "$LOCAL_COMPAT" --assets "$LITE" --var NOREF_TOKENS:zzfaketokenzz --var MIN_FILL_MS:0 >"$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 90); do curl -s -o /dev/null "$B/api/flags" && break; sleep 1; done

check "/api/flags: form + email on, subscribe off" '{"form":true,"subscribe":false,"email":true}' "$(curl -s $B/api/flags)"
check "health switches: 1 1 0 0" "1 1 0 0" "$(curl -s $B/api/health | python3 -c 'import json,sys;s=json.load(sys.stdin)["switches"];print(s["FORM_SUBMIT_ENABLED"],s["EMAIL_SUBMIT_ENABLED"],s["SUBSCRIBE_ENABLED"],s["DIGEST_ENABLED"])')"
check "form: valid new code -> 201" 201 "$(curl -s -m 20 -o /tmp/gz-emailon-form -w '%{http_code}' -X POST "$B/api/submit" -H 'cf-connecting-ip: 10.0.0.7' -H 'Content-Type: application/json' --data "$GOODJ")"
sleep 2
check "form: pending bots row, source submission" "pending submission" "$(sql "SELECT status, source FROM bots WHERE code_lc=lower('$FORMC')" | python3 -c 'import json,sys;r=json.load(sys.stdin)[0];print(r["status"],r["source"])')"
check "form: ack attempt is in send_log (ok or failed, never blocking)" 1 "$(n "SELECT COUNT(*) AS n FROM send_log WHERE kind='ack'")"
check "form: owner summary skipped, E_NO_OWNER_ADDRESS" 1 "$(n "SELECT COUNT(*) AS n FROM send_log WHERE kind='owner_summary' AND error_code='E_NO_OWNER_ADDRESS'")"
check "subscribe stays dark -> 503" 503 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/subscribe" -H 'Content-Type: application/json' --data '{"email":"a@example.test"}')"
M=$(mail submit@grokbot.zone author@example.test "My bot" "Helps with taxes.\nhttps://x.ai/bot/$MAILC")
email submit@grokbot.zone author@example.test "$M" >/dev/null; sleep 2
check "email: RFC 5322 message with Message-ID -> pending bot, source submission" "pending submission" "$(sql "SELECT status, source FROM bots WHERE code_lc=lower('$MAILC')" | python3 -c 'import json,sys;r=json.load(sys.stdin)[0];print(r["status"],r["source"])')"
check "email: submissions row, source email" 1 "$(n "SELECT COUNT(*) AS n FROM submissions WHERE source='email' AND code='$MAILC'")"
check "email: reply attempt logged as ack" 1 "$(n "SELECT COUNT(*) AS n FROM send_log WHERE kind='ack' AND recipient='author@example.test'")"
email info@grokbot.zone author@example.test "$(mail info@grokbot.zone author@example.test x "https://x.ai/bot/EmailOnOther000000001")" >/dev/null; sleep 1
check "email: other mailbox stores nothing" 0 "$(n "SELECT COUNT(*) AS n FROM bots WHERE code_lc=lower('EmailOnOther000000001')")"
check "no email address is exposed by any public page" 0 "$( (curl -s $B/api/flags; curl -s $B/submit/; curl -s $B/api/health) | grep -c 'author@example.test')"
check "wrangler.toml: FORM/EMAIL 1, SUBSCRIBE/DIGEST 0, OWNER_ADDRESS empty" "2 2 1" "$(grep -cE '^(FORM_SUBMIT_ENABLED|EMAIL_SUBMIT_ENABLED)\s*=\s*"1"' wrangler.toml) $(grep -cE '^(SUBSCRIBE_ENABLED|DIGEST_ENABLED)\s*=\s*"0"' wrangler.toml) $(grep -cE '^OWNER_ADDRESS\s*=\s*""' wrangler.toml)"
echo "test-email-on-local: PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]]
