import type { DocumentedResource, Listing } from "./resource-documentation.js";

type Row = Record<string, unknown>;

export interface SearchFilters {
  query?: string;
  type?: string;
  organization?: string;
  status?: string;
  has_gpu?: boolean;
  gpu_type?: string;
  min_gpu_memory_gb?: number;
  min_memory_gb?: number;
  min_cores_per_node?: number;
  cpu_type?: string;
  min_wall_time_hours?: number;
  dataset?: string;
  ondemand?: boolean;
  transfer_method?: string;
}

export const FILTER_KEYS = [
  "query",
  "type",
  "organization",
  "status",
  "has_gpu",
  "gpu_type",
  "min_gpu_memory_gb",
  "min_memory_gb",
  "min_cores_per_node",
  "cpu_type",
  "min_wall_time_hours",
  "dataset",
  "ondemand",
  "transfer_method",
] as const satisfies readonly (keyof SearchFilters)[];

// A filter can pass, fail, or be impossible to check because the documentation
// doesn't cover the field. Unknown resources are reported, never counted as failing.
type Outcome = "match" | "miss" | "unknown";

const QUEUE_FILTERS = [
  "gpu_type",
  "min_gpu_memory_gb",
  "min_memory_gb",
  "min_cores_per_node",
  "cpu_type",
  "min_wall_time_hours",
] as const;

export const RESOURCE_TYPES = ["Compute", "Storage"];

export const ORG_ABBREVIATIONS: Record<string, string[]> = {
  NCSA: ["National Center for Supercomputing Applications"],
  SDSC: ["San Diego Supercomputer Center"],
  PSC: ["Pittsburgh Supercomputing Center"],
  TACC: ["Texas Advanced Computing Center"],
  NCAR: ["National Center for Atmospheric Research"],
  IU: ["Indiana University"],
  UK: ["University of Kentucky"],
  TAMU: ["Texas A&M University"],
  TTU: ["Texas Tech University"],
  OSG: ["OSG Consortium"],
  OSN: ["Open Storage Network"],
  UT: ["University of Texas", "Texas Advanced Computing Center"],
  SBU: ["Stony Brook"],
};

// People name the university or consortium a center belongs to, while the
// documentation lists the center. Each pattern matches the whole organization asked for.
const ORG_PARENTS: [RegExp, string][] = [
  [/^(the )?(university of illinois( urbana[- ]champaign)?|uiuc|illinois)$/, "National Center for Supercomputing Applications"],
  [/^(carnegie mellon( university)?|cmu|(the )?university of pittsburgh|pitt)$/, "Pittsburgh Supercomputing Center"],
  [/^(uc san diego|ucsd|(the )?university of california,? san diego)$/, "San Diego Supercomputer Center"],
  [/^(ut austin|(the )?university of texas( at austin)?)$/, "Texas Advanced Computing Center"],
  [/^(ucar|(the )?university corporation for atmospheric research)$/, "National Center for Atmospheric Research"],
  [/^(the )?national research platform$/, "NRP"],
];

// Words that describe what's being searched for rather than which resource.
const GENERIC_WORDS = new Set([
  "a", "an", "the", "and", "or", "with", "for", "on", "in", "of", "to", "that", "has", "have",
  "resource", "resources", "system", "systems", "cluster", "clusters", "machine", "machines",
  "node", "nodes", "computer", "computers", "supercomputer", "supercomputers", "hpc",
  // Question words, for when the user's sentence is passed as the query.
  "which", "what", "where", "who", "can", "could", "i", "me", "my", "we", "our", "is", "are",
  "any", "there", "does", "do", "show", "find", "list", "get", "tell", "about",
]);

const ACCELERATOR_WORDS = ["gpu", "gpus", "accelerator", "accelerators"];

const text = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u200b\s]+/g, " ").trim();
  return cleaned && cleaned.toLowerCase() !== "none" ? cleaned : null;
};

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Terms match at the start of a word, so "AI" doesn't match "available". Short terms
// must also end the word (allowing a plural), so "L4" doesn't match "L40S" and "A10"
// doesn't match "A100".
function wordMatch(haystack: string | null, term: string): boolean {
  const wanted = term.trim().toLowerCase();
  if (haystack === null || !wanted) return false;
  const end = wanted.length < 4 ? "(?:e?s)?(?![a-z0-9])" : "";
  return new RegExp(`(?<![a-z0-9])${escape(wanted)}${end}`).test(joinVersions(haystack.toLowerCase()));
}

