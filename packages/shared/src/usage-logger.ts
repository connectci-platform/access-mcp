import { createHash } from "node:crypto";
import pg from "pg";

/**
 * Hash an actor identity for anonymous-but-stable usage tracking.
 * Deterministic (same actor → same hash), irreversible (SHA-256, truncated),
 * and stable across servers (no per-server salt) so one actor's usage joins
 * across all MCP servers. Returns null for anonymous (no acting user).
 * Mirrors the agent's usage_logs._hash_user (no PII stored).
 */
export function hashActor(actingUser: string | undefined): string | null {
  if (!actingUser) return null; // Falsy (undefined or empty string) is treated as anonymous.
  // 16 hex = 64 bits — ample for grouping/de-dup of distinct actors at our
  // scale; not intended as a cryptographic-strength privacy guarantee.
  return createHash("sha256").update(actingUser).digest("hex").slice(0, 16);
}

export interface UsageCall {
  server: string;
  tool: string;
  args: Record<string, unknown> | undefined | null;
  success: boolean;
  durationMs: number;
  actingUser: string | undefined;
  /**
   * The acting user is only a header claim the server didn't verify (jsm's
   * header path, D8-3069), so the call isn't counted as authenticated.
   */
  unverified?: boolean;
}

export interface UsageRow {
  server: string;
  tool: string;
  arg_keys: string[];
  success: boolean;
  duration_ms: number;
  user_hash: string | null;
  was_authenticated: boolean;
  client: null; // always null in stage 1; widened to string when the client hook lands (stage 1.5)
}

/** Pure: turn a call into the row we persist. Argument NAMES only, never values. */
export function buildUsageRow(call: UsageCall): UsageRow {
  return {
    server: call.server,
    tool: call.tool,
    arg_keys: call.args ? Object.keys(call.args) : [],
    success: call.success,
    // Clamp to a non-negative integer; a non-finite or negative duration
    // (clock skew, hung call) must not poison the integer insert downstream.
    duration_ms: Number.isFinite(call.durationMs) ? Math.max(0, Math.round(call.durationMs)) : 0,
    user_hash: hashActor(call.actingUser),
    was_authenticated: Boolean(call.actingUser) && !call.unverified,
    client: null, // future hook — not derivable at this seam today
  };
}

const SCHEMA_DDL = `
CREATE SCHEMA IF NOT EXISTS mcp_usage;
CREATE TABLE IF NOT EXISTS mcp_usage.tool_calls (
  id                bigserial PRIMARY KEY,
  ts                timestamptz NOT NULL DEFAULT now(),
  server            text NOT NULL,
  tool              text NOT NULL,
  arg_keys          text[] NOT NULL DEFAULT '{}',
  success           boolean NOT NULL,
  duration_ms       integer,
  user_hash         text,
  was_authenticated boolean NOT NULL,
  client            text
);
CREATE INDEX IF NOT EXISTS tool_calls_ts_idx ON mcp_usage.tool_calls (ts);
CREATE INDEX IF NOT EXISTS tool_calls_server_tool_idx ON mcp_usage.tool_calls (server, tool);
`;

/**
 * Best-effort usage logger. Lazily opens one pool from MCP_USAGE_DB_URL,
 * ensures the schema exists on first write, and persists one row per call.
 * Every failure is swallowed: logging must NEVER fail or delay a tool call.
 */
export class UsageLogger {
  readonly enabled: boolean;
  private pool: pg.Pool | undefined;
  private schemaReady: Promise<void> | undefined;

  constructor(private readonly connectionString: string | undefined) {
    this.enabled = Boolean(connectionString);
  }

  private getPool(): pg.Pool {
    if (!this.pool) {
      this.pool = new pg.Pool({ connectionString: this.connectionString, max: 2 });
      // Pool-level errors (dropped connections, "too many connections", server
      // restarts) are a different failure mode than a write error. Log so they're
      // visible, but never throw — the process must not crash over usage logging.
      this.pool.on("error", (err) => {
        console.error(`[usage-logger] pool error: ${err.message}`);
      });
    }
    return this.pool;
  }

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.getPool()
        .query(SCHEMA_DDL)
        .then(() => undefined)
        .catch((err) => {
          // Reset so a later call can retry; never propagate.
          this.schemaReady = undefined;
          throw err;
        });
    }
    return this.schemaReady;
  }

  /** Fire-and-forget. Resolves (undefined) on success AND on any failure. */
  async record(call: UsageCall): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.ensureSchema();
      const row = buildUsageRow(call);
      await this.getPool().query(
        `INSERT INTO mcp_usage.tool_calls
           (server, tool, arg_keys, success, duration_ms, user_hash, was_authenticated, client)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          row.server, row.tool, row.arg_keys, row.success,
          row.duration_ms, row.user_hash, row.was_authenticated, row.client,
        ]
      );
    } catch {
      // Best-effort: swallow. A logging failure must never affect a tool call.
    }
  }
}
