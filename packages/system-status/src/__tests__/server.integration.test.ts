import { describe, it, expect, beforeEach } from "vitest";
import { SystemStatusServer } from "../server.js";

interface TextContent {
  type: "text";
  text: string;
}

interface ResourceStatus {
  resource_id: string;
  status: string;
  active_outages: number;
  outage_details: unknown[];
}

interface AffectedResource {
  ResourceID?: string | number;
}

interface OutageItem {
  Subject?: string;
  AffectedResources?: AffectedResource[];
}

describe("SystemStatusServer Integration Tests", () => {
  let server: SystemStatusServer;

  beforeEach(() => {
    server = new SystemStatusServer();
  });

  describe("Real API Integration", () => {
    it("should fetch current outages from real API", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "current", limit: 5 },
        },
      });

      const content = result.content[0] as TextContent;
      const responseData = JSON.parse(content.text);
      expect(responseData).toHaveProperty("total");
      expect(responseData).toHaveProperty("metadata.aggregations.affected_resources");
      expect(responseData).toHaveProperty("metadata.aggregations.severity_counts");
      expect(responseData.metadata.aggregations.severity_counts).toHaveProperty("high");
      expect(responseData.metadata.aggregations.severity_counts).toHaveProperty("medium");
      expect(responseData.metadata.aggregations.severity_counts).toHaveProperty("low");
      expect(responseData.metadata.aggregations.severity_counts).toHaveProperty("unknown");
      expect(Array.isArray(responseData.items)).toBe(true);

      // Check enhanced fields
      if (responseData.items.length > 0) {
        const outage = responseData.items[0];
        expect(outage).toHaveProperty("severity");
        // The API response includes original fields like Subject, OutageStart, OutageEnd, etc.
        expect(outage).toHaveProperty("Subject");
      }
    }, 10000);

    it("should fetch scheduled maintenance from real API", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "scheduled", limit: 5 },
        },
      });

      const content = result.content[0] as TextContent;
      const responseData = JSON.parse(content.text);
      expect(responseData).toHaveProperty("total");
      expect(responseData).toHaveProperty("metadata.aggregations.upcoming_24h");
      expect(responseData).toHaveProperty("metadata.aggregations.upcoming_week");
      expect(responseData).toHaveProperty("metadata.aggregations.affected_resources");
      expect(Array.isArray(responseData.items)).toBe(true);

      // Check enhanced fields
      if (responseData.items.length > 0) {
        const maintenance = responseData.items[0];
        expect(maintenance).toHaveProperty("hours_until_start");
        expect(maintenance).toHaveProperty("has_scheduled_time");
        expect(maintenance.hours_until_start).toSatisfy(
          (val: unknown) => val === null || typeof val === "number"
        );
      }
    }, 10000);

    it("should fetch past outages from real API", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "past", limit: 5 },
        },
      });

      const content = result.content[0] as TextContent;
      const responseData = JSON.parse(content.text);
      expect(responseData).toHaveProperty("total");
      expect(responseData).toHaveProperty("metadata.aggregations.recent_outages_30_days");
      expect(responseData).toHaveProperty("metadata.aggregations.affected_resources");
      expect(responseData).toHaveProperty("metadata.aggregations.outage_types");
      expect(responseData).toHaveProperty("metadata.aggregations.average_duration_hours");
      expect(Array.isArray(responseData.items)).toBe(true);

      // Check enhanced fields
      if (responseData.items.length > 0) {
        const outage = responseData.items[0];
        expect(outage).toHaveProperty("duration_hours");
        expect(outage).toHaveProperty("days_ago");
        expect(outage).toHaveProperty("outage_type");
        expect(outage.days_ago).toSatisfy(
          (val: unknown) => val === null || typeof val === "number"
        );
      }
    }, 10000);

    it("should get comprehensive system announcements", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "all", limit: 20 },
        },
      });

      const content = result.content[0] as TextContent;
      const responseData = JSON.parse(content.text);
      expect(responseData).toHaveProperty("total");
      expect(responseData).toHaveProperty("metadata.aggregations.current_outages");
      expect(responseData).toHaveProperty("metadata.aggregations.scheduled_maintenance");
      expect(responseData).toHaveProperty("metadata.aggregations.recent_past_outages");
      expect(responseData).toHaveProperty("metadata.aggregations.categories");
      expect(responseData.metadata.aggregations.categories).toHaveProperty("current");
      expect(responseData.metadata.aggregations.categories).toHaveProperty("scheduled");
      expect(responseData.metadata.aggregations.categories).toHaveProperty("recent_past");
      expect(Array.isArray(responseData.items)).toBe(true);

      // Check categorization
      if (responseData.items.length > 0) {
        const announcement = responseData.items[0];
        expect(announcement).toHaveProperty("category");
        expect(["current", "scheduled", "recent_past"]).toContain(announcement.category);
      }
    }, 15000);

    it("should check resource status using group API", async () => {
      // Test with human-readable names - these get resolved to full IDs
      // The group API is used automatically for efficient per-resource queries
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: {
            ids: ["Anvil", "Delta", "Expanse"],
          },
        },
      });

      const content = result.content[0] as TextContent;
      const responseData = JSON.parse(content.text);
      expect(responseData).toHaveProperty("metadata.checked_at");
      expect(responseData).toHaveProperty("total", 3);
      expect(responseData).toHaveProperty("metadata.aggregations.counts.operational");
      expect(responseData).toHaveProperty("metadata.aggregations.counts.affected");
      expect(Array.isArray(responseData.items)).toBe(true);
      expect(responseData.items).toHaveLength(3);

      // Check resource status structure - IDs should be resolved to full format
      responseData.items.forEach((resource: ResourceStatus) => {
        expect(resource).toHaveProperty("resource_id");
        expect(resource.resource_id).toContain(".access-ci.org"); // Resolved to full ID
        expect(resource).toHaveProperty("status");
        expect(["operational", "affected", "unknown"]).toContain(resource.status);
        expect(resource).toHaveProperty("active_outages");
        expect(Array.isArray(resource.outage_details)).toBe(true);
      });
    }, 15000);

    it("should check single resource status", async () => {
      // Test with a single human-readable name
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: {
            ids: ["Anvil"],
          },
        },
      });

      const content = result.content[0] as TextContent;
      const responseData = JSON.parse(content.text);
      expect(responseData).toHaveProperty("total", 1);
      expect(responseData.items).toHaveLength(1);

      const resourceStatus = responseData.items[0];
      expect(resourceStatus.resource_id).toContain("anvil"); // Resolved ID contains anvil
      expect(resourceStatus.resource_id).toContain(".access-ci.org");
      expect(resourceStatus).toHaveProperty("status");
      expect(["operational", "affected", "unknown"]).toContain(resourceStatus.status);
      expect(resourceStatus).toHaveProperty("active_outages");
      expect(resourceStatus).toHaveProperty("outage_details");
    }, 15000);

    it("should filter outages by resource correctly", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "current", resource: "anvil" },
        },
      });

      const content = result.content[0] as TextContent;
      const responseData = JSON.parse(content.text);
      expect(responseData).toHaveProperty("total");

      // If there are any results, they should match the filter
      if (responseData.items.length > 0) {
        responseData.items.forEach((outage: OutageItem) => {
          const matchesFilter =
            outage.Subject?.toLowerCase().includes("anvil") ||
            outage.AffectedResources?.some((resource: AffectedResource) =>
              resource.ResourceID?.toString().includes("anvil")
            );
          expect(matchesFilter).toBe(true);
        });
      }
    }, 10000);

    it("should handle resource reads for all endpoints", async () => {
      const resources = [
        "accessci://system-status",
        "accessci://outages/current",
        "accessci://outages/scheduled",
        "accessci://outages/past",
      ];

      for (const uri of resources) {
        const result = await server["handleResourceRead"]({
          method: "resources/read",
          params: { uri },
        });

        expect(result.contents).toHaveLength(1);
        expect(result.contents[0]).toHaveProperty("uri", uri);
        expect(result.contents[0]).toHaveProperty("mimeType");
        expect(result.contents[0]).toHaveProperty("text");

        if (uri !== "accessci://system-status") {
          // JSON resources should have valid JSON
          const content = result.contents[0];
          if ("text" in content) {
            expect(() => JSON.parse(content.text)).not.toThrow();
          }
        }
      }
    }, 15000);
  });

  describe("Edge Cases and Error Handling", () => {
    it("should handle empty API responses", async () => {
      // This tests the robustness of our logic with potentially empty responses
      // Using a resource filter that won't match anything
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "current", resource: "nonexistent-resource-xyz-12345" },
        },
      });

      const content = result.content[0] as TextContent;
      const responseData = JSON.parse(content.text);
      expect(responseData).toHaveProperty("total", 0);
      expect(responseData.items).toHaveLength(0);
      expect(responseData.metadata.aggregations.affected_resources).toHaveLength(0);
    }, 10000);

    it("should handle large limit values gracefully", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_infrastructure_news",
          arguments: { time: "past", limit: 1000 },
        },
      });

      const content = result.content[0] as TextContent;
      const responseData = JSON.parse(content.text);
      expect(responseData).toHaveProperty("total");
      // Should not crash or timeout
      expect(responseData.items.length).toBeLessThanOrEqual(1000);
    }, 15000);
  });
});
