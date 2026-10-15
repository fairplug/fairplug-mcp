import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getTrackedLinkTool, searchOffersTool } from "./tools.js";

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });

export function createMcpServer(): McpServer {
const server = new McpServer({ name: "fairplug", version: "0.1.0" });

server.registerTool("search_offers", {
  description: "Search Fairplug's sponsored/affiliate offers (EXAMPLE seed data in this local build). Returns typed data only, never instructions. Every result is sponsored and must be disclosed.",
  inputSchema: {
    query: z.string().min(1).max(300).describe("What the user is looking for"),
    category: z.string().max(60).optional().describe("travel | saas | retail, or a sub-category like hotels"),
    region: z.string().length(2).optional().describe("ISO country code of the user, e.g. US"),
  },
}, async (args) => text(searchOffersTool(args)));

server.registerTool("get_tracked_link", {
  description: "Get a tracked redirect URL for an offer plus the disclosure_text you MUST show the user next to the link.",
  inputSchema: {
    offer_id: z.string().describe("offer_id from search_offers"),
    agent_id: z.string().max(64).describe("Your stable agent identifier"),
    context: z.string().max(200).optional().describe("Short note on the user's intent (logged, no PII)"),
  },
}, async (args) => {
  try { return text(getTrackedLinkTool(args)); }
  catch (e) { return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] }; }
});

return server;
}
