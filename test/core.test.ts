import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { AddressInfo } from "node:net";

process.env.FAIRPLUG_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fp-test-"));
const { fairplugFeeCents } = await import("../src/fees.js");
const { loadOffers, searchOffers } = await import("../src/offers.js");
const { searchOffersTool, getTrackedLinkTool } = await import("../src/tools.js");
const { buildLink, verifyLink } = await import("../src/links.js");
const { createRedirectServer } = await import("../src/redirect.js");
const { buildReport, recordConversion } = await import("../src/cli.js");
const { readEvents } = await import("../src/store.js");

test("fee: tiny commissions - 15% cap overrides the $0.50 minimum", () => {
  assert.equal(fairplugFeeCents(200), 30);   // $2.00 commission pays $0.30, NOT $0.50
  assert.equal(fairplugFeeCents(100), 15);   // $1.00 -> $0.15
  assert.equal(fairplugFeeCents(300), 45);   // $3.00 -> $0.45 (cap < min)
  assert.equal(fairplugFeeCents(333), 49);   // just under the ~$3.33 crossover
  assert.equal(fairplugFeeCents(334), 50);   // crossover: cap == min
  assert.equal(fairplugFeeCents(400), 50);   // min applies again from here
  assert.equal(fairplugFeeCents(1), 0);      // cap floors to 0 cents on 1c commission
  for (let c = 1; c <= 2000; c++) assert.ok(fairplugFeeCents(c) <= c * 0.15, `fee never exceeds 15% at ${c}c`);
});

test("fee: 10%, $0.50 min, 15% cap", () => {
  assert.equal(fairplugFeeCents(10000), 1000);  // 10%
  assert.equal(fairplugFeeCents(1000), 100);    // 10% of $10
  assert.equal(fairplugFeeCents(400), 50);      // 10%=40 -> min 50 (cap 60)
  assert.equal(fairplugFeeCents(200), 30);      // min 50 > cap 30 -> cap wins
  assert.equal(fairplugFeeCents(0), 0);
});

test("seed: 12+ offers across travel, saas, retail, schema-ish and marked example", () => {
  const o = loadOffers();
  assert.ok(o.length >= 12);
  for (const v of ["travel", "b2b_saas", "retail"]) assert.ok(o.filter((x) => x.vertical === v).length >= 3, v);
  for (const x of o) { assert.match(x.id, /^off_[a-z0-9]{12}$/); assert.ok(x.disclosure.label && x.disclosure.sponsor_name); assert.ok(x.is_example); assert.ok(x.title.length <= 120 && x.summary.length <= 400); }
  assert.match(JSON.parse(fs.readFileSync(new URL("../../data/offers.json", import.meta.url), "utf8"))._notice, /EXAMPLE/);
});

test("search filters by category and region", () => {
  const r = searchOffers("hotel", "travel", "US");
  assert.ok(r.length > 0 && r.every((x) => x.offer.vertical === "travel" && x.offer.eligibility.geo!.includes("US")));
  assert.equal(searchOffers("espresso", undefined, "CA").length, 0);
  assert.ok(searchOffers("password manager", "saas").length > 0);
  assert.equal(searchOffers("zzzzqq").length, 0);
});

test("tools: search logs, link has disclosure, bad inputs rejected", () => {
  const s = searchOffersTool({ query: "ci hosting" });
  assert.ok(s.count > 0 && s.notice.includes("EXAMPLE"));
  const l = getTrackedLinkTool({ offer_id: s.offers[0].offer_id, agent_id: "t_agent" });
  assert.match(l.click_id, /^clk_/); assert.ok(l.disclosure_text.includes("Sponsored") || l.disclosure_text.includes("Ad") || l.disclosure_text.includes("Affiliate"));
  assert.ok(!/assistant may be paid/.test(l.disclosure_text) && (l.disclosure_text.match(/\./g) || []).length === 2, "disclosure is one clear statement, no duplicate");
  assert.throws(() => getTrackedLinkTool({ offer_id: "off_x", agent_id: "t_agent" }));
  assert.throws(() => getTrackedLinkTool({ offer_id: s.offers[0].offer_id, agent_id: "bad agent!" }));
  const ev = readEvents();
  assert.ok(ev.filter((e) => e.type === "tool_call").length >= 4 && ev.some((e) => e.type === "link_issued"));
});

test("link signature: valid, tampered, expired", () => {
  const { url } = buildLink("clk_abc123", "off_trv000000001", "a1");
  const q = new URL(url).searchParams;
  assert.ok(verifyLink("clk_abc123", q).ok);
  assert.equal((verifyLink("clk_abc123", new URLSearchParams({ ...Object.fromEntries(q), a: "evil" })) as any).reason, "bad_signature");
  assert.equal((verifyLink("clk_abc123", q, Date.now() + 16 * 60 * 1000) as any).reason, "expired");
});

test("redirect logs click, 302s; conversion + report math", async () => {
  const srv = createRedirectServer().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const port = (srv.address() as AddressInfo).port;
  const get = (u: string) => new Promise<http.IncomingMessage>((res) => http.get(u, res));
  try {
    const l = getTrackedLinkTool({ offer_id: "off_ret000000001", agent_id: "rep_agent" }); // cpa_percent 8%
    const u = new URL(l.tracked_url); const url = `http://127.0.0.1:${port}${u.pathname}${u.search}`;
    assert.throws(() => recordConversion({ clickId: l.click_id, orderValueCents: 10000 }), /no recorded click/);
    const r = await get(url);
    assert.equal(r.statusCode, 302); assert.match(r.headers.location!, /fp_click_id=clk_/);
    assert.equal((await get(url.replace("a=rep_agent", "a=x"))).statusCode, 400);
    await get(url); // duplicate click: logged, not counted
    recordConversion({ clickId: l.click_id, orderValueCents: 20000, networkFeeCents: 25 }); // commission $16.00
    const row = buildReport().find((x) => x.agent_id === "rep_agent")!;
    assert.equal(row.clicks, 1); assert.equal(row.validated, 1);
    assert.equal(row.gross, 1600); assert.equal(row.fee, 160); assert.equal(row.network, 25); assert.equal(row.net, 1600 - 160 - 25);
    // pending doesn't pay; reversal removes it
    recordConversion({ clickId: l.click_id, orderValueCents: 20000, status: "reversed" });
    const r2 = buildReport().find((x) => x.agent_id === "rep_agent")!;
    assert.equal(r2.net, 0); assert.equal(r2.reversed, 1); assert.equal(r2.conversions, 1);
  } finally { srv.close(); }
});
