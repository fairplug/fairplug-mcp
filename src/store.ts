import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";

/** Append-only JSONL event log. Safe for the MCP, redirect and CLI processes to share. */
export type FairplugEvent =
  | { type: "tool_call"; ts: string; tool: string; agent_id?: string; args: unknown; result_count?: number; ok: boolean; error?: string }
  | { type: "link_issued"; ts: string; click_id: string; offer_id: string; agent_id: string; context?: string; expires_at: string }
  | { type: "click"; ts: string; click_id: string; offer_id: string; agent_id: string; ip?: string; ua?: string; duplicate: boolean }
  | { type: "click_rejected"; ts: string; click_id: string; reason: string }
  | {
      type: "conversion"; ts: string; click_id: string; offer_id: string; agent_id: string;
      order_value_cents: number; commission_cents: number; network_fee_cents: number;
      status: "pending" | "validated" | "reversed"; currency: string; simulated: true;
    };

/** Pluggable backend (sync). Default = JSONL file; the Cloudflare Worker installs a Durable Object SQLite backend. */
export interface EventBackend {
  append(e: FairplugEvent): void;
  readAll(): FairplugEvent[];
  /** Has a (non-rejected) click already been recorded for this click_id? Lets SQL backends use an index. */
  hasClick?(clickId: string): boolean;
  /** Per-agent report tokens: only a SHA-256 hash is stored. */
  getTokenHash?(agentId: string): string | undefined;
  setTokenHash?(agentId: string, hash: string): void;
}

function file(): string {
  return path.join(dataDir(), "events.jsonl");
}

const fileBackend: EventBackend = {
  append(e) {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.appendFileSync(file(), JSON.stringify(e) + "\n");
  },
  readAll() {
    if (!fs.existsSync(file())) return [];
    return fs.readFileSync(file(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  },
};

let backend: EventBackend = fileBackend;
export function setEventBackend(b: EventBackend | null): void { backend = b ?? fileBackend; }

export const appendEvent = (e: FairplugEvent): void => backend.append(e);
export const readEvents = (): FairplugEvent[] => backend.readAll();
export const hasClick = (clickId: string): boolean =>
  backend.hasClick ? backend.hasClick(clickId) : backend.readAll().some((e) => e.type === "click" && e.click_id === clickId);

const tokenFile = () => path.join(dataDir(), "agent_tokens.json");
export function getTokenHash(agentId: string): string | undefined {
  if (backend.getTokenHash) return backend.getTokenHash(agentId);
  if (!fs.existsSync(tokenFile())) return undefined;
  return JSON.parse(fs.readFileSync(tokenFile(), "utf8"))[agentId];
}
export function setTokenHash(agentId: string, hash: string): void {
  if (backend.setTokenHash) return backend.setTokenHash(agentId, hash);
  const cur = fs.existsSync(tokenFile()) ? JSON.parse(fs.readFileSync(tokenFile(), "utf8")) : {};
  cur[agentId] = hash;
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(tokenFile(), JSON.stringify(cur));
}
