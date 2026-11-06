# Software Discovery MCP Server

MCP server for discovering software packages across ACCESS-CI compute resources. Features global software search, AI-enhanced metadata, fuzzy matching, and software comparison using the Software Discovery Service (SDS) API v1.

## Usage Examples

### Search & Browse
```
"TensorFlow availability across ACCESS-CI"
"All software on Expanse"
"Python versions on Delta"
"GROMACS installation on Bridges-2"
```

### AI-Enhanced Discovery
```
"Machine learning software on Delta"
"Quantum chemistry tools (all resources)"
"Computational biology packages"
"GPU-optimized software by category"
```

### Comparison Queries
```
"Compare CUDA and OpenMPI availability"
"Which resources have TensorFlow and PyTorch?"
```

## Tools

### `search_software`

Search software packages on ACCESS-CI resources with fuzzy matching support.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Software name to search for (supports fuzzy matching) |
| `resource` | string | Resource provider name or ID (e.g., "anvil", "delta.ncsa.access-ci.org") |
| `fuzzy` | boolean | Enable fuzzy matching (default: true) |
| `include_ai_metadata` | boolean | Include AI-generated metadata (default: true) |
| `limit` | number | Max results (default: 100) |

**Examples:**
```javascript
// Search for Python packages with fuzzy matching
search_software({ query: "python", limit: 20 })

// Find TensorFlow on Anvil
search_software({ query: "tensorflow", resource: "anvil" })

// Exact search (no fuzzy matching)
search_software({ query: "gcc", fuzzy: false })
```

### `list_all_software`

List all software packages available across ACCESS-CI resources.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `resource` | string | Filter to a specific resource provider |
| `include_ai_metadata` | boolean | Include AI-generated metadata (default: false) |
| `limit` | number | Max results (default: 100) |

**Examples:**
```javascript
// List all available software
list_all_software({ limit: 100 })

// List software on Delta
list_all_software({ resource: "delta", limit: 50 })
```

### `get_software_details`

Get detailed information about a specific software package.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `software_name` | string | Exact or partial software name (required) |
| `resource` | string | Filter to a specific resource provider |
| `fuzzy` | boolean | Enable fuzzy matching (default: true) |

**Examples:**
```javascript
// Get TensorFlow details
get_software_details({ software_name: "tensorflow" })

// Get GCC details on Expanse
get_software_details({ software_name: "gcc", resource: "expanse" })
```

### `compare_software_availability`

Compare software availability across multiple resources.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `software_names` | array | List of software names to check (required) |
| `resources` | array | List of resources to compare (compares all if not specified) |

**Examples:**
```javascript
// Compare CUDA and OpenMPI availability
compare_software_availability({ software_names: ["cuda", "openmpi"] })

// Compare on specific resources
compare_software_availability({
  software_names: ["tensorflow", "pytorch"],
  resources: ["anvil", "delta", "expanse"]
})
```

## Installation

```bash
npm install -g @access-mcp/software-discovery
```

## Configuration

```json
{
  "mcpServers": {
    "access-software-discovery": {
      "command": "npx",
      "args": ["@access-mcp/software-discovery"],
      "env": {
        "SDS_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

**Note:** The `SDS_API_KEY` environment variable is required. Contact the ACCESS-CI team to request an API key.

## Resources

- `accessci://software-discovery` - ACCESS-CI Software Discovery Service
- `accessci://software/categories` - Available filter values from actual software data

---

**Package:** `@access-mcp/software-discovery`
**Version:** v0.9.0
**Main:** `dist/index.js`
