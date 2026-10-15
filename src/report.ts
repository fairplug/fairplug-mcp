import { readEvents, type FairplugEvent } from "./store.js";
import { fairplugFeeCents, FEE_RATE, FEE_CAP_RATE, FEE_MIN_CENTS } from "./fees.js";

type Conv = Extract<FairplugEvent, { type: "conversion" }>;
const d = (c: number) => Math.round(c) / 100;

/** Open-books report for one builder/agent. Only VALIDATED conversions count toward fee and payout. */
export function buildAgentReport(agentId: string) {
  const events = readEvents();
  let links = 0, clicks = 0;
  const latest = new Map<string, Conv>();
  for (const e of events) {
    if (e.type === "link_issued" && e.agent_id === agentId) links++;
    else if (e.type === "click" && e.agent_id === agentId && !e.duplicate) clicks++;
    else if (e.type === "conversion" && e.agent_id === agentId) latest.set(e.click_id, e);
  }
  const by = { validated: { count: 0, commission_cents: 0 }, pending: { count: 0, commission_cents: 0 }, reversed: { count: 0, commission_cents: 0 } };
  let gross = 0, fee = 0, network = 0;
  const conversions = [] as unknown[];
  for (const c of latest.values()) {
    by[c.status].count++; by[c.status].commission_cents += c.commission_cents;
    const f = c.status === "validated" ? fairplugFeeCents(c.commission_cents) : 0;
    if (c.status === "validated") { gross += c.commission_cents; fee += f; network += c.network_fee_cents; }
    conversions.push({ click_id: c.click_id, offer_id: c.offer_id, status: c.status, recorded_at: c.ts, commission_usd: d(c.commission_cents),
      fairplug_fee_usd: d(f), network_fee_usd: c.status === "validated" ? d(c.network_fee_cents) : 0,
      net_usd: c.status === "validated" ? d(c.commission_cents - f - c.network_fee_cents) : 0 });
  }
  const net = gross - fee - network;
  return {
    agent_id: agentId, currency: "USD", simulated_conversions: true,
    clicks, links_issued: links,
    conversions: {
      validated: { count: by.validated.count, commission_usd: d(by.validated.commission_cents) },
      pending: { count: by.pending.count, commission_usd: d(by.pending.commission_cents) },
      reversed: { count: by.reversed.count, commission_usd: d(by.reversed.commission_cents) },
    },
    gross_commission_usd: d(gross), fairplug_fee_usd: d(fee), network_fees_usd: d(network), net_payout_usd: d(net),
    totals_cents: { gross, fairplug_fee: fee, network_fees: network, net_payout: net },
    fee_policy: `${FEE_RATE * 100}% of validated commission, min US$${FEE_MIN_CENTS / 100}, capped at ${FEE_CAP_RATE * 100}% (cap wins over the minimum for tiny commissions); network fees passed through at cost; only validated conversions count; pending/reversed are shown but excluded.`,
    items: conversions,
  };
}
