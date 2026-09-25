import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import axios from "axios";
import {
  BaseAccessServer,
  Tool,
  Resource,
  CallToolResult,
  requestContextStorage,
} from "../base-server.js";
import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";

class CallerServer extends BaseAccessServer {
  constructor() {
    super("caller", "1.0.0");
  }
  protected getTools(): Tool[] {
    return [];
  }
  protected getResources(): Resource[] {
    return [];
  }
  protected async handleToolCall(_: CallToolRequest): Promise<CallToolResult> {
    return { content: [{ type: "text", text: "" }] };
  }
  // Expose for testing.
  public callPeer(service: string, tool: string, args: Record<string, unknown> = {}) {
    return this["callRemoteServer"](service, tool, args);
  }
}

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
}

describe("BaseAccessServer.callRemoteServer", () => {
  let server: CallerServer;
  let calls: CapturedCall[];
  const originalEnv = { ...process.env };

  beforeEach(() => {
    server = new CallerServer();
    calls = [];
    process.env.ACCESS_MCP_SERVICES = "events=http://mcp-events:3000";
    vi.spyOn(axios, "post").mockImplementation((async (url: string, _data: unknown, config: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: config?.headers ?? {} });
      return { status: 200, data: { content: [{ type: "text", text: "{}" }] } };
    }) as unknown as typeof axios.post);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("forwards X-Api-Key when MCP_API_KEY is set", async () => {
    process.env.MCP_API_KEY = "secret-key";
    await server.callPeer("events", "search_events", {});
    expect(calls[0].headers["X-Api-Key"]).toBe("secret-key");
  });

  it("omits X-Api-Key when MCP_API_KEY is not set", async () => {
    delete process.env.MCP_API_KEY;
    await server.callPeer("events", "search_events", {});
    expect(calls[0].headers["X-Api-Key"]).toBeUndefined();
  });

  it("forwards X-Acting-User from request context alongside the API key", async () => {
    process.env.MCP_API_KEY = "secret-key";
    await requestContextStorage.run(
      { actingUser: "alice@access-ci.org" },
      () => server.callPeer("events", "search_events", {})
    );
    expect(calls[0].headers["X-Api-Key"]).toBe("secret-key");
    expect(calls[0].headers["X-Acting-User"]).toBe("alice@access-ci.org");
  });

  it("throws when the service name isn't registered in ACCESS_MCP_SERVICES", async () => {
    await expect(server.callPeer("missing-service", "any_tool", {})).rejects.toThrow(
      /Service 'missing-service' not found/
    );
  });
});
