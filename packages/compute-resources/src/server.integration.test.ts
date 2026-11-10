import { describe, it, expect } from "vitest";
import { ComputeResourcesServer } from "./server.js";

interface ComputeResource {
  name?: string;
}


describe("ComputeResourcesServer Integration Tests", () => {
  const server = new ComputeResourcesServer();

  it("should read a resource from the live documentation", async () => {
    const result = await server["handleToolCall"]({
      params: { name: "get_resource", arguments: { resource: "Stampede3" } },
    });

    const responseData = JSON.parse(result.content[0].text);

    expect(responseData.name).toBe("Stampede3");
    expect(responseData.details_available).toBe(true);
    expect(responseData.citation_url).toContain("/documentation/resources/");
    expect(responseData.queues.length).toBeGreaterThan(0);
  }, 10000);

  it("should compare resources from the live documentation", async () => {
    const result = await server["handleToolCall"]({
      params: { name: "compare_resources", arguments: { resources: ["Stampede3", "ACES"] } },
    });

    const responseData = JSON.parse(result.content[0].text);

    expect(responseData.total).toBe(2);
    expect(responseData.unresolved).toEqual([]);
  }, 10000);

  const search = async (args: Record<string, unknown>) => {
    const result = await server["handleToolCall"]({
      params: { name: "search_resources", arguments: args },
    });
    return JSON.parse(result.content[0].text);
  };
  const names = (data: { items: ComputeResource[] }) =>
    data.items.map((item) => item.name?.toLowerCase() ?? "");

  it("should list documented resources from the live documentation", async () => {
    const data = await search({});

    expect(data.total).toBeGreaterThan(20);
    for (const known of ["delta gpu", "anvil cpu", "bridges-2 rm", "stampede3"]) {
      expect(names(data)).toContain(known);
    }
    expect(data.items[0]).toHaveProperty("citation_url");
  }, 30000);

  it("should find GPU queues on the live documentation", async () => {
    const data = await search({ gpu_type: "H100", min_gpu_memory_gb: 80 });

    expect(data.total).toBeGreaterThan(2);
    for (const item of data.items) {
      expect(item.matching_queues.length).toBeGreaterThan(0);
    }
  }, 30000);

  it("should point to the provider for a resource without documentation", async () => {
    const data = await search({ query: "rockfish" });

    expect(data.total).toBe(0);
    expect(data.hint).toContain("resource provider");
  }, 30000);
});
