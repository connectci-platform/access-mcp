# ACCESS Support Announcements MCP Server

MCP server for ACCESS support announcements, service updates, maintenance notices, and community communications. Supports both searching public announcements and creating/managing announcements for authenticated users.

## Usage Examples

### Searching Announcements
```
"Recent ACCESS announcements"
"Search for GPU announcements"
"Find announcements about machine learning"
```

### Creating Announcements
```
"Help me create a new announcement"
"I want to post an announcement about our workshop"
```

### Managing Your Announcements
```
"Show my announcements"
"Update my draft announcement"
"Delete my announcement"
```

## Tools

### `search_announcements`

Search and filter ACCESS support announcements (public, read-only).

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Full-text search across title, body, and summary |
| `tags` | string | Filter by topics (e.g., "gpu", "machine-learning", "training") |
| `date` | enum | Time period: `today`, `this_week` (last 7 days), `this_month` (last 30 days), `past` (last year) |
| `limit` | number | Max results (default: 25) |

**Returns:** `{ total, items: [{ uuid, title, summary, body, published_date, tags, affiliation, affinity_group }] }`

**Examples:**
```javascript
// Full-text search
search_announcements({ query: "GPU computing" })

// GPU announcements from the past month
search_announcements({ tags: "gpu", date: "this_month" })

// Combined search
search_announcements({ query: "workshop", tags: "training", limit: 10 })
```

### `get_announcement_context`

Get user context and available options before creating an announcement. **Call this first** when creating announcements.

**Returns:**
- `tags`: Available tags for announcements
- `affinity_groups`: Groups the user coordinates (empty if not a coordinator)
- `is_coordinator`: Boolean - whether user can associate announcements with affinity groups
- `affiliations`: Available affiliation options ("ACCESS Collaboration", "Community")
- `where_to_share_options`: Available sharing options (for coordinators)

### `create_announcement`

Create a new ACCESS announcement (saved as draft for staff review).

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Clear, specific headline (under 100 characters) |
| `body` | string | Yes | Full content. HTML supported (`<p>`, `<a>`, `<strong>`, `<em>`, `<ul>`, `<li>`) |
| `summary` | string | Yes | Brief teaser (1-2 sentences) for listings |
| `tags` | array | No | Tag names to categorize the announcement |
| `affiliation` | string | No | "ACCESS Collaboration" or "Community" (default) |
| `affinity_group` | string | No | Group name/UUID (coordinators only) |
| `external_link` | object | No | `{ uri: "https://...", title: "Link text" }` |
| `where_to_share` | array | No | Where to publish: "Announcements page", "Bi-Weekly Digest" (all users), "Affinity Group page", "Email to Affinity Group" (coordinators only) |

**Returns:** `{ success, uuid, title, edit_url }`

### `update_announcement`

Update an existing announcement you own.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uuid` | string | Yes | Announcement UUID (from `get_my_announcements`) |
| `title` | string | No | New title |
| `body` | string | No | New body content |
| `summary` | string | No | New summary |
| `tags` | array | No | New tags |
| `affinity_group` | string | No | New affinity group |
| `external_link` | object | No | New external link |
| `where_to_share` | array | No | Where to publish (see create_announcement for options) |

**Returns:** `{ success, uuid, title, edit_url }`

### `delete_announcement`

Permanently delete an announcement you own. **Requires explicit user confirmation.**

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uuid` | string | Yes | Announcement UUID |
| `confirmed` | boolean | Yes | Must be `true` - only set after showing the user the title/status and getting explicit confirmation |

**Important:** For bulk deletes, each announcement must be confirmed individually. General consent ("delete them all") is not sufficient.

**Returns:** `{ success, uuid }`

### `get_my_announcements`

List all announcements created by the authenticated user.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | number | Max results (default: 50) |

**Returns:** `{ total, items: [{ uuid, nid, title, status, created, published_date, summary, edit_url }] }`

## Installation

```bash
npm install -g @access-mcp/announcements
```

## Configuration

For read-only access (searching public announcements):
```json
{
  "mcpServers": {
    "access-announcements": {
      "command": "npx",
      "args": ["@access-mcp/announcements"]
    }
  }
}
```

For full access (creating/managing announcements), authentication is required:
```json
{
  "mcpServers": {
    "access-announcements": {
      "command": "npx",
      "args": ["@access-mcp/announcements"],
      "env": {
        "DRUPAL_API_URL": "https://support.access-ci.org",
        "DRUPAL_USERNAME": "your-username",
        "DRUPAL_PASSWORD": "your-password",
        "ACTING_USER_UID": "12345"
      }
    }
  }
}
```

## Resources

- `accessci://announcements` - Recent announcements (10 most recent)

## Prompts

- `create_announcement_guide` - Step-by-step guide for creating announcements
- `manage_announcements_guide` - Guide for viewing, updating, and deleting announcements

---

**Package:** `@access-mcp/announcements`
**Version:** v0.6.0
**Main:** `dist/index.js`
