import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

process.env.FAIRPLUG_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fp-http-"));
process.env.FAIRPLUG_MCP_TOKEN = "test-token";
process.env.FAIRPLUG_ADMIN_TOKEN = "admin-token";
const { createHttpServer } = await import("../src/http.js");
const { readEvents } = await import("../src/store.js");

test("remote MCP over streamable HTTP: SDK client -> tools -> tracked link -> click -> report", async () => {
  const server = createHttpServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.FAIRPLUG_REDIRECT_BASE = base;
  try {
    // no token -> 401
    assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })).status, 401);

    const client = new Client({ name: "http-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer test-token" } } }));
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["get_tracked_link", "search_offers"]);

    const parse = (r: any) => JSON.parse(r.content[0].text);
    const s = parse(await client.callTool({ name: "search_offers", arguments: { query: "hotel harbour", category: "travel", region: "US" } }));
    assert.ok(s.count > 0 && s.sponsored);
    const l = parse(await client.callTool({ name: "get_tracked_link", arguments: { offer_id: s.offers[0].offer_id, agent_id: "http_agent" } }));
    assert.ok(l.tracked_url.startsWith(base + "/r/clk_") && l.disclosure_text);
    const bad = await client.callTool({ name: "get_tracked_link", arguments: { offer_id: "off_nope", agent_id: "http_agent" } });
    assert.equal(bad.isError, true);
    await client.close();

    // same-port click logger
    const r = await fetch(l.tracked_url, { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.ok(r.headers.get("location")!.includes("fp_click_id=" + l.click_id));
    assert.equal((await fetch(l.tracked_url, { redirect: "manual" })).status, 302);
    assert.equal((await fetch(l.tracked_url.replace("a=http_agent", "a=evil"), { redirect: "manual" })).status, 400);
    const clicks = readEvents().filter((e) => e.type === "click") as any[];
    assert.deepEqual(clicks.map((c) => c.duplicate), [false, true]);

    assert.equal((await fetch(`${base}/admin/report`)).status, 404);
    const rep = (await (await fetch(`${base}/admin/report`, { headers: { authorization: "Bearer admin-token" } })).json()) as any[];
    const row = rep.find((x) => x.agent_id === "http_agent");
    assert.equal(row.links, 1); assert.equal(row.clicks, 1);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally { server.close(); }
});

