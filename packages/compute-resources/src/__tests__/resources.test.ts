import { describe, it, expect, beforeEach } from "vitest";
import { ComputeResourcesServer } from "../server.js";

describe("Compute Resources - Resources", () => {
  let server: ComputeResourcesServer;

  beforeEach(() => {
    server = new ComputeResourcesServer();
  });

  describe("listingLinks", () => {
    // compute-resources was the only server not overriding this hook, so it
    // inherited the base class's undefined and emitted no documentation.links
    // at all — the agent had nothing to cite for resource questions.
    it("should expose see_all_url for list and search contexts", () => {
      expect(server["listingLinks"]("list")?.see_all_url).toBe(
        "https://support.access-ci.org/documentation/resources"
      );
      expect(server["listingLinks"]("search")?.see_all_url).toBe(
        "https://support.access-ci.org/documentation/resources"
      );
      expect(server["listingLinks"]("details")).toBeUndefined();
    });
  });

  describe("getResources", () => {
    it("should list all available resources", () => {
      const resources = server["getResources"]();

      expect(resources).toHaveLength(4);
      expect(resources).toContainEqual(
        expect.objectContaining({
          uri: "accessci://compute-resources",
          name: "ACCESS-CI Compute Resources",
        })
      );
      expect(resources).toContainEqual(
        expect.objectContaining({
          uri: "accessci://compute-resources/capabilities-matrix",
          name: "Compute Resource Capabilities Matrix",
        })
      );
      expect(resources).toContainEqual(
        expect.objectContaining({
          uri: "accessci://compute-resources/gpu-guide",
          name: "GPU Resource Selection Guide",
        })
      );
      expect(resources).toContainEqual(
        expect.objectContaining({
          uri: "accessci://compute-resources/resource-types",
          name: "Resource Type Taxonomy",
        })
      );
    });
  });

  describe("handleResourceRead - capabilities-matrix", () => {
    it("should return JSON with comparison matrix and selection guide", async () => {
      const result = await server["handleResourceRead"]({
        params: { uri: "accessci://compute-resources/capabilities-matrix" },
      });

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].mimeType).toBe("application/json");

      const data = JSON.parse(result.contents[0].text);
      expect(data).toHaveProperty("comparison_matrix");
      expect(data).toHaveProperty("selection_guide");
      expect(data).not.toHaveProperty("resource_types");

      // Verify specific content
      expect(data.comparison_matrix).toHaveProperty("Machine Learning / AI");
      expect(data.comparison_matrix["Machine Learning / AI"].primary).toBe("GPU Compute");
    });
  });

  describe("handleResourceRead - gpu-guide", () => {
    it("should return Markdown GPU selection guide referencing live tools", async () => {
      const result = await server["handleResourceRead"]({
        params: { uri: "accessci://compute-resources/gpu-guide" },
      });

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].mimeType).toBe("text/markdown");

      const markdown = result.contents[0].text;
      expect(markdown).toContain("# GPU Resource Selection Guide");
      expect(markdown).toContain("search_resources");
      expect(markdown).toContain("get_resource");
      expect(markdown).not.toContain("get_resource_hardware");
      // Should reference GPU-related content
      expect(markdown).toContain("GPU");
      expect(markdown).toContain("has_gpu");
      // Should NOT contain hardcoded system names or GPU models
      expect(markdown).not.toContain("NVIDIA A100");
      expect(markdown).not.toContain("NVIDIA V100");
    });
  });

  describe("handleResourceRead - resource-types", () => {
    it("should return JSON with resource type taxonomy as array", async () => {
      const result = await server["handleResourceRead"]({
        params: { uri: "accessci://compute-resources/resource-types" },
      });

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].mimeType).toBe("application/json");

      const data = JSON.parse(result.contents[0].text);
      expect(data).toHaveProperty("resource_types");
      expect(Array.isArray(data.resource_types)).toBe(true);

      // The documentation's own types, which search_resources filters on
      expect(data.resource_types.map((t: { name: string }) => t.name)).toEqual(["Compute", "Storage"]);

      // Should not have old-style object keys
      expect(data).not.toHaveProperty("usage_notes");
    });
  });

  describe("handleResourceRead - unknown resource", () => {
    it("should throw error for unknown resource URI", async () => {
      await expect(
        server["handleResourceRead"]({
          params: { uri: "accessci://compute-resources/nonexistent" },
        })
      ).rejects.toThrow("Unknown resource");
    });
  });
});
