import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import { NSFAwardsServer } from "../server.js";
import { assertFiltersAppliedShape } from "@access-mcp/shared/testkit/filters-applied";

// Mock the global fetch function
global.fetch = vi.fn();

type MockFetch = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;

describe("NSFAwardsServer", () => {
  let server: NSFAwardsServer;
  let mockFetch: MockFetch;

  beforeEach(() => {
    server = new NSFAwardsServer();
    mockFetch = vi.mocked(fetch);
    mockFetch.mockClear();
  });

  describe("Tool Registration", () => {
    it("should register search_nsf_awards tool", () => {
      const tools = server["getTools"]();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("search_nsf_awards");
    });

    it("should have proper input schema", () => {
      const tools = server["getTools"]();
      const tool = tools[0];

      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
      expect(tool.inputSchema.properties.id).toBeDefined();
      expect(tool.inputSchema.properties.query).toBeDefined();
      expect(tool.inputSchema.properties.pi).toBeDefined();
      expect(tool.inputSchema.properties.institution).toBeDefined();
    });
  });

  describe("Tool Call Handler", () => {
    it("should handle unknown tool with error response", async () => {
      const result = await server["handleToolCall"]({
        params: {
          name: "unknown_tool",
          arguments: {},
        },
      });

      expect(result).toHaveProperty("isError", true);
      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty("error");
      expect(response.error.message).toContain("Unknown tool");
    });
  });

  describe("Search by Award ID", () => {
    const mockAwardResponse = {
      response: {
        award: [
          {
            id: "2138259",
            title: "Test Award Title",
            awardeeName: "Test University",
            piFirstName: "John",
            piLastName: "Doe",
            coPDPI: "Jane Smith; Bob Johnson",
            estimatedTotalAmt: "500000",
            fundsObligatedAmt: "400000",
            startDate: "09/01/2021",
            expDate: "08/31/2024",
            abstractText: "This is a test abstract for the award.",
            primaryProgram: "Computer Science",
            poName: "Program Officer Name",
            ueiNumber: "TEST123456789",
          },
        ],
      },
    };

    it("should fetch individual NSF award successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockAwardResponse,
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { id: "2138259" },
        },
      });

      expect(result.content).toHaveLength(1);
      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty("total", 1);
      expect(response).toHaveProperty("items");
      expect(response.items[0].awardNumber).toBe("2138259");
      expect(response.items[0].title).toBe("Test Award Title");
      expect(response.items[0].principalInvestigator).toBe("John Doe");
    });

    it("should handle award not found", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: { award: [] } }),
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { id: "9999999" },
        },
      });

      expect(result).toHaveProperty("isError", true);
      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty("error");
      expect(response.error.message).toContain("No NSF award found");
    });

    it("should handle API errors gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { id: "2138259" },
        },
      });

      expect(result).toHaveProperty("isError", true);
      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty("error");
    });
  });

  describe("Search by PI", () => {
    const mockPISearchResponse = {
      response: {
        metadata: { offset: 1, rpp: 100, totalCount: 2 },
        award: [
          {
            id: "2138259",
            title: "Award 1",
            awardeeName: "University A",
            piFirstName: "John",
            piLastName: "Smith",
            estimatedTotalAmt: "500000",
            startDate: "09/01/2021",
            expDate: "08/31/2024",
            primaryProgram: "Computer Science",
          },
          {
            id: "1234567",
            title: "Award 2",
            awardeeName: "University B",
            piFirstName: "John",
            piLastName: "Smith",
            estimatedTotalAmt: "750000",
            startDate: "01/01/2022",
            expDate: "12/31/2025",
            primaryProgram: "Mathematics",
          },
        ],
      },
    };

    it("should search awards by PI successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockPISearchResponse,
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { pi: "John Smith", limit: 10 },
        },
      });

      expect(result.content).toHaveLength(1);
      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty("total", 2);
      expect(response).toHaveProperty("items");
      expect(response.items).toHaveLength(2);
      expect(response.items[0].principalInvestigator).toBe("John Smith");
    });

    it("should handle no results found", async () => {
      // Mock multiple failed search attempts (different strategies)
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ response: { award: [] } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ response: { award: [] } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ response: { award: [] } }),
        });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { pi: "NonExistent Person" },
        },
      });

      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty("total", 0);
      expect(response).toHaveProperty("items");
      expect(response.items).toHaveLength(0);
    });

    it("should respect limit parameter", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockPISearchResponse,
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { pi: "John Smith", limit: 1 },
        },
      });

      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty("total");
      expect(response).toHaveProperty("items");
      // Limit is applied in the search method, so we get limited results
      expect(response.items.length).toBeLessThanOrEqual(1);
    });
  });

  describe("Search by Institution", () => {
    it("should search awards by institution", async () => {
      const mockInstitutionResponse = {
        response: {
          metadata: { offset: 1, rpp: 100, totalCount: 1 },
          award: [
            {
              id: "1111111",
              title: "PI Award",
              awardeeName: "Stanford University",
              piFirstName: "Jane",
              piLastName: "Doe",
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockInstitutionResponse,
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { institution: "Stanford University" },
        },
      });

      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty("total", 1);
      expect(response).toHaveProperty("items");
      expect(response.items[0].institution).toContain("Stanford");
    });
  });

  describe("Search by Keywords", () => {
    it("should search awards by keywords", async () => {
      const mockKeywordResponse = {
        response: {
          metadata: { offset: 1, rpp: 100, totalCount: 1 },
          award: [
            {
              id: "2222222",
              title: "Machine Learning Research",
              awardeeName: "MIT",
              piFirstName: "AI",
              piLastName: "Researcher",
              abstractText: "This project focuses on machine learning algorithms...",
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockKeywordResponse,
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { query: "machine learning" },
        },
      });

      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty("total", 1);
      expect(response).toHaveProperty("items");
      expect(response.items[0].abstract).toContain("machine learning");
    });
  });

  describe("Award Parsing", () => {
    it("should parse NSF award data correctly", async () => {
      const rawAward = {
        id: "1234567",
        title: "Test Title",
        awardeeName: "Test University",
        piFirstName: "Test",
        piLastName: "Researcher",
        coPDPI: "Co-PI One; Co-PI Two",
        estimatedTotalAmt: "1000000",
        fundsObligatedAmt: "500000",
        startDate: "01/01/2023",
        expDate: "12/31/2025",
        abstractText: "Test abstract",
        primaryProgram: "Test Program",
        poName: "Test Officer",
        ueiNumber: "TEST123",
      };

      const parsed = server["parseNSFAward"](rawAward);

      expect(parsed.awardNumber).toBe("1234567");
      expect(parsed.title).toBe("Test Title");
      expect(parsed.institution).toBe("Test University");
      expect(parsed.principalInvestigator).toBe("Test Researcher");
      expect(parsed.coPIs).toHaveLength(2);
      expect(parsed.coPIs[0]).toBe("Co-PI One");
      expect(parsed.coPIs[1]).toBe("Co-PI Two");
      expect(parsed.totalIntendedAward).toBe("$1,000,000");
      expect(parsed.totalAwardedToDate).toBe("$500,000");
    });

    it("should handle missing fields gracefully", async () => {
      const rawAward = {
        id: "1234567",
        // Most fields missing
      };

      const parsed = server["parseNSFAward"](rawAward);

      expect(parsed.awardNumber).toBe("1234567");
      expect(parsed.title).toBe("No title available");
      expect(parsed.institution).toBe("Unknown institution");
      expect(parsed.principalInvestigator).toBe("Unknown PI");
      expect(parsed.coPIs).toHaveLength(0);
    });
  });

  describe("Error Handling", () => {
    it("should handle network errors", async () => {
      mockFetch.mockClear();
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { id: "1234567" },
        },
      });

      expect(result).toHaveProperty("isError", true);
      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty("error");
    });

    it("should handle malformed API responses", async () => {
      mockFetch.mockClear();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ invalid: "response" }),
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { id: "1234567" },
        },
      });

      expect(result).toHaveProperty("isError", true);
      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty("error");
      expect(response.error.message).toContain("No NSF award found");
    });

    it("should require at least one search parameter", async () => {
      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: {},
        },
      });

      expect(result).toHaveProperty("isError", true);
      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty("error");
      expect(response.error.message).toContain("Provide");
    });
  });

  describe("Institution Filtering (primary_only)", () => {
    it("should filter to primary institution only when primary_only=true", async () => {
      const mockAwards = [
        {
          id: "1",
          title: "Test Award 1",
          awardeeName: "University of Chicago",
          piFirstName: "John",
          piLastName: "Doe",
          estimatedTotalAmt: "100000",
          fundsObligatedAmt: "100000",
          startDate: "2024-01-01",
          expDate: "2025-01-01",
          abstractText: "Test abstract",
          primaryProgram: "Test Program",
          poName: "Test Officer",
          ueiNumber: "123456",
        },
        {
          id: "2",
          title: "Collaborative Award",
          awardeeName: "Stanford University",
          piFirstName: "Jane",
          piLastName: "Smith",
          estimatedTotalAmt: "200000",
          fundsObligatedAmt: "200000",
          startDate: "2024-01-01",
          expDate: "2025-01-01",
          abstractText: "Collaborative project",
          primaryProgram: "Test Program",
          poName: "Test Officer",
          ueiNumber: "789012",
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { metadata: { offset: 1, rpp: 100, totalCount: 2 }, award: mockAwards },
        }),
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: {
            institution: "University of Chicago",
            primary_only: true,
            limit: 10,
          },
        },
      });

      const response = JSON.parse(result.content[0].text);

      // Should only include University of Chicago award (primary_only filters
      // to 1 of the 2 upstream totalCount, so total reflects the post-filter
      // count, not the raw totalCount)
      expect(response.total).toBe(1);
      expect(response.items).toHaveLength(1);
      expect(response.items[0].institution).toBe("University of Chicago");
    });

    it("should include all awards when primary_only=false", async () => {
      const mockAwards = [
        {
          id: "1",
          title: "Test Award 1",
          awardeeName: "University of Chicago",
          piFirstName: "John",
          piLastName: "Doe",
          estimatedTotalAmt: "100000",
          fundsObligatedAmt: "100000",
          startDate: "2024-01-01",
          expDate: "2025-01-01",
          abstractText: "Test abstract",
          primaryProgram: "Test Program",
          poName: "Test Officer",
          ueiNumber: "123456",
        },
        {
          id: "2",
          title: "Collaborative Award",
          awardeeName: "Stanford University",
          piFirstName: "Jane",
          piLastName: "Smith",
          estimatedTotalAmt: "200000",
          fundsObligatedAmt: "200000",
          startDate: "2024-01-01",
          expDate: "2025-01-01",
          abstractText: "Collaborative project",
          primaryProgram: "Test Program",
          poName: "Test Officer",
          ueiNumber: "789012",
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { metadata: { offset: 1, rpp: 100, totalCount: 2 }, award: mockAwards },
        }),
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: {
            institution: "University of Chicago",
            primary_only: false,
            limit: 10,
          },
        },
      });

      const response = JSON.parse(result.content[0].text);

      // Should include both awards
      expect(response.total).toBe(2);
      expect(response.items).toHaveLength(2);
    });

    it("should handle institution name variations", async () => {
      const mockAwards = [
        {
          id: "1",
          title: "Test Award",
          awardeeName: "Univ of Chicago",
          piFirstName: "John",
          piLastName: "Doe",
          estimatedTotalAmt: "100000",
          fundsObligatedAmt: "100000",
          startDate: "2024-01-01",
          expDate: "2025-01-01",
          abstractText: "Test abstract",
          primaryProgram: "Test Program",
          poName: "Test Officer",
          ueiNumber: "123456",
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { metadata: { offset: 1, rpp: 100, totalCount: 1 }, award: mockAwards },
        }),
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: {
            institution: "University of Chicago",
            primary_only: true,
            limit: 10,
          },
        },
      });

      const response = JSON.parse(result.content[0].text);

      // Should match despite name variation
      expect(response.total).toBe(1);
      expect(response.items[0].institution).toContain("Chicago");
    });

    // The implementation's fetchAllPages walk uses a fixed internal rpp (500)
    // for the primary_only complete-set fetch, independent of the caller's
    // `limit`. To force a genuine second page, the corpus must exceed that
    // fixed rpp — a smaller corpus would fit on page 1 and the "past the
    // page" scenario would never trigger (a vacuous test). Both pages must
    // carry metadata.totalCount: fetchAllPages reads totalPages from page 1,
    // and fetchPage derives its own totalPages from each page's metadata.
    const PRIMARY_ONLY_FETCH_RPP = 500;

    function buildTwoPageInstitutionMock(rpp: number) {
      const page1Awards = Array.from({ length: rpp }, (_, i) => ({
        id: `collab-${i}`,
        title: `Collaborative Award ${i}`,
        awardeeName: "Stanford University",
        piFirstName: "Jane",
        piLastName: "Smith",
        estimatedTotalAmt: "200000",
        fundsObligatedAmt: "200000",
        startDate: "2024-01-01",
        expDate: "2025-01-01",
        abstractText: "Collaborative project",
        primaryProgram: "Test Program",
        poName: "Test Officer",
        ueiNumber: "789012",
      }));
      const page2Award = {
        id: "primary-1",
        title: "Primary Award",
        awardeeName: "University of Chicago",
        piFirstName: "John",
        piLastName: "Doe",
        estimatedTotalAmt: "100000",
        fundsObligatedAmt: "100000",
        startDate: "2024-01-01",
        expDate: "2025-01-01",
        abstractText: "Test abstract",
        primaryProgram: "Test Program",
        poName: "Test Officer",
        ueiNumber: "123456",
      };
      const totalCount = rpp + 1;

      return async (input: RequestInfo | URL) => {
        const url = new URL(input.toString());
        const nsfOffset = Number(url.searchParams.get("offset"));
        if (nsfOffset === 1) {
          return {
            ok: true,
            json: async () => ({
              response: { metadata: { offset: 1, rpp, totalCount }, award: page1Awards },
            }),
          } as Response;
        }
        if (nsfOffset === rpp + 1) {
          return {
            ok: true,
            json: async () => ({
              response: {
                metadata: { offset: nsfOffset, rpp, totalCount },
                award: [page2Award],
              },
            }),
          } as Response;
        }
        throw new Error(`unexpected offset ${nsfOffset}`);
      };
    }

    it("primary_only finds a primary award ranked past the first page", async () => {
      // Page 1 (fixed rpp non-primary Stanford awards) sizes exactly to the
      // implementation's internal fetch rpp; the one PRIMARY award (University
      // of Chicago) sits alone on page 2. Filter-after-slice (the bug) would
      // fetch only page 1 and never see the page-2 award; the fix must fetch
      // the complete set first via fetchAllPages.
      mockFetch.mockImplementation(buildTwoPageInstitutionMock(PRIMARY_ONLY_FETCH_RPP));

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: {
            institution: "University of Chicago",
            primary_only: true,
            limit: 10,
          },
        },
      });

      const response = JSON.parse(result.content[0].text);
      const awardNumbers = response.items.map((a: { awardNumber: string }) => a.awardNumber);

      // Today (filter-after-slice) this award is dropped because it only
      // exists on page 2, past the caller's single-page fetch window.
      expect(awardNumbers).toContain("primary-1");
      expect(response.items.every((a: { institution: string }) => a.institution === "University of Chicago")).toBe(
        true
      );
    });

    it("primary_only total reflects the filtered full set, not the post-slice length", async () => {
      // Same two-page corpus as above, but assert on `total`/`has_more`
      // directly: total must equal the count of ALL primary awards across
      // both pages (1), not the length of whatever page happened to survive
      // the old slice-then-filter order.
      mockFetch.mockImplementation(buildTwoPageInstitutionMock(PRIMARY_ONLY_FETCH_RPP));

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: {
            institution: "University of Chicago",
            primary_only: true,
            limit: 10,
          },
        },
      });

      const response = JSON.parse(result.content[0].text);

      expect(response.total).toBe(1);
      expect(response.metadata.pagination.has_more).toBe(false);
    });

    it("primary_only coerces a negative offset before slicing the filtered set (not a JS Array.slice from-the-end)", async () => {
      // primary_only never sends the caller's offset to NSF (fetchAllPages
      // owns its own internal page math), but it DOES use the caller's
      // offset to slice the in-memory filtered array: `filtered.slice(offset,
      // offset + limit)`. Array.prototype.slice treats a negative start as
      // "from the end", so an uncoerced offset:-3 would silently return the
      // last 3 items instead of clamping to the front like buildPagination's
      // metadata claims. Assert the coerced offset (0) is what's actually
      // used for the slice, by checking the returned items match a
      // from-the-front slice of the filtered set.
      const awards = Array.from({ length: 5 }, (_, i) => ({
        id: String(i),
        title: `Award ${i}`,
        awardeeName: "University of Chicago",
        piFirstName: "John",
        piLastName: "Doe",
        estimatedTotalAmt: "100000",
        fundsObligatedAmt: "100000",
        startDate: "2024-01-01",
        expDate: "2025-01-01",
        abstractText: "Test abstract",
        primaryProgram: "Test Program",
        poName: "Test Officer",
        ueiNumber: "123456",
      }));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { metadata: { offset: 1, rpp: 500, totalCount: 5 }, award: awards },
        }),
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: {
            institution: "University of Chicago",
            primary_only: true,
            limit: 10,
            offset: -3,
          },
        },
      });

      const response = JSON.parse(result.content[0].text);
      const returnedIds = response.items.map((a: { awardNumber: string }) => a.awardNumber);

      // Coerced-to-0 slice returns all 5 awards from the front (ids 0-4).
      // The bug (raw -3 passed to Array.slice) would return only the last 3
      // (ids 2-4), silently dropping ids 0-1.
      expect(returnedIds).toEqual(["0", "1", "2", "3", "4"]);
      expect(response.metadata.pagination.offset).toBe(0);
    });

    it("primary_only demotes to total_lower_bound when the underlying institution corpus is ceiling-saturated", async () => {
      // Saturated corpus: NSF reports totalCount 10000 (the display ceiling) on
      // every page of the internal fetchAllPages walk (fetchRpp=500, hardCap=20
      // pages — 20 = ceil(10000/500), so this walk always completes and
      // `result.truncated` never fires; it is NOT the saturation signal). Page 1
      // carries one primary-institution award so the filtered set is non-empty;
      // later pages are non-primary filler so fetchAllPages has a full 20 pages
      // to walk without inflating the fixture.
      const fetchRpp = 500;
      const totalCount = 10000;
      const primaryAward = {
        id: "primary-1",
        title: "Primary Award",
        awardeeName: "University of Chicago",
        piFirstName: "John",
        piLastName: "Doe",
        estimatedTotalAmt: "100000",
        fundsObligatedAmt: "100000",
        startDate: "2024-01-01",
        expDate: "2025-01-01",
        abstractText: "Test abstract",
        primaryProgram: "Test Program",
        poName: "Test Officer",
        ueiNumber: "123456",
      };
      const fillerAward = (page: number, i: number) => ({
        id: `filler-${page}-${i}`,
        title: `Filler Award ${page}-${i}`,
        awardeeName: "Stanford University",
        piFirstName: "Jane",
        piLastName: "Smith",
        estimatedTotalAmt: "200000",
        fundsObligatedAmt: "200000",
        startDate: "2024-01-01",
        expDate: "2025-01-01",
        abstractText: "Collaborative project",
        primaryProgram: "Test Program",
        poName: "Test Officer",
        ueiNumber: "789012",
      });

      mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = new URL(input.toString());
        const nsfOffset = Number(url.searchParams.get("offset"));
        const page = Math.floor((nsfOffset - 1) / fetchRpp) + 1;
        const awards =
          page === 1
            ? [primaryAward, ...Array.from({ length: 4 }, (_, i) => fillerAward(page, i))]
            : Array.from({ length: 4 }, (_, i) => fillerAward(page, i));
        return {
          ok: true,
          json: async () => ({
            response: { metadata: { offset: nsfOffset, rpp: fetchRpp, totalCount }, award: awards },
          }),
        } as Response;
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: {
            institution: "University of Chicago",
            primary_only: true,
            limit: 10,
          },
        },
      });

      const response = JSON.parse(result.content[0].text);

      expect(response.metadata.pagination.total_lower_bound).toBe(10000);
      expect(response.metadata.pagination.total).toBeUndefined();
      expect(response.metadata.pagination.has_more).toBe(true);
      // Top-level `total` is a required number (UniversalResponse contract) —
      // same fallback the single-fetch branches use when saturated.
      expect(typeof response.total).toBe("number");
      expect(response.total).toBe(10000);
    });
  });

  describe("fields projection (Pillar 2)", () => {
    const mockPISearchResponse = {
      response: {
        metadata: { offset: 1, rpp: 100, totalCount: 1 },
        award: [
          {
            id: "2138259",
            title: "Award 1",
            awardeeName: "University A",
            piFirstName: "John",
            piLastName: "Smith",
            estimatedTotalAmt: "500000",
            startDate: "09/01/2021",
            expDate: "08/31/2024",
            primaryProgram: "Computer Science",
          },
        ],
      },
    };

    it("should project find-by-PI response to requested fields only", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockPISearchResponse,
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { pi: "John Smith", fields: ["total", "items[].title"] },
        },
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.total).toBe(1);
      expect(Object.keys(response.items[0])).toEqual(["title"]);
      expect(response.items[0].title).toBe("Award 1");
      // metadata is a sticky container — preserved on projection.
      expect(response.metadata).toBeDefined();
    });

    it("should always preserve total even when fields omits it", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockPISearchResponse,
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { pi: "John Smith", fields: ["metadata.pagination.has_more"] },
        },
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.total).toBe(1);
      expect(response.metadata.pagination.has_more).toBeDefined();
      expect(response.items).toBeUndefined();
    });

    it("should project find-by-institution response (second handler path)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockPISearchResponse,
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { institution: "University A", fields: ["total", "items[].title"] },
        },
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.total).toBeGreaterThanOrEqual(0);
      if (response.items?.length) {
        expect(Object.keys(response.items[0])).toEqual(["title"]);
      }
    });

    it("should advertise fields parameter and supportsFieldProjection on the tool", () => {
      const tools = server["getTools"]();
      const tool = tools.find((t) => t.name === "search_nsf_awards");

      expect(tool?.inputSchema.properties.fields).toBeDefined();
      expect((tool as { _meta?: { supportsFieldProjection?: boolean } })._meta?.supportsFieldProjection).toBe(true);
    });
  });

  describe("pagination (Phase 3a Task 1)", () => {
    function makeAward(id: string) {
      return {
        id,
        title: `Award ${id}`,
        awardeeName: "University A",
        piFirstName: "John",
        piLastName: "Smith",
        estimatedTotalAmt: "500000",
        startDate: "09/01/2021",
        expDate: "08/31/2024",
        primaryProgram: "Computer Science",
      };
    }

    it("find_nsf_awards_by_pi reports the true total from metadata.totalCount", async () => {
      const page = Array.from({ length: 10 }, (_, i) => makeAward(String(i)));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { metadata: { offset: 1, rpp: 10, totalCount: 311 }, award: page },
        }),
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { pi: "John Smith", limit: 10 },
        },
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.total).toBe(311);
      expect(response.items).toHaveLength(10);
      expect(response.metadata.pagination.has_more).toBe(true);
    });

    it("saturated totalCount (10000) is reported as total_lower_bound, not total", async () => {
      const page = Array.from({ length: 10 }, (_, i) => makeAward(String(i)));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { metadata: { offset: 1, rpp: 10, totalCount: 10000 }, award: page },
        }),
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { pi: "John Smith", limit: 10 },
        },
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.metadata.pagination.total_lower_bound).toBe(10000);
      expect(response.metadata.pagination.total).toBeUndefined();
      expect(response.metadata.pagination.has_more).toBe(true);
      // Top-level `total` is a required number (UniversalResponse contract) —
      // it carries the same lower-bound value as metadata.pagination.total_lower_bound.
      expect(response.total).toBe(10000);
    });

    it("offset pages past the first window, translating to NSF's 1-indexed offset", async () => {
      const page = Array.from({ length: 10 }, (_, i) => makeAward(String(i)));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { metadata: { offset: 11, rpp: 10, totalCount: 311 }, award: page },
        }),
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { pi: "John Smith", limit: 10, offset: 10 },
        },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("offset=11"),
        expect.anything()
      );
      const response = JSON.parse(result.content[0].text);
      expect(response.metadata.pagination.offset).toBe(10);
    });

    it("a limit above MAX_LIMIT clamps to 500 with capped:true", async () => {
      const page = Array.from({ length: 500 }, (_, i) => makeAward(String(i)));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { metadata: { offset: 1, rpp: 500, totalCount: 10000 }, award: page },
        }),
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { pi: "John Smith", limit: 5000 },
        },
      });

      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("rpp=500"), expect.anything());
      const response = JSON.parse(result.content[0].text);
      expect(response.metadata.pagination.limit).toBe(500);
      expect(response.metadata.pagination.capped).toBe(true);
    });

    it("find_nsf_awards_by_institution reports the true total from metadata.totalCount", async () => {
      const page = Array.from({ length: 5 }, (_, i) => ({
        ...makeAward(String(i)),
        awardeeName: "Stanford University",
      }));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { metadata: { offset: 1, rpp: 10, totalCount: 42 }, award: page },
        }),
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { institution: "Stanford University", limit: 10 },
        },
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.total).toBe(42);
      expect(response.metadata.pagination.has_more).toBe(true);
    });

    it("a limit:0 error propagates as an error envelope, not an empty result (buildPagination called in the caller)", async () => {
      // searchNSFAwardsByPI's own try/catch would normally swallow a thrown
      // error and return an empty result; stubbing a rejection here proves
      // buildPagination's "Limit must be at least 1" throw — raised in the
      // caller, after the fetch resolves — is NOT caught by that swallowing
      // catch, and instead propagates to handleToolCall's error envelope.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { metadata: { offset: 1, rpp: 10, totalCount: 2 }, award: [makeAward("1")] },
        }),
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { pi: "John Smith", limit: 0 },
        },
      });

      expect(result).toHaveProperty("isError", true);
      const response = JSON.parse(result.content[0].text);
      expect(response.error.message).toContain("Limit must be at least 1");
    });

    it("search_nsf_awards declares limit and offset in its schema", () => {
      const tools = server["getTools"]();
      const tool = tools.find((t) => t.name === "search_nsf_awards");
      expect(tool?.inputSchema.properties.limit).toBeDefined();
      expect(tool?.inputSchema.properties.offset).toBeDefined();
    });

    it("find_nsf_awards_by_pi coerces a negative offset to 0 for BOTH the upstream fetch and the reported metadata", async () => {
      const page = Array.from({ length: 10 }, (_, i) => makeAward(String(i)));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { metadata: { offset: 1, rpp: 10, totalCount: 2 }, award: page },
        }),
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { pi: "John Smith", limit: 10, offset: -3 },
        },
      });

      // The tool's offset -3 must be coerced (buildPagination's rule:
      // Math.max(0, Math.trunc(...))) BEFORE the fetch is issued, so the
      // upstream NSF request (nsfOffset = coerced offset + 1 = 1) matches
      // what the reported metadata claims was fetched. Pin the FETCH url,
      // not just the metadata — a regression that clamps only the reported
      // offset while still sending the raw negative value upstream (a
      // silent-wrong-fetch bug) would pass a metadata-only assertion.
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("offset=1"),
        expect.anything()
      );
      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining("offset=-2"),
        expect.anything()
      );
      const response = JSON.parse(result.content[0].text);
      expect(response.metadata.pagination.offset).toBe(0);
    });

    it("find_nsf_awards_by_institution coerces a negative offset to 0 for BOTH the upstream fetch and the reported metadata", async () => {
      const page = Array.from({ length: 5 }, (_, i) => ({
        ...makeAward(String(i)),
        awardeeName: "Stanford University",
      }));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { metadata: { offset: 1, rpp: 10, totalCount: 5 }, award: page },
        }),
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { institution: "Stanford University", limit: 10, offset: -3 },
        },
      });

      // Same caller shape as the PI branch: the coerced offset must be used
      // to compute nsfOffset BEFORE the fetch, so the upstream URL (offset=1)
      // matches the metadata. Pin the FETCH url, not just the metadata.
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("offset=1"),
        expect.anything()
      );
      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining("offset=-2"),
        expect.anything()
      );
      const response = JSON.parse(result.content[0].text);
      expect(response.metadata.pagination.offset).toBe(0);
    });

    it("find_nsf_awards_by_keywords coerces a negative offset to 0 for BOTH the upstream fetch and the reported metadata", async () => {
      const page = Array.from({ length: 5 }, (_, i) => makeAward(String(i)));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { metadata: { offset: 1, rpp: 10, totalCount: 5 }, award: page },
        }),
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { query: "machine learning", limit: 10, offset: -3 },
        },
      });

      // Same shape as the PI/institution branches: the coerced offset must
      // be used to compute nsfOffset BEFORE the fetch, so the upstream URL
      // (offset=1) matches the metadata. Pin the FETCH url, not just the
      // metadata.
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("offset=1"),
        expect.anything()
      );
      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining("offset=-2"),
        expect.anything()
      );
      const response = JSON.parse(result.content[0].text);
      expect(response.metadata.pagination.offset).toBe(0);
    });

    it("a limit:0 error propagates as an error envelope for the institution branch too", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: {
            metadata: { offset: 1, rpp: 10, totalCount: 2 },
            award: [{ ...makeAward("1"), awardeeName: "Stanford University" }],
          },
        }),
      });

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { institution: "Stanford University", limit: 0 },
        },
      });

      expect(result).toHaveProperty("isError", true);
      const response = JSON.parse(result.content[0].text);
      expect(response.error.message).toContain("Limit must be at least 1");
    });
  });

  describe("filters_applied disclosure (Phase 4b)", () => {
    const EXPECTED_KEYS = ["query", "pi", "institution", "primary_only"];

    function makeAward(id: string, overrides: Record<string, unknown> = {}) {
      return {
        id,
        title: `Award ${id}`,
        awardeeName: "University A",
        piFirstName: "John",
        piLastName: "Smith",
        estimatedTotalAmt: "500000",
        startDate: "09/01/2021",
        expDate: "08/31/2024",
        primaryProgram: "Computer Science",
        ...overrides,
      };
    }

    function mockAwardsPage(totalCount: number, awards: ReturnType<typeof makeAward>[]) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: { metadata: { offset: 1, rpp: 100, totalCount }, award: awards },
        }),
      });
    }

    // The four distinct router branches, keyed by the args that route to them.
    it("PI branch: conforms to the canonical four-key shape", async () => {
      mockAwardsPage(1, [makeAward("1")]);

      const result = await server["handleToolCall"]({
        params: { name: "search_nsf_awards", arguments: { pi: "John Smith" } },
      });

      assertFiltersAppliedShape(result, EXPECTED_KEYS, expect);
    });

    it("institution branch (non-primary_only): conforms to the canonical four-key shape", async () => {
      mockAwardsPage(1, [makeAward("1", { awardeeName: "Stanford University" })]);

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { institution: "Stanford University" },
        },
      });

      assertFiltersAppliedShape(result, EXPECTED_KEYS, expect);
    });

    it("institution branch (primary_only=true): conforms to the canonical four-key shape", async () => {
      mockAwardsPage(1, [makeAward("1", { awardeeName: "MIT" })]);

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { institution: "MIT", primary_only: true },
        },
      });

      assertFiltersAppliedShape(result, EXPECTED_KEYS, expect);
    });

    it("keywords branch: conforms to the canonical four-key shape", async () => {
      mockAwardsPage(1, [makeAward("1")]);

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { query: "machine learning" },
        },
      });

      assertFiltersAppliedShape(result, EXPECTED_KEYS, expect);
    });

    it("institution branch discloses institution and primary_only as applied", async () => {
      mockAwardsPage(1, [makeAward("1", { awardeeName: "MIT" })]);

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { institution: "MIT", primary_only: true },
        },
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.metadata.filters_applied).toEqual({
        query: null,
        pi: null,
        institution: "MIT",
        primary_only: true,
      });
    });

    it("PI branch discloses pi as applied and primary_only as null (not consulted, not omitted)", async () => {
      mockAwardsPage(1, [makeAward("1")]);

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { pi: "John Smith" },
        },
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.metadata.filters_applied).toEqual({
        query: null,
        pi: "John Smith",
        institution: null,
        primary_only: null,
      });
    });

    it("institution branch: primary_only=false survives as false, not null", async () => {
      mockAwardsPage(1, [makeAward("1", { awardeeName: "Stanford University" })]);

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { institution: "Stanford University", primary_only: false },
        },
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.metadata.filters_applied.primary_only).toBe(false);
      expect(response.metadata.filters_applied).toEqual({
        query: null,
        pi: null,
        institution: "Stanford University",
        primary_only: false,
      });
    });

    it("keywords branch: fields projection targeting a metadata subpath still discloses filters_applied", async () => {
      mockAwardsPage(1, [makeAward("1")]);

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { query: "machine learning", fields: ["metadata.pagination.has_more"] },
        },
      });

      assertFiltersAppliedShape(result, EXPECTED_KEYS, expect);
      const response = JSON.parse(result.content[0].text);
      expect(response.metadata.filters_applied.query).toBe("machine learning");
    });

    // Regression: the router's pi/institution/query params are independent
    // optionals with no mutual exclusion in the schema — a caller CAN pass
    // more than one at once. Only one branch runs (pi is checked first,
    // then institution, then query), so filters_applied must disclose ONLY
    // the param that branch actually applied, not every param the caller
    // happened to pass. Building filters_applied from the raw router args
    // wholesale (instead of a per-branch allowlist) would falsely disclose
    // the unread sibling param as "applied" here.
    it("multi-param call {pi, institution}: routes to pi branch, discloses pi only (institution NOT falsely applied)", async () => {
      mockAwardsPage(1, [makeAward("1")]);

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { pi: "X", institution: "Y" },
        },
      });

      const response = JSON.parse(result.content[0].text);
      // Routed to the pi branch: the mocked PI-search response is what came back.
      expect(response.items[0].principalInvestigator).toBeDefined();
      expect(response.metadata.filters_applied).toEqual({
        query: null,
        pi: "X",
        institution: null,
        primary_only: null,
      });
      // The institution branch's request URL (awardeeName=) must never have
      // been built — confirms institution was never read, not just that its
      // disclosed value happens to be null.
      const requestedUrl = String(mockFetch.mock.calls[0][0]);
      expect(requestedUrl).toContain("pdPIName=");
      expect(requestedUrl).not.toContain("awardeeName=");
    });

    it("multi-param call {institution, query}: routes to institution branch, discloses institution only (query NOT falsely applied)", async () => {
      mockAwardsPage(1, [makeAward("1", { awardeeName: "Y" })]);

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { institution: "Y", query: "Z" },
        },
      });

      const response = JSON.parse(result.content[0].text);
      // primary_only defaults to false (not null) on the institution branch —
      // it's always consulted there (args.primary_only || false), so an
      // unset caller value still yields a real applied value of `false`,
      // consistent with the single-param institution-branch test above.
      expect(response.metadata.filters_applied).toEqual({
        query: null,
        pi: null,
        institution: "Y",
        primary_only: false,
      });
      const requestedUrl = String(mockFetch.mock.calls[0][0]);
      expect(requestedUrl).toContain("awardeeName=");
      expect(requestedUrl).not.toContain("keyword=");
    });

    it("multi-param call {pi, query}: routes to pi branch, discloses pi only (query NOT falsely applied)", async () => {
      mockAwardsPage(1, [makeAward("1")]);

      const result = await server["handleToolCall"]({
        params: {
          name: "search_nsf_awards",
          arguments: { pi: "X", query: "Z" },
        },
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.metadata.filters_applied).toEqual({
        query: null,
        pi: "X",
        institution: null,
        primary_only: null,
      });
      const requestedUrl = String(mockFetch.mock.calls[0][0]);
      expect(requestedUrl).toContain("pdPIName=");
      expect(requestedUrl).not.toContain("keyword=");
    });
  });
});
