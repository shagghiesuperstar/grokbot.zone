#!/usr/bin/env bash
# DOM assertions for search against a running origin. Usage: scripts/assert-search.sh [origin]
set -u
ORIGIN="${1:-http://localhost:4321}"
FIRST_ID="privacy-security-scam-protection-fUj6TYhiW_cjtzWvbsFgz"
# The number of bots the index holds comes from the generated data, never typed here.
INDEXED=$(python3 -I -c "import json;print(json.load(open('src/data/meta.json'))['totalBots'])")
probe() { # $1 = query
  chrome-devtools-axi eval "(async () => {
    const root = document.querySelector('[data-search-root]');
    const input = root.querySelector('[data-search-input]');
    input.focus(); input.value = '$1'; input.dispatchEvent(new Event('input', {bubbles:true}));
    for (let i = 0; i < 100 && !(root.dataset.state === 'results' || root.dataset.state === 'empty'); i++) await new Promise(r => setTimeout(r, 100));
    const rows = [...root.querySelectorAll('[data-search-results] > li')];
    return JSON.stringify({ state: root.dataset.state, indexed: root.dataset.total, count: root.querySelector('[data-search-count]').textContent,
      emptyVisible: !root.querySelector('[data-search-empty]').hidden, rendered: rows.length,
      first: rows[0] ? { id: rows[0].dataset.id, name: rows[0].querySelector('h3').textContent } : null,
      top5: rows.slice(0,5).map(r => r.querySelector('h3').textContent) });
  })()" 2>&1 | python3 -I -c "import sys,json;l=[x for x in sys.stdin if x.startswith('result:')][0][7:];v=json.loads(l);v=json.loads(v) if isinstance(v,str) else v;print(json.dumps(json.loads(v) if isinstance(v,str) else v))"
}
chrome-devtools-axi open "$ORIGIN/bots/" >/dev/null 2>&1
fails=0
check() { python3 -I -c "import sys,json;d=json.loads(sys.argv[1]);exec(sys.argv[2])" "$1" "$2" && echo "PASS: $3" || { echo "FAIL: $3"; fails=1; }; }
echo "--- query: spam call"; A=$(probe "spam call"); echo "$A"
check "$A" "assert d['first']['id']=='$FIRST_ID' and d['state']=='results'" "first result is $FIRST_ID"
echo "--- query: Shikamaru"; C=$(probe "Shikamaru"); echo "$C"
check "$C" "assert d['state']=='results' and d['rendered']==1" "a bot listed twice in the corpus returns one row"
echo "--- query: nonexistentwordhere"; B=$(probe "nonexistentwordhere"); echo "$B"
check "$B" "assert d['state']=='empty' and d['emptyVisible'] and d['rendered']==0 and d['indexed']=='$INDEXED'" "empty state shown, 0 rows rendered (not blank, not all $INDEXED)"
exit $fails
