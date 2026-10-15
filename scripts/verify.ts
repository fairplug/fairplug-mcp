// End-to-end check: spawns the real MCP server over stdio with the official SDK client,
// calls both tools, follows the tracked link on the local redirect server, simulates a conversion, prints the report.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fairplug-verify-"));
const port = 18787;
const env = { ...process.env as Record<string, string>, FAIRPLUG_DATA_DIR: dataDir, FAIRPLUG_PORT: String(port), FAIRPLUG_REDIRECT_BASE: `http://127.0.0.1:${port}` };
const must = (c: unknown, m: string) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("ok  -", m); };

const redirect = spawn("node", [path.join(root, "dist/src/redirect.js")], { env, stdio: "ignore" });
const client = new Client({ name: "verify", version: "0" });
try {
  await client.connect(new StdioClientTransport({ command: "node", args: [path.join(root, "dist/src/server.js")], env }));
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  must(tools.join() === "get_tracked_link,search_offers", `tools listed: ${tools}`);
  const parse = (r: any) => JSON.parse(r.content[0].text);

  const s = parse(await client.callTool({ name: "search_offers", arguments: { query: "hotel harbour", category: "travel", region: "US" } }));
  console.log(JSON.stringify(s.offers[0], null, 2));
  must(s.count > 0 && s.notice.includes("EXAMPLE"), `search_offers returned ${s.count} offers, marked example`);
  must(s.offers.every((o: any) => o.disclosure.label && o.sponsored), "every offer carries disclosure label");

  const l = parse(await client.callTool({ name: "get_tracked_link", arguments: { offer_id: s.offers[0].offer_id, agent_id: "verify_agent", context: "user wants a quiet hotel" } }));
  console.log(JSON.stringify(l, null, 2));
  must(l.click_id.startsWith("clk_") && l.disclosure_text.length > 20, "get_tracked_link returned click id + disclosure_text");

  const bad = await client.callTool({ name: "get_tracked_link", arguments: { offer_id: "off_nope", agent_id: "verify_agent" } });
  must(bad.isError === true, "unknown offer rejected with isError");

  for (let i = 0; i < 20; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  const r = await fetch(l.tracked_url, { redirect: "manual" });
  must(r.status === 302 && r.headers.get("location")!.includes("fp_click_id=" + l.click_id), `redirect 302 -> ${r.headers.get("location")}`);
  const tampered = await fetch(l.tracked_url.replace("a=verify_agent", "a=evil"), { redirect: "manual" });
  must(tampered.status === 400, "tampered link rejected (400)");

  const cli = (...a: string[]) => execFileSync("node", [path.join(root, "dist/src/cli.js"), ...a], { env, encoding: "utf8" });
  console.log(cli("record_conversion", "--click-id", l.click_id, "--order-value", "329", "--network-fee", "0.30"));
  console.log(cli("report"));
  const events = fs.readFileSync(path.join(dataDir, "events.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x));
  must(["tool_call", "link_issued", "click", "click_rejected", "conversion"].every((t) => events.some((e) => e.type === t)), `event log has all types (${events.length} events, ${dataDir})`);
  console.log("\nVERIFY PASSED");
} finally { await client.close().catch(() => {}); redirect.kill(); }
