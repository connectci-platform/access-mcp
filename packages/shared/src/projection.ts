// Pillar 2 — fields projection.
// See docs/2026-05-12-tool-catalog-architecture.md §Pillar 2.
//
// Path syntax (dotted with [] for arrays):
//   "total"                         → top-level scalar
//   "items"                         → items array as-is
//   "items[]"                       → same as "items" (decorative bracket)
//   "items[].name"                  → each items element projected to { name }
//   "metadata.pagination.has_more"  → nested scalar
//   "metadata.aggregations"         → whole aggregations subtree
//
// Rules (per pre-decisions 2026-05-13):
//   - fields undefined/null      → return response unchanged (no projection)
//   - fields empty array []      → only `total` is preserved (if present)
//   - missing fields             → silently omitted (no error, no null padding)
//   - `total` always preserved   → unconditionally re-added at root when present
//   - paths union                → multiple paths merge; ending at a node = include whole subtree
//   - non-mentioned `items`      → dropped from output (no empty-array placeholder)
//
// Projection runs server-side between envelope-shaping and serialization. Saves
// MCP→agent bytes and LLM tokens, not upstream API bandwidth.

interface WantedNode {
  includeWhole: boolean;
  children: Map<string, WantedNode>;
}

function makeNode(): WantedNode {
  return { includeWhole: false, children: new Map() };
}

interface Segment {
  name: string;
}

function parsePath(path: string): Segment[] {
  // "items[].name" → ["items[]", "name"] → [{name:"items"}, {name:"name"}]
  // "metadata.aggregations" → [{name:"metadata"}, {name:"aggregations"}]
  // The "[]" suffix is decorative — the parser just strips it. Array descent
  // is decided at runtime by the actual value's type.
  return path
    .split(".")
    .map((raw) => raw.trim())
    .filter((s) => s.length > 0)
    .map((seg) => ({ name: seg.endsWith("[]") ? seg.slice(0, -2) : seg }));
}

function buildWantedTree(paths: string[]): WantedNode {
  const root = makeNode();
  for (const path of paths) {
    const segments = parsePath(path);
    if (segments.length === 0) continue;
    let node = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      let child = node.children.get(seg.name);
      if (!child) {
        child = makeNode();
        node.children.set(seg.name, child);
      }
      if (i === segments.length - 1) {
        // Terminal segment: include the whole subtree rooted here.
        child.includeWhole = true;
      }
      node = child;
    }
  }
  return root;
}

function projectValue(value: unknown, node: WantedNode): unknown {
  // includeWhole short-circuits — caller wants this subtree as-is.
  if (node.includeWhole) return value;

  // Arrays: descend into each element with the same node (the [] in the path
  // is decorative — we always traverse arrays transparently).
  if (Array.isArray(value)) {
    return value.map((elem) => projectValue(elem, node));
  }

  // Plain object: pick the keys named in node.children.
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childName, childNode] of node.children) {
      if (Object.prototype.hasOwnProperty.call(value, childName)) {
        const projected = projectValue(
          (value as Record<string, unknown>)[childName],
          childNode,
        );
        // Silently drop unresolved branches (projected may be {} if children
        // miss; that's intentional — keeps the structural shape).
        if (projected !== undefined) {
          result[childName] = projected;
        }
      }
    }
    return result;
  }

  // Scalar / null with children still pending: nothing to project into.
  return undefined;
}

export function projectFields<T extends Record<string, unknown>>(
  response: T,
  fields: string[] | undefined | null,
): T {
  if (fields === undefined || fields === null) {
    return response;
  }

  const paths = [...fields];
  // Sticky structural fields — always preserve top-level metadata/documentation
  // containers when present, even if the caller didn't list them. Otherwise
  // a caller requesting items[].title silently loses pagination.has_more,
  // documentation.links.see_all_url, and the query_relevance signal —
  // structural metadata the agent's prompt is explicitly told to consult.
  // Individual sub-paths are still honored (e.g. metadata.pagination[].limit
  // wins over the bare "metadata" preservation).
  let metadataAddedWhole = false;
  for (const sticky of ["total", "metadata", "documentation"]) {
    if (
      Object.prototype.hasOwnProperty.call(response, sticky) &&
      !paths.some((p) => p === sticky || p.startsWith(`${sticky}.`) || p.startsWith(`${sticky}[`))
    ) {
      paths.push(sticky);
      if (sticky === "metadata") metadataAddedWhole = true;
    }
  }

  // Sticky-within-metadata for filters_applied (disclosure contract, Phase 4b).
  // When the caller narrows into a metadata.* subpath (so the whole-container
  // stickiness above did NOT fire), filters_applied would otherwise be
  // silently dropped — it isn't discoverable from the fields schema, so a
  // caller has no way to know to ask for it explicitly. Rescue only
  // filters_applied here; the rest of metadata still honors the caller's
  // subpath projection.
  if (
    !metadataAddedWhole &&
    typeof (response as Record<string, unknown>).metadata === "object" &&
    (response as Record<string, unknown>).metadata !== null &&
    Object.prototype.hasOwnProperty.call(
      (response as Record<string, unknown>).metadata as object,
      "filters_applied",
    ) &&
    !paths.some((p) => p === "metadata" || p === "metadata.filters_applied")
  ) {
    paths.push("metadata.filters_applied");
  }

  const root = buildWantedTree(paths);
  const projected = projectValue(response, root);

  // projectValue returns an object when given an object; the cast is safe
  // because the root is always an envelope object.
  return (projected ?? {}) as T;
}
