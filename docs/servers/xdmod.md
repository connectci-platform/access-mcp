# XDMoD MCP Server

MCP server for public XDMoD data: charts, visualizations, metadata discovery, and dimension values from the XDMoD (XD Metrics on Demand) Usage Analytics API.

## Usage Examples

### Charts & Visualizations
```
"CPU hours chart for January 2024 (PNG)"
"Job count data for last 30 days"
"GPU usage SVG chart grouped by resource"
"Average wait time visualization for Q1 2024"
```

### Portal Links
```
"XDMoD portal link for CPU hours chart"
"Interactive GPU usage view in portal"
"Job count chart link for Bridges-2"
```

## Tools

### `get_chart_data`

Get chart data and metadata for a specific statistic.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `realm` | string | The realm (e.g., "Jobs") |
| `group_by` | string | The group by field (e.g., "none") |
| `statistic` | string | The statistic name (e.g., "total_cpu_hours") |
| `start_date` | string | Start date (YYYY-MM-DD) |
| `end_date` | string | End date (YYYY-MM-DD) |
| `dataset_type` | string | Dataset type (default: "timeseries") |

### `get_chart_image`

Get chart image (SVG, PNG, or PDF) for a specific statistic.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `realm` | string | The realm (e.g., "Jobs") |
| `group_by` | string | The group by field (e.g., "none") |
| `statistic` | string | The statistic name (e.g., "total_cpu_hours") |
| `start_date` | string | Start date (YYYY-MM-DD) |
| `end_date` | string | End date (YYYY-MM-DD) |
| `format` | string | Image format: "svg", "png", or "pdf" (default: "svg") |
| `width` | number | Image width in pixels (default: 916) |
| `height` | number | Image height in pixels (default: 484) |
| `dataset_type` | string | Dataset type (default: "timeseries") |

### `get_chart_link`

Generate a direct link to view the chart in the XDMoD portal.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `realm` | string | The realm (e.g., "Jobs", "SUPREMM") |
| `group_by` | string | The group by field (e.g., "none", "resource") |
| `statistic` | string | The statistic name (e.g., "total_cpu_hours", "gpu_time") |

## Understanding Realms

XDMoD organizes metrics into different realms:

### Jobs Realm
Basic job accounting and resource usage metrics:
- `total_cpu_hours` - Total CPU Hours
- `job_count` - Number of Jobs Ended
- `avg_cpu_hours` - Average CPU Hours per Job
- `total_waitduration_hours` - Total Wait Duration Hours
- `avg_waitduration_hours` - Average Wait Duration Hours
- `max_processors` - Maximum Processor Count
- `total_ace` - ACCESS Credit Equivalents Charged
- `utilization` - ACCESS CPU Utilization

### SUPREMM Realm
Detailed performance analytics and system metrics:
- `gpu_time` - GPU Hours: Total
- `avg_percent_gpu_usage` - Avg GPU usage
- `wall_time` - CPU Hours: Total
- `cpu_time_user` - CPU Hours: User: Total
- `avg_percent_cpu_user` - Avg CPU %: User
- `avg_flops_per_core` - Avg FLOPS: Per Core
- `avg_memory_per_core` - Avg Memory: Per Core
- `avg_ib_rx_bytes` - Avg InfiniBand rate: Per Node

**Note:** For GPU metrics, always use the SUPREMM realm.

## Installation

```bash
npm install -g @access-mcp/xdmod
```

## Configuration

```json
{
  "mcpServers": {
    "xdmod": {
      "command": "npx",
      "args": ["@access-mcp/xdmod"]
    }
  }
}
```

No authentication required - the server accesses publicly available system-wide metrics data.

---

**Package:** `@access-mcp/xdmod`
**Version:** v0.9.0
**Main:** `dist/index.js`
