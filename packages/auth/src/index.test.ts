import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

// index.ts exits at import unless these are set and refuses to bind a port
// unless NODE_ENV !== "test". Set both before importing.
process.env.NODE_ENV = "test";
process.env.CILOGON_CLIENT_ID = "test-client-id";
process.env.CILOGON_CLIENT_SECRET = "test-client-secret";
process.env.OAUTH_EXTERNAL_BASE_URL = "https://mcp.access-ci.org/auth";

let app: Express;

beforeAll(async () => {
  ({ app } = await import("./index.js"));
});

describe("service construction", () => {
  it("constructs with an in-memory client store under test env (no CLIENT_STORE_PATH)", async () => {
    // Importing index wires the provider; a throw here means the fail-loud
    // resolver mis-fired in test env. NODE_ENV=test is set at file top.
    await expect(import("./index.js")).resolves.toBeDefined();
  });
});

describe("OAuth protected-resource metadata discovery", () => {
  // Regression: the handler previously only matched the trailing-slash form
  // (/.well-known/oauth-protected-resource/<name>), so the BARE root path fell
  // through to an empty 200 and broke MCP OAuth discovery with
  // "expected object, received null" / EOF.
  it("serves a valid object at the BARE root path", async () => {
    const res = await request(app).get(
      "/.well-known/oauth-protected-resource"
    );
    expect(res.status).toBe(200);
    expect(res.body).toBeTypeOf("object");
    expect(res.body).not.toBeNull();
    expect(res.body.resource).toBe("https://mcp.access-ci.org/");
    expect(res.body.authorization_servers).toEqual([
      "https://mcp.access-ci.org/auth",
    ]);
    expect(res.body.scopes_supported).toContain("openid");
  });

  it("serves per-server metadata at a suffixed path", async () => {
    const res = await request(app).get(
      "/.well-known/oauth-protected-resource/events"
    );
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe("https://mcp.access-ci.org/events");
    expect(res.body.authorization_servers).toEqual([
      "https://mcp.access-ci.org/auth",
    ]);
  });

  it("handles a multi-segment suffixed path (e.g. an sse subpath)", async () => {
    const res = await request(app).get(
      "/.well-known/oauth-protected-resource/allocations/sse"
    );
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe("https://mcp.access-ci.org/allocations/sse");
  });

  it("does NOT capture unrelated .well-known paths", async () => {
    // oauth-authorization-server is a different endpoint; the protected-resource
    // handler must not swallow it and return the protected-resource document.
    const res = await request(app).get(
      "/.well-known/oauth-authorization-server"
    );
    // The bug would be the protected-resource handler over-matching and
    // returning its doc (identified by `resource: https://mcp.access-ci.org/`).
    expect(res.body?.resource).not.toBe("https://mcp.access-ci.org/");
  });
});

describe("OAuth callback failure", () => {
  it("returns a fixed 500 message and logs no error text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app).get("/callback?code=abc-secret&state=unknown-state");
    const lines = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.text).toBe("Authentication failed. Please try again.");
    expect(lines).toContain('"upstream":"cilogon"');
    expect(lines).toContain('"path":"/callback"');
    expect(lines).not.toContain("Invalid or expired");
    expect(lines).not.toContain("abc-secret");
    expect(lines).not.toContain("unknown-state");
  });
});
