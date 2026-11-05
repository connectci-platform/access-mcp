/**
 * Every real tool server declares whether each tool changes anything, and
 * publishes it to clients as annotations.readOnlyHint.
 *
 * The ACCESS agent refuses write tools to callers without write permission
 * using that hint, so a tool without its marker must fail CI here, before a
 * deploy. BaseAccessServer.start() runs the same check, but a deploy restarts
 * the servers before its health check, so a startup failure alone would
 * already be live.
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";
import { assertToolMarkers, type ToolWithAccess, type Tool } from "@access-mcp/shared";
import { AffinityGroupsServer } from "../packages/affinity-groups/src/server.js";
import { AllocationsServer } from "../packages/allocations/src/server.js";
import { AnnouncementsServer } from "../packages/announcements/src/server.js";
import { ComputeResourcesServer } from "../packages/compute-resources/src/server.js";
import { DocumentationServer } from "../packages/documentation/src/server.js";
import { EventsServer } from "../packages/events/src/server.js";
import { JsmServer } from "../packages/jsm/src/server.js";
import { NSFAwardsServer } from "../packages/nsf-awards/src/server.js";
import { SoftwareDiscoveryServer } from "../packages/software-discovery/src/server.js";
import { SystemStatusServer } from "../packages/system-status/src/server.js";
import { XDMoDMetricsServer } from "../packages/xdmod/src/index.js";

type Inspectable = { getTools(): ToolWithAccess[]; listToolsForClient(): Tool[] };

const SERVERS = {
  "affinity-groups": () => new AffinityGroupsServer(),
  allocations: () => new AllocationsServer(),
  announcements: () => new AnnouncementsServer(),
  "compute-resources": () => new ComputeResourcesServer(),
  documentation: () => new DocumentationServer(),
  events: () => new EventsServer(),
  jsm: () => new JsmServer(),
  "nsf-awards": () => new NSFAwardsServer(),
  "software-discovery": () => new SoftwareDiscoveryServer(),
  "system-status": () => new SystemStatusServer(),
  xdmod: () => new XDMoDMetricsServer(),
};

// The tools that change something. The ACCESS agent keeps the same list
// (WRITE_MCP_TOOL_NAMES) as a cross-check; a change here belongs there too.
const WRITE_TOOLS = new Set([
  "create_announcement",
  "update_announcement",
  "delete_announcement",
  "register_for_event",
  "cancel_registration",
  "create_event",
  "update_event",
  "delete_event",
  "restore_event",
  "send_for_review",
  "cancel_occurrence",
  "restore_occurrence",
  "edit_occurrence",
  "add_occurrence",
  "create_support_ticket",
  "create_login_ticket",
  "report_security_incident",
]);

const servers = Object.entries(SERVERS).map(
  ([name, make]) => [name, make() as unknown as Inspectable] as const
);

describe.each(servers)("%s", (_name, server) => {
  it("declares a boolean mutates on every tool", () => {
    expect(() => assertToolMarkers(server.getTools())).not.toThrow();
  });

  it("publishes readOnlyHint and no internal markers", () => {
    for (const tool of server.listToolsForClient()) {
      expect(tool).not.toHaveProperty("access");
      expect(tool).not.toHaveProperty("mutates");
      expect(tool.annotations?.readOnlyHint).toBe(!WRITE_TOOLS.has(tool.name));
    }
  });
});

it("covers every server class in packages/, so a new server can't be missed", () => {
  // Any non-test .ts under packages/*/src that declares a class extending
  // BaseAccessServer, however the declaration is laid out.
  const packagesDir = join(__dirname, "..", "packages");
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sources(path);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
    });
  const declared = readdirSync(packagesDir)
    .map((pkg) => join(packagesDir, pkg, "src"))
    .filter(existsSync)
    .flatMap(sources)
    .flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/class\s+(\w+)\s+extends\s+BaseAccessServer\b/g)].map(
        (m) => m[1]
      )
    );
  const tested = servers.map(([, s]) => (s as object).constructor.name);
  expect(declared.length).toBeGreaterThan(0);
  expect([...new Set(declared)].sort()).toEqual([...new Set(tested)].sort());
});

it("every listed write tool exists, so the list can't go stale", () => {
  const all = new Set(servers.flatMap(([, s]) => s.getTools().map((t) => t.name)));
  expect([...WRITE_TOOLS].filter((name) => !all.has(name))).toEqual([]);
});
