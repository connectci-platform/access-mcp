import { describe, it, expect, beforeEach, vi } from "vitest";
import { requestContextStorage, RequestContext } from "@access-mcp/shared";

const mockGet = vi.fn();
const mockRaw = vi.fn();
vi.mock("@access-mcp/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@access-mcp/shared")>();
  return {
    ...actual,
    DrupalAuthProvider: vi.fn().mockImplementation(function () {
      return {
        ensureAuthenticated: vi.fn().mockResolvedValue(undefined),
        get: mockGet,
        requestRaw: mockRaw,
      };
    }),
  };
});
import { AllocationsServer } from "../server.js";

const USER = "apasquale@access-ci.org";

describe("assistant consent tools", () => {
  let server: AllocationsServer;
  beforeEach(() => {
    server = new AllocationsServer();
    mockGet.mockReset();
    mockRaw.mockReset();
    delete process.env.ACTING_USER;
    process.env.DRUPAL_API_URL = "https://drupal.example";
    process.env.DRUPAL_USERNAME = "svc";
    process.env.DRUPAL_PASSWORD = "pw";
  });
  const call = (name: string, args: Record<string, unknown>, actingUser?: string) =>
    requestContextStorage.run({ actingUser } as RequestContext, () =>
      server["handleToolCall"]({ method: "tools/call", params: { name, arguments: args } })
    );
  const body = (result: { content: unknown[] }) =>
    JSON.parse((result.content[0] as { text: string }).text);

  it("are authenticated, service-only, and marked read and write", () => {
    const tools = server["getTools"]();
    const get = tools.find((t) => t.name === "get_assistant_consent");
    const set = tools.find((t) => t.name === "set_assistant_consent");
    expect(get).toMatchObject({ access: "authenticated", serviceOnly: true, mutates: false });
    expect(set).toMatchObject({ access: "authenticated", serviceOnly: true, mutates: true });
    const listed = server["listToolsForClient"]().map((t: { name: string }) => t.name);
    expect(listed).not.toContain("get_assistant_consent");
    expect(listed).not.toContain("set_assistant_consent");
    expect(listed).toContain("get_my_rp_accounts");
  });

  it("get returns only the consent state and ask date, never profile fields", async () => {
    mockGet.mockResolvedValue({
      consent: "allow",
      asked_at: "2026-11-16T12:00:00Z",
      first_name: "Andrew",
      allocated_resources: [{ name: "Delta GPU" }],
    });
    const result = await call("get_assistant_consent", {}, USER);
    expect(mockGet).toHaveBeenCalledWith(USER, "/api/1.0/profile");
    expect(body(result)).toEqual({ consent: "allow", asked_at: "2026-11-16T12:00:00Z" });
  });

  it("get reports a reply it can't read as an error", async () => {
    mockGet.mockResolvedValue({ consent: "maybe" });
    const result = await call("get_assistant_consent", {}, USER);
    expect(result.isError).toBe(true);
  });

  it("get normalizes a missing ask date to null", async () => {
    mockGet.mockResolvedValue({ consent: "unset" });
    expect(body(await call("get_assistant_consent", {}, USER))).toEqual({
      consent: "unset",
      asked_at: null,
    });
  });

  it.each(["allow", "deny", "not_now"])("set posts %s as the acting user", async (choice) => {
    mockRaw.mockResolvedValue({
      status: 200,
      data: { consent: choice === "not_now" ? "unset" : choice, asked_at: "2026-11-16T12:00:00Z" },
    });
    const result = await call("set_assistant_consent", { consent: choice }, USER);
    expect(mockRaw).toHaveBeenCalledWith(USER, "POST", "/api/1.0/profile/consent", {
      consent: choice,
    });
    expect(result.isError).toBeFalsy();
    expect(body(result).asked_at).toBe("2026-11-16T12:00:00Z");
  });

  it("set rejects any other value without calling Drupal", async () => {
    const result = await call("set_assistant_consent", { consent: "allow_once" }, USER);
    expect(result.isError).toBe(true);
    expect(mockRaw).not.toHaveBeenCalled();
  });

  it("set reports a 409 (already answered) as a conflict, not a crash", async () => {
    mockRaw.mockResolvedValue({ status: 409, data: { error: "already answered" } });
    const result = await call("set_assistant_consent", { consent: "not_now" }, USER);
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ status: 409 });
  });

  it("both refuse without an acting user", async () => {
    for (const [name, args] of [
      ["get_assistant_consent", {}],
      ["set_assistant_consent", { consent: "allow" }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
    }
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockRaw).not.toHaveBeenCalled();
  });
});
