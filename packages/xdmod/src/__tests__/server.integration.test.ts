/**
 * Integration tests for the XDMoD MCP server.
 * These tests call the real XDMoD API (public endpoints only).
 * Run with: npx vitest run packages/xdmod/src/__tests__/server.integration.test.ts
 */
import { describe, test, expect, vi, beforeAll } from "vitest";

// Prevent process.exit from killing vitest
vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

// Mock the base server so we can instantiate without starting HTTP
vi.mock("@access-mcp/shared", () => ({
  BaseAccessServer: class MockBaseAccessServer {
    constructor(
      public serverName: string,
      public version: string,
      public baseURL?: string
    ) {}
    httpClient = { get: vi.fn() };
    async start() {}
  },
  getRequestContext: () => ({ includeStructuredContent: true }),
  handleApiError: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : "Unknown error"
  ),
}));

const { XDMoDMetricsServer } = await import("../index.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getText(result: { content: any[] }): string {
  return result.content[0]?.text ?? "";
}

describe("XDMoD Integration Tests (live API)", () => {
  let server: InstanceType<typeof XDMoDMetricsServer>;

  beforeAll(() => {
    server = new XDMoDMetricsServer();
  });

  describe("describe_realms", () => {
    test("should return realms from live API", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "describe_realms", arguments: {} },
      });

      const text = getText(result);
      expect(text).toContain("Jobs");
      expect(text).toContain("Statistics");
    }, 15000);
  });

  describe("describe_fields", () => {
    test("should return Jobs realm fields from live API", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "describe_fields", arguments: { realm: "Jobs" } },
      });

      const text = getText(result);
      expect(text).toContain("resource");
      expect(text).toContain("total_cpu_hours");
    }, 15000);
  });

  describe("get_dimension_values", () => {
    test("should return resource values from live API", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_dimension_values",
          arguments: { realm: "Jobs", dimension: "resource", limit: 10 },
        },
      });

      const text = getText(result);
      expect(text).toContain("resource values in Jobs");
      // Should have at least one resource
      expect(text).not.toContain("No values found");
    }, 15000);
  });

  describe("get_chart_data", () => {
    test("should return chart data from live API", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_chart_data",
          arguments: {
            realm: "Jobs",
            group_by: "none",
            statistic: "total_cpu_hours",
            start_date: "2024-01-01",
            end_date: "2024-01-31",
          },
        },
      });

      const text = getText(result);
      expect(text).toContain("Chart Data for total_cpu_hours");
    }, 15000);
  });
});
