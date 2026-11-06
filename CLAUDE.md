# ACCESS-CI MCP Servers - AI Assistant Guide

This document helps AI assistants understand the project architecture, patterns, and conventions for effective development.

## Project Overview

**What this is:** A collection of Model Context Protocol (MCP) servers that provide AI assistants with access to ACCESS-CI cyberinfrastructure APIs.

**Architecture:** TypeScript monorepo using npm workspaces, with shared base classes and consistent patterns across all servers.

## Key Architecture Patterns

### BaseAccessServer Pattern

All MCP servers extend `BaseAccessServer` from `@access-mcp/shared`:

```typescript
export class EventsServer extends BaseAccessServer {
  constructor() {
    super("access-mcp-events", "0.1.0", "https://support.access-ci.org");
  }
  
  // Override httpClient for custom timeouts/config
  protected get httpClient(): AxiosInstance {
    if (!this._customHttpClient) {
      this._customHttpClient = axios.create({
        baseURL: this.baseURL,
        timeout: 10000,
        headers: { /* custom headers */ },
        validateStatus: () => true,
      });
    }
    return this._customHttpClient;
  }
}
```

### URL Building Pattern

Servers implement a `buildXxxUrl()` method for constructing API URLs with filters:

```typescript
private buildEventsUrl(filters: EventsFilters): string {
  const params = new URLSearchParams();
  
  // Date filters
  if (filters.beginning_date_relative) {
    params.append("beginning_date_relative", filters.beginning_date_relative);
  }
  
  // Faceted filters (ACCESS-CI API pattern)
  const facetedFilters = [];
  if (filters.event_type) {
    facetedFilters.push(`custom_event_type:${filters.event_type}`);
  }
  
  // Add faceted filters as f[0], f[1], etc.
  facetedFilters.forEach((filter, index) => {
    params.append(`f[${index}]`, filter);
  });
  
  return `/api/2.0/events?${params.toString()}`;
}
```

### Tool Implementation Pattern

Each server implements 3-5 core tools following this pattern:

```typescript
async get_events(args: EventsFilters): Promise<any> {
  const url = this.buildEventsUrl(args);
  const response = await this.httpClient.get(url);
  
  if (response.status !== 200) {
    throw new Error(`API Error ${response.status}: ${response.statusText}`);
  }
  
  const events = this.enhanceEvents(response.data);
  return {
    total_events: events.length,
    events: args.limit ? events.slice(0, args.limit) : events,
    popular_tags: this.getPopularTags(events),
    // ... other metadata
  };
}
```

### Tool markers

Every tool in `getTools()` declares `mutates: true` or `mutates: false`, and
`access: "public"` only when anonymous callers may use it. Type the list as
`ToolWithAccess[]` so the compiler catches a missing marker. `start()` refuses
to run with one missing, and `tests/tool-markers.test.ts` checks every server
in CI. Clients receive `mutates` as MCP's `annotations.readOnlyHint`; the ACCESS
agent uses it to refuse change-making tools to callers who can't make changes.
A new write tool also goes in that test's `WRITE_TOOLS` and the agent's
`WRITE_MCP_TOOL_NAMES`.

### Data Enhancement Pattern

Raw API data is enhanced with calculated fields:

```typescript
private enhanceEvents(rawEvents: any[]): EnhancedEvent[] {
  return rawEvents.map(event => ({
    ...event,
    // Parse comma-separated tags
    tags: event.custom_event_tags 
      ? event.custom_event_tags.split(',').map((t: string) => t.trim())
      : [],
    // Calculate duration
    duration_hours: event.date_1 
      ? Math.round((new Date(event.date_1).getTime() - new Date(event.date).getTime()) / (1000 * 60 * 60))
      : 0,
    // Time until event starts
    starts_in_hours: Math.round((new Date(event.date).getTime() - Date.now()) / (1000 * 60 * 60)),
  }));
}
```

## Package Structure

```
packages/
├── shared/              # Base classes, types, utilities
├── events/              # Events API server (workshops, training)
├── compute-resources/   # Hardware/resource information
├── system-status/       # Outages, maintenance
├── software-discovery/  # Software packages
├── xdmod-metrics/       # Usage analytics, NSF data
├── allocations/         # Research project allocations with NSF integration
└── affinity-groups/     # Community groups, knowledge base
```

