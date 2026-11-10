import { describe, it, expect, beforeEach } from "vitest";
import { ComputeResourcesServer } from "../server.js";

describe("Compute Resources - Prompts", () => {
  let server: ComputeResourcesServer;

  beforeEach(() => {
    server = new ComputeResourcesServer();
  });

  describe("getPrompts", () => {
    it("should list recommend_compute_resource prompt", () => {
      const prompts = server["getPrompts"]();

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        name: "recommend_compute_resource",
        description: expect.stringContaining("personalized"),
      });

      const args = prompts[0].arguments;
      expect(args).toHaveLength(4);
      expect(
        args?.find((a: { name: string; required?: boolean }) => a.name === "research_area")
          ?.required
      ).toBe(true);
      expect(
        args?.find((a: { name: string; required?: boolean }) => a.name === "compute_needs")
          ?.required
      ).toBe(true);
      expect(
        args?.find((a: { name: string; required?: boolean }) => a.name === "experience_level")
          ?.required
      ).toBe(false);
      expect(
        args?.find((a: { name: string; required?: boolean }) => a.name === "allocation_size")
          ?.required
      ).toBe(false);
    });
  });

  describe("handleGetPrompt - recommend_compute_resource", () => {
    it("should generate prompt with ML context referencing live tools", async () => {
      const result = await server["handleGetPrompt"]({
        params: {
          name: "recommend_compute_resource",
          arguments: {
            research_area: "machine learning",
            compute_needs: "GPU for training transformers",
          },
        },
      });

      expect(result).toHaveProperty("description");
      expect(result).toHaveProperty("messages");
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[0].content.type).toBe("text");

      const promptText = result.messages[0].content.text;

      // Should include field context
      expect(promptText).toContain("Computer Science");

      // Should reference live tools instead of hardcoded system names
      expect(promptText).toContain("search_resources");
      expect(promptText).toContain("get_resource");
      expect(promptText).not.toContain("get_resource_hardware");

      // Should include GPU reference
      expect(promptText).toContain("GPU");
    });

    it("should generate prompt with genomics context", async () => {
      const result = await server["handleGetPrompt"]({
        params: {
          name: "recommend_compute_resource",
          arguments: {
            research_area: "genomics",
            compute_needs: "genome assembly requiring 500GB RAM",
          },
        },
      });

      const promptText = result.messages[0].content.text;

      // Should include biological sciences field
      expect(promptText).toContain("Biological Sciences");

      // Should reference tools for discovering resources
      expect(promptText).toContain("search_resources");
    });

    it("should adapt to beginner experience level", async () => {
      const result = await server["handleGetPrompt"]({
        params: {
          name: "recommend_compute_resource",
          arguments: {
            research_area: "climate modeling",
            compute_needs: "parallel simulations",
            experience_level: "beginner",
          },
        },
      });

      const promptText = result.messages[0].content.text;

      // Should mention experience level
      expect(promptText).toContain("beginner");

      // Should include beginner-friendly note
      expect(promptText).toContain("new to HPC");
    });

    it("should include allocation size if provided", async () => {
      const result = await server["handleGetPrompt"]({
        params: {
          name: "recommend_compute_resource",
          arguments: {
            research_area: "physics",
            compute_needs: "large scale simulations",
            allocation_size: "large project",
          },
        },
      });

      const promptText = result.messages[0].content.text;
      expect(promptText).toContain("Allocation Size");
      expect(promptText).toContain("large project");
    });

    it("should include correct allocation tier guidance", async () => {
      const result = await server["handleGetPrompt"]({
        params: {
          name: "recommend_compute_resource",
          arguments: {
            research_area: "chemistry",
            compute_needs: "molecular dynamics",
          },
        },
      });

      const promptText = result.messages[0].content.text;

      // Should mention allocation tiers
      expect(promptText).toContain("Discover");
      expect(promptText).toContain("Explore");
      expect(promptText).toContain("Accelerate");
      expect(promptText).toContain("credits");
    });

    it("should handle unknown field gracefully", async () => {
      const result = await server["handleGetPrompt"]({
        params: {
          name: "recommend_compute_resource",
          arguments: {
            research_area: "underwater basket weaving",
            compute_needs: "need fast compute",
          },
        },
      });

      const promptText = result.messages[0].content.text;

      // Should still generate a valid prompt
      expect(promptText).toContain("underwater basket weaving");
      expect(promptText).toContain("fast compute");

      // Should reference tools for discovering resources
      expect(promptText).toContain("search_resources");
    });

    it("should throw error for unknown prompt", async () => {
      await expect(
        server["handleGetPrompt"]({
          params: {
            name: "nonexistent_prompt",
            arguments: {},
          },
        })
      ).rejects.toThrow("Unknown prompt");
    });
  });

  describe("Prompt Context Filtering", () => {
    it("should reference GPU tools for GPU-relevant requests", async () => {
      const gpuResult = await server["handleGetPrompt"]({
        params: {
          name: "recommend_compute_resource",
          arguments: {
            research_area: "computer vision",
            compute_needs: "training convolutional neural networks",
          },
        },
      });

      const promptText = gpuResult.messages[0].content.text;

      // Should reference tools for finding GPU resources
      expect(promptText).toContain("search_resources");
      expect(promptText).toContain("has_gpu");
      expect(promptText).toContain("get_resource");
      expect(promptText).not.toContain("get_resource_hardware");
    });

    it("should include tool instructions for non-GPU requests too", async () => {
      const cpuResult = await server["handleGetPrompt"]({
        params: {
          name: "recommend_compute_resource",
          arguments: {
            research_area: "data analysis",
            compute_needs: "CPU parallel processing",
          },
        },
      });

      const promptText = cpuResult.messages[0].content.text;

      // Should still reference tools
      expect(promptText).toContain("search_resources");
      expect(promptText).toContain("get_resource");
      expect(promptText).not.toContain("get_resource_hardware");
    });
  });
});
