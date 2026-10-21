# XDMoD MCP Data Server

A Python-based Model Context Protocol server for accessing XDMoD (XD Metrics on Demand) data using Python's data analytics capabilities for better data manipulation and user-specific queries. Features pandas integration, clean data structures, enhanced filtering, and framework integration with XDMoD's Python data analytics framework.

## Usage Examples

### **Personal Usage**

```
"CPU hours for ACCESS ID 'deems' (Jan-Jun 2025)"
"My computational usage trends (past 6 months)"
```

### **Data Extraction**

```
"GPU usage from SUPREMM realm (past month)"
"Job counts by field of science with timeseries"
"Raw data: institutions grouped, 2024, with progress tracking"
"Delta OR Bridges-2 jobs with >1000 cores"
```

### **Discovery (What's Available?)**

```
"List all available realms"
"What dimensions and metrics exist in Jobs realm?"
"What GPU resources can I filter by?"
"Show me available queue types"
```

### **Templates (Pre-configured Analysis)**

```
"List all analysis templates"
"Show me the queue analysis template"
"Get allocation efficiency template configuration"
```

## Tools

### `get_user_data`
Get user-specific usage data using Python's data manipulation capabilities with pandas integration.

**Parameters:**
- `access_id`: User's ACCESS ID (e.g., "deems")
- `start_date`: Start date (YYYY-MM-DD)
- `end_date`: End date (YYYY-MM-DD)
- `realm`: XDMoD realm (default: "Jobs")
- `statistic`: Statistic to retrieve (default: "total_cpu_hours")

### `get_raw_data`
Get raw data from XDMoD for detailed analysis with complex filtering and progress tracking.

**Parameters:**
- `realm`: XDMoD realm (Jobs, SUPREMM, Cloud, Storage, ResourceSpecifications)
- `dimension`: Dimension for grouping data (e.g., person, resource, institution, pi, none)
- `metric`: Metric to retrieve (e.g., total_cpu_hours, job_count, wall_hours)
- `start_date`: Start date (YYYY-MM-DD)
- `end_date`: End date (YYYY-MM-DD)
- `filters`: Complex filter combinations (e.g., `{'resource': ['Delta', 'Bridges-2'], 'pi': 'Smith'}`)
- `aggregation_unit`: Time aggregation (day, month, quarter, year, auto)
- `dataset_type`: Dataset type (aggregate or timeseries)
- `show_progress`: Show progress updates for large data retrievals

**Example:**
```
"Get raw CPU hours data grouped by resource for all Delta and Bridges-2 jobs in 2024"
"Extract timeseries data for GPU usage in SUPREMM realm with daily aggregation"
```

### `describe_fields`
Discover available fields and dimensions for a specific XDMoD realm with sample filter values.

**Parameters:**
- `realm`: XDMoD realm to describe (default: "Jobs")
- `include_metrics`: Include available metrics in response (default: true)
- `include_filter_values`: Include sample filter values for dimensions (default: false)

**Example:**
```
"What fields and metrics are available in the SUPREMM realm?"
"Show me all dimensions I can filter by in the Jobs realm with sample values"
```

### `describe_realms`
Discover all available XDMoD realms and their capabilities with dimension and metric counts.

**Parameters:**
- `include_details`: Include detailed information about each realm (default: true)

**Example:**
```
"What XDMoD realms are available for querying?"
"List all data realms with their dimension and metric counts"
```

### `get_smart_filters`
**Discover available filter values** - Find what resources, queues, institutions, etc. you can filter by in `get_raw_data()`. Returns categorized lists of filter values (e.g., "GPU resources", "batch queues", "physical sciences").

**When to use:** Before calling `get_raw_data()`, use this to discover what filter values are available.

**Parameters:**
- `realm`: XDMoD realm to query (default: "Jobs")
- `dimension`: Dimension to get filters for (resource, queue, person, fieldofscience, institution, etc.)
- `category`: Filter category (gpu, cpu, memory, storage, physical, life, engineering, all)
- `search_prefix`: Filter values by prefix for autocomplete-style searching (e.g., 'univ' for universities)
- `force_large_dimensions`: Override size limits for large dimensions (>1000 values)
- `limit`: Max items to display per category (default: 20)

**Example:**
```
"What GPU resources can I filter by?"
"Show me available queue types"
"Find institutions starting with 'california'"
"What science field categories exist?"
```

**Workflow:** get_smart_filters() → get_raw_data() with discovered filter values

