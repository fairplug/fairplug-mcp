/**
 * Portable (Web-standard Request -> Response) HTTP handler used by BOTH the Node entrypoint (src/http.ts)
 * and the Cloudflare Worker (worker/index.ts). Routes:
 *   POST /mcp          MCP streamable HTTP (stateless, JSON responses)
 *   GET  /r/clk_...    signed redirect + click logger
 *   GET  /health       liveness
 *   GET  /admin/report per-agent report (only if FAIRPLUG_ADMIN_TOKEN is set; Bearer auth)
 *   POST /admin/agent-token  {agent_id}  admin: issue/rotate a builder's report token (shown once)
 *   POST /admin/conversion   admin: record a conversion for a click_id (status, commission, network fee)
 *   GET  /report?agent_id=   builder's own token OR admin token: open-books report
 * Optional FAIRPLUG_MCP_TOKEN: if set, /mcp requires `Authorization: Bearer <token>`.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./app.js";
import { createSandboxServer, rateLimited, SERVER_CARD, SANDBOX_NOTICE } from "./sandbox.js";
import { getOffer } from "./offers.js";
import { verifyLink } from "./links.js";
import { appendEvent, hasClick, readEvents, getTokenHash, setTokenHash } from "./store.js";
import { buildReport } from "./cli.js";
import { buildAgentReport } from "./report.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(sha(a)), y = Buffer.from(sha(b));
  return timingSafeEqual(x, y);
}
function bearer(req: Request): string | undefined {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}
/** Strict admin check: fails closed when FAIRPLUG_ADMIN_TOKEN is unset. */
function isAdmin(req: Request, adminToken: string | undefined): boolean {
  const t = bearer(req);
  return !!adminToken && !!t && safeEq(t, adminToken);
}
const json = (o: unknown, status = 200) => Response.json(o, { status, headers: { "cache-control": "no-store" } });
const AGENT_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const money = (v: unknown): number | undefined => {
  if (typeof v !== "number" && typeof v !== "string") return undefined;
  if (typeof v === "string" && !/^\d+(\.\d{1,2})?$/.test(v)) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e7) return undefined;
  return Math.round(n * 100);
};

const text = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain", ...extra } });

function bearerOk(req: Request, token: string | undefined): boolean {
  if (!token) return true;
  return req.headers.get("authorization") === `Bearer ${token}`;
}

