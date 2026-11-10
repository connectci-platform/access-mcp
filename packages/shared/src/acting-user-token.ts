/**
 * Verification of the acting-user token the ACCESS agent sends on /tools calls.
 *
 * The portal mints it at /api/token-exchange for the access-assistant client,
 * from the researcher's agent token (D8-2946). It is an ES256 at+jwt signed
 * with a key from the portal's /.well-known/exchange-jwks.json, addressed to
 * the MCP tool servers (aud), carrying mcp:write, with the researcher's ACCESS
 * ID as sub. A server that verifies it takes the acting user from sub instead
 * of trusting X-Acting-User.
 *
 * The same JWKS also publishes the agent-token key, and the XDMoD token is
 * signed with the same exchange key, so a valid signature alone proves little:
 * the exact issuer, the exact single audience, azp and scope are what make it
 * this token and not one of the others.
 *
 * This is unrelated to the outside-client OAuth path (OAUTH_VERIFY_URL), which
 * verifies CILogon tokens on /mcp and /messages. Those tokens are opaque to us
 * and never verify here; this token is only accepted on /tools.
 */
import { createRemoteJWKSet, jwtVerify, errors, type JWTPayload, type JWTVerifyGetKey } from "jose";

export const ACTING_USER_SCOPE = "mcp:write";
export const DEFAULT_ACTING_USER_AUDIENCE = "https://mcp.access-ci.org";
export const DEFAULT_ALLOWED_AZP = "access-assistant";
/** The portal mints exchanged tokens for exactly this long. */
export const MAX_TOKEN_LIFETIME_S = 900;
export const MAX_IAT_SKEW_S = 60;

/**
 * How a server that acts for users treats X-Acting-User without a token.
 *
 * - either: accepted, as before this token existed (rollout steps 1 and 2).
 * - token: refused; the acting user comes only from a verified token (step 3).
 *
 * A presented token is verified in both modes, and a bad one is never
 * replaced by the header.
 */
export type ActingUserAuthMode = "either" | "token";

export interface ActingUserTokenConfig {
  mode: ActingUserAuthMode;
  /** The portal's issuer; unset means tokens can't be verified. */
  issuer?: string;
  jwksUrl?: string;
  audience: string;
  allowedAzp: string[];
  /**
   * The kids of the portal's exchange key. The same JWKS publishes the agent
   * key, so only these may sign an acting-user token. List two while a key
   * rotates.
   */
  kids: string[];
}

/**
 * Reads the configuration from the environment.
 *
 * MCP_ACTING_USER_AUTH  either (default) | token
 * MCP_TOKEN_ISSUER      the portal's issuer, e.g. https://support.access-ci.org
 * MCP_TOKEN_JWKS_URL    default <issuer>/.well-known/exchange-jwks.json
 * MCP_TOKEN_AUDIENCE    default https://mcp.access-ci.org
 * MCP_TOKEN_ALLOWED_AZP comma-separated, default access-assistant
 * MCP_TOKEN_KIDS        comma-separated kids of the portal's exchange key;
 *                       required with MCP_TOKEN_ISSUER
 *
 * Throws for a configuration that can't work, so the server refuses to start
 * rather than refusing every write.
 */
export function actingUserTokenConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ActingUserTokenConfig {
  const mode = (env.MCP_ACTING_USER_AUTH || "either").trim();
  if (mode !== "either" && mode !== "token") {
    throw new Error(`MCP_ACTING_USER_AUTH must be "either" or "token", not "${mode}"`);
  }
  const issuer = env.MCP_TOKEN_ISSUER?.trim() || undefined;
  if (mode === "token" && !issuer) {
    throw new Error("MCP_ACTING_USER_AUTH=token requires MCP_TOKEN_ISSUER");
  }
  const jwksUrl =
    env.MCP_TOKEN_JWKS_URL?.trim() ||
    (issuer ? `${issuer.replace(/\/+$/, "")}/.well-known/exchange-jwks.json` : undefined);
  if (jwksUrl && !/^https?:\/\//.test(jwksUrl)) {
    throw new Error("MCP_TOKEN_JWKS_URL must be an http(s) URL");
  }
  const list = (value: string) =>
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const allowedAzp = list(env.MCP_TOKEN_ALLOWED_AZP || DEFAULT_ALLOWED_AZP);
  const kids = list(env.MCP_TOKEN_KIDS || "");
  if (issuer && kids.length === 0) {
    throw new Error(
      "MCP_TOKEN_ISSUER requires MCP_TOKEN_KIDS, the kid of the portal's exchange key"
    );
  }
  return {
    mode,
    issuer,
    jwksUrl,
    audience: env.MCP_TOKEN_AUDIENCE?.trim() || DEFAULT_ACTING_USER_AUDIENCE,
    allowedAzp,
    kids,
  };
}

