#!/usr/bin/env node
import http from "node:http";
import { redirectPort } from "./config.js";
import { getOffer } from "./offers.js";
import { verifyLink } from "./links.js";
import { appendEvent, readEvents } from "./store.js";

export function createRedirectServer(): http.Server {
  return http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    const m = u.pathname.match(/^\/r\/(clk_[a-f0-9]+)$/);
    if (u.pathname === "/health") { res.writeHead(200, { "content-type": "text/plain" }); return void res.end("ok"); }
    if (!m) { res.writeHead(404); return void res.end("not found"); }
    const clickId = m[1];
    const v = verifyLink(clickId, u.searchParams);
    const ts = new Date().toISOString();
    if (!v.ok) {
      appendEvent({ type: "click_rejected", ts, click_id: clickId, reason: v.reason });
      res.writeHead(400, { "content-type": "text/plain" });
      return void res.end("invalid or expired link: " + v.reason);
    }
    const offer = getOffer(v.offerId);
    if (!offer) {
      appendEvent({ type: "click_rejected", ts, click_id: clickId, reason: "offer_inactive" });
      res.writeHead(410); return void res.end("offer no longer available");
    }
    const duplicate = readEvents().some((e) => e.type === "click" && e.click_id === clickId);
    appendEvent({ type: "click", ts, click_id: clickId, offer_id: offer.id, agent_id: v.agentId, ip: req.socket.remoteAddress, ua: req.headers["user-agent"], duplicate });
    const dest = new URL(offer.url);
    dest.searchParams.set("fp_click_id", clickId);
    res.writeHead(302, { location: dest.toString() });
    res.end();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = redirectPort();
  createRedirectServer().listen(port, "127.0.0.1", () => console.error(`Fairplug redirect/click logger on http://127.0.0.1:${port}`));
}
