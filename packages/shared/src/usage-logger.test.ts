import { describe, it, expect } from "vitest";
import { hashActor, buildUsageRow } from "./usage-logger.js";
import { UsageLogger } from "./usage-logger.js";

describe("hashActor", () => {
  it("returns null for an anonymous (undefined) actor", () => {
    expect(hashActor(undefined)).toBeNull();
  });

  it("treats an empty-string actor as anonymous (null)", () => {
    expect(hashActor("")).toBeNull();
  });

  it("is deterministic — same actor, same hash", () => {
    expect(hashActor("alice@access-ci.org")).toBe(hashActor("alice@access-ci.org"));
  });

  it("differs for different actors", () => {
    expect(hashActor("alice@access-ci.org")).not.toBe(hashActor("bob@access-ci.org"));
  });

  it("is not the raw identity (irreversible — no PII in output)", () => {
    const h = hashActor("alice@access-ci.org");
    expect(h).not.toContain("alice");
    expect(h).not.toContain("access-ci.org");
  });

  it("produces a fixed-width hex digest", () => {
    expect(hashActor("alice@access-ci.org")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("buildUsageRow", () => {
  it("captures argument NAMES only, never values", () => {
    const row = buildUsageRow({
      server: "allocations",
      tool: "search_projects",
      args: { query: "GPU on Delta", rp_name: "delta" },
      success: true,
      durationMs: 42,
      actingUser: "alice@access-ci.org",
    });
    expect(row.arg_keys.sort()).toEqual(["query", "rp_name"]);
    expect(JSON.stringify(row)).not.toContain("GPU on Delta");
    expect(JSON.stringify(row)).not.toContain("delta");
  });

  it("marks authenticated when an acting user is present, and hashes it", () => {
    const row = buildUsageRow({
      server: "jsm", tool: "create_ticket", args: {}, success: true,
      durationMs: 10, actingUser: "alice@access-ci.org",
    });
    expect(row.was_authenticated).toBe(true);
    expect(row.user_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("doesn't count an unverified header claim as authenticated (D8-3069)", () => {
    const row = buildUsageRow({
      server: "jsm", tool: "create_support_ticket", args: {}, success: true,
      durationMs: 10, actingUser: "alice@access-ci.org", unverified: true,
    });
    expect(row.was_authenticated).toBe(false);
  });

  it("marks anonymous with null hash when no acting user", () => {
    const row = buildUsageRow({
      server: "events", tool: "search_events", args: { q: "x" }, success: true,
      durationMs: 5, actingUser: undefined,
    });
    expect(row.was_authenticated).toBe(false);
    expect(row.user_hash).toBeNull();
  });

  it("handles null/undefined args as empty arg_keys", () => {
    const row = buildUsageRow({
      server: "events", tool: "list", args: undefined, success: false,
      durationMs: 0, actingUser: undefined,
    });
    expect(row.arg_keys).toEqual([]);
  });

  it("clamps negative and non-finite durations to a safe integer, and records success=false", () => {
    const neg = buildUsageRow({
      server: "events", tool: "list", args: {}, success: false,
      durationMs: -5, actingUser: undefined,
    });
    expect(neg.duration_ms).toBe(0);
    expect(neg.success).toBe(false);

    expect(buildUsageRow({ server: "s", tool: "t", args: {}, success: true, durationMs: NaN, actingUser: undefined }).duration_ms).toBe(0);
    expect(buildUsageRow({ server: "s", tool: "t", args: {}, success: true, durationMs: Infinity, actingUser: undefined }).duration_ms).toBe(0);
  });
});

describe("UsageLogger.record (best-effort)", () => {
  it("is a no-op (and never throws) when MCP_USAGE_DB_URL is unset", async () => {
    const logger = new UsageLogger(undefined);
    await expect(
      logger.record({
        server: "events", tool: "search", args: {}, success: true,
        durationMs: 1, actingUser: undefined,
      })
    ).resolves.toBeUndefined();
    expect(logger.enabled).toBe(false);
  });

  it("swallows write errors — a bad connection string never throws to the caller", async () => {
    const logger = new UsageLogger("postgresql://nope:nope@127.0.0.1:1/none");
    await expect(
      logger.record({
        server: "events", tool: "search", args: { q: "x" }, success: true,
        durationMs: 1, actingUser: undefined,
      })
    ).resolves.toBeUndefined();
  });
});