// "Bridges-2" and "Bridges 2" both read as "bridges2", matching how "Stampede3" is written.
const joinVersions = (value: string) => value.replace(/([a-z])-(\d{1,2})(?![\d.a-z])/g, "$1$2");

// A long term also matches its singular, so "H100s" finds "H100".
const termMatches = (haystack: string | null, term: string) =>
  wordMatch(haystack, term) || (term.length > 4 && term.endsWith("s") && wordMatch(haystack, term.slice(0, -1)));

interface Gpu {
  type: string | null;
  count: number | null;
  vram: number | null;
}

// One kind of node, as one queue can use it. A node type no queue lists has no queue.
export interface Profile {
  queue: string | null;
  node_type: string | null;
  summary: string | null;
  max_wall_time_hours: number | null;
  cpu_type: string | null;
  cpu_count: number | null;
  ram: number | null;
  gpus: Gpu[];
  /** A queue that lists no node types: its hardware is unknown, not absent. */
  undocumented?: boolean;
}

const rowsOf = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

// A queue can document a GPU count with no model, as Expanse's ind-gpu does.
const legacyGpus = (row: Row): Gpu[] => {
  const type = num(row.gpu_count) === 0 ? null : text(row.gpu_type);
  return (num(row.gpu_count) ?? 0) > 0 || type !== null
    ? [{ type, count: num(row.gpu_count), vram: num(row.gpu_vram) }]
    : [];
};

const nodeTypeGpus = (nodeType: Row): Gpu[] =>
  rowsOf(nodeType.gpus)
    .map((gpu) => ({ type: text(gpu.type), count: num(gpu.count), vram: num(gpu.vram) }))
    .filter((gpu) => gpu.count !== 0 || gpu.type !== null);

/**
 * The hardware a resource documents, one profile per queue and node type. Without
 * node_types (the portal before it ships them) each legacy queue_specs row is one profile.
 */
export function hardwareProfiles(detail: Row | null): Profile[] {
  const nodeTypes = rowsOf(detail?.node_types);
  if (nodeTypes.length === 0) {
    return rowsOf(detail?.queue_specs).map((row) => ({
      queue: text(row.name),
      node_type: null,
      summary: text(row.summary),
      max_wall_time_hours: num(row.max_wall_time_hours),
      cpu_type: text(row.cpu_type),
      cpu_count: num(row.cpu_count),
      ram: num(row.ram),
      gpus: legacyGpus(row),
    }));
  }

  const hardware = (nodeType: Row) => ({
    node_type: text(nodeType.label),
    summary: text(nodeType.summary),
    cpu_type: text(nodeType.cpu_type),
    cpu_count: num(nodeType.cpu_count),
    ram: num(nodeType.ram),
    gpus: nodeTypeGpus(nodeType),
  });
  const byLabel = new Map(nodeTypes.map((nodeType) => [text(nodeType.label), nodeType]));
  const referenced = new Set<string | null>();
  const profiles: Profile[] = [];

  for (const queue of rowsOf(detail?.queues)) {
    const name = text(queue.name);
    const wall = num(queue.max_wall_time_hours);
    const nodes = rowsOf(queue.nodes);
    if (nodes.length === 0) {
      profiles.push({
        queue: name, node_type: null, summary: null, max_wall_time_hours: wall,
        cpu_type: null, cpu_count: null, ram: null, gpus: [], undocumented: true,
      });
    }
    for (const node of nodes) {
      const label = text(node.node_type);
      referenced.add(label);
      const nodeType = byLabel.get(label);
      profiles.push(
        nodeType
          ? { queue: name, max_wall_time_hours: wall, ...hardware(nodeType) }
          : {
              queue: name, node_type: label, summary: null, max_wall_time_hours: wall,
              cpu_type: null, cpu_count: null, ram: null, gpus: [], undocumented: true,
            }
      );
    }
  }
  // Hardware no queue lists, such as a cloud resource's, still answers a search.
  for (const nodeType of nodeTypes) {
    if (!referenced.has(text(nodeType.label))) {
      profiles.push({ queue: null, max_wall_time_hours: null, ...hardware(nodeType) });
    }
  }
  return profiles;
}

const hasAccelerator = (profile: Profile): boolean => profile.gpus.length > 0;

const atLeast = (value: number | null, min: number): Outcome =>
  value === null ? "unknown" : value >= min ? "match" : "miss";

const matches = (value: string | null, wanted: string): Outcome =>
  value === null ? "unknown" : wordMatch(value, wanted) ? "match" : "miss";