/** The token is malformed, wrongly signed, or fails a claim check (401). */
export class InvalidActingUserTokenError extends Error {}

/** No key set could be fetched, so no token can be checked (503). */
export class ActingUserTokenUnavailableError extends Error {}

export interface VerifiedActingUser {
  sub: string;
  jti: string;
  exp: number;
}

export class ActingUserTokenVerifier {
  private readonly getKey: JWTVerifyGetKey;
  private readonly remote?: ReturnType<typeof createRemoteJWKSet>;
  private readonly now: () => number;

  constructor(
    private readonly config: ActingUserTokenConfig & { issuer: string },
    options: { getKey?: JWTVerifyGetKey; now?: () => number } = {}
  ) {
    if (!options.getKey && !config.jwksUrl) {
      throw new Error("A JWKS URL is required to verify acting-user tokens");
    }
    // jose caches the set, refetches on an unknown kid at most every 30s,
    // and pins the key to ES256 below, so an HS256 token signed with the
    // public JWK, or alg none, never verifies.
    if (!options.getKey) {
      this.remote = createRemoteJWKSet(new URL(config.jwksUrl!), { timeoutDuration: 5000 });
    }
    const inner = options.getKey ?? this.remote!;
    // Only the exchange key may sign: a token without a kid, or with any
    // other kid in the set (the agent key's), is refused before key lookup.
    this.getKey = (header, token) => {
      if (typeof header.kid !== "string" || !config.kids.includes(header.kid)) {
        throw new InvalidActingUserTokenError("kid is not the portal's exchange key");
      }
      return inner(header, token);
    };
    this.now = options.now ?? (() => Date.now() / 1000);
  }

  /**
   * Fetches the key set now, for a startup check. Returns what is wrong, or
   * null if every pinned kid is in the set.
   */
  async checkKeys(): Promise<string | null> {
    if (!this.remote) return null;
    try {
      await this.remote.reload();
    } catch (error) {
      return error instanceof Error ? `${error.name}: ${error.message}` : "fetch failed";
    }
    const published = (this.remote.jwks()?.keys ?? []).map((k) => k.kid);
    const missing = this.config.kids.filter((kid) => !published.includes(kid));
    return missing.length ? `missing kid ${missing.join(", ")}` : null;
  }

  async verify(token: string): Promise<VerifiedActingUser> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.getKey, {
        algorithms: ["ES256"],
        typ: "at+jwt",
        issuer: this.config.issuer,
        audience: this.config.audience,
        requiredClaims: ["sub", "jti", "iat", "exp"],
        currentDate: new Date(this.now() * 1000),
      }));
    } catch (error) {
      if (error instanceof InvalidActingUserTokenError) {
        throw error;
      }
      if (
        error instanceof errors.JWKSTimeout ||
        error instanceof errors.JWKSInvalid ||
        // jose throws the bare JOSEError only for a non-200 or unparsable
        // JWKS response.
        (error instanceof errors.JOSEError && error.constructor === errors.JOSEError) ||
        (error instanceof Error && !(error instanceof errors.JOSEError))
      ) {
        // A network failure or a bad JWKS document, not a bad token.
        throw new ActingUserTokenUnavailableError(
          error instanceof Error ? error.name : "JWKS fetch failed"
        );
      }
      throw new InvalidActingUserTokenError(
        error instanceof errors.JOSEError ? error.code : "invalid token"
      );
    }

    // jose accepts an aud array that contains ours; only the exact string is
    // this token.
    if (payload.aud !== this.config.audience) {
      throw new InvalidActingUserTokenError("aud is not exactly the MCP audience");
    }
    const { sub, jti, iat, exp } = payload;
    if (!Number.isInteger(iat) || !Number.isInteger(exp)) {
      throw new InvalidActingUserTokenError("iat and exp must be integers");
    }
    if (exp! - iat! > MAX_TOKEN_LIFETIME_S) {
      throw new InvalidActingUserTokenError("lifetime exceeds 900 seconds");
    }
    if (iat! > this.now() + MAX_IAT_SKEW_S) {
      throw new InvalidActingUserTokenError("iat is in the future");
    }
    if (typeof payload.azp !== "string" || !this.config.allowedAzp.includes(payload.azp)) {
      throw new InvalidActingUserTokenError("azp is not an allowed client");
    }
    const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
    if (!scopes.includes(ACTING_USER_SCOPE)) {
      throw new InvalidActingUserTokenError(`scope lacks ${ACTING_USER_SCOPE}`);
    }
    if (typeof sub !== "string" || !sub || typeof jti !== "string" || !jti) {
      throw new InvalidActingUserTokenError("sub and jti must be non-empty strings");
    }
    return { sub, jti, exp: exp! };
  }
}
