import { describe, it, expect, beforeEach, afterEach, vi, Mock } from "vitest";
import { DocumentationServer } from "./server.js";

interface MockHttpClient {
  post: Mock<
    (url: string, body: unknown, config?: unknown) => Promise<{
      status: number;
      data?: unknown;
      statusText?: string;
    }>
  >;
}

interface TextContent {
  type: "text";
  text: string;
}

function textOf(result: { content: Array<TextContent | { type: string }> }): string {
  const c = result.content[0];
  return c.type === "text" ? (c as TextContent).text : "";
}

describe("DocumentationServer", () => {
  let server: DocumentationServer;
  let mockHttpClient: MockHttpClient;

  beforeEach(() => {
    server = new DocumentationServer();
    mockHttpClient = { post: vi.fn() };
    Object.defineProperty(server, "httpClient", {
      get: () => mockHttpClient,
      configurable: true,
    });
  });

  afterEach(() => {
    delete process.env.ACCESS_AI_API_KEY;
    vi.restoreAllMocks();
  });

  describe("search_docs retrieval", () => {
    it("posts the query to the retrieve-docs URL and normalizes chunks with rank", async () => {
      mockHttpClient.post.mockResolvedValue({
        status: 200,
        data: {
          documents: [
            { text: "How to get an allocation...", url: "https://allocations.access-ci.org/a" },
            { text: "Eligibility...", url: "https://allocations.access-ci.org/b" },
          ],
          query_id: "q-123",
        },
      });

      const result = await server["handleToolCall"]({
        params: { name: "search_docs", arguments: { query: "how do I get an allocation" } },
      } as never);

      expect(mockHttpClient.post).toHaveBeenCalledTimes(1);
      const [, body] = mockHttpClient.post.mock.calls[0];
      expect(body).toMatchObject({ query: "how do I get an allocation" });

      const data = JSON.parse(textOf(result));
      expect(data.total).toBe(2);
      expect(data.items[0]).toMatchObject({ rank: 1, url: "https://allocations.access-ci.org/a" });
      expect(data.items[1].rank).toBe(2);
      expect(data.metadata.query_id).toBe("q-123");
    });
  });

  describe("tool definition", () => {
    it("exposes search_docs with fields projection support", () => {
      const tools = server["getTools"]();
      expect(tools).toHaveLength(1);
      const tool = tools[0];
      expect(tool.name).toBe("search_docs");
      expect(tool.inputSchema.properties).toHaveProperty("query");
      expect(tool.inputSchema.properties).toHaveProperty("rp_name");
      expect(tool.inputSchema.properties).toHaveProperty("fields");
      expect((tool as { _meta?: { supportsFieldProjection?: boolean } })._meta?.supportsFieldProjection).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("attaches X-API-KEY when ACCESS_AI_API_KEY is set, omits it otherwise", () => {
      // Without key: a fresh server's real httpClient has no X-API-KEY.
      delete process.env.ACCESS_AI_API_KEY;
      const noKeyServer = new DocumentationServer();
      const noKeyHeaders = (noKeyServer["httpClient"] as { defaults: { headers: Record<string, unknown> } })
        .defaults.headers;
      expect(noKeyHeaders["X-API-KEY"]).toBeUndefined();
      expect(noKeyHeaders["X-Origin"]).toBe("access-mcp-documentation");

      // With key set.
      process.env.ACCESS_AI_API_KEY = "secret-key";
      const keyServer = new DocumentationServer();
      const keyHeaders = (keyServer["httpClient"] as { defaults: { headers: Record<string, unknown> } })
        .defaults.headers;
      expect(keyHeaders["X-API-KEY"]).toBe("secret-key");
    });

    it("sends rp_name in the body and as X-Origin when scoping", async () => {
      mockHttpClient.post.mockResolvedValue({
        status: 200,
        data: { documents: [{ text: "Delta GPUs", url: "https://delta/docs" }] },
      });

      await server["handleToolCall"]({
        params: { name: "search_docs", arguments: { query: "gpus", rp_name: "delta" } },
      } as never);

      const [, body, config] = mockHttpClient.post.mock.calls[0];
      expect(body).toMatchObject({ query: "gpus", rp_name: "delta" });
      expect((config as { headers: Record<string, string> }).headers["X-Origin"]).toBe("delta");
    });

    it("falls back to top_documents when documents key is absent", async () => {
      mockHttpClient.post.mockResolvedValue({
        status: 200,
        data: { top_documents: [{ text: "legacy", url: "https://legacy" }] },
      });

      const result = await server["handleToolCall"]({
        params: { name: "search_docs", arguments: { query: "x" } },
      } as never);

      const data = JSON.parse(textOf(result));
      expect(data.total).toBe(1);
      expect(data.items[0].url).toBe("https://legacy");
    });

    it("returns total 0 with a usage_notes hint on empty results", async () => {
      mockHttpClient.post.mockResolvedValue({ status: 200, data: { documents: [] } });

      const result = await server["handleToolCall"]({
        params: { name: "search_docs", arguments: { query: "nothing matches" } },
      } as never);

      const data = JSON.parse(textOf(result));
      expect(data.total).toBe(0);
      expect(data.items).toEqual([]);
      expect(data.documentation.usage_notes).toContain("rephrasing");
    });

    it("maps 401 to an auth-unavailable error", async () => {
      mockHttpClient.post.mockResolvedValue({ status: 401, data: { error: "Unauthorized" } });

      const result = await server["handleToolCall"]({
        params: { name: "search_docs", arguments: { query: "x" } },
      } as never);

      expect((result as { isError?: boolean }).isError).toBe(true);
      const data = JSON.parse(textOf(result));
      expect(data.error.message).toContain("unavailable");
    });

    it("maps 400 to an invalid-request error mentioning rp_name", async () => {
      mockHttpClient.post.mockResolvedValue({ status: 400, data: { error: "bad slug" } });

      const result = await server["handleToolCall"]({
        params: { name: "search_docs", arguments: { query: "x", rp_name: "nope" } },
      } as never);

      expect((result as { isError?: boolean }).isError).toBe(true);
      const data = JSON.parse(textOf(result));
      expect(data.error.hint).toContain("rp_name");
    });

    it("does not show a 5xx body's error text", async () => {
      mockHttpClient.post.mockResolvedValue({
        status: 500,
        statusText: "Internal Server Error",
        data: { error: "psycopg2.OperationalError: could not connect to host 10.1.2.3" },
      });

      const result = await server["handleToolCall"]({
        params: { name: "search_docs", arguments: { query: "x" } },
      } as never);

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).not.toContain("10.1.2.3");
      expect(JSON.parse(textOf(result)).error.message).toBe("API error: 500 Internal Server Error");
    });

    it("shows a 4xx body's error text", async () => {
      mockHttpClient.post.mockResolvedValue({
        status: 422,
        statusText: "Unprocessable Entity",
        data: { error: "query is too long" },
      });

      const result = await server["handleToolCall"]({
        params: { name: "search_docs", arguments: { query: "x" } },
      } as never);

      expect(JSON.parse(textOf(result)).error.message).toBe("query is too long");
    });

    it("shows a 4xx body's message text", async () => {
      mockHttpClient.post.mockResolvedValue({
        status: 422,
        statusText: "Unprocessable Entity",
        data: { message: "query is too long" },
      });

      const result = await server["handleToolCall"]({
        params: { name: "search_docs", arguments: { query: "x" } },
      } as never);

      expect(JSON.parse(textOf(result)).error.message).toBe("query is too long");
    });

    it("rejects a missing query", async () => {
      const result = await server["handleToolCall"]({
        params: { name: "search_docs", arguments: {} },
      } as never);

      // Lock MCP error semantics: errorResponse must set isError on the result.
      expect((result as { isError?: boolean }).isError).toBe(true);
      const data = JSON.parse(textOf(result));
      expect(data.error.message).toContain("query is required");
    });

    it("projects fields when requested", async () => {
      mockHttpClient.post.mockResolvedValue({
        status: 200,
        data: { documents: [{ text: "body", url: "https://u" }], query_id: "q" },
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_docs",
          arguments: { query: "x", fields: ["total", "items[].url"] },
        },
      } as never);

      const data = JSON.parse(textOf(result));
      expect(data.total).toBe(1);
      expect(data.items[0]).toEqual({ url: "https://u" });
      expect(data.items[0].text).toBeUndefined();
    });

    it("surfaces a retry-able message when the POST rejects (network/timeout)", async () => {
      mockHttpClient.post.mockRejectedValue(new Error("ECONNABORTED"));

      const result = await server["handleToolCall"]({
        params: { name: "search_docs", arguments: { query: "x" } },
      } as never);

      expect((result as { isError?: boolean }).isError).toBe(true);
      const data = JSON.parse(textOf(result));
      // Spec-aligned wording, not the raw axios error string.
      expect(data.error.message).toContain("try another approach");
    });

    it("logs a transport failure as its code and host, not its message", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockHttpClient.post.mockRejectedValue(
        Object.assign(new Error("connect ECONNREFUSED 10.5.5.5:443 secret-body"), {
          code: "ECONNREFUSED",
        })
      );
      await server["handleToolCall"]({
        params: { name: "search_docs", arguments: { query: "x" } },
      } as never);
      const lines = spy.mock.calls.map((c) => c.join(" ")).join("\n");
      spy.mockRestore();
      expect(lines).toContain('"upstream":"uky"');
      expect(lines).toContain('"code":"ECONNREFUSED"');
      expect(lines).not.toContain("secret-body");
      expect(lines).not.toContain("10.5.5.5");
    });

    it("prefers an explicit empty documents over a stale top_documents", async () => {
      // Key-presence semantics, matching uky_client.retrieve(): a present
      // `documents: []` must NOT fall through to `top_documents`.
      mockHttpClient.post.mockResolvedValue({
        status: 200,
        data: { documents: [], top_documents: [{ text: "stale", url: "https://stale" }] },
      });

      const result = await server["handleToolCall"]({
        params: { name: "search_docs", arguments: { query: "x" } },
      } as never);

      const data = JSON.parse(textOf(result));
      expect(data.total).toBe(0);
      expect(data.items).toEqual([]);
    });

    it("sends the default X-Origin on an unscoped query (no rp_name)", async () => {
      mockHttpClient.post.mockResolvedValue({
        status: 200,
        data: { documents: [{ text: "t", url: "https://u" }] },
      });

      await server["handleToolCall"]({
        params: { name: "search_docs", arguments: { query: "x" } },
      } as never);

      // Unscoped: no per-request X-Origin override config is passed, so the
      // client's default header (access-mcp-documentation) applies.
      const [, , config] = mockHttpClient.post.mock.calls[0];
      expect(config).toBeUndefined();
    });
  });
});