const htmlText = (value: unknown) =>
  typeof value === "string" ? value.replace(/<[^>]+>/g, " ") : null;

// Some accelerators aren't in the queue table, such as Neocortex's Cerebras engines,
// so a description that mentions one makes "no accelerator" unknowable.
// "GPU" alone is left out because CPU systems' descriptions often mention their
// sibling GPU systems.
const ACCELERATOR_MENTION = /(?<![a-z])(accelerators?|cerebras|wafer-scale|fpgas?)(?![a-z])/i;
const mentionsAccelerator = (detail: Row | null) =>
  ACCELERATOR_MENTION.test(htmlText(detail?.description) ?? "");

// A node has several GPU models at most, so the GPU filters hold if one model passes them all.
function gpuOutcome(profile: Profile, filters: SearchFilters): Outcome {
  if (profile.undocumented) return "unknown";
  if (!hasAccelerator(profile)) return "miss";
  const perGpu = profile.gpus.map((gpu) => {
    const checks: Outcome[] = [];
    if (filters.gpu_type) checks.push(matches(gpu.type, filters.gpu_type));
    if (filters.min_gpu_memory_gb !== undefined) checks.push(atLeast(gpu.vram, filters.min_gpu_memory_gb));
    return combine(checks);
  });
  if (perGpu.includes("match")) return "match";
  return perGpu.includes("unknown") ? "unknown" : "miss";
}

function profileOutcome(profile: Profile, filters: SearchFilters): Outcome {
  const checks: Outcome[] = [];
  if (filters.has_gpu === true) {
    checks.push(profile.undocumented ? "unknown" : hasAccelerator(profile) ? "match" : "miss");
  }
  if (filters.gpu_type || filters.min_gpu_memory_gb !== undefined) checks.push(gpuOutcome(profile, filters));
  const known = (outcome: Outcome): Outcome => (profile.undocumented ? "unknown" : outcome);
  if (filters.min_memory_gb !== undefined) checks.push(known(atLeast(profile.ram, filters.min_memory_gb)));
  if (filters.min_cores_per_node !== undefined) {
    checks.push(known(atLeast(profile.cpu_count, filters.min_cores_per_node)));
  }
  if (filters.cpu_type) checks.push(known(matches(profile.cpu_type, filters.cpu_type)));
  if (filters.min_wall_time_hours !== undefined) {
    // The API calls a null wall time "no limit", but an unfilled field looks the same.
    // A node type no queue lists has no wall time to check.
    checks.push(atLeast(profile.max_wall_time_hours, filters.min_wall_time_hours));
  }
  return combine(checks);
}

function combine(outcomes: Outcome[]): Outcome {
  if (outcomes.includes("miss")) return "miss";
  if (outcomes.includes("unknown")) return "unknown";
  return "match";
}

const normalizeMethod = (method: string) => {
  const lower = method.toLowerCase();
  if (lower.includes("coming soon")) return null;
  if (lower.startsWith("globus")) return "Globus";
  return method.trim();
};

function transferMethods(detail: Row | null): string[] | null {
  const methods = Array.isArray(detail?.file_transfer) ? (detail.file_transfer as Row[]) : [];
  const names = methods.flatMap((row) => {
    const name = text(row.method);
    return name ? (name.split("/").map(normalizeMethod).filter(Boolean) as string[]) : [];
  });
  const unique = names.filter(
    (name, index) => names.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === index
  );
  return unique.length > 0 ? unique : null;
}

const datasetNames = (detail: Row | null): string[] =>
  Array.isArray(detail?.datasets)
    ? (detail.datasets as Row[]).flatMap((row) => text(row.name) ?? [])
    : [];

// An abbreviation matches its expansions only.
function organizationMatches(orgName: string, organization: string): boolean {
  const wanted = organization.trim();
  const parent = ORG_PARENTS.find(([pattern]) => pattern.test(wanted.toLowerCase()));
  if (parent && wordMatch(orgName, parent[1])) return true;
  const expansions = ORG_ABBREVIATIONS[wanted.toUpperCase()];
  if (expansions) {
    return orgName.toLowerCase() === wanted.toLowerCase() || expansions.some((name) => wordMatch(orgName, name));
  }
  return wordMatch(orgName, wanted);
}

