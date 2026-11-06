# ACCESS Documentation MCP Server

Hosted MCP server exposing ACCESS-CI's documentation RAG. Retrieves ranked documentation chunks for natural-language questions so the calling LLM can synthesize an answer and cite the source URLs.

## Usage Examples

### General Questions
```
"How do I get an ACCESS allocation?"
"What MFA options does ACCESS support?"
"How do I transfer data with Globus?"
```

### Resource-Scoped Questions
```
"How do I use Globus on Delta?"
"What is the job scheduler on Anvil?"
"How do I load software modules on Bridges-2?"
```

## Tools

### `search_docs`

Retrieves ranked documentation chunks (text plus source URL) for a natural-language question. The calling LLM synthesizes an answer from the returned chunks and cites the URLs. Anonymous from the client's perspective; the upstream API key is a server-side deployment secret.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Natural-language question, not keywords (required) |
| `rp_name` | string | Resource provider slug (e.g. `delta`, `anvil`, `bridges-2`, `expanse`) to scope results to one RP's docs. Invalid slugs return a 400 |
| `fields` | string[] | Dotted-path projection to shrink the response, e.g. `["total","items[].url"]` for just source links, or `["total","items[].text"]` for prose |

`rp_name` accepts a resource provider slug such as `delta`, `anvil`, `bridges-2`, or `expanse`. An invalid slug returns a 400. The full list of valid slugs comes from the ACCESS resource-groups API, [`https://support.access-ci.org/api/1.0/resource-groups`](https://support.access-ci.org/api/1.0/resource-groups) (each group's `slug` field). Leave `rp_name` unset for cross-resource or general-process questions.

Responses can be large (tens of KB). Use `fields` to project down to only the parts you need.

**Examples:**
```javascript
// Basic query
search_docs({ query: "How do I get an ACCESS allocation?" })

// Scope to one resource provider
search_docs({ query: "How do I use Globus?", rp_name: "delta" })

// Project to just the source links
search_docs({
  query: "What MFA options does ACCESS support?",
  fields: ["total", "items[].url"]
})

// Project to just the prose
search_docs({
  query: "How do I request a startup allocation?",
  fields: ["total", "items[].text"]
})
```

**Response:**
```json
{
  "total": 3,
  "items": [
    {
      "rank": 1,
      "url": "https://allocations.access-ci.org/...",
      "text": "..."
    }
  ],
  "metadata": {
    "filters_applied": { "rp_name": null },
    "query": "how do I get an allocation",
    "query_id": "..."
  }
}
```

On empty results, `total` is 0 and a `documentation.usage_notes` hint is included.

## Installation

This server is hosted and isn't published to npm, because searching needs an API key held on the server. Connect to the hosted server, with no key needed:

```bash
claude mcp add access-documentation -t http -s user https://mcp.access-ci.org/documentation/mcp
```

### Environment

These are server-side environment variables for deployment. Clients are keyless and do not configure anything.

| Variable | Description |
|----------|-------------|
| `ACCESS_AI_API_KEY` | Upstream UKY API key, sent as `X-API-KEY`. Optional in code but required in production: UKY returns 401 without it today, until auth is dropped on the retrieve-docs path. It is a server-side deployment secret |
| `ACCESS_DOCS_RETRIEVE_URL` | Optional override of the UKY retrieve-docs endpoint |
