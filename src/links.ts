import crypto from "node:crypto";
import { LINK_TTL_SECONDS, redirectBase, signingSecret } from "./config.js";

export function sign(clickId: string, offerId: string, agentId: string, exp: number): string {
  return crypto.createHmac("sha256", signingSecret()).update(`${clickId}|${offerId}|${agentId}|${exp}`).digest("base64url").slice(0, 32);
}

export function newClickId(): string {
  return "clk_" + crypto.randomBytes(9).toString("hex");
}

export function buildLink(clickId: string, offerId: string, agentId: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + LINK_TTL_SECONDS;
  const sig = sign(clickId, offerId, agentId, exp);
  const q = new URLSearchParams({ o: offerId, a: agentId, e: String(exp), s: sig });
  return { url: `${redirectBase()}/r/${clickId}?${q}`, exp };
}

export function verifyLink(clickId: string, q: URLSearchParams, now = Date.now()): { ok: true; offerId: string; agentId: string } | { ok: false; reason: string } {
  const o = q.get("o"), a = q.get("a"), e = Number(q.get("e")), s = q.get("s");
  if (!o || !a || !e || !s) return { ok: false, reason: "missing_params" };
  const expect = sign(clickId, o, a, e);
  const A = Buffer.from(expect), B = Buffer.from(s);
  if (A.length !== B.length || !crypto.timingSafeEqual(A, B)) return { ok: false, reason: "bad_signature" };
  if (now / 1000 > e) return { ok: false, reason: "expired" };
  return { ok: true, offerId: o, agentId: a };
}
