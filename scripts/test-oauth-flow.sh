#!/usr/bin/env bash
# End-to-end OAuth check against a running Worker: DCR -> authorize (PKCE S256) -> magic link -> token exchange.
# The magic link comes from dev_magic_url, which the Worker returns only on a loopback host.
# Usage: scripts/test-oauth-flow.sh [base-url]
# With no URL, starts wrangler dev on PORT (default 8799) the same way scripts/agentready-local.sh does (lite dist copy).
# Prints "oauth-flow: pass" or the failing step. Never prints the access token.
set -u
cd "$(dirname "$0")/.."
PORT="${PORT:-8799}"
LOG=$(mktemp)
PID=
if [[ $# -ge 1 ]]; then
  BASE="${1%/}"
  OWN=0
else
  BASE="http://127.0.0.1:$PORT"
  OWN=1
  if [[ ! -f dist/_worker.js/index.js ]]; then
    echo "oauth-flow: dist/ missing; run pnpm build first" >&2
    exit 2
  fi
  W="npx --yes wrangler@4.123.0"
  LOCAL_COMPAT="${LOCAL_COMPAT:-2026-08-18}"
  LITE=$(mktemp -d)
  # HTML bot pages are thousands of directories and stall the assets watcher. Keep the JSON API.
  rsync -a --exclude='/bots/' --exclude='/categories/' dist/ "$LITE/"
  $W d1 migrations apply grokbot-zone --local >/dev/null
  # wrangler.toml has custom-domain routes, and wrangler dev then shows the Worker that host (grokbot.zone) as the request URL.
  # --local-upstream makes it show the loopback address, so the Worker derives a loopback origin and returns dev_magic_url.
  $W dev --port "$PORT" --local-upstream "127.0.0.1:$PORT" --compatibility-date "$LOCAL_COMPAT" --assets "$LITE" >"$LOG" 2>&1 &
  PID=$!
  ready=0
  for _ in $(seq 1 90); do
    if curl -sf -o /dev/null "$BASE/api/health"; then ready=1; break; fi
    sleep 1
  done
  if [[ "$ready" != 1 ]]; then
    echo "oauth-flow: wrangler dev did not start" >&2
    cat "$LOG" >&2
    kill "$PID" 2>/dev/null || true
    exit 2
  fi
fi
cleanup() {
  if [[ "${OWN:-0}" == 1 && -n "${PID:-}" ]]; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill $(lsof -ti "tcp:$PORT" -sTCP:LISTEN) 2>/dev/null || true
  fi
}
trap cleanup EXIT
python3 - "$BASE" <<'PY'
import base64, hashlib, json, secrets, sys, urllib.error, urllib.parse, urllib.request

BASE = sys.argv[1]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None

opener = urllib.request.build_opener(NoRedirect)

def call(step, method, path, body=None, headers=None, expect=(200,)):
    req = urllib.request.Request(BASE + path, data=body, method=method, headers=headers or {})
    try:
        res = opener.open(req, timeout=30)
        status, hdrs, raw = res.status, res.headers, res.read()
    except urllib.error.HTTPError as e:
        status, hdrs, raw = e.code, e.headers, e.read()
    if status not in expect:
        print(f"oauth-flow: FAIL at {step}: HTTP {status}")
        sys.exit(1)
    return status, hdrs, raw

def parse(step, raw):
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        print(f"oauth-flow: FAIL at {step}: body is not JSON")
        sys.exit(1)

JSON = {"content-type": "application/json", "accept": "application/json"}
redirect = "http://127.0.0.1:9/cb"

_, _, raw = call("discovery", "GET", "/.well-known/oauth-authorization-server")
doc = parse("discovery", raw)
if "S256" not in doc.get("code_challenge_methods_supported", []):
    print("oauth-flow: FAIL at discovery: S256 not advertised"); sys.exit(1)

_, _, raw = call("register", "POST", "/oauth/register", json.dumps({"redirect_uris": [redirect], "client_name": "oauth-flow test"}).encode(), JSON, (201,))
client_id = parse("register", raw).get("client_id")
if not client_id:
    print("oauth-flow: FAIL at register: no client_id"); sys.exit(1)

verifier = secrets.token_urlsafe(48)
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
state = secrets.token_urlsafe(8)
q = urllib.parse.urlencode({"response_type": "code", "client_id": client_id, "redirect_uri": redirect, "code_challenge": challenge, "code_challenge_method": "S256", "state": state})
email = f"flow-{secrets.token_hex(6)}@example.test"
_, _, raw = call("authorize", "POST", f"/oauth/authorize?{q}", json.dumps({"email": email}).encode(), JSON)
magic = parse("authorize", raw).get("dev_magic_url")
if not magic:
    print("oauth-flow: FAIL at authorize: no dev_magic_url (is the base URL loopback?)"); sys.exit(1)

parsed = urllib.parse.urlparse(magic)
_, hdrs, _ = call("magic", "GET", parsed.path + "?" + parsed.query, expect=(302,))
loc = urllib.parse.urlparse(hdrs.get("Location", ""))
params = urllib.parse.parse_qs(loc.query)
code = (params.get("code") or [""])[0]
if not code or (params.get("state") or [""])[0] != state or not hdrs.get("Location", "").startswith(redirect):
    print("oauth-flow: FAIL at magic: bad redirect"); sys.exit(1)

form = urllib.parse.urlencode({"grant_type": "authorization_code", "code": code, "redirect_uri": redirect, "client_id": client_id, "code_verifier": verifier}).encode()
_, _, raw = call("token", "POST", "/oauth/token", form, {"content-type": "application/x-www-form-urlencoded"})
tok = parse("token", raw)
if not tok.get("access_token") or tok.get("token_type") != "Bearer":
    print("oauth-flow: FAIL at token: missing access_token or token_type Bearer"); sys.exit(1)

# The same code must not work twice.
call("code replay", "POST", "/oauth/token", form, {"content-type": "application/x-www-form-urlencoded"}, (400,))
print("oauth-flow: pass")
PY
status=$?
if [[ "$OWN" == 1 ]]; then echo "wrangler log: $LOG"; fi
exit "$status"
