# Filter Discovery & Template Design Best Practices

## The Core Problem

When designing filter discovery and templates for MCP tools, we face two critical challenges:

1. **Accuracy**: How do we ensure filter values are correct and current?
2. **Maintenance**: How do we keep templates relevant without constant manual updates?

## Best Practice: Dynamic Discovery (Preferred)

### ✅ Correct Pattern: Query the Source of Truth

**XDMoD Data Example** (line 1703):
```python
# DON'T: Hardcode filter values
gpu_resources = ["delta-gpu", "bridges2-gpu", "anvil-a100"]  # ❌ Becomes stale

# DO: Query the API dynamically
filter_df = dw.get_filter_values(realm, dimension)  # ✅ Always current
all_values = filter_df['label'].tolist()
```

**Key Principle**: Filter discovery should **query the upstream API**, not maintain its own list.

### Why Dynamic Discovery Works

1. **Always Current**: Reflects real-time state of the system
2. **Zero Maintenance**: No manual updates needed when resources change
3. **Single Source of Truth**: API is authoritative
4. **Handles Edge Cases**: Automatically includes new/removed items

## Implementation Patterns by Server Type

### Pattern 1: API Provides Discovery Endpoint

**When to use**: API has dedicated discovery/list endpoints

**Example: Allocations Server**
```typescript
async getAvailableFilters() {
  // CORRECT: Query the API
  const [projects, resources, fields] = await Promise.all([
    this.api.get('/projects'),  // Get actual project data
    this.api.get('/resources'), // Get real resources
    this.api.get('/fields')     // Get available fields
  ]);

  return {
    fields_of_science: [...new Set(projects.map(p => p.field_of_science))],
    resources: resources.map(r => r.resource_name),
    allocation_types: [...new Set(projects.map(p => p.allocation_type))]
  };
}
```

**INCORRECT Approach**:
```typescript
// ❌ DON'T DO THIS - hardcoded values become stale
const FIELDS_OF_SCIENCE = [
  "Computer Science",
  "Physics",
  "Chemistry"  // What if new field is added?
];
```

### Pattern 2: Derive from Search Results

**When to use**: No dedicated discovery endpoint, but search returns metadata

**Example: Software Discovery (already implemented)**
```typescript
// Scan actual results to discover available filters
async discover_filters(query: string) {
  const results = await this.searchAllSoftware(query);

  return {
    research_areas: [...new Set(results.map(r => r.ai_research_area))],
    tags: [...new Set(results.flatMap(r => r.ai_tags || []))],
    software_types: [...new Set(results.map(r => r.ai_software_type))],
    resources: [...new Set(results.map(r => r.resource_id))]
  };
}
```

### Pattern 3: Cross-Reference Other Services

**When to use**: Filter values come from related service

**Example: System Status (resource names)**
```typescript
async getInfrastructureNews() {
  // DON'T: Hardcode resource names
  // DO: Cross-reference compute-resources service

  if (invalidResourceName) {
    return {
      error: "Invalid resource",
      suggestion: "Use search_resources tool from compute-resources server to find valid resource IDs",
      cross_reference: {
        tool: "search_resources",
        server: "compute-resources"
      }
    };
  }
}
```

### Pattern 4: Small, Stable Enums (OK to Hardcode)

**When to use**: Values are stable and defined by spec/standard

**Examples that ARE OK to hardcode**:
```typescript
// ✅ These are stable and unlikely to change
event_types: ["Workshop", "Webinar", "Office Hours", "Training"]
skill_levels: ["Beginner", "Intermediate", "Advanced"]
time_ranges: ["This Week", "This Month", "This Quarter", "This Year"]
aggregation_units: ["Day", "Month", "Quarter", "Year"]
dataset_types: ["timeseries", "aggregate"]
```

**Rule of Thumb**:
- If it's defined by your system/spec: ✅ Can hardcode
- If it's data from external systems: ❌ Must query dynamically

## Template Design Best Practices

### Anti-Pattern: Hardcoded Data Templates

**❌ AVOID**:
```typescript
const TEMPLATES = {
  large_gpu_projects: {
    filters: {
      resource: ["delta-gpu", "bridges2-gpu"],  // ❌ Stale data
      min_allocation: 100000
    }
  }
};
```

**Problems**:
- Resources change (new GPUs added, old ones decommissioned)
- Allocation thresholds shift over time
- No way to know if template is still relevant

### Better Pattern: Query-Based Templates

**✅ CORRECT**:
```typescript
const TEMPLATES = {
  large_gpu_projects: {
    description: "Find major GPU computing projects",
    query_pattern: {
      resource_filter: "has_gpu=true",  // ✅ Dynamic filter
      sort_by: "allocation_desc",
      percentile: "top_10_percent"      // ✅ Relative, not absolute
    },
    // Template returns query config, not hardcoded data
    build: async (context) => ({
      has_gpu: true,
      min_allocation: await getPercentileThreshold(90),  // Dynamic
      sort_by: "allocation_desc"
    })
  }
};
```

### Template Design Principles

1. **Templates Configure Queries, Not Data**
   ```typescript
   // Good: Template is about HOW to query
   template: {
     dimension: "institution",
     metric: "total_cpu_hours",
     aggregation: "sum",
     sort: "desc"
   }

   // Bad: Template contains actual data
   template: {
     institutions: ["Illinois", "Purdue", "SDSC"]  // ❌
   }
   ```

