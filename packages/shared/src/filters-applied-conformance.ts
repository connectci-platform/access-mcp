/**
 * Shared test helper for the `filters_applied` disclosure contract (Phase 4b).
 *
 * The canonical shape: `metadata.filters_applied = { <verbatim_param_name>:
 * <applied_value> ?? null, ... }` — every accepted param that NARROWS the
 * result set, each key ALWAYS present, unset → `null` (never omitted, never
 * a descriptive string). Every read tool across every MCP server that adopts
 * this convention (announcements first, more in later Phase-4b tasks) asserts
 * the same structural shape against its own expected key list, so the
 * structural check lives here once as the single source of truth.
 *
 * This is test-only support code, exported from the dedicated
 * `./testkit/filters-applied` subpath (NOT the package root) so it stays off
 * the runtime main entry — consuming test suites import it as
 * `@access-mcp/shared/testkit/filters-applied`.
 */

interface TextContent {
  type: "text";
  text: string;
}

interface ToolResponse {
  content: TextContent[];
}

/** Minimal `expect` surface this helper needs — structurally typed so this
 * module doesn't import a test framework; works under any harness's global. */
interface ExpectLike {
  (actual: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toHaveProperty(key: string): void;
  };
}

function isTextContent(value: unknown): value is TextContent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

/**
 * Parse a tool response's envelope out of the MCP `{ content: [{ type:
 * "text", text: JSON.stringify(envelope) }] }` wrapper. Throws a descriptive
 * error (not a silent `undefined`) if the response doesn't match that shape,
 * so a malformed-response bug surfaces at the assertion site, not as a
 * confusing downstream "Cannot read properties of undefined".
 */
function parseEnvelope(response: unknown): Record<string, unknown> {
  const content = (response as Partial<ToolResponse> | null | undefined)?.content;
  const first = Array.isArray(content) ? content[0] : undefined;
  if (!isTextContent(first)) {
    throw new Error(
      "assertFiltersAppliedShape: response is not a { content: [{ type: \"text\", text }] } tool envelope"
    );
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

/**
 * Assert `response` (a raw MCP tool-call result) discloses `metadata.
 * filters_applied` conforming to the Phase-4b shape: present, and its key
 * set EXACTLY equal to `expectedKeys` — no missing key (a key may be `null`
 * but must not be absent), no extra key.
 *
 * Takes an `expect` so it works under any harness's global without this
 * module importing a test framework — same pattern as `assertWriteEnvelope`.
 */
export function assertFiltersAppliedShape(
  response: unknown,
  expectedKeys: string[],
  expect: ExpectLike
): void {
  const envelope = parseEnvelope(response);
  expect(typeof envelope.metadata).toBe("object");
  const metadata = envelope.metadata as Record<string, unknown> | null;
  expect(metadata).toHaveProperty("filters_applied");

  const filtersApplied = (metadata as Record<string, unknown>).filters_applied as
    | Record<string, unknown>
    | null
    | undefined;
  expect(typeof filtersApplied).toBe("object");

  const actualKeys = Object.keys(filtersApplied as Record<string, unknown>).sort();
  expect(actualKeys).toEqual([...expectedKeys].sort());
}
