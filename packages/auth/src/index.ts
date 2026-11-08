#!/usr/bin/env node
/**
 * ACCESS-CI MCP Auth Service
 *
 * Shared OAuth authorization server that proxies to CILogon.
 * Individual MCP servers verify tokens via CILogon's userinfo endpoint.
 */

import express from "express";
import { createLogger, describeAxiosFailure, logUpstreamFailure } from "@access-mcp/shared";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { CILogonOAuthProvider } from "./cilogon-provider.js";
import { SqliteClientStore, resolveClientStorePath } from "./sqlite-client-store.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const CILOGON_CLIENT_ID = process.env.CILOGON_CLIENT_ID;
const CILOGON_CLIENT_SECRET = process.env.CILOGON_CLIENT_SECRET;
const EXTERNAL_BASE_URL =
  process.env.OAUTH_EXTERNAL_BASE_URL || "https://mcp.access-ci.org/auth";

if (!CILOGON_CLIENT_ID || !CILOGON_CLIENT_SECRET) {
  console.error(
    "CILOGON_CLIENT_ID and CILOGON_CLIENT_SECRET must be set"
  );
  process.exit(1);
}

const clientStore = new SqliteClientStore(resolveClientStorePath(process.env));

const provider = new CILogonOAuthProvider({
  clientId: CILOGON_CLIENT_ID,
  clientSecret: CILOGON_CLIENT_SECRET,
  externalBaseUrl: EXTERNAL_BASE_URL,
  clientStore,
});

const logger = createLogger("access-mcp-auth");
const app = express();
app.set("trust proxy", 1); // Behind Caddy reverse proxy
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging (production-level, not verbose)
app.use((req, _res, next) => {
  if (req.path !== "/health") {
    console.log(`${req.method} ${req.path}`);
  }
  next();
});

// Protected resource metadata for all MCP servers.
// Claude discovers OAuth by fetching /.well-known/oauth-protected-resource/<server-path>
// from the server URL it was given. We serve this for all server paths,
// pointing to our auth service as the authorization server.
app.use((req, res, next) => {
  // Match both the per-server path (/.well-known/oauth-protected-resource/<name>)
  // and the BARE root (/.well-known/oauth-protected-resource, per RFC 9728). The
  // MCP client fetches the bare path during discovery; returning an empty 200
  // there (the old behavior — the handler only matched the trailing-slash form)
  // breaks the client with "expected object, received null" / EOF.
  const base = "/.well-known/oauth-protected-resource";
  if (
    req.method === "GET" &&
    (req.path === base || req.path.startsWith(`${base}/`))
  ) {
    const resourcePath =
      req.path === base ? "" : req.path.slice(`${base}/`.length);
    res.json({
      resource: `https://mcp.access-ci.org/${resourcePath}`,
      authorization_servers: [EXTERNAL_BASE_URL],
      scopes_supported: ["openid", "email", "org.cilogon.userinfo"],
      resource_name: "ACCESS-CI MCP Servers",
      resource_documentation: "https://mcp.access-ci.org/docs/",
    });
    return;
  }
  next();
});

// Health check
app.get("/health", (_req, res) => {
  res.json({
    server: "access-mcp-auth",
    version: "0.1.0",
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

// CILogon callback — receives the auth code from CILogon after user login
app.get("/callback", async (req, res) => {
  try {
    const { code, state } = req.query as { code: string; state: string };
    if (!code || !state) {
      res.status(400).send("Missing code or state parameter");
      return;
    }

    const { redirectUri } = await provider.handleCallback(code, state);

    // Serve an ACCESS-branded success page that redirects
    res.send(`<!DOCTYPE html>
<html><head>
<title>ACCESS-CI Authentication</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700&display=swap" rel="stylesheet">
</head>
<body style="font-family:'Archivo',system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#fff">
<div style="text-align:center;max-width:480px;padding:2rem">
<div style="margin-bottom:1.5rem">
  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#008597" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
</div>
<h2 style="color:#232323;font-weight:700;margin:0 0 0.5rem">Successfully Authenticated</h2>
<p style="color:#3f3f3f;margin:0 0 1.5rem">You're now connected to ACCESS-CI MCP services.</p>
<p style="color:#707070;font-size:14px;margin:0">Redirecting back to your AI assistant...<br>You can close this tab if it doesn't close automatically.</p>
</div>
<script>setTimeout(function(){window.location.href = ${JSON.stringify(redirectUri)};}, 1500);</script>
</body></html>`);
  } catch (error) {
    // The error text can come from CILogon or the network and name internal
    // hosts, so the caller gets a fixed message and the log gets metadata only.
    const failure = describeAxiosFailure(error, "cilogon");
    logUpstreamFailure(logger, { ...failure, path: failure.path ?? "/callback" });
    res.status(500).send("Authentication failed. Please try again.");
  }
});

// Token verification endpoint — internal use by MCP servers
app.post("/verify", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing Bearer token" });
      return;
    }

    const token = authHeader.slice(7);
    const authInfo = await provider.verifyAccessToken(token);
    res.json(authInfo);
  } catch (error) {
    res.status(401).json({ error: "Invalid token" });
  }
});

// MCP OAuth router — serves .well-known, /authorize, /token, /register, /revoke
const issuerUrl = new URL(EXTERNAL_BASE_URL);
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl,
    scopesSupported: ["openid", "email", "org.cilogon.userinfo"],
    resourceName: "ACCESS-CI MCP Servers",
    serviceDocumentationUrl: new URL(
      "https://mcp.access-ci.org/docs/"
    ),
  })
);

// Exported so tests can exercise the routes without binding a port.
export { app };

// Only bind a port when run as the entrypoint, not when imported by a test.
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`ACCESS-CI MCP Auth Service running on port ${PORT}`);
    console.log(`External URL: ${EXTERNAL_BASE_URL}`);
    console.log(`CILogon callback: ${EXTERNAL_BASE_URL}/callback`);
  });
}
