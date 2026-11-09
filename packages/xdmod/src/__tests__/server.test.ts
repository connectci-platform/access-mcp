import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

// Mock fetch globally
const mockFetch = vi.fn();
const { mockGetRequestContext } = vi.hoisted(() => ({
  mockGetRequestContext: vi.fn(() => ({ includeStructuredContent: true }) as { includeStructuredContent?: boolean } | undefined),
}));
vi.stubGlobal("fetch", mockFetch);

// Prevent process.exit from killing vitest
vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

// Mock the base server — include start() so main() doesn't crash
vi.mock("@access-mcp/shared", async (importOriginal) => {
  // The real helpers, so the tests exercise the actual 4xx-only rule and log shape.
  const actual = await importOriginal<typeof import("@access-mcp/shared")>();
  return {
  callerSafeUpstreamError: actual.callerSafeUpstreamError,
  logUpstreamFailure: actual.logUpstreamFailure,
  // The agent's /tools calls ask for structuredContent; tests that check the
  // other callers override this.
  getRequestContext: mockGetRequestContext,
  BaseAccessServer: class MockBaseAccessServer {
    constructor(
      public serverName: string,
      public version: string,
      public baseURL?: string
    ) {}
    httpClient = { get: vi.fn() };
    logger = actual.createLogger("test-xdmod");
    async start() {}
  },
  handleApiError: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : "Unknown error"
  ),
  };
});

// Sample menu data matching XDMoD API response format
const SAMPLE_MENU_DATA = [
  { text: "by Resource", realm: "Jobs", group_by: "resource", node_type: "group_by" },
  { text: "by Person", realm: "Jobs", group_by: "person", node_type: "group_by" },
  { text: "by PI", realm: "Jobs", group_by: "pi", node_type: "group_by" },
  { text: "by Institution", realm: "Jobs", group_by: "institution", node_type: "group_by" },
  { text: "by Resource", realm: "SUPREMM", group_by: "resource", node_type: "group_by" },
  { text: "by Person", realm: "SUPREMM", group_by: "person", node_type: "group_by" },
  { text: "by Resource", realm: "Cloud", group_by: "resource", node_type: "group_by" },
];

const SAMPLE_DIMENSION_VALUES = {
  totalCount: 3,
  data: [
    { id: "delta.ncsa.xsede.org", name: "Delta", short_name: "Delta" },
    { id: "bridges2.psc.xsede.org", name: "Bridges-2", short_name: "Bridges-2" },
    { id: "expanse.sdsc.xsede.org", name: "Expanse", short_name: "Expanse" },
  ],
};

const SAMPLE_CHART_DATA = {
  data: [
    {
      chart_title: "Total CPU Hours",
      group_description: "All Jobs",
      description: "CPU usage over time",
    },
  ],
};

// Helper: create a mock Response
function mockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: new Headers(),
  } as Response;
}

// Helper to extract text from CallToolResult content
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getText(result: { content: any[] }): string {
  const item = result.content[0];
  return item.text ?? "";
}

// Import the server class (after mocks are in place)
import type { ChartPayload } from "../chart-payload.js";

const { XDMoDMetricsServer } = await import("../index.js");

