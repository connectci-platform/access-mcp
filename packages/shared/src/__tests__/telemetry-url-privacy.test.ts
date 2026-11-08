import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const bootstrap = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../dist/telemetry-bootstrap.js"
);

// Makes one traced call in each direction, then stops so the spans flush. The
// query comes from the environment because the SDK exports the command line.
const app = `
const http = require("node:http");
const server = http.createServer((req, res) => res.end("{}"));
server.listen(0, () => {
  const url = "http://127.0.0.1:" + server.address().port + "/api/search?" + process.env.TEST_QUERY;
  http.get(url, (res) => {
    res.resume();
    res.on("end", () => setTimeout(() => process.kill(process.pid, "SIGTERM"), 100));
  });
});
`;

describe("telemetry URL privacy", () => {
  let collector: Server;

  afterEach(() => new Promise((done) => collector.close(done)));

  const paths: string[] = [];

  async function exportedTraces(): Promise<string> {
    const received: string[] = [];
    paths.length = 0;
    collector = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        paths.push(req.url ?? "");
        if (req.url === "/v1/traces") received.push(Buffer.concat(chunks).toString());
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((done) => collector.listen(0, "127.0.0.1", done));
    const { port } = collector.address() as AddressInfo;

    const child = spawn(process.execPath, ["--import", bootstrap, "-e", app], {
      env: {
        ...process.env,
        OTEL_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
        TEST_QUERY: "person=Secret+Person",
      },
      stdio: "ignore",
    });
    await new Promise((done) => child.on("exit", done));
    return received.join("\n");
  }

  it("exports request URLs without their query strings", async () => {
    const traces = await exportedTraces();

    expect(traces).toContain("/api/search");
    expect(traces).toContain('"url.full"');
    expect(traces).not.toContain("Secret");
    expect(traces).not.toContain("person=");
    expect(traces).not.toContain('"url.query"');
  }, 10000);

  // Nothing reads them, and with no dataset set they land in unknown_metrics.
  it("sends traces but no metrics", async () => {
    await exportedTraces();

    expect(paths).toContain("/v1/traces");
    expect(paths).not.toContain("/v1/metrics");
  }, 10000);
});
