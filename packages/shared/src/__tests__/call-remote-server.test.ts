import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import axios from "axios";
import {
  BaseAccessServer,
  Resource,
  CallToolResult,
  requestContextStorage,
} from "../base-server.js";
import type { ToolWithAccess } from "../tool-access.js";
import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";

class CallerServer extends BaseAccessServer {
  constructor() {
    super("caller", "1.0.0");
  }
  protected getTools(): ToolWithAccess[] {
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

  it("forwards the verified acting-user token, so a peer requiring it still works", async () => {
    await requestContextStorage.run(
      { actingUser: "alice@access-ci.org", actingUserAuth: "token", actingUserToken: "tok.en.sig" },
      () => server.callPeer("events", "search_events", {})
    );
    expect(calls[0].headers["Authorization"]).toBe("Bearer tok.en.sig");
    expect(calls[0].headers["X-Acting-User"]).toBe("alice@access-ci.org");
  });

  it("never forwards the token to a peer that doesn't act for users", async () => {
    process.env.ACCESS_MCP_SERVICES = "nsf-awards=http://mcp-nsf-awards:3000";
    await requestContextStorage.run(
      { actingUser: "alice@access-ci.org", actingUserAuth: "token", actingUserToken: "tok.en.sig" },
      () => server.callPeer("nsf-awards", "search_nsf_awards", {})
    );
    expect(calls[0].headers["Authorization"]).toBeUndefined();
  });

  it("sends no Authorization when the call was not token-verified", async () => {
    await requestContextStorage.run(
      { actingUser: "alice@access-ci.org", actingUserAuth: "header" },
      () => server.callPeer("events", "search_events", {})
    );
    expect(calls[0].headers["Authorization"]).toBeUndefined();
  });

  it("shows a peer's 4xx error text", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 404,
      statusText: "Not Found",
      data: { error: "Tool 'x' not found" },
    });
    await expect(server.callPeer("events", "x", {})).rejects.toThrow(
      "Remote server call failed: 404 Tool 'x' not found"
    );
  });

  it("does not show a peer's 5xx error text", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 500,
      statusText: "Internal Server Error",
      data: { error: "connect ECONNREFUSED 10.0.3.4:5432" },
    });
    const err = await server.callPeer("events", "x", {}).catch((e: Error) => e);
    expect((err as Error).message).toBe("Remote server call failed: 500 Internal Server Error");
  });

  it("logs a peer's 5xx as status, peer name and path without the body", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 500,
      statusText: "Internal Server Error",
      data: { error: "connect ECONNREFUSED 10.0.3.4:5432" },
    });
    await server.callPeer("events", "search_events", {}).catch(() => undefined);
    const lines = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    spy.mockRestore();
    expect(lines).toContain('"upstream":"events"');
    expect(lines).toContain('"status":500');
    expect(lines).toContain('"path":"/tools/search_events"');
    expect(lines).not.toContain("ECONNREFUSED");
    expect(lines).not.toContain("10.0.3.4");
  });

  it("rethrows a transport failure as a plain Error without headers or acting user", async () => {
    process.env.MCP_API_KEY = "secret-key-123";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const axiosErr = Object.assign(new Error("connect ECONNREFUSED 10.0.3.4:3000"), {
      isAxiosError: true,
      code: "ECONNREFUSED",
      config: {
        method: "post",
        url: "http://mcp-events:3000/tools/search_events",
        headers: { "X-Api-Key": "secret-key-123", "X-Acting-User": "alice@access-ci.org" },
      },
      request: { _header: "X-Api-Key: secret-key-123" },
    });
    vi.spyOn(axios, "post").mockRejectedValue(axiosErr);
    const err = (await requestContextStorage
      .run({ actingUser: "alice@access-ci.org" }, () => server.callPeer("events", "search_events", {}))
      .catch((e: Error) => e)) as Error;
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    spy.mockRestore();
    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBeUndefined();
    expect(Object.keys(err)).toEqual([]);
    const dump = JSON.stringify(err, Object.getOwnPropertyNames(err)) + String(err.stack) + logged;
    expect(dump).not.toContain("secret-key-123");
    expect(dump).not.toContain("alice@access-ci.org");
    expect(dump).not.toContain("10.0.3.4");
    expect(logged).toContain('"upstream":"events"');
    expect(logged).toContain('"code":"ECONNREFUSED"');
  });

  it("throws when the service name isn't registered in ACCESS_MCP_SERVICES", async () => {
    await expect(server.callPeer("missing-service", "any_tool", {})).rejects.toThrow(
      /Service 'missing-service' not found/
    );
  });
});
