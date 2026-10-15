// Smoke test of a REMOTE Fairplug MCP over streamable HTTP with the official SDK client.
// Usage: node dist/scripts/remote-check.js <base-url> [mcp-token] [admin-token]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [base, token, admin] = [process.argv[2]?.replace(/\/$/, ""), process.argv[3], process.argv[4]]; // token "-" = sandbox-only check
if (!base) { console.error("usage: remote-check <base-url> [mcp-token] [admin-token]"); process.exit(2); }
const must = (c: unknown, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok  -", m); };
const parse = (r: any) => JSON.parse(r.content[0].text);

if (token !== "-") {
  const client = new Client({ name: "remote-check", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined }));
  must((await client.listTools()).tools.map((t) => t.name).sort().join() === "get_tracked_link,search_offers", "tools listed over HTTP");
  const s = parse(await client.callTool({ name: "search_offers", arguments: { query: "hotel harbour", category: "travel", region: "US" } }));
  must(s.count > 0, `search_offers -> ${s.count} offers`);
  const l = parse(await client.callTool({ name: "get_tracked_link", arguments: { offer_id: s.offers[0].offer_id, agent_id: "remote_check" } }));
  must(l.tracked_url.startsWith(base + "/r/clk_"), `tracked_url on same host: ${l.tracked_url}`);
  await client.close();
  const r = await fetch(l.tracked_url, { redirect: "manual" });
  must(r.status === 302 && r.headers.get("location")!.includes("fp_click_id=" + l.click_id), `click -> 302 ${r.headers.get("location")}`);
  const r2 = await fetch(l.tracked_url, { redirect: "manual" });
  must(r2.status === 302, "duplicate click still redirects");
  if (admin) {
    const rep = (await (await fetch(`${base}/admin/report`, { headers: { authorization: `Bearer ${admin}` } })).json()) as any[];
    const row = rep.find((x) => x.agent_id === "remote_check");
    must(row && row.links >= 1 && row.clicks >= 1, `admin report row: ${JSON.stringify(row)}`);
  }
  if (admin) {
    const H = { authorization: `Bearer ${admin}`, "content-type": "application/json" };
    const post = (p: string, b: unknown) => fetch(`${base}${p}`, { method: "POST", headers: H, body: JSON.stringify(b) });
    const cr = await post("/admin/conversion", { click_id: l.click_id, status: "validated", commission: 20, network_fee: 0.25 });
    must(cr.status === 200, "admin/conversion recorded");
    const tk = (await (await post("/admin/agent-token", { agent_id: "remote_check" })).json()) as any;
    must(typeof tk.token === "string", "agent token issued");
    must((await fetch(`${base}/report?agent_id=remote_check`)).status === 401, "/report without token -> 401");
    const rr = (await (await fetch(`${base}/report?agent_id=remote_check`, { headers: { authorization: `Bearer ${tk.token}` } })).json()) as any;
    must(rr.conversions.validated.count >= 1 && rr.net_payout_usd > 0, `/report with agent token: gross ${rr.gross_commission_usd} fee ${rr.fairplug_fee_usd} net ${rr.net_payout_usd}`);
  }
  
  
}

// ---- Public sandbox (no auth) + server card ----
{
  const sc = new Client({ name: "sandbox-check", version: "0" });
  await sc.connect(new StreamableHTTPClientTransport(new URL(`${base}/sandbox/mcp`)));
  must((await sc.listTools()).tools.map((t) => t.name).sort().join() === "get_tracked_link,search_offers", "sandbox: tools listed, no auth");
  const ss = parse(await sc.callTool({ name: "search_offers", arguments: { query: "hotel harbour", category: "travel" } }));
  must(ss.sandbox === true && ss.count > 0, `sandbox search_offers -> ${ss.count}`);
  const sl = parse(await sc.callTool({ name: "get_tracked_link", arguments: { offer_id: ss.offers[0].offer_id, agent_id: "sandbox_check" } }));
  must(sl.sandbox === true && sl.tracked_url.includes("/sandbox/r/") && sl.disclosure_text, "sandbox get_tracked_link: marked sandbox, has disclosure");
  await sc.close();
  const sr = await fetch(sl.tracked_url, { redirect: "manual" });
  must(sr.status === 200, "sandbox link is a non-redirecting placeholder");
  const card = (await (await fetch(`${base}/.well-known/mcp/server-card.json`)).json()) as any;
  must(card.transport?.url === `${base}/sandbox/mcp`, "server-card.json served");
  must((await fetch(`${base}/mcp`, { method: "POST" })).status === 401, "private /mcp not open without token");
}
console.log("REMOTE CHECK PASSED");
