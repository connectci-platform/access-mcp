# Affinity Groups MCP Server

MCP server for ACCESS-CI affinity groups, community events, and knowledge base resources.

## Usage Examples

### Discovery
```
"List all affinity groups"
"Machine learning affinity groups"
"Bridges-2 group details"
```

### Events & Knowledge Base
```
"Upcoming events for delta.ncsa.access-ci.org"
"Knowledge base for bridges2.psc.access-ci.org"
"All events and documentation for anvil.purdue.access-ci.org"
```

## Tools

### `search_affinity_groups`

Search ACCESS-CI affinity groups with optional events and knowledge base content.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Group ID (e.g., "bridges2.psc.access-ci.org"). Omit to list all groups |
| `include` | enum | What to include: `events`, `kb`, or `all` |
| `query` | string | Search KB resources |
| `limit` | number | Max results (default: 20) |

**Examples:**
```javascript
// List all affinity groups
search_affinity_groups({})

// Get specific group details
search_affinity_groups({ id: "bridges2.psc.access-ci.org" })

// Get group with events
search_affinity_groups({ id: "bridges2.psc.access-ci.org", include: "events" })

// Get complete group information (fetched in parallel)
search_affinity_groups({ id: "delta.ncsa.access-ci.org", include: "all" })
```

## Installation

```bash
npm install -g @access-mcp/affinity-groups
```

## Configuration

```json
{
  "mcpServers": {
    "access-affinity-groups": {
      "command": "npx",
      "args": ["@access-mcp/affinity-groups"]
    }
  }
}
```

## Resources

- `accessci://affinity-groups` - All affinity groups

---

**Package:** `@access-mcp/affinity-groups`
**Version:** v0.7.0
**Main:** `dist/index.js`
