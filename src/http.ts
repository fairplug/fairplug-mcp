#!/usr/bin/env node
/** Node entrypoint: remote MCP (streamable HTTP) + redirect logger on ONE port. Env: PORT / FAIRPLUG_PORT, FAIRPLUG_HOST (default 0.0.0.0). */
import http from "node:http";
import { Readable } from "node:stream";
import { handleRequest } from "./handler.js";

export function createHttpServer(): http.Server {
  return http.createServer(async (nreq, nres) => {
    try {
      const host = nreq.headers.host ?? "localhost";
      const method = nreq.method ?? "GET";
      const headers = new Headers();
      for (const [k, v] of Object.entries(nreq.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      const init: RequestInit & { duplex?: "half" } = { method, headers };
      if (method !== "GET" && method !== "HEAD") { init.body = Readable.toWeb(nreq) as unknown as ReadableStream; init.duplex = "half"; }
      const res = await handleRequest(new Request(`http://${host}${nreq.url ?? "/"}`, init), nreq.socket.remoteAddress);
      nres.writeHead(res.status, Object.fromEntries(res.headers));
      nres.end(Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      console.error("request failed", e);
      if (!nres.headersSent) nres.writeHead(500, { "content-type": "text/plain" });
      nres.end("internal error");
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? process.env.FAIRPLUG_PORT ?? 8788);
  const host = process.env.FAIRPLUG_HOST ?? "0.0.0.0";
  createHttpServer().listen(port, host, () => console.error(`Fairplug remote MCP on http://${host}:${port}/mcp  (redirects at /r/..., health at /health)`));
}
