# Compute Resources MCP Server

MCP server for ACCESS-CI compute resources including hardware specifications, capabilities, and configurations.

## Data source and its limits

This server reads CiDeR, the ACCESS resource catalog, via the operations API. Resource
providers are responsible for keeping their CiDeR records current and largely do not, so
treat what it returns as incomplete rather than authoritative. Verified 2026-09-20:

- `get_resource_hardware` reports Delta at 124 CPU nodes where it has 132, omits the
  MI210 in Delta's AMD node, and lists Bridges-2 as H100-only when it also has L40S and
  V100. NCSA's and PSC's own user guides agree with the curated documentation, not with
  CiDeR.
- It returns no hardware specifications at all for Stampede3, KyRIC, Voyager or
  Neocortex — the description is prose with no node counts or memory.
- `has_gpu` includes resources whose hardware payload has no GPU block and excludes
  non-GPU accelerators such as Habana Gaudi.
- A resource's display name may carry a hand-typed `COMING SOON` or `NO NEW ALLOCATIONS`
  label that contradicts its own `accessAllocated` flag.

**For hardware specifications, prefer the curated per-resource pages under
https://support.access-ci.org/documentation/resources**, which are maintained against
the resource providers' own documentation. Use this server to enumerate and filter the
catalog, and to resolve resource IDs for other ACCESS services.

## Usage Examples

### Discovery & Search
```
"List all GPU resources"
"Resources at NCSA"
"Cloud computing systems"
"Delta hardware specifications"
```

### Recommendations
```
"Recommend a resource for machine learning with GPUs"
"What system should I use for molecular dynamics?"
"Best resource for a beginner doing genomics analysis"
```

## Tools

### `search_resources`

Search and filter ACCESS-CI compute resources. Returns resource IDs usable by other ACCESS-CI services.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Get specific resource (e.g., "delta.ncsa.access-ci.org") |
| `query` | string | Search names, descriptions, organizations |
| `type` | enum | Filter: `compute`, `storage`, `cloud`, `gpu`, `cpu` |
| `has_gpu` | boolean | Filter for GPU resources |
| `organization` | string | Filter by org: `NCSA`, `PSC`, `Purdue`, `SDSC`, `TACC` |
| `limit` | number | Max results (default: 50) |

**Examples:**
```javascript
// List all resources
search_resources({})

// Get specific resource
search_resources({ id: "expanse.sdsc.access-ci.org" })

// Find GPU resources at NCSA
search_resources({ has_gpu: true, organization: "NCSA" })
```

### `get_resource_hardware`

Get detailed hardware specs (CPU, GPU, memory, storage) for a resource.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Resource ID (required) |

**Example:**
```javascript
get_resource_hardware({ id: "delta.ncsa.access-ci.org" })
```

## Prompts

### `recommend_compute_resource`

Get personalized resource recommendations based on research needs.

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| `research_area` | Yes | Field of research (e.g., "machine learning", "molecular dynamics") |
| `compute_needs` | Yes | Requirements (e.g., "GPU for training transformers", "high memory for genome assembly") |
| `experience_level` | No | HPC experience: `beginner`, `intermediate`, `advanced` |
| `allocation_size` | No | Scale needed (e.g., "small pilot project", "large-scale production") |

## Installation

```bash
npm install -g @access-mcp/compute-resources
```

## Configuration

```json
{
  "mcpServers": {
    "access-compute-resources": {
      "command": "npx",
      "args": ["@access-mcp/compute-resources"]
    }
  }
}
```

## Resources

- `accessci://compute-resources` - All compute resources
- `accessci://compute-resources/capabilities-matrix` - Resource comparison matrix
- `accessci://compute-resources/gpu-guide` - GPU selection guide
- `accessci://compute-resources/resource-types` - Resource type taxonomy
