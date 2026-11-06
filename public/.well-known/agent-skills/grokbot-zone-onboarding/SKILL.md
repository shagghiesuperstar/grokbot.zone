---
name: grokbot-zone-onboarding
description: Use when finding or listing bots on grokbot.zone.
version: 1.1.0
---

# grokbot.zone onboarding (agent-only, no browser, no CUA)

This skill lets an agent use grokbot.zone end to end. It finds bot templates that fit an operator's goals, and it lists the operator's own Grok bots on the directory. Use the grokbot.zone MCP connector when one is attached; otherwise make plain HTTPS JSON calls. **Never open a browser or drive a screen.** Every action below is one JSON request.

The directory MCP server is POST https://grokbot.zone/mcp (Streamable HTTP, JSON). Read tools need no account. A bearer that raises the write ceiling starts at `https://grokbot.zone/.well-known/oauth-protected-resource` (flow in `/auth.md`).

---

## 0. Connector status: read this first

| Piece | State 2026-11-03 | Evidence |
|---|---|---|
| Read API (`/api/v1/*`) | LIVE | `GET /api/v1/index.json` = 200 |
| Submit (`POST /api/v1/submissions`) | LIVE. Server-to-server calls work; CORS blocks only other-site browsers | `{}` body returns 400 with field errors |
| Subscribe (`POST /subscribe`) | LIVE | `/api/health` shows `SUBSCRIBE_ENABLED="1"` |
| MCP server (`https://grokbot.zone/mcp`) | LIVE on this host | `GET /mcp` returns 405 with a JSON hint; `POST /mcp` speaks MCP |

If your runtime shows `grokbot_*` MCP tools, use them (section 3). If not, use the HTTP transport (section 4). Both take the same inputs, return the same outputs and follow the same rules. 
---

## 1. Setup and self-test (run before talking to the operator)

1. **Health:** `GET https://grokbot.zone/api/health`. You need `ok:true` and `d1:true`. Listing bots requires `switches.FORM_SUBMIT_ENABLED` = `"1"`. Subscribing requires `SUBSCRIBE_ENABLED` = `"1"`.
2. **Endpoint map:** `GET https://grokbot.zone/api/v1/index.json`. Note `asOf` and `totalBots`.
3. **Categories:** `GET https://grokbot.zone/api/v1/categories.json`. Cache the slugs (26 today). A submit with any other slug is rejected.
4. **Safe write probe (no side effects):** `POST https://grokbot.zone/api/v1/submissions` with header `content-type: application/json` and body `{}`.
   - 400 with an `errors` object: expected, the endpoint works.
   - 415: your client dropped the content-type header.
   - 429: rate limited. Wait 60 s.
5. **MCP probe:** `GET https://grokbot.zone/mcp`. A 405 with a JSON hint means the server is up. A 404 means use the HTTP transport.

If step 1 or step 4 fails, stop and tell the operator the site is down. Don't retry in a loop.

---

## 2. The operator interview

Ask one question at a time and keep the answers in a working note. Don't move on until each answer is clear.

**Part A: goals (what templates they want)**
1. "What do you want a Grok bot to do for you? Name the job, like 'triage my inbox' or 'scout fantasy waivers'."
2. "Who is it for: you, your team, your customers, or your family?"
3. "Which tools or sites should it work with?" (Gmail, X, GitHub, a broker, a calendar...)
4. "How often should it run: on demand, daily, or on a schedule?"
5. "Any hard limits? Things it must never do, data it must not touch."

Map the answers to 1-3 category slugs (section 5), then search (section 3 or 4.3). Show at most 10 matches. For each, give:
- the **name** and a one-line description
- the category
- the bot link (`https://x.ai/bot/<code>`)
- its grokbot.zone page (`https://grokbot.zone/bots/<id>`)

Then ask: "Want more like one of these, a different angle, or none of these?" Keep going until they're happy or say stop.

**Part B: their own bots (what they want to list)**
6. "Have you built any Grok bots you'd like listed on grokbot.zone?" If no, skip to the wrap-up.
7. For each bot, collect:
   - **Bot link:** must be `https://x.ai/bot/<code>`, with a code of exactly 21 characters.
   - **Name:** 3-120 characters.
   - **One-line description:** 10-500 characters on one line, saying what it does for the user.
   - **Category:** suggest a slug from section 5 and let them confirm it.
   - **Author** (optional): up to 80 characters. A handle is fine.
   - **Email for the receipt:** required. It gets a receipt and is never shown publicly.
