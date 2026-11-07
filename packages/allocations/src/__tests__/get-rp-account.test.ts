import { describe, it, expect, beforeEach, vi } from "vitest";
import { requestContextStorage, RequestContext } from "@access-mcp/shared";

const mockGet = vi.fn();
vi.mock("@access-mcp/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@access-mcp/shared")>();
  return {
    ...actual,
    DrupalAuthProvider: vi.fn().mockImplementation(function () {
      return {
        ensureAuthenticated: vi.fn().mockResolvedValue(undefined),
        get: mockGet,
      };
    }),
  };
});
import { AllocationsServer } from "../server.js";

describe("get_rp_account", () => {
  let server: AllocationsServer;
  beforeEach(() => {
    server = new AllocationsServer();
    mockGet.mockReset();
    delete process.env.ACTING_USER;
    process.env.DRUPAL_API_URL = "https://drupal.example";
    process.env.DRUPAL_USERNAME = "svc"; process.env.DRUPAL_PASSWORD = "pw";
  });
  const call = (args: Record<string, unknown>, actingUser?: string) =>
    requestContextStorage.run({ actingUser } as RequestContext, () =>
      server["handleToolCall"]({ method: "tools/call", params: { name: "get_rp_account", arguments: args } }));

  it("requires resource_id and offers an optional live flag", () => {
    const tool = server["getTools"]().find((t) => t.name === "get_rp_account");
    const schema = tool?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema?.properties).toHaveProperty("resource_id");
    expect(schema?.properties).toHaveProperty("live");
    expect(schema?.required).toContain("resource_id");
    expect(schema?.properties).not.toHaveProperty("rp_nid");
  });

  it("calls the by-resource route with the resource_id, as the acting user (email/domain form)", async () => {
    // auth.get returns the response BODY directly; the by-resource endpoint
    // returns the account object at the TOP LEVEL (no { data: ... } wrapper).
    mockGet.mockResolvedValue({ rp_display_name: "NCSA Delta", rp_username: "alice_delta",
      grants: [{ project_balance: 5000, billable_unit: "GPU hours" }] });
    const result = await call({ resource_id: "delta-gpu.ncsa.access-ci.org" }, "apasquale@access-ci.org");
    expect(mockGet).toHaveBeenCalledWith(
      "apasquale@access-ci.org",
      "/api/1.0/rp-account/by-resource/delta-gpu.ncsa.access-ci.org"
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("alice_delta");
    expect(text).toContain("5000");
    expect(text).toContain("GPU hours");
  });

  it("strips the freshness-only 'stale' flag from the output (synced_at is the source of truth)", async () => {
    mockGet.mockResolvedValue({ rp_display_name: "NCSA Delta", stale: true,
      synced_at: "2026-07-09T00:16:00+00:00", grants: [] });
    const result = await call({ resource_id: "delta-gpu.ncsa.access-ci.org" }, "apasquale@access-ci.org");
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).not.toHaveProperty("stale");
    // synced_at is kept — the LLM derives freshness from it if needed.
    expect(parsed.synced_at).toBe("2026-07-09T00:16:00+00:00");
  });

  it("appends ?live=1 when live is true", async () => {
    mockGet.mockResolvedValue({ rp_display_name: "NCSA Delta", grants: [] });
    await call({ resource_id: "delta-gpu.ncsa.access-ci.org", live: true }, "apasquale@access-ci.org");
    expect(mockGet).toHaveBeenCalledWith(
      "apasquale@access-ci.org",
      "/api/1.0/rp-account/by-resource/delta-gpu.ncsa.access-ci.org?live=1"
    );
  });

  it("never emits an undefined text block when the response body is empty", async () => {
    // JSON.stringify(undefined) is undefined (not a string) → a content[0] with
    // no `text` field, which fails MCP response validation. Guard against it.
    mockGet.mockResolvedValue(undefined);
    const result = await call({ resource_id: "delta-gpu.ncsa.access-ci.org" }, "apasquale@access-ci.org");
    const text = (result.content[0] as { text: string }).text;
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/no data|syncing/i);
  });

  it("refuses with a clear error and no endpoint call when there is no acting user", async () => {
    const result = await call({ resource_id: "delta-gpu.ncsa.access-ci.org" });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/authenticate with your ACCESS-CI credentials/i);
    expect(text).toMatch(/Customize > Connectors/i);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("does not gate the public tools", () => {
    const names = server["getTools"]().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_projects", "analyze_funding", "get_allocation_statistics"]));
  });
});
