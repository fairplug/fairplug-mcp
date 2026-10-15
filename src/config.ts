import path from "node:path";
import { fileURLToPath } from "node:url";

// src/ or dist/src/ -> package root. Wrapped so bundling for Cloudflare Workers (no real file URL) doesn't throw.
function findRoot(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, here.endsWith(path.join("dist", "src")) ? "../.." : "..");
  } catch { return "/"; }
}
export const ROOT = findRoot();

export function dataDir(): string {
  return process.env.FAIRPLUG_DATA_DIR ?? path.join(ROOT, "var");
}
export function offersPath(): string {
  return process.env.FAIRPLUG_OFFERS_FILE ?? path.join(ROOT, "data", "offers.json");
}
export function redirectBase(): string {
  return (process.env.FAIRPLUG_REDIRECT_BASE ?? "http://127.0.0.1:8787").replace(/\/$/, "");
}
export function redirectPort(): number {
  return Number(process.env.FAIRPLUG_PORT ?? 8787);
}
/** Local dev signing secret. Override in env; the default is NOT secret. */
export function signingSecret(): string {
  return process.env.FAIRPLUG_SIGNING_SECRET ?? "fairplug-local-dev-secret-not-for-production";
}
export const LINK_TTL_SECONDS = 15 * 60; // spec §7: 15-min issuance TTL