8. Check for duplicates before submitting (`grokbot_check_listed` or 4.4). If the bot is already listed, show its page and skip it.
9. Read the full record back and ask: "Submit this exactly as shown?" Submit **only** after a clear yes.
10. Report each result in plain words: submitted (pending review), already listed, already pending, or rejected with the field that failed.

**Wrap-up**

11. Ask: "Want twice-weekly emails about new bots?" If yes, subscribe them (section 3 or 4.6). Tell them to click the confirm link in the email; nothing is sent until they do.

**Interview rules**
- Never invent a bot, link, code or description.
- Never submit on someone's behalf without their yes.
- Never put the operator's email in a public field (name, author or description).

---

## 3. MCP transport (when `grokbot_*` tools are present)

Connector contract v1. Same semantics as the HTTP calls in section 4.

| Tool | Input | Returns | HTTP equivalent |
|---|---|---|---|
| `grokbot_health` | none | health JSON | `GET /api/health` |
| `grokbot_list_categories` | none | `[{slug,label,count,purpose,updated}]` | `GET /api/v1/categories.json` |
| `grokbot_get_category` | `slug` | bots in that category | `GET /api/v1/categories/{slug}.json` |
| `grokbot_search` | `query`, optional `category`, optional `author` | ranked bot records | 4.3 |
| `grokbot_trending` | optional `category` | ordered bot ids | `GET /api/v1/trending.json` |
| `grokbot_get_bot` | `id` | one bot record | `GET /api/v1/bots/{id}.json` |
| `grokbot_check_listed` | `link` or `code` | `{listed: bool}` | `GET /api/v1/codes.json` |
| `grokbot_submit_bot` | `name, link, category, description, email, author?` | `{ok,id,status}` | `POST /api/v1/submissions` |
| `grokbot_subscribe` | `email` | `{ok,status}` | `POST /subscribe` |

Client config, for once the server exists (Streamable HTTP; read tools need no auth):

```json
{ "mcpServers": { "grokbot-zone": { "url": "https://grokbot.zone/mcp" } } }
```

