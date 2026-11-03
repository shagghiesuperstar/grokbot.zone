#!/usr/bin/env python3
"""Run the 15 isitagentready checks plus the MCP contract against a base URL.

Prints one line per check and N/15. Exit 0 only when 14 pass and the only miss is dnsAid.
MCP probe failures also exit non-zero (they are not part of the 15).
"""
import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1].rstrip("/")
DOMAIN = "grokbot.zone"


def fetch(path, headers=None, method="GET", body=None):
    req = urllib.request.Request(BASE + path, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read()
            return res.status, dict(res.headers.items()), raw
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers.items()), e.read()


def hdr(headers, name):
    for k, v in headers.items():
        if k.lower() == name.lower():
            return v
    return ""


def main():
    passed = []
    failed = []

    def check(key, ok, detail):
        (passed if ok else failed).append(key)
        print(f"{'PASS' if ok else 'FAIL'}  {key}: {detail}")

    status, headers, body = fetch("/robots.txt")
    text = body.decode("utf-8", "replace")
    check("robotsTxt", status == 200 and "text/plain" in hdr(headers, "content-type") and "User-agent" in text, f"{status} {hdr(headers, 'content-type')[:40]}")

    sm_status, sm_headers, sm_body = fetch("/sitemap.xml")
    sm_ok = sm_status == 200 and sm_body.lstrip().startswith(b"<?xml") and b"<" in sm_body
    robots_sitemap = "Sitemap:" in text
    check("sitemap", sm_ok or robots_sitemap, f"/sitemap.xml {sm_status} robots_sitemap={robots_sitemap}")

    h_status, h_headers, _ = fetch("/", method="HEAD")
    link = hdr(h_headers, "link")
    agent_rels = any(rel in link for rel in ("service-desc", "describedby", "api-catalog", "ai-catalog", "mcp-server-card"))
    preload_only = "preload" in link and not agent_rels
    check("linkHeaders", h_status == 200 and agent_rels and not preload_only, f"{h_status} link={link[:140]}")

    dns_ok = False
    dns_detail = "no answer"
    try:
        dns_req = urllib.request.Request(
            f"https://cloudflare-dns.com/dns-query?name=_index._agents.{DOMAIN}&type=SVCB&do=1",
            headers={"accept": "application/dns-json"},
        )
        with urllib.request.urlopen(dns_req, timeout=15) as res:
            dns = json.loads(res.read().decode())
        dns_ok = dns.get("Status") == 0 and dns.get("AD") is True and len(dns.get("Answer") or []) > 0
        dns_detail = f"Status={dns.get('Status')} AD={dns.get('AD')} answers={len(dns.get('Answer') or [])}"
    except Exception as e:
        dns_detail = type(e).__name__
    check("dnsAid", dns_ok, dns_detail)

    md_status, md_headers, _ = fetch("/", method="HEAD", headers={"Accept": "text/markdown"})
    get_status, get_headers, md_body = fetch("/", headers={"Accept": "text/markdown"})
    md_type = hdr(md_headers, "content-type")
    md_text = md_body.decode("utf-8", "replace")
    check(
        "markdownNegotiation",
        md_status == 200 and "text/markdown" in md_type and "accept" in hdr(md_headers, "vary").lower() and get_status == 200 and "text/markdown" in hdr(get_headers, "content-type") and not md_text.lstrip().lower().startswith("<!doctype") and md_text.strip().startswith("#"),
        f"HEAD {md_status} {md_type} GET {get_status} starts={md_text[:40]!r}",
    )

    named = all(ua in text for ua in ("OAI-SearchBot", "ClaudeBot", "GPTBot", "User-agent: *"))
    check("robotsTxtAiRules", named or "User-agent: *" in text, "named+wildcard" if named else "wildcard-only" if "User-agent: *" in text else "missing")
    check("contentSignals", "Content-Signal:" in text and all(k in text for k in ("ai-train", "search", "ai-input")), "line present" if "Content-Signal:" in text else "missing")

    card_status, card_headers, card_body = fetch("/.well-known/mcp/server-card.json")
    try:
        card = json.loads(card_body)
    except json.JSONDecodeError:
        card = {}
    name = card.get("name") or (card.get("serverInfo") or {}).get("name")
    card2_status, card2_headers, _ = fetch("/mcp/server-card")
    check(
        "mcpServerCard",
        card_status == 200 and bool(name) and "mcp-server-card+json" in hdr(card_headers, "content-type") and card2_status == 200 and "mcp-server-card+json" in hdr(card2_headers, "content-type"),
        f"well-known {card_status} name={name} /mcp/server-card {card2_status}",
    )

    sk_status, _, sk_body = fetch("/.well-known/agent-skills/index.json")
    try:
        skills = json.loads(sk_body).get("skills")
    except json.JSONDecodeError:
        skills = None
    check("agentSkills", sk_status == 200 and isinstance(skills, list) and len(skills) >= 1 and skills[0].get("url"), f"{sk_status} n={len(skills) if isinstance(skills, list) else 0}")

    home_status, _, home_body = fetch("/")
    submit_status, _, submit_body = fetch("/submit/")
    home_html = home_body.decode("utf-8", "replace")
    submit_html = submit_body.decode("utf-8", "replace")
    has_register = "document.modelContext" in home_html and "registerTool" in home_html and "search_bots" in home_html and "submit_bot" in home_html
    has_forms = 'toolname="submit_bot"' in submit_html and "tooldescription=" in submit_html and 'toolname="subscribe"' in home_html
    check("webMcp", home_status == 200 and submit_status == 200 and has_register and has_forms, f"register={has_register} forms={has_forms}")

    cat_status, cat_headers, cat_body = fetch("/.well-known/api-catalog")
    try:
        linkset = json.loads(cat_body).get("linkset")
    except json.JSONDecodeError:
        linkset = None
    check("apiCatalog", cat_status == 200 and "linkset+json" in hdr(cat_headers, "content-type") and isinstance(linkset, list) and len(linkset) >= 1, f"{cat_status} {hdr(cat_headers, 'content-type')}")

    oa_status, _, oa_body = fetch("/.well-known/oauth-authorization-server")
    check(
        "oauthDiscovery",
        oa_status == 200 and b"authorization_endpoint" in oa_body and b"agent_auth" in oa_body and b"registration_endpoint" in oa_body and b"S256" in oa_body,
        f"{oa_status}",
    )
    pr_status, _, pr_body = fetch("/.well-known/oauth-protected-resource")
    check("oauthProtectedResource", pr_status == 200 and b"authorization_servers" in pr_body and b"resource" in pr_body, f"{pr_status}")
    au_status, _, au_body = fetch("/auth.md")
    check("authMd", au_status == 200 and len(au_body) > 20, f"{au_status}")

    ar_status, ar_headers, ar_body = fetch("/.well-known/ai-catalog.json")
    try:
        ard = json.loads(ar_body)
    except json.JSONDecodeError:
        ard = {}
    entries = ard.get("entries") if isinstance(ard, dict) else None
    check(
        "ard",
        ar_status == 200 and "ai-catalog+json" in hdr(ar_headers, "content-type") and isinstance(ard.get("specVersion"), str) and isinstance(entries, list) and len(entries) >= 1 and all(str(e.get("id", "")).startswith("urn:air:grokbot.zone:") for e in entries),
        f"{ar_status} entries={len(entries) if isinstance(entries, list) else 0}",
    )

    n = len(passed)
    print(f"\n{n}/15")
    print("passed:", ", ".join(passed) or "(none)")
    print("failed:", ", ".join(failed) or "(none)")

    mcp_ok = mcp_probe()
    only_dns = failed == ["dnsAid"] and n == 14
    if only_dns and mcp_ok:
        return 0
    if not only_dns:
        print("exit: not 14/15 with dnsAid as the only miss")
    if not mcp_ok:
        print("exit: MCP probe failed")
    return 1


