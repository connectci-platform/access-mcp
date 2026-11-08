/**
 * CILogon OAuth Provider for ACCESS-CI MCP Servers
 *
 * Implements OAuthServerProvider by proxying authorization to CILogon.
 * Claude (or any MCP client) registers dynamically, authenticates via CILogon,
 * and gets tokens that our MCP servers can verify via CILogon's userinfo endpoint.
 */

import { randomUUID } from "node:crypto";
import type { Response } from "express";
import axios from "axios";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

interface CILogonConfig {
  clientId: string;
  clientSecret: string;
  /** External base URL, e.g., "https://mcp.access-ci.org/auth" */
  externalBaseUrl: string;
  /** Persistent (or explicitly in-memory) OAuth client registry. */
  clientStore: OAuthRegisteredClientsStore;
}

interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
}

interface StoredAuthCode {
  cilogonTokens: OAuthTokens;
  client: OAuthClientInformationFull;
  createdAt: number;
}

interface CachedUserInfo {
  info: AuthInfo;
  expiresAt: number;
}

/**
 * In-memory client store for dynamic client registration.
 * Claude registers itself when connecting — clients re-register on restart.
 */
export class InMemoryClientStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  async getClient(
    clientId: string
  ): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async registerClient(
    client: OAuthClientInformationFull
  ): Promise<OAuthClientInformationFull> {
    this.clients.set(client.client_id, client);
    return client;
  }
}

export class CILogonOAuthProvider implements OAuthServerProvider {
  private _clientStore: OAuthRegisteredClientsStore;
  private _pendingAuthorizations = new Map<string, PendingAuthorization>();
  private _authCodes = new Map<string, StoredAuthCode>();
  private _tokenCache = new Map<string, CachedUserInfo>();
  // Clients that keep reconnecting with an expired token would otherwise send
  // every attempt to CILogon. Value is when to ask again.
  private _rejectedTokens = new Map<string, number>();

  // Skip local PKCE — CILogon handles it
  skipLocalPkceValidation = true;