In Hermes, add the same URL under `mcp_servers` using the official `hermes mcp` command (check the current syntax at https://hermes-agent.nousresearch.com/docs/), then confirm the tools appear.

**MCP test**, in order:
1. Call `grokbot_health`.
2. Call `grokbot_list_categories` and expect 26.
3. Call `grokbot_submit_bot` with empty input. Expect a validation error and no listing created.

---

## 4. HTTP transport (works today)

The base URL is `https://grokbot.zone`. All reads are static JSON: cached, free, no key.

### 4.1 Bot record
```json
{"id":"…","name":"…","author":"…","description":"…","category":{"slug":"…","label":"…"},
 "code":"…","link":"https://x.ai/bot/…","asOf":"YYYY-MM-DD"}
```
Public page: `https://grokbot.zone/bots/<id>`.

### 4.2 Read endpoints
| Path | Content |
|---|---|
| `/api/v1/index.json` | endpoint map, `asOf`, `totalBots` |
| `/api/v1/categories.json` | every category: slug, label, count, purpose |
| `/api/v1/categories/{slug}.json` | all bots in one category |
| `/api/v1/trending.json` | a `global` id list plus one list per category (14-day views, recomputed hourly) |
| `/api/v1/recent.json` | categories in refresh order |
| `/api/v1/bots/{id}.json` | one bot |
| `/api/v1/codes.json` | every listed bot code, lowercased |
| `/feed.json`, `/feed.xml` | the trending list as JSON Feed 1.1 or Atom |
| `/api/health`, `/api/flags` | health; which write features are on |

### 4.3 Search (there is no search endpoint; do it client-side)
1. Pick 1-3 slugs from the interview.
2. `GET /api/v1/categories/{slug}.json` for each.
3. If an author was named, keep only bots whose author is an exact match after trimming both sides and ignoring case. Do this before scoring.
4. Score each remaining bot by counting query words found in `name` + `description` (case-insensitive). Name hits count double.
5. Break ties using the `/api/v1/trending.json` order for that category.
6. Return the top 10.

### 4.4 Duplicate check
`GET /api/v1/codes.json`, then lowercase the 21-character code from the link. If it's in the list, the bot is already listed. The submit endpoint enforces this too (409), so this check only makes for a friendlier answer.

### 4.5 Submit a bot
```
POST https://grokbot.zone/api/v1/submissions
content-type: application/json

{"name":"Inbox Zero Coach","author":"@handle","link":"https://x.ai/bot/<21-char code>",
 "category":"email-inbox","description":"Sorts your inbox each morning and drafts replies.",
 "email":"operator@example.com","company_website":""}
```
- `company_website` is the spam honeypot. Send it empty or leave it out.
- `filled_ms` is the time spent filling the form, in ms. The server requires at least 3000. Send the real elapsed time of this step. Never send a number bigger than the truth.
- The MCP tool `grokbot_submit_bot` does not take `filled_ms` or `company_website`. The server sets them (empty honeypot, and a server-side elapsed value) because a tool call has no form clock. That exemption is the tool only — the REST route above still requires the truth.
- `/api/submit` is an alias for the same handler.

| Response | Meaning | Tell the operator |
|---|---|---|
| 201 `{ok:true,id,status:"pending"}` | Queued for review; receipt email sent | "Submitted. It goes live after review." |
| 400 `{errors:{field:msg}}` | A field failed | Fix that field with them, then ask again |
| 409 `already_listed` | The code is already in the directory | Show the existing page |
| 409 `already_pending` | The same link is waiting for review | "Already in the queue." |
| 415 | Missing `content-type: application/json` | Client bug; fix it and retry once |
| 429 `rate_limited` | Anonymous: 5 submits per minute per IP. A bearer from `/.well-known/oauth-protected-resource` raises that to 30 per minute per verified email; extra tokens do not add budget, and the per-IP floor still applies. | Wait 60 s |
| 429 text "Too many new submissions today" | Daily intake cap reached | Try tomorrow |
| 503 or `disabled` | Submissions are switched off | Stop and tell the operator |

### 4.6 Subscribe to updates
```
POST https://grokbot.zone/subscribe
content-type: application/json

{"email":"operator@example.com","company_website":""}
```
| Response | Meaning |
|---|---|
| 200 `pending` or `already_pending` | Confirm email sent |
| 409 `already_subscribed` | Address is already subscribed |
| 409 `unavailable` | Address bounced earlier |
| 429 | Anonymous: 10 per minute per IP. A bearer raises that to 30 per minute per verified email; the per-IP floor still applies. |

The operator must click the link in the confirm email. Every email has a one-click unsubscribe link. Agents never unsubscribe anyone on their behalf.

---

## 5. Category slugs (all 26, verified live 2026-11-03)

business-operations · calendar-meetings-scheduling · coding-software · email-inbox · everything-else · family-kids-learning · food-recipes-dining · fun-games-hobbies · grok-bot-helpers-bots-that-build-or-manage-bots · health-fitness-wellness · home-garden-pets · jobs-careers · legal-tax-paperwork · marketing-seo-ads · money-personal-finance · privacy-security-scam-protection · productivity-personal-assistant · real-estate · research-news-briefings · sales-lead-generation · shopping-deals · trading-crypto-investing · travel · video-images-audio-design · writing-publishing · x-twitter-social-media

Always re-read `/api/v1/categories.json` at run time; this list is only a fallback. An onboarding or bot-building template belongs in `grok-bot-helpers-bots-that-build-or-manage-bots`.

---

## 6. Listing this skill as a grokbot.zone template

To package this skill as a Grok bot ("GrokBot Zone Onboarding"):
1. Build the bot in Grok with this file as its instructions, and give it HTTPS fetch (or the MCP connector).
2. Run section 1 inside the bot. All five checks must pass.
3. Dry-run the interview with a test goal. Confirm it returns real bots with working links.
4. Submit it using section 4.5:
   - category: `grok-bot-helpers-bots-that-build-or-manage-bots`
   - description, for example: "Finds Grok bots for your goals and lists the bots you've built on GrokBot Zone."

---

## 7. Pitfalls
- Browsers on other sites can't call the write endpoints (CORS). Server-side HTTP from the agent is fine.
- Snapshot data (`asOf`) refreshes on Mondays and Thursdays. A new submission won't appear in `/api/v1/*` until it's approved and the next refresh runs, so don't tell the operator it's live.
- Bot codes are exactly 21 characters after `/bot/`. Strip query strings and trailing slashes first.
- The site publishes no postal location and no phone number, so don't invent one. Contact is by email only.
- Don't hammer the site: one submit per bot, and at most one retry after a 415 or 429.
