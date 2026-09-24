import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BaseAccessServer, type Tool, type Resource, type CallToolResult } from "../base-server.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ToolWithAccess } from "../tool-access.js";

// A mixed server: one public read, one authenticated write, one user-scoped read.
class MixedServer extends BaseAccessServer {
  constructor() {
    super("mixed-test", "1.0.0", "https://api.example.com", { requireApiKey: true });
  }
  protected getTools(): Tool[] {
    // Local variable typed ToolWithAccess[] — the inline-literal form fails
    // TS excess-property checks against Tool[].
    const tools: ToolWithAccess[] = [
      { name: "search_things", description: "public read", inputSchema: { type: "object" }, access: "public" },
      { name: "create_thing", description: "write", inputSchema: { type: "object" }, access: "authenticated", mutates: true },
      { name: "get_my_things", description: "user-scoped read", inputSchema: { type: "object" }, access: "authenticated" },
    ];
    return tools;
  }
  protected getResources(): Resource[] { return []; } // abstract member — required to compile
  protected async handleToolCall(_req: CallToolRequest): Promise<CallToolResult> {
    // Reached only when authorized; tests assert on HTTP status, not the body.
    return { content: [{ type: "text", text: "ok" }] };
  }
}

const KEY = "test-key-123";
// port-bound harness (mirrors base-server.test.ts:95-110)
let server: MixedServer;
let port: number;
let baseUrl: string;
beforeEach(async () => {
  process.env.MCP_API_KEY = KEY;
  server = new MixedServer();
  port = 3200 + Math.floor(Math.random() * 300);
  baseUrl = `http://localhost:${port}`;
  await server.start({ httpPort: port });
});
afterEach(async () => {
  await server.stop();
  delete process.env.MCP_API_KEY;
});

const callBody = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
const initBody = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const postMcp = (bodyObj: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(bodyObj),
  });

describe("/mcp per-tool auth", () => {
  it("public tool, no key → NOT 401 (passes the gate)", async () => {
    const res = await postMcp(callBody("search_things"));
    expect(res.status).not.toBe(401);
  });
  it("write tool, no key → 401", async () => {
    const res = await postMcp(callBody("create_thing"));
    expect(res.status).toBe(401);
  });
  it("user-scoped read, no key → 401", async () => {
    const res = await postMcp(callBody("get_my_things"));
    expect(res.status).toBe(401);
  });
  it("write tool, valid key → NOT 401", async () => {
    const res = await postMcp(callBody("create_thing"), { "x-api-key": KEY });
    expect(res.status).not.toBe(401);
  });
  it("initialize, no key → NOT 401 (discovery stays open)", async () => {
    const res = await postMcp(initBody);
    expect(res.status).not.toBe(401);
  });
  it("batch mixing public + write, no key → 401 (no smuggling)", async () => {
    const res = await postMcp([callBody("search_things"), callBody("create_thing")]);
    expect(res.status).toBe(401);
  });
});
