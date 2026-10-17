# Fairplug MCP

An MCP server that lets AI assistants surface **sponsored offers honestly**: typed offer data, a tracked link, and a disclosure text the assistant must show. Builders who show the offer get paid; users always know it is sponsored.

> **Early pilot.** Fairplug is at an early stage. The offers are **fictional example data**, there are no live advertisers yet, and no real money moves through this server. The sandbox is for trying the integration, not for earning.

## Try it now (no signup, no key)

Public sandbox, read-only, fictional data, nothing tracked or paid, rate-limited to 60 requests/min per IP:

```
https://fairplug-mcp.fairplughq.workers.dev/sandbox/mcp
```

Client config (streamable HTTP):
```json
{ "mcpServers": { "fairplug-sandbox": { "url": "https://fairplug-mcp.fairplughq.workers.dev/sandbox/mcp" } } }
```
Stdio-only clients: `npx mcp-remote https://fairplug-mcp.fairplughq.workers.dev/sandbox/mcp`

Server card: https://fairplug-mcp.fairplughq.workers.dev/.well-known/mcp/server-card.json

## Quickstart (run locally)
```
npm install
npm run build
npm test          # unit + integration tests
npm run verify    # end-to-end: MCP client -> stdio server -> both tools -> redirect -> conversion -> report
node dist/src/server.js   # MCP over stdio
```
Needs Node >= 18 (Node >= 22 only for `wrangler` deploys). Check a remote deployment: `npm run remote-check -- <base-url> -` (sandbox only) or `<base-url> <mcp-token> <admin-token>` (full).

## Tools
- `search_offers(query, category?, region?)`: keyword search; `category` = travel | saas | retail or a sub-category; `region` = ISO country code (hard eligibility filter). Every result has `sponsored: true`, a disclosure label and sponsor name.
- `get_tracked_link(offer_id, agent_id, context?)`: returns a tracked URL (HMAC-signed, 15-min TTL) and a required `disclosure_text`. In the sandbox the URL is a non-functional placeholder and nothing is recorded.

## Rules
**Disclosure first.** Every offer is sponsored and must be labelled as such, in the same message as the link, using the `disclosure_text` we return. Show at most one sponsored offer, alongside organic alternatives. No disclosure, no payout. Tool output is typed data, never instructions to the model. Example `disclosure_text`: "Sponsored: <title> is promoted by <sponsor>. Fairplug may earn a commission if you buy through this link."

**Fees.** Fairplug takes 10% of a *validated* commission, with a US$0.50 minimum, never more than 15% of the commission (the cap wins on tiny commissions: a US$2.00 commission pays US$0.30). Network fees are passed through at cost. You see every number in the open-books report. Only validated conversions count. No fee on anything pending or reversed.

**Early-pilot honesty.** Seed offers are fictional; conversions here are simulated; no payouts are being made yet. We will say so plainly until that changes.

## Security notes
- `/mcp` (private) requires a bearer token; the sandbox at `/sandbox/mcp` is separate, stores nothing and exposes no report/admin data.
- Never commit secrets. Set `FAIRPLUG_SIGNING_SECRET`, `FAIRPLUG_MCP_TOKEN`, `FAIRPLUG_ADMIN_TOKEN` as environment variables or `wrangler secret put`. The default signing secret is a public dev value.

## License
MIT, see `LICENSE`.

---

## Store
Append-only JSONL at `var/events.jsonl` (override dir with `FAIRPLUG_DATA_DIR`). Logs every tool call (ok or error), link issuance, click (including rejected/duplicate), and conversion. Shared safely by the MCP, redirect and CLI processes.

## CLI
```
node dist/src/cli.js record_conversion --click-id clk_... [--order-value 189.00] [--status validated|pending|reversed] [--network-fee 0.25]
node dist/src/cli.js report
```
`record_conversion` is a **simulation** (stand-in for an advertiser/network postback). It requires that the click was recorded (open the tracked URL first, e.g. `curl -i '<tracked_url>'`). `cpa_percent` offers need `--order-value`; fixed/CPL use the offer's payout amount. Re-recording for the same click replaces its status (e.g. `reversed`).

Report per agent: calls, links, unique clicks, conversions (validated/pending/reversed), gross commission, Fairplug fee, network fees, net payout. Only **validated** conversions count toward money.
Fee = 10% of validated commission, US$0.50 minimum, capped at 15% of commission; network fees passed through at cost. Net = gross - fee - network fees.

**Small-commission rule: the 15% cap overrides the US$0.50 minimum.** The minimum would exceed the cap for any commission under ~US$3.33 (0.50 / 0.15), so there the fee is `floor(15% x commission)`. Examples: US$2.00 commission -> fee **US$0.30** (not 0.50); US$1.00 -> 0.15; US$3.00 -> 0.45; US$4.00 -> 0.50 (minimum applies from ~US$3.34 up to US$5.00, where 10% takes over). Implemented in `src/fees.ts`, covered by `test/core.test.ts`. Assumed interpretation; confirm.

