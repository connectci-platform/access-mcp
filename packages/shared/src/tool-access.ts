import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type AccessTier = "public" | "authenticated";

export type ToolWithAccess = Tool & {
  access?: AccessTier;
  mutates?: boolean;
};

// Default-deny: a tool is public ONLY if it explicitly says so.
export function classifyTool(tool: ToolWithAccess): AccessTier {
  return tool.access === "public" ? "public" : "authenticated";
}

// Narrow a parsed JSON-RPC message to a tools/call with a tool name.
function toolCallName(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  const m = msg as { method?: unknown; params?: unknown };
  if (m.method !== "tools/call") return undefined;
  const params = m.params as { name?: unknown } | undefined;
  return typeof params?.name === "string" ? params.name : undefined;
}

// Is a single JSON-RPC message authorized on its own?
function messageAuthorized(
  msg: unknown,
  publicToolNames: Set<string>,
  transportAuthorized: boolean
): boolean {
  const name = toolCallName(msg);
  // Non-tools/call methods (initialize, tools/list, notifications, lifecycle)
  // are always allowed: they expose only metadata, never tool execution.
  if (name === undefined) return true;
  // A tools/call is allowed if the tool is public, OR the transport is
  // authorized (valid key or verified acting-user). Default-deny: a name not
  // in publicToolNames is authenticated.
  if (publicToolNames.has(name)) return true;
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

export function stripAccessMarkers(tools: ToolWithAccess[]): Tool[] {
  return tools.map((t) => {
    // Structural copy without the internal markers. Everything else passes through.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit from `rest`
    const { access: _access, mutates: _mutates, ...rest } = t;
    return rest;
  });
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
