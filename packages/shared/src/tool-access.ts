import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type AccessTier = "public" | "authenticated";

// `mutates` is required: whether a tool changes anything is published to
// clients as annotations.readOnlyHint, and the ACCESS agent refuses write
// tools to callers without write permission. A tool that left it out would
// read as a read everywhere, so assertToolMarkers refuses to start without it.
export type ToolWithAccess = Tool & {
  access?: AccessTier;
  mutates: boolean;
};

// Default-deny: a tool is public ONLY if it explicitly says so.
export function classifyTool(tool: ToolWithAccess): AccessTier {
  return tool.access === "public" ? "public" : "authenticated";
}

// Classification of a single parsed JSON-RPC message: either non-tools/call
// metadata (always allowed), or a tools/call attempt with its resolved name
// — `name: null` means the call could not be resolved to a string tool name
// (missing/non-string params.name, or a non-object/garbage message), which
// must NOT be treated as metadata.
type MsgKind = { kind: "metadata" } | { kind: "call"; name: string | null };

function classifyMessage(msg: unknown): MsgKind {
  // A non-object message (garbage inside a batch, e.g. `42`) is not a valid
  // metadata message; route it to the unresolvable-call deny path.
  if (!msg || typeof msg !== "object") return { kind: "call", name: null };
  const m = msg as { method?: unknown; params?: unknown };
  if (m.method !== "tools/call") return { kind: "metadata" };
  const params = m.params as { name?: unknown } | undefined;
  return { kind: "call", name: typeof params?.name === "string" ? params.name : null };
}

// Is a single JSON-RPC message authorized on its own?
function messageAuthorized(
  msg: unknown,
  publicToolNames: Set<string>,
  transportAuthorized: boolean
): boolean {
  const msgKind = classifyMessage(msg);
  // Non-tools/call methods (initialize, tools/list, notifications, lifecycle)
  // are always allowed: they expose only metadata, never tool execution.
  if (msgKind.kind === "metadata") return true;
  // A tools/call with no resolvable name is a malformed invocation attempt,
  // not metadata — it must not fall through to always-allow. It's permitted
  // only if the transport itself is authorized (a real authenticated
  // principal); downstream will reject the missing name on its own.
  if (msgKind.name === null) return transportAuthorized;
  // A tools/call is allowed if the tool is public, OR the transport is
  // authorized (valid key or verified acting-user). Default-deny: a name not
  // in publicToolNames is authenticated.
  if (publicToolNames.has(msgKind.name)) return true;
  return transportAuthorized;
}

export function isCallAuthorized(args: {
  body: unknown;
  publicToolNames: Set<string>;
  hasValidKey: boolean;
  hasVerifiedActingUser: boolean;
}): boolean {
  const { body, publicToolNames, hasValidKey, hasVerifiedActingUser } = args;
  const transportAuthorized = hasValidKey || hasVerifiedActingUser;

  // A malformed body (null, non-object) is never a valid single message or
  // batch: deny outright rather than falling through to "no tool name found,
  // so treat it as metadata" in messageAuthorized.
  if (body === null || typeof body !== "object") return false;

  // A batch is authorized only if EVERY message is authorized (no smuggling an
  // authenticated call into a batch of public ones).
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return false; // empty batch
  return messages.every((m) => messageAuthorized(m, publicToolNames, transportAuthorized));
}

/**
 * Tools as clients see them: the internal markers removed, and `mutates`
 * published as MCP's standard `annotations.readOnlyHint`. The hint derived from
 * `mutates` wins over any `annotations.readOnlyHint` a tool sets itself. Only
 * an explicit `mutates: false` is published as read-only, so a tool that
 * somehow reaches here without its marker is listed as making changes.
 */
export function toClientTools(tools: ToolWithAccess[]): Tool[] {
  return tools.map((t) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit from `rest`
    const { access: _access, mutates, ...rest } = t;
    return { ...rest, annotations: { ...rest.annotations, readOnlyHint: mutates === false } };
  });
}

/**
 * Refuse to start with tools whose markers are missing or contradictory:
 * every tool must say whether it mutates, and a write must never be public.
 * Runs in BaseAccessServer.start(), not in a constructor, because a subclass's
 * tools don't exist until its constructor finishes.
 */
export function assertToolMarkers(tools: ToolWithAccess[]): void {
  const unmarked = tools.filter((t) => typeof t.mutates !== "boolean").map((t) => t.name);
  if (unmarked.length > 0) {
    throw new Error(
      `Tool marker misconfiguration: tool(s) without a boolean mutates: ${unmarked.join(", ")}. ` +
        `Every tool must declare mutates: true or mutates: false.`
    );
  }
  assertNoPublicWrites(tools);
}

export function assertNoPublicWrites(tools: ToolWithAccess[]): void {
  const offenders = tools.filter((t) => t.mutates === true && t.access === "public");
  if (offenders.length > 0) {
    const names = offenders.map((t) => t.name).join(", ");
    throw new Error(
      `Tool auth misconfiguration: write tool(s) marked public: ${names}. ` +
        `A tool with mutates:true must never have access:"public".`
    );
  }
}
