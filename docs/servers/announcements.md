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
- `affinity_groups`: Groups the user coordinates (empty if not a coordinator)
- `is_coordinator`: Boolean - whether the user coordinates at least one affinity group
- `affiliations`: Available affiliation options ("ACCESS Collaboration", "Community")
- `where_to_share_options`: All sharing options; "Affinity Group page" and "Email to Affinity Group" need an affinity group the user is allowed to post to

### `create_announcement`

Create a new ACCESS announcement (saved as draft for staff review).

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Clear, specific headline (under 100 characters) |
| `body` | string | Yes | Full content. HTML supported (`<p>`, `<a>`, `<strong>`, `<em>`, `<ul>`, `<li>`) |
| `summary` | string | Yes | Brief teaser (1-2 sentences) for listings |
| `tags` | array | No | Tag names to categorize the announcement |
| `affiliation` | string | No | "ACCESS Collaboration" or "Community". Defaults to "Community" when omitted |
| `affinity_group` | string | No | Group name/UUID (a group the user is allowed to post to; administrators and news managers name it directly, as `get_announcement_context` lists only coordinated groups) |
| `external_link` | object | No | `{ uri: "https://...", title: "Link text" }` |
| `where_to_share` | array | No | Where to publish: "Announcements page", "Bi-Weekly Digest" (all users), "Affinity Group page", "Email to Affinity Group" (both require an `affinity_group` the user is allowed to post to). Omit (or pass null) for the defaults "Announcements page" + "Bi-Weekly Digest", which are sent explicitly; duplicates are removed (first occurrence kept); an empty array or a non-array value is rejected |

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
| `affinity_group` | string | No | New affinity group. Replaces all of the announcement's affinity groups |
| `external_link` | object | No | New external link |
| `affiliation` | string | No | New affiliation: "ACCESS Collaboration" or "Community" (only if changing) |
| `where_to_share` | array | No | Where to publish (see create_announcement for options). Replaces the whole set of sharing options, so list every option to keep; when `get_my_announcements` returns `where_to_share`, start from that list and show the user the full resulting list before updating. Duplicates are removed (first occurrence kept). An empty array is rejected. "Affinity Group page" and "Email to Affinity Group" only take effect if the announcement has an affinity group; the tool does not check this |

Calling it with no fields to change returns an error without contacting Drupal.

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
| `limit` | number | Max results (default: 25) |

**Returns:** `{ total, items: [{ uuid, nid, title, status, created, published_date, summary, tags, edit_url }] }`

When available, each item also includes `affiliation` (passed as is, including null), `where_to_share` (labels such as "Announcements page"; unknown values pass through unchanged and cannot be sent back to create or update, which reject them) and `affinity_groups` (`[{ uuid, title }]`). The keys are left out when Drupal does not provide them.

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
