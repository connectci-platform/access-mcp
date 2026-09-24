import { describe, it, expect } from "vitest";
import { JsmServer } from "../server.js";
import { classifyTool, assertNoPublicWrites, type ToolWithAccess } from "@access-mcp/shared";

function tools(): ToolWithAccess[] {
  const s = new JsmServer();
  return (s as unknown as { getTools(): ToolWithAccess[] }).getTools();
}

describe("jsm tool classification", () => {
  it("get_ticket_types is public", () => {
    const t = tools();
    const getTicketTypes = t.find((x) => x.name === "get_ticket_types")!;
    expect(classifyTool(getTicketTypes)).toBe("public");
    expect(getTicketTypes.mutates).toBeFalsy();
  });

  it("ticket creators are authenticated and mutate", () => {
    const t = tools();
    for (const name of [
      "create_support_ticket",
      "create_login_ticket",
      "report_security_incident",
    ]) {
      const tool = t.find((x) => x.name === name)!;
      expect(classifyTool(tool)).toBe("authenticated");
      expect(tool.mutates).toBe(true);
    }
  });

  it("assertNoPublicWrites passes for jsm's actual tool set", () => {
    expect(() => assertNoPublicWrites(tools())).not.toThrow();
  });

  it("assertNoPublicWrites throws when a write tool is mismarked public", () => {
    const mismarked: ToolWithAccess[] = [
      {
        name: "fake_write",
        description: "a write tool incorrectly marked public",
        inputSchema: { type: "object", properties: {} },
        access: "public",
        mutates: true,
      },
    ];
    expect(() => assertNoPublicWrites(mismarked)).toThrow();
  });
});
