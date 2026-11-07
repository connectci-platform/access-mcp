import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

type ExportArgs = Parameters<OTLPTraceExporter["export"]>;

/**
 * Query strings carry search terms, identifiers and OAuth codes, and telemetry
 * leaves our infrastructure. Dropping them here covers every span, including
 * parameters nobody has thought to list.
 */
export class QueryFreeTraceExporter extends OTLPTraceExporter {
  override export(spans: ExportArgs[0], resultCallback: ExportArgs[1]): void {
    for (const { attributes } of spans) {
      delete attributes["url.query"];
      const url = attributes["url.full"];
      if (typeof url === "string") attributes["url.full"] = url.split(/[?#]/)[0];
    }
    super.export(spans, resultCallback);
  }
}
