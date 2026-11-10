import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { ComputeResourcesServer } from "./server.js";
import { assertFiltersAppliedShape } from "@access-mcp/shared/testkit/filters-applied";

const API = "https://support.access-ci.org/api/1.0";

const listing = (nid: number, title: string, gid: string | null) => ({
  nid,
  title,
  short_name: title,
  resource_id: gid ? String(nid) : null,
  global_resource_id: gid,
  org_name: "National Center for Supercomputing Applications",
  status: "production",
  resource_type: "Compute",
  has_documentation: true,
  url: `https://support.access-ci.org/documentation/resources/${nid}`,
  last_modified: "2026-11-07T02:02:06-05:00",
});

const deltaGpu = listing(502, "Delta GPU", "delta-gpu.ncsa.access-ci.org");
const deltaCpu = listing(501, "Delta CPU", "delta-cpu.ncsa.access-ci.org");
const fabric = listing(801, "Fabric", null);

const details: Record<string, unknown> = {
  "502": {
    ...deltaGpu,
    ondemand_url: "https://openondemand.delta.ncsa.illinois.edu",
    file_transfer: [{ method: "Globus" }],
    queue_specs: [
      { name: "gpuA100x4", gpu_count: 4, gpu_type: "NVIDIA A100", gpu_vram: 40, ram: 256, summary: "4 NVIDIA A100" },
    ],
  },
  "501": {
    ...deltaCpu,
    queue_specs: [{ name: "cpu", gpu_count: 0, gpu_type: "None", ram: 256, summary: "128 cores" }],
  },
};

const FILTER_KEYS = [
  "query",
  "type",
  "organization",
  "status",
  "has_gpu",
  "gpu_type",
  "min_gpu_memory_gb",
  "min_memory_gb",
  "min_cores_per_node",
  "cpu_type",
  "min_wall_time_hours",
  "dataset",
  "ondemand",
  "transfer_method",
];

