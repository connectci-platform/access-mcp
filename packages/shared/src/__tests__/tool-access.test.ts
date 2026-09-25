import { describe, it, expect } from "vitest";
import {
  classifyTool,
  isCallAuthorized,
  stripAccessMarkers,
  assertNoPublicWrites,
  type ToolWithAccess,
} from "../tool-access.js";

const publicTool: ToolWithAccess = { name: "search_events", description: "", inputSchema: { type: "object" }, access: "public" };
const authedTool: ToolWithAccess = { name: "create_event", description: "", inputSchema: { type: "object" }, access: "authenticated", mutates: true };
const unmarkedTool: ToolWithAccess = { name: "mystery", description: "", inputSchema: { type: "object" } };

const publicNames = new Set(["search_events"]);
const call = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });

describe("classifyTool (default-deny)", () => {
  it("explicit public → public", () => expect(classifyTool(publicTool)).toBe("public"));
  it("explicit authenticated → authenticated", () => expect(classifyTool(authedTool)).toBe("authenticated"));
  it("unmarked → authenticated (default-deny)", () => expect(classifyTool(unmarkedTool)).toBe("authenticated"));
});

describe("isCallAuthorized", () => {
  const base = { publicToolNames: publicNames, hasValidKey: false, hasVerifiedActingUser: false };

  it("public tool, no key, no user → allowed", () =>
    expect(isCallAuthorized({ ...base, body: call("search_events") })).toBe(true));

  it("authenticated tool, no key, no user → denied", () =>
    expect(isCallAuthorized({ ...base, body: call("create_event") })).toBe(false));

  it("authenticated tool, valid key → allowed", () =>
    expect(isCallAuthorized({ ...base, body: call("create_event"), hasValidKey: true })).toBe(true));

  it("authenticated tool, verified user (no key) → allowed", () =>
    expect(isCallAuthorized({ ...base, body: call("create_event"), hasVerifiedActingUser: true })).toBe(true));

  it("initialize → allowed without key", () =>
    expect(isCallAuthorized({ ...base, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } })).toBe(true));

  it("tools/list → allowed without key", () =>
    expect(isCallAuthorized({ ...base, body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } })).toBe(true));

  it("batch of all-public, no key → allowed", () =>
    expect(isCallAuthorized({ ...base, body: [call("search_events"), call("search_events")] })).toBe(true));

  it("batch mixing public + authenticated, no key → denied (no smuggling)", () =>
    expect(isCallAuthorized({ ...base, body: [call("search_events"), call("create_event")] })).toBe(false));

  it("unknown tool name (not in publicNames), no key → denied (default-deny)", () =>
    expect(isCallAuthorized({ ...base, body: call("mystery") })).toBe(false));

  it("malformed body (null) → denied", () =>
    expect(isCallAuthorized({ ...base, body: null })).toBe(false));

  it("tools/call with missing params.name, no key → denied (not treated as metadata)", () =>
    expect(
      isCallAuthorized({ ...base, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} } })
    ).toBe(false));

  it("tools/call with non-string params.name, no key → denied", () =>
    expect(
      isCallAuthorized({
        ...base,
        body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: 123 } },
      })
    ).toBe(false));

  it("batch with a public call + an unresolvable tools/call, no key → denied", () =>
    expect(
      isCallAuthorized({
        ...base,
        body: [call("search_events"), { jsonrpc: "2.0", id: 2, method: "tools/call", params: {} }],
      })
    ).toBe(false));

  it("unresolvable tools/call WITH a valid key → allowed (transport is authorized)", () =>
    expect(
      isCallAuthorized({
        ...base,
        body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} },
        hasValidKey: true,
      })
    ).toBe(true));

  it("batch with a public call + a bare non-object message, no key → denied", () =>
    expect(isCallAuthorized({ ...base, body: [call("search_events"), 42] })).toBe(false));

  it("regression: initialize and tools/list still allowed without key; empty batch still denied", () => {
    expect(
      isCallAuthorized({ ...base, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } })
    ).toBe(true);
    expect(
      isCallAuthorized({ ...base, body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } })
    ).toBe(true);
    expect(isCallAuthorized({ ...base, body: [] })).toBe(false);
  });
});

describe("stripAccessMarkers", () => {
  it("removes access and mutates, keeps the rest", () => {
    const [t] = stripAccessMarkers([authedTool]);
    expect(t).not.toHaveProperty("access");
    expect(t).not.toHaveProperty("mutates");
    expect(t.name).toBe("create_event");
    expect(t.description).toBe("");
  });
});

describe("assertNoPublicWrites", () => {
  it("throws when a tool is both mutates:true and access:public", () =>
    expect(() => assertNoPublicWrites([{ ...authedTool, access: "public" }])).toThrow(/public/i));
  it("does not throw for a clean set", () =>
    expect(() => assertNoPublicWrites([publicTool, authedTool])).not.toThrow());
});
