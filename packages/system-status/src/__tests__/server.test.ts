import { describe, it, expect, beforeEach, vi, afterEach, Mock } from "vitest";
import { SystemStatusServer } from "../server.js";
import { assertFiltersAppliedShape } from "@access-mcp/shared/testkit/filters-applied";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

interface MockHttpClient {
  get: Mock<(url: string) => Promise<{ status: number; statusText?: string; data: unknown }>>;
}

interface TextContent {
  type: "text";
  text: string;
}

// Mock axios
vi.mock("axios");

describe("SystemStatusServer", () => {
  let server: SystemStatusServer;
  let mockHttpClient: MockHttpClient;

  const mockCurrentOutagesData = [
    {
      id: "1",
      Subject: "Emergency maintenance on Anvil",
      Content: "Critical issue requiring immediate attention",
      OutageStart: "2024-08-27T10:00:00Z",
      OutageEnd: "2024-08-27T11:00:00Z",
      OutageType: "Full",
      AffectedResources: [{ ResourceName: "Anvil", ResourceID: "anvil-1.purdue.access-ci.org" }],
    },
    {
      id: "2",
      Subject: "Scheduled maintenance on Bridges-2",
      Content: "Regular maintenance window",
      OutageStart: "2024-08-27T08:00:00Z",
      OutageEnd: "2024-08-27T08:30:00Z",
      OutageType: "Partial",
      AffectedResources: [{ ResourceName: "Bridges-2", ResourceID: "bridges2.psc.access-ci.org" }],
    },
  ];

  const mockFutureOutagesData = [
    {
      id: "3",
      Subject: "Scheduled Jetstream maintenance",
      Content: "Planned maintenance",
      OutageStart: "2024-08-30T10:00:00Z",
      OutageEnd: "2024-08-30T14:00:00Z",
      AffectedResources: [{ ResourceName: "Jetstream", ResourceID: "jetstream-1" }],
    },
  ];

  const mockPastOutagesData = [
    {
      id: "4",
      Subject: "Past maintenance on Stampede3",
      Content: "Completed maintenance",
      OutageStart: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
      OutageEnd: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000).toISOString(), // 3 days ago + 6 hours
      OutageType: "Full",
      AffectedResources: [{ ResourceName: "Stampede3", ResourceID: "stampede3-1" }],
    },
  ];

  beforeEach(() => {
    server = new SystemStatusServer();

    // Set up mock HTTP client
    mockHttpClient = {
      get: vi.fn(),
    };

    // Override the httpClient getter
    Object.defineProperty(server, "httpClient", {
      get: () => mockHttpClient,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Server Initialization", () => {
    it("should initialize with correct server info", () => {
      expect(server).toBeDefined();
      expect(server["serverName"]).toBe("access-mcp-system-status");
      expect(server["version"]).toBe(version);
      expect(server["baseURL"]).toBe("https://operations-api.access-ci.org");
    });

    it("should provide correct tools", () => {
      const tools = server["getTools"]();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("get_infrastructure_news");
    });

    it("should provide correct resources", () => {
      const resources = server["getResources"]();
      expect(resources).toHaveLength(4);
      expect(resources.map((r) => r.uri)).toEqual([
        "accessci://system-status",
        "accessci://outages/current",
        "accessci://outages/scheduled",
        "accessci://outages/past",
      ]);
    });
  });

  describe("getCurrentOutages", () => {
    it("should fetch and enhance current outages", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: mockCurrentOutagesData },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "current" } },
      });

      expect(mockHttpClient.get).toHaveBeenCalledWith(
        "/wh2/news/v1/affiliation/access-ci.org/current_outages/"
      );

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.total).toBe(2);
      expect(response.metadata.aggregations.affected_resources).toEqual(["Anvil", "Bridges-2"]);
      expect(response.metadata.aggregations.severity_counts).toHaveProperty("high", 1); // Emergency
      expect(response.metadata.aggregations.severity_counts).toHaveProperty("low", 1); // Scheduled maintenance
      expect(response.items[0]).toHaveProperty("severity");
      expect(response.documentation.links.see_all_url).toBe("https://operations.access-ci.org/infrastructure_news_view");
    });

    it("should filter outages by resource", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: mockCurrentOutagesData },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { resource: "Anvil", time: "current" },
        },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.total).toBe(1);
      expect(response.items[0].Subject).toContain("Anvil");
    });

    it("should filter outages by outage_type", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: mockCurrentOutagesData },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { outage_type: "Full", time: "current" },
        },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.total).toBe(1);
      expect(response.items[0].OutageType).toBe("Full");
      expect(response.items[0].Subject).toContain("Anvil");
    });

    it("should filter by both resource and outage_type", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: mockCurrentOutagesData },
      });

      // Filter for Partial outages on Bridges-2
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { resource: "Bridges", outage_type: "Partial", time: "current" },
        },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.total).toBe(1);
      expect(response.items[0].OutageType).toBe("Partial");
    });

    it("should return empty when outage_type filter matches nothing", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: mockCurrentOutagesData },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { outage_type: "Degraded", time: "current" },
        },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.total).toBe(0);
      expect(response.items).toHaveLength(0);
    });

    it("should categorize severity correctly", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: mockCurrentOutagesData },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "current" } },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      const emergencyOutage = response.items.find((o: { Subject: string }) =>
        o.Subject.includes("Emergency")
      );
      const maintenanceOutage = response.items.find((o: { Subject: string }) =>
        o.Subject.includes("Scheduled")
      );

      expect(emergencyOutage.severity).toBe("high");
      expect(maintenanceOutage.severity).toBe("low");
    });

    it("returns all active outages by default (no hidden outages)", async () => {
      const manyOutages = Array(8)
        .fill(0)
        .map((_, i) => ({
          ...mockCurrentOutagesData[0],
          id: `current-${i}`,
          Subject: `Current outage ${i}`,
        }));

      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: manyOutages },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "current" } },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.items).toHaveLength(8);
      expect(response.metadata.pagination.total).toBe(8);
      expect(response.metadata.pagination.has_more).toBe(false);
    });

    it("emits honest pagination metadata (not result-length as limit)", async () => {
      const manyOutages = Array(8)
        .fill(0)
        .map((_, i) => ({
          ...mockCurrentOutagesData[0],
          id: `current-${i}`,
          Subject: `Current outage ${i}`,
        }));

      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: manyOutages },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "current" } },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.metadata.pagination.limit).not.toBe(8);
      expect(response.metadata.pagination.limit).toBe(500);
      expect(response.metadata.pagination.offset).toBe(0);
      expect(response.metadata.pagination.total).toBe(8);
      expect(response.metadata.pagination.has_more).toBe(false);
    });

    it("honors an explicit small limit + offset", async () => {
      const manyOutages = Array(8)
        .fill(0)
        .map((_, i) => ({
          ...mockCurrentOutagesData[0],
          id: `current-${i}`,
          Subject: `Current outage ${i}`,
        }));

      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: manyOutages },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "current", limit: 3, offset: 3 },
        },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.items).toHaveLength(3);
      expect(response.items[0].Subject).toBe("Current outage 3");
      expect(response.items[2].Subject).toBe("Current outage 5");
      expect(response.metadata.pagination.total).toBe(8);
      expect(response.metadata.pagination.has_more).toBe(true);
    });
  });

  describe("getScheduledMaintenance", () => {
    it("should fetch and enhance scheduled maintenance", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: mockFutureOutagesData },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "scheduled" } },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.total).toBe(1);
      expect(response.metadata.aggregations.affected_resources).toEqual(["Jetstream"]);
      expect(response.items[0]).toHaveProperty("hours_until_start");
      expect(response.items[0]).toHaveProperty("duration_hours", 4); // 10am to 2pm = 4 hours
      expect(response.items[0]).toHaveProperty("has_scheduled_time", true);
    });

    it("should handle missing scheduled times", async () => {
      const dataWithoutSchedule = [
        {
          ...mockFutureOutagesData[0],
          OutageStart: null,
          OutageEnd: null,
        },
      ];

      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: dataWithoutSchedule },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "scheduled" } },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.items[0].has_scheduled_time).toBe(false);
      expect(response.items[0].duration_hours).toBe(null);
    });

    it("should sort by scheduled start time", async () => {
      const multipleMaintenanceData = [
        {
          ...mockFutureOutagesData[0],
          OutageStart: "2024-08-31T10:00:00Z", // Later
          Subject: "Later maintenance",
        },
        {
          ...mockFutureOutagesData[0],
          OutageStart: "2024-08-30T10:00:00Z", // Earlier
          Subject: "Earlier maintenance",
        },
      ];

      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: multipleMaintenanceData },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "scheduled" } },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.items[0].Subject).toBe("Earlier maintenance");
      expect(response.items[1].Subject).toBe("Later maintenance");
    });

    it("returns all scheduled maintenance by default with honest pagination", async () => {
      const manyMaintenance = Array(8)
        .fill(0)
        .map((_, i) => ({
          ...mockFutureOutagesData[0],
          id: `future-${i}`,
          Subject: `Future maintenance ${i}`,
          OutageStart: `2024-08-3${i % 1}T10:00:00Z`,
        }));

      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: manyMaintenance },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "scheduled" } },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.items).toHaveLength(8);
      expect(response.metadata.pagination.limit).toBe(500);
      expect(response.metadata.pagination.offset).toBe(0);
      expect(response.metadata.pagination.total).toBe(8);
      expect(response.metadata.pagination.has_more).toBe(false);
    });

    it("honors an explicit small limit + offset on scheduled maintenance", async () => {
      const manyMaintenance = Array(8)
        .fill(0)
        .map((_, i) => ({
          ...mockFutureOutagesData[0],
          id: `future-${i}`,
          Subject: `Future maintenance ${i}`,
          OutageStart: new Date(Date.now() + (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
        }));

      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: manyMaintenance },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "scheduled", limit: 3, offset: 3 },
        },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.items).toHaveLength(3);
      expect(response.items[0].Subject).toBe("Future maintenance 3");
      expect(response.items[2].Subject).toBe("Future maintenance 5");
      expect(response.metadata.pagination.total).toBe(8);
      expect(response.metadata.pagination.has_more).toBe(true);
    });
  });

  describe("getPastOutages", () => {
    it("should fetch and enhance past outages", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: mockPastOutagesData },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "past" } },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.total).toBe(1);
      expect(response.metadata.aggregations.outage_types).toEqual(["Full"]);
      expect(response.metadata.aggregations.average_duration_hours).toBe(6); // 6 hour duration
      expect(response.items[0]).toHaveProperty("duration_hours", 6);
      expect(response.items[0]).toHaveProperty("days_ago");
    });

    it("should apply limit correctly", async () => {
      const manyOutages = Array(50)
        .fill(0)
        .map((_, i) => ({
          ...mockPastOutagesData[0],
          id: `past-${i}`,
          Subject: `Past outage ${i}`,
        }));

      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: manyOutages },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "past", limit: 10 },
        },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.items).toHaveLength(10);
    });

    it("honors offset with a true full-count total", async () => {
      const manyOutages = Array(25)
        .fill(0)
        .map((_, i) => ({
          ...mockPastOutagesData[0],
          id: `past-${i}`,
          Subject: `Past outage ${i}`,
          OutageEnd: new Date(Date.now() - (i + 3) * 24 * 60 * 60 * 1000).toISOString(),
        }));

      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: manyOutages },
      });

      const page0Result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "past", limit: 10, offset: 0 },
        },
      });
      const page0 = JSON.parse((page0Result.content[0] as TextContent).text);

      const page1Result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "past", limit: 10, offset: 10 },
        },
      });
      const page1 = JSON.parse((page1Result.content[0] as TextContent).text);

      expect(page0.metadata.pagination.offset).toBe(0);
      expect(page1.metadata.pagination.offset).toBe(10);
      expect(page1.items[0].Subject).not.toEqual(page0.items[0].Subject);
      expect(page0.metadata.pagination.total).toBe(25); // true full count, not sliced
      expect(page0.metadata.pagination.has_more).toBe(true);
      expect(page0.metadata.pagination.limit).toBe(10);
    });
  });

  describe("getSystemAnnouncements", () => {
    it("should combine current, future, and recent past outages", async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: { results: mockCurrentOutagesData } })
        .mockResolvedValueOnce({ status: 200, data: { results: mockFutureOutagesData } })
        .mockResolvedValueOnce({ status: 200, data: { results: mockPastOutagesData } });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "all" } },
      });

      expect(mockHttpClient.get).toHaveBeenCalledTimes(3);

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.metadata.aggregations.current_outages).toBe(2);
      expect(response.metadata.aggregations.scheduled_maintenance).toBe(1);
      expect(response.metadata.aggregations.recent_past_outages).toBe(1); // Within 30 days
      expect(response.metadata.aggregations.categories).toHaveProperty("current");
      expect(response.metadata.aggregations.categories).toHaveProperty("scheduled");
      expect(response.metadata.aggregations.categories).toHaveProperty("recent_past");
    });

    it("should prioritize current outages in sorting", async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: { results: mockCurrentOutagesData } })
        .mockResolvedValueOnce({ status: 200, data: { results: mockFutureOutagesData } })
        .mockResolvedValueOnce({ status: 200, data: { results: mockPastOutagesData } });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "all" } },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      const firstAnnouncement = response.items[0];
      expect(firstAnnouncement.category).toBe("current");
    });

    it("honors offset and total is the full assembled count", async () => {
      const manyCurrent = Array(5)
        .fill(0)
        .map((_, i) => ({
          ...mockCurrentOutagesData[0],
          id: `cur-${i}`,
          Subject: `Current outage ${i}`,
        }));
      const manyFuture = Array(5)
        .fill(0)
        .map((_, i) => ({
          ...mockFutureOutagesData[0],
          id: `fut-${i}`,
          Subject: `Future outage ${i}`,
          OutageStart: new Date(Date.now() + (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
        }));
      const manyPast = Array(5)
        .fill(0)
        .map((_, i) => ({
          ...mockPastOutagesData[0],
          id: `past-${i}`,
          Subject: `Past outage ${i}`,
          OutageEnd: new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
        }));

      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: { results: manyCurrent } })
        .mockResolvedValueOnce({ status: 200, data: { results: manyFuture } })
        .mockResolvedValueOnce({ status: 200, data: { results: manyPast } });

      const page0Result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "all", limit: 5, offset: 0 },
        },
      });
      const page0 = JSON.parse((page0Result.content[0] as TextContent).text);

      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: { results: manyCurrent } })
        .mockResolvedValueOnce({ status: 200, data: { results: manyFuture } })
        .mockResolvedValueOnce({ status: 200, data: { results: manyPast } });

      const page1Result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "all", limit: 5, offset: 5 },
        },
      });
      const page1 = JSON.parse((page1Result.content[0] as TextContent).text);

      expect(page0.metadata.pagination.offset).toBe(0);
      expect(page1.metadata.pagination.offset).toBe(5);
      expect(page0.items).not.toEqual(page1.items);
      // full assembled count (5 current + 5 future + 5 recent past), not the page size
      expect(page0.metadata.pagination.total).toBe(15);
      expect(page0.metadata.pagination.has_more).toBe(true);
    });

    it("categories aggregation reflects the full set, not the returned page", async () => {
      // Full set: 3 current, 1 scheduled, 1 recent_past = 5 total.
      // A page of limit:2 (offset 0) would only see 2 "current" items if it
      // read the sliced page instead of the full assembled list.
      const threeCurrent = Array(3)
        .fill(0)
        .map((_, i) => ({
          ...mockCurrentOutagesData[0],
          id: `cur-${i}`,
          Subject: `Current outage ${i}`,
        }));

      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: { results: threeCurrent } })
        .mockResolvedValueOnce({ status: 200, data: { results: mockFutureOutagesData } })
        .mockResolvedValueOnce({ status: 200, data: { results: mockPastOutagesData } });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "all", limit: 2, offset: 0 },
        },
      });
      const response = JSON.parse((result.content[0] as TextContent).text);

      expect(response.items).toHaveLength(2); // page is small
      // but categories + total describe the FULL set (3 current, 1 scheduled, 1 recent_past)
      expect(response.metadata.pagination.total).toBe(5);
      expect(response.metadata.aggregations.categories.current).toBe(3);
      expect(response.metadata.aggregations.categories.scheduled).toBe(1);
      expect(response.metadata.aggregations.categories.recent_past).toBe(1);
    });

    it("honors the resource filter, keeping total and aggregations consistent with items", async () => {
      // current: 2 Delta + 3 Bridges2 = 5; future: 1 Delta; past (within 30d): 1 Delta.
      // Unfiltered total would be 7; filtered by "Delta" should be 4.
      const currentDelta = Array(2)
        .fill(0)
        .map((_, i) => ({
          ...mockCurrentOutagesData[0],
          id: `cur-delta-${i}`,
          Subject: `Current outage on Delta ${i}`,
          AffectedResources: [{ ResourceName: "Delta", ResourceID: `delta-${i}` }],
        }));
      const currentBridges2 = Array(3)
        .fill(0)
        .map((_, i) => ({
          ...mockCurrentOutagesData[0],
          id: `cur-bridges2-${i}`,
          Subject: `Current outage on Bridges2 ${i}`,
          AffectedResources: [{ ResourceName: "Bridges2", ResourceID: `bridges2-${i}` }],
        }));
      const currentMixed = [...currentDelta, ...currentBridges2];

      const futureDelta = [
        {
          ...mockFutureOutagesData[0],
          id: "fut-delta-0",
          Subject: "Future outage on Delta",
          AffectedResources: [{ ResourceName: "Delta", ResourceID: "delta-fut-0" }],
        },
      ];

      const pastDelta = [
        {
          ...mockPastOutagesData[0],
          id: "past-delta-0",
          Subject: "Past outage on Delta",
          OutageEnd: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // within 30 days
          AffectedResources: [{ ResourceName: "Delta", ResourceID: "delta-past-0" }],
        },
      ];

      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: { results: currentMixed } })
        .mockResolvedValueOnce({ status: 200, data: { results: futureDelta } })
        .mockResolvedValueOnce({ status: 200, data: { results: pastDelta } });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { resource: "Delta", time: "all" },
        },
      });
      const response = JSON.parse((result.content[0] as TextContent).text);

      expect(mockHttpClient.get).toHaveBeenCalledTimes(3);

      // items: all reference Delta
      expect(response.items).toHaveLength(4);
      for (const item of response.items) {
        expect(
          item.AffectedResources?.some((r: { ResourceName?: string }) =>
            r.ResourceName?.toLowerCase().includes("delta")
          )
        ).toBe(true);
      }

      // total must reflect the FILTERED set (4), not the unfiltered 7.
      expect(response.total).toBe(4);

      // per-category aggregations must also reflect the filtered set, not the
      // unfiltered arrays -- this is what catches a late (fullSorted-only) filter.
      expect(response.metadata.aggregations.current_outages).toBe(2);
      expect(response.metadata.aggregations.scheduled_maintenance).toBe(1);
      expect(response.metadata.aggregations.recent_past_outages).toBe(1);
      expect(response.metadata.aggregations.categories.current).toBe(2);
      expect(response.metadata.aggregations.categories.scheduled).toBe(1);
      expect(response.metadata.aggregations.categories.recent_past).toBe(1);
    });

    it("matches the resource filter via Subject, same as the sibling handlers, even when AffectedResources doesn't match", async () => {
      // This outage's AffectedResources does NOT mention "Delta" -- it only
      // matches via Subject, exactly like getCurrentOutages/getScheduledMaintenance/
      // getPastOutages do. Should still be included when filtering by "Delta".
      const subjectOnlyMatch = {
        ...mockCurrentOutagesData[0],
        id: "cur-subject-only",
        Subject: "Emergency maintenance affecting Delta users",
        AffectedResources: [{ ResourceName: "Bridges2", ResourceID: "bridges2-x" }],
      };

      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: { results: [subjectOnlyMatch] } })
        .mockResolvedValueOnce({ status: 200, data: { results: [] } })
        .mockResolvedValueOnce({ status: 200, data: { results: [] } });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { resource: "Delta", time: "all" },
        },
      });
      const response = JSON.parse((result.content[0] as TextContent).text);

      expect(response.items).toHaveLength(1);
      expect(response.items[0].id).toBe("cur-subject-only");
      expect(response.total).toBe(1);
      expect(response.metadata.aggregations.current_outages).toBe(1);
    });

    it("returns the unfiltered baseline count when no resource is given", async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: { results: mockCurrentOutagesData } })
        .mockResolvedValueOnce({ status: 200, data: { results: mockFutureOutagesData } })
        .mockResolvedValueOnce({ status: 200, data: { results: mockPastOutagesData } });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "all" } },
      });
      const response = JSON.parse((result.content[0] as TextContent).text);

      expect(response.total).toBe(4); // 2 current + 1 scheduled + 1 recent past
      expect(response.metadata.aggregations.current_outages).toBe(2);
      expect(response.metadata.aggregations.scheduled_maintenance).toBe(1);
      expect(response.metadata.aggregations.recent_past_outages).toBe(1);
    });

    it("returns empty items/total/aggregations for a resource with no matches, without error", async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: { results: mockCurrentOutagesData } })
        .mockResolvedValueOnce({ status: 200, data: { results: mockFutureOutagesData } })
        .mockResolvedValueOnce({ status: 200, data: { results: mockPastOutagesData } });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { resource: "Nonexistent", time: "all" },
        },
      });
      const response = JSON.parse((result.content[0] as TextContent).text);

      expect(response.items).toEqual([]);
      expect(response.total).toBe(0);
      expect(response.metadata.aggregations.current_outages).toBe(0);
      expect(response.metadata.aggregations.scheduled_maintenance).toBe(0);
      expect(response.metadata.aggregations.recent_past_outages).toBe(0);
      expect(response.metadata.aggregations.categories.current).toBe(0);
      expect(response.metadata.aggregations.categories.scheduled).toBe(0);
      expect(response.metadata.aggregations.categories.recent_past).toBe(0);
    });
  });

  describe("checkResourceStatus", () => {
    it("should check resource status using group API", async () => {
      // Mock group API responses for each resource
      const now = new Date();
      const activeOutage = {
        Subject: "Current outage on Anvil",
        OutageStart: new Date(now.getTime() - 3600000).toISOString(), // 1 hour ago
        OutageEnd: null, // Still active
        OutageType: "Full",
      };

      mockHttpClient.get
        .mockResolvedValueOnce({
          status: 200,
          data: { results: [activeOutage] }, // anvil has active outage
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { results: [] }, // unknown resource has no outages
        });

      // Use full IDs with dots to skip resolution lookup
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { ids: ["anvil.purdue.access-ci.org", "unknown.resource.org"] },
        },
      });

      expect(mockHttpClient.get).toHaveBeenCalledWith(
        "/wh2/news/v1/info_groupid/anvil.purdue.access-ci.org/"
      );
      expect(mockHttpClient.get).toHaveBeenCalledWith(
        "/wh2/news/v1/info_groupid/unknown.resource.org/"
      );

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.total).toBe(2);
      expect(response.metadata.aggregations.counts.operational).toBe(1); // unknown.resource.org
      expect(response.metadata.aggregations.counts.affected).toBe(1); // anvil.purdue.access-ci.org

      const anvilStatus = response.items.find(
        (r: { resource_id: string }) => r.resource_id === "anvil.purdue.access-ci.org"
      );
      expect(anvilStatus.status).toBe("affected");
      expect(anvilStatus.severity).toBe("high"); // Full outage = high
      expect(anvilStatus.outage_details[0].outage_type).toBe("Full");
    });

    it("should handle group API failures gracefully", async () => {
      mockHttpClient.get.mockRejectedValue(new Error("API Error"));

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { ids: ["failing.resource.org"] },
        },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.metadata.aggregations.counts.unknown).toBe(1);
      expect(response.items[0].status).toBe("unknown");
      expect(response.items[0]).toHaveProperty("error");
    });

    it("should resolve human-readable name to resource ID", async () => {
      // First call: resource search for name resolution
      // Second call: group API for the resolved resource ID
      mockHttpClient.get
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: {
              active_groups: [
                { info_groupid: "anvil.purdue.access-ci.org", group_descriptive_name: "Anvil" },
              ],
            },
          },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { results: [] }, // No outages from group API
        });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { ids: ["Anvil"] },
        },
      });

      // Should have called resource search first, then group API
      expect(mockHttpClient.get).toHaveBeenCalledWith(
        "/wh2/cider/v1/access-active-groups/type/resource-catalog.access-ci.org/"
      );
      expect(mockHttpClient.get).toHaveBeenCalledWith(
        "/wh2/news/v1/info_groupid/anvil.purdue.access-ci.org/"
      );

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.total).toBe(1);
      expect(response.items[0].resource_id).toBe("anvil.purdue.access-ci.org");
      expect(response.items[0].status).toBe("operational"); // No current outages
    });

    it("should return error when resource name is ambiguous", async () => {
      mockHttpClient.get.mockResolvedValueOnce({
        status: 200,
        data: {
          results: {
            active_groups: [
              {
                info_groupid: "stampede2.tacc.access-ci.org",
                group_descriptive_name: "Stampede 2",
              },
              {
                info_groupid: "stampede3.tacc.access-ci.org",
                group_descriptive_name: "Stampede 3",
              },
            ],
          },
        },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { ids: ["Stampede"] },
        },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.error).toContain("Could not resolve");
      expect(response.resolution_errors[0].error).toContain("Multiple resources match");
    });
  });

  describe("Error Handling", () => {
    it("should handle API errors gracefully", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 500,
        statusText: "Internal Server Error",
        data: null,
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "current" } },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.error).toBeDefined();
    });

    it("should handle network errors", async () => {
      mockHttpClient.get.mockRejectedValue(new Error("Network error"));

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "current" } },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.error.message).toBe("Network error");
    });

    it("should handle unknown tools", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "unknown_tool", arguments: {} },
      });

      const content = result.content[0] as TextContent;
      expect(content.text).toContain("Unknown tool");
    });
  });

  describe("Resource Handling", () => {
    it("should handle resource reads correctly", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: mockCurrentOutagesData },
      });

      const result = await server["handleResourceRead"]({
        method: "resources/read",
        params: { uri: "accessci://outages/current" },
      });

      expect(result.contents[0].mimeType).toBe("application/json");
      expect("text" in result.contents[0] && result.contents[0].text).toBeDefined();
    });

    it("should handle unknown resources", async () => {
      await expect(async () => {
        await server["handleResourceRead"]({
          method: "resources/read",
          params: { uri: "accessci://unknown" },
        });
      }).rejects.toThrow("Unknown resource");
    });
  });

  describe("fields projection (Pillar 2)", () => {
    it("should project current outages response to requested fields only", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: mockCurrentOutagesData },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "current", fields: ["total", "items[].Subject"] },
        },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.total).toBe(2);
      expect(Object.keys(response.items[0])).toEqual(["Subject"]);
      expect(response.items[0].Subject).toContain("Anvil");
      // metadata + documentation are sticky containers — preserved on projection.
      expect(response.metadata).toBeDefined();
      expect(response.documentation).toBeDefined();
    });

    it("should always preserve total even when fields omits it", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: mockCurrentOutagesData },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: {
            time: "current",
            fields: ["metadata.aggregations.severity_counts"],
          },
        },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.total).toBe(2);
      expect(response.metadata.aggregations.severity_counts).toBeDefined();
      expect(response.items).toBeUndefined();
    });

    it("should project past outages response (second handler path)", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: mockPastOutagesData },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "past", fields: ["total", "items[].Subject"] },
        },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.total).toBe(1);
      expect(Object.keys(response.items[0])).toEqual(["Subject"]);
      expect(response.items[0].Subject).toContain("Stampede3");
    });

    it("should advertise fields parameter and supportsFieldProjection on the tool", () => {
      const tools = server["getTools"]();
      const tool = tools.find((t: { name: string }) => t.name === "get_infrastructure_news");

      expect(tool?.inputSchema.properties?.fields).toBeDefined();
      expect((tool as { _meta?: { supportsFieldProjection?: boolean } })._meta?.supportsFieldProjection).toBe(true);
    });
  });

  describe("adversarial input handling", () => {
    it("time=past coerces a negative offset forward to 0", async () => {
      const manyOutages = Array(25)
        .fill(0)
        .map((_, i) => ({
          ...mockPastOutagesData[0],
          id: `past-${i}`,
          Subject: `Past outage ${i}`,
          OutageEnd: new Date(Date.now() - (i + 3) * 24 * 60 * 60 * 1000).toISOString(),
        }));

      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: manyOutages },
      });

      const negativeResult = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "past", limit: 10, offset: -3 },
        },
      });
      const negative = JSON.parse((negativeResult.content[0] as TextContent).text);

      const zeroResult = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "past", limit: 10, offset: 0 },
        },
      });
      const zero = JSON.parse((zeroResult.content[0] as TextContent).text);

      expect(negative.metadata.pagination.offset).toBe(0);
      expect(negative.items[0].Subject).toEqual(zero.items[0].Subject);
      expect(negative.items[0].Subject).not.toEqual(
        manyOutages[manyOutages.length - 1].Subject
      );
    });

    it("time=current coerces a negative offset forward to 0", async () => {
      const manyCurrent = Array(8)
        .fill(0)
        .map((_, i) => ({
          ...mockCurrentOutagesData[0],
          id: `cur-${i}`,
          Subject: `Current outage ${i}`,
        }));

      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: manyCurrent },
      });

      const negativeResult = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "current", limit: 3, offset: -5 },
        },
      });
      const negative = JSON.parse((negativeResult.content[0] as TextContent).text);

      const zeroResult = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "current", limit: 3, offset: 0 },
        },
      });
      const zero = JSON.parse((zeroResult.content[0] as TextContent).text);

      expect(negative.metadata.pagination.offset).toBe(0);
      expect(negative.items[0].Subject).toEqual(zero.items[0].Subject);
      expect(negative.items[0].Subject).not.toEqual(manyCurrent[manyCurrent.length - 1].Subject);
    });

    it("time=past rejects limit:0 with the nested error envelope", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: mockPastOutagesData },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "past", limit: 0 },
        },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.status).toBe("error");
      expect(response.executed).toBe(false);
      expect(response.error.message).toBe("Limit must be at least 1");
      expect(result.isError).toBe(true);
    });

    it("time=current rejects limit:0 with the nested error envelope", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: mockCurrentOutagesData },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "current", limit: 0 },
        },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.status).toBe("error");
      expect(response.executed).toBe(false);
      expect(response.error.message).toBe("Limit must be at least 1");
      expect(result.isError).toBe(true);
    });
  });

  describe("Tier-A conformance", () => {
    it("get_infrastructure_news declares limit and offset in its schema", () => {
      const tools = server["getTools"]();
      const tool = tools.find((t: { name: string }) => t.name === "get_infrastructure_news");

      expect(tool?.inputSchema.properties?.limit).toBeDefined();
      expect(tool?.inputSchema.properties?.offset).toBeDefined();
    });

    it("clamps a limit above MAX_LIMIT to 500 with capped:true", async () => {
      const manyOutages = Array(600)
        .fill(0)
        .map((_, i) => ({
          ...mockPastOutagesData[0],
          id: `past-${i}`,
          Subject: `Past outage ${i}`,
          OutageEnd: new Date(Date.now() - (i + 3) * 24 * 60 * 60 * 1000).toISOString(),
        }));

      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { results: manyOutages },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "past", limit: 600 },
        },
      });

      const content = result.content[0] as TextContent;
      const response = JSON.parse(content.text);
      expect(response.items).toHaveLength(500);
      expect(response.metadata.pagination.limit).toBe(500);
      expect(response.metadata.pagination.capped).toBe(true);
      expect(response.metadata.pagination.total).toBe(600);
    });
  });

  describe("filters_applied disclosure (Phase 4b)", () => {
    const EXPECTED_KEYS = ["resource", "outage_type"];

    // All four time-routed branches must be stubbed the same way each test
    // uses them: current/scheduled/past hit a single endpoint; "all" fans
    // out to all three (per #83's getSystemAnnouncements convention above).
    function mockSingleEndpoint(results: unknown[]) {
      mockHttpClient.get.mockResolvedValue({ status: 200, data: { results } });
    }

    function mockAllBranchEndpoints() {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: { results: mockCurrentOutagesData } })
        .mockResolvedValueOnce({ status: 200, data: { results: mockFutureOutagesData } })
        .mockResolvedValueOnce({ status: 200, data: { results: mockPastOutagesData } });
    }

    it("time=current: conforms to the canonical two-key shape", async () => {
      mockSingleEndpoint(mockCurrentOutagesData);

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "current" } },
      });

      assertFiltersAppliedShape(result, EXPECTED_KEYS, expect);
    });

    it("time=scheduled: conforms to the canonical two-key shape", async () => {
      mockSingleEndpoint(mockFutureOutagesData);

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "scheduled" } },
      });

      assertFiltersAppliedShape(result, EXPECTED_KEYS, expect);
    });

    it("time=past: conforms to the canonical two-key shape", async () => {
      mockSingleEndpoint(mockPastOutagesData);

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "past" } },
      });

      assertFiltersAppliedShape(result, EXPECTED_KEYS, expect);
    });

    it("time=all: conforms to the canonical two-key shape", async () => {
      mockAllBranchEndpoints();

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "all" } },
      });

      assertFiltersAppliedShape(result, EXPECTED_KEYS, expect);
    });

    it("time=current discloses resource and outage_type as applied", async () => {
      mockSingleEndpoint(mockCurrentOutagesData);

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "current", resource: "Anvil", outage_type: "Full" },
        },
      });

      const response = JSON.parse((result.content[0] as TextContent).text);
      expect(response.metadata.filters_applied).toEqual({
        resource: "Anvil",
        outage_type: "Full",
      });
    });

    it("time=current with no filters discloses both keys as null", async () => {
      mockSingleEndpoint(mockCurrentOutagesData);

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "current" } },
      });

      const response = JSON.parse((result.content[0] as TextContent).text);
      expect(response.metadata.filters_applied).toEqual({
        resource: null,
        outage_type: null,
      });
    });

    it("time=all discloses resource and outage_type as applied (post-#83, the all branch applies both)", async () => {
      mockAllBranchEndpoints();

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "all", resource: "Bridges-2", outage_type: "Partial" },
        },
      });

      const response = JSON.parse((result.content[0] as TextContent).text);
      expect(response.metadata.filters_applied).toEqual({
        resource: "Bridges-2",
        outage_type: "Partial",
      });
    });

    it("time=all with no filters discloses both keys as null", async () => {
      mockAllBranchEndpoints();

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_infrastructure_news", arguments: { time: "all" } },
      });

      const response = JSON.parse((result.content[0] as TextContent).text);
      expect(response.metadata.filters_applied).toEqual({
        resource: null,
        outage_type: null,
      });
    });

    it("time=past: fields projection targeting a metadata subpath still discloses filters_applied", async () => {
      mockSingleEndpoint(mockPastOutagesData);

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: {
            time: "past",
            resource: "Stampede3",
            fields: ["metadata.pagination.has_more"],
          },
        },
      });

      assertFiltersAppliedShape(result, EXPECTED_KEYS, expect);
      const response = JSON.parse((result.content[0] as TextContent).text);
      expect(response.metadata.filters_applied.resource).toBe("Stampede3");
    });
  });
});
