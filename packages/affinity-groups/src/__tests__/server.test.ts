import { describe, test, expect, vi, beforeEach } from "vitest";
import { AffinityGroupsServer } from "../server.js";
import { assertFiltersAppliedShape } from "@access-mcp/shared/testkit/filters-applied";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

interface TextContent {
  type: "text";
  text: string;
}

// Mock the base server
vi.mock("@access-mcp/shared", () => ({
  BaseAccessServer: class MockBaseAccessServer {
    constructor(
      public serverName: string,
      public version: string,
      public baseURL?: string
    ) {}
    httpClient = {
      get: vi.fn(),
    };
  },
  handleApiError: vi.fn((error) => error.message || "Unknown error"),
  sanitizeGroupId: vi.fn((id) => id),
  projectFields: vi.fn((envelope: unknown) => envelope),
}));

describe("AffinityGroupsServer", () => {
  let server: AffinityGroupsServer;

  beforeEach(() => {
    server = new AffinityGroupsServer();
  });

  describe("basic functionality", () => {
    test("should be instantiable", () => {
      expect(server).toBeDefined();
      expect(server).toBeInstanceOf(AffinityGroupsServer);
    });

    test("should have correct configuration", () => {
      // Test by using the public server interface
      expect(server["serverName"]).toBe("access-mcp-affinity-groups");
      expect(server["version"]).toBe(version);
    });

    test("should expose see_all_url for list and search contexts", () => {
      expect(server["listingLinks"]("list")?.see_all_url).toBe(
        "https://support.access-ci.org/affinity-groups"
      );
      expect(server["listingLinks"]("search")?.see_all_url).toBe(
        "https://support.access-ci.org/affinity-groups"
      );
      expect(server["listingLinks"]("details")).toBeUndefined();
    });
  });

  describe("filters_applied (Phase 4b canonical shape)", () => {
    const mockGroups = [
      {
        field_group_id: "1",
        nid: "1",
        title: "Machine Learning Group",
        description: "A group for ML researchers",
        coordinator_name: "Jane Doe",
        field_affinity_group_category: "research",
      },
      {
        field_group_id: "2",
        nid: "2",
        title: "Quantum Computing Group",
        description: "A group for quantum research",
        coordinator_name: "John Smith",
        field_affinity_group_category: "research",
      },
    ];

    beforeEach(() => {
      (server["httpClient"].get as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: mockGroups,
      });
    });

    test("search_affinity_groups discloses filters_applied shape [query]", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_affinity_groups",
          arguments: { query: "machine learning" },
        },
      });

      assertFiltersAppliedShape(result, ["query"], expect);
    });

    test("search_affinity_groups discloses the applied query and filters the result set", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_affinity_groups",
          arguments: { query: "machine learning" },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.metadata.filters_applied.query).toBe("machine learning");
      expect(responseData.total).toBe(1);
      expect(responseData.items[0].name).toBe("Machine Learning Group");
      // The canonical location is filters_applied — no bare metadata.query.
      expect(responseData.metadata.query).toBeUndefined();
    });

    test("search_affinity_groups discloses null query when listing without a query", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_affinity_groups",
          arguments: {},
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      // No id/query -> full list path, which has no filters_applied at all
      // (no filter params on that branch).
      expect(responseData.metadata.filters_applied).toBeUndefined();
      expect(responseData.total).toBe(2);
    });
  });
});
