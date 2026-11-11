# @access-mcp/shared

Shared utilities and base classes for ACCESS-CI MCP servers.

## Overview

This package provides the common infrastructure used by all ACCESS-CI MCP servers:

- **BaseAccessServer**: Abstract base class for creating MCP servers
- **Error handling utilities**: Consistent error handling across servers
- **Type definitions**: Shared TypeScript types
- **API utilities**: Helper functions for API interactions

## Installation

```bash
npm install @access-mcp/shared
```

## Usage

```typescript
import { BaseAccessServer, handleApiError } from "@access-mcp/shared";

export class MyServer extends BaseAccessServer {
  constructor() {
    super("my-server", "1.0.0");
  }

  // Implement required abstract methods
}
```

## Features

- Automatic stdio transport setup
- Consistent error handling
- Built-in axios HTTP client with authentication support
- TypeScript support with full type definitions

## Acting-user tokens

Servers constructed with `actsForUsers: true` (events, announcements,
allocations) take the acting user on `/tools/:toolName` from a token the portal
mints for the ACCESS agent, instead of trusting the `X-Acting-User` header. The
agent exchanges the researcher's agent token at the portal's
`/api/token-exchange` and sends the result as `Authorization: Bearer`.

The token is an ES256 `at+jwt` from the portal's
`/.well-known/exchange-jwks.json`. A server accepts it only with the exact
issuer, the exact single audience, `azp` of `access-assistant`, scope
`mcp:write`, a lifetime of at most 900 seconds, and an unexpired `exp`. The
acting user is its `sub`. A bad token gets a 401 and is never replaced by the
header, and an `X-Acting-User` sent alongside must equal `sub`. The API key is
still required as a second check.

| Variable | Default | |
|---|---|---|
| `MCP_TOKEN_ISSUER` | unset | The portal's issuer, e.g. `https://support.access-ci.org`. Unset, a Bearer on `/tools` is refused. |
| `MCP_TOKEN_JWKS_URL` | `<issuer>/.well-known/exchange-jwks.json` | |
| `MCP_TOKEN_AUDIENCE` | `https://mcp.access-ci.org` | `https://mcp.dev.invalid` off live. |
| `MCP_TOKEN_ALLOWED_AZP` | `access-assistant` | Comma-separated. |
| `MCP_TOKEN_KIDS` | unset | Required with `MCP_TOKEN_ISSUER`. The kid of the portal's exchange key, the `kid` in an exchanged token's header; list the old and new kid while it rotates. The agent key is in the same JWKS and is never accepted. |
| `MCP_ACTING_USER_AUTH` | `either` | `either` also accepts `X-Acting-User` without a token; `token` refuses it. `token` requires `MCP_TOKEN_ISSUER`, or the server won't start. |

The JWKS is fetched at startup, and the log says so loudly if it can't be fetched,
if a pinned kid isn't in it, or if `MCP_TOKEN_ISSUER` is unset. Tokens are
checked with no clock leeway on `exp` and up to 60 seconds of leeway on `iat`,
so server clocks must stay within 60 seconds of the portal's (NTP).
The portal's kid is the first 16 hex digits of the SHA-256 of the key's public
PEM. From the exchange private key (or `-pubin -in public.pem` for the public
one):

```bash
openssl pkey -in exchange-private.pem -pubout | shasum -a 256 | cut -c1-16
```

It is also the `kid` in any exchanged token's header. To rotate the exchange
key without refusing writes: add the new kid to `MCP_TOKEN_KIDS` on all three
servers (`old,new`) and redeploy them; publish the new key on the portal as
verify-only, then make it the signing key; once tokens signed with the old key
have expired (15 minutes), remove the old kid from `MCP_TOKEN_KIDS`. A pinned
kid the servers haven't seen yet makes them refetch the JWKS, at most every 30
seconds.

`ACTING_USER` is only a fallback for a local stdio session; it is ignored once
the HTTP service runs and always in production.

Each acting call logs `Acting user auth` with `path` `token` or `header` (at
warn for writes and header-path calls, so production's default level keeps
them), and the tool span carries `mcp.acting_user.auth`. Rollout: deploy with
`MCP_TOKEN_ISSUER` set (step 1), turn on token sending in the agent (step 2),
and once no `path: header` lines remain set `MCP_ACTING_USER_AUTH=token`
and change the `MCP_ACTING_USER_AUTH` default in docker-compose.prod.yml to
`token` (step 3). Deploy this before the agent is set to send tokens: older
servers ran the CILogon middleware on `/tools` and would post the portal
token to mcp-auth.

This is separate from the outside-client OAuth path (`OAUTH_VERIFY_URL`), which
verifies CILogon tokens on `/mcp` and `/messages` only. That middleware skips
`/tools`, so the portal token is never sent to CILogon, and a CILogon token on
`/tools` fails verification as a portal token.

## License

MIT