function searchableText(resource: DocumentedResource): string {
  const { listing, group, detail } = resource;
  const software = Array.isArray(detail?.top_software) ? (detail.top_software as Row[]) : [];
  return [
    listing.title,
    listing.short_name,
    listing.global_resource_id,
    listing.org_name,
    group?.title,
    htmlText(detail?.description),
    ...hardwareProfiles(detail).flatMap((profile) => [
      profile.queue,
      profile.node_type,
      profile.cpu_type,
      ...profile.gpus.map((gpu) => gpu.type),
    ]),
    ...(hardwareProfiles(detail).some(hasAccelerator) ? ACCELERATOR_WORDS : []),
    ...datasetNames(detail),
    ...software.map((row) => text(row.name)),
  ]
    .filter(Boolean)
    .join(" ");
}

// A query of only generic words, such as "HPC resources", yields no terms and filters nothing.
function queryTerms(query: string | undefined): string[] {
  const words = joinVersions((query ?? "").toLowerCase())
    .split(/[\s,?!;:()"]+/)
    .map((word) => word.replace(/\.+$/, ""))
    .filter(Boolean);
  const terms: string[] = [];
  words.forEach((word, index) => {
    const previous = words[index - 1];
    // "Stampede 3" is written "Stampede3".
    if (/^\d{1,2}$/.test(word) && previous && /[a-z]$/.test(previous) && !GENERIC_WORDS.has(previous)) {
      terms[terms.length - 1] += word;
    } else if (!GENERIC_WORDS.has(word)) {
      terms.push(word);
    }
  });
  return terms;
}

// The filters a catalog listing alone can decide.
function listingOutcomes(listing: Listing, filters: SearchFilters): Record<string, Outcome> {
  const outcomes: Record<string, Outcome> = {};
  if (filters.type) {
    outcomes.type = listing.resource_type === null
      ? "unknown"
      : listing.resource_type.toLowerCase() === filters.type.trim().toLowerCase() ? "match" : "miss";
  }
  if (filters.status) {
    outcomes.status = listing.status === null
      ? "unknown"
      : listing.status.toLowerCase() === filters.status.toLowerCase() ? "match" : "miss";
  }
  if (filters.organization) {
    outcomes.organization = listing.org_name === null
      ? "unknown"
      : organizationMatches(listing.org_name, filters.organization) ? "match" : "miss";
  }
  return outcomes;
}

interface MatchingQueue {
  name: string | null;
  summary: string | null;
  node_types?: string[];
}

// Each queue is listed once, with the node types that satisfy the filters.
function matchingQueueList(profiles: Profile[]): MatchingQueue[] {
  const queues = new Map<string, Profile[]>();
  for (const profile of profiles) {
    if (profile.queue === null) continue;
    queues.set(profile.queue, [...(queues.get(profile.queue) ?? []), profile]);
  }
  return [...queues].map(([name, group]) => {
    const summaries = [...new Set(group.flatMap((profile) => profile.summary ?? []))];
    const labels = [...new Set(group.flatMap((profile) => profile.node_type ?? []))];
    return {
      name,
      summary: summaries.length > 0 ? summaries.join("; ") : null,
      ...(labels.length > 0 && { node_types: labels }),
    };
  });
}

interface Evaluation {
  outcome: Outcome;
  unknown: string[];
  matchingQueues: MatchingQueue[] | null;
  matchingDatasets: string[] | null;
}

function evaluate(resource: DocumentedResource, filters: SearchFilters): Evaluation {
  const { listing, detail } = resource;
  const outcomes: Record<string, Outcome> = {};

  const terms = queryTerms(filters.query);
  if (terms.length > 0) {
    const haystack = searchableText(resource);
    // Without its page, a resource the name doesn't match might still match its documentation.
    outcomes.query = terms.every((term) => termMatches(haystack, term))
      ? "match"
      : resource.failed ? "unknown" : "miss";
  }
  Object.assign(outcomes, listingOutcomes(listing, filters));

  const documentedQueues = hardwareProfiles(detail);
  let matchingQueues: MatchingQueue[] | null = null;
  const anyAccelerator = documentedQueues.some(hasAccelerator);
  const unmodelledAccelerator = !anyAccelerator && mentionsAccelerator(detail);
  // Storage systems don't run jobs, so hardware filters don't apply to them.
  const storage = listing.resource_type?.toLowerCase() === "storage";
  if (filters.has_gpu === false) {
    outcomes.has_gpu = storage
      ? "miss"
      : documentedQueues.length === 0 || unmodelledAccelerator
        ? "unknown"
        : anyAccelerator ? "miss" : documentedQueues.some(({ undocumented }) => undocumented) ? "unknown" : "match";
  }
  // has_gpu: false is decided per resource above; the rest are checked per queue.
  const queueFiltered = filters.has_gpu === true || QUEUE_FILTERS.some((key) => filters[key] !== undefined);
  if (queueFiltered) {
    const results = documentedQueues.map((profile) => ({ profile, outcome: profileOutcome(profile, filters) }));
    const matching = results.filter(({ outcome }) => outcome === "match").map(({ profile }) => profile);
    matchingQueues = matchingQueueList(matching);
    const wantsAccelerator =
      filters.has_gpu === true || filters.gpu_type !== undefined || filters.min_gpu_memory_gb !== undefined;
    if (storage) outcomes.queues = "miss";
    else if (documentedQueues.length === 0) outcomes.queues = "unknown";
    else if (matching.length > 0) outcomes.queues = "match";
    else if (results.some(({ outcome }) => outcome === "unknown")) outcomes.queues = "unknown";
    else outcomes.queues = wantsAccelerator && unmodelledAccelerator ? "unknown" : "miss";
  }

  let matchingDatasets: string[] | null = null;
  if (filters.dataset) {
    const names = datasetNames(detail);
    matchingDatasets = names.filter((name) => wordMatch(name, filters.dataset!));
    outcomes.dataset = names.length === 0 ? "unknown" : matchingDatasets.length > 0 ? "match" : "miss";
  }
  if (filters.ondemand) outcomes.ondemand = text(detail?.ondemand_url) ? "match" : "unknown";
  if (filters.transfer_method) {
    const methods = transferMethods(detail);
    outcomes.transfer_method = methods === null
      ? "unknown"
      : methods.some((method) => wordMatch(method, filters.transfer_method!)) ? "match" : "miss";
  }

  const unknown = Object.entries(outcomes)
    .filter(([, outcome]) => outcome === "unknown")
    .map(([key]) => (key === "queues" ? queueFilterNames(filters) : [key]))
    .flat();
  return { outcome: combine(Object.values(outcomes)), unknown, matchingQueues, matchingDatasets };
}

function queueFilterNames(filters: SearchFilters): string[] {
  const names: string[] = filters.has_gpu === true ? ["has_gpu"] : [];
  return [...names, ...QUEUE_FILTERS.filter((key) => filters[key] !== undefined)];
}

function maxOf(profiles: Profile[], field: "ram" | "cpu_count" | "max_wall_time_hours"): number | null {
  const values = profiles.map((profile) => profile[field]).filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

function summarize(resource: DocumentedResource, evaluation: Evaluation) {
  const { listing, group, detail } = resource;
  const documentedQueues = hardwareProfiles(detail);
  const accelerators = [...new Set(documentedQueues.flatMap((profile) => profile.gpus.flatMap((gpu) => gpu.type ?? [])))];
  return {
    id: listing.global_resource_id,
    name: listing.title,
    organization: listing.org_name,
    type: listing.resource_type,
    status: listing.status,
    group: group?.title ?? null,
    accelerators: documentedQueues.length > 0 ? accelerators : null,
    max_node_memory_gb: maxOf(documentedQueues, "ram"),
    max_cores_per_node: maxOf(documentedQueues, "cpu_count"),
    max_wall_time_hours: maxOf(documentedQueues, "max_wall_time_hours"),
    ondemand_url: text(detail?.ondemand_url),
    transfer_methods: transferMethods(detail),
    ...(evaluation.matchingQueues && {
      matching_queues: evaluation.matchingQueues,
    }),
    ...(evaluation.matchingDatasets && { matching_datasets: evaluation.matchingDatasets }),
    citation_url: group?.url ?? listing.url,
    details_available: detail !== null,
  };
}

export type ResourceSummary = ReturnType<typeof summarize>;

export function searchResources(
  resources: DocumentedResource[],
  filters: SearchFilters
) {
  const items: ResourceSummary[] = [];
  const unchecked: { name: string; filters: string[] }[] = [];
  const unavailable: string[] = [];

  for (const resource of resources) {
    const evaluation = evaluate(resource, filters);
    if (evaluation.outcome === "match") items.push(summarize(resource, evaluation));
    if (evaluation.outcome === "unknown") {
      if (resource.failed) unavailable.push(resource.listing.title);
      else unchecked.push({ name: resource.listing.title, filters: evaluation.unknown });
    }
  }

  return {
    items,
    unchecked,
    unavailable,
  };
}
