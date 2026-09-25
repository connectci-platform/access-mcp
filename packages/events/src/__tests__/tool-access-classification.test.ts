import { describe, it, expect } from "vitest";
import { EventsServer } from "../server.js";
import { classifyTool, assertNoPublicWrites, type ToolWithAccess } from "@access-mcp/shared";

function tools(): ToolWithAccess[] {
  const s = new EventsServer();
  return (s as unknown as { getTools(): ToolWithAccess[] }).getTools();
}

describe("events tool classification", () => {
  it("search_events and get_event are public", () => {
    const t = tools();
    expect(classifyTool(t.find((x) => x.name === "search_events")!)).toBe("public");
    expect(classifyTool(t.find((x) => x.name === "get_event")!)).toBe("public");
  });
  it("get_my_registrations and get_my_events are authenticated", () => {
    const t = tools();
    expect(classifyTool(t.find((x) => x.name === "get_my_registrations")!)).toBe("authenticated");
    expect(classifyTool(t.find((x) => x.name === "get_my_events")!)).toBe("authenticated");
  });
  it("create_event is authenticated and mutates", () => {
    const t = tools();
    const create = t.find((x) => x.name === "create_event")!;
    expect(classifyTool(create)).toBe("authenticated");
    expect(create.mutates).toBe(true);
  });
  it("no write tool is public (assertion passes)", () => {
    expect(() => assertNoPublicWrites(tools())).not.toThrow();
  });
  it("the public set is EXACTLY the intended reads (a stray public marker fails)", () => {
    const publicNames = tools()
      .filter((t) => classifyTool(t) === "public")
      .map((t) => t.name)
      .sort();
    expect(publicNames).toEqual(["get_event", "search_events"]);
  });
});
