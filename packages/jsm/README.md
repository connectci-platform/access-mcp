# ACCESS JSM MCP Server

MCP server for creating support tickets in ACCESS Jira Service Management.

## Overview

This server enables AI agents to create support tickets on behalf of users. It connects to the existing ACCESS JSM proxy which handles authentication and field mapping.

## Tools

### `create_support_ticket`

Create a general support ticket for issues with allocations, accounts, software, etc.

### `create_login_ticket`

Create a ticket for login issues - either ACCESS portal or resource provider login problems.

### `report_security_incident`

Report security vulnerabilities or incidents to the ACCESS cybersecurity team.

### `get_ticket_types`

Get information about available ticket types and their categories.

### Previewing before filing

The three ticket tools preview by default and file nothing. The model calls the tool to show the user the ticket as it would be filed, the user confirms with the Confirm button, and only then is the call made with `confirmed: true`. The model never passes `confirmed` itself. A preview returns `{action: "create_ticket", status: "preview", executed: false, data}` with the request type, summary, description (including any verification note), the email it would be filed under (`filed_as`), and the other fields the ticket carries. Dry-run mode applies to the confirmed call.

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JSM_PROXY_URL` | No | Netlify proxy URL (default: `https://access-jsm-api.netlify.app`) |
| `MCP_API_KEY` | Yes | API key for authenticating requests from the agent |
| `PORT` | No | HTTP port for the server |

## Security

This server requires API key authentication. Requests must include:

```
X-Api-Key: <your-api-key>
```

The API key must match the `MCP_API_KEY` environment variable.

## Usage

### With HTTP (Docker/Production)

```bash
PORT=3012 MCP_API_KEY=your-secret npm start
```

### Agent Request Example

A signed-in user's ticket is filed under the email and name on their verified
acting-user token, so the agent sends that token and no contact details:

```bash
curl -X POST http://localhost:3012/tools/create_support_ticket \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your-secret" \
  -H "Authorization: Bearer <acting-user token from /api/token-exchange>" \
  -d '{
    "arguments": {
      "summary": "Cannot allocate GPUs on Delta",
      "description": "User is unable to submit GPU jobs. Getting error about quota exceeded.",
      "category": "Allocation Question",
      "resource": "Delta"
    }
  }'
```

Without a verified token (an anonymous user, or a signed-in user whose token
exchange failed), pass `user_email` and, if known, `user_name`. The ticket's
description then says the requester isn't verified. The result's `filed_as`
is the email the ticket went to.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```