  constructor(private config: CILogonConfig) {
    this._clientStore = config.clientStore;

    // Periodic cleanup of expired pending authorizations (10 min TTL)
    // and auth codes (5 min TTL)
    setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this._pendingAuthorizations) {
        if (now - value.createdAt > 600_000) this._pendingAuthorizations.delete(key);
      }
      for (const [key, value] of this._authCodes) {
        if (now - value.createdAt > 300_000) this._authCodes.delete(key);
      }
      for (const [key, value] of this._tokenCache) {
        if (value.expiresAt < now) this._tokenCache.delete(key);
      }
      for (const [key, retryAt] of this._rejectedTokens) {
        if (retryAt < now) this._rejectedTokens.delete(key);
      }
    }, 60_000);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientStore;
  }

  /**
   * Begin authorization: redirect to CILogon with our client credentials.
   * Store the MCP client's params so we can redirect back after CILogon callback.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const state = randomUUID();
    this._pendingAuthorizations.set(state, { client, params, createdAt: Date.now() });

    const targetUrl = new URL("https://cilogon.org/authorize");
    targetUrl.searchParams.set("client_id", this.config.clientId);
    targetUrl.searchParams.set("response_type", "code");
    targetUrl.searchParams.set(
      "redirect_uri",
      `${this.config.externalBaseUrl}/callback`
    );
    targetUrl.searchParams.set("scope", "openid email org.cilogon.userinfo");
    targetUrl.searchParams.set("state", state);

    res.redirect(targetUrl.toString());
  }

  /**
   * Handle the CILogon callback: exchange CILogon code for tokens,
   * generate our own auth code, redirect client to their redirect_uri.
   */
  async handleCallback(
    cilogonCode: string,
    state: string
  ): Promise<{ redirectUri: string }> {
    const pending = this._pendingAuthorizations.get(state);
    if (!pending) {
      throw new Error("Invalid or expired authorization state");
    }
    this._pendingAuthorizations.delete(state);

    // Exchange CILogon code for tokens
    const tokenResponse = await axios.post(
      "https://cilogon.org/oauth2/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code: cilogonCode,
        redirect_uri: `${this.config.externalBaseUrl}/callback`,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const cilogonTokens: OAuthTokens = {
      access_token: tokenResponse.data.access_token,
      token_type: "bearer",
      refresh_token: tokenResponse.data.refresh_token,
      expires_in: tokenResponse.data.expires_in,
    };

    // Generate our own auth code that maps to these tokens
    const ourCode = randomUUID();
    this._authCodes.set(ourCode, {
      cilogonTokens,
      client: pending.client,
      createdAt: Date.now(),
    });

    // Build redirect back to the MCP client
    const redirectUrl = new URL(pending.params.redirectUri);
    redirectUrl.searchParams.set("code", ourCode);
    if (pending.params.state) {
      redirectUrl.searchParams.set("state", pending.params.state);
    }

    return { redirectUri: redirectUrl.toString() };
  }

  /**
   * Return the code challenge for PKCE validation.
   * Since we skip local PKCE (CILogon validates), return a dummy value.
   */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const stored = this._authCodes.get(authorizationCode);
    if (!stored) {
      throw new Error("Invalid authorization code");
    }
    // Return empty string since we skip local PKCE
    return "";
  }

  /**
   * Exchange our auth code for the CILogon tokens we already obtained.
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const stored = this._authCodes.get(authorizationCode);
    if (!stored) {
      throw new Error("Invalid or expired authorization code");
    }
    if (stored.client.client_id !== client.client_id) {
      throw new Error("Authorization code was issued to a different client");
    }
    this._authCodes.delete(authorizationCode);
    return stored.cilogonTokens;
  }

  /**
   * Refresh tokens via CILogon's token endpoint.
   */
  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string
  ): Promise<OAuthTokens> {
    const tokenResponse = await axios.post(
      "https://cilogon.org/oauth2/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        validateStatus: () => true,
      }
    );

    if (tokenResponse.status !== 200) {
      throw new Error("Refresh token expired or invalid. Please re-authenticate.");
    }

    return {
      access_token: tokenResponse.data.access_token,
      token_type: "bearer",
      refresh_token: tokenResponse.data.refresh_token || refreshToken,
      expires_in: tokenResponse.data.expires_in,
    };
  }

  /**
   * Verify an access token by calling CILogon's userinfo endpoint.
   * Results are cached briefly to avoid hammering CILogon.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Check cache
    const cached = this._tokenCache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.info;
    }
    if ((this._rejectedTokens.get(token) ?? 0) > Date.now()) {
      throw new Error("Invalid or expired access token");
    }

    // Call CILogon userinfo
    const response = await axios.get(
      "https://cilogon.org/oauth2/userinfo",
      {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      }
    );

    if (response.status !== 200) {
      // Only CILogon's own rejection is remembered, so an outage can't lock
      // out valid tokens.
      if (response.status === 401 || response.status === 403) {
        // Anyone can send made-up tokens, so the list is capped.
        if (this._rejectedTokens.size >= 5_000) {
          const oldest = this._rejectedTokens.keys().next().value;
          if (oldest !== undefined) this._rejectedTokens.delete(oldest);
        }
        this._rejectedTokens.set(token, Date.now() + 300_000);
      }
      throw new Error("Invalid or expired access token");
    }

    const userinfo = response.data;
    const authInfo: AuthInfo = {
      token,
      clientId: userinfo.sub || "unknown",
      scopes: ["openid", "email"],
      extra: {
        sub: userinfo.sub,
        email: userinfo.email,
        eppn: userinfo.eppn, // ACCESS ID (e.g., username@access-ci.org)
        name: userinfo.name || userinfo.given_name,
      },
    };

    // Cache for 60 seconds
    this._tokenCache.set(token, {
      info: authInfo,
      expiresAt: Date.now() + 60_000,
    });

    return authInfo;
  }

  /**
   * Revoke a token (optional — best effort).
   */
  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    // Remove from cache
    this._tokenCache.delete(request.token);
  }
}
