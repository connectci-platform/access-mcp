/**
 * OpenTelemetry instrumentation for ACCESS-CI MCP servers.
 *
 * Provides distributed tracing with OTLP export to Honeycomb.
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
import {
  trace,
  Span,
  SpanStatusCode,
  context as otelContext,
  type Attributes,
} from "@opentelemetry/api";
import { QueryFreeTraceExporter } from "./telemetry-exporter.js";

let sdk: NodeSDK | null = null;

export interface TelemetryConfig {
  serviceName: string;
  serviceVersion: string;
  environment?: string;
}

/**
 * Initialize OpenTelemetry SDK with OTLP export to Honeycomb.
 *
 * Environment variables:
 * - OTEL_ENABLED: Set to "false" to disable telemetry (default: true)
 * - OTEL_EXPORTER_OTLP_ENDPOINT: OTLP endpoint URL (e.g., https://api.honeycomb.io)
 * - OTEL_EXPORTER_OTLP_HEADERS: Headers for auth (e.g., "x-honeycomb-team=your-api-key")
 * - HONEYCOMB_DATASET: Dataset name (default: "access-ci")
 */
export function initTelemetry(config: TelemetryConfig): void {
  // Only initialize once
  if (sdk !== null) {
    return;
  }

  // Check if telemetry is disabled
  if (process.env.OTEL_ENABLED === "false") {
    console.log(`[${config.serviceName}] OpenTelemetry disabled via OTEL_ENABLED=false`);
    return;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    console.log(`[${config.serviceName}] OpenTelemetry disabled: no OTEL_EXPORTER_OTLP_ENDPOINT`);
    return;
  }

  // Parse headers from environment
  const headersStr = process.env.OTEL_EXPORTER_OTLP_HEADERS || "";
  const headers: Record<string, string> = {};
  headersStr.split(",").forEach((pair) => {
    const [key, value] = pair.split("=");
    if (key && value) {
      headers[key.trim()] = value.trim();
    }
  });

  // Set Honeycomb dataset header to group all services together
  const dataset = process.env.HONEYCOMB_DATASET || "access-ci";
  headers["x-honeycomb-dataset"] = dataset;

  const traceExporter = new QueryFreeTraceExporter({
    url: `${endpoint}/v1/traces`,
    headers,
  });

  // Use a common service.name for the Honeycomb dataset, with component to distinguish servers
  const datasetName = process.env.HONEYCOMB_DATASET || "access-ci";
  const resource = resourceFromAttributes({
    [SEMRESATTRS_SERVICE_NAME]: datasetName,
    [SEMRESATTRS_SERVICE_VERSION]: config.serviceVersion,
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: config.environment || process.env.ENVIRONMENT || "local",
    "service.component": config.serviceName,
  });

  // Nothing reads the default metrics, and with no dataset header they land in
  // Honeycomb's unknown_metrics. Setting the variable turns them back on.
  process.env.OTEL_METRICS_EXPORTER ??= "none";

  sdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
  });

  sdk.start();
  console.log(`[${config.serviceName}] OpenTelemetry initialized: exporting to ${endpoint}`);

  // Listening for a signal turns off Node's default exit, so end the process
  // once spans are flushed.
  const shutdown = () => {
    sdk
      ?.shutdown()
      .then(() => console.log(`[${config.serviceName}] OpenTelemetry shutdown complete`))
      .catch((err) => console.error(`[${config.serviceName}] OpenTelemetry shutdown error`, err))
      .finally(() => process.exit(0));
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

/**
 * Shutdown OpenTelemetry SDK and flush pending spans.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
  }
}

/**
 * Get a tracer for creating custom spans.
 */
export function getTracer(name: string) {
  return trace.getTracer(name);
}

/**
 * Get the current active span.
 */
export function getCurrentSpan(): Span | undefined {
  return trace.getActiveSpan();
}

/**
 * Set an attribute on the current span.
 */
export function setSpanAttribute(key: string, value: string | number | boolean): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute(key, value);
  }
}

/**
 * Add an event to the current span.
 */
export function addSpanEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.addEvent(name, attributes);
  }
}

/**
 * Record an error on the current span.
 */
export function recordSpanError(error: Error): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }
}

/**
 * Create a child span for tracing a specific operation.
 *
 * @example
 * await withSpan("tool.get_events", { "tool.args": JSON.stringify(args) }, async (span) => {
 *   const result = await fetchEvents(args);
 *   span.setAttribute("tool.result_count", result.length);
 *   return result;
 * });
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer("access-mcp");
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Trace an MCP tool call following OpenTelemetry MCP semantic conventions.
 * https://opentelemetry.io/docs/specs/semconv/gen-ai/mcp/
 *
 * Argument values and error messages can hold personal details and text people
 * wrote, so they are recorded only with `recordArguments: true`. Otherwise the
 * span carries the argument names and the error type.
 *
 * @example
 * const result = await traceMcpToolCall("get_events", args, async (span) => {
 *   const events = await fetchEvents(args);
 *   span.setAttribute("mcp.result.count", events.length);
 *   return events;
 * }, { recordArguments: true });
 */
export async function traceMcpToolCall<T>(
  toolName: string,
  args: Record<string, unknown>,
  fn: (span: Span) => Promise<T>,
  { recordArguments = false }: { recordArguments?: boolean } = {}
): Promise<T> {
  const tracer = getTracer("access-mcp.tools");

  // Follow MCP semantic conventions: "tools/call {tool_name}"
  const spanName = `tools/call ${toolName}`;

  const attributes: Attributes = {
    "mcp.method.name": "tools/call",
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": toolName,
  };

  if (recordArguments) {
    attributes["mcp.tool.arguments"] = JSON.stringify(redactSensitive(args));
  } else {
    attributes["mcp.tool.argument_names"] = Object.keys(args);
  }

  return tracer.startActiveSpan(spanName, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      if (error instanceof Error) {
        if (recordArguments) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        } else {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        span.setAttribute("error.type", error.name || "Error");
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Redact sensitive values from arguments before logging.
 */
function redactSensitive(data: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ["password", "token", "secret", "key", "auth", "credential", "api_key"];
  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    const keyLower = key.toLowerCase();
    if (sensitiveKeys.some((s) => keyLower.includes(s))) {
      redacted[key] = "[REDACTED]";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      redacted[key] = redactSensitive(value as Record<string, unknown>);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

// Re-export for convenience
export { Span, SpanStatusCode, otelContext };