### Package Dependencies

**Production Dependencies:**
- `@access-mcp/shared`: `^0.5.0` - Shared base classes, types, and utilities
- `@modelcontextprotocol/sdk`: MCP protocol implementation
- `axios`: HTTP client for API requests
- Additional dependencies vary by server (e.g., `express` for allocations)

**Development Dependencies:**
- `typescript`: TypeScript compiler
- `vitest`: Test framework
- `@types/node`: Node.js type definitions

**Important:** All published packages use version references (e.g., `^0.5.0`) to `@access-mcp/shared`. The `file:../shared` pattern should **never** appear in published packages, only in local development workspaces if needed.

## Testing Patterns

### Unit Tests Structure

```typescript
describe("ServerName", () => {
  let server: ServerName;
  let mockHttpClient: any;

  beforeEach(() => {
    server = new ServerName();
    mockHttpClient = { get: vi.fn() };
    Object.defineProperty(server, "httpClient", {
      get: () => mockHttpClient,
      configurable: true,
    });
  });

  describe("Tool Methods", () => {
    it("should handle basic requests", async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: mockData,
      });

      const result = await server["handleToolCall"]({
        params: { name: "get_items", arguments: {} },
      });

      expect(mockHttpClient.get).toHaveBeenCalled();
      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.total_items).toBe(2);
    });
  });
});
```

### Integration Tests

Integration tests make real API calls with 10-second timeouts:

```typescript
describe("Server Integration Tests", () => {
  it("should fetch real data from API", async () => {
    const result = await server["handleToolCall"]({
      params: {
        name: "get_items",
        arguments: { limit: 5 },
      },
    });
    
    const responseData = JSON.parse(result.content[0].text);
    expect(responseData).toHaveProperty("total_items");
  }, 10000); // 10 second timeout
});
```

### Test Commands

- `npm test` - Unit tests only (excludes integration)
- `npm run test:integration` - Integration tests only  
- `npm run test:all` - All tests
- `npm run test:watch` - Watch mode
- `npm run test:coverage` - Coverage report

## Development Workflow

### Adding New Servers

1. **Create package structure:**
   ```bash
   mkdir packages/new-server
   cd packages/new-server
   npm init -y
   ```

2. **Set up package.json:**
   ```json
   {
     "name": "@access-mcp/new-server",
     "version": "0.1.0",
     "type": "module",
     "main": "dist/index.js",
     "bin": { "access-mcp-new-server": "dist/index.js" },
     "dependencies": {
       "@access-mcp/shared": "^0.5.0",
       "@modelcontextprotocol/sdk": "^1.16.0",
       "axios": "^1.7.0"
     }
   }
   ```

   **Important:** Use version references (e.g., `^0.5.0`) for the shared package, NOT `file:../shared`. This ensures:
   - npm users get automatic dependency resolution
   - Published packages work correctly
   - No manual installation of shared package required
   - Local development still works via npm workspaces

3. **Create TypeScript config:**
   ```json
   {
     "extends": "../../tsconfig.json",
     "compilerOptions": {
       "outDir": "dist",
       "rootDir": "src"
     },
     "include": ["src/**/*"],
     "exclude": ["src/**/*.test.ts"],
     "references": [{ "path": "../shared" }]
   }
   ```

4. **Implement server class:**
   - Extend `BaseAccessServer`
   - Implement tool methods
   - Add resource handlers if needed
   - Follow URL building patterns

5. **Add to build system:**
   - Update root `package.json` build script
   - Add to documentation
   - Create comprehensive tests

### Documentation Updates

**CRITICAL**: The VitePress documentation is generated from package READMEs, not from docs/ files directly.