describe("XDMoDMetricsServer", () => {
  let server: InstanceType<typeof XDMoDMetricsServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new XDMoDMetricsServer();
    // Clear the menu cache between tests
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).menuCache = null;
    // The probe for XDMoD's latest day has its own tests.
    server["latestDataDay"] = async () => null;
  });

  describe("basic configuration", () => {
    test("should be instantiable", () => {
      expect(server).toBeDefined();
      expect(server).toBeInstanceOf(XDMoDMetricsServer);
    });

    test("should have correct server name", () => {
      expect(server["serverName"]).toBe("xdmod");
    });

    test("should have correct version", () => {
      expect(server["version"]).toBe(version);
    });

    test("should have correct base URL", () => {
      expect(server["baseURL"]).toBe("https://xdmod.access-ci.org");
    });
  });

  describe("getTools()", () => {
    test("should return 6 tools", () => {
      const tools = server["getTools"]();
      expect(tools).toHaveLength(6);
    });

    test("filters examples fit the filters schema", () => {
      type Filters = { description: string; additionalProperties: unknown };
      const withFilters = server["getTools"]().filter(
        (t: { inputSchema: { properties?: Record<string, unknown> } }) => t.inputSchema.properties?.filters,
      );
      expect(withFilters.map((t: { name: string }) => t.name)).toEqual(["get_chart_data", "get_chart_image"]);
      for (const tool of withFilters) {
        const filters = tool.inputSchema.properties?.filters as Filters;
        expect(filters.additionalProperties).toEqual({
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }],
        });
        const examples = filters.description.match(/\{[^{}]*\}/g) ?? [];
        expect(examples.length, tool.name).toBeGreaterThan(1);
        for (const example of examples) {
          for (const value of Object.values(JSON.parse(example))) {
            const ok = typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"));
            expect(ok, `${tool.name}: ${example}`).toBe(true);
          }
        }
      }
    });

    test("should include chart tools", () => {
      const tools = server["getTools"]();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const names = tools.map((t: any) => t.name);
      expect(names).toContain("get_chart_data");
      expect(names).toContain("get_chart_image");
      expect(names).toContain("get_chart_link");
    });

    test("should include discovery tools", () => {
      const tools = server["getTools"]();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const names = tools.map((t: any) => t.name);
      expect(names).toContain("describe_realms");
      expect(names).toContain("describe_fields");
      expect(names).toContain("get_dimension_values");
    });

    test("describe_realms should require no parameters", () => {
      const tools = server["getTools"]();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tool = tools.find((t: any) => t.name === "describe_realms");
      expect(tool?.inputSchema.required).toEqual([]);
    });

    test("describe_fields should require realm parameter", () => {
      const tools = server["getTools"]();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tool = tools.find((t: any) => t.name === "describe_fields");
      expect(tool?.inputSchema.required).toEqual(["realm"]);
    });

    test("get_dimension_values should require realm and dimension", () => {
      const tools = server["getTools"]();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tool = tools.find((t: any) => t.name === "get_dimension_values");
      expect(tool?.inputSchema.required).toEqual(["realm", "dimension"]);
    });
  });

  describe("handleToolCall()", () => {
    test("should throw on unknown tool", async () => {
      await expect(
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "nonexistent_tool", arguments: {} },
        })
      ).rejects.toThrow("Unknown tool: nonexistent_tool");
    });
  });

  describe("fetchMenus()", () => {
    test("should call XDMoD API with correct parameters", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ data: SAMPLE_MENU_DATA }));

      await server["fetchMenus"]();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://xdmod.access-ci.org/controllers/user_interface.php");
      expect(options.method).toBe("POST");

      const body = options.body as URLSearchParams;
      expect(body.get("operation")).toBe("get_menus");
      expect(body.get("public_user")).toBe("true");
      expect(body.get("node")).toBe("category_");
    });

    test("should cache menu results", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ data: SAMPLE_MENU_DATA }));

      const first = await server["fetchMenus"]();
      const second = await server["fetchMenus"]();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(first).toEqual(second);
    });

    test("should refresh cache after TTL expires", async () => {
      mockFetch.mockResolvedValue(mockResponse({ data: SAMPLE_MENU_DATA }));

      await server["fetchMenus"]();

      // Simulate expired cache
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server as any).menuCache.timestamp = Date.now() - 1000 * 60 * 31;

      await server["fetchMenus"]();

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test("should throw on API error", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(null, false, 500));

      await expect(server["fetchMenus"]()).rejects.toThrow(
        "Failed to fetch XDMoD menus: HTTP 500"
      );
    });

    test("should handle response without data wrapper", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(SAMPLE_MENU_DATA));

      const result = await server["fetchMenus"]();
      expect(result).toEqual(SAMPLE_MENU_DATA);
    });
  });

  describe("describe_realms tool", () => {
    test("should list realms from API and static reference", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ data: SAMPLE_MENU_DATA }));

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "describe_realms", arguments: {} },
      });

      const text = getText(result);
      expect(text).toContain("Jobs");
      expect(text).toContain("SUPREMM");
      expect(text).toContain("Cloud");
      expect(text).toContain("Storage");
      expect(text).toContain("reference only");
    });

    test("should include dimension and statistics counts", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ data: SAMPLE_MENU_DATA }));

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "describe_realms", arguments: {} },
      });

      const text = getText(result);
      expect(text).toContain("Dimensions");
      expect(text).toContain("Statistics");
    });

    test("should propagate API errors", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(null, false, 500));

      await expect(
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "describe_realms", arguments: {} },
        })
      ).rejects.toThrow("Failed to describe realms");
    });
  });

  describe("describe_fields tool", () => {
    test("should return dimensions and statistics for Jobs realm", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ data: SAMPLE_MENU_DATA }));

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "describe_fields", arguments: { realm: "Jobs" } },
      });

      const text = getText(result);
      expect(text).toContain("resource");
      expect(text).toContain("person");
      expect(text).toContain("pi");
      expect(text).toContain("institution");
      expect(text).toContain("total_cpu_hours");
      expect(text).toContain("job_count");
      expect(text).toContain("CPU Hours: Total");
    });

    test("should return SUPREMM statistics", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ data: SAMPLE_MENU_DATA }));

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "describe_fields", arguments: { realm: "SUPREMM" } },
      });

      const text = getText(result);
      expect(text).toContain("gpu_time");
      expect(text).toContain("GPU Hours: Total");
      expect(text).toContain("avg_percent_gpu_usage");
    });

    test("should return error for unknown realm", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ data: SAMPLE_MENU_DATA }));

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "describe_fields", arguments: { realm: "FakeRealm" } },
      });

      const text = getText(result);
      expect(text).toContain("not found");
      expect(text).toContain("Available realms");
    });

    test("should use static data when realm has no API entries", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ data: SAMPLE_MENU_DATA }));

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "describe_fields", arguments: { realm: "Storage" } },
      });

      const text = getText(result);
      expect(text).toContain("Storage");
      expect(text).toContain("avg_logical_usage");
    });

    test("should deduplicate dimension entries", async () => {
      const dupeMenus = [
        { realm: "Jobs", group_by: "resource", text: "By Resource", id: "resource" },
        { realm: "Jobs", group_by: "resource", text: "By Resource (dup)", id: "resource" },
      ];
      mockFetch.mockResolvedValueOnce(mockResponse({ data: dupeMenus }));

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "describe_fields", arguments: { realm: "Jobs" } },
      });

      const text = getText(result);
      const matches = text.match(/`resource`/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe("get_dimension_values tool", () => {
    test("should call metric_explorer API with correct parameters", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(SAMPLE_DIMENSION_VALUES));

      await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_dimension_values",
          arguments: { realm: "Jobs", dimension: "resource" },
        },
      });

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://xdmod.access-ci.org/controllers/metric_explorer.php");
      expect(options.method).toBe("POST");

      const body = options.body as URLSearchParams;
      expect(body.get("operation")).toBe("get_dimension");
      expect(body.get("public_user")).toBe("true");
      expect(body.get("realm")).toBe("Jobs");
      expect(body.get("dimension_id")).toBe("resource");
      expect(body.get("limit")).toBe("200");
    });

    test("does not show a non-JSON 200 body's parse error", async () => {
      const res = mockResponse(null);
      res.json = async () => {
        throw new SyntaxError("Unexpected token '<', \"<html>SELECT * FROM x\" is not valid JSON");
      };
      mockFetch.mockResolvedValueOnce(res);
      const msg = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_dimension_values", arguments: { realm: "Jobs", dimension: "resource" } },
      }).then(
        (r) => (r.content[0] as { text: string }).text,
        (e: Error) => e.message
      );
      expect(msg).toContain("XDMoD returned an unreadable response");
      expect(msg).not.toContain("SELECT");
    });

    test("should format dimension values in response", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(SAMPLE_DIMENSION_VALUES));

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_dimension_values",
          arguments: { realm: "Jobs", dimension: "resource" },
        },
      });

      const text = getText(result);
      expect(text).toContain("Delta");
      expect(text).toContain("Bridges-2");
      expect(text).toContain("Expanse");
      expect(text).toContain("3 total");
    });

    test("should use custom limit parameter", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(SAMPLE_DIMENSION_VALUES));

      await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_dimension_values",
          arguments: { realm: "Jobs", dimension: "resource", limit: 50 },
        },
      });

      const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
      expect(body.get("limit")).toBe("50");
    });

    test("should show truncation message when more values exist", async () => {
      const manyValues = {
        totalCount: 500,
        data: [
          { id: "1", name: "Resource A" },
          { id: "2", name: "Resource B" },
        ],
      };
      mockFetch.mockResolvedValueOnce(mockResponse(manyValues));

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_dimension_values",
          arguments: { realm: "Jobs", dimension: "resource" },
        },
      });

      const text = getText(result);
      expect(text).toContain("498 more");
    });

    test("should handle empty dimension values", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ totalCount: 0, data: [] }));

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_dimension_values",
          arguments: { realm: "Jobs", dimension: "nonexistent" },
        },
      });

      const text = getText(result);
      expect(text).toContain("No values found");
    });

    test("should throw on API error", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(null, false, 500));

      await expect(
        server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_dimension_values",
            arguments: { realm: "Jobs", dimension: "resource" },
          },
        })
      ).rejects.toThrow("Failed to get dimension values");
    });
  });

  describe("get_chart_data tool", () => {
    describe("filter matches", () => {
      const dimension = (names: string[]) => ({
        ok: true,
        json: () =>
          Promise.resolve({ data: names.map((name, i) => ({ id: String(i + 1), name })) }),
      });
      const chart = {
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: [{ hc_jsonstore: { data: [{ name: "ACCESS", x: ["ACCESS"], y: [5] }] } }],
          }),
      };
      const call = (resource: string | string[]) =>
        server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_chart_data",
            arguments: {
              realm: "Jobs",
              group_by: "none",
              statistic: "total_cpu_hours",
              start_date: "2026-01-01",
              end_date: "2026-01-31",
              dataset_type: "aggregate",
              filters: { resource },
            },
          },
        });

      beforeEach(() => {
        mockFetch.mockReset();
      });

      test("should send every id when the filter is a list", async () => {
        mockFetch
          .mockResolvedValueOnce(dimension(["NCSA DELTA CPU", "Anvil CPU", "Expanse"]))
          .mockResolvedValueOnce(dimension(["NCSA DELTA CPU", "Anvil CPU", "Expanse"]))
          .mockResolvedValueOnce(chart);

        await call(["NCSA DELTA CPU", "Expanse"]);
        const body = mockFetch.mock.calls[2][1].body as URLSearchParams;
        expect(body.get("resource_filter")).toBe("1,3");
      });

      test("should send each id once when list entries overlap", async () => {
        const names = ["NCSA DELTA CPU", "NCSA DELTA GPU", "Expanse"];
        mockFetch
          .mockResolvedValueOnce(dimension(names))
          .mockResolvedValueOnce(dimension(names))
          .mockResolvedValueOnce(chart);

        await call(["Delta", "NCSA DELTA CPU"]);
        const body = mockFetch.mock.calls[2][1].body as URLSearchParams;
        expect(body.get("resource_filter")).toBe("1,2");
      });

      test("should say which resources a partial name included", async () => {
        mockFetch
          .mockResolvedValueOnce(dimension(["NCSA DELTA CPU", "NCSA DELTA GPU", "NCSA DeltaAI", "Expanse"]))
          .mockResolvedValueOnce(chart);

        const result = await call("Delta");
        const text = (result.content[0] as { text: string }).text;

        expect(text).toContain('resource "Delta" included NCSA DELTA CPU, NCSA DELTA GPU, NCSA DeltaAI');
        expect(mockFetch.mock.calls[1][1].body.get("resource_filter")).toBe("1,2,3");
      });

      test("should not call out an exact match", async () => {
        mockFetch.mockResolvedValueOnce(dimension(["Expanse", "Expanse GPU"])).mockResolvedValueOnce(chart);

        const result = await call("Expanse");

        expect((result.content[0] as { text: string }).text).not.toContain("included");
      });
    });

    describe("caching", () => {
      const chartResponse = {
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: [
              {
                hc_jsonstore: { data: [{ name: "Delta", x: ["Delta"], y: [5] }] },
              },
            ],
          }),
      };
      const emptyResponse = {
        ok: true,
        json: () => Promise.resolve({ success: true, data: [] }),
      };
      const chart = (args: Record<string, unknown> = {}) =>
        server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_chart_data",
            arguments: {
              realm: "Jobs",
              group_by: "resource",
              statistic: "job_count",
              start_date: "2026-01-01",
              end_date: "2026-01-31",
              dataset_type: "aggregate",
              ...args,
            },
          },
        });

      beforeEach(() => {
        vi.useFakeTimers({ now: new Date("2026-03-15T12:00:00Z"), toFake: ["Date"] });
        mockFetch.mockReset();
        mockFetch.mockResolvedValue(chartResponse);
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      test("should reuse a finished date range", async () => {
        const first = await chart();
        const second = await chart();

        expect(second).toEqual(first);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      test("should query again for different arguments", async () => {
        await chart();
        await chart({ statistic: "total_cpu_hours" });

        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      test("should query again after an hour", async () => {
        await chart();
        vi.setSystemTime(new Date("2026-03-15T13:00:01Z"));
        await chart();

        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      test.each(["2026-03-15", "2026-03-16"])(
        "should not reuse a range ending %s, which is still changing",
        async (end_date) => {
          await chart({ end_date });
          await chart({ end_date });

          expect(mockFetch).toHaveBeenCalledTimes(2);
        }
      );

      test("should not keep an empty result", async () => {
        mockFetch.mockResolvedValue(emptyResponse);

        await chart();
        await chart();

        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      test("should not keep a failed result", async () => {
        mockFetch.mockRejectedValueOnce(new Error("XDMoD down"));

        await expect(chart()).rejects.toThrow();
        await chart();

        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      test("should drop the oldest result when full", async () => {
        for (let i = 1; i <= 101; i++) await chart({ limit: i });
        mockFetch.mockClear();

        await chart({ limit: 101 });
        expect(mockFetch).not.toHaveBeenCalled();

        await chart({ limit: 1 });
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
    });

    test("should call user_interface API with correct chart parameters", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(SAMPLE_CHART_DATA));

      await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_chart_data",
          arguments: {
            realm: "Jobs",
            group_by: "none",
            statistic: "total_cpu_hours",
            start_date: "2024-01-01",
            end_date: "2024-12-31",
          },
        },
      });

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://xdmod.access-ci.org/controllers/user_interface.php");

      const body = options.body as URLSearchParams;
      expect(body.get("operation")).toBe("get_charts");
      expect(body.get("public_user")).toBe("true");
      expect(body.get("realm")).toBe("Jobs");
      expect(body.get("group_by")).toBe("none");
      expect(body.get("statistic")).toBe("total_cpu_hours");
      expect(body.get("start_date")).toBe("2024-01-01");
      expect(body.get("end_date")).toBe("2024-12-31");
    });

    test("should format chart data response", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(SAMPLE_CHART_DATA));

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_chart_data",
          arguments: {
            realm: "Jobs",
            group_by: "none",
            statistic: "total_cpu_hours",
            start_date: "2024-01-01",
            end_date: "2024-12-31",
          },
        },
      });

      const text = getText(result);
      expect(text).toContain("total_cpu_hours");
      expect(text).toContain("Jobs");
      expect(text).toContain("Total CPU Hours");
    });

    test("should include parsed summary for aggregate grouped data", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        data: [{
          chart_title: "Wait Hours: Per Job",
          group_description: "Queue",
          description: "Average wait time",
          hc_jsonstore: {
            layout: {
              annotations: [{ name: "title", text: "Wait Hours: Per Job" }],
            },
            data: [{
              name: "Wait Hours: Per Job",
              x: ["gpuA100x4", "cpu", "gpuA40x4"],
              y: [21.93, 9.36, 7.90],
            }],
          },
        }],
      }));

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_chart_data",
          arguments: {
            realm: "Jobs",
            group_by: "queue",
            statistic: "avg_waitduration_hours",
            start_date: "2026-03-17",
            end_date: "2026-03-23",
            dataset_type: "aggregate",
          },
        },
      });

      const text = getText(result);
      expect(text).toContain("Wait Hours: Per Job by queue:");
      expect(text).toContain("gpuA100x4: 21.9300");
      expect(text).toContain("cpu: 9.3600");
      expect(text).toContain("gpuA40x4: 7.9000");
      expect(text).not.toContain("```json");
    });

    test("should include parsed summary for timeseries grouped data", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        data: [{
          chart_title: "Wait Hours: Per Job",
          group_description: "Queue",
          description: "Average wait time",
          hc_jsonstore: {
            layout: {
              annotations: [{ name: "title", text: "Wait Hours: Per Job" }],
            },
            data: [
              { name: "1. gpuA100x4", y: [20.0, 22.0, null, 21.0] },
              { name: "gap connector", y: [] },
              { name: "2. cpu", y: [9.0, 10.0, 9.5] },
            ],
          },
        }],
      }));

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_chart_data",
          arguments: {
            realm: "Jobs",
            group_by: "queue",
            statistic: "avg_waitduration_hours",
            start_date: "2026-03-17",
            end_date: "2026-03-23",
            dataset_type: "timeseries",
          },
        },
      });

      const text = getText(result);
      expect(text).toContain("Wait Hours: Per Job by queue");
      expect(text).toContain("1. gpuA100x4 (3 data points)");
      expect(text).toContain("2. cpu (3 data points)");
      expect(text).not.toContain("gap connector");
    });

    describe("chart payload", () => {
      const monthStarts = [1785556800000, 1788235200000, 1790827200000];
      const trace = (name: string) => ({ name, x: monthStarts, y: [1, 2, 3] });
      const respond = (traces: unknown[]) =>
        mockResponse({ success: true, data: [{ description: "Core hours used", hc_jsonstore: { data: traces } }] });
      const run = (extra: Record<string, unknown> = {}) =>
        server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_chart_data",
            arguments: {
              realm: "Jobs",
              group_by: "resource",
              statistic: "total_cpu_hours",
              start_date: "2026-08-01",
              end_date: "2026-10-31",
              dataset_type: "timeseries",
              aggregation_unit: "Month",
              ...extra,
            },
          },
        }) as Promise<{ content: { text: string }[]; structuredContent?: { chart: ChartPayload } }>;
      const sentBody = (n = 0) => mockFetch.mock.calls[n][1].body as URLSearchParams;
      const baseArgs = {
        realm: "Jobs",
        group_by: "resource",
        statistic: "total_cpu_hours",
        start_date: "2026-08-01",
        end_date: "2026-10-31",
        dataset_type: "timeseries",
      };

      beforeEach(() => {
        mockFetch.mockReset();
      });

      test("returns the chart payload beside the text", async () => {
        mockFetch.mockResolvedValueOnce(respond([trace("A")]));
        const result = await run();
        const chart = result.structuredContent!.chart;

        expect(chart.version).toBe(1);
        expect(chart.series).toHaveLength(1);
        expect(chart.series![0].points.map((p: { start: string }) => p.start)).toEqual([
          "2026-08-01",
          "2026-09-01",
          "2026-10-01",
        ]);
        expect(chart.measure.label).toBe("CPU Hours: Total");
        expect(chart.measure.description).toBe("Core hours used");
        expect(chart.link).toContain("https://xdmod.access-ci.org/index.php#tg_usage?");
        expect(chart.link).toContain("statistic=total_cpu_hours");
        expect(result.content[0].text).toMatch(/^Chart Data for/);
      });

      test("the text no longer prints a per-series avg", async () => {
        mockFetch.mockResolvedValueOnce(respond([trace("A")]));
        const text = (await run()).content[0].text;

        expect(text).not.toMatch(/avg /);
        expect(text).toContain("  - 2026-08-01: 1.0000");
        expect(text).toContain("  - 2026-10-01: 3.0000");
      });

      test("asks XDMoD for one more series than the limit", async () => {
        mockFetch.mockResolvedValueOnce(respond([trace("A"), trace("B"), trace("C"), trace("D")]));
        const result = await run({ limit: 3 });

        expect(sentBody().get("limit")).toBe("4");
        expect(result.structuredContent!.chart.series!.map((s: { name: string }) => s.name)).toEqual(["A", "B", "C"]);
        expect(result.structuredContent!.chart.has_more).toBe(true);
        expect(result.content[0].text).toContain("- C (3 data points)");
        expect(result.content[0].text).not.toContain("- D ");
      });

      test("has_more is false when no extra series came back", async () => {
        mockFetch.mockResolvedValueOnce(respond([trace("A"), trace("B"), trace("C")]));
        const result = await run({ limit: 3 });

        expect(result.structuredContent!.chart.series).toHaveLength(3);
        expect(result.structuredContent!.chart.has_more).toBe(false);
      });

      test("trims an aggregate list to the limit", async () => {
        mockFetch.mockResolvedValueOnce(
          respond([{ name: "m", x: ["a", "b", "c"], y: [3, 2, 1] }])
        );
        const result = await run({ dataset_type: "aggregate", group_by: "queue", limit: 2 });

        expect(result.structuredContent!.chart.categories!.map((c: { name: string }) => c.name)).toEqual(["a", "b"]);
        expect(result.structuredContent!.chart.has_more).toBe(true);
        expect(result.content[0].text).not.toContain("- c:");
      });

      test("ordered dimensions keep XDMoD's bucket order, cached", async () => {
        const lookup = () =>
          mockResponse({
            data: [
              { id: "1", name: "1 Core" },
              { id: "2", name: "2 - 4 Cores" },
              { id: "3", name: "5 - 8 Cores" },
            ],
          });
        const aggregate = () =>
          respond([{ name: "m", x: ["5 - 8 Cores", "1 Core", "2 - 4 Cores"], y: [9, 5, 1] }]);
        mockFetch
          .mockResolvedValueOnce(aggregate())
          .mockResolvedValueOnce(lookup())
          .mockResolvedValueOnce(aggregate());
        const args = { dataset_type: "aggregate", group_by: "jobsize" };

        const first = await run(args);
        expect(first.structuredContent!.chart.categories!.map((c: { name: string }) => c.name)).toEqual([
          "1 Core",
          "2 - 4 Cores",
          "5 - 8 Cores",
        ]);
        expect(sentBody(1).get("dimension_id")).toBe("jobsize");

        await run({ ...args, limit: 11 });
        // Lookup once, then two chart requests.
        expect(mockFetch).toHaveBeenCalledTimes(3);
      });

      test("the text warns when the last period holds only part of the data", async () => {
        mockFetch.mockResolvedValueOnce(
          respond([{ name: "A", x: monthStarts.slice(0, 2), y: [12, 0.05] }])
        );
        const result = await run();

        expect(result.structuredContent!.chart.last_data_period_partial).toBe(true);
        expect(result.content[0].text).toContain(
          "XDMoD has no data after Sep 2026, so the Sep 2026 value may cover only part of that period"
        );
        expect(result.content[0].text).not.toContain("only through Sep 1");
      });

      test("the text gives the real XDMoD link instead of pointing at other tools", async () => {
        mockFetch.mockResolvedValueOnce(respond([trace("A")]));
        const result = await run();
        const text = result.content[0].text;

        expect(text).not.toContain("get_chart_link");
        expect(text).toContain(`Open this chart in XDMoD: ${result.structuredContent!.chart.link}`);
      });

      test("drops XDMoD's Others series and counts what it left out", async () => {
        mockFetch.mockResolvedValueOnce(
          respond([trace("A"), trace("B"), trace("C"), trace("D"), trace("All 37 Others")])
        );
        const result = await run({ limit: 3 });
        const chart = result.structuredContent!.chart;

        expect(chart.series!.map((s) => s.name)).toEqual(["A", "B", "C"]);
        expect(chart.has_more).toBe(true);
        // D, cut by the limit, plus the 37 XDMoD folded into Others.
        expect(chart.others_count).toBe(38);
        expect(result.content[0].text).not.toContain("Others");
        expect(result.content[0].text).toContain("XDMoD has 38 more not listed.");
      });

      test("doesn't let an all-empty series take a place in the top N", async () => {
        mockFetch.mockResolvedValueOnce(
          respond([trace("A"), { name: "Empty", x: monthStarts, y: [null, null, null] }, trace("B")])
        );
        const result = await run({ limit: 2 });
        const chart = result.structuredContent!.chart;

        expect(chart.series!.map((s) => s.name)).toEqual(["A", "B"]);
        expect(chart.has_more).toBe(false);
        expect(chart.others_count).toBe(0);
      });

      test("an extra series with no Others count says there is more without a number", async () => {
        mockFetch.mockResolvedValueOnce(respond([trace("A"), trace("B"), trace("C")]));
        const result = await run({ limit: 2 });

        expect(result.structuredContent!.chart.others_count).toBeNull();
        expect(result.content[0].text).toContain("XDMoD has more not listed.");
      });

      test("drops an aggregate's Others bar and counts it", async () => {
        mockFetch.mockResolvedValueOnce(
          respond([{ name: "m", x: ["a", "b", "All 1,204 Others"], y: [3, 2, 9] }])
        );
        const result = await run({ dataset_type: "aggregate", group_by: "queue", limit: 2 });
        const chart = result.structuredContent!.chart;

        expect(chart.categories!.map((c) => c.name)).toEqual(["a", "b"]);
        expect(chart.has_more).toBe(true);
        expect(chart.others_count).toBe(1204);
      });

      test("keeps everything when there is no limit", async () => {
        const info = { name: "m", x: ["a", "b"], y: [3, 2] };
        const trimmed = server["trimToLimit"](
          { hc_jsonstore: { data: [info] } },
          { ...baseArgs, dataset_type: "aggregate" }
        );
        expect(trimmed.hasMore).toBe(false);
        expect(trimmed.chartInfo.hc_jsonstore!.data![0].x).toEqual(["a", "b"]);
        expect(server["trimToLimit"]({}, baseArgs).othersCount).toBe(0);
        expect(server["trimToLimit"]({ hc_jsonstore: { data: [{ name: "m" }] } }, { ...baseArgs, dataset_type: "aggregate" }).hasMore).toBe(false);
        const series = server["trimToLimit"](
          { hc_jsonstore: { data: [{ name: "A", x: monthStarts, y: [1, 2, 3] }, { x: [] }, { name: "gap connector" }] } },
          baseArgs
        );
        expect(series.chartInfo.hc_jsonstore!.data!.map((t) => t.name)).toEqual(["A"]);
      });

      test("aggregates carry the recent-data flag and the latest data day", async () => {
        vi.useFakeTimers({ now: new Date("2026-11-09T12:00:00Z"), toFake: ["Date"] });
        try {
          server["latestDataDay"] = async () => "2026-10-01";
          mockFetch.mockResolvedValueOnce(
            respond([{ name: "m", x: ["Chemistry", "Physics"], y: [9, 4] }])
          );
          const result = await run({
            dataset_type: "aggregate",
            group_by: "fieldofscience",
            start_date: "2026-01-01",
            end_date: "2026-11-09",
          });
          const chart = result.structuredContent!.chart;

          expect(chart.last_period_incomplete).toBe(true);
          expect(chart.data_through).toBe("2026-10-01");
          expect(chart.data_through_precision).toBe("day");
          expect(result.content[0].text).toContain("XDMoD has data only through Oct 1, 2026");
        } finally {
          vi.useRealTimers();
        }
      });

      test("leaves structuredContent out unless the caller asks for it", async () => {
        mockFetch.mockResolvedValue(respond([trace("A")]));
        mockGetRequestContext.mockReturnValueOnce(undefined);
        const other = await run();
        expect(other.structuredContent).toBeUndefined();
        expect(other.content[0].text).toMatch(/^Chart Data for/);

        // The cache keeps the payload for a caller that does ask.
        const agent = await run();
        expect(agent.structuredContent).toBeDefined();
        mockGetRequestContext.mockReturnValueOnce({ includeStructuredContent: false });
        expect((await run()).structuredContent).toBeUndefined();
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      test("no data gives no structuredContent", async () => {
        mockFetch.mockResolvedValueOnce(mockResponse({ success: true, data: [] }));
        const result = await run();

        expect(result.structuredContent).toBeUndefined();
        expect(result.content[0].text).toContain("No data available");
      });

      test("a failed call gives no structuredContent", async () => {
        mockFetch.mockResolvedValueOnce(mockResponse(null, false, 500));

        await expect(run()).rejects.toThrow();
      });

      test("keeps the text and warns when XDMoD's periods don't fit the grid", async () => {
        const warn = vi.spyOn(server["logger"], "warn").mockImplementation(() => {});
        mockFetch.mockResolvedValueOnce(
          respond([{ name: "A", x: [1785556800000 + 86_400_000], y: [1] }])
        );
        const result = await run();

        expect(result.structuredContent).toBeUndefined();
        expect(result.content[0].text).toMatch(/^Chart Data for/);
        expect(warn).toHaveBeenCalled();
      });

      test("the cached result keeps its structuredContent", async () => {
        mockFetch.mockResolvedValue(respond([trace("A")]));
        const first = await run();
        const second = await run();

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(second.structuredContent).toEqual(first.structuredContent);
        expect(second.structuredContent).toBeDefined();
      });
    });

    describe("aggregation_unit and per-period values", () => {
      // Midnight Eastern on Aug 1, Sep 1 and Oct 1 2026, as XDMoD sends them.
      const monthStarts = [1785556800000, 1788235200000, 1790827200000];
      const timeseries = (y: (number | null)[], x: unknown[] = monthStarts) =>
        mockResponse({ data: [{ hc_jsonstore: { data: [{ name: "NCSA DELTA GPU", x, y }] } }] });
      const chartData = (extra: Record<string, unknown> = {}) =>
        server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_chart_data",
            arguments: {
              realm: "Jobs",
              group_by: "resource",
              statistic: "total_cpu_hours",
              start_date: "2026-08-01",
              end_date: "2026-10-31",
              dataset_type: "timeseries",
              ...extra,
            },
          },
        });
      const sentBody = () => mockFetch.mock.calls.at(-1)![1].body as URLSearchParams;

      test("sends the unit and lists each period's start and value", async () => {
        mockFetch.mockResolvedValueOnce(timeseries([5966498.92, null, 6625166.73]));
        const text = getText(await chartData({ aggregation_unit: "Month" }));

        expect(sentBody().get("aggregation_unit")).toBe("Month");
        expect(text).toContain("(2026-08-01 to 2026-10-31, by month):");
        expect(text).toContain("- NCSA DELTA GPU (2 data points)");
        expect(text).toContain("  - 2026-08-01: 5966498.9200\n  - 2026-10-01: 6625166.7300\n");
        expect(text).not.toContain("2026-09-01");
      });

      test("sends the resolved unit when it is omitted or Auto", async () => {
        for (const extra of [{}, { aggregation_unit: "Auto" }]) {
          mockFetch.mockResolvedValueOnce(timeseries([1, 2, 3]));
          const text = getText(await chartData(extra));

          expect(sentBody().get("aggregation_unit")).toBe("Day");
          expect(text).toContain("(2026-08-01 to 2026-10-31, by day):");
        }
      });

      test("resolves a year-long range to Month", async () => {
        mockFetch.mockResolvedValueOnce(timeseries([1, 2, 3]));
        await chartData({ start_date: "2026-01-01", end_date: "2026-12-31" });

        expect(sentBody().get("aggregation_unit")).toBe("Month");
      });

      test("summarizes a series too long to list", async () => {
        const days = Array.from({ length: 61 }, (_, i) => monthStarts[0] + i * 86_400_000);
        mockFetch.mockResolvedValueOnce(timeseries(days.map(() => 1), days));
        const text = getText(await chartData({ aggregation_unit: "Day" }));

        expect(text).toContain("- NCSA DELTA GPU (61 data points)");
        expect(text).not.toContain("  - 2026-08-01");
        expect(text).toContain("set aggregation_unit to Month");
      });

      test("says periods are whole even when the range is not", async () => {
        mockFetch.mockResolvedValueOnce(timeseries([1, 2, 3]));
        const text = getText(await chartData({ start_date: "2026-08-15", aggregation_unit: "Month" }));
        expect(text).toContain("XDMoD counts the whole first and last period");
      });

      test("stops listing once the total budget is spent", async () => {
        const series = Array.from({ length: 6 }, (_, n) => ({
          name: `R${n}`,
          x: Array.from({ length: 60 }, (_, i) => monthStarts[0] + i * 86_400_000),
          y: Array.from({ length: 60 }, () => 1),
        }));
        mockFetch.mockResolvedValueOnce(mockResponse({ data: [{ hc_jsonstore: { data: series } }] }));
        const text = getText(await chartData({ aggregation_unit: "Day", limit: 6 }));

        expect(text.match(/^ {2}- /gm)).toHaveLength(300);
        expect(text).toContain("- R5 (60 data points)");
        expect(text).toContain("300 in all, are listed");
      });

      test("get_chart_image sends the unit too", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(8),
          headers: new Headers(),
        } as Response);
        await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_chart_image",
            arguments: {
              realm: "Jobs",
              group_by: "none",
              statistic: "total_cpu_hours",
              start_date: "2024-01-01",
              end_date: "2024-12-31",
              format: "png",
              aggregation_unit: "Quarter",
            },
          },
        });
        expect(sentBody().get("aggregation_unit")).toBe("Quarter");
      });
    });

    test("should handle empty chart data", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ data: [] }));

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_chart_data",
          arguments: {
            realm: "Jobs",
            group_by: "none",
            statistic: "total_cpu_hours",
            start_date: "2024-01-01",
            end_date: "2024-12-31",
          },
        },
      });

      const text = getText(result);
      expect(text).toContain("No data available");
    });
  });

  describe("upstream error text", () => {
    const chartArgs = {
      realm: "Jobs",
      group_by: "none",
      statistic: "total_cpu_hours",
      start_date: "2024-01-01",
      end_date: "2024-12-31",
    };
    const run = (name: string, extra: Record<string, unknown> = {}) =>
      server["handleToolCall"]({
        method: "tools/call",
        params: { name, arguments: { ...chartArgs, ...extra } },
      }).then(
        () => "",
        (e: Error) => e.message
      );
    const sql = "SQLSTATE[42S02]: Base table or view not found: 1146 Table 'moddb.x'";

    test.each(["get_chart_data", "get_chart_image"])(
      "%s does not show a 500 body's message",
      async (name) => {
        mockFetch.mockResolvedValueOnce(mockResponse({ success: false, message: sql }, false, 500));
        const msg = await run(name);
        expect(msg).toContain("HTTP 500");
        expect(msg).not.toContain("SQLSTATE");
      }
    );

    test("logs a 500 as status and upstream without the body text", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockFetch.mockResolvedValueOnce(mockResponse({ success: false, message: sql }, false, 500));
      await run("get_chart_data");
      const lines = spy.mock.calls.map((c) => c.join(" ")).join("\n");
      spy.mockRestore();
      expect(lines).toContain('"upstream":"xdmod"');
      expect(lines).toContain('"status":500');
      expect(lines).not.toContain("SQLSTATE");
      expect(lines).not.toContain("moddb");
    });

    test.each(["get_chart_data", "get_chart_image"])(
      "%s shows a 4xx body's message",
      async (name) => {
        mockFetch.mockResolvedValueOnce(
          mockResponse({ success: false, message: "Invalid date range" }, false, 400)
        );
        expect(await run(name)).toContain("XDMoD error: Invalid date range");
      }
    );

    test.each(["get_chart_data", "get_chart_image"])(
      "%s does not show a non-JSON 500 body's parse error",
      async (name) => {
        const res = mockResponse(null, false, 500);
        res.json = async () => {
          throw new SyntaxError("Unexpected token '<', \"<html>SELECT * FROM x\" is not valid JSON");
        };
        mockFetch.mockResolvedValueOnce(res);
        const msg = await run(name);
        expect(msg).toContain("HTTP 500");
        expect(msg).not.toContain("SELECT");
      }
    );

    test("get_chart_data does not show a non-JSON 200 body's parse error", async () => {
      const res = mockResponse(null);
      res.json = async () => {
        throw new SyntaxError("Unexpected token '<', \"<html>SELECT * FROM x\" is not valid JSON");
      };
      mockFetch.mockResolvedValueOnce(res);
      const msg = await run("get_chart_data");
      expect(msg).toContain("XDMoD returned an unreadable response");
      expect(msg).not.toContain("SELECT");
    });

    test("get_chart_data does not show a 200 success:false message", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ success: false, message: sql }));
      const msg = await run("get_chart_data");
      expect(msg).not.toContain("SQLSTATE");
      expect(msg).toContain("XDMoD could not run this query");
    });

    test("get_chart_data keeps the valid-statistics hint for a 200 No Statistic found", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: false, message: "No Statistic found for foo in Jobs: SQL here" })
      );
      const msg = await run("get_chart_data", { statistic: "foo" });
      expect(msg).toContain("No Statistic found");
      expect(msg).toContain("Valid statistics for Jobs");
      expect(msg).not.toContain("SQL here");
    });
  });

  describe("get_chart_link tool", () => {
    test("should generate correct portal URL", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_chart_link",
          arguments: {
            realm: "Jobs",
            group_by: "resource",
            statistic: "total_cpu_hours",
          },
        },
      });

      const text = getText(result);
      expect(text).toContain("https://xdmod.access-ci.org/index.php#tg_usage");
      expect(text).toContain("realm=Jobs");
      expect(text).toContain("group_by=resource");
      expect(text).toContain("statistic=total_cpu_hours");
    });
  });

  describe("get_chart_image tool", () => {
    test("should request PNG and return image content", async () => {
      const fakeBuffer = new ArrayBuffer(8);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => fakeBuffer,
        headers: new Headers(),
      } as Response);

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_chart_image",
          arguments: {
            realm: "Jobs",
            group_by: "none",
            statistic: "total_cpu_hours",
            start_date: "2024-01-01",
            end_date: "2024-12-31",
            format: "png",
          },
        },
      });

      expect(result.content[0].type).toBe("image");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result.content[0] as any).mimeType).toBe("image/png");
    });

    test("should request SVG and return text content", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => "<svg>chart</svg>",
        headers: new Headers(),
      } as Response);

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_chart_image",
          arguments: {
            realm: "Jobs",
            group_by: "none",
            statistic: "total_cpu_hours",
            start_date: "2024-01-01",
            end_date: "2024-12-31",
            format: "svg",
          },
        },
      });

      expect(result.content[0].type).toBe("text");
      const text = getText(result);
      expect(text).toContain("SVG");
      expect(text).toContain("<svg>chart</svg>");
    });
  });
});

