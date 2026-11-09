import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

// Mock fetch globally
const mockFetch = vi.fn();
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
const { XDMoDMetricsServer } = await import("../index.js");

describe("XDMoDMetricsServer", () => {
  let server: InstanceType<typeof XDMoDMetricsServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new XDMoDMetricsServer();
    // Clear the menu cache between tests
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).menuCache = null;
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
      expect(text).toContain("1. gpuA100x4: avg 21.0000 (3 data points)");
      expect(text).toContain("2. cpu: avg 9.5000 (3 data points)");
      expect(text).not.toContain("gap connector");
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
        expect(text).toContain("- NCSA DELTA GPU: avg 6295832.8250 (2 data points)");
        expect(text).toContain("  - 2026-08-01: 5966498.9200\n  - 2026-10-01: 6625166.7300\n");
        expect(text).not.toContain("2026-09-01");
      });

      test("leaves the unit to XDMoD when it is omitted", async () => {
        mockFetch.mockResolvedValueOnce(timeseries([1, 2, 3]));
        const text = getText(await chartData());

        expect(sentBody().has("aggregation_unit")).toBe(false);
        expect(text).toContain("(2026-08-01 to 2026-10-31):");
        expect(text).toContain("  - 2026-09-01: 2.0000");
      });

      test("summarizes a series too long to list", async () => {
        const days = Array.from({ length: 61 }, (_, i) => monthStarts[0] + i * 86_400_000);
        mockFetch.mockResolvedValueOnce(timeseries(days.map(() => 1), days));
        const text = getText(await chartData({ aggregation_unit: "Day" }));

        expect(text).toContain("- NCSA DELTA GPU: avg 1.0000 (61 data points)");
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

        expect(text.match(/^  - /gm)).toHaveLength(300);
        expect(text).toContain("- R5: avg 1.0000 (60 data points)");
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
