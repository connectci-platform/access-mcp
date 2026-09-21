import { describe, it, expect, beforeEach, vi, afterEach, Mock } from "vitest";
import { requestContextStorage, RequestContext, DrupalApiError } from "@access-mcp/shared";
import { assertWriteEnvelope } from "@access-mcp/shared/testkit";
import { assertFiltersAppliedShape } from "@access-mcp/shared/testkit/filters-applied";

const mockGet = vi.fn();
const mockDelete = vi.fn();
const mockRequestRaw = vi.fn();
const mockSetActingUser = vi.fn();
vi.mock("@access-mcp/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@access-mcp/shared")>();
  return {
    ...actual,
    // Re-export the real DrupalApiError explicitly so tests can `new` it (the
    // cancel error-branch tests throw a real DrupalApiError at auth.delete).
    DrupalApiError: actual.DrupalApiError,
    DrupalAuthProvider: vi.fn().mockImplementation(() => ({
      ensureAuthenticated: vi.fn().mockResolvedValue(undefined),
      get: mockGet,
      delete: mockDelete,
      requestRaw: mockRequestRaw,
      setActingUser: mockSetActingUser,
    })),
  };
});
import { EventsServer } from "../server.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

interface MockHttpClient {
  get: Mock<(url: string) => Promise<{ status: number; data: unknown }>>;
}

