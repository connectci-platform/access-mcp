/**
 * Early telemetry bootstrap for OpenTelemetry auto-instrumentation.
 *
 * IMPORTANT: This file must be loaded BEFORE the main server script.
 * OpenTelemetry auto-instrumentation only works if the SDK is initialized before
 * the modules it instruments (express, http) are loaded.
 *
 * Usage: Load via Node.js --import flag in Dockerfile:
 *   CMD ["node", "--import", "./packages/shared/dist/telemetry-bootstrap.js", "packages/${PACKAGE}/dist/index.js"]
 *
 * The bootstrap automatically reads the server's package.json to get name/version.
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from "@opentelemetry/semantic-conventions";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryFreeTraceExporter } from "./telemetry-exporter.js";

interface PackageJson {
  name: string;
  version: string;
}

/**
 * Read the package.json for the target package.
 * Uses the PACKAGE env var set by the Dockerfile to locate the package.
 */
function getPackageInfo(): PackageJson {
  const packageName = process.env.PACKAGE;
  if (!packageName) {
    return { name: "unknown-mcp-server", version: "0.0.0" };
  }

  try {
    // In Docker, packages are at /app/packages/${PACKAGE}
    const pkgPath = join(process.cwd(), "packages", packageName, "package.json");
    const content = readFileSync(pkgPath, "utf-8");
    return JSON.parse(content) as PackageJson;
  } catch {
    return { name: `mcp-${packageName}`, version: "0.0.0" };
  }
}

function bootstrap(): void {
  const pkg = getPackageInfo();
  const serviceName = pkg.name;
  const serviceVersion = pkg.version;

  // Check if telemetry is disabled
  if (process.env.OTEL_ENABLED === "false") {
    console.log(`[${serviceName}] OpenTelemetry disabled via OTEL_ENABLED=false`);
    return;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    console.log(`[${serviceName}] OpenTelemetry disabled: no OTEL_EXPORTER_OTLP_ENDPOINT`);
    return;
  }

  // Parse headers from environment (format: "key1=value1,key2=value2")
  // Note: Values may contain '=' (e.g., base64), so only split on first '='
  const headersStr = process.env.OTEL_EXPORTER_OTLP_HEADERS || "";
  const headers: Record<string, string> = {};
  headersStr.split(",").forEach((pair) => {
    const eqIndex = pair.indexOf("=");
    if (eqIndex > 0) {
      const key = pair.slice(0, eqIndex).trim();
      const value = pair.slice(eqIndex + 1).trim();
      if (key && value) {
        headers[key] = value;
      }
    }
  });

  // Set Honeycomb dataset header
  const dataset = process.env.HONEYCOMB_DATASET || "access-ci";
  headers["x-honeycomb-dataset"] = dataset;

  const traceExporter = new QueryFreeTraceExporter({
    url: `${endpoint}/v1/traces`,
    headers,
  });

  const resource = resourceFromAttributes({
    [SEMRESATTRS_SERVICE_NAME]: dataset,
    [SEMRESATTRS_SERVICE_VERSION]: serviceVersion,
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: process.env.ENVIRONMENT || "local",
    "service.component": serviceName,
  });

  // Nothing reads the default metrics, and with no dataset header they land in
  // Honeycomb's unknown_metrics. Setting the variable turns them back on.
  process.env.OTEL_METRICS_EXPORTER ??= "none";

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
  });

  sdk.start();
  console.log(`[${serviceName}] OpenTelemetry initialized: exporting to ${endpoint}`);

  // Listening for a signal turns off Node's default exit, and no server handles
  // these itself, so we have to end the process once spans are flushed.
  const shutdown = (signal: string) => {
    console.log(`[${serviceName}] Received ${signal}, shutting down OpenTelemetry...`);
    sdk
      .shutdown()
      .then(() => console.log(`[${serviceName}] OpenTelemetry shutdown complete`))
      .catch((err) => console.error(`[${serviceName}] OpenTelemetry shutdown error`, err instanceof Error ? err.message : String(err)))
      .finally(() => process.exit(0));
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

// Run bootstrap immediately on import
bootstrap();
