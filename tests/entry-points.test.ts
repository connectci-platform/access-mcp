import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// npx runs a server through a bin symlink. Node resolves the symlink for
// import.meta.url but not for process.argv[1], so an entry point that compares
// the two exits 0 without starting, and the client only sees a closed
// connection. Running the real path doesn't show this, so go through a symlink.
const packagesDir = resolve(__dirname, "../packages");
// auth is an OAuth web service, not an MCP server, so it has no stdio to test.
const servers = readdirSync(packagesDir).filter((name) => {
  const manifest = join(packagesDir, name, "package.json");
  return name !== "auth" && existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).bin;
});

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "entry-point-test", version: "1.0.0" },
  },
});

const binDir = mkdtempSync(join(tmpdir(), "mcp-bin-"));
afterAll(() => rmSync(binDir, { recursive: true, force: true }));

function firstLineFrom(bin: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [bin], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) {
        child.kill();
        done(output);
      }
    });
    child.on("exit", () => done(output));
    child.on("error", fail);
    child.stdin.write(`${initialize}\n`);
  });
}

// CI builds before it tests. A local run without dist has nothing to spawn.
describe.each(servers)("%s entry point", (name) => {
  const entry = join(packagesDir, name, "dist/index.js");

  it.skipIf(!existsSync(entry))(
    "answers initialize when run through a symlink",
    async () => {
      const bin = join(binDir, `access-mcp-${name}`);
      symlinkSync(entry, bin);

      expect(await firstLineFrom(bin)).toContain('"serverInfo"');
    },
    15000
  );
});