describe("EventsServer", () => {
  let server: EventsServer;
  let mockHttpClient: MockHttpClient;

  beforeEach(() => {
    server = new EventsServer();

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

  beforeEach(() => {
    mockRequestRaw.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Server Initialization", () => {
    it("should initialize with correct server name and version", () => {
      expect(server).toBeDefined();
      expect(server["serverName"]).toBe("access-mcp-events");
      expect(server["version"]).toBe(version);
      expect(server["baseURL"]).toBe("https://support.access-ci.org");
    });

    it("should provide the correct tools", () => {
      const tools = server["getTools"]();

      expect(tools).toHaveLength(15);
      expect(tools.map((t: { name: string }) => t.name)).toContain("search_events");
      expect(tools.map((t: { name: string }) => t.name)).toContain("get_my_events");
      expect(tools.map((t: { name: string }) => t.name)).toContain("get_my_registrations");
      expect(tools.map((t: { name: string }) => t.name)).toContain("cancel_registration");
      expect(tools.map((t: { name: string }) => t.name)).toContain("get_event");
      expect(tools.map((t: { name: string }) => t.name)).toContain("register_for_event");
      expect(tools.map((t: { name: string }) => t.name)).toContain("create_event");
      expect(tools.map((t: { name: string }) => t.name)).toContain("update_event");
      expect(tools.map((t: { name: string }) => t.name)).toContain("delete_event");
      expect(tools.map((t: { name: string }) => t.name)).toContain("restore_event");
      expect(tools.map((t: { name: string }) => t.name)).toContain("send_for_review");
      expect(tools.map((t: { name: string }) => t.name)).toContain("cancel_occurrence");
      expect(tools.map((t: { name: string }) => t.name)).toContain("restore_occurrence");
      expect(tools.map((t: { name: string }) => t.name)).toContain("edit_occurrence");
      expect(tools.map((t: { name: string }) => t.name)).toContain("add_occurrence");
      // No update_recurrence tool: access_events.routing.yml has no recurrence
      // route (the kernel test base's doRecurrence() dispatcher is dead
      // scaffolding, unreachable via crudOpMethodMap()). The API deliberately
      // has no whole-schedule rebuild surface — see update_event/add_occurrence.
      expect(tools.map((t: { name: string }) => t.name)).not.toContain("update_recurrence");
    });

    it("get_my_events / get_my_registrations descriptions crisply separate created vs attending", () => {
      const tools = server["getTools"]();
      const myEvents = tools.find((t) => t.name === "get_my_events")!;
      const myRegs = tools.find((t) => t.name === "get_my_registrations")!;
      // get_my_events must point to get_my_registrations for the attending case (currently does NOT):
      expect(myEvents.description).toContain("get_my_registrations");
      expect(myEvents.description.toLowerCase()).toContain("created");
      // get_my_registrations must cross-reference get_my_events (already does — keep):
      expect(myRegs.description).toContain("get_my_events");
      expect(myRegs.description.toLowerCase()).toContain("registered to attend");
    });

    it("get_event description documents registration_path and capacity_type", () => {
      const tools = server["getTools"]();
      const getEvent = tools.find((t) => t.name === "get_event")!;
      expect(getEvent.description).toContain("registration_path");
      expect(getEvent.description).toContain("capacity_type");
    });

    it("register_for_event description documents the write envelope and drops the cross-tool OPPOSITE/REFUSES clause", () => {
      const tools = server["getTools"]();
      const reg = tools.find((t) => t.name === "register_for_event")!;
      // Documents the write envelope + status reading.
      expect(reg.description).toContain("status");
      expect(reg.description).toContain("executed");
      expect(reg.description).toContain("already_registered");
      // Stale cross-tool reciprocity clause is gone.
      expect(reg.description).not.toContain("OPPOSITE");
      expect(reg.description).not.toContain("REFUSES");
      const confirmed = reg.inputSchema.properties?.confirmed as { description?: string };
      expect(confirmed.description).not.toContain("OPPOSITE");
    });

    it("cancel_registration description documents the unified preview/execute rule and drops the OPPOSITE/REFUSES clause", () => {
      const tools = server["getTools"]();
      const cancel = tools.find((t) => t.name === "cancel_registration")!;
      // Unified rule: confirmed:true executes, confirmed:false previews; read status/executed.
      expect(cancel.description).toContain("status");
      expect(cancel.description).toContain("executed");
      expect(cancel.description.toLowerCase()).toContain("preview");
      // The stale reciprocal REFUSES/OPPOSITE clause left by Task 6 is gone.
      expect(cancel.description).not.toContain("OPPOSITE");
      expect(cancel.description).not.toContain("REFUSES");
    });

    it("should provide the correct resources", () => {
      const resources = server["getResources"]();

      expect(resources).toHaveLength(4);
      expect(resources.map((r) => r.uri)).toContain("accessci://events");
      expect(resources.map((r) => r.uri)).toContain("accessci://events/upcoming");
      expect(resources.map((r) => r.uri)).toContain("accessci://events/workshops");
      expect(resources.map((r) => r.uri)).toContain("accessci://events/webinars");
    });
  });

  describe("URL Building", () => {
    it("should build correct URLs with the v2.4 read endpoint", () => {
      const url = server["buildEventsUrl"]({});
      expect(url).toContain("/api/2.4/events");
    });

    it("should map 'date: today' to beginning_date_relative", () => {
      const url = server["buildEventsUrl"]({ date: "today" });
      expect(url).toContain("beginning_date_relative=today");
    });

    it("should map 'date: upcoming' to open-ended future range", () => {
      const url = server["buildEventsUrl"]({ date: "upcoming" });
      expect(url).toContain("beginning_date_relative=today");
      expect(url).not.toContain("end_date_relative");
    });

    it("should map 'date: past' to date range", () => {
      const url = server["buildEventsUrl"]({ date: "past" });
      expect(url).toContain("beginning_date_relative=-1year");
      expect(url).toContain("end_date_relative=today");
    });

    it("should map 'date: this_week' to date range", () => {
      const url = server["buildEventsUrl"]({ date: "this_week" });
      expect(url).toContain("beginning_date_relative=today");
      expect(url).toContain("end_date_relative=%2B1week");
    });

    it("should map 'date: this_month' to date range", () => {
      const url = server["buildEventsUrl"]({ date: "this_month" });
      expect(url).toContain("beginning_date_relative=today");
      expect(url).toContain("end_date_relative=%2B1month");
    });

    it("should include type as faceted filter", () => {
      const url = server["buildEventsUrl"]({ type: "workshop" });
      expect(url).toContain("f%5B0%5D=custom_event_type%3Aworkshop");
    });

    it("should include tags as faceted filter", () => {
      const url = server["buildEventsUrl"]({ tags: "python" });
      expect(url).toContain("f%5B0%5D=tags%3Apython");
    });

    it("should include skill as faceted filter", () => {
      const url = server["buildEventsUrl"]({ skill: "beginner" });
      expect(url).toContain("f%5B0%5D=custom_event_skill_level%3ABeginner");
    });

    it("should include multiple faceted filters with incrementing index", () => {
      const url = server["buildEventsUrl"]({
        type: "workshop",
        tags: "python",
        skill: "beginner",
      });

      expect(url).toContain("f%5B0%5D=custom_event_type%3Aworkshop");
      expect(url).toContain("f%5B1%5D=tags%3Apython");
      expect(url).toContain("f%5B2%5D=custom_event_skill_level%3ABeginner");
    });

    it("should include search_api_fulltext for query parameter", () => {
      const url = server["buildEventsUrl"]({
        query: "python machine learning",
      });

      expect(url).toContain("search_api_fulltext=python+machine+learning");
    });

    it("should build URLs with all parameter types", () => {
      const url = server["buildEventsUrl"]({
        query: "gpu",
        date: "this_week",
        type: "webinar",
        skill: "intermediate",
      });

      expect(url).toContain("search_api_fulltext=gpu");
      expect(url).toContain("beginning_date_relative=today");
      expect(url).toContain("end_date_relative=%2B1week");
      expect(url).toContain("f%5B0%5D=custom_event_type%3Awebinar");
      expect(url).toContain("f%5B1%5D=custom_event_skill_level%3AIntermediate");
    });

    it("date_range routes to absolute beginning_date/end_date Drupal params", () => {
      const url = server["buildEventsUrl"]({
        date_range: { start_date: "2026-09-17", end_date: "2026-09-25" },
      });

      expect(url).toContain("beginning_date=2026-09-17");
      expect(url).toContain("end_date=2026-09-25");
      expect(url).not.toContain("beginning_date_relative");
      expect(url).not.toContain("end_date_relative");
    });

    it("date_range overrides the date enum", () => {
      const url = server["buildEventsUrl"]({
        date: "upcoming",
        date_range: { start_date: "2026-09-17" },
      });

      expect(url).toContain("beginning_date=2026-09-17");
      expect(url).not.toContain("beginning_date_relative");
    });

    it("the date enum still works unchanged when no date_range is given", () => {
      const url = server["buildEventsUrl"]({ date: "past" });

      expect(url).toContain("beginning_date_relative=-1year");
      expect(url).toContain("end_date_relative=today");
    });

    it("flat start_date/end_date are no longer accepted schema props", () => {
      const tools = server["getTools"]();
      const searchEvents = tools.find(
        (t: { name: string }) => t.name === "search_events"
      ) as { inputSchema: { properties: Record<string, unknown> } };

      expect(searchEvents.inputSchema.properties.date_range).toBeDefined();
      expect(searchEvents.inputSchema.properties.start_date).toBeUndefined();
      expect(searchEvents.inputSchema.properties.end_date).toBeUndefined();
    });

    // Anti-conflation guard: the search FILTER migrated to date_range, but
    // create_event's CONTENT dates (when the event happens) are a different
    // concern and must NOT be migrated. This fails if a later change wrongly
    // pulls content dates into date_range too.
    it("create_event still uses start_date/end_date for content (not migrated to date_range)", () => {
      const tools = server["getTools"]();
      const createEvent = tools.find(
        (t: { name: string }) => t.name === "create_event"
      ) as { inputSchema: { properties: Record<string, unknown> } };
      // Navigate the nested schema via a structural type rather than `any`
      // (the repo's eslint forbids explicit any).
      type SchemaNode = { properties?: Record<string, unknown>; items?: SchemaNode };
      const props = createEvent.inputSchema.properties as Record<string, SchemaNode>;

      // custom_dates items carry start_date/end_date content
      expect(props.custom_dates.items?.properties?.start_date).toBeDefined();
      expect(props.custom_dates.items?.properties?.end_date).toBeDefined();
      // recurrence carries start_date/end_date content
      expect(props.recurrence.properties?.start_date).toBeDefined();
      expect(props.recurrence.properties?.end_date).toBeDefined();
      // and create_event has NOT sprouted a date_range (that's search-only)
      expect(props.date_range).toBeUndefined();
    });
  });

  describe("Tool Methods", () => {
    const mockEventsData = [
      {
        id: "1",
        title: "Python Workshop",
        description: "Learn Python basics",
        start_date: "2024-08-30T09:00:00",
        end_date: "2024-08-30T17:00:00",
        location: "Online",
        event_type: "workshop",
        event_affiliation: "ACCESS",
        tags: ["python", "programming", "beginner"],
        skill_level: "beginner",
        speakers: "Dr. Smith",
        contact: "events@example.com",
        registration: "https://example.com/register",
        field_video: "",
        created: "2024-08-01T10:00:00-0400",
        changed: "2024-08-15T14:30:00-0400",
        url: "https://support.access-ci.org/events/python-workshop",
      },
      {
        id: "2",
        title: "Machine Learning Webinar",
        description: "Introduction to ML",
        start_date: "2024-09-01T14:00:00",
        end_date: "2024-09-01T15:30:00",
        location: "Virtual",
        event_type: "webinar",
        event_affiliation: "Community",
        tags: ["machine-learning", "ai", "python"],
        skill_level: "intermediate",
        speakers: "Prof. Johnson",
        contact: "ml@example.com",
        registration: "https://example.com/ml-register",
        field_video: "",
        created: "2024-08-01T10:00:00-0400",
        changed: "2024-08-20T11:00:00-0400",
        url: "https://support.access-ci.org/events/machine-learning-webinar",
      },
    ];

    describe("search_events", () => {
      it("should get events with no filters", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: mockEventsData,
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {},
          },
        });

        expect(mockHttpClient.get).toHaveBeenCalled();
        const responseData = JSON.parse(result.content[0].text);
        expect(responseData.total).toBe(2);
        expect(responseData.items).toHaveLength(2);
        expect(responseData.documentation.links.see_all_url).toBe("https://support.access-ci.org/events");
        expect(responseData.metadata.query_relevance).toBe("exact");
      });

      it("should tag query_relevance loose_match when full-text query is supplied", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: mockEventsData,
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {
              query: "machine learning",
            },
          },
        });

        const calledUrl = mockHttpClient.get.mock.calls[0][0];
        expect(calledUrl).toContain("search_api_fulltext=machine+learning");

        const responseData = JSON.parse(result.content[0].text);
        expect(responseData.metadata.query_relevance).toBe("loose_match");
      });

      it("should get events with date filter", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: mockEventsData,
        });

        await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {
              date: "this_month",
            },
          },
        });

        const calledUrl = mockHttpClient.get.mock.calls[0][0];
        expect(calledUrl).toContain("beginning_date_relative=today");
        expect(calledUrl).toContain("end_date_relative=%2B1month");
      });

      it("should pass type as faceted filter to Drupal", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: [mockEventsData[0]],
        });

        await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {
              type: "workshop",
            },
          },
        });

        const calledUrl = mockHttpClient.get.mock.calls[0][0];
        expect(calledUrl).toContain("f%5B0%5D=custom_event_type%3Aworkshop");
      });

      it("should pass skill as faceted filter to Drupal", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: [mockEventsData[0]],
        });

        await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {
              skill: "beginner",
            },
          },
        });

        const calledUrl = mockHttpClient.get.mock.calls[0][0];
        expect(calledUrl).toContain("f%5B0%5D=custom_event_skill_level%3ABeginner");
      });

      it("should pass tags as faceted filter to Drupal", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: mockEventsData,
        });

        await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {
              tags: "python",
            },
          },
        });

        const calledUrl = mockHttpClient.get.mock.calls[0][0];
        expect(calledUrl).toContain("f%5B0%5D=tags%3Apython");
      });

      it("should apply limit to events", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: mockEventsData,
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {
              limit: 1,
            },
          },
        });

        const responseData = JSON.parse(result.content[0].text);
        expect(responseData.items).toHaveLength(1);
      });

      it("should enhance events with calculated fields", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: mockEventsData,
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {},
          },
        });

        const responseData = JSON.parse(result.content[0].text);
        const event = responseData.items[0];

        // Check enhanced fields
        expect(event.tags).toEqual(["python", "programming", "beginner"]);
        expect(event.duration_hours).toBe(8); // 9am to 5pm
        expect(event.starts_in_hours).toBeDefined();
      });

      it("passes through the v2.4 already-zoned start_date/end_date (isoInstant no-op)", async () => {
        // /api/2.4/events returns true-UTC instants WITH a Z. isoInstant must
        // leave an already-zoned value untouched (not double-append).
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: [
            {
              id: "8504",
              title: "OnDemand",
              start_date: "2026-08-06T13:00:00Z",
              end_date: "2026-08-06T14:00:00Z",
            },
          ],
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {},
          },
        });

        const responseData = JSON.parse(result.content[0].text);
        const item = responseData.items[0];
        expect(item.start_date).toBe("2026-08-06T13:00:00Z");
        expect(item.end_date).toBe("2026-08-06T14:00:00Z");
        expect(item.duration_hours).toBe(1); // 13:00Z to 14:00Z
      });

      it("computes starts_in_hours from the zoned instant, independent of runtime TZ", async () => {
        // A zoned value must be parsed as the instant it denotes, NOT as the
        // runtime's local time. Fixed 'now' so the assertion is deterministic.
        const now = Date.parse("2026-08-06T10:00:00Z");
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
        try {
          mockHttpClient.get.mockResolvedValue({
            status: 200,
            data: [
              {
                id: "8504",
                title: "OnDemand",
                start_date: "2026-08-06T13:00:00Z", // 3h after 'now'
                end_date: "2026-08-06T14:00:00Z",
              },
            ],
          });
          const result = await server["handleToolCall"]({
            method: "tools/call",
            params: { name: "search_events", arguments: {} },
          });
          const item = JSON.parse(result.content[0].text).items[0];
          expect(item.starts_in_hours).toBe(3); // 13:00Z − 10:00Z, TZ-independent
        } finally {
          nowSpy.mockRestore();
        }
      });

      it("normalizes a NAIVE (no-zone) date before computing starts_in_hours (the fallback branch)", async () => {
        // This is the case the refactor actually guards: a bare value must be
        // treated as UTC (via isoInstant's Z-append) before new Date(), NOT as
        // the runtime's local time. Feeding a naive value and asserting the UTC
        // interpretation proves it, regardless of the machine's timezone.
        const now = Date.parse("2026-08-06T10:00:00Z");
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
        try {
          mockHttpClient.get.mockResolvedValue({
            status: 200,
            data: [
              { id: "8504", title: "OnDemand", start_date: "2026-08-06T13:00:00", end_date: "2026-08-06T14:00:00" },
            ],
          });
          const result = await server["handleToolCall"]({
            method: "tools/call",
            params: { name: "search_events", arguments: {} },
          });
          const item = JSON.parse(result.content[0].text).items[0];
          // isoInstant makes it 13:00:00Z → 3h after 10:00Z. If the code used the
          // raw naive value, new Date() would parse it as local and this would
          // drift by the runtime offset.
          expect(item.starts_in_hours).toBe(3);
          expect(item.start_date).toBe("2026-08-06T13:00:00Z");
        } finally {
          nowSpy.mockRestore();
        }
      });

      it("should parse comma-separated string tags", async () => {
        const eventsWithStringTags = [
          {
            id: "10",
            title: "String Tags Event",
            start_date: "2024-09-15T09:00:00",
            end_date: "2024-09-15T17:00:00",
            tags: "python, gpu, hpc",
            url: "https://support.access-ci.org/events/string-tags-event",
          },
        ];

        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: eventsWithStringTags,
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {},
          },
        });

        const responseData = JSON.parse(result.content[0].text);
        expect(responseData.items[0].tags).toEqual(["python", "gpu", "hpc"]);
      });

      it("should handle empty string tags", async () => {
        const eventsWithEmptyTags = [
          {
            id: "11",
            title: "No Tags Event",
            start_date: "2024-09-15T09:00:00",
            end_date: "2024-09-15T17:00:00",
            tags: "  ",
            url: "https://support.access-ci.org/events/no-tags-event",
          },
        ];

        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: eventsWithEmptyTags,
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {},
          },
        });

        const responseData = JSON.parse(result.content[0].text);
        expect(responseData.items[0].tags).toEqual([]);
      });

      it("should sort events by starts_in_hours ascending", async () => {
        const futureDate1 = new Date(Date.now() + 2 * 24 * 3600000).toISOString();
        const futureDate2 = new Date(Date.now() + 10 * 24 * 3600000).toISOString();
        const futureDate3 = new Date(Date.now() + 5 * 24 * 3600000).toISOString();

        const unsortedEvents = [
          {
            id: "s1",
            title: "Event B (10 days out)",
            start_date: futureDate2,
            end_date: futureDate2,
            tags: [],
            url: "https://support.access-ci.org/events/event-b",
          },
          {
            id: "s2",
            title: "Event A (2 days out)",
            start_date: futureDate1,
            end_date: futureDate1,
            tags: [],
            url: "https://support.access-ci.org/events/event-a",
          },
          {
            id: "s3",
            title: "Event C (5 days out)",
            start_date: futureDate3,
            end_date: futureDate3,
            tags: [],
            url: "https://support.access-ci.org/events/event-c",
          },
        ];

        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: unsortedEvents,
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {},
          },
        });

        const responseData = JSON.parse(result.content[0].text);
        expect(responseData.items[0].id).toBe("s2"); // nearest
        expect(responseData.items[1].id).toBe("s3"); // middle
        expect(responseData.items[2].id).toBe("s1"); // farthest
      });

      it("should search events by query", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: mockEventsData,
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {
              query: "Python",
            },
          },
        });

        const calledUrl = mockHttpClient.get.mock.calls[0][0];
        expect(calledUrl).toContain("search_api_fulltext=Python");

        const responseData = JSON.parse(result.content[0].text);
        expect(responseData.total).toBe(2);
        expect(responseData.items).toHaveLength(2);
      });

      it("should combine query params and faceted filters", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: [mockEventsData[0]],
        });

        await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {
              query: "Python",
              date: "this_week",
              type: "workshop",
              skill: "beginner",
            },
          },
        });

        const calledUrl = mockHttpClient.get.mock.calls[0][0];
        expect(calledUrl).toContain("search_api_fulltext=Python");
        expect(calledUrl).toContain("beginning_date_relative=today");
        expect(calledUrl).toContain("end_date_relative=%2B1week");
        expect(calledUrl).toContain("f%5B0%5D=custom_event_type%3Aworkshop");
        expect(calledUrl).toContain("f%5B1%5D=custom_event_skill_level%3ABeginner");
      });

      // The flat /api/2.3/events API serializes Drupal boolean fields as the
      // STRINGS 'Yes'/'No' and numeric fields as strings ('0'/'60'), NOT JS
      // booleans/numbers. These fixtures use that real production shape.
      it("surfaces native access_registration and renames registration to registration_url", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: [
            {
              id: "9078", title: "Reg Workshop", start_date: "2026-08-01T14:00:00Z",
              end_date: "2026-08-01T15:00:00Z", tags: "", description: "d",
              registration: "https://sdsc.edu/register",
              registration_enabled: "Yes", registration_capacity: "60", registration_has_waitlist: "Yes",
            },
            {
              id: "9079", title: "Plain Event", start_date: "2026-08-02T14:00:00Z",
              end_date: "2026-08-02T15:00:00Z", tags: "", description: "d",
              registration: "", registration_enabled: "No", registration_capacity: "0", registration_has_waitlist: "No",
            },
          ],
        });
        const result = await server["handleToolCall"]({
          method: "tools/call", params: { name: "search_events", arguments: {} },
        });
        const payload = JSON.parse((result.content[0] as { text: string }).text);
        const [a, b] = payload.items;
        // Registrable event: capacity is a NUMBER, not the string "60"
        expect(a.access_registration).toEqual({ enabled: true, capacity: 60, has_waitlist: true });
        expect(a.registration_url).toBe("https://sdsc.edu/register");
        // Non-registrable: 'No' must parse to enabled:false, url null, no fabricated capacity
        expect(b.access_registration).toEqual({ enabled: false });
        expect(b.registration_url).toBeNull();
        // The raw flat keys must NOT leak alongside the nested shape
        expect(a).not.toHaveProperty("registration_enabled");
        expect(a).not.toHaveProperty("registration");
      });

      it("treats the string 'No' as not-enabled (the real /api/2.3 shape, not a JS boolean)", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: [
            {
              id: "1", title: "Offsite Event", start_date: "2026-08-01T14:00:00Z",
              end_date: "2026-08-01T15:00:00Z", tags: "", description: "d",
              registration: "https://offsite.example/register",
              // Every event on live prod comes back like this for non-native events.
              registration_enabled: "No", registration_capacity: "0", registration_has_waitlist: "No",
            },
          ],
        });
        const result = await server["handleToolCall"]({
          method: "tools/call", params: { name: "search_events", arguments: {} },
        });
        const payload = JSON.parse((result.content[0] as { text: string }).text);
        const [e] = payload.items;
        // Boolean('No') === true would (wrongly) make this enabled:true with
        // has_waitlist:true and capacity "0". The string parser must fix all three.
        expect(e.access_registration).toEqual({ enabled: false });
      });

      it("parses capacity 0 (unlimited) as null even when enabled", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: [
            {
              id: "2", title: "Unlimited Workshop", start_date: "2026-08-01T14:00:00Z",
              end_date: "2026-08-01T15:00:00Z", tags: "", description: "d",
              registration: "",
              registration_enabled: "Yes", registration_capacity: "0", registration_has_waitlist: "No",
            },
          ],
        });
        const result = await server["handleToolCall"]({
          method: "tools/call", params: { name: "search_events", arguments: {} },
        });
        const payload = JSON.parse((result.content[0] as { text: string }).text);
        const [e] = payload.items;
        // capacity '0' means unlimited → null (not the string "0", not the number 0)
        expect(e.access_registration).toEqual({ enabled: true, capacity: null, has_waitlist: false });
      });
    });

    describe("filters_applied disclosure", () => {
      it("conforms to the canonical shape (exactly query, type, tags, date, date_range, skill, has_video)", async () => {
        mockHttpClient.get.mockResolvedValue({ status: 200, data: mockEventsData });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: { name: "search_events", arguments: { query: "python" } },
        });

        assertFiltersAppliedShape(
          result,
          ["query", "type", "tags", "date", "date_range", "skill", "has_video"],
          expect
        );
      });

      it("no filters → all seven keys null", async () => {
        mockHttpClient.get.mockResolvedValue({ status: 200, data: mockEventsData });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: { name: "search_events", arguments: {} },
        });

        const responseData = JSON.parse(result.content[0].text);
        expect(responseData.metadata.filters_applied).toEqual({
          query: null,
          type: null,
          tags: null,
          date: null,
          date_range: null,
          skill: null,
          has_video: null,
        });
      });

      it("date and date_range are distinct keys: a `date` call discloses date_range: null", async () => {
        mockHttpClient.get.mockResolvedValue({ status: 200, data: mockEventsData });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: { name: "search_events", arguments: { date: "upcoming" } },
        });

        const responseData = JSON.parse(result.content[0].text);
        expect(responseData.metadata.filters_applied.date).toBe("upcoming");
        expect(responseData.metadata.filters_applied.date_range).toBeNull();
      });

      it("date and date_range are distinct keys: a `date_range` call discloses date: null", async () => {
        mockHttpClient.get.mockResolvedValue({ status: 200, data: mockEventsData });

        const dateRange = { start_date: "2026-09-17", end_date: "2026-09-25" };
        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: { name: "search_events", arguments: { date_range: dateRange } },
        });

        const responseData = JSON.parse(result.content[0].text);
        expect(responseData.metadata.filters_applied.date_range).toEqual(dateRange);
        expect(responseData.metadata.filters_applied.date).toBeNull();
      });

      it("has_video: true is disclosed and the result set reflects it", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: [
            { ...mockEventsData[0], video: "https://example.com/recording.mp4" },
            { ...mockEventsData[1], video: "" },
          ],
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: { name: "search_events", arguments: { has_video: true } },
        });

        const responseData = JSON.parse(result.content[0].text);
        expect(responseData.metadata.filters_applied.has_video).toBe(true);
        expect(responseData.items).toHaveLength(1);
        expect(responseData.items[0].title).toBe(mockEventsData[0].title);
      });

      it("discloses has_video: false as false, not null (boolean-false must survive)", async () => {
        mockHttpClient.get.mockResolvedValue({ status: 200, data: mockEventsData });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: { name: "search_events", arguments: { has_video: false } },
        });

        const responseData = JSON.parse(result.content[0].text);
        expect(responseData.metadata.filters_applied.has_video).toBe(false);
        expect(responseData.metadata.filters_applied).toEqual({
          query: null,
          type: null,
          tags: null,
          date: null,
          date_range: null,
          skill: null,
          has_video: false,
        });
      });

      it("survives a fields projection targeting a metadata subpath", async () => {
        mockHttpClient.get.mockResolvedValue({ status: 200, data: mockEventsData });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: { has_video: true, fields: ["metadata.pagination.has_more"] },
          },
        });

        assertFiltersAppliedShape(
          result,
          ["query", "type", "tags", "date", "date_range", "skill", "has_video"],
          expect
        );
        const responseData = JSON.parse(result.content[0].text);
        expect(responseData.metadata.filters_applied.has_video).toBe(true);
      });
    });

    describe("search_events pagination (offset via fetch-from-0 + local slice)", () => {
      // Distinguishable stub events e0..e{n-1}, each with a distinct
      // start_date so the starts_in_hours sort is stable and predictable.
      const stubEvents = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
          id: `e${i}`,
          title: `Event ${i}`,
          start_date: `2026-09-${String(18 + i).padStart(2, "0")}T00:00:00Z`,
          end_date: `2026-09-${String(18 + i).padStart(2, "0")}T01:00:00Z`,
          tags: "",
          description: "d",
        }));

      it("fetch size covers offset+limit+1 and no page param is set", () => {
        const url = server["buildEventsUrl"]({ limit: 10, offset: 10 });
        // needed = 10+10+1 = 21 → smallest ALLOWED_PAGE_SIZES >= 21 is 25
        expect(url).toContain("items_per_page=25");
        expect(new URL(url).searchParams.has("page")).toBe(false);
      });

      it("a mid-page offset returns the correct window (records offset..offset+limit), not records from 0", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: stubEvents(25),
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: { limit: 10, offset: 10 },
          },
        });

        const payload = JSON.parse((result.content[0] as { text: string }).text);
        expect(payload.items).toHaveLength(10);
        expect(payload.items.map((e: { id: string }) => e.id)).toEqual(
          Array.from({ length: 10 }, (_, i) => `e${i + 10}`)
        );
      });

      it("has_more true when a record beyond offset+limit was fetched", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: stubEvents(25),
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: { limit: 10, offset: 10 },
          },
        });

        const payload = JSON.parse((result.content[0] as { text: string }).text);
        expect(payload.metadata.pagination.has_more).toBe(true);
      });

      it("has_more false at the true end", async () => {
        // offset 10 / limit 10 → fetch returns exactly 20 records (nothing
        // beyond offset+limit=20 was fetched, so the probe honestly says no more).
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: stubEvents(20),
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: { limit: 10, offset: 10 },
          },
        });

        const payload = JSON.parse((result.content[0] as { text: string }).text);
        expect(payload.metadata.pagination.has_more).toBe(false);
        expect(payload.items.map((e: { id: string }) => e.id)).toEqual(
          Array.from({ length: 10 }, (_, i) => `e${i + 10}`)
        );
      });

      it("emits total_lower_bound, not a fabricated total", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: stubEvents(25),
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: { limit: 10, offset: 10 },
          },
        });

        const payload = JSON.parse((result.content[0] as { text: string }).text);
        expect(payload.metadata.pagination.total_lower_bound).toBe(20); // offset(10) + window.length(10)
        expect(typeof payload.total).toBe("number");
        expect(payload.total).toBe(payload.metadata.pagination.total_lower_bound);
      });

      it("negative offset is coerced to 0", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: stubEvents(10),
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: { limit: 10, offset: -5 },
          },
        });

        const payload = JSON.parse((result.content[0] as { text: string }).text);
        expect(payload.metadata.pagination.offset).toBe(0);
        expect(payload.items.map((e: { id: string }) => e.id)).toEqual(
          Array.from({ length: 10 }, (_, i) => `e${i}`)
        );
      });

      it("offset+limit beyond 500 is capped, not fetched at an invalid page size", () => {
        // needed = 495+10+1 = 506, no ALLOWED_PAGE_SIZES bucket >= 506 → clamp to 500
        const url = server["buildEventsUrl"]({ limit: 10, offset: 495 });
        expect(url).toContain("items_per_page=500");
      });

      it("offset+limit == 500 is treated as probe-lost: capped + honest has_more, not clean false", async () => {
        // offset 490 / limit 10 → needed = 501, no ALLOWED_PAGE_SIZES bucket
        // >= 501 → fetchSize clamps to 500, probePreserved is false. Stub a
        // FULL 500-record page (upstream has at least 501 records in reality).
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: stubEvents(500),
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: { limit: 10, offset: 490 },
          },
        });

        const payload = JSON.parse((result.content[0] as { text: string }).text);
        expect(payload.items).toHaveLength(10);
        expect(payload.items.map((e: { id: string }) => e.id)).toEqual(
          Array.from({ length: 10 }, (_, i) => `e${i + 490}`)
        );
        expect(payload.metadata.pagination.capped).toBe(true);
        expect(payload.metadata.pagination.has_more).toBe(true);
      });

      it("limit:0 returns items:[] with honest metadata, not an error (count-only contract preserved)", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: stubEvents(5),
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: { limit: 0 },
          },
        });

        const payload = JSON.parse((result.content[0] as { text: string }).text);
        expect(result.content[0].text).not.toContain('"error"');
        expect(payload.items).toEqual([]);
        expect(payload.metadata.pagination.limit).toBe(0);
        expect(typeof payload.total).toBe("number");
      });

      it("negative limit is coerced to the default, not a from-the-end slice — no lying has_more/total_lower_bound", async () => {
        // Before coerceLimit: slice(2, 2 + -1) === slice(2, 1) — a
        // from-the-end slice — while has_more/total_lower_bound still
        // claimed a normal forward window. After coercion, limit:-1 falls
        // back to the default (50) and the window is an honest one.
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: stubEvents(10),
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: { limit: -1, offset: 2 },
          },
        });

        const payload = JSON.parse((result.content[0] as { text: string }).text);
        expect(result.content[0].text).not.toContain('"error"');
        // Honest forward window: offset 2, coerced limit 50 → records e2..e9.
        expect(payload.items.map((e: { id: string }) => e.id)).toEqual(
          Array.from({ length: 8 }, (_, i) => `e${i + 2}`)
        );
        expect(payload.metadata.pagination.limit).toBe(50);
        // No lying metadata: has_more must be false (nothing beyond the
        // fetched/returned window), and total_lower_bound must match what
        // was actually returned (offset + window.length), not a stale claim.
        expect(payload.metadata.pagination.has_more).toBe(false);
        expect(payload.metadata.pagination.total_lower_bound).toBe(
          2 + payload.items.length
        );
      });

      it("limit:5000 is clamped via the existing 500 ceiling, not broken by coercion", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: stubEvents(500),
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: { limit: 5000, offset: 0 },
          },
        });

        const payload = JSON.parse((result.content[0] as { text: string }).text);
        expect(result.content[0].text).not.toContain('"error"');
        expect(payload.items).toHaveLength(500);
        expect(payload.metadata.pagination.capped).toBe(true);
      });

      it("limit:10.5 is truncated to 10", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: stubEvents(20),
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: { limit: 10.5 },
          },
        });

        const payload = JSON.parse((result.content[0] as { text: string }).text);
        expect(payload.items).toHaveLength(10);
        expect(payload.metadata.pagination.limit).toBe(10);
      });

      it("search_events schema default limit is 50, matching the effective server default", () => {
        const tools = server["getTools"]();
        const searchEvents = tools.find((t) => t.name === "search_events");
        expect(searchEvents?.inputSchema.properties?.limit).toMatchObject({
          default: 50,
        });
      });

      it("declares offset in its schema", () => {
        const tools = server["getTools"]();
        const searchEvents = tools.find((t) => t.name === "search_events");
        expect(searchEvents?.inputSchema.properties?.offset).toBeDefined();
      });

      it("search_events declares limit and offset in its schema", () => {
        const t = server["getTools"]().find(
          (x: { name: string }) => x.name === "search_events"
        );
        expect(t?.inputSchema.properties?.limit).toBeDefined();
        expect(t?.inputSchema.properties?.offset).toBeDefined();
      });

      it("a default (no-limit) search against a small result set does not report capped and honestly windows to the default limit", async () => {
        // No `limit` in arguments — handleToolCall passes raw args, so the
        // JSON-schema default:20 is never applied server-side. Before the
        // fix, getEvents fell back to `limit = filtered.length` (disagreeing
        // with buildEventsUrl's `params.limit || 50`, which fetched only 100
        // records for a no-limit call — needed = 0+50+1=51 -> bucket 100).
        // With 60 stub events (> the true default limit of 50, < the 100
        // fetched), the buggy fallback set limit=60 (=filtered.length),
        // returned ALL 60 items, and silently reported has_more:false even
        // though the caller only asked for the default page — a silent
        // over-return with no capped/has_more signal at all, not merely a
        // false capped:true.
        mockHttpClient.get.mockResolvedValue({
          status: 200,
          data: stubEvents(60),
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {},
          },
        });

        const payload = JSON.parse((result.content[0] as { text: string }).text);
        expect(payload.metadata.pagination.capped).toBeUndefined();
        expect(payload.metadata.pagination.limit).toBe(50);
        expect(payload.items).toHaveLength(50);
        expect(payload.metadata.pagination.has_more).toBe(true);
      });
    });

    describe("Error Handling", () => {
      it("should handle API errors gracefully", async () => {
        mockHttpClient.get.mockResolvedValue({
          status: 404,
          statusText: "Not Found",
        });

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {},
          },
        });

        expect(result.content[0].text).toContain("error");
        expect(result.content[0].text).toContain("404");
      });

      it("should handle network errors", async () => {
        mockHttpClient.get.mockRejectedValue(new Error("Network error"));

        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "search_events",
            arguments: {},
          },
        });

        expect(result.content[0].text).toContain("error");
      });

      it("should handle unknown tools", async () => {
        const result = await server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "unknown_tool",
            arguments: {},
          },
        });

        expect(result.content[0].text).toContain("Unknown tool");
      });
    });
  });

  describe("Resource Handling", () => {
    const mockEventsData = [
      {
        id: "1",
        title: "Test Event",
        event_type: "workshop",
        start_date: "2024-08-30T09:00:00",
        end_date: "2024-08-30T17:00:00",
        tags: ["test"],
        url: "https://support.access-ci.org/events/test-event",
      },
    ];

    it("should handle accessci://events resource", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: mockEventsData,
      });

      const result = await server["handleResourceRead"]({
        params: { uri: "accessci://events" },
      });

      expect(result.contents[0].mimeType).toBe("application/json");
      expect(result.contents[0].text).toBeDefined();
    });

    it("should handle accessci://events/upcoming resource", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: mockEventsData,
      });

      const result = await server["handleResourceRead"]({
        params: { uri: "accessci://events/upcoming" },
      });

      expect(result.contents[0].mimeType).toBe("application/json");
    });

    it("should handle accessci://events/workshops resource", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: mockEventsData,
      });

      const result = await server["handleResourceRead"]({
        params: { uri: "accessci://events/workshops" },
      });

      expect(result.contents[0].mimeType).toBe("application/json");
    });

    it("should handle accessci://events/webinars resource", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: [],
      });

      const result = await server["handleResourceRead"]({
        params: { uri: "accessci://events/webinars" },
      });

      expect(result.contents[0].mimeType).toBe("application/json");
    });

    it("should handle unknown resources", async () => {
      await expect(async () => {
        await server["handleResourceRead"]({
          params: { uri: "accessci://unknown" },
        });
      }).rejects.toThrow("Unknown resource");
    });
  });

  describe("get_my_registrations", () => {
    it("get_my_registrations calls the registrations endpoint with when=upcoming by default", async () => {
      const saved = { url: process.env.DRUPAL_API_URL, user: process.env.DRUPAL_USERNAME, pass: process.env.DRUPAL_PASSWORD };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc"; process.env.DRUPAL_PASSWORD = "pw";
        mockGet.mockReset();
        // auth.get returns the response BODY directly; our endpoint returns { registrations: [...] } — mock that shape, NOT wrapped in { data: ... }.
        mockGet.mockResolvedValue({ registrations: [{ registrant_id: "u-1", eventinstance_id: "5", event_title: "GPU", waitlist: false }] });
        const server = new EventsServer();
        const result = await requestContextStorage.run(
          { actingUser: "apasquale@access-ci.org" } as RequestContext,
          () => server["handleToolCall"]({ method: "tools/call", params: { name: "get_my_registrations", arguments: {} } })
        );
        expect(mockGet).toHaveBeenCalledWith(
          "apasquale@access-ci.org",
          "/api/1.0/registrations?when=upcoming"
        );
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("u-1");
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL; else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME; else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD; else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    });

    it("get_my_registrations passes when=past through", async () => {
      const saved = { url: process.env.DRUPAL_API_URL, user: process.env.DRUPAL_USERNAME, pass: process.env.DRUPAL_PASSWORD };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc"; process.env.DRUPAL_PASSWORD = "pw";
        mockGet.mockReset();
        mockGet.mockResolvedValue({ registrations: [] });
        const server = new EventsServer();
        await requestContextStorage.run(
          { actingUser: "apasquale@access-ci.org" } as RequestContext,
          () => server["handleToolCall"]({ method: "tools/call", params: { name: "get_my_registrations", arguments: { when: "past" } } })
        );
        expect(mockGet).toHaveBeenCalledWith(
          "apasquale@access-ci.org",
          "/api/1.0/registrations?when=past"
        );
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL; else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME; else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD; else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    });

    it("get_my_registrations surfaces the cancelled flag per registration", async () => {
      const saved = { url: process.env.DRUPAL_API_URL, user: process.env.DRUPAL_USERNAME, pass: process.env.DRUPAL_PASSWORD };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc"; process.env.DRUPAL_PASSWORD = "pw";
        mockGet.mockReset();
        mockGet.mockResolvedValue({
          registrations: [
            { registrant_id: "u-1", eventinstance_id: "5", event_title: "GPU", waitlist: false, cancelled: true },
            { registrant_id: "u-2", eventinstance_id: "6", event_title: "Other", waitlist: false, cancelled: false },
          ],
        });
        const server = new EventsServer();
        const result = await requestContextStorage.run(
          { actingUser: "apasquale@access-ci.org" } as RequestContext,
          () => server["handleToolCall"]({ method: "tools/call", params: { name: "get_my_registrations", arguments: {} } })
        );
        const parsed = JSON.parse((result.content[0] as { text: string }).text);
        expect(parsed.registrations[0].cancelled).toBe(true);
        expect(parsed.registrations[1].cancelled).toBe(false);
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL; else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME; else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD; else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    });

    it("get_my_registrations handles an empty/undefined response body", async () => {
      const saved = { url: process.env.DRUPAL_API_URL, user: process.env.DRUPAL_USERNAME, pass: process.env.DRUPAL_PASSWORD };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc"; process.env.DRUPAL_PASSWORD = "pw";
        mockGet.mockReset();
        mockGet.mockResolvedValue(undefined);
        const server = new EventsServer();
        const result = await requestContextStorage.run(
          { actingUser: "apasquale@access-ci.org" } as RequestContext,
          () => server["handleToolCall"]({ method: "tools/call", params: { name: "get_my_registrations", arguments: {} } })
        );
        const text = (result.content[0] as { text: string }).text;
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
        expect(text).toMatch(/no data/i);
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL; else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME; else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD; else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    });

    // Production bug (2026-08-12): an expired Drupal session comes back as a 3xx
    // redirect to CILogon. get_my_registrations calls the THROWING auth.get, whose
    // DrupalApiError fell through to the generic handleToolCall catch and surfaced
    // the raw "Drupal API error: 307 Temporary Redirect". Authenticated reads must
    // map a 3xx onto the same structured authRedirectError shape the requestRaw
    // paths already use. With the shared-layer re-login retry in place this only
    // fires when re-login itself fails.
    it("get_my_registrations maps a persistent 3xx to the structured auth error", async () => {
      const saved = { url: process.env.DRUPAL_API_URL, user: process.env.DRUPAL_USERNAME, pass: process.env.DRUPAL_PASSWORD };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc"; process.env.DRUPAL_PASSWORD = "pw";
        mockGet.mockReset();
        mockGet.mockRejectedValue(
          new DrupalApiError("Drupal API error: 307 Temporary Redirect", 307, "")
        );
        const server = new EventsServer();
        const result = await requestContextStorage.run(
          { actingUser: "apasquale@access-ci.org" } as RequestContext,
          () => server["handleToolCall"]({ method: "tools/call", params: { name: "get_my_registrations", arguments: {} } })
        );
        expect(result.isError).toBe(true);
        const parsed = JSON.parse((result.content[0] as { text: string }).text);
        expect(parsed.status).toBe("error");
        expect(parsed.error.code).toBe("unauthenticated");
        expect(parsed.error.message).toMatch(/session may have expired/i);
        // The raw upstream string must NOT leak to the user.
        expect(parsed.error.message).not.toContain("307");
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL; else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME; else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD; else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    });

    it("get_my_events maps a persistent 3xx to the structured auth error", async () => {
      const saved = { url: process.env.DRUPAL_API_URL, user: process.env.DRUPAL_USERNAME, pass: process.env.DRUPAL_PASSWORD };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc"; process.env.DRUPAL_PASSWORD = "pw";
        mockGet.mockReset();
        mockGet.mockRejectedValue(
          new DrupalApiError("Drupal API error: 302 Found", 302, "")
        );
        const server = new EventsServer();
        const result = await requestContextStorage.run(
          { actingUser: "apasquale@access-ci.org" } as RequestContext,
          () => server["handleToolCall"]({ method: "tools/call", params: { name: "get_my_events", arguments: {} } })
        );
        expect(result.isError).toBe(true);
        const parsed = JSON.parse((result.content[0] as { text: string }).text);
        expect(parsed.error.code).toBe("unauthenticated");
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL; else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME; else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD; else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    });

    // A failed re-login is NOT ordinary expiry: retrying or restarting will not
    // help, the credentials/Drupal are broken. It must not be reported as the
    // reassuring "re-authenticate and try again" message.
    it("get_my_registrations reports a failed re-login distinctly from expiry", async () => {
      const saved = { url: process.env.DRUPAL_API_URL, user: process.env.DRUPAL_USERNAME, pass: process.env.DRUPAL_PASSWORD };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc"; process.env.DRUPAL_PASSWORD = "pw";
        mockGet.mockReset();
        const err = new DrupalApiError(
          "Drupal session expired and re-authentication failed: Drupal login failed: 503 Service Unavailable",
          401,
          undefined,
          "reauth_failed"
        );
        mockGet.mockRejectedValue(err);
        const server = new EventsServer();
        const result = await requestContextStorage.run(
          { actingUser: "apasquale@access-ci.org" } as RequestContext,
          () => server["handleToolCall"]({ method: "tools/call", params: { name: "get_my_registrations", arguments: {} } })
        );
        expect(result.isError).toBe(true);
        const parsed = JSON.parse((result.content[0] as { text: string }).text);
        expect(parsed.error.code).toBe("reauth_failed");
        expect(parsed.error.code).not.toBe("unauthenticated");
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL; else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME; else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD; else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    });

    it("a non-3xx DrupalApiError is NOT swallowed into the auth error", async () => {
      const saved = { url: process.env.DRUPAL_API_URL, user: process.env.DRUPAL_USERNAME, pass: process.env.DRUPAL_PASSWORD };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc"; process.env.DRUPAL_PASSWORD = "pw";
        mockGet.mockReset();
        mockGet.mockRejectedValue(
          new DrupalApiError("Drupal API error (500): boom", 500, { errors: [{ detail: "boom" }] })
        );
        const server = new EventsServer();
        const result = await requestContextStorage.run(
          { actingUser: "apasquale@access-ci.org" } as RequestContext,
          () => server["handleToolCall"]({ method: "tools/call", params: { name: "get_my_registrations", arguments: {} } })
        );
        const parsed = JSON.parse((result.content[0] as { text: string }).text);
        expect(parsed.error.code).not.toBe("unauthenticated");
        expect(parsed.error.message).toContain("boom");
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL; else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME; else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD; else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    });
  });

  describe("cancel_registration", () => {
    const withDrupalEnv = async (
      fn: () => Promise<{ content: { text: string }[]; isError?: boolean }>
    ) => {
      const saved = { url: process.env.DRUPAL_API_URL, user: process.env.DRUPAL_USERNAME, pass: process.env.DRUPAL_PASSWORD };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc"; process.env.DRUPAL_PASSWORD = "pw";
        return await requestContextStorage.run(
          { actingUser: "apasquale@access-ci.org" } as RequestContext,
          fn
        );
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL; else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME; else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD; else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    };

    it("cancel_registration requires registrant_id and confirmed in the schema", () => {
      const tool = new EventsServer()["getTools"]().find((t) => t.name === "cancel_registration");
      const schema = tool?.inputSchema as { required?: string[] };
      expect(schema?.required).toContain("registrant_id");
      expect(schema?.required).toContain("confirmed");
    });

    it("confirmed:false PREVIEWS via a when=all lookup and writes NOTHING", async () => {
      mockGet.mockReset();
      mockDelete.mockReset();
      // The when=all list carries the row for u-1 (event_title/start_date come
      // straight from the /registrations row).
      mockGet.mockResolvedValue({
        registrations: [
          { registrant_id: "u-1", eventinstance_id: "5", event_title: "GPU Workshop", start_date: "2026-08-01T14:00:00Z", end_date: "2026-08-01T15:00:00Z" },
          { registrant_id: "u-2", eventinstance_id: "6", event_title: "Other", start_date: "2026-09-01T14:00:00Z" },
        ],
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({ method: "tools/call", params: { name: "cancel_registration", arguments: { registrant_id: "u-1", confirmed: false } } })
      );
      // The lookup uses when=all so a PAST-dated registration still previews.
      expect(mockGet).toHaveBeenCalledWith(
        "apasquale@access-ci.org",
        "/api/1.0/registrations?when=all"
      );
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        action: "cancel",
        status: "preview",
        executed: false,
        data: {
          registrant_id: "u-1",
          event: { title: "GPU Workshop", start_date: "2026-08-01T14:00:00Z" },
        },
      });
      // Preview writes nothing.
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it("confirmed:false with a registrant_id NOT in the when=all list is a coded not_found", async () => {
      mockGet.mockReset();
      mockDelete.mockReset();
      mockGet.mockResolvedValue({
        registrations: [
          { registrant_id: "u-2", eventinstance_id: "6", event_title: "Other", start_date: "2026-09-01T14:00:00Z" },
        ],
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({ method: "tools/call", params: { name: "cancel_registration", arguments: { registrant_id: "u-1", confirmed: false } } })
      );
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "not_found" } });
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it("truthy-but-not-true confirmed values PREVIEW (strict === true execute-gate), never delete", async () => {
      mockGet.mockReset();
      mockDelete.mockReset();
      mockGet.mockResolvedValue({
        registrations: [
          { registrant_id: "u-1", eventinstance_id: "5", event_title: "GPU Workshop", start_date: "2026-08-01T14:00:00Z" },
        ],
      });
      // A string "true" and the number 1 are truthy but not boolean true; they
      // must land in the PREVIEW path, not the destructive execute path.
      for (const confirmed of ["true", 1]) {
        const result = await withDrupalEnv(() =>
          server["handleToolCall"]({ method: "tools/call", params: { name: "cancel_registration", arguments: { registrant_id: "u-1", confirmed } } })
        );
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          action: "cancel",
          status: "preview",
          executed: false,
          data: { registrant_id: "u-1" },
        });
      }
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it("confirmed:true EXECUTES: DELETE the registration and return the cancelled envelope", async () => {
      mockGet.mockReset();
      mockDelete.mockReset();
      mockDelete.mockResolvedValue({ status: "cancelled", registrant_id: "u-1" });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({ method: "tools/call", params: { name: "cancel_registration", arguments: { registrant_id: "u-1", confirmed: true } } })
      );
      expect(mockDelete).toHaveBeenCalledWith(
        "apasquale@access-ci.org",
        "/api/1.0/registrations/u-1"
      );
      // No preview lookup on the execute path.
      expect(mockGet).not.toHaveBeenCalled();
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        action: "cancel",
        status: "cancelled",
        executed: true,
        data: { registrant_id: "u-1" },
      });
    });

    it("confirmed:true → DrupalApiError 404 maps to a coded not_found", async () => {
      mockDelete.mockReset();
      mockDelete.mockRejectedValue(new DrupalApiError("Drupal API error: 404 Not Found", 404, { error: "not_found" }));
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({ method: "tools/call", params: { name: "cancel_registration", arguments: { registrant_id: "u-1", confirmed: true } } })
      );
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "not_found" } });
    });

    it("confirmed:true → a 403 DrupalApiError maps to forbidden, NOT not_found", async () => {
      mockDelete.mockReset();
      mockDelete.mockRejectedValue(new DrupalApiError("Drupal API error: 403 Forbidden", 403, { error: "forbidden" }));
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({ method: "tools/call", params: { name: "cancel_registration", arguments: { registrant_id: "u-1", confirmed: true } } })
      );
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error.code).toBe("forbidden");
      // Guard: a non-404 must never be mis-mapped to not_found.
      expect(parsed.error.code).not.toBe("not_found");
    });

    it("confirmed:true → a 500 DrupalApiError maps to upstream_error, NOT not_found", async () => {
      mockDelete.mockReset();
      mockDelete.mockRejectedValue(new DrupalApiError("Drupal API error: 500 Server Error", 500, { error: "boom" }));
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({ method: "tools/call", params: { name: "cancel_registration", arguments: { registrant_id: "u-1", confirmed: true } } })
      );
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error.code).toBe("upstream_error");
      expect(parsed.error.message).toMatch(/Events service error \(500\)/i);
      expect(parsed.error.code).not.toBe("not_found");
    });

    it("cancel_registration errors without registrant_id and never calls DELETE or the lookup", async () => {
      mockGet.mockReset();
      mockDelete.mockReset();
      const server = new EventsServer();
      const result = await requestContextStorage.run(
        { actingUser: "apasquale@access-ci.org" } as RequestContext,
        () => server["handleToolCall"]({ method: "tools/call", params: { name: "cancel_registration", arguments: {} } })
      );
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/registrant_id is required/i);
      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockGet).not.toHaveBeenCalled();
    });

    // The PREVIEW lookup (auth.get) can itself throw. It must carry the same
    // machine-readable code as the execute path — not bubble to a bare {error}.
    it("preview → a 403 DrupalApiError on the lookup maps to a coded forbidden", async () => {
      mockGet.mockReset();
      mockDelete.mockReset();
      mockGet.mockRejectedValue(new DrupalApiError("Drupal API error: 403 Forbidden", 403, { error: "forbidden" }));
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({ method: "tools/call", params: { name: "cancel_registration", arguments: { registrant_id: "u-1" } } })
      );
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error.code).toBe("forbidden");
      expect(parsed.error.code).not.toBe("not_found");
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it("preview → a 500 DrupalApiError on the lookup maps to a coded upstream_error", async () => {
      mockGet.mockReset();
      mockDelete.mockReset();
      mockGet.mockRejectedValue(new DrupalApiError("Drupal API error: 500 Server Error", 500, { error: "boom" }));
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({ method: "tools/call", params: { name: "cancel_registration", arguments: { registrant_id: "u-1" } } })
      );
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error.code).toBe("upstream_error");
      expect(parsed.error.code).not.toBe("not_found");
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });

  describe("get_event", () => {
    const withDrupalEnv = async (
      fn: () => Promise<{ content: { text: string }[]; isError?: boolean }>
    ) => {
      const saved = {
        url: process.env.DRUPAL_API_URL,
        user: process.env.DRUPAL_USERNAME,
        pass: process.env.DRUPAL_PASSWORD,
      };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc";
        process.env.DRUPAL_PASSWORD = "pw";
        return await requestContextStorage.run(
          { actingUser: "actor@example.com" } as RequestContext,
          fn
        );
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL;
        else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME;
        else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD;
        else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    };

    it("get_event returns detail and registration block", async () => {
      mockRequestRaw.mockResolvedValue({
        status: 200,
        data: {
          id: "8504",
          title: "OnDemand Call",
          description: "…",
          start_date: "2026-08-06T13:00:00Z",
          series_id: "398",
          registration: {
            enabled: true,
            capacity: 60,
            seats_remaining: 18,
            already_registered: false,
          },
        },
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "get_event", arguments: { eventinstance_id: "8504" } },
        })
      );
      expect(mockRequestRaw).toHaveBeenCalledWith(
        "actor@example.com",
        "GET",
        "/api/2.3/events/8504"
      );
      const body = JSON.parse(result.content[0].text);
      expect(body.id).toBe("8504");
      expect(body.registration.enabled).toBe(true);
      expect(body.registration.seats_remaining).toBe(18);
    });

    it("get_event surfaces capacity_type/capacity/seats_remaining", async () => {
      mockRequestRaw.mockResolvedValue({
        status: 200,
        data: {
          id: "7807",
          title: "X",
          registration: { enabled: true, capacity_type: "limited", capacity: 60, seats_remaining: 12 },
        },
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "get_event", arguments: { eventinstance_id: "7807" } },
        })
      );
      const body = JSON.parse(result.content[0].text);
      expect(body.registration.capacity_type).toBe("limited");
      expect(body.registration.capacity).toBe(60);
      expect(body.registration.seats_remaining).toBe(12);
    });

    it("get_event computes registration_path=native and relocates the external url", async () => {
      mockRequestRaw.mockResolvedValue({
        status: 200,
        data: {
          id: "7807",
          title: "X",
          registration: { enabled: true },
          registration_url: "http://example.com/ext",
        },
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "get_event", arguments: { eventinstance_id: "7807" } },
        })
      );
      const body = JSON.parse(result.content[0].text);
      expect(body.registration_path).toBe("native");
      expect(body.external_registration_url).toBe("http://example.com/ext");
      expect(body.registration_url).toBeUndefined();
    });

    it("get_event computes registration_path=external when native is off and an external url exists", async () => {
      mockRequestRaw.mockResolvedValue({
        status: 200,
        data: {
          id: "7808",
          title: "Y",
          registration: { enabled: false },
          registration_url: "http://example.com/ext",
        },
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "get_event", arguments: { eventinstance_id: "7808" } },
        })
      );
      const body = JSON.parse(result.content[0].text);
      expect(body.registration_path).toBe("external");
      expect(body.registration_url).toBe("http://example.com/ext");
      expect(body.external_registration_url).toBeUndefined();
    });

    it("get_event computes registration_path=none when neither native nor external is available", async () => {
      mockRequestRaw.mockResolvedValue({
        status: 200,
        data: {
          id: "7809",
          title: "Z",
          registration: { enabled: false },
        },
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "get_event", arguments: { eventinstance_id: "7809" } },
        })
      );
      const body = JSON.parse(result.content[0].text);
      expect(body.registration_path).toBe("none");
      expect(body.external_registration_url).toBeUndefined();
    });

    it("get_event maps a 404 to a first-class error (no throw)", async () => {
      mockRequestRaw.mockResolvedValue({
        status: 404,
        data: { error: "not_found" },
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "get_event", arguments: { eventinstance_id: "9999" } },
        })
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/No event found with id 9999/i);
    });

    it("get_event maps a redirect (stale session) to an auth-expired error, not raw HTML", async () => {
      // A stale session makes Drupal 3xx-redirect to CILogon; with maxRedirects:0
      // the client returns the 3xx (not a followed-to-HTML fake 200). The tool must
      // surface a clear auth error, never the login page.
      mockRequestRaw.mockResolvedValue({
        status: 307,
        data: "<!DOCTYPE html><html>…redirect…</html>",
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "get_event", arguments: { eventinstance_id: "9174" } },
        })
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/authentication|session|re-authenticate/i);
      expect(result.content[0].text).not.toMatch(/DOCTYPE|<html/i);
    });

    it("get_event maps an unexpected upstream status to a coded upstream_error", async () => {
      mockRequestRaw.mockResolvedValue({ status: 500, data: { error: "boom" } });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "get_event", arguments: { eventinstance_id: "8504" } },
        })
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Events service error \(500\)/i);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "upstream_error" } });
    });

    it("get_event errors without an eventinstance_id and never calls the service", async () => {
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "get_event", arguments: {} },
        })
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/eventinstance_id is required/i);
      expect(mockRequestRaw).not.toHaveBeenCalled();
    });
  });

  describe("register_for_event", () => {
    const withDrupalEnv = async (
      fn: () => Promise<{ content: { text: string }[]; isError?: boolean }>
    ) => {
      const saved = {
        url: process.env.DRUPAL_API_URL,
        user: process.env.DRUPAL_USERNAME,
        pass: process.env.DRUPAL_PASSWORD,
      };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc";
        process.env.DRUPAL_PASSWORD = "pw";
        return await requestContextStorage.run(
          { actingUser: "actor@example.com" } as RequestContext,
          fn
        );
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL;
        else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME;
        else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD;
        else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    };

    it("register preview maps outcome_if_confirmed to the write envelope", async () => {
      mockRequestRaw.mockResolvedValue({
        status: 200,
        data: { outcome_if_confirmed: "seat", already_registered: false, seats_remaining: 18 },
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "register_for_event", arguments: { eventinstance_id: "5" } },
        })
      );
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        action: "register",
        status: "preview",
        executed: false,
        data: { outcome_if_confirmed: "seat" },
      });
      // Verify a no-write preview was requested: the tool sent confirmed:false.
      expect(mockRequestRaw).toHaveBeenCalledWith(
        "actor@example.com",
        "POST",
        "/api/1.0/events/5/register",
        { confirmed: false }
      );
    });

    it("register preview surfaces waitlisted_count when present", async () => {
      mockRequestRaw.mockResolvedValue({
        status: 200,
        data: { outcome_if_confirmed: "waitlist", already_registered: false, waitlisted_count: 3 },
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "register_for_event", arguments: { eventinstance_id: "5" } },
        })
      );
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        action: "register",
        status: "preview",
        executed: false,
        data: { outcome_if_confirmed: "waitlist", waitlisted_count: 3 },
      });
    });

    it("register commit registered maps to executed write envelope", async () => {
      mockRequestRaw.mockResolvedValue({
        status: 200,
        data: { success: true, status: "registered", registrant_id: "u-123" },
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "register_for_event",
            arguments: { eventinstance_id: "5", confirmed: true },
          },
        })
      );
      expect(mockRequestRaw).toHaveBeenCalledWith(
        "actor@example.com",
        "POST",
        "/api/1.0/events/5/register",
        { confirmed: true }
      );
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        action: "register",
        status: "registered",
        executed: true,
        data: { registrant_id: "u-123" },
      });
    });

    it("register commit waitlisted maps to executed write envelope", async () => {
      mockRequestRaw.mockResolvedValue({
        status: 200,
        data: { success: true, status: "waitlisted", registrant_id: "u-2" },
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "register_for_event",
            arguments: { eventinstance_id: "5", confirmed: true },
          },
        })
      );
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        action: "register",
        status: "waitlisted",
        executed: true,
        data: { registrant_id: "u-2" },
      });
    });

    it("register 409 already_registered is a terminal status, not an error", async () => {
      mockRequestRaw.mockResolvedValue({
        status: 409,
        data: { error: "already_registered", message: "You are already registered." },
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "register_for_event",
            arguments: { eventinstance_id: "5", confirmed: true },
          },
        })
      );
      // already_registered is a first-class result, NOT an errorResponse.
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        action: "register",
        status: "already_registered",
        executed: false,
      });
    });

    it("register 409 event_full is an error with a code", async () => {
      mockRequestRaw.mockResolvedValue({
        status: 409,
        data: { error: "event_full", message: "full" },
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "register_for_event",
            arguments: { eventinstance_id: "5", confirmed: true },
          },
        })
      );
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "event_full" } });
    });

    it("register 409 registration_closed is an error carrying the Drupal code", async () => {
      mockRequestRaw.mockResolvedValue({
        status: 409,
        data: { error: "registration_closed", message: "Registration has closed." },
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "register_for_event",
            arguments: { eventinstance_id: "5", confirmed: true },
          },
        })
      );
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "registration_closed" } });
    });

    it("register_for_event maps a bare gate-403 (no not_permitted) to an actionable error", async () => {
      // A 403 from the ActingUserAccess gate (identity/auth failure) has no
      // not_permitted code — it is a genuine auth failure, not a state refusal.
      mockRequestRaw.mockResolvedValue({
        status: 403,
        data: {},
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "register_for_event",
            arguments: { eventinstance_id: "5", confirmed: true },
          },
        })
      );
      expect(result.isError).toBe(true); // errorResponse, not a first-class refusal
      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "auth_required" } });
    });

    it("register_for_event maps a 404 to a first-class error", async () => {
      mockRequestRaw.mockResolvedValue({ status: 404, data: { error: "not_found" } });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "register_for_event",
            arguments: { eventinstance_id: "9999", confirmed: true },
          },
        })
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/No event found with id 9999/i);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "not_found" } });
    });

    it("register_for_event maps an unexpected upstream status to upstream_error", async () => {
      mockRequestRaw.mockResolvedValue({ status: 500, data: { error: "boom" } });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "register_for_event",
            arguments: { eventinstance_id: "5", confirmed: true },
          },
        })
      );
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "upstream_error" } });
    });

    it("register_for_event errors without an eventinstance_id and never calls the service", async () => {
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "register_for_event", arguments: {} },
        })
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/eventinstance_id is required/i);
      expect(mockRequestRaw).not.toHaveBeenCalled();
    });
  });

  describe("fields projection (Pillar 2)", () => {
    const mockEventsData = [
      {
        id: "1",
        title: "Python Workshop",
        description: "Learn Python basics",
        start_date: "2024-08-30T09:00:00",
        end_date: "2024-08-30T17:00:00",
        event_type: "workshop",
        tags: ["python"],
        url: "https://support.access-ci.org/events/python-workshop",
      },
    ];

    it("should project search_events response to requested fields only", async () => {
      mockHttpClient.get.mockResolvedValue({ status: 200, data: mockEventsData });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_events",
          arguments: { fields: ["total", "items[].title"] },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.total).toBe(1);
      expect(Object.keys(responseData.items[0])).toEqual(["title"]);
      expect(responseData.items[0].title).toBe("Python Workshop");
      // metadata + documentation are sticky containers — preserved on projection.
      expect(responseData.metadata).toBeDefined();
      expect(responseData.documentation).toBeDefined();
    });

    it("should always preserve total even when fields omits it", async () => {
      mockHttpClient.get.mockResolvedValue({ status: 200, data: mockEventsData });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "search_events",
          arguments: { fields: ["metadata.pagination.has_more"] },
        },
      });

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.total).toBe(1);
      expect(responseData.metadata.pagination.has_more).toBeDefined();
      expect(responseData.items).toBeUndefined();
    });

    it("should advertise fields parameter and supportsFieldProjection on opted-in tools", () => {
      const tools = server["getTools"]();

      const searchTool = tools.find((t: { name: string }) => t.name === "search_events");
      expect(searchTool?.inputSchema.properties?.fields).toBeDefined();
      expect((searchTool as { _meta?: { supportsFieldProjection?: boolean } })._meta?.supportsFieldProjection).toBe(true);

      const myTool = tools.find((t: { name: string }) => t.name === "get_my_events");
      expect(myTool?.inputSchema.properties?.fields).toBeDefined();
      expect((myTool as { _meta?: { supportsFieldProjection?: boolean } })._meta?.supportsFieldProjection).toBe(true);
    });
  });

  describe("get_my_events display URL", () => {
    it("get_my_events queries the mcp_my_events JSON:API display", async () => {
      const saved = {
        url: process.env.DRUPAL_API_URL,
        user: process.env.DRUPAL_USERNAME,
        pass: process.env.DRUPAL_PASSWORD,
      };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc";
        process.env.DRUPAL_PASSWORD = "pw";
        mockGet.mockReset();
        mockGet.mockResolvedValue({ data: [] });
        const server = new EventsServer();
        await requestContextStorage.run(
          { actingUser: "apasquale@access-ci.org" } as RequestContext,
          () =>
            server["handleToolCall"]({
              method: "tools/call",
              params: { name: "get_my_events", arguments: { limit: 5 } },
            })
        );
        expect(mockGet).toHaveBeenCalledWith(
          "apasquale@access-ci.org",
          "/jsonapi/views/event_instance_mine/mcp_my_events?page[limit]=6"
        );
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL;
        else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME;
        else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD;
        else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    });

    it("maps the daterange 'date' and moderation_state from the JSON:API base entity", async () => {
      const saved = {
        url: process.env.DRUPAL_API_URL,
        user: process.env.DRUPAL_USERNAME,
        pass: process.env.DRUPAL_PASSWORD,
      };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc";
        process.env.DRUPAL_PASSWORD = "pw";
        mockGet.mockReset();
        // jsonapi_views serializes the base eventinstance entity: the date is a
        // daterange field ({value, end_value}, naive UTC), status is the boolean
        // publish flag, and moderation_state carries the real editorial state.
        mockGet.mockResolvedValue({
          data: [
            {
              id: "uuid-1",
              type: "eventinstance--instance",
              attributes: {
                title: "Sage Office Hours",
                date: [{ value: "2026-07-23T20:00:00", end_value: "2026-07-23T21:00:00" }],
                status: false,
                moderation_state: "ready_for_review",
              },
            },
          ],
        });
        const server = new EventsServer();
        const result = await requestContextStorage.run(
          { actingUser: "apasquale@access-ci.org" } as RequestContext,
          () =>
            server["handleToolCall"]({
              method: "tools/call",
              params: { name: "get_my_events", arguments: { limit: 5 } },
            })
        );
        const payload = JSON.parse(
          (result.content[0] as { text: string }).text
        );
        const item = payload.items[0];
        // start_date/end_date come from the daterange, with Z appended so the
        // naive-UTC strings are unambiguous ISO instants.
        expect(item.start_date).toBe("2026-07-23T20:00:00Z");
        expect(item.end_date).toBe("2026-07-23T21:00:00Z");
        // status is the editorial moderation_state, NOT the raw publish boolean.
        expect(item.status).toBe("ready_for_review");
        // the raw publish boolean must not leak back over the mapped status.
        expect(typeof item.status).toBe("string");
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL;
        else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME;
        else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD;
        else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    });

    it("canonicalizes an offset-bearing daterange to UTC Z (matches search_events/get_event form)", async () => {
      const saved = {
        url: process.env.DRUPAL_API_URL,
        user: process.env.DRUPAL_USERNAME,
        pass: process.env.DRUPAL_PASSWORD,
      };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc";
        process.env.DRUPAL_PASSWORD = "pw";
        mockGet.mockReset();
        // The real jsonapi view emits offset-bearing values (site-local clock +
        // its offset), e.g. 15:00:00-05:00. That's a correct instant but a
        // different string form than the flat read tools' "…Z". Canonicalize it.
        mockGet.mockResolvedValue({
          data: [
            {
              id: "uuid-2",
              type: "eventinstance--instance",
              attributes: {
                title: "Chicago Workshop",
                date: [{ value: "2025-11-11T15:00:00-05:00", end_value: "2025-11-11T16:00:00-05:00" }],
                status: true,
                moderation_state: "published",
              },
            },
            {
              id: "uuid-3",
              type: "eventinstance--instance",
              attributes: {
                title: "Already UTC",
                // already-Z passthrough branch: must return unchanged.
                date: [{ value: "2025-12-01T18:00:00Z", end_value: "2025-12-01T19:00:00Z" }],
                status: true,
                moderation_state: "published",
              },
            },
          ],
        });
        const server = new EventsServer();
        const result = await requestContextStorage.run(
          { actingUser: "apasquale@access-ci.org" } as RequestContext,
          () =>
            server["handleToolCall"]({
              method: "tools/call",
              params: { name: "get_my_events", arguments: { limit: 5 } },
            })
        );
        const items = JSON.parse((result.content[0] as { text: string }).text).items;
        const item = items[0];
        // 15:00 at -05:00 == 20:00 UTC; emitted as "…Z", no offset, no millis.
        expect(item.start_date).toBe("2025-11-11T20:00:00Z");
        expect(item.end_date).toBe("2025-11-11T21:00:00Z");
        // already-Z value passes through unchanged (identity branch).
        expect(items[1].start_date).toBe("2025-12-01T18:00:00Z");
        expect(items[1].end_date).toBe("2025-12-01T19:00:00Z");
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL;
        else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME;
        else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD;
        else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    });

    // Phase 3b Task 2: get_my_events' has_more (limit+1 probe) is already
    // honest — this only fixes the metadata LIES: total was page-length
    // (events.length), not a lower bound, and offset:0 was hardcoded without
    // being tied to an actual (non-)paging story. No offset paging is added
    // here — get_my_events' jsonapi page[offset] support is unverified
    // (authed endpoint), so offset stays a legitimate 0 (no paging exists).
    it("emits total_lower_bound and a legitimate offset:0, has_more stays honest (limit+1 probe unchanged)", async () => {
      const saved = {
        url: process.env.DRUPAL_API_URL,
        user: process.env.DRUPAL_USERNAME,
        pass: process.env.DRUPAL_PASSWORD,
      };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc";
        process.env.DRUPAL_PASSWORD = "pw";
        mockGet.mockReset();
        // limit 5 requested → fetch is limit+1=6; return 6 items so has_more
        // is honestly true (one more than requested exists).
        const items = Array.from({ length: 6 }, (_, i) => ({
          id: `uuid-${i}`,
          type: "eventinstance--instance",
          attributes: {
            title: `Event ${i}`,
            date: [{ value: "2026-07-23T20:00:00", end_value: "2026-07-23T21:00:00" }],
            status: true,
            moderation_state: "published",
          },
        }));
        mockGet.mockResolvedValue({ data: items });
        const server = new EventsServer();
        const result = await requestContextStorage.run(
          { actingUser: "apasquale@access-ci.org" } as RequestContext,
          () =>
            server["handleToolCall"]({
              method: "tools/call",
              params: { name: "get_my_events", arguments: { limit: 5 } },
            })
        );
        const payload = JSON.parse((result.content[0] as { text: string }).text);

        // has_more: unchanged, honest limit+1 probe (6 fetched > 5 limit).
        expect(payload.metadata.pagination.has_more).toBe(true);
        // offset: still legitimately 0 (no paging added), not a lie anymore
        // because get_my_events genuinely never advances past record 0.
        expect(payload.metadata.pagination.offset).toBe(0);
        // total_lower_bound replaces the old page-length `total` lie.
        expect(payload.metadata.pagination.total_lower_bound).toBe(5);
        // top-level total stays a number via the lower-bound fallback.
        expect(payload.total).toBe(5);
        expect(payload.items).toHaveLength(5);
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL;
        else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME;
        else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD;
        else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    });

    it("limit:0 is preserved as count-only (was coerced to 50 by the old `|| 50`), consistent with search_events", async () => {
      const saved = {
        url: process.env.DRUPAL_API_URL,
        user: process.env.DRUPAL_USERNAME,
        pass: process.env.DRUPAL_PASSWORD,
      };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc";
        process.env.DRUPAL_PASSWORD = "pw";
        mockGet.mockReset();
        mockGet.mockResolvedValue({ data: [] });
        const server = new EventsServer();
        const result = await requestContextStorage.run(
          { actingUser: "apasquale@access-ci.org" } as RequestContext,
          () =>
            server["handleToolCall"]({
              method: "tools/call",
              params: { name: "get_my_events", arguments: { limit: 0 } },
            })
        );
        // `params.limit || 50` turned an explicit 0 into 50; coerceLimit
        // preserves it, so the fetch asks for page[limit]=1 (0+1 probe).
        expect(mockGet).toHaveBeenCalledWith(
          "apasquale@access-ci.org",
          "/jsonapi/views/event_instance_mine/mcp_my_events?page[limit]=1"
        );
        const payload = JSON.parse((result.content[0] as { text: string }).text);
        expect(result.content[0].text).not.toContain('"error"');
        expect(payload.items).toEqual([]);
        expect(payload.metadata.pagination.limit).toBe(0);
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL;
        else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME;
        else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD;
        else process.env.DRUPAL_PASSWORD = saved.pass;
      }
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
    // — events emits `cancelled` (announcements does not).
    const STATUS_VOCAB = new Set([
      "preview",
      "registered",
      "waitlisted",
      "already_registered",
      "cancelled",
      "created",
      "updated",
      "deleted",
    ]);
    const assertEnvelope = (parsed: Record<string, unknown>) =>
      assertWriteEnvelope(parsed, STATUS_VOCAB, expect);

    const withDrupalEnv = async (
      fn: () => Promise<{ content: { text: string }[]; isError?: boolean }>
    ) => {
      const saved = {
        url: process.env.DRUPAL_API_URL,
        user: process.env.DRUPAL_USERNAME,
        pass: process.env.DRUPAL_PASSWORD,
      };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc";
        process.env.DRUPAL_PASSWORD = "pw";
        return await requestContextStorage.run(
          { actingUser: "actor@example.com" } as RequestContext,
          fn
        );
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL;
        else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME;
        else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD;
        else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    };

    const dispatch = (mockData: unknown, mockStatus: number, args: Record<string, unknown>) => {
      mockRequestRaw.mockResolvedValue({ status: mockStatus, data: mockData });
      return withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "register_for_event", arguments: { eventinstance_id: "5", ...args } },
        })
      );
    };

    // action | scenario | mock (status,data) | args | expected status/executed
    const cases: Array<{
      name: string;
      mockStatus: number;
      mockData: unknown;
      args: Record<string, unknown>;
      status: string;
      executed: boolean;
    }> = [
      {
        name: "register preview",
        mockStatus: 200,
        mockData: { outcome_if_confirmed: "seat", already_registered: false },
        args: {},
        status: "preview",
        executed: false,
      },
      {
        name: "register commit → registered",
        mockStatus: 200,
        mockData: { success: true, status: "registered", registrant_id: "u-1" },
        args: { confirmed: true },
        status: "registered",
        executed: true,
      },
      {
        name: "register commit → waitlisted",
        mockStatus: 200,
        mockData: { success: true, status: "waitlisted", registrant_id: "u-2" },
        args: { confirmed: true },
        status: "waitlisted",
        executed: true,
      },
      {
        name: "register 409 → already_registered",
        mockStatus: 409,
        mockData: { error: "already_registered", message: "You are already registered." },
        args: { confirmed: true },
        status: "already_registered",
        executed: false,
      },
    ];

    for (const c of cases) {
      it(`${c.name} produces a conformant envelope`, async () => {
        const result = await dispatch(c.mockData, c.mockStatus, c.args);
        const parsed = JSON.parse(result.content[0].text);
        assertEnvelope(parsed);
        expect(parsed.action).toBe("register");
        expect(parsed.status).toBe(c.status);
        // Truth table (spec §2.1 rank-5): executed matches per status. NO `changed`.
        expect(parsed.executed).toBe(c.executed);
      });
    }

    // cancel_registration now emits the envelope too (Task 9). Cancel's write
    // paths run through auth.get (preview lookup) + auth.delete (execute), not
    // requestRaw, so exercise it with its own dispatch.
    it("cancel preview produces a conformant envelope", async () => {
      mockGet.mockReset();
      mockDelete.mockReset();
      mockGet.mockResolvedValue({
        registrations: [
          { registrant_id: "u-1", eventinstance_id: "5", event_title: "GPU Workshop", start_date: "2026-08-01T14:00:00Z" },
        ],
      });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "cancel_registration", arguments: { registrant_id: "u-1", confirmed: false } },
        })
      );
      const parsed = JSON.parse(result.content[0].text);
      assertEnvelope(parsed);
      expect(parsed.action).toBe("cancel");
      expect(parsed.status).toBe("preview");
      expect(parsed.executed).toBe(false);
    });

    it("cancel commit → cancelled produces a conformant envelope", async () => {
      mockGet.mockReset();
      mockDelete.mockReset();
      mockDelete.mockResolvedValue({ status: "cancelled", registrant_id: "u-1" });
      const result = await withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: { name: "cancel_registration", arguments: { registrant_id: "u-1", confirmed: true } },
        })
      );
      const parsed = JSON.parse(result.content[0].text);
      assertEnvelope(parsed);
      expect(parsed.action).toBe("cancel");
      expect(parsed.status).toBe("cancelled");
      expect(parsed.executed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Organizer write toolset: create_event, update_event, delete_event,
  // restore_event, send_for_review, cancel_occurrence, restore_occurrence,
  // edit_occurrence, add_occurrence.
  // ---------------------------------------------------------------------------
  describe("organizer write tools", () => {
    const withDrupalEnv = async (
      fn: () => Promise<{ content: { text: string }[]; isError?: boolean }>
    ) => {
      const saved = {
        url: process.env.DRUPAL_API_URL,
        user: process.env.DRUPAL_USERNAME,
        pass: process.env.DRUPAL_PASSWORD,
      };
      try {
        process.env.DRUPAL_API_URL = "https://drupal.example";
        process.env.DRUPAL_USERNAME = "svc";
        process.env.DRUPAL_PASSWORD = "pw";
        return await requestContextStorage.run(
          { actingUser: "actor@example.com" } as RequestContext,
          fn
        );
      } finally {
        if (saved.url === undefined) delete process.env.DRUPAL_API_URL;
        else process.env.DRUPAL_API_URL = saved.url;
        if (saved.user === undefined) delete process.env.DRUPAL_USERNAME;
        else process.env.DRUPAL_USERNAME = saved.user;
        if (saved.pass === undefined) delete process.env.DRUPAL_PASSWORD;
        else process.env.DRUPAL_PASSWORD = saved.pass;
      }
    };

    const call = (name: string, args: Record<string, unknown>) =>
      withDrupalEnv(() =>
        server["handleToolCall"]({
          method: "tools/call",
          params: { name, arguments: args },
        })
      );

    beforeEach(() => {
      mockRequestRaw.mockReset();
    });

    describe("schema shapes", () => {
      it("create_event requires the fields site validation enforces (affinity group and recur_type stay optional)", () => {
        const tool = server["getTools"]().find((t) => t.name === "create_event")!;
        const schema = tool.inputSchema as { required?: string[] };
        // field_event_type and field_location mirror the site's required: true
        // field config — the Drupal API refuses creation without them, so the
        // schema must not advertise them as optional. recur_type is NOT in this
        // list: it's conditionally required (recur_type OR recurrence), enforced
        // by the handler guard, not JSON-Schema — otherwise the framework would
        // reject any recurrence-only call before the handler ever runs.
        expect(schema.required).toEqual([
          "title",
          "field_event_type",
          "field_location",
        ]);
        expect(schema.required).not.toContain("field_affinity_group_node");
        expect(schema.required).not.toContain("recur_type");
      });

      it("update_event requires only eventseries_id and does NOT expose confirmed (content-only, no preview step)", () => {
        const tool = server["getTools"]().find((t) => t.name === "update_event")!;
        const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
        expect(schema.required).toEqual(["eventseries_id"]);
        expect(schema.properties?.confirmed).toBeUndefined();
      });

      it("delete_event requires eventseries_id and exposes confirmed", () => {
        const tool = server["getTools"]().find((t) => t.name === "delete_event")!;
        const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
        expect(schema.required).toEqual(["eventseries_id"]);
        expect(schema.properties?.confirmed).toBeDefined();
      });

      it("restore_event and send_for_review require only eventseries_id (no confirm)", () => {
        for (const name of ["restore_event", "send_for_review"]) {
          const tool = server["getTools"]().find((t) => t.name === name)!;
          const schema = tool.inputSchema as { required?: string[] };
          expect(schema.required).toEqual(["eventseries_id"]);
        }
      });

      it("cancel_occurrence requires eventinstance_id and exposes confirmed", () => {
        const tool = server["getTools"]().find((t) => t.name === "cancel_occurrence")!;
        const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
        expect(schema.required).toEqual(["eventinstance_id"]);
        expect(schema.properties?.confirmed).toBeDefined();
      });

      it("restore_occurrence requires only eventinstance_id", () => {
        const tool = server["getTools"]().find((t) => t.name === "restore_occurrence")!;
        const schema = tool.inputSchema as { required?: string[] };
        expect(schema.required).toEqual(["eventinstance_id"]);
      });

      it("edit_occurrence requires eventinstance_id and exposes date/field_location/confirmed", () => {
        const tool = server["getTools"]().find((t) => t.name === "edit_occurrence")!;
        const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
        expect(schema.required).toEqual(["eventinstance_id"]);
        expect(schema.properties?.date).toBeDefined();
        expect(schema.properties?.field_location).toBeDefined();
        expect(schema.properties?.confirmed).toBeDefined();
      });

      it("add_occurrence requires eventseries_id and date", () => {
        const tool = server["getTools"]().find((t) => t.name === "add_occurrence")!;
        const schema = tool.inputSchema as { required?: string[] };
        expect(schema.required).toEqual(["eventseries_id", "date"]);
      });
    });

    describe("doc-text teaching topics", () => {
      const toolDoc = (name: string) => server["getTools"]().find((t) => t.name === name)!.description;

      it("cancel_occurrence teaches the postponement story and partial restore", () => {
        const doc = toolDoc("cancel_occurrence");
        expect(doc).toContain("edit_occurrence");
        expect(doc).toContain("restore_occurrence");
        expect(doc.toLowerCase()).toContain("partial");
      });

      it("edit_occurrence teaches the live-reschedule story, contrasts the postpone-with-a-gap story, and notes there is no whole-schedule rebuild", () => {
        const doc = toolDoc("edit_occurrence");
        expect(doc).toContain("cancel_occurrence");
        expect(doc).toContain("registrants_to_notify");
        expect(doc.toLowerCase()).toContain("no whole-schedule rebuild");
      });

      it("restore_occurrence teaches dates-before-restore ordering and duplicate_date -> restore_occurrence", () => {
        const doc = toolDoc("restore_occurrence");
        expect(doc).toContain("returns_with_series");
        expect(doc.toLowerCase()).toContain("before");
        expect(doc).toContain("duplicate_date");
      });

      it("add_occurrence teaches duplicate_date -> restore_occurrence", () => {
        const doc = toolDoc("add_occurrence");
        expect(doc).toContain("duplicate_date");
        expect(doc).toContain("restore_occurrence");
      });

      it("update_event is documented as content-only and never dates/state, pointing schedule/state changes elsewhere", () => {
        const doc = toolDoc("update_event");
        expect(doc.toLowerCase()).toContain("content");
        expect(doc).toContain("edit_occurrence");
        expect(doc).toContain("add_occurrence");
        expect(doc).toContain("delete_event");
        expect(doc).toContain("restore_event");
        expect(doc).toContain("send_for_review");
        // No stray preview/confirm language — update_event has no preview step.
        expect(doc).not.toContain("confirmed:true");
        // No update_recurrence reference — that tool doesn't exist (no route).
        expect(doc).not.toContain("update_recurrence");
      });

      it("update_event and add_occurrence both teach that the API deliberately has no whole-schedule rebuild operation", () => {
        // The teaching relocated from the removed update_recurrence tool: no
        // whole-pattern rebuild surface exists anywhere in the API (verified
        // absent from access_events.routing.yml) — schedule changes are
        // per-occurrence only, via edit_occurrence/add_occurrence/cancel_occurrence.
        for (const name of ["update_event", "add_occurrence"]) {
          const doc = toolDoc(name);
          expect(doc.toLowerCase()).toContain("no whole-schedule rebuild");
          expect(doc).toContain("edit_occurrence");
          expect(doc).toContain("cancel_occurrence");
        }
        // update_event's version names add_occurrence explicitly as the third leg.
        expect(toolDoc("update_event")).toContain("add_occurrence");
      });

      it("update_event and add_occurrence teach that a registered series' recurrence pattern can never be rebuilt, and the reschedule path is cancel -> edit dates -> restore", () => {
        for (const name of ["update_event", "add_occurrence"]) {
          const doc = toolDoc(name);
          expect(doc.toLowerCase()).toContain("never be rebuilt");
          expect(doc.toLowerCase()).toContain("registrations");
          expect(doc).toContain("cancel_occurrence");
          expect(doc).toContain("edit_occurrence");
          expect(doc).toContain("restore_occurrence");
        }
      });

      it("delete_event and restore_event cross-reference each other", () => {
        expect(toolDoc("delete_event")).toContain("restore_event");
      });

      it("create_event documents the draft-only moderation block", () => {
        const doc = toolDoc("create_event");
        expect(doc.toLowerCase()).toContain("draft");
        expect(doc).toContain("can_publish");
        expect(doc).toContain("send_for_review");
      });

      it("every write tool's description surfaces the relevant envelope fields", () => {
        expect(toolDoc("delete_event")).toContain("instances_archived");
        expect(toolDoc("delete_event")).toContain("notified");
        expect(toolDoc("delete_event")).toContain("notifications_disabled");
        expect(toolDoc("restore_event")).toContain("instances_restored");
        expect(toolDoc("cancel_occurrence")).toContain("registrants_affected");
        expect(toolDoc("restore_occurrence")).toContain("returns_with_series");
      });
    });

    describe("create_event", () => {
      it("POSTs to /api/2.3/events?confirmed=true and maps a created response", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: {
            success: true,
            series_id: 42,
            instance_ids: [100, 101],
            title: "GPU Bootcamp",
            moderation_state: "draft",
            moderation: { state: "draft", can_publish: false, next_action: "send_for_review", message: "Saved as a draft." },
          },
        });
        const result = await call("create_event", {
          title: "GPU Bootcamp",
          recur_type: "custom",
          field_affinity_group_node: ["uuid-1"],
          custom_dates: [{ start_date: "2026-09-01T14:00:00", end_date: "2026-09-01T15:00:00" }],
          confirmed: true,
        });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "POST",
          "/api/2.3/events?confirmed=true",
          expect.objectContaining({ title: "GPU Bootcamp", recur_type: "custom", field_affinity_group_node: ["uuid-1"] })
        );
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed).toMatchObject({
          action: "create",
          status: "created",
          executed: true,
          data: { series_id: 42, instance_ids: [100, 101], moderation_state: "draft" },
        });
      });

      it("confirmed omitted previews via a query-string flag and writes nothing", async () => {
        const occurrences = [
          { start_date: "2026-09-01T09:00:00+00:00", end_date: "2026-09-01T10:00:00+00:00" },
          { start_date: "2026-09-08T09:00:00+00:00", end_date: "2026-09-08T10:00:00+00:00" },
        ];
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: {
            status: "preview",
            executed: false,
            occurrence_count: 2,
            truncated: false,
            occurrences,
          },
        });
        const result = await call("create_event", {
          title: "GPU Bootcamp",
          recurrence: {
            frequency: "weekly",
            start_date: "2026-09-01",
            end_date: "2026-09-30",
            days: ["tue"],
            start_time: "09:00",
            duration_minutes: 60,
          },
        });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "POST",
          "/api/2.3/events?confirmed=false",
          expect.objectContaining({ title: "GPU Bootcamp" })
        );
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          action: "create",
          status: "preview",
          executed: false,
          data: { occurrence_count: 2, truncated: false, occurrences },
        });
      });

      it("forwards truncated:true and total_occurrence_count verbatim when Drupal's hard cap clipped the occurrence set", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: {
            status: "preview",
            executed: false,
            occurrence_count: 1000,
            total_occurrence_count: 3200,
            truncated: true,
            occurrences: [{ start_date: "2026-09-01T09:00:00+00:00", end_date: "2026-09-01T10:00:00+00:00" }],
          },
        });
        const result = await call("create_event", {
          title: "Daily Forever",
          recurrence: {
            frequency: "daily",
            start_date: "2026-09-01",
            end_date: "2099-09-01",
            start_time: "09:00",
            duration_minutes: 60,
          },
        });
        // The MCP forwards data verbatim: the agent can honestly say "3,200
        // occurrences, showing the first 1,000" rather than the vague "1000+".
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          status: "preview",
          executed: false,
          data: { occurrence_count: 1000, total_occurrence_count: 3200, truncated: true },
        });
      });

      it("A6: falls through to the CREATED envelope when Drupal ignores ?confirmed=false and commits anyway", async () => {
        // Simulates a deploy-order mismatch: the MCP sends ?confirmed=false but
        // an older Drupal that doesn't understand the param ignores it and
        // creates for real. The MCP must report the truth, not a fake preview.
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: {
            status: "created",
            executed: true,
            success: true,
            series_id: 77,
            instance_ids: [300, 301],
            title: "Accidental Commit",
            moderation_state: "draft",
            moderation: { state: "draft", can_publish: false, next_action: "send_for_review", message: "Saved as a draft." },
          },
        });
        const result = await call("create_event", {
          title: "Accidental Commit",
          recurrence: {
            frequency: "weekly",
            start_date: "2026-09-01",
            end_date: "2026-09-30",
            days: ["tue"],
            start_time: "09:00",
            duration_minutes: 60,
          },
        });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "POST",
          "/api/2.3/events?confirmed=false",
          expect.objectContaining({ title: "Accidental Commit" })
        );
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          action: "create",
          status: "created",
          executed: true,
          data: { series_id: 77, instance_ids: [300, 301], moderation_state: "draft" },
        });
      });

      it("requires title/recur_type-or-recurrence client-side without calling Drupal", async () => {
        const r1 = await call("create_event", { recur_type: "custom", field_affinity_group_node: ["u"] });
        expect(r1.isError).toBe(true);
        expect(r1.content[0].text).toMatch(/title is required/i);

        const r2 = await call("create_event", { title: "X", field_affinity_group_node: ["u"] });
        expect(r2.isError).toBe(true);
        expect(r2.content[0].text).toMatch(/recur_type or recurrence is required/i);

        expect(mockRequestRaw).not.toHaveBeenCalled();
      });

      it("rejects recurrence + recur_type both set, before any POST (no silent override)", async () => {
        const result = await call("create_event", {
          title: "Both set",
          field_event_type: "Training",
          field_location: "Building 42",
          recur_type: "custom",
          recurrence: {
            frequency: "weekly",
            start_date: "2026-10-01",
            end_date: "2026-10-31",
            days: ["mon"],
            start_time: "09:00",
            duration_minutes: 60,
          },
        });
        expect(mockRequestRaw).not.toHaveBeenCalled();
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.status).toBe("error");
        expect(parsed.error.code).toBe("validation_error");
        expect(parsed.error.message).toMatch(/recurrence and recur_type are mutually exclusive/i);
      });

      it("create_event with no affinity group reaches the Drupal write path (not rejected)", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: {
            success: true,
            series_id: 7,
            instance_ids: [],
            title: "No-group event",
            moderation_state: "draft",
            moderation: { state: "draft", can_publish: false, next_action: "send_for_review", message: "Saved as a draft." },
          },
        });
        const result = await call("create_event", {
          title: "No-group event",
          recur_type: "custom",
          custom_dates: [{ start_date: "2026-09-01T14:00:00", end_date: "2026-09-01T15:00:00" }],
          confirmed: true,
        });
        // The old client-side guard is gone: the request reaches Drupal.
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "POST",
          "/api/2.3/events?confirmed=true",
          expect.objectContaining({ title: "No-group event", recur_type: "custom" })
        );
        expect(JSON.stringify(result)).not.toMatch(/field_affinity_group_node is required/i);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.executed).toBe(true);
      });

      it("create_event forwards field_event_timezone and field_event_in_person to the POST body", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: {
            success: true, series_id: 8, instance_ids: [], title: "TZ event",
            moderation_state: "draft",
            moderation: { state: "draft", can_publish: false, next_action: "send_for_review", message: "Saved as a draft." },
          },
        });
        await call("create_event", {
          title: "TZ event",
          recur_type: "custom",
          custom_dates: [{ start_date: "2026-09-01T14:00:00", end_date: "2026-09-01T15:00:00" }],
          field_event_timezone: "America/Los_Angeles",
          field_event_in_person: true,
          confirmed: true,
        });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "POST",
          "/api/2.3/events?confirmed=true",
          expect.objectContaining({
            field_event_timezone: "America/Los_Angeles",
            field_event_in_person: true,
          })
        );
      });

      it("create_event with an explicit empty affinity-group array reaches the write path", async () => {
        // The old guard rejected empty-array too (|| length === 0); it must not now.
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: {
            success: true,
            series_id: 8,
            instance_ids: [],
            title: "Empty-array group",
            moderation_state: "draft",
            moderation: { state: "draft", can_publish: false, next_action: "send_for_review", message: "Saved as a draft." },
          },
        });
        const result = await call("create_event", {
          title: "Empty-array group",
          recur_type: "custom",
          field_affinity_group_node: [],
          custom_dates: [{ start_date: "2026-09-01T14:00:00", end_date: "2026-09-01T15:00:00" }],
          confirmed: true,
        });
        expect(mockRequestRaw).toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toMatch(/field_affinity_group_node is required/i);
        expect(JSON.parse(result.content[0].text).executed).toBe(true);
      });

      it("maps a not_coordinator 409 to a coded error", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 409,
          data: { error: "not_coordinator", message: "You are not a coordinator of the selected affinity group(s)." },
        });
        const result = await call("create_event", {
          title: "X",
          recur_type: "custom",
          field_affinity_group_node: ["uuid-1"],
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "not_coordinator" } });
      });

      it("passes field_event_type and field_location through to the POST body", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: {
            success: true,
            series_id: 43,
            instance_ids: [110],
            title: "Typed Event",
            moderation_state: "draft",
            moderation: { state: "draft", can_publish: false, next_action: "send_for_review", message: "Saved as a draft." },
          },
        });
        await call("create_event", {
          title: "Typed Event",
          recur_type: "custom",
          custom_dates: [{ start_date: "2026-09-01T14:00:00", end_date: "2026-09-01T15:00:00" }],
          field_event_type: "Training",
          field_location: "Building 42",
          confirmed: true,
        });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "POST",
          "/api/2.3/events?confirmed=true",
          expect.objectContaining({
            field_event_type: "Training",
            field_location: "Building 42",
          })
        );
      });

      it("maps a 422 validation_error to a coded error naming the field", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 422,
          data: { error: "validation_error", message: "field_event_type: This value should not be null." },
        });
        const result = await call("create_event", {
          title: "X",
          recur_type: "custom",
          custom_dates: [{ start_date: "2026-09-01T14:00:00", end_date: "2026-09-01T15:00:00" }],
          field_location: "Building 42",
        });
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed).toMatchObject({ error: { code: "validation_error" } });
        expect(parsed.error.message).toContain("field_event_type");
      });
    });

    describe("create_event with recurrence", () => {
      const validRecurrence = {
        frequency: "weekly",
        start_date: "2026-09-01",
        end_date: "2026-09-30",
        start_time: "14:00",
        duration_minutes: 60,
        days: ["mon"],
      };

      it("(a) recurrence object → native weekly_recurring_date columns in the POST body", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: {
            success: true,
            series_id: 50,
            instance_ids: [200],
            title: "Weekly Standup",
            moderation_state: "draft",
            moderation: { state: "draft", can_publish: false, next_action: "send_for_review", message: "Saved as a draft." },
          },
        });
        await call("create_event", {
          title: "Weekly Standup",
          field_event_type: "Training",
          field_location: "Building 42",
          recurrence: validRecurrence,
        });
        const body = mockRequestRaw.mock.calls[0][3];
        expect(body).toMatchObject({
          recur_type: "weekly_recurring_date",
          weekly_recurring_date: expect.objectContaining({
            value: "2026-09-01T00:00:00",
            end_value: "2026-09-30T00:00:00",
            days: "monday",
          }),
        });
      });

      it("(b) a raw rule recur_type without a recurrence object is refused with a redirect to recurrence, before any POST", async () => {
        const result = await call("create_event", {
          title: "Raw Key Attempt",
          recur_type: "weekly_recurring_date",
          field_event_type: "Training",
          field_location: "Building 42",
          weekly_recurring_date: {
            value: "2026-09-01",
            end_value: "2026-09-30",
            time: "02:00 PM",
            days: "monday",
            duration_or_end_time: "duration",
            duration: 3600,
            end_time: "",
          },
        });
        // Refused at the MCP boundary — never forwarded to Drupal.
        expect(mockRequestRaw).not.toHaveBeenCalled();
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.status).toBe("error");
        expect(parsed.error.code).toBe("validation_error");
        // The error redirects the caller to the recurrence object.
        expect(parsed.error.hint).toMatch(/recurrence object/i);
        expect(parsed.error.hint).toMatch(/"frequency"/);
      });

      it("(c) content fields (body, field_summary) are still forwarded alongside recurrence", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: {
            success: true,
            series_id: 52,
            instance_ids: [202],
            title: "Content Fields",
            moderation_state: "draft",
            moderation: { state: "draft", can_publish: false, next_action: "send_for_review", message: "Saved as a draft." },
          },
        });
        await call("create_event", {
          title: "Content Fields",
          field_event_type: "Training",
          field_location: "Building 42",
          body: "Description body",
          field_summary: "A short summary",
          recurrence: validRecurrence,
        });
        const body = mockRequestRaw.mock.calls[0][3];
        expect(body).toMatchObject({
          body: "Description body",
          field_summary: "A short summary",
        });
      });

      it("(d) recur_type:custom with custom_dates still works unchanged", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: {
            success: true,
            series_id: 53,
            instance_ids: [203],
            title: "Custom Dates Event",
            moderation_state: "draft",
            moderation: { state: "draft", can_publish: false, next_action: "send_for_review", message: "Saved as a draft." },
          },
        });
        await call("create_event", {
          title: "Custom Dates Event",
          recur_type: "custom",
          field_event_type: "Training",
          field_location: "Building 42",
          custom_dates: [{ start_date: "2026-09-01T14:00:00", end_date: "2026-09-01T15:00:00" }],
        });
        const body = mockRequestRaw.mock.calls[0][3];
        expect(body).toMatchObject({
          recur_type: "custom",
          custom_dates: [{ start_date: "2026-09-01T14:00:00", end_date: "2026-09-01T15:00:00" }],
        });
      });

      it("(e) recurrence present, recur_type absent → NOT rejected by the guard", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: {
            success: true,
            series_id: 54,
            instance_ids: [204],
            title: "No Top-Level recur_type",
            moderation_state: "draft",
            moderation: { state: "draft", can_publish: false, next_action: "send_for_review", message: "Saved as a draft." },
          },
        });
        const result = await call("create_event", {
          title: "No Top-Level recur_type",
          field_event_type: "Training",
          field_location: "Building 42",
          recurrence: validRecurrence,
          confirmed: true,
        });
        expect(JSON.stringify(result)).not.toMatch(/recur_type or recurrence is required/i);
        expect(mockRequestRaw).toHaveBeenCalled();
        expect(JSON.parse(result.content[0].text).executed).toBe(true);
      });

      it("(f) invalid recurrence → errorResponse with a validation code, without calling Drupal", async () => {
        const result = await call("create_event", {
          title: "Broken Recurrence",
          field_event_type: "Training",
          field_location: "Building 42",
          recurrence: {
            frequency: "weekly",
            start_date: "2026-09-01",
            end_date: "2026-09-30",
            // missing days and start_time/duration
          },
        });
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0].text);
        expect(["validation_error", "over_fill", "out_of_vocab"]).toContain(parsed.error.code);
        expect(mockRequestRaw).not.toHaveBeenCalled();
      });

      it("(g) recurrence and custom_dates together → validation_error, without calling Drupal", async () => {
        const result = await call("create_event", {
          title: "Both Recurrence And Custom",
          field_event_type: "Training",
          field_location: "Building 42",
          recurrence: validRecurrence,
          custom_dates: [{ start_date: "2026-09-01T14:00:00", end_date: "2026-09-01T15:00:00" }],
        });
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.error.code).toBe("validation_error");
        expect(mockRequestRaw).not.toHaveBeenCalled();
      });

      it("(h) Drupal returns instance_ids:[] → response includes recurrence_warning", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: {
            success: true,
            series_id: 55,
            instance_ids: [],
            title: "Zero Occurrences",
            moderation_state: "draft",
            moderation: { state: "draft", can_publish: false, next_action: "send_for_review", message: "Saved as a draft." },
          },
        });
        const result = await call("create_event", {
          title: "Zero Occurrences",
          field_event_type: "Training",
          field_location: "Building 42",
          recurrence: validRecurrence,
          confirmed: true,
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.data.instance_ids).toEqual([]);
        expect(parsed.data.recurrence_warning).toEqual(expect.any(String));
      });
    });

    describe("update_event", () => {
      it("maps a 422 validation_error to a coded error naming the field", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 422,
          data: { error: "validation_error", message: "field_event_type: This value should not be null." },
        });
        const result = await call("update_event", { eventseries_id: "42", title: "New Title" });
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed).toMatchObject({ error: { code: "validation_error" } });
        expect(parsed.error.message).toContain("field_event_type");
      });

      it("PATCHes /api/2.3/event-series/{id} with NO confirmed query param (content-only, applies immediately) and maps an updated response", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { success: true, series_id: 42, updated_fields: ["title", "field_summary"] },
        });
        const result = await call("update_event", { eventseries_id: "42", title: "New Title" });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "PATCH",
          "/api/2.3/event-series/42",
          { title: "New Title" }
        );
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          action: "update",
          status: "updated",
          executed: true,
          data: { series_id: 42, updated_fields: ["title", "field_summary"] },
        });
      });

      it("update_event forwards field_event_timezone and field_event_in_person in the PATCH body", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { success: true, series_id: 42, updated_fields: ["field_event_timezone", "field_event_in_person"] },
        });
        await call("update_event", {
          eventseries_id: "42",
          field_event_timezone: "America/Chicago",
          field_event_in_person: false,
        });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "PATCH",
          "/api/2.3/event-series/42",
          { field_event_timezone: "America/Chicago", field_event_in_person: false }
        );
      });

      it("does not accept/forward a confirmed flag — content-only edits are not gated on it", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { success: true, series_id: 42, updated_fields: [] },
        });
        // Even if a caller mistakenly passes confirmed, the tool's param type
        // does not include it, so it is never read into the request body.
        await call("update_event", { eventseries_id: "42" });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "PATCH",
          "/api/2.3/event-series/42",
          {}
        );
      });

      it("requires eventseries_id and never calls Drupal without it", async () => {
        const result = await call("update_event", { title: "X" });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/eventseries_id is required/i);
        expect(mockRequestRaw).not.toHaveBeenCalled();
      });
    });

    describe("delete_event", () => {
      it("confirmed:false previews via a query-string flag and writes nothing", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { status: "preview", executed: false, series_id: 42, would_archive: true, would_hard_delete: false, registrants_affected: 3 },
        });
        const result = await call("delete_event", { eventseries_id: "42" });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "DELETE",
          "/api/2.3/event-series/42?confirmed=false",
          undefined
        );
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          action: "delete",
          status: "preview",
          executed: false,
          data: { would_archive: true, registrants_affected: 3 },
        });
      });

      it("preview data does not duplicate top-level status/executed", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: {
            status: "preview",
            executed: false,
            series_id: 42,
            would_archive: true,
          },
        });
        const result = await call("delete_event", { eventseries_id: "42" });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.status).toBe("preview");
        expect(parsed.executed).toBe(false);
        // The nested Drupal body keeps its detail but not the duplicated envelope keys.
        expect(parsed.data).not.toHaveProperty("status");
        expect(parsed.data).not.toHaveProperty("executed");
        expect(parsed.data.would_archive).toBe(true);
      });

      it("confirmed:true executes and maps instances_archived/notified/notifications_disabled", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: {
            success: true,
            series_id: 42,
            instances_archived: 5,
            registrants_affected: 3,
            notified: 3,
            notifications_disabled: false,
            hard_deleted: false,
          },
        });
        const result = await call("delete_event", { eventseries_id: "42", confirmed: true });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "DELETE",
          "/api/2.3/event-series/42?confirmed=true",
          undefined
        );
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          action: "delete",
          status: "deleted",
          executed: true,
          data: { instances_archived: 5, notified: 3, notifications_disabled: false, hard_deleted: false },
        });
      });

      it("a 409 registrations_exist refusal surfaces the real message + hint", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 409,
          data: { error: "registrations_exist", message: "This draft has registrations and cannot be deleted." },
        });
        const result = await call("delete_event", { eventseries_id: "42", confirmed: true });
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.error.code).toBe("registrations_exist");
        expect(parsed.error.message).toBe("This draft has registrations and cannot be deleted.");
        expect(parsed.error.hint).toMatch(/silently destroyed/i);
      });

      it("a 409 registrations_exist refusal maps to a coded error", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 409,
          data: { error: "registrations_exist", message: "Registrations exist." },
        });
        const result = await call("delete_event", { eventseries_id: "42", confirmed: true });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "registrations_exist" } });
      });

      it("requires eventseries_id", async () => {
        const result = await call("delete_event", {});
        expect(result.isError).toBe(true);
        expect(mockRequestRaw).not.toHaveBeenCalled();
      });
    });

    describe("restore_event", () => {
      it("POSTs to the restore route and maps instances_restored/notified", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { success: true, series_id: 42, instances_restored: 4, notified: 4, notifications_disabled: false },
        });
        const result = await call("restore_event", { eventseries_id: "42" });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "POST",
          "/api/2.3/event-series/42/restore",
          undefined
        );
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          action: "update",
          status: "updated",
          executed: true,
          data: { instances_restored: 4, notified: 4 },
        });
      });

      it("an invalid_state 409 (never archived) maps to a coded error", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 409,
          data: { error: "invalid_state", message: "This event is not archived." },
        });
        const result = await call("restore_event", { eventseries_id: "42" });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "invalid_state" } });
      });
    });

    describe("send_for_review", () => {
      it("POSTs to the send-for-review route and maps moderation_state", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { success: true, series_id: 42, moderation_state: "ready_for_review" },
        });
        const result = await call("send_for_review", { eventseries_id: "42" });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "POST",
          "/api/2.3/event-series/42/send-for-review",
          undefined
        );
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          action: "update",
          status: "updated",
          executed: true,
          data: { moderation_state: "ready_for_review" },
        });
      });

      it("an invalid_state 409 maps to a coded error", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 409,
          data: { error: "invalid_state", message: "Not draft or needs_adjustment." },
        });
        const result = await call("send_for_review", { eventseries_id: "42" });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "invalid_state" } });
      });
    });

    describe("cancel_occurrence", () => {
      it("confirmed:false previews", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { status: "preview", executed: false, eventinstance_id: 900, registrants_affected: 2 },
        });
        const result = await call("cancel_occurrence", { eventinstance_id: "900" });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "DELETE",
          "/api/2.3/event-occurrences/900?confirmed=false",
          undefined
        );
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          action: "delete",
          status: "preview",
          executed: false,
          data: { registrants_affected: 2 },
        });
      });

      it("confirmed:true executes and maps notified/notifications_disabled", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { success: true, eventinstance_id: 900, registrants_affected: 2, notified: 2, notifications_disabled: false },
        });
        const result = await call("cancel_occurrence", { eventinstance_id: "900", confirmed: true });
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          action: "delete",
          status: "deleted",
          executed: true,
          data: { notified: 2, notifications_disabled: false },
        });
      });

      it("an invalid_state 409 (draft occurrence) maps to a coded error", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 409,
          data: { error: "invalid_state", message: "This occurrence is an unpublished draft; delete it instead." },
        });
        const result = await call("cancel_occurrence", { eventinstance_id: "900", confirmed: true });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "invalid_state" } });
      });
    });

    describe("restore_occurrence", () => {
      it("POSTs to the restore route and maps notified", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { success: true, eventinstance_id: 900, notified: 1, notifications_disabled: false },
        });
        const result = await call("restore_occurrence", { eventinstance_id: "900" });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "POST",
          "/api/2.3/event-occurrences/900/restore",
          undefined
        );
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          action: "update",
          status: "updated",
          executed: true,
          data: { notified: 1 },
        });
      });

      it("surfaces returns_with_series:true when restoring under a dark parent", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { success: true, eventinstance_id: 900, returns_with_series: true, notified: 0 },
        });
        const result = await call("restore_occurrence", { eventinstance_id: "900" });
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          data: { returns_with_series: true, notified: 0 },
        });
      });

      it("an invalid_state 409 (not archived) maps to a coded error", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 409,
          data: { error: "invalid_state", message: "This occurrence is not cancelled." },
        });
        const result = await call("restore_occurrence", { eventinstance_id: "900" });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "invalid_state" } });
      });
    });

    describe("edit_occurrence", () => {
      it("PATCHes the occurrence route with confirmed=false by default", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { success: true, eventinstance_id: 900, registrants_affected: 0 },
        });
        const result = await call("edit_occurrence", { eventinstance_id: "900", field_location: "Room 2" });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "PATCH",
          "/api/2.3/event-occurrences/900?confirmed=false",
          { field_location: "Room 2" }
        );
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          action: "update",
          status: "updated",
          executed: true,
          data: { eventinstance_id: 900, registrants_affected: 0 },
        });
      });

      it("a date change on a live registered occurrence returns a preview with registrants_to_notify", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { status: "preview", executed: false, eventinstance_id: 900, date_changes: true, registrants_to_notify: 4 },
        });
        const result = await call("edit_occurrence", {
          eventinstance_id: "900",
          date: { value: "2026-09-05T14:00:00", end_value: "2026-09-05T15:00:00" },
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed).toMatchObject({ action: "update", status: "preview", executed: false });
        expect(parsed.data.registrants_to_notify).toBe(4);
      });

      it("confirmed:true commits a date change", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { success: true, eventinstance_id: 900, registrants_affected: 4 },
        });
        const result = await call("edit_occurrence", {
          eventinstance_id: "900",
          confirmed: true,
          date: { value: "2026-09-05T14:00:00", end_value: "2026-09-05T15:00:00" },
        });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "PATCH",
          "/api/2.3/event-occurrences/900?confirmed=true",
          { date: { value: "2026-09-05T14:00:00", end_value: "2026-09-05T15:00:00" } }
        );
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          status: "updated",
          executed: true,
          data: { registrants_affected: 4 },
        });
      });

      it("requires eventinstance_id", async () => {
        const result = await call("edit_occurrence", {});
        expect(result.isError).toBe(true);
        expect(mockRequestRaw).not.toHaveBeenCalled();
      });
    });

    describe("add_occurrence", () => {
      it("POSTs to /api/2.3/event-series/{id}/occurrence (singular) and maps the created instance", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { success: true, series_id: 42, eventinstance_id: 950, moderation_state: "published" },
        });
        const result = await call("add_occurrence", {
          eventseries_id: "42",
          date: { value: "2026-09-10T14:00:00", end_value: "2026-09-10T15:00:00" },
        });
        expect(mockRequestRaw).toHaveBeenCalledWith(
          "actor@example.com",
          "POST",
          "/api/2.3/event-series/42/occurrence",
          { date: { value: "2026-09-10T14:00:00", end_value: "2026-09-10T15:00:00" } }
        );
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          action: "create",
          status: "created",
          executed: true,
          data: { series_id: 42, eventinstance_id: 950, moderation_state: "published" },
        });
      });

      it("a duplicate_date 409 maps to a coded error whose message points at restore_occurrence for a cancelled twin", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 409,
          data: {
            error: "duplicate_date",
            message: "An occurrence already exists at this date; it is cancelled — use restore_occurrence to bring it back instead of adding a duplicate.",
          },
        });
        const result = await call("add_occurrence", {
          eventseries_id: "42",
          date: { value: "2026-09-10T14:00:00", end_value: "2026-09-10T15:00:00" },
        });
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.error.code).toBe("duplicate_date");
        expect(parsed.error.message).toContain("restore_occurrence");
      });

      it("an invalid_state 409 (draft series) maps to a coded error", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 409,
          data: { error: "invalid_state", message: "This event is a draft; publish it before adding occurrences." },
        });
        const result = await call("add_occurrence", {
          eventseries_id: "42",
          date: { value: "2026-09-10T14:00:00", end_value: "2026-09-10T15:00:00" },
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "invalid_state" } });
      });

      it("requires eventseries_id and date.value/date.end_value client-side", async () => {
        const r1 = await call("add_occurrence", { date: { value: "x", end_value: "y" } });
        expect(r1.isError).toBe(true);
        const r2 = await call("add_occurrence", { eventseries_id: "42" });
        expect(r2.isError).toBe(true);
        expect(mockRequestRaw).not.toHaveBeenCalled();
      });
    });

    describe("shared auth/error handling", () => {
      it("a 403 identity refusal (No acting user.) maps to auth_required", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 403,
          data: { error: "forbidden", message: "No acting user." },
        });
        const result = await call("restore_event", { eventseries_id: "42" });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "auth_required" } });
      });

      it("a 403 state refusal (not archivable) surfaces the real message, NOT auth_required", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 403,
          data: { error: "forbidden", message: "You may not archive this event." },
        });
        const result = await call("delete_event", { eventseries_id: "42", confirmed: true });
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.error.code).toBe("forbidden");
        expect(parsed.error.code).not.toBe("auth_required");
        expect(parsed.error.message).toBe("You may not archive this event.");
        expect(parsed.error.hint).toMatch(/editorial permission/i);
      });

      it("a 403 permission refusal (events-editor required) surfaces the real message, NOT auth_required", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 403,
          data: {
            error: "forbidden",
            message: "Cancelling this occurrence's participation requires the events-editor permission.",
          },
        });
        const result = await call("cancel_occurrence", { eventinstance_id: "900", confirmed: true });
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.error.code).toBe("forbidden");
        expect(parsed.error.code).not.toBe("auth_required");
        expect(parsed.error.message).toBe(
          "Cancelling this occurrence's participation requires the events-editor permission."
        );
        expect(parsed.error.hint).toMatch(/editorial permission/i);
      });

      it("an auth-redirect (3xx, stale session) maps to a re-authenticate error, not raw HTML", async () => {
        mockRequestRaw.mockResolvedValue({ status: 307, data: "<!DOCTYPE html>…" });
        const result = await call("send_for_review", { eventseries_id: "42" });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/authentication|session|re-authenticate/i);
        expect(result.content[0].text).not.toMatch(/DOCTYPE/i);
      });

      it("a 404 not_found maps cleanly for a series-scoped tool", async () => {
        mockRequestRaw.mockResolvedValue({ status: 404, data: { error: "not_found", message: "Event series not found." } });
        const result = await call("delete_event", { eventseries_id: "9999", confirmed: true });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "not_found" } });
      });

      it("a not_coordinator 409 maps cleanly for an occurrence-scoped tool", async () => {
        mockRequestRaw.mockResolvedValue({ status: 409, data: { error: "not_coordinator", message: "You may not cancel this occurrence." } });
        const result = await call("cancel_occurrence", { eventinstance_id: "900", confirmed: true });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "not_coordinator" } });
      });

      it("an unexpected 500 with no coded refusal body maps to upstream_error", async () => {
        mockRequestRaw.mockResolvedValue({ status: 500, data: { message: "Internal server error" } });
        const result = await call("add_occurrence", {
          eventseries_id: "42",
          date: { value: "x", end_value: "y" },
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "upstream_error" } });
      });
    });

    describe("write-envelope conformance", () => {
      const STATUS_VOCAB = new Set([
        "preview", "created", "updated", "deleted",
      ]);
      const assertEnvelope = (parsed: Record<string, unknown>) =>
        assertWriteEnvelope(parsed, STATUS_VOCAB, expect);

      it("create_event, delete_event (executed), and add_occurrence all produce conformant envelopes", async () => {
        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { success: true, series_id: 1, instance_ids: [], title: "X", moderation_state: "draft", moderation: {} },
        });
        const created = await call("create_event", {
          title: "X",
          recur_type: "custom",
          field_affinity_group_node: ["u"],
        });
        assertEnvelope(JSON.parse(created.content[0].text));

        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { success: true, series_id: 1, instances_archived: 0, registrants_affected: 0, notified: 0, notifications_disabled: false, hard_deleted: true },
        });
        const deleted = await call("delete_event", { eventseries_id: "1", confirmed: true });
        assertEnvelope(JSON.parse(deleted.content[0].text));

        mockRequestRaw.mockResolvedValue({
          status: 200,
          data: { success: true, series_id: 1, eventinstance_id: 2, moderation_state: "published" },
        });
        const added = await call("add_occurrence", {
          eventseries_id: "1",
          date: { value: "x", end_value: "y" },
        });
        assertEnvelope(JSON.parse(added.content[0].text));
      });
    });
  });
});

