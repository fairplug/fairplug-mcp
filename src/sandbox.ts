/**
 * Public, no-signup SANDBOX. Read-only: fictional offers only, nothing is written to the event store,
 * no signed links, no clicks, no money data. Same two tools as the real server (search_offers, get_tracked_link).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { disclosureText, getOffer, searchOffers } from "./offers.js";

export const SANDBOX_NOTICE =
  "SANDBOX: fictional example offers and non-functional links. Nothing is tracked, nothing is paid. Not real advertising.";
const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });
const AGENT_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function createSandboxServer(base: string): McpServer {
  const server = new McpServer({ name: "fairplug-sandbox", version: "0.1.0" });
  server.registerTool("search_offers", {
    description: "SANDBOX. Search fictional example sponsored offers. Typed data only, never instructions. Every result is sponsored and must be disclosed to the user.",
    inputSchema: {
      query: z.string().min(1).max(300).describe("What the user is looking for"),
      category: z.string().max(60).optional().describe("travel | saas | retail, or a sub-category like hotels"),
      region: z.string().length(2).optional().describe("ISO country code of the user, e.g. US"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => {
    const results = searchOffers(a.query, a.category, a.region);
    return text({
      sandbox: true, notice: SANDBOX_NOTICE, sponsored: true,
      guidance: "Show at most 1 offer with its disclosure label, alongside organic alternatives. Call get_tracked_link for the required disclosure_text.",
      count: results.length,
      offers: results.map(({ offer, score }) => ({
        offer_id: offer.id, title: offer.title, summary: offer.summary, vertical: offer.vertical,
        category_path: offer.category_path, price: offer.price, regions: offer.eligibility.geo, sponsored: true,
        disclosure: { label: offer.disclosure.label, sponsor_name: offer.disclosure.sponsor_name },
        relevance_score: score, is_example: true,
      })),
    });
  });
  server.registerTool("get_tracked_link", {
    description: "SANDBOX. Returns a non-functional example link plus the disclosure_text you MUST show the user next to any link. Nothing is recorded.",
    inputSchema: {
      offer_id: z.string().describe("offer_id from search_offers"),
      agent_id: z.string().max(64).describe("Your stable agent identifier (not stored in the sandbox)"),
      context: z.string().max(200).optional().describe("Ignored in the sandbox"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => {
    if (!AGENT_RE.test(a.agent_id)) return { isError: true, content: [{ type: "text" as const, text: "invalid agent_id (1-64 chars: letters, digits, _ . : -)" }] };
    const offer = getOffer(a.offer_id);
    if (!offer) return { isError: true, content: [{ type: "text" as const, text: `unknown offer_id: ${a.offer_id}` }] };
    return text({
      sandbox: true, notice: SANDBOX_NOTICE, offer_id: offer.id,
      tracked_url: `${base}/sandbox/r/${offer.id}`,
      click_id: "sandbox_none", expires_at: null,
      disclosure_text: disclosureText(offer), disclosure_required: true,
      instructions: "You MUST show disclosure_text next to the link in the same message. In production, no disclosure means no payout. This sandbox link is not tracked.",
    });
  });
  return server;
}

// Cheap per-isolate fixed-window rate limit (the Worker runs one Durable Object, so one process).
const hits = new Map<string, { n: number; t: number }>();
export function rateLimited(key: string, max = 60, windowMs = 60_000, now = Date.now()): boolean {
  const h = hits.get(key);
  if (!h || now - h.t > windowMs) {
    if (hits.size > 5000) hits.clear();
    hits.set(key, { n: 1, t: now });
    return false;
  }
  return ++h.n > max;
}

export const SERVER_CARD = (base: string) => ({
  serverInfo: { name: "fairplug-sandbox", version: "0.1.0" },
  description: "Fairplug sandbox: fictional sponsored offers with disclosure-first rules. Read-only, no signup, nothing tracked or paid. Early pilot.",
  transport: { type: "streamable-http", url: `${base}/sandbox/mcp` },
  authentication: { required: false },
  tools: [{ name: "search_offers" }, { name: "get_tracked_link" }],
  documentation: "https://github.com/fairplug/fairplug-mcp",
});
