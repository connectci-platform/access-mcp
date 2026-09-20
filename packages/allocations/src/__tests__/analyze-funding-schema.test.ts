import { describe, it, expect } from "vitest";
import { AllocationsServer } from "../server.js";

/**
 * Guard test (Phase 4a Task 3): `has_nsf_funding` was declared in the
 * `analyze_funding` inputSchema and two example blocks but never read by any
 * handler — a silent no-op filter. This asserts it's fully removed from the
 * schema and from every example's arguments.
 */
describe("analyze_funding schema: has_nsf_funding removed", () => {
  it("inputSchema properties do not include has_nsf_funding", () => {
    const server = new AllocationsServer();
    const tools = server["getTools"]();
    const tool = tools.find((t: { name: string }) => t.name === "analyze_funding") as {
      inputSchema: { properties: Record<string, unknown> };
    };
    expect(tool).toBeDefined();
    expect(tool.inputSchema.properties.has_nsf_funding).toBeUndefined();
  });

  it("no example block's arguments reference has_nsf_funding", () => {
    const server = new AllocationsServer();
    const tools = server["getTools"]();
    const tool = tools.find((t: { name: string }) => t.name === "analyze_funding") as {
      inputSchema: {
        examples?: Array<{ name: string; arguments: Record<string, unknown> }>;
      };
    };
    expect(tool).toBeDefined();
    const examples = tool.inputSchema.examples ?? [];
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(example.arguments.has_nsf_funding).toBeUndefined();
    }
  });
});
