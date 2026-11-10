# Compute Resources MCP Server

MCP server for ACCESS resources, read from the curated per-resource documentation at
https://support.access-ci.org/documentation/resources through its Resource Documentation
API. Responses are cached for 10 minutes, since the site limits regular traffic to 300
requests per 10 minutes.

## Usage Examples

### Discovery & Search
```
"Which resources have H100s?"
"I need GPUs with at least 80 GB each and a terabyte of node memory"
"Where can I run a seven-day job?"
"Which resources host the AlphaFold databases?"
"Storage I can reach with Globus"
"Resources at NCSA with Open OnDemand"
```

### Recommendations
```
"Recommend a resource for machine learning with GPUs"
"What system should I use for molecular dynamics?"
"Best resource for a beginner doing genomics analysis"
```

## Tools

### `search_resources`

Find resources by what their documentation says. With no filters it lists every documented
resource. Each item has its global resource ID (`null` for resources outside CiDeR, such as
Fabric and Sage), group, accelerator models, largest node memory, most cores per node,
longest wall time, OnDemand URL, transfer methods and `citation_url`.

Hardware filters are checked per queue, and a resource matches only when one queue meets
all of them at once. `matching_queues` names those queues with a one-line summary of
their hardware, so an answer can cite the partition rather than combine figures from
different ones. Any accelerator counts for `has_gpu`, including Habana Gaudi and NEC
Vector Engines.

The documentation doesn't cover every field for every resource. A resource that can't be
checked against a filter is listed in `unchecked` with the filters it couldn't be
checked against, rather than treated as not matching. A resource whose page couldn't be
read is listed in `unavailable` instead, including for a query its name doesn't match. Storage systems are left out of hardware
searches. A system whose description mentions an accelerator its queues don't list,
such as Neocortex's Cerebras engines, counts as unknown for `has_gpu`.

Only documented resources are searched. A query that matches none of them, such as
Rockfish, which has left ACCESS, gets a `hint` saying the resource may be undocumented or
no longer part of ACCESS, so the answer points to the provider rather than guessing.

Query words, and the text filters, match whole words or the start of a word, so `AI`
doesn't match "available" and `L4` doesn't match L40S. "Bridges 2" and "Stampede 3"
match Bridges-2 and Stampede3, and a plural such as "H100s" matches H100. Words such as
"cluster", "resources" and "which" are ignored, and a query made only of them filters
nothing. When nothing matches, `hint` says why.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Words that must all appear in the name, group, organization, description, CPU or GPU models, datasets or top software |
| `type` | string | `Compute` or `Storage` |
| `organization` | string | Organization name or abbreviation (`NCSA`, `PSC`, `SDSC`, `TACC`, `IU`, `TAMU`…), or a center's university, such as `University of Illinois` for NCSA or `Carnegie Mellon` for PSC |
| `status` | string | `production`, `pre-production` or `post-production` |
| `has_gpu` | boolean | `true`: a queue has an accelerator. `false`: queues are documented and none has one |
| `gpu_type` | string | Accelerator model text, such as `H100` or `Gaudi` (per queue) |
| `min_gpu_memory_gb` | number | Minimum memory per GPU (per queue) |
| `min_memory_gb` | number | Minimum RAM per node (per queue) |
| `min_cores_per_node` | number | Minimum CPU cores per node (per queue) |
| `cpu_type` | string | CPU model text, such as `EPYC` or `Grace` (per queue) |
| `min_wall_time_hours` | number | Minimum job length a queue allows (per queue) |
| `dataset` | string | Hosted dataset name, such as `AlphaFold` |
| `ondemand` | boolean | `true` keeps resources with a documented Open OnDemand portal |
| `transfer_method` | string | File transfer method, such as `Globus` or `rsync` |
| `fields` | string[] | Limit the response to these fields, such as `items[].id` |

**Examples:**
```javascript
// List all documented resources
search_resources({})

// H100 queues with 80 GB per GPU
search_resources({ gpu_type: "H100", min_gpu_memory_gb: 80 })

// Large-memory CPU nodes with long jobs
search_resources({ has_gpu: false, min_memory_gb: 1000, min_wall_time_hours: 96 })
```

### `get_resource`

Get a resource's documented login, file transfer, storage, queue, dataset, software and
support details.

`citation_url` is the page to cite. A value is `null` when the documentation doesn't
cover it, which doesn't mean the resource lacks it, since resources range from batch
clusters to VMs, containers, storage and networks. A name that covers several resources,
such as `Delta`, returns `matches` to choose from. `details_available` is `false` when
only the listing could be read. `wait_times` is `null` unless the API reports the last
date it has wait data for, and a queue's `average_wait_hours` is `null` when that
queue's data is missing.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `resource` | string | Resource name or global resource ID (required) |
| `fields` | string[] | Limit the response to these fields, such as `queues[].name` |

**Example:**
```javascript
get_resource({ resource: "Delta GPU", fields: ["name", "citation_url", "queues"] })
```

### `compare_resources`

Compare two or three resources from the same documentation: access requirements, login,
transfer methods, queues, wait times, storage and software links. `unresolved` lists any name that
didn't settle on one resource.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `resources` | string[] | Two or three resource names or global resource IDs (required) |

**Example:**
```javascript
compare_resources({ resources: ["ACES", "Delta GPU", "Stampede3"] })
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

- `accessci://compute-resources` - Overview of the tools
- `accessci://compute-resources/capabilities-matrix` - Resource comparison matrix
- `accessci://compute-resources/gpu-guide` - GPU selection guide
- `accessci://compute-resources/resource-types` - Resource type taxonomy