test("admin conversion + per-agent token + /report (open books)", async () => {
  const server = createHttpServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.FAIRPLUG_REDIRECT_BASE = base;
  const A = { authorization: "Bearer admin-token", "content-type": "application/json" };
  const post = (p: string, body: unknown, h: Record<string, string> = A) => fetch(base + p, { method: "POST", headers: h, body: JSON.stringify(body) });
  try {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer test-token" } } }));
    const parse = (r: any) => JSON.parse(r.content[0].text);
    const s = parse(await client.callTool({ name: "search_offers", arguments: { query: "hotel harbour", category: "travel" } }));
    const mk = async (agent: string) => {
      const l = parse(await client.callTool({ name: "get_tracked_link", arguments: { offer_id: s.offers[0].offer_id, agent_id: agent } }));
      await fetch(l.tracked_url, { redirect: "manual" });
      return l.click_id as string;
    };
    const c1 = await mk("rep_agent"), c2 = await mk("rep_agent"), c3 = await mk("rep_agent"), c4 = await mk("rep_agent"), other = await mk("other_agent");
    await client.close();

    // admin auth
    assert.equal((await post("/admin/conversion", { click_id: c1, commission: 10 }, { "content-type": "application/json" })).status, 404);
    assert.equal((await post("/admin/conversion", { click_id: c1, commission: 10 }, { authorization: "Bearer nope" })).status, 404);
    // validation
    assert.equal((await post("/admin/conversion", { click_id: c1, commission: -1 })).status, 400);
    assert.equal((await post("/admin/conversion", { click_id: c1, commission: 10, status: "weird" })).status, 400);
    assert.equal((await post("/admin/conversion", { click_id: c1, commission: 1, network_fee: 2 })).status, 400);
    assert.equal((await post("/admin/conversion", { click_id: "clk_deadbeef", commission: 10 })).status, 404);

    // $20 validated w/ $0.25 network fee -> fee $2.00 ; $2 validated -> fee $0.30 (cap beats min) ; pending $50 ; reversed $9
    assert.equal((await post("/admin/conversion", { click_id: c1, commission: 20, network_fee: 0.25 })).status, 200);
    assert.equal((await post("/admin/conversion", { click_id: c2, commission: "2.00", status: "validated" })).status, 200);
    assert.equal((await post("/admin/conversion", { click_id: c3, commission: 50, status: "pending" })).status, 200);
    assert.equal((await post("/admin/conversion", { click_id: c4, commission: 9, status: "validated" })).status, 200);
    assert.equal((await post("/admin/conversion", { click_id: c4, commission: 9, status: "reversed" })).status, 200); // later status wins
    assert.equal((await post("/admin/conversion", { click_id: other, commission: 100 })).status, 200);

    // tokens
    assert.equal((await post("/admin/agent-token", { agent_id: "rep_agent" }, { "content-type": "application/json" })).status, 404);
    assert.equal((await post("/admin/agent-token", { agent_id: "bad id!" })).status, 400);
    const tok = ((await (await post("/admin/agent-token", { agent_id: "rep_agent" })).json()) as any).token as string;
    const otherTok = ((await (await post("/admin/agent-token", { agent_id: "other_agent" })).json()) as any).token as string;
    assert.match(tok, /^fpa_[a-f0-9]{48}$/);

    const get = (q: string, t?: string) => fetch(`${base}/report?agent_id=${q}`, { headers: t ? { authorization: `Bearer ${t}` } : {} });
    assert.equal((await get("rep_agent")).status, 401);
    assert.equal((await get("rep_agent", "wrong")).status, 401);
    assert.equal((await get("rep_agent", otherTok)).status, 401); // another builder's token
    assert.equal((await get("nobody", tok)).status, 401);
    for (const t of [tok, "admin-token"]) {
      const r = (await (await get("rep_agent", t)).json()) as any;
      assert.equal(r.clicks, 4);
      assert.deepEqual(r.conversions, { validated: { count: 2, commission_usd: 22 }, pending: { count: 1, commission_usd: 50 }, reversed: { count: 1, commission_usd: 9 } });
      assert.equal(r.gross_commission_usd, 22);
      assert.equal(r.fairplug_fee_usd, 2.3); // 2.00 + 0.30
      assert.equal(r.network_fees_usd, 0.25);
      assert.equal(r.net_payout_usd, 19.45); // 22 - 2.30 - 0.25
      assert.equal(r.items.length, 4);
    }
    // rotation invalidates old token
    const tok2 = ((await (await post("/admin/agent-token", { agent_id: "rep_agent" })).json()) as any).token;
    assert.equal((await get("rep_agent", tok)).status, 401);
    assert.equal((await get("rep_agent", tok2)).status, 200);
    // no plaintext token persisted
    const stored = fs.readFileSync(path.join(process.env.FAIRPLUG_DATA_DIR!, "agent_tokens.json"), "utf8");
    assert.ok(!stored.includes(tok2));
  } finally { server.close(); }
});

test("public sandbox: no auth, read-only, nothing stored, server card", async () => {
  const server = createHttpServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const before = readEvents().length;
  try {
    const c = new Client({ name: "sbx-test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/sandbox/mcp`)));
    const parse = (r: any) => JSON.parse(r.content[0].text);
    const s = parse(await c.callTool({ name: "search_offers", arguments: { query: "hotel", category: "travel" } }));
    assert.ok(s.sandbox && s.count > 0);
    const l = parse(await c.callTool({ name: "get_tracked_link", arguments: { offer_id: s.offers[0].offer_id, agent_id: "t" } }));
    assert.ok(l.sandbox && l.tracked_url.includes("/sandbox/r/") && l.disclosure_text);
    await c.close();
    assert.equal(readEvents().length, before, "sandbox must not write events");
    const card: any = await (await fetch(`${base}/.well-known/mcp/server-card.json`)).json();
    assert.equal(card.authentication.required, false);
  } finally { server.close(); }
});
