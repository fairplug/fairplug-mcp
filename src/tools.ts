import { appendEvent } from "./store.js";
import { SEED_NOTICE, disclosureText, getOffer, searchOffers } from "./offers.js";
import { buildLink, newClickId } from "./links.js";

const AGENT_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function searchOffersTool(args: { query: string; category?: string; region?: string }) {
  const results = searchOffers(args.query, args.category, args.region);
  appendEvent({ type: "tool_call", ts: new Date().toISOString(), tool: "search_offers", args, result_count: results.length, ok: true });
  return {
    notice: SEED_NOTICE,
    sponsored: true,
    guidance: "These are paid/affiliate offers. Show at most 1 with its disclosure label, alongside organic alternatives. Call get_tracked_link to obtain a link and the required disclosure_text.",
    count: results.length,
    offers: results.map(({ offer, score }) => ({
      offer_id: offer.id, title: offer.title, summary: offer.summary, vertical: offer.vertical,
      category_path: offer.category_path, price: offer.price, attributes: offer.attributes,
      regions: offer.eligibility.geo, sponsored: true,
      disclosure: { label: offer.disclosure.label, sponsor_name: offer.disclosure.sponsor_name },
      relevance_score: score, is_example: true,
    })),
  };
}

export function getTrackedLinkTool(args: { offer_id: string; agent_id: string; context?: string }) {
  const ts = new Date().toISOString();
  const fail = (error: string) => {
    appendEvent({ type: "tool_call", ts, tool: "get_tracked_link", agent_id: args.agent_id, args, ok: false, error });
    throw new Error(error);
  };
  if (!AGENT_RE.test(args.agent_id ?? "")) fail("invalid agent_id (1-64 chars: letters, digits, _ . : -)");
  const offer = getOffer(args.offer_id);
  if (!offer) fail(`unknown or inactive offer_id: ${args.offer_id}`);
  const context = args.context?.slice(0, 200);
  const clickId = newClickId();
  const { url, exp } = buildLink(clickId, offer!.id, args.agent_id);
  const expires_at = new Date(exp * 1000).toISOString();
  appendEvent({ type: "link_issued", ts, click_id: clickId, offer_id: offer!.id, agent_id: args.agent_id, context, expires_at });
  appendEvent({ type: "tool_call", ts, tool: "get_tracked_link", agent_id: args.agent_id, args, ok: true });
  return {
    notice: SEED_NOTICE,
    offer_id: offer!.id,
    tracked_url: url,
    click_id: clickId,
    expires_at,
    disclosure_text: disclosureText(offer!),
    disclosure_required: true,
    instructions: "You MUST show disclosure_text to the user next to this link, in the same message. Do not present this as an unpaid opinion. No disclosure, no payout.",
  };
}