describe("ComputeResourcesServer", () => {
  let server: ComputeResourcesServer;
  let get: Mock<(url: string) => Promise<{ status: number; data: unknown }>>;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await server.handleToolCall({ method: "tools/call", params: { name, arguments: args } });
    return { result, data: JSON.parse(result.content[0].text as string) };
  };

  beforeEach(() => {
    server = new ComputeResourcesServer();
    get = vi.fn(async (url: string) => {
      if (url === `${API}/resources`) {
        return { status: 200, data: { resources: [deltaCpu, deltaGpu, fabric] } };
      }
      if (url === `${API}/resource-groups`) {
        return {
          status: 200,
          data: {
            groups: [
              {
                title: "Delta",
                url: "https://support.access-ci.org/documentation/resources/delta",
                variants: [{ nid: 501 }, { nid: 502 }],
              },
            ],
          },
        };
      }
      const id = url.slice(`${API}/resources/`.length);
      return id in details
        ? { status: 200, data: details[id] }
        : { status: 404, data: { error: "Resource not found" } };
    });
    Object.defineProperty(server, "httpClient", { get: () => ({ get }), configurable: true });
  });

  describe("tool definitions", () => {
    it("offers search, detail and comparison tools only", () => {
      const names = server["getTools"]().map((tool) => tool.name);
      expect(names).toEqual(["search_resources", "get_resource", "compare_resources"]);
    });

    it("advertises field projection on search_resources", () => {
      const tool = server["getTools"]().find((t) => t.name === "search_resources");
      expect(tool?.inputSchema.properties).toHaveProperty("fields");
      expect(tool?._meta).toEqual({ supportsFieldProjection: true });
    });

    it("declares every documented filter", () => {
      const tool = server["getTools"]().find((t) => t.name === "search_resources");
      expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(
        [...FILTER_KEYS, "fields"].sort()
      );
    });

    it("doesn't describe the old catalog's data problems", () => {
      const text = JSON.stringify(server["getTools"]());
      expect(text).not.toMatch(/cider|stale|nairr|get_resource_hardware/i);
    });
  });

  describe("search_resources", () => {
    it("reads only the Resource Documentation API", async () => {
      await call("search_resources", { query: "delta", has_gpu: true });
      for (const [url] of get.mock.calls) {
        expect(url.startsWith(`${API}/`)).toBe(true);
      }
    });

    it("lists documented resources with their group citation", async () => {
      const { data } = await call("search_resources");
      expect(data.total).toBe(3);
      expect(data.items.map(({ name }: { name: string }) => name)).toEqual([
        "Delta CPU",
        "Delta GPU",
        "Fabric",
      ]);
      expect(data.items[1]).toMatchObject({
        id: "delta-gpu.ncsa.access-ci.org",
        group: "Delta",
        accelerators: ["NVIDIA A100"],
        citation_url: "https://support.access-ci.org/documentation/resources/delta",
      });
      expect(data.items[2]).toMatchObject({ id: null, details_available: false });
      expect(data.documentation.links.see_all_url).toBe(
        "https://support.access-ci.org/documentation/resources"
      );
    });

    it("reports resources it can't check rather than dropping them silently", async () => {
      const { data } = await call("search_resources", { has_gpu: true });
      expect(data.items.map(({ name }: { name: string }) => name)).toEqual(["Delta GPU"]);
      expect(data.unchecked).toEqual([{ name: "Fabric", filters: ["has_gpu"] }]);
    });

    it("searches documented resources only", async () => {
      await call("search_resources", { query: "rockfish" });
      await call("search_resources", { has_gpu: true });
      expect(get).not.toHaveBeenCalledWith(`${API}/resources?documented=false`);
    });

    it("tells the model not to describe a resource it can't find", async () => {
      const { data } = await call("search_resources", { query: "rockfish" });
      expect(data.total).toBe(0);
      expect(data).not.toHaveProperty("undocumented_matches");
      expect(data.hint).toContain("may no longer be an ACCESS resource");
      expect(data.hint).toContain("point to the resource provider");
    });

    it("hints at the resource types when type matches nothing", async () => {
      const { data } = await call("search_resources", { type: "GPU Compute" });
      expect(data.total).toBe(0);
      expect(data.hint).toContain("Compute or Storage");
    });

    it("refuses ondemand: false", async () => {
      const { data } = await call("search_resources", { ondemand: false });
      expect(data.error.message).toContain("ondemand only accepts true");
      expect(get).not.toHaveBeenCalled();
    });

    it("reuses cached pages for the next search", async () => {
      await call("search_resources");
      const requests = get.mock.calls.length;
      await call("search_resources", { organization: "NCSA" });
      await call("get_resource", { resource: "Delta GPU" });
      expect(get.mock.calls.length).toBe(requests);
    });

    it("still answers when one resource's page fails", async () => {
      const original = get.getMockImplementation()!;
      get.mockImplementation(async (url) =>
        url === `${API}/resources/501` ? { status: 500, data: {} } : original(url)
      );
      const { data } = await call("search_resources", { has_gpu: false });
      expect(data.total).toBe(0);
      expect(data.unavailable).toEqual(["Delta CPU"]);
      expect(data.unchecked.map(({ name }: { name: string }) => name)).toEqual(["Fabric"]);

      // The failure isn't cached, so the next search reads the page again.
      get.mockImplementation(original);
      const retried = await call("search_resources", { has_gpu: false });
      expect(retried.data.items.map(({ name }: { name: string }) => name)).toEqual(["Delta CPU"]);
      expect(retried.data.unavailable).toBeUndefined();
    });

    it("shares one load between concurrent searches", async () => {
      await Promise.all([call("search_resources"), call("search_resources", { has_gpu: true })]);
      const detailCalls = get.mock.calls.filter(([url]) => url === `${API}/resources/502`);
      expect(detailCalls).toHaveLength(1);
    });

    it("returns an error when the listing can't be read", async () => {
      get.mockResolvedValue({ status: 503, data: {} });
      const { data } = await call("search_resources");
      expect(data.error).toBeDefined();
    });
  });

  describe("filters_applied disclosure", () => {
    it("conforms to the canonical shape", async () => {
      const { result } = await call("search_resources", { has_gpu: true });
      assertFiltersAppliedShape(result, FILTER_KEYS, expect);
    });

    it("discloses applied values, including false, and null for the rest", async () => {
      const { data } = await call("search_resources", { has_gpu: false, min_memory_gb: 128 });
      expect(data.metadata.filters_applied).toMatchObject({
        has_gpu: false,
        min_memory_gb: 128,
        query: null,
        ondemand: null,
      });
    });

    it("ignores arguments that aren't filters", async () => {
      const { data } = await call("search_resources", { include_ids: true, id: "delta" });
      expect(data.total).toBe(3);
      expect(Object.keys(data.metadata.filters_applied).sort()).toEqual([...FILTER_KEYS].sort());
    });
  });

  describe("fields projection", () => {
    it("keeps filters_applied when it's projected", async () => {
      const { result } = await call("search_resources", {
        has_gpu: true,
        fields: ["metadata.filters_applied"],
      });
      assertFiltersAppliedShape(result, FILTER_KEYS, expect);
    });

    it("projects the response to the requested fields", async () => {
      const { data } = await call("search_resources", { fields: ["items[].name", "items[].id"] });
      expect(data.total).toBe(3);
      expect(data.items[1]).toEqual({ name: "Delta GPU", id: "delta-gpu.ncsa.access-ci.org" });
      expect(data.unchecked).toBeUndefined();
    });
  });

  describe("errors", () => {
    it("reports an unknown tool", async () => {
      const { result } = await call("get_resource_hardware", { id: "Delta" });
      expect(result.content[0].text).toContain("Unknown tool");
    });

    it("reports a network error", async () => {
      get.mockRejectedValue(new Error("Network error"));
      const { data } = await call("search_resources");
      expect(data.error).toBeDefined();
    });
  });
});