def mcp_rpc(method, params, req_id=1) -> tuple[int, dict]:
    payload = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}).encode()
    status, _, body = fetch("/mcp", method="POST", body=payload, headers={
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
    })
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        parsed = {"raw": body[:200].decode("utf-8", "replace")}
    return status, parsed


def mcp_probe():
    print("\n--- MCP ---")
    ok = True
    status, init = mcp_rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "agentready-local", "version": "1"}})
    names_ok = False
    status_l, listed = mcp_rpc("tools/list", {})
    tools = (((listed.get("result") or {}).get("tools")) or [])
    names = [t.get("name") for t in tools]
    expected = [
        "grokbot_check_listed", "grokbot_get_bot", "grokbot_get_category", "grokbot_health", "grokbot_list_categories",
        "grokbot_search", "grokbot_submit_bot", "grokbot_subscribe", "grokbot_trending",
    ]
    names_ok = names == expected
    print(f"{'PASS' if status == 200 and names_ok else 'FAIL'}  tools/list: {names}")
    ok = ok and status == 200 and names_ok and (init.get("result") or {}).get("serverInfo", {}).get("name") == "grokbot.zone"

    reads = [
        ("grokbot_health", {}),
        ("grokbot_list_categories", {}),
        ("grokbot_trending", {}),
        ("grokbot_check_listed", {"code": "placeholder"}),
    ]
    # category + bot + search depend on the catalog. Pull a slug and an id from list_categories / get_category.
    st, cats = mcp_rpc("tools/call", {"name": "grokbot_list_categories", "arguments": {}}, 10)
    structured = ((cats.get("result") or {}).get("structuredContent")) or {}
    is_err = (cats.get("result") or {}).get("isError")
    print(f"{'PASS' if st == 200 and not is_err else 'FAIL'}  tools/call grokbot_list_categories isError={is_err}")
    ok = ok and st == 200 and not is_err
    slug = None
    categories = structured.get("categories") or []
    if categories:
        slug = categories[0].get("slug")
    if slug:
        st, cat = mcp_rpc("tools/call", {"name": "grokbot_get_category", "arguments": {"slug": slug}}, 11)
        cat_err = (cat.get("result") or {}).get("isError")
        print(f"{'PASS' if st == 200 and not cat_err else 'FAIL'}  tools/call grokbot_get_category slug={slug} isError={cat_err}")
        ok = ok and st == 200 and not cat_err
        bots = (((cat.get("result") or {}).get("structuredContent")) or {}).get("bots") or []
        bot_id = bots[0].get("i") if bots else None
        if bot_id:
            st, bot = mcp_rpc("tools/call", {"name": "grokbot_get_bot", "arguments": {"id": bot_id}}, 12)
            bot_err = (bot.get("result") or {}).get("isError")
            print(f"{'PASS' if st == 200 and not bot_err else 'FAIL'}  tools/call grokbot_get_bot id={bot_id} isError={bot_err}")
            ok = ok and st == 200 and not bot_err
            name = bots[0].get("n") or "bot"
            st, search = mcp_rpc("tools/call", {"name": "grokbot_search", "arguments": {"query": name.split()[0], "category": slug}}, 13)
            search_err = (search.get("result") or {}).get("isError")
            print(f"{'PASS' if st == 200 and not search_err else 'FAIL'}  tools/call grokbot_search isError={search_err}")
            ok = ok and st == 200 and not search_err
        else:
            print("FAIL  tools/call grokbot_get_bot: no bot id in category")
            ok = False
    else:
        print("FAIL  no category slug from list_categories")
        ok = False

    for name, args in (("grokbot_health", {}), ("grokbot_trending", {}), ("grokbot_check_listed", {"code": "AAAAAAAAAAAAAAAAAAAAA"})):
        st, res = mcp_rpc("tools/call", {"name": name, "arguments": args}, 20)
        err = (res.get("result") or {}).get("isError")
        print(f"{'PASS' if st == 200 and not err else 'FAIL'}  tools/call {name} isError={err}")
        ok = ok and st == 200 and not err

    st, bad = mcp_rpc("tools/call", {"name": "grokbot_submit_bot", "arguments": {
        "name": "Nope Bot", "link": "https://x.ai/bot/NewBot-12345000000000", "category": slug or "email-inbox",
        "description": "This description is long enough.", "email": "not-an-email",
    }}, 30)
    err = (bad.get("result") or {}).get("isError")
    print(f"{'PASS' if st == 200 and err else 'FAIL'}  tools/call grokbot_submit_bot invalid email isError={err}")
    ok = ok and st == 200 and err is True
    print(f"MCP probe: {'PASS' if ok else 'FAIL'}")
    return ok


if __name__ == "__main__":
    sys.exit(main())