describe("latest data day probe", () => {
  let probeServer: InstanceType<typeof XDMoDMetricsServer>;
  const day = (d: string) => Date.parse(`${d}T05:00:00Z`);
  const probeResponse = (y: (number | null)[]) =>
    mockResponse({
      success: true,
      data: [
        {
          hc_jsonstore: {
            data: [
              {
                name: "Number of Jobs Ended",
                x: [day("2026-09-28"), day("2026-09-29"), day("2026-09-30"), day("2026-10-01")],
                y,
              },
            ],
          },
        },
      ],
    });

  beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers({ now: new Date("2026-11-09T12:00:00Z"), toFake: ["Date"] });
    probeServer = new XDMoDMetricsServer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("asks for 120 days of daily job counts and returns the last non-zero day", async () => {
    mockFetch.mockResolvedValueOnce(probeResponse([5, 6, 7, 0]));

    expect(await probeServer["latestDataDay"]("Jobs")).toBe("2026-09-30");

    const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("realm")).toBe("Jobs");
    expect(body.get("group_by")).toBe("none");
    expect(body.get("statistic")).toBe("job_count");
    expect(body.get("dataset_type")).toBe("timeseries");
    expect(body.get("aggregation_unit")).toBe("Day");
    expect(body.get("end_date")).toBe("2026-11-09");
    expect(body.get("start_date")).toBe("2026-07-13");
  });

  test("ignores null days and caches per realm", async () => {
    mockFetch.mockResolvedValueOnce(probeResponse([5, 6, null, null]));

    expect(await probeServer["latestDataDay"]("Jobs")).toBe("2026-09-29");
    expect(await probeServer["latestDataDay"]("Jobs")).toBe("2026-09-29");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("returns null on failure without caching it", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(null, false, 500));
    expect(await probeServer["latestDataDay"]("Jobs")).toBeNull();

    mockFetch.mockRejectedValueOnce(new Error("down"));
    expect(await probeServer["latestDataDay"]("Jobs")).toBeNull();

    mockFetch.mockResolvedValueOnce(probeResponse([1, 0, 0, 0]));
    expect(await probeServer["latestDataDay"]("Jobs")).toBe("2026-09-28");
  });

  test("gives up after the timeout and the tool still answers", async () => {
    probeServer["probeTimeoutMs"] = 10;
    const x = [1785556800000, 1788235200000, 1790827200000];
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({ success: true, data: [{ hc_jsonstore: { data: [{ name: "A", x, y: [1, 2, 3] }] } }] })
      )
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason))
          )
      );
    const result = (await probeServer["handleToolCall"]({
      method: "tools/call",
      params: {
        name: "get_chart_data",
        arguments: {
          realm: "Jobs",
          group_by: "resource",
          statistic: "job_count",
          start_date: "2026-08-01",
          end_date: "2026-10-31",
          dataset_type: "timeseries",
          aggregation_unit: "Month",
        },
      },
    })) as { content: { text: string }[]; structuredContent?: { chart: ChartPayload } };

    expect(result.content[0].text).toMatch(/^Chart Data for/);
    expect(result.structuredContent!.chart.data_through).toBe("2026-10-01");
    expect(result.structuredContent!.chart.data_through_precision).toBe("period");
  });

  test("starts beside the chart request", async () => {
    let releaseChart!: (r: Response) => void;
    const x = [1785556800000, 1788235200000, 1790827200000];
    mockFetch
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (releaseChart = resolve)))
      .mockResolvedValueOnce(probeResponse([5, 6, 7, 8]));
    const pending = probeServer["handleToolCall"]({
      method: "tools/call",
      params: {
        name: "get_chart_data",
        arguments: {
          realm: "Jobs",
          group_by: "resource",
          statistic: "job_count",
          start_date: "2026-08-01",
          end_date: "2026-10-31",
          dataset_type: "timeseries",
          aggregation_unit: "Month",
        },
      },
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect((mockFetch.mock.calls[1][1].body as URLSearchParams).get("aggregation_unit")).toBe("Day");
    releaseChart(
      mockResponse({ success: true, data: [{ hc_jsonstore: { data: [{ name: "A", x, y: [1, 2, 3] }] } }] })
    );
    await pending;
  });

  test("concurrent cold calls share one probe request", async () => {
    let release!: (r: Response) => void;
    mockFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)));
    const first = probeServer["latestDataDay"]("Jobs");
    const second = probeServer["latestDataDay"]("Jobs");
    release(probeResponse([5, 6, 7, 0]));

    expect(await first).toBe("2026-09-30");
    expect(await second).toBe("2026-09-30");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("skips realms it has no count statistic for", async () => {
    expect(await probeServer["latestDataDay"]("Storage")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("get_chart_data still answers when the probe fails", async () => {
    const x = [1785556800000, 1788235200000, 1790827200000];
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({ success: true, data: [{ hc_jsonstore: { data: [{ name: "A", x, y: [1, 2, 3] }] } }] })
      )
      .mockRejectedValueOnce(new Error("probe down"));
    const result = (await probeServer["handleToolCall"]({
      method: "tools/call",
      params: {
        name: "get_chart_data",
        arguments: {
          realm: "Jobs",
          group_by: "resource",
          statistic: "job_count",
          start_date: "2026-08-01",
          end_date: "2026-10-31",
          dataset_type: "timeseries",
          aggregation_unit: "Month",
        },
      },
    })) as { content: { text: string }[]; structuredContent?: { chart: ChartPayload } };

    expect(result.content[0].text).toMatch(/^Chart Data for/);
    expect(result.structuredContent!.chart.data_through).toBe("2026-10-01");
  });

  test("a probe day inside the last period puts the note in the text", async () => {
    const x = [1785556800000, 1788235200000, 1790827200000];
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({ success: true, data: [{ hc_jsonstore: { data: [{ name: "A", x, y: [12, 11, 0.05] }] } }] })
      )
      .mockResolvedValueOnce(probeResponse([5, 6, 7, 8]));
    const result = (await probeServer["handleToolCall"]({
      method: "tools/call",
      params: {
        name: "get_chart_data",
        arguments: {
          realm: "Jobs",
          group_by: "resource",
          statistic: "job_count",
          start_date: "2026-08-01",
          end_date: "2026-10-31",
          dataset_type: "timeseries",
          aggregation_unit: "Month",
        },
      },
    })) as { content: { text: string }[]; structuredContent?: { chart: ChartPayload } };

    expect(result.structuredContent!.chart.last_data_period_partial).toBe(true);
    expect(result.content[0].text).toContain(
      "XDMoD has data only through Oct 1, 2026, so the Oct 2026 value may cover only part of that period. Don't read it as a change."
    );
  });
});
