import { describe, it, expect, beforeEach, vi } from "vitest";
import { requestContextStorage, RequestContext, DrupalApiError } from "@access-mcp/shared";

const mockGet = vi.fn();
vi.mock("@access-mcp/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@access-mcp/shared")>();
  return {
    ...actual,
    DrupalAuthProvider: vi.fn().mockImplementation(() => ({
      ensureAuthenticated: vi.fn().mockResolvedValue(undefined),
      get: mockGet,
    })),
  };
});
import { AllocationsServer } from "../server.js";

describe("get_my_rp_accounts", () => {
  let server: AllocationsServer;
  beforeEach(() => {
    server = new AllocationsServer();
    mockGet.mockReset();
    delete process.env.ACTING_USER;
    process.env.DRUPAL_API_URL = "https://drupal.example";
    process.env.DRUPAL_USERNAME = "svc";
    process.env.DRUPAL_PASSWORD = "pw";
  });
  const call = (actingUser?: string) =>
    requestContextStorage.run({ actingUser } as RequestContext, () =>
      server["handleToolCall"]({
        method: "tools/call",
        params: { name: "get_my_rp_accounts", arguments: {} },
      })
    );

  it("registers with no required args", () => {
    const tool = server["getTools"]().find((t) => t.name === "get_my_rp_accounts");
    expect(tool).toBeDefined();
    const schema = tool?.inputSchema as { required?: string[] };
    expect(schema?.required ?? []).toEqual([]);
  });

  it("calls the no-id route as the acting user and surfaces resource_ids + balances", async () => {
    // auth.get returns the response BODY directly; the rp-accounts endpoint
    // returns { accounts, state, synced_at } at the TOP LEVEL (no data wrapper).
    mockGet.mockResolvedValue({
      state: "rows_fresh",
      synced_at: "2026-07-07T14:32:00Z",
      accounts: [
        {
          resource_id: "delta-gpu.ncsa.access-ci.org",
          rp_display_name: "NCSA Delta",
          rp_username: "alice",
          grants: [{ project_balance: 5000, billable_unit: "GPU hours" }],
        },
      ],
    });
    const result = await call("apasquale@access-ci.org");
    expect(mockGet).toHaveBeenCalledWith("apasquale@access-ci.org", "/api/1.0/rp-accounts");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("delta-gpu.ncsa.access-ci.org");
    expect(text).toContain("5000");
    expect(text).toContain("GPU hours");
  });

  it("passes through the syncing state", async () => {
    mockGet.mockResolvedValue({ data: { state: "syncing", accounts: [] } });
    const result = await call("apasquale@access-ci.org");
    expect((result.content[0] as { text: string }).text).toContain("syncing");
  });

  it("refuses with the aligned auth error and no endpoint call when there is no acting user", async () => {
    const result = await call();
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/authenticate with your ACCESS-CI credentials/i);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("returns isError when the Drupal call fails", async () => {
    mockGet.mockRejectedValue(new Error("Request failed with status code 403"));
    const result = await call("apasquale@access-ci.org");
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/error|403/i);
  });

  // An expired Drupal session comes back as a 3xx CILogon bounce. The shared
  // auth layer re-logs-in and retries, so a 3xx reaching the tool boundary means
  // recovery failed and the user needs the structured auth error rather than the
  // raw "Drupal API error: 307 Temporary Redirect" upstream text.
  it("surfaces a persistent 3xx as the structured auth error", async () => {
    mockGet.mockRejectedValue(
      new DrupalApiError("Drupal API error: 307 Temporary Redirect", 307, "")
    );
    const result = await call("apasquale@access-ci.org");
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe("unauthenticated");
    expect(parsed.error.message).toMatch(/session may have expired/i);
    expect(parsed.error.message).not.toContain("307");
  });

  it("shows Drupal's own message for a client error", async () => {
    mockGet.mockRejectedValue(
      new DrupalApiError("Drupal API error: 409 Conflict", 409, {
        error: "account_not_linked",
        message: "Your ACCESS account isn't linked to a resource provider account.",
      })
    );
    const result = await call("apasquale@access-ci.org");
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("isn't linked to a resource provider account");
    expect(text).not.toContain("409 Conflict");
  });

  it("surfaces a failed re-login as reauth_failed", async () => {
    mockGet.mockRejectedValue(
      new DrupalApiError(
        "Drupal session expired and re-authentication failed: Drupal login failed: 503 Service Unavailable",
        401,
        undefined,
        "reauth_failed"
      )
    );
    const result = await call("apasquale@access-ci.org");
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe("reauth_failed");
  });

  it("does not gate the public tools", () => {
    const names = server["getTools"]().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["search_projects", "analyze_funding", "get_allocation_statistics"])
    );
  });
});
