import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AllocationsServer } from "../server.js";
import { classifyTool, assertNoPublicWrites, type ToolWithAccess } from "@access-mcp/shared";

function tools(): ToolWithAccess[] {
  const s = new AllocationsServer();
  return (s as unknown as { getTools(): ToolWithAccess[] }).getTools();
}

describe("allocations tool classification", () => {
  it("search_projects, analyze_funding, get_allocation_statistics are public", () => {
    const t = tools();
    expect(classifyTool(t.find((x) => x.name === "search_projects")!)).toBe("public");
    expect(classifyTool(t.find((x) => x.name === "analyze_funding")!)).toBe("public");
    expect(classifyTool(t.find((x) => x.name === "get_allocation_statistics")!)).toBe("public");
  });
  it("get_rp_account and get_my_rp_accounts are authenticated", () => {
    const t = tools();
    expect(classifyTool(t.find((x) => x.name === "get_rp_account")!)).toBe("authenticated");
    expect(classifyTool(t.find((x) => x.name === "get_my_rp_accounts")!)).toBe("authenticated");
  });
  it("no write tool is public (assertion passes)", () => {
    expect(() => assertNoPublicWrites(tools())).not.toThrow();
  });
  it("the public set is EXACTLY the intended reads (a stray public marker fails)", () => {
    const publicNames = tools()
      .filter((t) => classifyTool(t) === "public")
      .map((t) => t.name)
      .sort();
    expect(publicNames).toEqual(["analyze_funding", "get_allocation_statistics", "search_projects"]);
  });
});

// Integration-style: proves the cross-user hole is closed on the REST inter-server
// route (/tools/:toolName), and that public reads stay keyless-reachable through
// the per-tool gate on /mcp. Mirrors packages/shared/src/__tests__/base-server-auth.test.ts.
const KEY = "test-key-allocations-123";
let server: AllocationsServer;
let port: number;
let baseUrl: string;

beforeEach(async () => {
  process.env.MCP_API_KEY = KEY;
  server = new AllocationsServer();
  // 3900-3999: a range clear of base-server.test.ts (3100-3399) and
  // base-server-auth.test.ts (3600-3899).
  port = 3900 + Math.floor(Math.random() * 100);
  baseUrl = `http://localhost:${port}`;
  await server.start({ httpPort: port });
});

afterEach(async () => {
  await server.stop();
  delete process.env.MCP_API_KEY;
});

const postTool = (toolName: string, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/tools/${toolName}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ arguments: {} }),
  });

const callBody = (name: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: {} },
});
const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};
const postMcp = (bodyObj: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(bodyObj),
  });

describe("cross-user hole closed: REST /tools/:toolName requires the key", () => {
  it("get_my_rp_accounts with X-Acting-User but NO x-api-key → 401", async () => {
    const res = await postTool("get_my_rp_accounts", { "X-Acting-User": "victim@access-ci.org" });
    expect(res.status).toBe(401);
  });

  it("get_my_rp_accounts with a valid x-api-key → NOT 401", async () => {
    const res = await postTool("get_my_rp_accounts", {
      "X-Acting-User": "someone@access-ci.org",
      "x-api-key": KEY,
    });
    expect(res.status).not.toBe(401);
  });
});

describe("public reads stay keyless-reachable via the per-tool gate on /mcp", () => {
  it("search_projects, no key, via /mcp → NOT 401", async () => {
    const res = await postMcp(callBody("search_projects"));
    expect(res.status).not.toBe(401);
  });

  it("get_my_rp_accounts, no key, via /mcp → 401", async () => {
    const res = await postMcp(callBody("get_my_rp_accounts"));
    expect(res.status).toBe(401);
  });

  it("initialize, no key → NOT 401 (discovery stays open)", async () => {
    const res = await postMcp(initBody);
    expect(res.status).not.toBe(401);
  });
});
