# ACCESS-CI Events MCP Server

MCP server for ACCESS-CI events including workshops, webinars, and training sessions.

## Usage Examples

### Search & Discovery
```
"Upcoming ACCESS events"
"Python workshops"
"Machine learning training"
"Office hours this week"
```

### Filtering
```
"Beginner events this month"
"GPU computing workshops"
"Advanced training sessions"
```

## Tools

### `search_events`

Search and filter ACCESS-CI events.

Returns future events by default. Use `date: "past"` for historical events, most recent first, or `date_range` for an absolute window, in date order.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Search titles, descriptions, speakers, tags |
| `type` | string | Filter: `workshop`, `webinar`, `training` |
| `tags` | string | Filter: `python`, `gpu`, `hpc`, `ml` |
| `date` | enum | Quick date filter: `today`, `upcoming`, `past`, `this_week`, `this_month` |
| `start_date` | string | Start date (YYYY-MM-DD or relative like `-6month`). Overrides `date`. |
| `end_date` | string | End date (YYYY-MM-DD or relative like `+3month`). Overrides `date`. |
| `skill` | enum | Skill level: `beginner`, `intermediate`, `advanced` |
| `has_video` | boolean | Filter to events with recorded video (implies past events) |
| `limit` | number | Max results (default: 50) |

**Examples:**
```javascript
// Upcoming Python events
search_events({ query: "python", limit: 10 })

// Machine learning workshops this month
search_events({ query: "machine learning", date: "this_month", type: "workshop" })

// Beginner GPU training
search_events({ tags: "gpu", skill: "beginner" })

// Events with video recordings
search_events({ has_video: true, limit: 20 })

// Events in a specific date range
search_events({ date_range: { start_date: "2025-01-01", end_date: "2025-06-30" } })
```

### `get_my_events`

Get events created by or associated with the **authenticated user**, including unpublished/draft events. Read-only, scoped to the acting user.

Requires authentication: the acting user is resolved from the `X-Acting-User` header (set by an authenticated MCP connector) or the `ACTING_USER` environment variable. Returns `{ total, items: [{ title, start_date, end_date, status, ... }] }`.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | number | Max results (default: 50) |
| `fields` | string[] | Optional projection — return only these fields per event |

**Examples:**
```javascript
// The signed-in user's events
get_my_events({ limit: 25 })
```

## Installation

```bash
npm install -g @access-mcp/events
```

## Configuration

```json
{
  "mcpServers": {
    "access-events": {
      "command": "npx",
      "args": ["@access-mcp/events"]
    }
  }
}
```

## Resources

- `accessci://events` - All events data
- `accessci://events/upcoming` - Upcoming events
- `accessci://events/workshops` - Workshop events
- `accessci://events/webinars` - Webinar events

---

**Package:** `@access-mcp/events`
**Version:** v0.6.0
**Main:** `dist/index.js`