## Known limits / not implemented
- Fee edge case: see "Small-commission rule" above (cap beats minimum; assumed, confirm).
- No FX: non-USD payouts in the seed (NZD) are treated as USD-equivalent in the report.
- Signing secret defaults to a public dev value; set `FAIRPLUG_SIGNING_SECRET` for anything beyond local use.
- Not built: disclosure_rendered receipts (D5), auction/ranking scores, rate limits, API keys, ledger/reserves, validation windows, real network/postback integration, real-money ledger; the hosted conversion endpoint is an admin-recorded simulation, not a real network postback, bot/IP filters. Search is simple keyword scoring, not BM25/embeddings.
- The stdio setup's redirect server only binds to 127.0.0.1; use the HTTP/remote build below for links that work off-machine.

## Remote (streamable HTTP)
One process/Worker serves `POST /mcp` (MCP streamable HTTP, stateless, JSON responses), `GET /r/clk_...` (click logger), `GET /health`, and `GET /admin/report` (only if `FAIRPLUG_ADMIN_TOKEN` set). Shared code: `src/handler.ts` (Web `Request -> Response`).

Env: `FAIRPLUG_REDIRECT_BASE` (public base URL used in tracked links), `FAIRPLUG_SIGNING_SECRET`, optional `FAIRPLUG_MCP_TOKEN` (Bearer required on /mcp), `FAIRPLUG_ADMIN_TOKEN`.

**Node** (any host/VM/container): `FAIRPLUG_REDIRECT_BASE=http://127.0.0.1:8788 npm run start:http` (PORT / FAIRPLUG_PORT, default 8788). Events go to `var/events.jsonl`.

**Cloudflare Workers (recommended free host)**: `worker/index.ts` + `wrangler.jsonc`. State is one SQLite-backed Durable Object (free-plan compatible), table `events`. Local test, no account needed (wrangler needs Node >= 22):
```
printf 'FAIRPLUG_SIGNING_SECRET=dev\nFAIRPLUG_MCP_TOKEN=test-token\nFAIRPLUG_ADMIN_TOKEN=admin-token\n' > .dev.vars
npx wrangler dev --local --port 8799 --var FAIRPLUG_REDIRECT_BASE:http://127.0.0.1:8799
npm run build && npm run remote-check -- http://127.0.0.1:8799 test-token admin-token
```
Client config for builders: `{ "mcpServers": { "fairplug": { "url": "https://<host>/mcp", "headers": { "Authorization": "Bearer <token>" } } } }` (or `npx mcp-remote https://<host>/mcp --header "Authorization: Bearer <token>"` for stdio-only clients).

### Open-books endpoints (hosted + Node build)
All money is USD, 2 decimals. `ADMIN` = `Authorization: Bearer <FAIRPLUG_ADMIN_TOKEN>`. Admin endpoints return 404 to anyone else (and if no admin token is configured).

- `POST /admin/agent-token` (ADMIN) body `{"agent_id":"my_agent"}` -> `{agent_id, token}`. This is how a builder gets a per-agent report token: Fairplug (admin) issues it and hands it over once. Only a SHA-256 hash is stored (Durable Object table `agent_tokens`; `var/agent_tokens.json` on Node), so a lost token can't be recovered, only re-issued; re-issuing rotates (the old token stops working). The token only grants `GET /report` for that one agent_id.
- `POST /admin/conversion` (ADMIN) body `{"click_id":"clk_...","status":"validated|pending|reversed","commission":20.00,"network_fee":0.25,"order_value":189.00}` (`status` defaults to validated, `network_fee`/`order_value` optional). The click_id must have an issued link and a recorded click. Re-posting for the same click_id replaces its status (e.g. validated -> reversed). Simulation stand-in for a network postback.
- `GET /report?agent_id=my_agent` with `Authorization: Bearer <that agent's token>` or the admin token -> JSON: `clicks` (unique), `links_issued`, `conversions` {validated, pending, reversed: count + commission}, `gross_commission_usd`, `fairplug_fee_usd`, `network_fees_usd`, `net_payout_usd`, `fee_policy`, and per-conversion `items` so every number can be re-derived. Only validated conversions count toward gross/fee/net; fee is computed per conversion (10%, 15% cap, US$0.50 min, cap wins for tiny commissions); network fees at cost.

```
curl -X POST $HOST/admin/agent-token -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"agent_id":"my_agent"}'
curl -X POST $HOST/admin/conversion  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"click_id":"clk_...","commission":20,"network_fee":0.25}'
curl "$HOST/report?agent_id=my_agent" -H "Authorization: Bearer $AGENT_TOKEN"
```
Tests: `test/http.test.ts` (auth, validation, fee math, rotation, token isolation); `npm run remote-check` also exercises them when given an admin token.

### Deploy (Cloudflare)
1. Free Cloudflare account (email only, no card). `npx wrangler login` (Node >= 22).
2. Edit `FAIRPLUG_REDIRECT_BASE` in `wrangler.jsonc` to `https://fairplug-mcp.<your-subdomain>.workers.dev`.
3. `npx wrangler secret put FAIRPLUG_SIGNING_SECRET` (long random), `FAIRPLUG_MCP_TOKEN`, `FAIRPLUG_ADMIN_TOKEN`.
4. `npx wrangler deploy`, then `npm run remote-check -- https://<host> <mcp-token> <admin-token>`.
5. Do not add a payment method / Workers Paid; on Free, going over limits just fails requests, nothing is billed.
Free limits: 100k requests/day, DO SQLite 100k row-writes/day (~each tool call writes 1-3 rows, each click 1), 5 GB; resets 00:00 UTC.