**To update documentation:**
1. **First update the package README** - `packages/server-name/README.md`
2. **Then regenerate docs** - `npm run docs:generate`
3. **Never edit docs/servers/*.md directly** - they will be overwritten

When adding servers, update:
- `packages/server-name/README.md` - Main documentation source
- `docs/getting-started.md` - Update installation commands  
- `docs/index.md` - Add to features list
- `README.md` - Update overview and structure

## ACCESS-CI API Patterns

### Common Filter Types

1. **Date Filters:**
   - `beginning_date_relative: "today" | "-1week" | "+1month"`
   - `end_date_relative: "+1week" | "+1month"`
   - `beginning_date: "2024-01-01"`
   - `end_date: "2024-12-31"`

2. **Faceted Filters (f[0], f[1], etc.):**
   - `custom_event_type:workshop`
   - `skill_level:beginner`
   - `custom_event_tags:python`

3. **Standard Filters:**
   - `limit: number`
   - Search queries in title/description

### Response Enhancement

Always enhance raw API responses:
- Parse comma-separated tags into arrays
- Calculate time-based fields (duration, starts_in_hours)
- Extract popular/common values
- Add metadata (total counts, types, etc.)

## Build & Deployment

### Local Development
```bash
npm run build        # Build all packages
npm run dev         # Watch mode
npm test            # Run test suite
npm run docs:dev    # Local documentation server
```

### Publishing Process
```bash
npm run build                    # Build all packages
node scripts/publish-packages.js # Publish to npm
git tag @access-mcp/server@x.x.x # Tag releases
git push origin --tags          # Push tags
```

### Documentation Deployment

Documentation auto-deploys to https://access-mcp.netlify.app from GitHub pushes.

## Important Conventions

1. **Use version references for shared package** - All packages should depend on `@access-mcp/shared` using version references like `^0.5.0`, never `file:../shared`. This ensures proper dependency resolution for npm users.
2. **Include integration tests** - Real API calls validate functionality
3. **Follow enhancement patterns** - Transform raw data into useful structures
4. **Comprehensive error handling** - Handle API errors gracefully
5. **Consistent tool naming** - `get_items`, `search_items`, `get_items_by_tag`
6. **Resource URIs** - Use `accessci://` scheme: `accessci://events/upcoming`
7. **Dependency management** - npm workspaces handle local development; published packages use semver ranges

## Key Files Reference

- `packages/shared/src/base-server.ts` - Base server implementation
- `packages/shared/src/types.ts` - Shared type definitions
- `scripts/build-all.js` - Build automation
- `scripts/publish-packages.js` - Publishing automation
- `vitest.config.ts` - Test configuration
- `docs/.vitepress/config.ts` - Documentation configuration

## Allocations Server - Advanced Features

The `@access-mcp/allocations` server provides sophisticated research project discovery and funding analysis capabilities with enterprise-grade search and NSF integration.

### Core Capabilities

**Advanced Search Features:**
- Boolean operators: `"machine learning" AND gpu NOT tensorflow`
- Exact phrases: `"quantum computing"`
- Date range filtering: `date_range: {start_date: "2024-01-01", end_date: "2024-12-31"}`
- Allocation thresholds: `min_allocation: 100000`
- Multiple sorting: `sort_by: "allocation_desc" | "date_desc" | "relevance"`

**NSF Integration & Cross-Referencing:**
- Real-time PI name matching with multiple format variations
- Institution name normalization ("MIT" ↔ "Massachusetts Institute of Technology")
- Temporal alignment analysis (NSF award periods vs ACCESS project timelines)
- Funding correlation insights and collaboration discovery

**Similarity Analysis:**
- Semantic project matching with configurable thresholds (0.0-1.0)
- Multi-factor similarity scoring (field, text, resources, context)
- Resource-based correlation (GPU projects ↔ AI research)
- Collaboration potential assessment

### Key Implementation Patterns

**Institution Name Handling:**
```typescript
// Generate comprehensive institution variants
const variants = this.getInstitutionVariants(this.normalizeInstitutionName(name));
// Handles: "CU Boulder" ↔ "University of Colorado Boulder" ↔ "University of Colorado at Boulder"

// Multi-tier matching with false positive prevention
private matchesInstitution(projectInstitution: string, searchVariants: string[]): boolean {
  // 1. Exact match (highest confidence)
  // 2. Partial match with length validation  
  // 3. Semantic word overlap (50% threshold)
}
```

**Advanced Search Architecture:**
```typescript
// Parse complex queries with operators
private parseAdvancedQuery(query: string): {
  andTerms: string[];     // Terms that MUST be present
  orTerms: string[];      // Terms that CAN be present  
  notTerms: string[];     // Terms that MUST NOT be present
  exactPhrases: string[]; // Quoted exact matches
  regularTerms: string[]; // Standard search terms
}

// Multi-criteria scoring
private calculateAdvancedSearchScore(
  project: Project, 
  searchTerms: ParsedQuery,
  fieldOfScience?: string, 
  allocationType?: string
): number {
  // Weighted scoring: title(3x), PI(2x), field(1.5x), abstract(1x)
  // Bonus for exact matches and term clusters
}
```

**NSF Cross-Referencing:**
```typescript
// Generate PI name variations for robust matching
private generatePINameVariations(piName: string): string[] {
  // "John Smith" → ["John Smith", "Smith, John", "J. Smith", "Smith, J.", etc.]
}

// Validate institution alignment
private validateInstitutionMatch(nsfAward: string, accessInstitution: string): boolean {
  // Cross-check institution names between ACCESS and NSF systems
  // Handle institution changes, abbreviations, and format differences  
}

// Temporal alignment analysis
private analyzeTemporalAlignment(nsfAwards: string[], accessStart: string, accessEnd: string): string {
  // Check if NSF funding periods overlap with ACCESS project dates
  // Generate insights about funding continuity and resource optimization
}
```

### Performance & Caching

**Intelligent Caching System:**
- 5-minute TTL for API responses with automatic cleanup
- Parallel page fetching (up to 5 concurrent requests)  
- Rate limiting for NSF server communication

**Data Processing:**
- Batch processing for statistics generation
- Concurrent NSF cross-referencing with respectful delays
- Memory-efficient project filtering and scoring

### Error Handling & Validation

**Comprehensive Input Validation:**
- Parameter bounds checking (limits, thresholds, dates)
- Query parsing with helpful error messages
- Graceful degradation when services unavailable

**Robust Error Recovery:**
- NSF server timeouts handled gracefully
- Partial results returned when some operations fail
- Clear user feedback about service limitations

This server demonstrates advanced MCP patterns for complex data integration, sophisticated search capabilities, and enterprise-grade reliability.

## AI Assistant Parameter Usage Guide

### Allocations Server - Advanced Features

The allocations server includes sophisticated search capabilities that require proper parameter mapping:

#### Search Parameter Mapping

**When users request boolean searches:**
```typescript
// User: "Find machine learning projects with GPU but not TensorFlow"
await search_projects({
  query: '"machine learning" AND gpu NOT tensorflow',
  sort_by: "relevance",
  limit: 20
});
```

**When users request similarity searches:**
```typescript
// User: "Show similar projects with 80% similarity"
await find_similar_projects({
  project_id: 12345,
  similarity_threshold: 0.8,  // IMPORTANT: Convert percentage to decimal
  show_similarity_scores: true,
  include_same_field: true
});
```

#### Critical Parameter Conversions

- **Similarity percentages**: "80%" → `0.8`, "70%" → `0.7`, "50%" → `0.5`
- **Date ranges**: "from 2024" → `date_range: {start_date: "2024-01-01", end_date: "2024-12-31"}`
- **Sorting**: "largest allocation" → `sort_by: "allocation_desc"`
- **Field filtering**: "Computer Science projects" → `field_of_science: "Computer Science"`

#### Advanced Search Patterns

**Boolean Operators Recognition:**
- "AND" → `"term1 AND term2"`
- "OR" → `"term1 OR term2"`
- "NOT" → `"term1 NOT term2"`
- Exact phrases → `"exact phrase"`

**NSF Integration:**
- Always use `analyze_project_funding(project_id)` for funding analysis
- Use `institutional_funding_profile(institution_name)` for university profiles
- Include `find_funded_projects()` for cross-platform research discovery

This guide should help you understand and extend the ACCESS-CI MCP servers effectively. Each server follows these established patterns for consistency and maintainability.