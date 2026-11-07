import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist");
const bootstrap = resolve(dist, "telemetry-bootstrap.js");

// Stands in for an MCP server: an open listener keeps the event loop alive.
const server = `require("node:http").createServer().listen(0, () => console.log("listening"));`;

const viaBootstrap = ["--import", bootstrap, "-e", server];

const viaInitTelemetry = [
  "--input-type=module",
  "-e",
  `import { createServer } from "node:http";
   import { initTelemetry } from ${JSON.stringify(resolve(dist, "telemetry.js"))};
   initTelemetry({ serviceName: "test", serviceVersion: "0.0.0" });
   createServer().listen(0, () => console.log("listening"));`,
];

function stopWith(args: string[], signal: NodeJS.Signals): Promise<number | null> {
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
    },
    stdio: ["ignore", "pipe", "ignore"],
  });

  return new Promise((resolvePromise, reject) => {
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process still running after ${signal}`));
    }, 8000);

    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) child.kill(signal);
    });
    child.on("exit", (code) => {
      clearTimeout(deadline);
      resolvePromise(code);
    });
  });
}

describe("telemetry bootstrap shutdown", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "exits on %s while a server is listening",
    async (signal) => {
      await expect(stopWith(viaBootstrap, signal)).resolves.toBe(0);
    },
    10000
  );
});

describe("initTelemetry shutdown", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "exits on %s while a server is listening",
    async (signal) => {
      await expect(stopWith(viaInitTelemetry, signal)).resolves.toBe(0);
    },
    10000
  );
});
