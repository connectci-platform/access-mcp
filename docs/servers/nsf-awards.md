# NSF Awards MCP Server

MCP server for NSF awards and funding information with comprehensive search and detailed award data.

## Usage Examples

### Search & Discovery
```
"Awards for PI Dr. Jane Smith"
"Award #2138259 details"
"Computer science awards at MIT since 2020"
"Awards with 'quantum computing' keywords"
```

### Analysis & Filtering
```
"Stanford awards over $500K"
"Largest materials science awards, 2020-2024"
"All Co-PIs on award #1947282"
```

## Tools

### `search_nsf_awards`

Search NSF awards by award number, PI, institution, or keywords.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Get specific award by number (e.g., "2138259") |
| `pi` | string | Search by principal investigator name |
| `institution` | string | Search by institution name |
| `query` | string | Search keywords in titles and abstracts |
| `primary_only` | boolean | Only return awards where institution is PRIMARY recipient (default: false) |
| `limit` | number | Max results (default: 10, max: 100) |

**Examples:**
```javascript
// Get specific award details
search_nsf_awards({ id: "2138259" })

// Find awards by PI
search_nsf_awards({ pi: "John Smith", limit: 10 })

// Find awards by institution
search_nsf_awards({ institution: "Stanford University", limit: 20 })

// Primary awards only (excludes collaborations)
search_nsf_awards({ institution: "Stanford University", primary_only: true })

// Search by keywords
search_nsf_awards({ query: "machine learning", limit: 10 })
```

## Installation

```bash
npm install -g @access-mcp/nsf-awards
```

## Configuration

The NSF Awards server runs in HTTP mode to enable inter-server communication with the Allocations server.

```json
{
  "mcpServers": {
    "access-nsf-awards": {
      "command": "npx",
      "args": ["@access-mcp/nsf-awards"],
      "env": {
        "PORT": "3007"
      }
    }
  }
}
```

### NSF Integration with Allocations

To enable NSF award cross-referencing in the Allocations server:

```json
{
  "mcpServers": {
    "access-nsf-awards": {
      "command": "npx",
      "args": ["@access-mcp/nsf-awards"],
      "env": { "PORT": "3007" }
    },
    "access-allocations": {
      "command": "npx",
      "args": ["@access-mcp/allocations"],
      "env": { "ACCESS_MCP_SERVICES": "nsf-awards=http://localhost:3007" }
    }
  }
}
```

This enables:
- Institutional funding profiles (ACCESS + NSF)
- PI award history cross-referencing
- Funding vs. computational usage analysis

---

**Package:** `@access-mcp/nsf-awards`
**Version:** v0.4.0
**Main:** `dist/index.js`
