import { describe, it, expect } from "vitest";
import { AnnouncementsServer } from "../server.js";
import { classifyTool, assertNoPublicWrites, type ToolWithAccess } from "@access-mcp/shared";

function tools(): ToolWithAccess[] {
  const s = new AnnouncementsServer();
  return (s as unknown as { getTools(): ToolWithAccess[] }).getTools();
}

describe("announcements tool classification", () => {
  it("search_announcements is public", () => {
    const t = tools();
    expect(classifyTool(t.find((x) => x.name === "search_announcements")!)).toBe("public");
  });
  it("get_announcement_context is authenticated (user-scoped: returns the acting user's coordinator status)", () => {
    const t = tools();
    expect(classifyTool(t.find((x) => x.name === "get_announcement_context")!)).toBe("authenticated");
  });
  it("create/update/delete are authenticated and mutate", () => {
    const t = tools();
    for (const name of ["create_announcement", "update_announcement", "delete_announcement"]) {
      const tool = t.find((x) => x.name === name)!;
      expect(classifyTool(tool)).toBe("authenticated");
      expect(tool.mutates).toBe(true);
    }
  });
  it("no write tool is public", () => {
    expect(() => assertNoPublicWrites(tools())).not.toThrow();
  });
  it("the public set is EXACTLY the intended reads (a stray public marker fails)", () => {
    const publicNames = tools()
      .filter((t) => classifyTool(t) === "public")
      .map((t) => t.name)
      .sort();
    expect(publicNames).toEqual(["search_announcements"]);
  });
});
