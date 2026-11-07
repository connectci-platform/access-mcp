import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const workDir = mkdtempSync(join(tmpdir(), "publish-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

// Stands in for npm so the real script runs without touching the registry.
// "view" fails, which the script reads as "not published yet".
writeFileSync(
  join(workDir, "npm"),
  `#!/bin/sh
case "$1" in
  view) exit 1 ;;
  publish)
    echo "$PWD" >> "$PUBLISH_LOG"
    [ "$(basename "$PWD")" = "$FAIL_PACKAGE" ] && exit 1
    ;;
esac
exit 0
`
);
chmodSync(join(workDir, "npm"), 0o755);

function publish(failPackage: string) {
  const log = join(workDir, `${failPackage || "none"}.log`);
  const result = spawnSync("node", ["scripts/publish-packages.js"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${workDir}:${process.env.PATH}`,
      PUBLISH_LOG: log,
      FAIL_PACKAGE: failPackage,
    },
  });
  const attempted = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((path) => basename(path))
    : [];
  return { status: result.status, output: result.stdout + result.stderr, attempted };
}

describe("publish-packages", () => {
  it("stops at the first failure and exits non-zero", () => {
    const { status, output, attempted } = publish("shared");

    expect(status).toBe(1);
    expect(attempted).toEqual(["shared"]);
    expect(output).toContain("Failed to publish shared");
    expect(output).not.toContain("Publishing complete");
  }, 30000);

  it("reports success when every package publishes", () => {
    const { status, output, attempted } = publish("");

    expect(status).toBe(0);
    expect(attempted).toHaveLength(10);
    expect(output).toContain("Publishing complete");
  }, 30000);
});