### `get_analysis_template`
**Get pre-configured analysis patterns** - Returns ready-to-use configurations for common analysis scenarios (queue analysis, allocation efficiency, etc.) with pre-defined metrics and semantic filters.

**When to use:** When you want a standardized analysis pattern instead of building a custom query.

**Parameters:**
- `analysis_type`: Template name (queue_analysis, allocation_efficiency, performance_efficiency, etc.)
- `list_templates`: Set to true to list all 14 available templates (default: false)

**Example:**
```
"List all analysis templates"
"Get the queue analysis template"
"Show me allocation efficiency template configuration"
```

**Workflow:** get_analysis_template() → Use returned configuration with get_raw_data()


## Installation

**For Claude Desktop (Recommended):**
```bash
# Install pipx if you don't have it
brew install pipx

# Install from local development copy
cd /path/to/access_mcp/packages/xdmod-data
pipx install .

# Or install from GitHub (when published)
pipx install git+https://github.com/necyberteam/access-mcp.git#subdirectory=packages/xdmod-data
```

**For Development:**
```bash
cd /path/to/access_mcp/packages/xdmod-data
python3 -m venv venv
source venv/bin/activate
pip install -e .
pip install xdmod-data  # Install official XDMoD Python framework
```

**Note:** This MCP server requires the official `xdmod-data` package for full functionality. The pipx installation method will automatically install it in an isolated environment.

## Configuration

Add to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "xdmod-mcp-data": {
      "command": "xdmod-mcp-data",
      "env": {
        "XDMOD_API_TOKEN": "your-xdmod-token-here",
        "ACCESS_MCP_SERVICES": "nsf-awards=http://localhost:3007"
      }
    }
  }
}
```

**Note:** After installing with pipx, restart Claude Desktop to detect the new command.

`XDMOD_CALL_TIMEOUT_SECONDS` (default `60`) caps how long any single XDMoD request may take. When XDMoD is down or unreachable, tools return an error after this long instead of hanging.

## Analysis Templates

The server provides 14 pre-configured analysis templates organized by operational value. Each template includes base configuration, dynamic semantic filters, multi-metric support, and context parameters for professional analysis.

**🔄 Maintenance-Free Design**: Templates use `get_smart_filters()` references for always-current filter values - no hardcoded values to maintain!

### 🚀 Operational Insights (System Administrators)

**Queue Analysis** - Critical for operational insights
- Monitor job queue performance and wait time patterns
- Identify bottlenecks and optimize scheduling
- Multi-metrics: wait duration, job count, average wait times
- Semantic filters: interactive_queues, batch_queues, gpu_queues, debug_queues

**Allocation Efficiency** - Important for resource management  
- Analyze resource allocation utilization and optimization opportunities
- Identify unused allocations and optimize distribution
- Multi-metrics: CPU hours, SU charged, job count, average usage
- Semantic filters: power_users, underutilized, overutilized allocations

**Performance Efficiency** - Computational throughput analysis
- Monitor job performance and computational efficiency 
- Identify performance optimization opportunities
- Multi-metrics: CPU hours, job count, wait duration, average performance
- Semantic filters: cpu_intensive, gpu_intensive, memory_intensive, io_intensive

**Multi Node Scaling** - Parallel efficiency metrics
- Analyze parallel job scaling and multi-node utilization patterns
- Understand scaling efficiency and parallel overhead
- Multi-metrics: CPU hours, job count, average processors, wait duration
- Semantic filters: single_node, small_parallel, large_parallel, massive_parallel

**Service Provider Comparison** - Performance benchmarking
- Compare performance across different ACCESS service providers
- Identify optimal allocation strategies
- Multi-metrics: CPU hours, job count, wait duration, SU charged
- Semantic filters: tacc, ncsa, psc, sdsc, iu providers

**Grant Type Analysis** - Funding source analysis
- Analyze computational resource usage by funding source
- Understand how different grant types drive usage
- Multi-metrics: CPU hours, SU charged, job count, unique users
- Semantic filters: research_grants, startup_grants, education_grants, industry_grants

### 👤 User Analysis (Individual Insights - Publicly Available Data)

*Note: ACCESS-CI XDMoD user data is publicly available through the XDMoD portal, making individual user analysis valuable for optimization consulting and training opportunities.*

**Individual User Productivity** - Optimization consulting opportunities
- Analyze user computational productivity patterns
- Identify users for optimization consulting
- Multi-metrics: CPU hours, job count, processors, job duration
- Semantic filters: power_users (>5M CPU hours), community_accounts, high_job_count

**User Efficiency Profiling** - Training opportunities (SUPREMM)
- Profile computational efficiency using performance metrics
- Identify users for optimization training
- Multi-metrics: CPU utilization, wall time, memory usage, job count, GPU time
- Semantic filters: highly_efficient (>90%), inefficient (<50%), gpu_users

**User Computing Behavior** - Scaling patterns and training
- Analyze user parallelism and computational scaling behavior
- Identify candidates for advanced HPC training
- Multi-metrics: processors, CPU hours, job count, max processors, duration
- Semantic filters: serial_computing, extreme_parallel (>8K cores), hpc_power_users

**User Activity Timeline** - Temporal engagement patterns
- Analyze user computational behavior over time
- Track engagement and predict system load
- Multi-metrics: CPU hours, job count, processors (weekly timeseries)
- Semantic filters: top_users, burst_users, steady_users, new_users

### 📊 Research Analysis (Scientific Insights)

**Field Trends** - Scientific domain usage over time
- Track computational usage trends by field of science
- Monthly timeseries for scientific domains
- Semantic filters: computer_science, life_sciences, physical_sciences

**Resource Usage** - System utilization comparison
- Compare usage patterns across computational resources
- Daily timeseries across major HPC systems
- Semantic filters: gpu_systems, cpu_systems, large_systems

**Job Size Analysis** - Resource utilization efficiency
- Understand job size distribution and efficiency
- Aggregate analysis by job size categories
- Semantic filters: small_jobs, medium_jobs, large_jobs

**GPU Usage** - Specialized GPU analysis (SUPREMM)
- Track GPU computational patterns and efficiency
- Daily GPU usage timeseries
- Semantic filters: gpu_resources, high_gpu_usage

### 📈 Basic Analysis

**Institutional Comparison** - Simple institutional comparisons
- Compare computational usage across institutions
- Basic aggregate analysis
- Semantic filters: top_institutions, california_unis, ivy_league

## Template Usage Examples

### Basic Template Usage
```bash
# List all available templates
"Show me all analysis templates"