export async function handleRequest(req: Request, clientIp?: string): Promise<Response> {
  const u = new URL(req.url);
  const env = (k: string) => (typeof process !== "undefined" ? process.env[k] : undefined);

  if (u.pathname === "/health") return text("ok");

  if (u.pathname === "/.well-known/mcp/server-card.json")
    return Response.json(SERVER_CARD(u.origin), { headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });

  // Public sandbox: no auth, read-only, fictional data, nothing stored. Separate from the token-protected /mcp.
  if (u.pathname === "/sandbox/mcp") {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id" } });
    if (rateLimited(clientIp ?? "anon")) return text("sandbox rate limit: 60 requests/minute", 429, { "retry-after": "60" });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createSandboxServer(u.origin);
    await server.connect(transport);
    try {
      const r = await transport.handleRequest(req);
      const h = new Headers(r.headers); h.set("access-control-allow-origin", "*");
      return new Response(r.body, { status: r.status, headers: h });
    } finally { void server.close().catch(() => {}); }
  }
  const sb = u.pathname.match(/^\/sandbox\/r\/(off_[a-z0-9]+)$/);
  if (sb) return text(SANDBOX_NOTICE + " This link is a placeholder for offer " + sb[1] + "; no click was recorded.");

  if (u.pathname === "/mcp") {
    if (!bearerOk(req, env("FAIRPLUG_MCP_TOKEN"))) return text("unauthorized", 401, { "www-authenticate": "Bearer" });
    // Stateless mode: a fresh server + transport per request, no session affinity needed.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createMcpServer();
    await server.connect(transport);
    try { return await transport.handleRequest(req); }
    finally { /* response is fully materialised (JSON mode) */ void server.close().catch(() => {}); }
  }

  if (u.pathname === "/admin/report") {
    const t = env("FAIRPLUG_ADMIN_TOKEN");
    if (!t || !bearerOk(req, t)) return text("not found", 404);
    return Response.json(buildReport());
  }

  if (u.pathname === "/admin/agent-token") {
    if (!isAdmin(req, env("FAIRPLUG_ADMIN_TOKEN"))) return text("not found", 404);
    if (req.method !== "POST") return text("method not allowed", 405, { allow: "POST" });
    const b = (await req.json().catch(() => null)) as { agent_id?: unknown } | null;
    if (!b || typeof b.agent_id !== "string" || !AGENT_RE.test(b.agent_id)) return json({ error: "agent_id required (1-64 chars: letters, digits, _ . : -)" }, 400);
    const token = "fpa_" + randomBytes(24).toString("hex");
    setTokenHash(b.agent_id, sha(token)); // re-issuing rotates: the old token stops working
    return json({ agent_id: b.agent_id, token, note: "Shown once; store it. Re-issuing replaces it." });
  }

  if (u.pathname === "/admin/conversion") {
    if (!isAdmin(req, env("FAIRPLUG_ADMIN_TOKEN"))) return text("not found", 404);
    if (req.method !== "POST") return text("method not allowed", 405, { allow: "POST" });
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b.click_id !== "string" || !/^clk_[a-f0-9]+$/.test(b.click_id)) return json({ error: "click_id required" }, 400);
    const status: "validated" | "pending" | "reversed" = (b.status ?? "validated") as never;
    if (status !== "validated" && status !== "pending" && status !== "reversed") return json({ error: "status must be validated|pending|reversed" }, 400);
    const commission = money(b.commission);
    if (commission === undefined) return json({ error: "commission required: non-negative USD amount, max 2 decimals" }, 400);
    const nf = b.network_fee === undefined ? 0 : money(b.network_fee);
    if (nf === undefined) return json({ error: "network_fee must be a non-negative USD amount, max 2 decimals" }, 400);
    if (nf > commission) return json({ error: "network_fee cannot exceed commission" }, 400);
    const ov = b.order_value === undefined ? 0 : money(b.order_value);
    if (ov === undefined) return json({ error: "order_value must be a non-negative USD amount" }, 400);
    const events = readEvents();
    const issued = events.find((e) => e.type === "link_issued" && e.click_id === b.click_id);
    if (!issued || issued.type !== "link_issued") return json({ error: "unknown click_id (no link was issued)" }, 404);
    if (!hasClick(b.click_id)) return json({ error: "click_id has no recorded click" }, 409);
    const ev = { type: "conversion" as const, ts: new Date().toISOString(), click_id: b.click_id, offer_id: issued.offer_id, agent_id: issued.agent_id,
      order_value_cents: ov, commission_cents: commission, network_fee_cents: nf, status, currency: "USD", simulated: true as const };
    appendEvent(ev); // last status per click wins in reports
    return json({ recorded: true, click_id: ev.click_id, agent_id: ev.agent_id, status, commission_cents: commission, network_fee_cents: nf });
  }

  if (u.pathname === "/report") {
    if (req.method !== "GET") return text("method not allowed", 405, { allow: "GET" });
    const agent = u.searchParams.get("agent_id") ?? "";
    const t = bearer(req);
    const h = AGENT_RE.test(agent) ? getTokenHash(agent) : undefined;
    const ok = isAdmin(req, env("FAIRPLUG_ADMIN_TOKEN")) || (!!t && !!h && safeEq(sha(t), h));
    if (!ok) return text("unauthorized", 401, { "www-authenticate": "Bearer" });
    return json(buildAgentReport(agent));
  }

  const m = u.pathname.match(/^\/r\/(clk_[a-f0-9]+)$/);
  if (!m) return text("not found", 404);
  const clickId = m[1];
  const v = verifyLink(clickId, u.searchParams);
  const ts = new Date().toISOString();
  if (!v.ok) {
    appendEvent({ type: "click_rejected", ts, click_id: clickId, reason: v.reason });
    return text("invalid or expired link: " + v.reason, 400);
  }
  const offer = getOffer(v.offerId);
  if (!offer) {
    appendEvent({ type: "click_rejected", ts, click_id: clickId, reason: "offer_inactive" });
    return text("offer no longer available", 410);
  }
  const duplicate = hasClick(clickId);
  appendEvent({ type: "click", ts, click_id: clickId, offer_id: offer.id, agent_id: v.agentId, ip: clientIp, ua: req.headers.get("user-agent") ?? undefined, duplicate });
  const dest = new URL(offer.url);
  dest.searchParams.set("fp_click_id", clickId);
  return new Response(null, { status: 302, headers: { location: dest.toString() } });
}
