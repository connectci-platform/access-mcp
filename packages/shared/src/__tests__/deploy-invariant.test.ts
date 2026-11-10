import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Repo root relative to packages/shared/src/__tests__
const root = resolve(__dirname, "../../../..");

// The per-tool auth gate is the primary write-door control, but the tools also
// carry an env-conditional fail-closed backstop: getActingUserAccessId falls
// back to process.env.ACTING_USER before throwing. That backstop is only sound
// while ACTING_USER is unset on the public-facing deployment. This test asserts
// the deploy config keeps it unset, so the backstop cannot silently rot if
// someone sets the env — a bare `ACTING_USER: someuser` would make every write
// on the mixed servers execute as that user without a gate.
describe("deploy invariant: ACTING_USER is unset on mixed servers", () => {
  it("docker-compose.yml sets ACTING_USER only to an empty default", () => {
    const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
    // The variable itself, not names that contain it (MCP_ACTING_USER_AUTH).
    const lines = compose.split("\n").filter((l) => /^\s*ACTING_USER\s*:/.test(l));
    // There must be at least one ACTING_USER line (the servers declare it), and
    // every such line must be the empty-default form `${ACTING_USER:-}` — a bare
    // `ACTING_USER: someuser` fails this invariant.
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/ACTING_USER:\s*\$\{ACTING_USER:-\}\s*$/);
    }
  });

  it("repo .env does not set a non-empty ACTING_USER", () => {
    let env = "";
    try {
      env = readFileSync(resolve(root, ".env"), "utf8");
    } catch {
      return; // no .env → nothing to violate
    }
    const active = env
      .split("\n")
      .filter((l) => /^\s*ACTING_USER\s*=/.test(l) && !/^\s*ACTING_USER\s*=\s*$/.test(l));
    expect(active).toEqual([]);
  });

  it("the empty-default regex discriminates (a bare value fails)", () => {
    // Guards against the assertion being vacuously true: a hardcoded user must
    // NOT match the empty-default pattern.
    expect("      ACTING_USER: prod-service-user").not.toMatch(
      /ACTING_USER:\s*\$\{ACTING_USER:-\}\s*$/
    );
    expect("      ACTING_USER: ${ACTING_USER:-}").toMatch(
      /ACTING_USER:\s*\$\{ACTING_USER:-\}\s*$/
    );
  });
});

// xdmod-mcp-data is Python and has no OpenTelemetry SDK, so the settings would do nothing there.
describe("deploy invariant: Node MCP servers can export telemetry", () => {
  const compose = readFileSync(resolve(root, "docker-compose.prod.yml"), "utf8");
  const services = compose
    .split(/^(?= {2}[a-z][a-z0-9-]*:\n)/m)
    .filter((block) => block.startsWith("  mcp-"))
    .filter((block) => !/^ {2}mcp-(xdmod-data|usage-db|usage-backup):/.test(block));

  it("finds the Node MCP servers", () => {
    expect(services).toHaveLength(12);
  });

  it.each(services.map((block) => [block.split(":")[0].trim(), block]))(
    "%s receives the telemetry settings",
    (_name, block) => {
      for (const setting of [
        "OTEL_ENABLED=${OTEL_ENABLED:-false}",
        "OTEL_EXPORTER_OTLP_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT:-}",
        "OTEL_EXPORTER_OTLP_HEADERS=${OTEL_EXPORTER_OTLP_HEADERS:-}",
        "HONEYCOMB_DATASET=${HONEYCOMB_DATASET:-access-ci-mcp}",
      ]) {
        expect(block).toContain(setting);
      }
    }
  );
});