import { compactDescription, isoInstant } from "../server.js";

describe("isoInstant", () => {
  it("appends Z to a naive-UTC daterange string", () => {
    expect(isoInstant("2026-07-23T20:00:00")).toBe("2026-07-23T20:00:00Z");
  });

  it("leaves an already-zoned string untouched", () => {
    expect(isoInstant("2026-07-23T20:00:00Z")).toBe("2026-07-23T20:00:00Z");
    expect(isoInstant("2026-07-23T20:00:00+00:00")).toBe("2026-07-23T20:00:00+00:00");
  });

  it("returns undefined for missing values", () => {
    expect(isoInstant(undefined)).toBeUndefined();
    expect(isoInstant(null)).toBeUndefined();
    expect(isoInstant("")).toBeUndefined();
  });
});

describe("compactDescription", () => {
  it("returns undefined for undefined input", () => {
    expect(compactDescription(undefined)).toBeUndefined();
  });

  it("strips HTML tags", () => {
    expect(compactDescription("<h4>Hello</h4><p>world</p>")).toBe("Hello world");
  });

  it("decodes common entities", () => {
    expect(compactDescription("Foo&nbsp;&amp;&nbsp;bar &lt;3 &quot;hi&quot;")).toBe(
      'Foo & bar <3 "hi"'
    );
  });

  it("collapses whitespace", () => {
    expect(compactDescription("a   b\n\nc\t\td")).toBe("a b c d");
  });

  it("truncates with ellipsis past max length", () => {
    const long = "a".repeat(500);
    const out = compactDescription(long, 100);
    expect(out!.endsWith("…")).toBe(true);
    expect(out!.length).toBe(101);
  });

  it("does not truncate when within max", () => {
    expect(compactDescription("short", 100)).toBe("short");
  });
});