# Get specific template configuration
"Get the queue analysis template"
"Show me the allocation efficiency template configuration"
```

### Dynamic Filter Integration
```bash
# Get live filter values for templates
"Get smart filters for GPU resources"  # For resource templates
"Show me current queue types"          # For queue analysis template
"Find computer science fields"         # For field trends template

# Use filters with raw data
"Get raw CPU hours data for GPU systems from smart filters"
"Extract queue wait time data for interactive queues"
```

### Complete Analysis Workflow
```bash
# Step 1: Get template configuration
"Get the performance efficiency template"

# Step 2: Get current filter values  
"Get smart filters for resources with category gpu"

# Step 3: Apply to raw data analysis
"Get raw data for GPU resources using performance efficiency metrics for 2024"

# Alternative: Direct template application
"Use the performance efficiency template to analyze GPU usage for the past quarter"
```

## Usage Examples

Once configured, you can ask Claude:

- "Debug my XDMoD data authentication"
- "Get my usage data using the data server for the last 6 months"
- "Test the XDMoD data analytics framework"

## Comparison with XDMoD Server (@access-mcp/xdmod)

The TypeScript `@access-mcp/xdmod` server handles **public data** (no auth):
- Charts, images, and portal links (`public_user=true`)
- Metadata discovery: `describe_realms`, `describe_fields`, `get_dimension_values`

This Python `xdmod-mcp-data` server handles **authenticated data**:
- Per-user usage queries via the XDMoD DataWarehouse library
- Complex filtered extractions with pandas
- NSF funding integration
- Analysis templates and smart filters

## Per-User Token Architecture (TODO)

The `XDMOD_API_TOKEN` is currently a **single static env var** — not per-user.

**Current limitations:**
- Personal data tools (`get_user_data`, `get_raw_data`) require a token from the XDMoD portal (My Profile > API Token)
- The static token acts as a service-level credential, not tied to any specific user
- Discovery tools (`describe_fields`, `describe_realms`) also require this token since they use the DataWarehouse library

**Future approach:**
1. Store per-user XDMoD API tokens in Drupal user profiles
2. Pass via the `X-Acting-User` header flow (already in place for JWT auth)
3. Have `xdmod-data` resolve the per-user token per request
4. Until then, `xdmod-data` only works with a static service-level token

## Development

```bash
# Install in development mode
pip install -e ".[dev]"

# Run tests
pytest

# Format code
black src/
```