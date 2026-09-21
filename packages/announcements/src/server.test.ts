import { describe, it, expect, beforeEach, afterEach, vi, Mock } from "vitest";
import { AnnouncementsServer } from "./server.js";
import { DrupalAuthProvider, DrupalApiError, requestContextStorage, RequestContext } from "@access-mcp/shared";
import { assertWriteEnvelope } from "@access-mcp/shared/testkit";
import { assertFiltersAppliedShape } from "@access-mcp/shared/testkit/filters-applied";

// Mock the DrupalAuthProvider
vi.mock("@access-mcp/shared", async () => {
  const actual = await vi.importActual("@access-mcp/shared");
  return {
    ...actual,
    DrupalAuthProvider: vi.fn().mockImplementation(() => ({
      ensureAuthenticated: vi.fn().mockResolvedValue(undefined),
      getUserUuid: vi.fn().mockReturnValue("user-uuid-123"),
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    })),
  };
});

interface MockHttpClient {
  get: Mock<(url: string) => Promise<{ status: number; data?: unknown; statusText?: string }>>;
}

interface TextContent {
  type: "text";
  text: string;
}

describe("AnnouncementsServer", () => {
  let server: AnnouncementsServer;
  let mockHttpClient: MockHttpClient;

  beforeEach(() => {
    server = new AnnouncementsServer();

    // Mock the httpClient
    mockHttpClient = {
      get: vi.fn(),
    };

    // Override the httpClient getter
    Object.defineProperty(server, "httpClient", {
      get: () => mockHttpClient,
      configurable: true,
    });
  });

  describe("Tool Methods", () => {
    describe("search_announcements", () => {
      it("should fetch announcements with filters", async () => {
        const mockResponse = {
          status: 200,
          data: [
            {
              title: "Scheduled Maintenance",
              body: "System will be down for maintenance",
              published_date: "2024-03-15",
              author: "ACCESS Support",
              tags: ["maintenance", "scheduled"],
              affinity_group: ["123", "456"],
              url: "https://support.access-ci.org/announcements/scheduled-maintenance",
            },
            {
              title: "New GPU Nodes Available",
              body: "Additional GPU resources added",
              published_date: "2024-03-10",
              author: "Resource Team",
              tags: ["gpu", "hardware"],
              affinity_group: ["789"],
              url: "https://support.access-ci.org/announcements/new-gpu-nodes-available",
            },
          ],
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_announcements",
            arguments: {
              tags: "maintenance",
              limit: 10,
            },
          },
        });

        expect(mockHttpClient.get).toHaveBeenCalled();
        const url = mockHttpClient.get.mock.calls[0][0];
        expect(url).toContain("/api/2.2/announcements");
        expect(url).toContain("tags=maintenance");

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.total).toBe(2);
        expect(responseData.items).toHaveLength(2);
        expect(responseData.items[0].tags).toEqual(["maintenance", "scheduled"]);
        expect(responseData.documentation.links).toEqual({
          see_all_url: "https://support.access-ci.org/announcements",
        });
        expect(responseData.metadata.query_relevance).toBe("exact");
      });

      it("should handle empty results and still surface see_all_url", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: [],
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_announcements",
            arguments: {
              tags: "nonexistent",
            },
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.total).toBe(0);
        expect(responseData.items).toEqual([]);
        expect(responseData.documentation.links.see_all_url).toBe(
          "https://support.access-ci.org/announcements"
        );
      });

      it("should handle API errors", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 500,
          statusText: "Internal Server Error",
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_announcements",
            arguments: {},
          },
        });

        // Server handles errors and returns them in content, not as isError
        expect((result.content[0] as TextContent).text).toContain("500");
      });
    });

    describe("search with query parameter", () => {
      it("should include search_api_fulltext in URL and tag query_relevance loose_match", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: [],
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_announcements",
            arguments: {
              query: "GPU computing",
            },
          },
        });

        const url = mockHttpClient.get.mock.calls[0][0];
        expect(url).toContain("search_api_fulltext=GPU+computing");

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.metadata.query_relevance).toBe("loose_match");
      });

      it("should combine query with other filters", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: [],
        });

        await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_announcements",
            arguments: {
              query: "workshop",
              tags: "training",
              date: "this_month",
            },
          },
        });

        const url = mockHttpClient.get.mock.calls[0][0];
        expect(url).toContain("search_api_fulltext=workshop");
        expect(url).toContain("tags=training");
        expect(url).toContain("relative_start_date=-1+month");
      });
    });

    describe("search by tags", () => {
      it("should fetch announcements by specific tags", async () => {
        const mockResponse = {
          status: 200,
          data: [
            {
              title: "GPU Maintenance",
              body: "GPU nodes maintenance",
              published_date: "2024-03-15",
              author: "Support",
              tags: ["gpu", "maintenance"],
              affinity_group: [],
              url: "https://support.access-ci.org/announcements/gpu-maintenance",
            },
          ],
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_announcements",
            arguments: {
              tags: "gpu,maintenance",
              limit: 20,
            },
          },
        });

        const url = mockHttpClient.get.mock.calls[0][0];
        expect(url).toContain("tags=gpu%2Cmaintenance");

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.items[0].tags).toContain("gpu");
        expect(responseData.items[0].tags).toContain("maintenance");
      });
    });

    describe("filters_applied disclosure", () => {
      it("conforms to the canonical shape (exactly query, tags, date)", async () => {
        mockHttpClient.get.mockResolvedValue({ status: 200, data: [] });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_announcements",
            arguments: { tags: "gpu" },
          },
        });

        assertFiltersAppliedShape(result, ["query", "tags", "date"], expect);
      });

      it("discloses the applied tag filter and the result reflects it", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: [
            {
              title: "GPU Maintenance",
              body: "GPU nodes maintenance",
              published_date: "2024-03-15",
              author: "Support",
              tags: ["gpu"],
              affinity_group: [],
              url: "https://support.access-ci.org/announcements/gpu-maintenance",
            },
          ],
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_announcements",
            arguments: { tags: "gpu" },
          },
        });

        const url = mockHttpClient.get.mock.calls[0][0];
        expect(url).toContain("tags=gpu");

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.metadata.filters_applied).toEqual({
          query: null,
          tags: "gpu",
          date: null,
        });
        expect(responseData.items[0].tags).toContain("gpu");
      });

      it("discloses all-null filters_applied when no filters are supplied", async () => {
        mockHttpClient.get.mockResolvedValue({ status: 200, data: [] });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_announcements",
            arguments: {},
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.metadata.filters_applied).toEqual({
          query: null,
          tags: null,
          date: null,
        });
      });

      it("survives a fields projection that does not explicitly include metadata", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: [
            {
              title: "GPU Maintenance",
              body: "GPU nodes maintenance",
              published_date: "2024-03-15",
              author: "Support",
              tags: ["gpu"],
              affinity_group: [],
              url: "https://support.access-ci.org/announcements/gpu-maintenance",
            },
          ],
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_announcements",
            arguments: { tags: "gpu", fields: ["total", "items[].title"] },
          },
        });

        // metadata is a sticky projection container (see projection.ts), so
        // filters_applied is expected to already survive here — this test
        // guards that behavior rather than fixing a gap.
        assertFiltersAppliedShape(result, ["query", "tags", "date"], expect);
        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.metadata.filters_applied.tags).toBe("gpu");
      });
    });

    describe("search with limit", () => {
      it("fetches items_per_page=All and still respects limit via local slice", async () => {
        const mockResponse = {
          status: 200,
          data: [
            {
              title: "Update 1",
              body: "Body 1",
              published_date: "2024-03-14",
              tags: ["ai"],
              affinity_group: [],
              url: "https://support.access-ci.org/announcements/update-1",
            },
          ],
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_announcements",
            arguments: {
              limit: 5,
            },
          },
        });

        const url = mockHttpClient.get.mock.calls[0][0];
        expect(url).toContain("items_per_page=All");

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.items).toHaveLength(1);
      });
    });

    describe("recent announcements with date filters", () => {
      it("should fetch announcements with date filter", async () => {
        const mockResponse = {
          status: 200,
          data: [
            {
              title: "Today's Update",
              body: "Important update",
              published_date: new Date().toISOString(),
              author: "Admin",
              tags: ["urgent"],
              affinity_group: [],
              url: "https://support.access-ci.org/announcements/todays-update",
            },
          ],
        };

        mockHttpClient.get.mockResolvedValue(mockResponse);

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_announcements",
            arguments: {
              date: "this_week",
            },
          },
        });

        const url = mockHttpClient.get.mock.calls[0][0];
        expect(url).toContain("relative_start_date=-1+week");

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.items).toHaveLength(1);
      });

      it("should handle search with no date filter", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: [],
        });

        await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_announcements",
            arguments: {},
          },
        });

        expect(mockHttpClient.get).toHaveBeenCalled();
        const url = mockHttpClient.get.mock.calls[0][0];
        expect(url).toContain("/api/2.2/announcements");
      });
    });
  });

  describe("URL Building", () => {
    it("should build URLs with multiple filters", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: [],
      });

      await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: {
            tags: "gpu,maintenance",
            date: "this_month",
            limit: 20,
          },
        },
      });

      const url = mockHttpClient.get.mock.calls[0][0];
      expect(url).toContain("tags=gpu%2Cmaintenance");
      expect(url).toContain("relative_start_date=-1+month");
    });

    it("should handle date filters", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: [],
      });

      await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: {
            date: "today",
          },
        },
      });

      const url = mockHttpClient.get.mock.calls[0][0];
      expect(url).toContain("relative_start_date=today");
    });
  });

  describe("Data Enhancement", () => {
    it("should parse tags array correctly", async () => {
      const mockResponse = {
        status: 200,
        data: [
          {
            title: "Test",
            published_date: "2024-03-15",
            tags: ["tag1", "tag2", "tag3"],
            affinity_group: [],
            url: "https://support.access-ci.org/announcements/test",
          },
        ],
      };

      mockHttpClient.get.mockResolvedValue(mockResponse);

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: {},
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.items[0].tags).toEqual(["tag1", "tag2", "tag3"]);
    });

    it("should parse tags from comma-separated string", async () => {
      const mockResponse = {
        status: 200,
        data: [
          {
            title: "Test",
            published_date: "2024-03-15",
            tags: "gpu, machine-learning, hpc",
            affinity_group: [],
            url: "https://support.access-ci.org/announcements/test",
          },
        ],
      };

      mockHttpClient.get.mockResolvedValue(mockResponse);

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: {},
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.items[0].tags).toEqual(["gpu", "machine-learning", "hpc"]);
    });

    it("should handle empty tags string", async () => {
      const mockResponse = {
        status: 200,
        data: [
          {
            title: "Test",
            published_date: "2024-03-15",
            tags: "",
            affinity_group: [],
            url: "https://support.access-ci.org/announcements/test",
          },
        ],
      };

      mockHttpClient.get.mockResolvedValue(mockResponse);

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: {},
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.items[0].tags).toEqual([]);
    });

    it("should extract popular tags", async () => {
      const mockResponse = {
        status: 200,
        data: [
          {
            title: "1",
            published_date: "2024-03-15",
            tags: ["gpu", "maintenance"],
            affinity_group: [],
            url: "https://support.access-ci.org/announcements/1",
          },
          {
            title: "2",
            published_date: "2024-03-14",
            tags: ["gpu", "network"],
            affinity_group: [],
            url: "https://support.access-ci.org/announcements/2",
          },
          {
            title: "3",
            published_date: "2024-03-13",
            tags: ["gpu", "storage"],
            affinity_group: [],
            url: "https://support.access-ci.org/announcements/3",
          },
          { title: "4", published_date: "2024-03-12", tags: ["maintenance"], affinity_group: [], url: "https://support.access-ci.org/announcements/4" },
        ],
      };

      mockHttpClient.get.mockResolvedValue(mockResponse);

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: {},
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      // Popular tags are in metadata, not in the universal {total, items} format
      expect(responseData.items).toHaveLength(4);
    });

    it("should include published_date in items", async () => {
      const mockResponse = {
        status: 200,
        data: [
          {
            title: "Test",
            published_date: "2024-03-15",
            tags: [],
            affinity_group: [],
            url: "https://support.access-ci.org/announcements/test",
          },
        ],
      };

      mockHttpClient.get.mockResolvedValue(mockResponse);

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: {},
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.items[0].published_date).toBe("2024-03-15");
    });
  });

  describe("CRUD Operations", () => {
    let mockDrupalAuth: {
      ensureAuthenticated: Mock;
      getUserUuid: Mock;
      get: Mock;
      post: Mock;
      patch: Mock;
      delete: Mock;
    };

    beforeEach(() => {
      // Set up environment variables for CRUD operations
      process.env.DRUPAL_API_URL = "https://test.drupal.site";
      process.env.DRUPAL_USERNAME = "test_user";
      process.env.DRUPAL_PASSWORD = "test_password";
      process.env.ACTING_USER = "testuser@access-ci.org";

      // Create a fresh mock for each test
      mockDrupalAuth = {
        ensureAuthenticated: vi.fn().mockResolvedValue(undefined),
        getUserUuid: vi.fn().mockReturnValue("user-uuid-123"),
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      };

      // Mock the DrupalAuthProvider constructor to return our mock
      (DrupalAuthProvider as unknown as Mock).mockImplementation(() => mockDrupalAuth);
    });

    afterEach(() => {
      delete process.env.DRUPAL_API_URL;
      delete process.env.DRUPAL_USERNAME;
      delete process.env.DRUPAL_PASSWORD;
      delete process.env.ACTING_USER;
    });

    describe("create_announcement", () => {
      it("should create an announcement with required fields", async () => {
        mockDrupalAuth.post.mockResolvedValue({
          success: true,
          uuid: "new-announcement-uuid",
          nid: 12345,
          title: "Test Announcement",
          edit_url: "https://test.drupal.site/node/12345/edit",
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "create_announcement",
            arguments: {
              title: "Test Announcement",
              body: "<p>This is a test</p>",
              summary: "Test summary",
            },
          },
        });

        // New custom controller: flat body, plain field names, POST to /api/2.3/announcements.
        // The controller hardcodes moderation_state=draft, so the client no longer sends it.
        expect(mockDrupalAuth.post).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/api/2.3/announcements",
          expect.objectContaining({
            title: "Test Announcement",
            body: expect.objectContaining({
              value: "<p>This is a test</p>",
              summary: "Test summary",
            }),
          })
        );
        const [, , requiredBody] = mockDrupalAuth.post.mock.calls[0];
        expect(requiredBody).not.toHaveProperty("summary");
        const [, , postedBody] = mockDrupalAuth.post.mock.calls[0];
        expect(postedBody).not.toHaveProperty("data");
        expect(postedBody).not.toHaveProperty("moderation_state");

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData).toMatchObject({
          action: "create",
          status: "created",
          executed: true,
          data: {
            uuid: "new-announcement-uuid",
            nid: 12345,
            title: "Test Announcement",
            edit_url: "https://test.drupal.site/node/12345/edit",
            moderation_state: "draft",
          },
        });
        expect(responseData).not.toHaveProperty("success");
      });

      it("should build edit_url from nid when the controller omits it", async () => {
        mockDrupalAuth.post.mockResolvedValue({
          success: true,
          uuid: "new-announcement-uuid",
          nid: 999,
          title: "No Edit URL",
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "create_announcement",
            arguments: {
              title: "No Edit URL",
              body: "Body",
              summary: "Summary",
            },
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.data.edit_url).toBe(
          "https://test.drupal.site/node/999/edit"
        );
      });

      it("should surface skipped tags as a top-level warning in the envelope", async () => {
        // Tag cache resolves only one of the two requested names.
        mockDrupalAuth.get.mockResolvedValueOnce({
          data: [{ id: "tag-uuid-1", attributes: { name: "gpu" } }],
          links: {},
        });

        mockDrupalAuth.post.mockResolvedValue({
          success: true,
          uuid: "new-announcement-uuid",
          nid: 12345,
          title: "Tagged",
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "create_announcement",
            arguments: {
              title: "Tagged",
              body: "Body",
              summary: "Summary",
              tags: ["gpu", "nonexistent-tag"],
            },
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.action).toBe("create");
        expect(responseData.status).toBe("created");
        expect(responseData.warning).toContain("were skipped");
        expect(responseData.warning).toContain("nonexistent-tag");
      });

      it("should look up tags by name when provided (with caching)", async () => {
        mockDrupalAuth.get.mockResolvedValueOnce({
          data: [
            { id: "tag-uuid-1", attributes: { name: "gpu" } },
            { id: "tag-uuid-2", attributes: { name: "maintenance" } },
            { id: "tag-uuid-3", attributes: { name: "hpc" } },
          ],
          links: {},
        });

        mockDrupalAuth.post.mockResolvedValue({
          success: true,
          uuid: "new-announcement-uuid",
          title: "Test",
        });

        await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "create_announcement",
            arguments: {
              title: "Test",
              body: "Body",
              summary: "Summary",
              tags: ["gpu", "maintenance"],
            },
          },
        });

        expect(mockDrupalAuth.get).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/jsonapi/taxonomy_term/tags?page[limit]=50"
        );

        // Tags sent as field_tags: a flat array of UUIDs (controller resolves field_tags by uuid).
        expect(mockDrupalAuth.post).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/api/2.3/announcements",
          expect.objectContaining({
            field_tags: ["tag-uuid-1", "tag-uuid-2"],
          })
        );
      });

      it("should fail without credentials", async () => {
        delete process.env.DRUPAL_API_URL;

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "create_announcement",
            arguments: {
              title: "Test",
              body: "Body",
            },
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.error.message).toContain("DRUPAL_API_URL");
      });

      it("should fail without ACTING_USER", async () => {
        delete process.env.ACTING_USER;

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "create_announcement",
            arguments: {
              title: "Test",
              body: "Body",
              summary: "Summary",
            },
          },
        });

        const text = (result.content[0] as TextContent).text;
        expect(text).toMatch(/authenticate with your ACCESS-CI credentials/i);
        expect(mockDrupalAuth.post).not.toHaveBeenCalled();
      });

      it("should use actingUser from request context when env var not set", async () => {
        delete process.env.ACTING_USER;

        mockDrupalAuth.post.mockResolvedValue({
          data: {
            id: "new-announcement-uuid",
            attributes: {
              title: "Test",
              drupal_internal__nid: 12345,
            },
          },
        });

        const context: RequestContext = {
          actingUser: "contextuser@access-ci.org",
        };

        const result = await requestContextStorage.run(context, async () => {
          return server["handleToolCall"]({
            method: "tools/call",
            params: {
              name: "create_announcement",
              arguments: {
                title: "Test",
                body: "Body",
                summary: "Summary",
              },
            },
          });
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData).toMatchObject({
          action: "create",
          status: "created",
          executed: true,
        });
      });

      it("should prefer request context actingUser over env var", async () => {
        process.env.ACTING_USER = "envuser@access-ci.org";

        mockDrupalAuth.post.mockResolvedValue({
          data: {
            id: "new-announcement-uuid",
            attributes: { title: "Test" },
          },
        });

        const context: RequestContext = {
          actingUser: "contextuser@access-ci.org",
        };

        await requestContextStorage.run(context, async () => {
          return server["handleToolCall"]({
            method: "tools/call",
            params: {
              name: "create_announcement",
              arguments: {
                title: "Test",
                body: "Body",
                summary: "Summary",
              },
            },
          });
        });

        // context value takes priority over env: post uses the context actor
        expect(mockDrupalAuth.post).toHaveBeenCalledWith(
          "contextuser@access-ci.org",
          expect.any(String),
          expect.anything()
        );
      });

      it("should set actingUser on DrupalAuth from request context", async () => {
        const context: RequestContext = {
          actingUser: "researcher@access-ci.org",
        };

        mockDrupalAuth.post.mockResolvedValue({
          data: {
            id: "new-announcement-uuid",
            attributes: { title: "Test" },
          },
        });

        await requestContextStorage.run(context, async () => {
          return server["handleToolCall"]({
            method: "tools/call",
            params: {
              name: "create_announcement",
              arguments: {
                title: "Test",
                body: "Body",
                summary: "Summary",
              },
            },
          });
        });

        expect(mockDrupalAuth.post).toHaveBeenCalledWith(
          "researcher@access-ci.org",
          expect.any(String),
          expect.anything()
        );
      });

      it("should create announcement with external link", async () => {
        mockDrupalAuth.post.mockResolvedValue({
          success: true,
          uuid: "new-announcement-uuid",
          nid: 12345,
          title: "Test with Link",
        });

        await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "create_announcement",
            arguments: {
              title: "Test with Link",
              body: "<p>Body content</p>",
              summary: "Test summary",
              external_link: {
                uri: "https://example.com/resource",
                title: "Learn more",
              },
            },
          },
        });

        expect(mockDrupalAuth.post).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/api/2.3/announcements",
          expect.objectContaining({
            field_news_external_link: {
              uri: "https://example.com/resource",
              title: "Learn more",
            },
          })
        );
      });

      it("should create announcement with where_to_share", async () => {
        mockDrupalAuth.post.mockResolvedValue({
          success: true,
          uuid: "new-announcement-uuid",
          nid: 12345,
          title: "Test with sharing",
        });

        await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "create_announcement",
            arguments: {
              title: "Test with sharing",
              body: "<p>Body content</p>",
              summary: "Test summary",
              where_to_share: ["Announcements page", "Bi-Weekly Digest"],
            },
          },
        });

        expect(mockDrupalAuth.post).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/api/2.3/announcements",
          expect.objectContaining({
            field_choose_where_to_share_this: [
              "on_the_announcements_page",
              "in_the_access_support_bi_weekly_digest",
            ],
          })
        );
      });

      it("should fail with invalid where_to_share value", async () => {
        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "create_announcement",
            arguments: {
              title: "Test",
              body: "Body",
              summary: "Summary",
              where_to_share: ["Invalid Option"],
            },
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.error.message).toContain("Invalid where_to_share value");
      });

      it("should create announcement with affinity group", async () => {
        // Affinity group lookup by title (first by field_group_id returns empty, then by title)
        mockDrupalAuth.get.mockResolvedValueOnce({ data: [] });
        mockDrupalAuth.get.mockResolvedValueOnce({
          data: [{ id: "group-uuid-456", attributes: { title: "Test Group" } }],
        });

        mockDrupalAuth.post.mockResolvedValue({
          success: true,
          uuid: "new-announcement-uuid",
          nid: 12345,
          title: "Test with group",
        });

        await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "create_announcement",
            arguments: {
              title: "Test with group",
              body: "<p>Body content</p>",
              summary: "Test summary",
              affinity_group: "Test Group",
            },
          },
        });

        // Affinity group sent as its resolved UUID (controller resolves
        // field_affinity_group_node by uuid — settled identifier contract).
        expect(mockDrupalAuth.post).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/api/2.3/announcements",
          expect.objectContaining({
            field_affinity_group_node: ["group-uuid-456"],
          })
        );
      });

      it("should fail when affinity group not found", async () => {
        // Both lookups return empty
        mockDrupalAuth.get.mockResolvedValueOnce({ data: [] });
        mockDrupalAuth.get.mockResolvedValueOnce({ data: [] });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "create_announcement",
            arguments: {
              title: "Test",
              body: "Body",
              summary: "Summary",
              affinity_group: "Nonexistent Group",
            },
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.error.message).toContain("Affinity group not found");
      });
    });

    describe("update_announcement", () => {
      it("should update an announcement", async () => {
        mockDrupalAuth.patch.mockResolvedValue({
          success: true,
          uuid: "announcement-uuid",
          title: "Updated Title",
          edit_url: "https://test.drupal.site/node/12345/edit",
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "update_announcement",
            arguments: {
              uuid: "announcement-uuid",
              title: "Updated Title",
            },
          },
        });

        // New custom controller: flat body of only changed fields, PATCH to /api/2.3/announcements/{uuid}.
        expect(mockDrupalAuth.patch).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/api/2.3/announcements/announcement-uuid",
          expect.objectContaining({
            title: "Updated Title",
          })
        );
        const [, , patchedBody] = mockDrupalAuth.patch.mock.calls[0];
        expect(patchedBody).not.toHaveProperty("data");

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData).toMatchObject({
          action: "update",
          status: "updated",
          executed: true,
          data: {
            uuid: "announcement-uuid",
            title: "Updated Title",
            edit_url: "https://test.drupal.site/node/12345/edit",
          },
        });
        expect(responseData).not.toHaveProperty("success");
        // Update never carries nid in its data.
        expect(responseData.data).not.toHaveProperty("nid");
      });

      it("should leave edit_url null when the controller omits it (no nid fallback)", async () => {
        mockDrupalAuth.patch.mockResolvedValue({
          success: true,
          uuid: "announcement-uuid",
          title: "Updated Title",
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "update_announcement",
            arguments: {
              uuid: "announcement-uuid",
              title: "Updated Title",
            },
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.data.edit_url).toBeNull();
      });

      it("should surface skipped tags as a top-level warning in the envelope", async () => {
        mockDrupalAuth.get.mockResolvedValueOnce({
          data: [{ id: "tag-uuid-1", attributes: { name: "gpu" } }],
        });

        mockDrupalAuth.patch.mockResolvedValue({
          success: true,
          uuid: "announcement-uuid",
          title: "Test",
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "update_announcement",
            arguments: {
              uuid: "announcement-uuid",
              tags: ["gpu", "nonexistent-tag"],
            },
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.action).toBe("update");
        expect(responseData.status).toBe("updated");
        expect(responseData.warning).toContain("were skipped");
        expect(responseData.warning).toContain("nonexistent-tag");
      });

      it("should send only the summary field when updating summary only (no pre-read)", async () => {
        mockDrupalAuth.patch.mockResolvedValue({
          success: true,
          uuid: "announcement-uuid",
          title: "Test",
        });

        await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "update_announcement",
            arguments: {
              uuid: "announcement-uuid",
              summary: "New summary only",
            },
          },
        });

        // The new controller applies only the fields sent; no fetch-and-preserve pre-read.
        expect(mockDrupalAuth.get).not.toHaveBeenCalled();
        // Summary is nested inside body — {body: {summary}} — with no value key
        // (title unchanged) and no top-level summary.
        expect(mockDrupalAuth.patch).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/api/2.3/announcements/announcement-uuid",
          { body: { summary: "New summary only" } }
        );
        const [, , patchedBody] = mockDrupalAuth.patch.mock.calls[0];
        expect(patchedBody).not.toHaveProperty("summary");
        expect(patchedBody.body).not.toHaveProperty("value");
      });

      it("should update with tags", async () => {
        // Tag cache fetch
        mockDrupalAuth.get.mockResolvedValueOnce({
          data: [
            { id: "tag-uuid-1", attributes: { name: "gpu" } },
            { id: "tag-uuid-2", attributes: { name: "hpc" } },
          ],
        });

        mockDrupalAuth.patch.mockResolvedValue({
          success: true,
          uuid: "announcement-uuid",
          title: "Test",
        });

        await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "update_announcement",
            arguments: {
              uuid: "announcement-uuid",
              tags: ["gpu", "hpc"],
            },
          },
        });

        expect(mockDrupalAuth.patch).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/api/2.3/announcements/announcement-uuid",
          expect.objectContaining({
            field_tags: ["tag-uuid-1", "tag-uuid-2"],
          })
        );
      });

      it("should fail without an acting user and make no provider call", async () => {
        delete process.env.ACTING_USER;

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "update_announcement",
            arguments: {
              uuid: "announcement-uuid",
              title: "Updated Title",
            },
          },
        });

        const text = (result.content[0] as TextContent).text;
        expect(text).toMatch(/authenticate with your ACCESS-CI credentials/i);
        expect(mockDrupalAuth.patch).not.toHaveBeenCalled();
        expect(mockDrupalAuth.get).not.toHaveBeenCalled();
      });
    });

    describe("delete_announcement", () => {
      it("should delete an announcement when confirmed", async () => {
        mockDrupalAuth.delete.mockResolvedValue({
          success: true,
          uuid: "announcement-to-delete",
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "delete_announcement",
            arguments: {
              uuid: "announcement-to-delete",
              confirmed: true,
            },
          },
        });

        expect(mockDrupalAuth.delete).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/api/2.3/announcements/announcement-to-delete"
        );

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData).toEqual({
          action: "delete",
          status: "deleted",
          executed: true,
          data: { uuid: "announcement-to-delete" },
        });
      });

      // The preview's /mine lookup has its own catch that coded EVERY
      // DrupalApiError as upstream_error, which swallowed a persistent auth
      // failure before the tool-call-level mapping could see it. An expired
      // session must read as unauthenticated here too, not as a vague upstream
      // fault that suggests retrying.
      it("preview surfaces a persistent 3xx as unauthenticated, not upstream_error", async () => {
        mockDrupalAuth.get.mockRejectedValueOnce(
          new DrupalApiError("Drupal API error: 307 Temporary Redirect", 307, "")
        );

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "delete_announcement",
            arguments: { uuid: "a-1", confirmed: false },
          },
        });

        expect(result.isError).toBe(true);
        const parsed = JSON.parse((result.content[0] as TextContent).text);
        expect(parsed.error.code).toBe("unauthenticated");
        expect(parsed.error.code).not.toBe("upstream_error");
        expect(parsed.error.message).not.toContain("307");
        // Nothing was written on a failed preview.
        expect(mockDrupalAuth.delete).not.toHaveBeenCalled();
      });

      it("preview surfaces a failed re-login as reauth_failed", async () => {
        mockDrupalAuth.get.mockRejectedValueOnce(
          new DrupalApiError(
            "Drupal session expired and re-authentication failed: Drupal login failed: 503 Service Unavailable",
            401,
            undefined,
            "reauth_failed"
          )
        );

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "delete_announcement",
            arguments: { uuid: "a-1", confirmed: false },
          },
        });

        const parsed = JSON.parse((result.content[0] as TextContent).text);
        expect(parsed.error.code).toBe("reauth_failed");
      });

      it("preview still codes a non-auth Drupal failure as upstream_error", async () => {
        mockDrupalAuth.get.mockRejectedValueOnce(
          new DrupalApiError("Drupal API error (500): boom", 500, { errors: [{ detail: "boom" }] })
        );

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "delete_announcement",
            arguments: { uuid: "a-1", confirmed: false },
          },
        });

        const parsed = JSON.parse((result.content[0] as TextContent).text);
        expect(parsed.error.code).toBe("upstream_error");
      });

      it("should PREVIEW (not delete) when confirmed is false, reading the title from /mine", async () => {
        mockDrupalAuth.get.mockResolvedValueOnce({
          items: [
            {
              uuid: "a-1",
              nid: 111,
              title: "My Post",
              status: "draft",
              summary: "Summary",
              tags: [],
              edit_url: "https://test.drupal.site/node/111/edit",
            },
          ],
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "delete_announcement",
            arguments: {
              uuid: "a-1",
              confirmed: false,
            },
          },
        });

        // Preview writes NOTHING.
        expect(mockDrupalAuth.delete).not.toHaveBeenCalled();

        // RECON-2 (#30 follow-up): the preview reads /mine with an explicit high
        // limit so a user owning more announcements than the controller's default
        // page cap can still find (and preview-delete) any of their own.
        expect(mockDrupalAuth.get).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/api/2.3/announcements/mine?limit=1000"
        );

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData).toEqual({
          action: "delete",
          status: "preview",
          executed: false,
          data: { uuid: "a-1", title: "My Post" },
        });
      });

      it("should NOT delete when confirmed is truthy-but-not-strict-true (falls to preview)", async () => {
        mockDrupalAuth.get.mockResolvedValueOnce({
          items: [{ uuid: "a-1", title: "My Post" }],
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "delete_announcement",
            arguments: {
              uuid: "a-1",
              // truthy but not strictly === true
              confirmed: "true" as unknown as boolean,
            },
          },
        });

        expect(mockDrupalAuth.delete).not.toHaveBeenCalled();

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.status).toBe("preview");
        expect(responseData.executed).toBe(false);
      });

      it("should return a not_found error when the preview uuid is not among the user's announcements", async () => {
        mockDrupalAuth.get.mockResolvedValueOnce({
          items: [{ uuid: "other-1", title: "Not the one" }],
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "delete_announcement",
            arguments: {
              uuid: "missing-1",
              confirmed: false,
            },
          },
        });

        expect(mockDrupalAuth.delete).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.error.code).toBe("not_found");
      });

      it("should return a not_found error when the delete returns 404", async () => {
        // Post-#30: the handler branches on the DrupalApiError.status, not a
        // string-match of the message, so the mock throws a real DrupalApiError.
        mockDrupalAuth.delete.mockRejectedValueOnce(
          new DrupalApiError("Drupal API error: 404 Not Found", 404, {
            errors: [{ detail: "Not Found" }],
          })
        );

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "delete_announcement",
            arguments: {
              uuid: "gone-1",
              confirmed: true,
            },
          },
        });

        expect(result.isError).toBe(true);
        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.error.code).toBe("not_found");
      });

      it("should fail without an acting user and make no provider call", async () => {
        delete process.env.ACTING_USER;

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "delete_announcement",
            arguments: {
              uuid: "announcement-to-delete",
              confirmed: true,
            },
          },
        });

        const text = (result.content[0] as TextContent).text;
        expect(text).toMatch(/authenticate with your ACCESS-CI credentials/i);
        expect(mockDrupalAuth.delete).not.toHaveBeenCalled();
      });

      // The PREVIEW lookup (GET /mine) can itself throw. A failed list-fetch
      // means "the lookup failed", never "your announcement is absent" — it must
      // carry a coded upstream_error (not a bare, uncoded {error}), and never
      // delete.
      it("preview → a DrupalApiError on the /mine lookup maps to a coded upstream_error", async () => {
        mockDrupalAuth.get.mockRejectedValueOnce(
          new DrupalApiError("Drupal API error: 500 Server Error", 500, {
            errors: [{ detail: "boom" }],
          })
        );

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "delete_announcement",
            arguments: { uuid: "any-1", confirmed: false },
          },
        });

        expect(result.isError).toBe(true);
        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.error.code).toBe("upstream_error");
        expect(responseData.error.code).not.toBe("not_found");
        expect(mockDrupalAuth.delete).not.toHaveBeenCalled();
      });
    });

    describe("get_my_announcements", () => {
      it("should fetch announcements via the mine endpoint without user UUID lookup", async () => {
        mockDrupalAuth.get.mockResolvedValueOnce({
          items: [
            {
              uuid: "announcement-1",
              nid: 111,
              title: "My First Announcement",
              status: "draft",
              created: "2024-03-15T10:00:00Z",
              published_date: "2024-03-15",
              summary: "Summary",
              tags: ["gpu", "maintenance"],
              edit_url: "https://test.drupal.site/node/111/edit",
            },
          ],
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_my_announcements",
            arguments: { limit: 10 },
          },
        });

        // Should make exactly 1 call — no user UUID lookup
        expect(mockDrupalAuth.get).toHaveBeenCalledTimes(1);
        expect(mockDrupalAuth.get).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/api/2.3/announcements/mine?limit=11"
        );

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.items).toHaveLength(1);
        expect(responseData.items[0].title).toBe("My First Announcement");
        // status is already a string from the controller — used verbatim.
        expect(responseData.items[0].status).toBe("draft");
        // tags come back as english NAMES from the controller — passed through verbatim.
        expect(responseData.items[0].tags).toEqual(["gpu", "maintenance"]);
      });

      // An expired Drupal session arrives as a 3xx CILogon bounce. The shared
      // auth layer re-logs-in and retries, so reaching here means recovery
      // itself failed — the user must get the structured auth error, not the
      // raw "Drupal API error: 307 Temporary Redirect" upstream string.
      it("surfaces a persistent 3xx as the structured auth error, not the generic message", async () => {
        mockDrupalAuth.get.mockRejectedValueOnce(
          new DrupalApiError("Drupal API error: 307 Temporary Redirect", 307, "")
        );

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: { name: "get_my_announcements", arguments: {} },
        });

        expect(result.isError).toBe(true);
        const parsed = JSON.parse((result.content[0] as TextContent).text);
        expect(parsed.error.code).toBe("unauthenticated");
        expect(parsed.error.message).toMatch(/session may have expired/i);
        expect(parsed.error.message).not.toContain("307");
      });

      it("surfaces a failed re-login as reauth_failed", async () => {
        mockDrupalAuth.get.mockRejectedValueOnce(
          new DrupalApiError(
            "Drupal session expired and re-authentication failed: Drupal login failed: 503 Service Unavailable",
            401,
            undefined,
            "reauth_failed"
          )
        );

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: { name: "get_my_announcements", arguments: {} },
        });

        const parsed = JSON.parse((result.content[0] as TextContent).text);
        expect(parsed.error.code).toBe("reauth_failed");
      });

      it("leaves a non-auth Drupal error on its existing generic path", async () => {
        mockDrupalAuth.get.mockRejectedValueOnce(
          new DrupalApiError("Drupal API error (500): boom", 500, { errors: [{ detail: "boom" }] })
        );

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: { name: "get_my_announcements", arguments: {} },
        });

        const parsed = JSON.parse((result.content[0] as TextContent).text);
        expect(parsed.error.code).not.toBe("unauthenticated");
        expect(parsed.error.message).toContain("boom");
      });

      it("should use default limit of 25", async () => {
        mockDrupalAuth.get.mockResolvedValueOnce({ items: [] });

        await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_my_announcements",
            arguments: {},
          },
        });

        expect(mockDrupalAuth.get).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/api/2.3/announcements/mine?limit=26"
        );
      });

      it("should pass through controller-computed status, summary, and edit_url verbatim", async () => {
        mockDrupalAuth.get.mockResolvedValueOnce({
          items: [
            {
              uuid: "ann-published",
              nid: 999,
              title: "Published One",
              status: "published",
              created: "2024-03-15T10:00:00Z",
              published_date: "2024-03-15",
              summary: "Short summary",
              edit_url: "https://test.drupal.site/node/999/edit",
            },
            {
              uuid: "ann-draft",
              nid: 1000,
              title: "Draft One",
              status: "draft",
              created: "2024-03-14T10:00:00Z",
              published_date: null,
              summary: "Draft body",
              edit_url: "https://test.drupal.site/node/1000/edit",
            },
          ],
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_my_announcements",
            arguments: {},
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.total).toBe(2);

        // Published announcement — fields passed straight through.
        expect(responseData.items[0].uuid).toBe("ann-published");
        expect(responseData.items[0].status).toBe("published");
        expect(responseData.items[0].nid).toBe(999);
        expect(responseData.items[0].edit_url).toBe("https://test.drupal.site/node/999/edit");
        expect(responseData.items[0].published_date).toBe("2024-03-15");
        expect(responseData.items[0].summary).toBe("Short summary");

        // Draft announcement — status string used verbatim, summary already stripped.
        expect(responseData.items[1].uuid).toBe("ann-draft");
        expect(responseData.items[1].status).toBe("draft");
        expect(responseData.items[1].edit_url).toBe("https://test.drupal.site/node/1000/edit");
        expect(responseData.items[1].summary).toBe("Draft body");
      });

      it("should handle empty results from the mine endpoint", async () => {
        mockDrupalAuth.get.mockResolvedValueOnce({ items: [] });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_my_announcements",
            arguments: {},
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.total).toBe(0);
        expect(responseData.items).toEqual([]);
      });

      it("should use acting user from request context", async () => {
        delete process.env.ACTING_USER;

        mockDrupalAuth.get.mockResolvedValueOnce({ items: [] });

        const context: RequestContext = {
          actingUser: "contextuser@access-ci.org",
        };

        const result = await requestContextStorage.run(context, async () => {
          return server["handleToolCall"]({
            method: "tools/call",
            params: {
              name: "get_my_announcements",
              arguments: {},
            },
          });
        });

        // Should succeed — acting user comes from request context
        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.total).toBe(0);
        expect(mockDrupalAuth.get).toHaveBeenCalledTimes(1);
      });

      it("emits total_lower_bound and honest has_more from the limit+1 probe", async () => {
        mockDrupalAuth.get.mockResolvedValueOnce({
          items: Array.from({ length: 26 }, (_, i) => ({
            uuid: `ann-${i}`,
            nid: i,
            title: `Announcement ${i}`,
            status: "published",
            created: "2024-03-15T10:00:00Z",
            published_date: "2024-03-15",
            summary: "Summary",
            tags: [],
            edit_url: null,
          })),
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_my_announcements",
            arguments: { limit: 25 },
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        // 26 items came back for a limit+1=26 fetch, so has_more is true and
        // the page is sliced back down to 25 — total is a lower bound (what
        // we can prove exists), not a fabricated exact count.
        expect(responseData.items).toHaveLength(25);
        expect(responseData.total).toBe(25);
        expect(responseData.metadata.pagination.total_lower_bound).toBe(25);
        expect(responseData.metadata.pagination.has_more).toBe(true);
        expect(responseData.metadata.pagination.offset).toBe(0);
      });

      it("coerces a negative limit to the default (no negative fetch param, no from-end slice)", async () => {
        mockDrupalAuth.get.mockResolvedValueOnce({
          items: Array.from({ length: 10 }, (_, i) => ({
            uuid: `ann-${i}`,
            nid: i,
            title: `Announcement ${i}`,
            status: "published",
            created: "2024-03-15T10:00:00Z",
            published_date: "2024-03-15",
            summary: "Summary",
            tags: [],
            edit_url: null,
          })),
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_my_announcements",
            arguments: { limit: -5 },
          },
        });

        // Negative limit coerces to the default (25), never a negative
        // fetch param and never a slice-from-the-end.
        expect(mockDrupalAuth.get).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/api/2.3/announcements/mine?limit=26"
        );

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.items).toHaveLength(10);
        expect(responseData.items[0].title).toBe("Announcement 0");
        expect(responseData.metadata.pagination.limit).toBe(25);
      });

      it("coerces a NaN limit to the default", async () => {
        mockDrupalAuth.get.mockResolvedValueOnce({ items: [] });

        await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_my_announcements",
            arguments: { limit: Number.NaN },
          },
        });

        expect(mockDrupalAuth.get).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/api/2.3/announcements/mine?limit=26"
        );
      });

      it("limit:0 is reachable post-fix: count-only items:[], has_more still honest from the probe", async () => {
        mockDrupalAuth.get.mockResolvedValueOnce({
          items: [{ uuid: "ann-0", nid: 0, title: "Announcement 0" }],
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_my_announcements",
            arguments: { limit: 0 },
          },
        });

        // coerceLimit(0, 25) preserves the explicit 0 (unlike the old `|| 25`,
        // which silently overrode it). The fetch becomes limit=1 (0+1 probe).
        expect(mockDrupalAuth.get).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/api/2.3/announcements/mine?limit=1"
        );

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.items).toEqual([]);
        expect(responseData.total).toBe(0);
        expect(responseData.metadata.pagination.total_lower_bound).toBe(0);
        // The probe fetched 1 item and sliced to 0, so has_more is honestly true.
        expect(responseData.metadata.pagination.has_more).toBe(true);
        expect(responseData.metadata.pagination.offset).toBe(0);
      });

      it("coerces fractional limit to integer (adversarial input)", async () => {
        mockDrupalAuth.get.mockResolvedValueOnce({
          items: Array.from({ length: 10 }, (_, i) => ({
            uuid: `ann-${i}`,
            nid: i,
            title: `Announcement ${i}`,
            status: "published",
            created: "2024-03-15T10:00:00Z",
            published_date: "2024-03-15",
            summary: "Summary",
            tags: [],
            edit_url: null,
          })),
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_my_announcements",
            arguments: { limit: 5.9 },
          },
        });

        // Fractional limit should be floored to 5
        expect(mockDrupalAuth.get).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/api/2.3/announcements/mine?limit=6"
        );

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.metadata.pagination.limit).toBe(5);
        expect(responseData.items).toHaveLength(5);
      });
    });

    describe("get_announcement_context", () => {
      it("should fetch affinity groups without tags", async () => {
        mockDrupalAuth.get.mockResolvedValueOnce({
          data: [
            {
              id: "group-uuid-1",
              attributes: {
                title: "Test Group",
                field_group_id: 123,
                field_affinity_group_category: "Research",
              },
            },
          ],
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_announcement_context",
            arguments: {},
          },
        });

        // Only 1 call — affinity groups view, no tags fetch
        expect(mockDrupalAuth.get).toHaveBeenCalledTimes(1);
        expect(mockDrupalAuth.get).toHaveBeenCalledWith(
          "testuser@access-ci.org",
          "/jsonapi/views/mcp_my_affinity_groups/page_1"
        );

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        // Should NOT return tags
        expect(responseData).not.toHaveProperty("tags");
        expect(responseData.affinity_groups).toHaveLength(1);
        expect(responseData.affinity_groups[0].name).toBe("Test Group");
        expect(responseData.is_coordinator).toBe(true);
        expect(responseData.affiliations).toContain("ACCESS Collaboration");
        expect(responseData.affiliations).toContain("Community");
        expect(responseData.where_to_share_options).toHaveLength(4);
        expect(responseData.guidance).toContain("coordinator");
      });

      it("should indicate non-coordinator when views returns no affinity groups", async () => {
        mockDrupalAuth.get.mockResolvedValueOnce({
          data: [],
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_announcement_context",
            arguments: {},
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.is_coordinator).toBe(false);
        expect(responseData.affinity_groups).toHaveLength(0);
        expect(responseData.guidance).toContain("not a coordinator");
      });

      it("should fail without acting user", async () => {
        delete process.env.ACTING_USER;

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "get_announcement_context",
            arguments: {},
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.error.message).toContain("No acting user specified");
        expect(mockDrupalAuth.get).not.toHaveBeenCalled();
      });

      it("should use acting user from request context", async () => {
        delete process.env.ACTING_USER;

        mockDrupalAuth.get.mockResolvedValueOnce({ data: [] });

        const context: RequestContext = {
          actingUser: "contextuser@access-ci.org",
        };

        const result = await requestContextStorage.run(context, async () => {
          return server["handleToolCall"]({
            method: "tools/call",
            params: {
              name: "get_announcement_context",
              arguments: {},
            },
          });
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData).not.toHaveProperty("tags");
        expect(responseData.is_coordinator).toBe(false);
        expect(mockDrupalAuth.get).toHaveBeenCalledTimes(1);
      });
    });

    describe("suggest_tags", () => {
      it("should return error when text is too short", async () => {
        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "suggest_tags",
            arguments: { text: "Short text" },
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.error.message).toContain("at least 100 characters");
      });

      it("should return error when text is empty", async () => {
        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "suggest_tags",
            arguments: { text: "" },
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.error.message).toContain("at least 100 characters");
      });

      it("should return suggested tags on success", async () => {
        const longText = "A".repeat(150);
        mockDrupalAuth.post.mockResolvedValueOnce({
          tags: [
            { tid: 1, name: "ai", uuid: "uuid-1" },
            { tid: 2, name: "hpc", uuid: "uuid-2" },
          ],
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "suggest_tags",
            arguments: { text: longText },
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.suggested_tags).toEqual(["ai", "hpc"]);
        expect(responseData.tag_details).toHaveLength(2);
      });

      it("should truncate results to the specified limit", async () => {
        const longText = "A".repeat(150);
        mockDrupalAuth.post.mockResolvedValueOnce({
          tags: [
            { tid: 1, name: "ai", uuid: "uuid-1" },
            { tid: 2, name: "hpc", uuid: "uuid-2" },
            { tid: 3, name: "gpu", uuid: "uuid-3" },
          ],
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "suggest_tags",
            arguments: { text: longText, limit: 2 },
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.suggested_tags).toHaveLength(2);
        expect(responseData.tag_details).toHaveLength(2);
      });

      it("should fail without an acting user and make no provider call", async () => {
        delete process.env.ACTING_USER;

        // >100 chars so it clears the length gate and reaches the actor
        // check — with short text the handler returns the length error first
        // and this test would pass without exercising acting-user enforcement.
        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: { name: "suggest_tags", arguments: { text: "A".repeat(150) } },
        });

        const text = (result.content[0] as TextContent).text;
        expect(text).toMatch(/authenticate with your ACCESS-CI credentials/i);
        expect(mockDrupalAuth.post).not.toHaveBeenCalled();
      });
    });

    describe("suggest_summary", () => {
      it("should return error when text is too short", async () => {
        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "suggest_summary",
            arguments: { text: "Short text" },
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.error.message).toContain("at least 100 characters");
      });

      it("should return summary on success", async () => {
        const longText = "A".repeat(150);
        mockDrupalAuth.post.mockResolvedValueOnce({
          summary: "A test summary of the content.",
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "suggest_summary",
            arguments: { text: longText },
          },
        });

        const responseData = JSON.parse((result.content[0] as TextContent).text);
        expect(responseData.summary).toBe("A test summary of the content.");
      });

      it("should fail without an acting user and make no provider call", async () => {
        delete process.env.ACTING_USER;

        // >100 chars so it clears the length gate and reaches the actor
        // check — with short text the handler returns the length error first
        // and this test would pass without exercising acting-user enforcement.
        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: { name: "suggest_summary", arguments: { text: "A".repeat(150) } },
        });

        const text = (result.content[0] as TextContent).text;
        expect(text).toMatch(/authenticate with your ACCESS-CI credentials/i);
        expect(mockDrupalAuth.post).not.toHaveBeenCalled();
      });
    });
  });

  describe("Resources", () => {
    it("should read accessci://announcements resource", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: [
          {
            uuid: "test-uuid-1",
            title: "Test Announcement",
            body: "<p>Content</p>",
            published_date: "2024-03-15",
            tags: "gpu,hpc",
            affinity_group: [],
          },
        ],
      });

      const result = await server["handleResourceRead"]({
        method: "resources/read",
        params: {
          uri: "accessci://announcements",
        },
      });

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe("accessci://announcements");
      expect(result.contents[0].mimeType).toBe("application/json");

      const data = JSON.parse(result.contents[0].text as string);
      expect(data).toHaveLength(1);
      expect(data[0].title).toBe("Test Announcement");
    });

    it("should handle resource read errors", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 500,
        statusText: "Internal Server Error",
      });

      const result = await server["handleResourceRead"]({
        method: "resources/read",
        params: {
          uri: "accessci://announcements",
        },
      });

      expect(result.contents[0].text).toContain("Error loading announcements");
    });

    it("should throw for unknown resource", async () => {
      await expect(
        server["handleResourceRead"]({
          method: "resources/read",
          params: {
            uri: "accessci://unknown",
          },
        })
      ).rejects.toThrow("Unknown resource");
    });
  });

  describe("Prompts", () => {
    it("should return create_announcement_guide prompt", async () => {
      const result = await server["handleGetPrompt"]({
        params: {
          name: "create_announcement_guide",
          arguments: {},
        },
      });

      expect(result.description).toBe("Guide for creating an ACCESS announcement");
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[1].role).toBe("assistant");
    });

    it("should include topic in create_announcement_guide", async () => {
      const result = await server["handleGetPrompt"]({
        params: {
          name: "create_announcement_guide",
          arguments: { topic: "GPU availability" },
        },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP SDK prompt message content type
      expect((result.messages[0].content as any).text).toContain("GPU availability");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP SDK prompt message content type
      expect((result.messages[1].content as any).text).toContain("GPU availability");
    });

    it("should return manage_announcements_guide prompt", async () => {
      const result = await server["handleGetPrompt"]({
        params: {
          name: "manage_announcements_guide",
          arguments: {},
        },
      });

      expect(result.description).toBe("Guide for managing existing announcements");
      expect(result.messages).toHaveLength(2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP SDK prompt message content type
      expect((result.messages[1].content as any).text).toContain("get_my_announcements");
    });

    it("should throw for unknown prompt", async () => {
      await expect(
        server["handleGetPrompt"]({
          params: {
            name: "unknown_prompt",
            arguments: {},
          },
        })
      ).rejects.toThrow("Unknown prompt");
    });
  });

  describe("Unknown Tool", () => {
    it("should return error for unknown tool", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "unknown_tool",
          arguments: {},
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.error.message).toContain("Unknown tool");
    });
  });

  describe("fields projection (Pillar 2)", () => {
    const mockAnnouncements = {
      status: 200,
      data: [
        {
          title: "Scheduled Maintenance",
          body: "System will be down for maintenance",
          published_date: "2024-03-15",
          author: "ACCESS Support",
          tags: ["maintenance"],
          url: "https://support.access-ci.org/announcements/scheduled-maintenance",
        },
      ],
    };

    it("should project search_announcements response to requested fields only", async () => {
      mockHttpClient.get.mockResolvedValue(mockAnnouncements);

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: { fields: ["total", "items[].title"] },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.total).toBe(1);
      expect(Object.keys(responseData.items[0])).toEqual(["title"]);
      expect(responseData.items[0].title).toBe("Scheduled Maintenance");
      // metadata + documentation are sticky containers — preserved on
      // projection so the agent doesn't lose pagination/see_all_url signals.
      expect(responseData.metadata).toBeDefined();
      expect(responseData.documentation).toBeDefined();
    });

    it("should always preserve total even when fields omits it", async () => {
      mockHttpClient.get.mockResolvedValue(mockAnnouncements);

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: { fields: ["metadata.pagination.has_more"] },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.total).toBe(1);
      expect(responseData.metadata.pagination.has_more).toBeDefined();
      expect(responseData.items).toBeUndefined();
    });

    it("should project filtered search_announcements response (second handler path)", async () => {
      mockHttpClient.get.mockResolvedValue(mockAnnouncements);

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: { tags: "maintenance", fields: ["total", "items[].title"] },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.total).toBe(1);
      expect(Object.keys(responseData.items[0])).toEqual(["title"]);
    });

    it("should advertise fields parameter and supportsFieldProjection on opted-in tools", () => {
      const tools = server["getTools"]();

      const searchTool = tools.find((t: { name: string }) => t.name === "search_announcements");
      expect(searchTool?.inputSchema.properties?.fields).toBeDefined();
      expect((searchTool as { _meta?: { supportsFieldProjection?: boolean } })._meta?.supportsFieldProjection).toBe(true);

      const myTool = tools.find((t: { name: string }) => t.name === "get_my_announcements");
      expect(myTool?.inputSchema.properties?.fields).toBeDefined();
      expect((myTool as { _meta?: { supportsFieldProjection?: boolean } })._meta?.supportsFieldProjection).toBe(true);
    });

    it("write-tool descriptions document the write envelope (status/executed) and delete's preview-by-default", () => {
      const tools = server["getTools"]();
      const create = tools.find((t: { name: string }) => t.name === "create_announcement")!;
      const update = tools.find((t: { name: string }) => t.name === "update_announcement")!;
      const del = tools.find((t: { name: string }) => t.name === "delete_announcement")!;

      expect(create.description).toContain("write envelope");
      expect(create.description).toContain("created");
      expect(update.description).toContain("write envelope");
      expect(update.description).toContain("updated");

      // delete: write envelope + preview-by-default (confirmed required).
      expect(del.description).toContain("write envelope");
      expect(del.description).toContain("preview");
      expect(del.description).toContain("deleted");
      expect(del.description).toContain("REQUIRED");
    });
  });

  // ---------------------------------------------------------------------------
  // Write-contract conformance (Phase 2, Task 5)
  //
  // The core guarantee of the write-contract migration: EVERY write tool emits
  // the exact StandardWriteResponse envelope — {action, status, executed} always
  // present, {data, warning} optional, and NO other top-level key (especially NO
  // legacy `changed`/`success`). Plus the `executed` truth table per status.
  // ---------------------------------------------------------------------------
  describe("write-contract conformance", () => {
    // Structural contract (keys/actions/no-changed/boolean-executed) is asserted
    // by the shared assertWriteEnvelope. Only the STATUS vocabulary is per-server
    // — announcements never emits `cancelled` (events does).
    const STATUS_VOCAB = new Set([
      "preview",
      "registered",
      "waitlisted",
      "already_registered",
      "created",
      "updated",
      "deleted",
    ]);
    const assertEnvelope = (parsed: Record<string, unknown>) =>
      assertWriteEnvelope(parsed, STATUS_VOCAB, expect);

    let mockDrupalAuth: {
      ensureAuthenticated: Mock;
      getUserUuid: Mock;
      get: Mock;
      post: Mock;
      patch: Mock;
      delete: Mock;
    };

    beforeEach(() => {
      process.env.DRUPAL_API_URL = "https://test.drupal.site";
      process.env.DRUPAL_USERNAME = "test_user";
      process.env.DRUPAL_PASSWORD = "test_password";
      process.env.ACTING_USER = "testuser@access-ci.org";

      mockDrupalAuth = {
        ensureAuthenticated: vi.fn().mockResolvedValue(undefined),
        getUserUuid: vi.fn().mockReturnValue("user-uuid-123"),
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      };
      (DrupalAuthProvider as unknown as Mock).mockImplementation(() => mockDrupalAuth);
    });

    afterEach(() => {
      delete process.env.DRUPAL_API_URL;
      delete process.env.DRUPAL_USERNAME;
      delete process.env.DRUPAL_PASSWORD;
      delete process.env.ACTING_USER;
    });

    const call = (name: string, args: Record<string, unknown>) =>
      server["handleToolCall"]({
        method: "tools/call",
        params: { name, arguments: args },
      });

    it("create_announcement (created) produces a conformant envelope with executed:true", async () => {
      mockDrupalAuth.post.mockResolvedValue({
        success: true,
        uuid: "u-1",
        nid: 1,
        title: "T",
        edit_url: "https://test.drupal.site/node/1/edit",
      });
      const result = await call("create_announcement", {
        title: "T",
        body: "<p>b</p>",
        summary: "s",
      });
      const parsed = JSON.parse((result.content[0] as TextContent).text);
      assertEnvelope(parsed);
      expect(parsed.action).toBe("create");
      expect(parsed.status).toBe("created");
      expect(parsed.executed).toBe(true);
    });

    it("update_announcement (updated) produces a conformant envelope with executed:true", async () => {
      mockDrupalAuth.patch.mockResolvedValue({
        success: true,
        uuid: "u-1",
        title: "T2",
        edit_url: "https://test.drupal.site/node/1/edit",
      });
      const result = await call("update_announcement", { uuid: "u-1", title: "T2" });
      const parsed = JSON.parse((result.content[0] as TextContent).text);
      assertEnvelope(parsed);
      expect(parsed.action).toBe("update");
      expect(parsed.status).toBe("updated");
      expect(parsed.executed).toBe(true);
    });

    it("delete_announcement (deleted) produces a conformant envelope with executed:true", async () => {
      mockDrupalAuth.delete.mockResolvedValue({ success: true, uuid: "u-1" });
      const result = await call("delete_announcement", { uuid: "u-1", confirmed: true });
      const parsed = JSON.parse((result.content[0] as TextContent).text);
      assertEnvelope(parsed);
      expect(parsed.action).toBe("delete");
      expect(parsed.status).toBe("deleted");
      expect(parsed.executed).toBe(true);
    });

    it("delete_announcement (preview) produces a conformant envelope with executed:false", async () => {
      mockDrupalAuth.get.mockResolvedValueOnce({
        items: [{ uuid: "u-1", title: "My Post" }],
      });
      const result = await call("delete_announcement", { uuid: "u-1", confirmed: false });
      // Preview writes nothing.
      expect(mockDrupalAuth.delete).not.toHaveBeenCalled();
      const parsed = JSON.parse((result.content[0] as TextContent).text);
      assertEnvelope(parsed);
      expect(parsed.action).toBe("delete");
      expect(parsed.status).toBe("preview");
      expect(parsed.executed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // search_announcements pagination (fetch-All + local slice + exact total)
  //
  // items_per_page=All returns the TRUE full (filtered) corpus in one request,
  // so search_announcements can report an EXACT total and page over it with a
  // local slice — unlike events/nsf, which only ever see one upstream page and
  // must report a total_lower_bound. Both offset and limit are coerced (the
  // events lesson: a Critical shipped there from coercing only offset).
  // ---------------------------------------------------------------------------
  describe("search_announcements pagination", () => {
    const makeAnnouncements = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        title: `Announcement ${i}`,
        body: `Body ${i}`,
        published_date: "2024-03-15",
        tags: [],
        affinity_group: [],
        url: `https://support.access-ci.org/announcements/${i}`,
      }));

    it("reports the EXACT total and pages via offset (not from the start)", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: makeAnnouncements(105),
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: { limit: 10, offset: 10 },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.total).toBe(105);
      expect(responseData.items).toHaveLength(10);
      expect(responseData.items[0].title).toBe("Announcement 10");
      expect(responseData.items[9].title).toBe("Announcement 19");
      expect(responseData.metadata.pagination.has_more).toBe(true);
      expect(responseData.metadata.pagination.capped).toBeUndefined();
    });

    it("coerces both offset and limit (negative offset -> 0, negative/NaN limit -> default)", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: makeAnnouncements(30),
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: { limit: -1, offset: -5 },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      // Negative offset coerces to 0, negative limit coerces to the default
      // (25) — never a slice-from-the-end footgun, and honest metadata.
      expect(responseData.metadata.pagination.offset).toBe(0);
      expect(responseData.metadata.pagination.limit).toBe(25);
      expect(responseData.items).toHaveLength(25);
      expect(responseData.items[0].title).toBe("Announcement 0");
      expect(responseData.total).toBe(30);
    });

    it("limit:0 is count-only: items:[], no error, exact total still reported", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: makeAnnouncements(12),
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: { limit: 0 },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.items).toEqual([]);
      expect(responseData.total).toBe(12);
      expect(responseData.metadata.pagination.limit).toBe(0);
    });

    it("corpus > MAX_LIMIT logs a tripwire warning but still returns the exact total (no fake capped)", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: makeAnnouncements(600),
      });
      const warnSpy = vi.spyOn(server["logger"], "warn").mockImplementation(() => {});

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: { limit: 10 },
        },
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/corpus.*600|600.*corpus|page-based/i)
      );

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      // Still EXACT — we DID fetch all 600 via items_per_page=All. The
      // tripwire is a log, not a response guard: no `capped` from corpus
      // size (capped only appears when the REQUESTED limit > MAX_LIMIT).
      expect(responseData.total).toBe(600);
      expect(responseData.items).toHaveLength(10);
      expect(responseData.metadata.pagination.capped).toBeUndefined();

      warnSpy.mockRestore();
    });

    it("has_more is false at the exact end of the corpus (offset + window.length === total)", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: makeAnnouncements(105),
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: { offset: 100, limit: 5 },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      // Records 100-104 are the last 5 of a 105-item corpus: offset(100) +
      // window.length(5) = 105, which is NOT < 105 — nothing remains, so
      // has_more must be false. A `<=` typo or substituting `limit` for
      // `window.length` here would flip this to true.
      expect(responseData.items).toHaveLength(5);
      expect(responseData.metadata.pagination.has_more).toBe(false);
      expect(responseData.metadata.pagination.total).toBe(105);
      expect(responseData.metadata.pagination.offset).toBe(100);
    });

    it("capped:true is emitted when the requested limit exceeds MAX_LIMIT", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: makeAnnouncements(5),
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: { limit: 501 },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.metadata.pagination.capped).toBe(true);
      expect(responseData.metadata.pagination.limit).toBe(500);
    });

    it("declares offset and limit in its schema (Tier-A conformance)", () => {
      const tools = server["getTools"]();
      const tool = tools.find((t: { name: string }) => t.name === "search_announcements");
      expect(tool?.inputSchema.properties).toHaveProperty("limit");
      expect(tool?.inputSchema.properties).toHaveProperty("offset");
    });

    it("coerces NaN offset to 0 (adversarial input)", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: makeAnnouncements(5),
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: { offset: Number.NaN },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.metadata.pagination.offset).toBe(0);
    });

    it("coerces NaN limit to default (adversarial input)", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: makeAnnouncements(30),
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: { limit: Number.NaN },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.metadata.pagination.limit).toBe(25);
    });

    it("coerces negative offset to 0 (adversarial input)", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: makeAnnouncements(10),
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: { offset: -10 },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.metadata.pagination.offset).toBe(0);
    });

    it("coerces fractional offset to integer (adversarial input)", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: makeAnnouncements(30),
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: { offset: 5.7 },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      // Fractional offset should be floored to 5, not rounded
      expect(responseData.metadata.pagination.offset).toBe(5);
      expect(responseData.items[0].title).toBe("Announcement 5");
    });

    it("coerces fractional limit to integer (adversarial input)", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: makeAnnouncements(30),
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_announcements",
          arguments: { limit: 5.9 },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      // Fractional limit should be floored to 5, not rounded
      expect(responseData.metadata.pagination.limit).toBe(5);
      expect(responseData.items).toHaveLength(5);
    });
  });

  describe("get_my_announcements pagination (Tier-A conformance)", () => {
    it("declares limit in its schema and does NOT declare offset (metadata-only paging)", () => {
      const tools = server["getTools"]();
      const tool = tools.find((t: { name: string }) => t.name === "get_my_announcements");
      expect(tool?.inputSchema.properties).toHaveProperty("limit");
      expect(tool?.inputSchema.properties).not.toHaveProperty("offset");
    });
  });
});
