# System Status MCP Server

MCP server for real-time ACCESS-CI system status including current outages, scheduled maintenance, and operational status.

## Usage Examples

### Current Status
```
"Current ACCESS-CI outages"
"Delta operational status"
"Systems experiencing issues"
"GPU systems status check"
```

### Maintenance & Incidents
```
"Scheduled maintenance this week"
"Next Expanse maintenance window"
"Past outages for Bridges-2"
"All infrastructure news for Delta"
```

## Tools

### `get_infrastructure_news`

Get infrastructure status, outages, and maintenance information for ACCESS-CI resources.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `time` | enum | Time period: `current`, `scheduled`, `past`, `all` (default: "current") |
| `resource` | string | Filter by resource name (e.g., "delta", "bridges2", "anvil") |
| `outage_type` | enum | Filter by type: `Full`, `Partial`, `Degraded`, `Reconfiguration` |
| `ids` | array | Check status by name, group ID or resource ID. Returns `operational`, `affected`, or `unknown` when the status can't be determined |
| `limit` | number | Max results (default: 50 for "all", 100 for "past") |

A canceled outage stays in the `scheduled` and `all` results with `canceled: true`. It doesn't count as current or upcoming, and it doesn't make a resource report as `affected`. The news API has no cancellation field, so this is read from the subject.

**Examples:**
```javascript
// Get current outages across all resources
get_infrastructure_news({})

// Get scheduled maintenance
get_infrastructure_news({ time: "scheduled" })

// Get comprehensive overview
get_infrastructure_news({ time: "all" })

// Filter to a specific resource
get_infrastructure_news({ resource: "delta", time: "current" })

// Filter by outage type
get_infrastructure_news({ outage_type: "Full" })

// Check operational status of specific resources (by name or ID)
get_infrastructure_news({
  ids: ["Anvil", "Delta", "Bridges-2"]
})

// Or using full resource IDs
get_infrastructure_news({
  ids: ["delta.ncsa.access-ci.org", "bridges2.psc.access-ci.org"]
})

// Get past outages with limit
get_infrastructure_news({ time: "past", limit: 50 })
```

## Installation

```bash
npm install -g @access-mcp/system-status
```

## Configuration

```json
{
  "mcpServers": {
    "access-system-status": {
      "command": "npx",
      "args": ["@access-mcp/system-status"]
    }
  }
}
```

## Resources

- `accessci://system-status` - Current operational status of all ACCESS-CI resources
- `accessci://outages/current` - Currently active outages
- `accessci://outages/scheduled` - Upcoming scheduled maintenance
- `accessci://outages/past` - Historical outages

---

**Package:** `@access-mcp/system-status`
**Version:** v0.9.0
**Main:** `dist/index.js`
