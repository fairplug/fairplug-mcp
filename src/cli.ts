#!/usr/bin/env node
import { parseArgs } from "node:util";
import { getOffer } from "./offers.js";
import { fairplugFeeCents, usd } from "./fees.js";
import { appendEvent, readEvents } from "./store.js";

export interface AgentRow { agent_id: string; links: number; calls: number; clicks: number; conversions: number; validated: number; pending: number; reversed: number; gross: number; fee: number; network: number; net: number }

export function buildReport(): AgentRow[] {
  const rows = new Map<string, AgentRow>();
  const row = (a: string) => {
    if (!rows.has(a)) rows.set(a, { agent_id: a, links: 0, calls: 0, clicks: 0, conversions: 0, validated: 0, pending: 0, reversed: 0, gross: 0, fee: 0, network: 0, net: 0 });
    return rows.get(a)!;
  };
  const events = readEvents();
  const latest = new Map<string, Extract<(typeof events)[number], { type: "conversion" }>>();
  for (const e of events) {
    if (e.type === "tool_call" && e.agent_id) row(e.agent_id).calls++;
    else if (e.type === "link_issued") row(e.agent_id).links++;
    else if (e.type === "click" && !e.duplicate) row(e.agent_id).clicks++; // unique clicks
    else if (e.type === "conversion") latest.set(e.click_id, e); // last status per click wins
  }
  for (const c of latest.values()) {
    const r = row(c.agent_id);
    r.conversions++;
    if (c.status === "reversed") { r.reversed++; continue; }
    if (c.status === "pending") { r.pending++; continue; }
    r.validated++;
    const fee = fairplugFeeCents(c.commission_cents);
    r.gross += c.commission_cents; r.fee += fee; r.network += c.network_fee_cents;
    r.net += c.commission_cents - fee - c.network_fee_cents;
  }
  return [...rows.values()].sort((a, b) => a.agent_id.localeCompare(b.agent_id));
}

export function recordConversion(o: { clickId: string; orderValueCents?: number; status?: "pending" | "validated" | "reversed"; networkFeeCents?: number }) {
  const events = readEvents();
  const click = events.find((e) => e.type === "click" && e.click_id === o.clickId);
  const issued = events.find((e) => e.type === "link_issued" && e.click_id === o.clickId);
  if (!issued || issued.type !== "link_issued") throw new Error(`unknown click_id ${o.clickId} (no link was issued)`);
  if (!click) throw new Error(`click_id ${o.clickId} has no recorded click; hit the tracked URL first`);
  const offer = getOffer(issued.offer_id);
  if (!offer) throw new Error("offer no longer active");
  const p = offer.payout;
  let commission: number;
  if (p.model === "cpa_percent") {
    if (o.orderValueCents == null) throw new Error("cpa_percent offer: --order-value required");
    commission = Math.round(o.orderValueCents * p.amount / 100);
  } else commission = Math.round(p.amount * 100);
  const status = o.status ?? "validated";
  if (status === "validated" && p.currency !== "USD") {
    // Seed has some NZD payouts; v0 simulator treats the numbers as USD-equivalent. No FX.
  }
  const ev = { type: "conversion" as const, ts: new Date().toISOString(), click_id: o.clickId, offer_id: offer.id, agent_id: issued.agent_id,
    order_value_cents: o.orderValueCents ?? 0, commission_cents: commission, network_fee_cents: o.networkFeeCents ?? 0, status, currency: p.currency, simulated: true as const };
  appendEvent(ev);
  return ev;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "report") {
    const rows = buildReport();
    if (!rows.length) return console.log("No events yet.");
    console.log("Fairplug report (SIMULATED conversions; example seed offers; amounts treated as USD, no FX)\n");
    const head = ["agent", "calls", "links", "clicks", "conv(val/pend/rev)", "gross", "fp_fee", "network", "net_payout"];
    const lines = rows.map((r) => [r.agent_id, r.calls, r.links, r.clicks, `${r.conversions}(${r.validated}/${r.pending}/${r.reversed})`, usd(r.gross), usd(r.fee), usd(r.network), usd(r.net)].map(String));
    const tot = rows.reduce((t, r) => ({ ...t, gross: t.gross + r.gross, fee: t.fee + r.fee, network: t.network + r.network, net: t.net + r.net }), { gross: 0, fee: 0, network: 0, net: 0 });
    lines.push(["TOTAL", "", "", "", "", usd(tot.gross), usd(tot.fee), usd(tot.network), usd(tot.net)]);
    const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
    const fmt = (l: string[]) => l.map((c, i) => c.padEnd(w[i])).join("  ");
    console.log(fmt(head)); console.log(w.map((n) => "-".repeat(n)).join("  ")); lines.forEach((l) => console.log(fmt(l)));
    console.log("\nFee = 10% of validated commission, min $0.50, capped at 15%; network fees at cost. Only validated conversions count toward gross/fee/net.");
  } else if (cmd === "record_conversion" || cmd === "record-conversion") {
    const { values } = parseArgs({ args: rest, options: { "click-id": { type: "string" }, "order-value": { type: "string" }, status: { type: "string" }, "network-fee": { type: "string" } } });
    if (!values["click-id"]) throw new Error("usage: record_conversion --click-id clk_... [--order-value 189.00] [--status validated|pending|reversed] [--network-fee 0.25]");
    const cents = (s?: string) => (s == null ? undefined : Math.round(parseFloat(s) * 100));
    const st = values.status as "pending" | "validated" | "reversed" | undefined;
    if (st && !["pending", "validated", "reversed"].includes(st)) throw new Error("bad --status");
    const ev = recordConversion({ clickId: values["click-id"], orderValueCents: cents(values["order-value"]), status: st, networkFeeCents: cents(values["network-fee"]) });
    console.log(`Recorded simulated conversion: ${ev.status}, commission ${usd(ev.commission_cents)} for agent ${ev.agent_id}`);
  } else {
    console.log("usage: fairplug report | fairplug record_conversion --click-id clk_... [--order-value N] [--status S] [--network-fee N]");
    process.exitCode = cmd ? 1 : 0;
  }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) { console.error("error:", (e as Error).message); process.exit(1); }
}
