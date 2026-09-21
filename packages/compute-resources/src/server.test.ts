import { describe, it, expect, beforeEach, vi, Mock } from "vitest";
import { ComputeResourcesServer } from "./server.js";
import { assertFiltersAppliedShape } from "@access-mcp/shared/testkit/filters-applied";

interface MockHttpClient {
  get: Mock<(url: string) => Promise<{ status: number; statusText?: string; data: unknown }>>;
}

interface ComputeResource {
  name?: string;
  organization_names?: string[];
}

interface HardwareItem {
  cider_type?: string;
  name?: string;
}

describe("ComputeResourcesServer", () => {
  let server: ComputeResourcesServer;
  let mockHttpClient: MockHttpClient;

  beforeEach(() => {
    server = new ComputeResourcesServer();
    mockHttpClient = { get: vi.fn() };
    Object.defineProperty(server, "httpClient", {
      get: () => mockHttpClient,
      configurable: true,
    });
  });

  const mockFeatures = [
    { feature_id: 133, feature_name: "Cloud", feature_category_id: 100 },
    { feature_id: 134, feature_name: "GPU Compute", feature_category_id: 100 },
    { feature_id: 136, feature_name: "CPU Compute", feature_category_id: 100 },
    { feature_id: 138, feature_name: "Storage", feature_category_id: 100 },
    { feature_id: 139, feature_name: "ACCESS Allocated", feature_category_id: 101 },
    { feature_id: 142, feature_name: "Large Memory Nodes", feature_category_id: 102 },
    { feature_id: 397, feature_name: "Globus Data Transfer", feature_category_id: 103 },
  ];

  const mockFeatureCategories = [
    { feature_category_id: 100, feature_category_name: "Resource Type" },
    { feature_category_id: 101, feature_category_name: "Allocations" },
    { feature_category_id: 102, feature_category_name: "Specialized Hardware" },
    { feature_category_id: 103, feature_category_name: "Specialized Support" },
  ];

  const mockResourceGroups = {
    results: {
      features: mockFeatures,
      feature_categories: mockFeatureCategories,
      active_groups: [
        {
          info_groupid: 1,
          group_descriptive_name: "Delta",
          group_description: "GPU-focused supercomputer at NCSA",
          rollup_organization_ids: [100],
          rollup_feature_ids: [134, 136, 139], // GPU Compute, CPU Compute, ACCESS Allocated
          rollup_info_resourceids: ["delta.ncsa.access-ci.org"],
          group_logo_url: "https://example.com/delta.png",
        },
        {
          info_groupid: 2,
          group_descriptive_name: "Anvil",
          group_description: "CPU compute cluster at Purdue",
          rollup_organization_ids: [101],
          rollup_feature_ids: [136, 139], // CPU Compute, ACCESS Allocated
          rollup_info_resourceids: ["anvil.purdue.access-ci.org"],
          group_logo_url: "https://example.com/anvil.png",
        },
        {
          info_groupid: 3,
          group_descriptive_name: "Jetstream2",
          group_description: "Cloud computing platform",
          rollup_organization_ids: [102],
          rollup_feature_ids: [133, 134, 136, 138, 139], // Cloud, GPU Compute, CPU Compute, Storage, ACCESS Allocated
          rollup_info_resourceids: ["jetstream2.iu.access-ci.org"],
          group_logo_url: "https://example.com/jetstream.png",
        },
      ],
    },
  };

  // Updated to match new /wh2/cider/v1/organizations/ endpoint structure
  const mockOrganizations = {
    results: [
      {
        organization_id: 100,
        organization_name: "National Center for Supercomputing Applications",
        organization_abbrev: "NCSA",
      },
      {
        organization_id: 101,
        organization_name: "Purdue University",
        organization_abbrev: "Purdue",
      },
      {
        organization_id: 102,
        organization_name: "Indiana University",
        organization_abbrev: "IU",
      },
    ],
    status_code: 200,
  };

  describe("Tool Definitions", () => {
    it("should include search_resources tool with universal standard description", () => {
      const tools = server["getTools"]();

      const searchTool = tools.find((t) => t.name === "search_resources");
      expect(searchTool).toBeDefined();
      expect(searchTool?.description).toContain("Search ACCESS-CI compute resources");
      expect(searchTool?.description).toContain("Returns {total, items}");
    });

    it("should have consolidated tools", () => {
      const tools = server["getTools"]();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("search_resources");
      expect(toolNames).toContain("get_resource_hardware");
      expect(tools).toHaveLength(2);
    });
  });

  describe("search_resources (list all)", () => {
    it("should list compute resources with organization names", async () => {
      // Mock resource groups first, then organizations (actual call order)
      mockHttpClient.get
        .mockResolvedValueOnce({
          // Resource groups call (first)
          status: 200,
          data: mockResourceGroups,
        })
        .mockResolvedValueOnce({
          // Organizations call (second)
          status: 200,
          data: mockOrganizations,
        });

      // Verify mock is set up
      expect(mockHttpClient.get).toBeDefined();
      expect(vi.isMockFunction(mockHttpClient.get)).toBe(true);

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: {},
        },
      });

      // Verify mock was called
      expect(mockHttpClient.get).toHaveBeenCalledTimes(2);

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.total).toBe(3);
      expect(responseData.items).toHaveLength(3);

      const delta = responseData.items.find((r: ComputeResource) => r.name === "Delta");
      expect(delta).toBeDefined();
      expect(delta.description).toContain("GPU-focused");
      expect(delta.hasGpu).toBe(true);
      expect(delta.resourceTypes).toContain("GPU Compute");
      expect(delta.resourceTypes).toContain("CPU Compute");
      expect(delta.feature_names).toContain("GPU Compute");
      expect(delta.feature_names).toContain("CPU Compute");
      expect(delta.feature_names).toContain("ACCESS Allocated");
      expect(delta.feature_categories["Resource Type"]).toContain("GPU Compute");
      expect(delta.feature_categories["Resource Type"]).toContain("CPU Compute");
      expect(delta.feature_categories["Allocations"]).toContain("ACCESS Allocated");
      expect(delta.organization_names).toContain("National Center for Supercomputing Applications");
      expect(delta.resourceIds).toContain("delta.ncsa.access-ci.org");
    });

    it("should handle organization lookup failure gracefully", async () => {
      // Mock successful resource groups, failed organization lookup
      mockHttpClient.get
        .mockResolvedValueOnce({
          // Resource groups call succeeds (first)
          status: 200,
          data: mockResourceGroups,
        })
        .mockRejectedValueOnce(new Error("Organizations endpoint not found")); // Organizations call fails (second)

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: {},
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.total).toBe(3);

      const delta = responseData.items.find((r: ComputeResource) => r.name === "Delta");
      expect(delta.organization_names).toEqual(["100"]); // Falls back to ID
    });

    it("should handle API errors", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 500,
        statusText: "Internal Server Error",
        data: null,
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: {},
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.error).toBeDefined();
    });
  });

  describe("search_resources", () => {
    // No beforeEach needed - we'll set up mocks in each test

    it("should search resources by query", async () => {
      // Set up mocks for the listComputeResources call inside searchResources
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: mockResourceGroups })
        .mockResolvedValueOnce({ status: 200, data: mockOrganizations });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: {
            query: "gpu",
            include_ids: true,
          },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      // "gpu" matches Delta (description) and Jetstream2 (feature name "GPU Compute")
      expect(responseData.total).toBe(2);
      const names = responseData.items.map((r: ComputeResource) => r.name);
      expect(names).toContain("Delta");
      expect(names).toContain("Jetstream2");
    });

    it("should filter by resource type", async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: mockResourceGroups })
        .mockResolvedValueOnce({ status: 200, data: mockOrganizations });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: {
            type: "Cloud",
            include_ids: true,
          },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.total).toBe(1);
      expect(responseData.items[0].name).toBe("Jetstream2");
      expect(responseData.items[0].resourceTypes).toContain("Cloud");
    });

    it("should filter by GPU capability", async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: mockResourceGroups })
        .mockResolvedValueOnce({ status: 200, data: mockOrganizations });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: {
            has_gpu: true,
            include_ids: true,
          },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.total).toBe(2);
      const names = responseData.items.map((r: ComputeResource) => r.name);
      expect(names).toContain("Delta");
      expect(names).toContain("Jetstream2");
      expect(responseData.items.every((r: { hasGpu: boolean }) => r.hasGpu === true)).toBe(true);
    });

    it("should search by organization", async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: mockResourceGroups })
        .mockResolvedValueOnce({ status: 200, data: mockOrganizations });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: {
            query: "purdue",
            include_ids: true,
          },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.total).toBe(1);
      expect(responseData.items[0].name).toBe("Anvil");
    });

    it("should exclude resource_ids when include_ids is false", async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: mockResourceGroups })
        .mockResolvedValueOnce({ status: 200, data: mockOrganizations });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: {
            query: "delta",
            include_ids: false,
          },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      if (responseData.items.length > 0) {
        expect(responseData.items[0].resource_ids).toBeUndefined();
      }
    });
  });

  describe("filters_applied disclosure", () => {
    it("conforms to the canonical shape (exactly query, type, has_gpu, organization)", async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: mockResourceGroups })
        .mockResolvedValueOnce({ status: 200, data: mockOrganizations });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: { query: "gpu" },
        },
      });

      assertFiltersAppliedShape(result, ["query", "type", "has_gpu", "organization"], expect);
    });

    it("discloses applied filters and the result reflects them", async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: mockResourceGroups })
        .mockResolvedValueOnce({ status: 200, data: mockOrganizations });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: { has_gpu: true, type: "GPU Compute" },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.metadata.filters_applied).toEqual({
        query: null,
        type: "GPU Compute",
        has_gpu: true,
        organization: null,
      });
      expect(responseData.items.length).toBeGreaterThan(0);
      expect(
        responseData.items.every((r: { hasGpu: boolean; resourceTypes: string[] }) =>
          r.hasGpu === true && r.resourceTypes.includes("GPU Compute")
        )
      ).toBe(true);
    });

    it("discloses null for unapplied filters alongside the one that was applied", async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: mockResourceGroups })
        .mockResolvedValueOnce({ status: 200, data: mockOrganizations });

      // A fully empty call routes to listComputeResources (no filters_applied key at all —
      // covered by the "list all" describe block), so exercise the searchResources path with
      // one filter set and assert the other three keys are null.
      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: { organization: "NCSA" },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.metadata.filters_applied).toEqual({
        query: null,
        type: null,
        has_gpu: null,
        organization: "NCSA",
      });
    });

    it("discloses has_gpu: false as false, not null (boolean-false must survive)", async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: mockResourceGroups })
        .mockResolvedValueOnce({ status: 200, data: mockOrganizations });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: { has_gpu: false },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.metadata.filters_applied.has_gpu).toBe(false);
      expect(responseData.metadata.filters_applied).toEqual({
        query: null,
        type: null,
        has_gpu: false,
        organization: null,
      });
      expect(
        responseData.items.every((r: { hasGpu: boolean }) => r.hasGpu === false)
      ).toBe(true);
    });

    it("survives a fields projection targeting a metadata subpath", async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: mockResourceGroups })
        .mockResolvedValueOnce({ status: 200, data: mockOrganizations });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: { has_gpu: true, fields: ["metadata.pagination.has_more"] },
        },
      });

      assertFiltersAppliedShape(result, ["query", "type", "has_gpu", "organization"], expect);
      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.metadata.filters_applied.has_gpu).toBe(true);
    });
  });

  describe("search_resources (get specific resource)", () => {
    it("should get specific resource details", async () => {
      const mockResourceDetails = {
        results: [
          {
            info_groupid: 1,
            group_descriptive_name: "Delta",
            group_description: "Detailed Delta description",
            cider_type: "Compute",
            resource_descriptive_name: "GPU Nodes",
          },
        ],
      };

      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: mockResourceDetails,
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: {
            id: "1",
          },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData).toHaveLength(1);
      expect(responseData[0].group_descriptive_name).toBe("Delta");
    });
  });

  describe("get_resource_hardware", () => {
    it("should extract hardware information", async () => {
      const mockHardwareData = {
        results: [
          {
            info_groupid: 1,
            cider_type: "Compute",
            resource_descriptive_name: "GPU Nodes with A100",
            short_name: "Delta GPU",
            info_resourceid: "delta-gpu.ncsa.access-ci.org",
          },
          {
            info_groupid: 1,
            cider_type: "Storage",
            resource_descriptive_name: "High-speed storage",
            short_name: "Delta Storage",
            info_resourceid: "delta-storage.ncsa.access-ci.org",
          },
          {
            info_groupid: 1,
            cider_type: "Network",
            resource_descriptive_name: "Infiniband network",
            short_name: "Delta Network",
            info_resourceid: "delta-network.ncsa.access-ci.org",
          },
        ],
      };

      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: mockHardwareData,
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "get_resource_hardware",
          arguments: {
            id: "delta.ncsa.access-ci.org", // Full ID (contains dot) skips name resolution
          },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.resource_id).toBe("delta.ncsa.access-ci.org");

      // Hardware is now structured into categories (empty categories are removed)
      // The mock "GPU Nodes with A100" gets categorized as gpus (has "gpu" in name)
      // The mock "High-speed storage" gets categorized as storage
      expect(responseData.hardware).toHaveProperty("gpus");
      expect(responseData.hardware).toHaveProperty("storage");
      expect(responseData.hardware.gpus).toHaveLength(1);
      expect(responseData.hardware.storage).toHaveLength(1);

      // Verify the categorization is correct
      expect(responseData.hardware.gpus[0].name).toBe("GPU Nodes with A100");
      expect(responseData.hardware.storage[0].name).toBe("High-speed storage");

      // Check raw_hardware_items has 2 items (Compute and Storage, Network excluded)
      expect(responseData.raw_hardware_items).toHaveLength(2);
      expect(
        responseData.raw_hardware_items.some((h: HardwareItem) => h.cider_type === "Compute")
      ).toBe(true);
      expect(
        responseData.raw_hardware_items.some((h: HardwareItem) => h.cider_type === "Storage")
      ).toBe(true);
    });

    it("should resolve human-readable name to resource ID", async () => {
      // Mock the search_resources call that resolveResourceId makes
      const mockSearchResponse = {
        results: {
          features: mockFeatures,
          feature_categories: mockFeatureCategories,
          active_groups: [
            {
              info_groupid: "anvil.purdue.access-ci.org",
              group_descriptive_name: "Anvil",
              group_description: "Purdue Anvil cluster",
              rollup_organization_ids: [1869],
              rollup_feature_ids: [136, 139],
              rollup_info_resourceids: ["anvil.purdue.access-ci.org"],
            },
          ],
        },
      };

      const mockHardwareData = {
        results: [
          {
            cider_type: "Compute",
            resource_descriptive_name: "CPU Nodes",
          },
        ],
      };

      // First call is for search_resources (to resolve name), second is for hardware
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: mockSearchResponse })
        .mockResolvedValueOnce({ status: 200, data: mockSearchResponse }) // org lookup
        .mockResolvedValueOnce({ status: 200, data: mockHardwareData });

      const result = await server["handleToolCall"]({
        params: {
          name: "get_resource_hardware",
          arguments: {
            id: "Anvil", // Human-readable name, not full ID
          },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.resource_id).toBe("anvil.purdue.access-ci.org");
    });

    it("should return error when multiple resources match", async () => {
      const mockSearchResponse = {
        results: {
          features: mockFeatures,
          feature_categories: mockFeatureCategories,
          active_groups: [
            {
              info_groupid: "stampede2.tacc.access-ci.org",
              group_descriptive_name: "Stampede 2",
              group_description: "TACC Stampede 2",
              rollup_organization_ids: [2058],
              rollup_feature_ids: [],
              rollup_info_resourceids: ["stampede2.tacc.access-ci.org"],
            },
            {
              info_groupid: "stampede3.tacc.access-ci.org",
              group_descriptive_name: "Stampede 3",
              group_description: "TACC Stampede 3",
              rollup_organization_ids: [2058],
              rollup_feature_ids: [],
              rollup_info_resourceids: ["stampede3.tacc.access-ci.org"],
            },
          ],
        },
      };

      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: mockSearchResponse })
        .mockResolvedValueOnce({ status: 200, data: mockSearchResponse }); // org lookup

      const result = await server["handleToolCall"]({
        params: {
          name: "get_resource_hardware",
          arguments: {
            id: "Stampede", // Matches multiple resources
          },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.error.message).toContain("Multiple resources match");
      expect(responseData.error.message).toContain("Stampede 2");
      expect(responseData.error.message).toContain("Stampede 3");
    });

    it("should return error when no resources match", async () => {
      const mockSearchResponse = {
        results: {
          features: mockFeatures,
          feature_categories: mockFeatureCategories,
          active_groups: [],
        },
      };

      mockHttpClient.get.mockResolvedValueOnce({ status: 200, data: mockSearchResponse });

      const result = await server["handleToolCall"]({
        params: {
          name: "get_resource_hardware",
          arguments: {
            id: "NonExistentResource",
          },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.error.message).toContain("No resource found");
    });
  });

  describe("Resource Type Detection", () => {
    it("should detect GPU resources via feature 134", () => {
      const mockGroup = {
        group_description: "GPU-accelerated computing",
        group_descriptive_name: "Delta GPU",
        rollup_feature_ids: [134], // GPU Compute feature
      };

      const hasGpu = server["detectGpuCapability"](mockGroup);
      expect(hasGpu).toBe(true);
    });

    it("should detect GPU resources via description fallback", () => {
      const mockGroup = {
        group_description: "A system with GPU accelerators",
        group_descriptive_name: "Some GPU System",
        rollup_feature_ids: [], // No feature 134
      };

      const hasGpu = server["detectGpuCapability"](mockGroup);
      expect(hasGpu).toBe(true);
    });

    it("should not detect GPU for non-GPU resources", () => {
      const mockGroup = {
        group_description: "Traditional HPC cluster",
        group_descriptive_name: "Anvil Compute",
        rollup_feature_ids: [136, 139],
      };

      const hasGpu = server["detectGpuCapability"](mockGroup);
      expect(hasGpu).toBe(false);
    });
  });

  describe("Error Handling", () => {
    it("should handle unknown tools", async () => {
      const result = await server["handleToolCall"]({
        params: {
          name: "unknown_tool",
          arguments: {},
        },
      });

      expect(result.content[0].text).toContain("Unknown tool");
    });

    it("should handle network errors", async () => {
      mockHttpClient.get.mockRejectedValue(new Error("Network error"));

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: {},
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.error).toBeDefined();
    });
  });

  describe("fields projection (Pillar 2)", () => {
    it("should project search_resources response to requested fields only", async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: mockResourceGroups })
        .mockResolvedValueOnce({ status: 200, data: mockOrganizations });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: { fields: ["total", "items[].name"] },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.total).toBe(3);
      expect(responseData.items).toHaveLength(3);
      expect(Object.keys(responseData.items[0])).toEqual(["name"]);
      // metadata and documentation are both sticky containers — preserved on
      // projection even though fields asked for neither. This assertion used
      // to expect documentation to be absent, describing the behaviour of the
      // orphaned addDocumentation() rather than a decision: the listingLinks
      // hook now supplies a see_all_url on search, as the base class documents
      // and the six sibling servers already do.
      expect(responseData.metadata).toBeDefined();
      expect(responseData.documentation.links.see_all_url).toBe(
        "https://allocations.access-ci.org/resources"
      );
    });

    it("should always preserve total even when fields omits it", async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: mockResourceGroups })
        .mockResolvedValueOnce({ status: 200, data: mockOrganizations });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: { fields: ["metadata.pagination.has_more"] },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.total).toBe(3);
      expect(responseData.metadata.pagination.has_more).toBeDefined();
      expect(responseData.items).toBeUndefined();
    });

    it("should project filtered search_resources response (second handler path)", async () => {
      mockHttpClient.get
        .mockResolvedValueOnce({ status: 200, data: mockResourceGroups })
        .mockResolvedValueOnce({ status: 200, data: mockOrganizations });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_resources",
          arguments: { query: "GPU", fields: ["total", "items[].name"] },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.total).toBeGreaterThanOrEqual(0);
      if (responseData.items?.length) {
        expect(Object.keys(responseData.items[0])).toEqual(["name"]);
      }
    });

    it("should advertise fields parameter and supportsFieldProjection on search_resources", () => {
      const tools = server["getTools"]();
      const tool = tools.find((t) => t.name === "search_resources");

      expect(tool?.inputSchema.properties?.fields).toBeDefined();
      expect((tool as { _meta?: { supportsFieldProjection?: boolean } })._meta?.supportsFieldProjection).toBe(true);
    });
  });
});
