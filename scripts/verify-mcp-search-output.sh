#!/usr/bin/env bash
# Post-deploy check for grokbot_search text + author-query parity.
# Usage: scripts/verify-mcp-search-output.sh [origin]
# Exit 0 = every check passed, 1 = a check failed, 2 = usage.
# Uses curl (Cloudflare bot-filters Python urllib). Does not deploy.
set -euo pipefail
ORIGIN="${1:-https://grokbot.zone}"
ORIGIN="${ORIGIN%/}"
[ -n "$ORIGIN" ] || { echo "usage: $0 [origin]" >&2; exit 2; }

fail() { echo "FAIL: $1" >&2; exit 1; }

mcp() {
  local method="$1" params="$2" body status
  body="$(mktemp)"
  status="$(curl -sS -o "$body" -w '%{http_code}' --retry 5 --retry-delay 2 --retry-all-errors \
    -X POST "$ORIGIN/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}" || true)"
  if [ "$status" != "200" ]; then
    echo "FAIL: POST $ORIGIN/mcp $method returned HTTP ${status:-000}" >&2
    rm -f "$body"
    exit 1
  fi
  cat "$body"
  rm -f "$body"
}

FILTERED="$(mcp 'tools/call' '{"name":"grokbot_search","arguments":{"query":"shagghie","author":"shagghie"}}')"
OPEN="$(mcp 'tools/call' '{"name":"grokbot_search","arguments":{"query":"shagghie"}}')"
AT="$(mcp 'tools/call' '{"name":"grokbot_search","arguments":{"query":"shagghie","author":"@shagghie"}}')"
LISTED="$(mcp 'tools/list' '{}')"

FILTERED="$FILTERED" OPEN="$OPEN" AT="$AT" LISTED="$LISTED" node --input-type=module <<'JS'
const filtered = JSON.parse(process.env.FILTERED);
const open = JSON.parse(process.env.OPEN);
const at = JSON.parse(process.env.AT);
const listed = JSON.parse(process.env.LISTED);
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const dash = '\u2014';

function botsOf(doc) {
  const result = doc.result;
  if (!result || result.isError) fail('search isError: ' + JSON.stringify(result && result.content));
  const bots = result.structuredContent && result.structuredContent.bots;
  if (!Array.isArray(bots)) fail('structuredContent.bots missing');
  return { bots, text: result.content && result.content[0] && result.content[0].text };
}

function assertText(text, bots, label) {
  if (typeof text !== 'string') fail(label + ' text missing');
  const lines = text.split('\n');
  if (lines[0] !== bots.length + ' matches:') fail(label + ' first line ' + JSON.stringify(lines[0]));
  if (lines.length !== bots.length + 1) fail(label + ' line count ' + lines.length);
  bots.forEach((b, i) => {
    const want = (i + 1) + '. ' + b.name + ' ' + dash + ' id: ' + b.id + ' ' + dash + ' https://grokbot.zone/bots/' + b.id + '/';
    if (lines[i + 1] !== want) fail(label + ' line ' + (i + 1) + ' ' + JSON.stringify(lines[i + 1]));
    const keys = Object.keys(b).sort().join(',');
    if (keys !== 'author,category,description,id,link,name,score') fail(label + ' bot keys ' + keys);
    if (typeof b.link !== 'string' || !b.link.startsWith('https://x.ai/bot/')) fail(label + ' link is not the x.ai bot URL');
  });
}

const f = botsOf(filtered);
if (f.bots.length < 1) fail('author=shagghie returned 0; expected the exact-author set');
if (f.bots.length > 10) fail('author=shagghie returned ' + f.bots.length + ', cap is 10');
for (const b of f.bots) {
  if (String(b.author).trim().toLowerCase() !== 'shagghie') fail('filtered author ' + JSON.stringify(b.author));
}
assertText(f.text, f.bots, 'filtered');
for (const b of f.bots) {
  if (b.description && f.text.includes(b.description)) fail('description leaked into text: ' + b.description);
}

const o = botsOf(open);
assertText(o.text, o.bots, 'open');
const openIds = new Set(o.bots.map((b) => b.id));
const overlap = f.bots.filter((b) => openIds.has(b.id));
if (overlap.length < 1) fail('query=shagghie did not return any author=shagghie bot');

const a = botsOf(at);
if (a.bots.length !== 0 || a.text !== '0 matches:') fail('@shagghie returned ' + JSON.stringify(a.text));

const tools = listed.result && listed.result.tools;
if (!Array.isArray(tools) || tools.length !== 9) fail('tool count ' + (tools && tools.length));
const search = tools.find((t) => t.name === 'grokbot_search');
if (!search) fail('grokbot_search missing');
const schema = search.inputSchema;
if (!schema || schema.additionalProperties !== false) fail('additionalProperties');
if (JSON.stringify(schema.required) !== '["query"]') fail('required ' + JSON.stringify(schema.required));
if (JSON.stringify(Object.keys(schema.properties)) !== '["query","category","author"]') fail('properties ' + JSON.stringify(Object.keys(schema.properties)));

console.log('PASS: ' + f.bots.length + ' exact-author bots named in text; open query overlaps ' + overlap.length + '; @shagghie is 0 matches:; 9 tools');
JS
