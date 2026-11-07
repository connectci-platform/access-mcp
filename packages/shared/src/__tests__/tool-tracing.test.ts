import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { trace } from "@opentelemetry/api";
import {
  TracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace";
import { BaseAccessServer, type CallToolResult, type Resource } from "../base-server.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ToolWithAccess } from "../tool-access.js";

const PERSONAL = "jsmith@example.edu";

class TracedServer extends BaseAccessServer {
  constructor() {
    super("traced-test", "1.0.0", "https://api.example.com", { requireApiKey: true });
  }
  protected getTools(): ToolWithAccess[] {
    const schema = { type: "object" as const };
    const tools: ToolWithAccess[] = [
      { name: "search_things", description: "", inputSchema: schema, access: "public", mutates: false },
      { name: "create_thing", description: "", inputSchema: schema, access: "authenticated", mutates: true },
      { name: "get_my_things", description: "", inputSchema: schema, access: "authenticated", mutates: false },
      { name: "unmarked_read", description: "", inputSchema: schema, mutates: false },
      { name: "failing_write", description: "", inputSchema: schema, access: "authenticated", mutates: true },
    ];
    return tools;
  }
  protected getResources(): Resource[] {
    return [];
  }
  protected async handleToolCall(req: CallToolRequest): Promise<CallToolResult> {
    if (req.params.name === "failing_write") throw new Error(`Rejected ${PERSONAL}`);
    return { content: [{ type: "text", text: "ok" }] };
  }
}

const KEY = "test-key-123";
const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
let server: TracedServer;
let baseUrl: string;

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
});
afterAll(async () => {
  trace.disable();
  await provider.shutdown();
});
beforeEach(async () => {
  exporter.reset();
  process.env.MCP_API_KEY = KEY;
  server = new TracedServer();
  await server.start({ httpPort: 0 });
  baseUrl = `http://localhost:${server.httpPort}`;
});
afterEach(async () => {
  await server.stop();
  delete process.env.MCP_API_KEY;
});

const callRest = (name: string, args: Record<string, unknown>) =>
  fetch(`${baseUrl}/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: JSON.stringify({ arguments: args }),
  });

const postMcp = (body: unknown, sessionId?: string) =>
  fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });

const toolSpan = (name: string) => {
  const span = exporter.getFinishedSpans().find((s) => s.name === `tools/call ${name}`);
  if (!span) throw new Error(`no span for ${name}`);
  return span;
};

describe("tool call spans", () => {
  it("traces calls made over the MCP protocol", async () => {
    const init = await postMcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    const sessionId = init.headers.get("mcp-session-id") ?? undefined;
    await init.text();
    await postMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);

    const res = await postMcp(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search_things", arguments: { query: "gpu" } },
      },
      sessionId
    );
    await res.text();

    expect(toolSpan("search_things").attributes["gen_ai.tool.name"]).toBe("search_things");
  });

  it("creates one span for a REST call", async () => {
    await callRest("search_things", { query: "gpu" });

    const spans = exporter.getFinishedSpans().filter((s) => s.name.startsWith("tools/call"));
    expect(spans).toHaveLength(1);
  });

  it("records argument values for a public read, with sensitive keys redacted", async () => {
    await callRest("search_things", { query: "gpu", api_key: "abc" });

    const recorded = JSON.parse(
      toolSpan("search_things").attributes["mcp.tool.arguments"] as string
    );
    expect(recorded).toEqual({ query: "gpu", api_key: "[REDACTED]" });
  });

  it.each(["create_thing", "get_my_things", "unmarked_read"])(
    "records only argument names for %s",
    async (name) => {
      await callRest(name, { email: PERSONAL, description: "my account was hacked" });

      const { attributes } = toolSpan(name);
      expect(attributes["mcp.tool.argument_names"]).toEqual(["email", "description"]);
      expect(attributes["mcp.tool.arguments"]).toBeUndefined();
      expect(JSON.stringify(attributes)).not.toContain(PERSONAL);
    }
  );

  it("keeps the error type but not the message for a failed write", async () => {
    await callRest("failing_write", { email: PERSONAL });

    const span = toolSpan("failing_write");
    expect(span.attributes["error.type"]).toBe("Error");
    expect(JSON.stringify([span.status, span.events, span.attributes])).not.toContain(PERSONAL);
  });
});
