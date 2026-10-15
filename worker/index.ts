/**
 * Cloudflare Worker entry. All state lives in ONE SQLite-backed Durable Object ("hub"), whose storage.sql API is
 * synchronous, so the existing sync store/tools code runs unchanged inside it. Free plan allows SQLite-backed DOs.
 * Single DO = writes serialised = fine for pilot scale; shard by agent_id/day if it ever matters.
 */
import { DurableObject } from "cloudflare:workers";
import { handleRequest } from "../src/handler.js";
import { setEventBackend, type FairplugEvent } from "../src/store.js";
import { setOffers } from "../src/offers.js";
import offers from "../data/offers.json";

export class FairplugHub extends DurableObject {
  constructor(ctx: DurableObjectState, env: Record<string, string>) {
    super(ctx, env);
    // Make wrangler vars/secrets visible to src/config.ts (also set by nodejs_compat_populate_process_env).
    for (const [k, v] of Object.entries(env)) if (typeof v === "string") process.env[k] ??= v;
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, type TEXT NOT NULL, click_id TEXT, data TEXT NOT NULL)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS events_click ON events(type, click_id)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_tokens (agent_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_at TEXT NOT NULL)`);
    setOffers(offers as never);
    setEventBackend({
      append: (e: FairplugEvent) =>
        void sql.exec("INSERT INTO events (ts, type, click_id, data) VALUES (?, ?, ?, ?)", e.ts, e.type, (e as { click_id?: string }).click_id ?? null, JSON.stringify(e)),
      readAll: () => sql.exec("SELECT data FROM events ORDER BY id").toArray().map((r) => JSON.parse(r.data as string)),
      getTokenHash: (a: string) => sql.exec("SELECT token_hash FROM agent_tokens WHERE agent_id=?", a).toArray()[0]?.token_hash as string | undefined,
      setTokenHash: (a: string, h: string) =>
        void sql.exec("INSERT INTO agent_tokens (agent_id, token_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET token_hash=excluded.token_hash, created_at=excluded.created_at", a, h, new Date().toISOString()),
      hasClick: (id: string) => sql.exec("SELECT 1 FROM events WHERE type='click' AND click_id=? LIMIT 1", id).toArray().length > 0,
    });
  }
  async fetch(req: Request): Promise<Response> {
    return handleRequest(req, req.headers.get("cf-connecting-ip") ?? undefined);
  }
}

export default {
  async fetch(req: Request, env: { HUB: DurableObjectNamespace }): Promise<Response> {
    return env.HUB.get(env.HUB.idFromName("hub")).fetch(req);
  },
};
