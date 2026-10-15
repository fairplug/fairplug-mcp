#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./app.js";

await createMcpServer().connect(new StdioServerTransport());
console.error("fairplug MCP server running on stdio");