2. **Use Relative, Not Absolute Values**
   ```typescript
   // Good: Relative threshold
   min_allocation: "top_10_percent"

   // Bad: Absolute threshold (becomes meaningless over time)
   min_allocation: 100000
   ```

3. **Document Template Intent**
   ```typescript
   template: {
     name: "emerging_research",
     description: "New projects in last 6 months",
     intent: "Discover recent research trends",  // Why it exists
     date_range: "last_6_months",  // Relative
     expected_use_case: "Quarterly research reviews"
   }
   ```

## Validation & Maintenance Strategies

### Strategy 1: Runtime Validation

Add checks to detect stale templates:

```typescript
async validateTemplate(template) {
  // Check if template query returns reasonable results
  const results = await executeTemplateQuery(template);

  if (results.length === 0) {
    console.warn(`Template '${template.name}' returned no results - may be outdated`);
  }

  // Check if referenced filters exist
  if (template.filters?.resource) {
    const validResources = await getValidResources();
    const invalid = template.filters.resource.filter(r => !validResources.includes(r));

    if (invalid.length > 0) {
      console.warn(`Template '${template.name}' references invalid resources: ${invalid}`);
    }
  }
}
```

### Strategy 2: Template Versioning

```typescript
const TEMPLATES = {
  institutional_comparison: {
    version: "2025-01",
    description: "Compare institutions",
    last_validated: "2025-01-14",
    query_config: { /* ... */ },
    deprecation_warning: null  // Set when template becomes outdated
  }
};
```

### Strategy 3: Self-Documenting Filters

```typescript
// Instead of returning raw values, return metadata
{
  dimension: "resource",
  values: [
    {
      id: "delta.ncsa.access-ci.org",
      label: "Delta (NCSA)",
      type: "gpu",
      status: "active",
      last_seen: "2025-01-14"  // When we saw this in the API
    }
  ],
  generated_at: "2025-01-14T10:30:00Z",
  source: "live_xdmod_api"
}
```

## Migration Guide: Fixing Hardcoded Filters

### Step 1: Identify Hardcoded Values

```bash
# Find potential hardcoded lists
grep -r "const.*=.*\[" src/
grep -r "FILTERS\s*=" src/
grep -r "TEMPLATES\s*=" src/
```

### Step 2: Determine Source of Truth

For each hardcoded list, ask:
- Where does this data actually come from?
- Is there an API endpoint that provides this?
- Does another service know these values?
- Is this a stable enum defined by spec?

### Step 3: Implement Dynamic Discovery

```typescript
// Before
const GPU_RESOURCES = ["delta-gpu", "bridges2-gpu"];

// After
async function getGPUResources() {
  const resources = await fetch('/api/resources?type=gpu');
  return resources.map(r => r.id);
}
```

### Step 4: Add Caching (Optional)

For expensive queries, add short-term caching:

```typescript
class FilterCache {
  private cache = new Map();
  private TTL = 5 * 60 * 1000; // 5 minutes

  async get(key: string, fetcher: () => Promise<any>) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.TTL) {
      return cached.value;
    }

    const value = await fetcher();
    this.cache.set(key, { value, timestamp: Date.now() });
    return value;
  }
}
```

## Testing Filter Discovery

### Test 1: Freshness

```typescript
test('filters reflect current API state', async () => {
  const filters = await getAvailableFilters();
  const apiData = await fetchFromAPI();

  // Ensure filter values match API
  expect(filters.resources).toEqual(apiData.resources.map(r => r.id));
});
```

### Test 2: Cross-Reference Consistency

```typescript
test('filters match related services', async () => {
  const systemStatusResources = await systemStatus.getResourceNames();
  const computeResources = await computeResources.getAllResourceIds();

  // They should reference the same resources
  expect(systemStatusResources).toMatchSnapshot(computeResources);
});
```

### Test 3: Template Validity

```typescript
test('templates return results', async () => {
  for (const template of Object.values(TEMPLATES)) {
    const results = await executeTemplate(template);
    expect(results.length).toBeGreaterThan(0);
  }
});
```

## Decision Matrix: When to Use Each Pattern

| Data Type | Pattern | Example | Maintenance |
|-----------|---------|---------|-------------|
| System resources | Dynamic API query | GPU resources, compute nodes | ✅ Zero |
| User data | Dynamic API query | Researchers, institutions | ✅ Zero |
| API response fields | Derive from results | AI tags, categories | ✅ Zero |
| Stable enums | Hardcode | Event types, skill levels | ⚠️ Review yearly |
| Cross-service refs | Query other service | Resource IDs, allocation IDs | ✅ Zero |
| Query templates | Config-based | Analysis patterns | ⚠️ Validate quarterly |

## Summary: Key Principles

1. **Query, Don't Store**: Always fetch from source of truth
2. **Relative, Not Absolute**: Use percentiles and time ranges
3. **Self-Documenting**: Include metadata about freshness
4. **Cross-Reference**: Point to authoritative services
5. **Test Validity**: Automated checks for stale data
6. **Cache Wisely**: Short TTL for expensive queries only
7. **Version Templates**: Track when they were last validated

---

**Key Insight**: The best filter discovery tool is one that **queries the live system** rather than maintaining its own list. This is what XDMoD Data does correctly.
