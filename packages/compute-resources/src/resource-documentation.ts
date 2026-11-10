const API_URL = "https://support.access-ci.org/api/1.0";

// The site limits regular traffic to 300 requests per 10 minutes.
const CACHE_TTL_MS = 10 * 60 * 1000;
const DETAIL_CONCURRENCY = 6;

type HttpGet = (url: string) => Promise<{ status: number; data: unknown }>;
type Row = Record<string, unknown>;

export interface Listing {
  nid: number;
  title: string;
  short_name: string | null;
  resource_id: string | null;
  global_resource_id: string | null;
  org_name: string | null;
  status: string | null;
  resource_type: string | null;
  url: string;
  last_modified: string | null;
  listed?: boolean;
}

export interface Group {
  title: string;
  url: string;
  variants: { nid: number }[];
}

interface Catalog {
  resources: Listing[];
  groups: Group[];
}

interface Cached<T> {
  value: T;
  expires: number;
}

export interface DocumentedResource {
  listing: Listing;
  group: Group | undefined;
  detail: Row | null;
  /** The detail page couldn't be read, as opposed to not existing. */
  failed?: boolean;
}

export interface ResourceMatch {
  id: string | null;
  name: string;
}

export type Resolution =
  { resource: Listing; matches?: undefined } | { resource?: undefined; matches: ResourceMatch[] };

export type ResourceDetails = ReturnType<typeof buildResource>;

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function htmlToText(html: unknown): string | null {
  if (typeof html !== "string") return null;
  const text = html
    .replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>(.*?)<\/a>/gis, "$2 ($1)")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<br\s*\/?>|<\/(?:p|div|li|ul|ol|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return text || null;
}

const rows = (value: unknown): Row[] => (Array.isArray(value) ? value : []);

function list<T>(value: unknown, map: (row: Row) => T): T[] | null {
  const mapped = rows(value).map(map);
  return mapped.length > 0 ? mapped : null;
}

const value = <T>(field: T | undefined): T | null => (field === "" ? null : (field ?? null));

function links(field: unknown): Record<string, string> | null {
  const entries = Object.entries((field ?? {}) as Row).filter(([, url]) => url);
  return entries.length > 0 ? (Object.fromEntries(entries) as Record<string, string>) : null;
}

// Today's figures can't tell missing data from a real zero, so nothing is shown
// until the API reports the last date it has data for (D8-2971).
function waitTimes(detail: Row) {
  const asOf = value(detail.queue_metrics_last_data as string);
  const metrics = Object.entries((detail.queue_metrics ?? {}) as Record<string, Row>);
  if (!asOf || metrics.length === 0) return null;

  return {
    as_of: asOf,
    queues: metrics.map(([queue, row]) => ({
      queue,
      average_wait_hours: value(row.wait_time),
      job_count: value(row.job_count),
    })),
  };
}

function buildResource(listing: Listing, group: Group | undefined, detail: Row | null) {
  const d = detail ?? {};
  return {
    id: listing.global_resource_id,
    name: listing.title,
    organization: listing.org_name,
    organization_url: value(d.org_url as string),
    type: listing.resource_type,
    status: listing.status,
    last_updated: listing.last_modified,
    description: htmlToText(d.description),
    access: {
      mfa_required: value(d.mfa_required as boolean),
      account_required: value(d.account_required as boolean),
      account_setup_url: value(d.account_setup_url as string),
    },
    login: {
      instructions: htmlToText(d.login_text),
      ondemand_url: value(d.ondemand_url as string),
      ssh_hosts: list(d.ssh_logins, (row) => ({
        hostname: row.hostname as string,
        username: value(row.username_placeholder),
        docs_url: value(row.docs_url),
        recommended: row.recommended === true,
      })),
      help_links: list(d.login_help_links, (row) => ({ title: row.title, url: row.url })),
    },
    file_transfer: {
      instructions: htmlToText(d.file_transfer_text),
      methods: list(d.file_transfer, (row) => ({
        method: row.method as string,
        node: value(row.transfer_node),
        url: value(row.transfer_url),
        recommended: row.recommended === true,
      })),
    },
    storage: {
      instructions: htmlToText(d.storage_text),
      filesystems: list(d.storage, (row) => ({
        name: row.directory as string,
        path: value(row.path),
        quota_gb: value(row.quota_size),
        quota_files: value(row.quota_inode_amount),
        purge: value(row.purge),
        backup: value(row.backup),
        notes: htmlToText(row.notes),
        summary: value(row.summary) as string | null,
      })),
      external: htmlToText(d.external_storage),
    },
    jobs: htmlToText(d.jobs_info),
    queues: list(d.queue_specs, (row) => ({
      name: row.name as string,
      purpose: htmlToText(row.purpose),
      nodes: value(row.node_count),
      cpus_per_node: value(row.cpu_count),
      cpu_type: value(row.cpu_type),
      gpus_per_node: value(row.gpu_count),
      gpu_type: value(row.gpu_type),
      gpu_memory_gb: value(row.gpu_vram),
      memory_gb: value(row.ram),
      max_wall_time_hours: value(row.max_wall_time_hours) as number | null,
      summary: value(row.summary) as string | null,
    })),
    wait_times: waitTimes(d),
    datasets: list(d.datasets, (row) => ({
      name: row.name,
      description: htmlToText(row.description),
    })),
    top_software: list(d.top_software, (row) => ({ name: row.name, job_count: row.job_count })),
    software_url: value(d.software_list_url as string),
    support_links: list(d.support_links, (row) => ({ title: row.title, url: row.url })),
    documentation_links: links(d.documentation_links),
    office_hours: value(d.office_hours as string),
    group: group?.title ?? null,
    citation_url: group?.url ?? listing.url,
    details_available: detail !== null,
  };
}

export function buildComparison(resource: ResourceDetails) {
  return {
    id: resource.id,
    name: resource.name,
    organization: resource.organization,
    type: resource.type,
    status: resource.status,
    mfa_required: resource.access.mfa_required,
    account_required: resource.access.account_required,
    ondemand_url: resource.login.ondemand_url,
    ssh_hosts: resource.login.ssh_hosts?.map((host) => host.hostname) ?? null,
    transfer_methods: resource.file_transfer.methods?.map((method) => method.method) ?? null,
    queues:
      resource.queues?.map(({ name, summary, max_wall_time_hours }) => ({
        name,
        summary,
        max_wall_time_hours,
      })) ?? null,
    wait_times: resource.wait_times,
    filesystems:
      resource.storage.filesystems?.map(({ name, summary }) => ({ name, summary })) ?? null,
    software_url: resource.software_url,
    citation_url: resource.citation_url,
    details_available: resource.details_available,
  };
}

/** Reads the pages under support.access-ci.org/documentation/resources. */
export class ResourceDocumentation {
  private catalog?: Cached<Catalog>;
  private loadingAll?: Promise<DocumentedResource[]>;
  private details = new Map<string, Cached<Row | null>>();

  constructor(private readonly get: HttpGet) {}

  async resolve(input: string): Promise<Resolution> {
    const { resources, groups } = await this.loadCatalog();
    const wanted = input.trim().toLowerCase();
    // CiDeR group IDs like delta.ncsa.access-ci.org name a group, not a resource.
    const key = normalize(wanted.endsWith(".access-ci.org") ? wanted.split(".")[0] : wanted);
    const members = (group: Group) =>
      resources.filter(({ nid }) => group.variants.some((variant) => variant.nid === nid));

    const candidates = [
      resources.filter((resource) => resource.global_resource_id?.toLowerCase() === wanted),
      resources.filter(({ title, short_name }) =>
        [title, short_name].some((name) => name && normalize(name) === key)
      ),
      groups.filter(({ title }) => normalize(title) === key).flatMap(members),
      key ? resources.filter(({ title }) => normalize(title).includes(key)) : [],
    ].find((matches) => matches.length > 0);

    if (candidates?.length === 1) return { resource: candidates[0] };
    return {
      matches: (candidates ?? []).map((resource) => ({
        id: resource.global_resource_id,
        name: resource.title,
      })),
    };
  }

  async describe(resource: Listing): Promise<ResourceDetails> {
    return buildResource(resource, await this.groupOf(resource), await this.loadDetail(resource));
  }

  /** Every documented resource with its detail, for searching across them. */
  all(): Promise<DocumentedResource[]> {
    // Concurrent searches on a cold cache share one load instead of each
    // requesting every page.
    this.loadingAll ??= this.loadAll().finally(() => {
      this.loadingAll = undefined;
    });
    return this.loadingAll;
  }

  private async loadAll(): Promise<DocumentedResource[]> {
    const { resources, groups } = await this.loadCatalog();
    const loaded: { detail: Row | null; failed: boolean }[] = new Array(resources.length);
    let next = 0;
    const worker = async () => {
      while (next < resources.length) {
        const index = next++;
        // One failed page shouldn't sink a search across all of them. It's reported
        // as failed, not undocumented, and isn't cached, so the next search retries it.
        loaded[index] = await this.loadDetail(resources[index]).then(
          (detail) => ({ detail, failed: false }),
          () => ({ detail: null, failed: true })
        );
      }
    };
    await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));
    return resources.map((listing, index) => ({
      listing,
      group: groups.find(({ variants }) => variants.some((variant) => variant.nid === listing.nid)),
      ...loaded[index],
    }));
  }

  private async groupOf(resource: Listing): Promise<Group | undefined> {
    const { groups } = await this.loadCatalog();
    return groups.find(({ variants }) => variants.some((variant) => variant.nid === resource.nid));
  }

  private async loadCatalog(): Promise<Catalog> {
    if (this.catalog && this.catalog.expires > Date.now()) return this.catalog.value;

    const [resources, groups] = await Promise.all([
      this.fetchJson<{ resources: Listing[] }>(`${API_URL}/resources`),
      this.fetchJson<{ groups: Group[] }>(`${API_URL}/resource-groups`),
    ]);
    const value = {
      resources: resources.resources.filter(({ listed }) => listed !== false),
      groups: groups.groups,
    };
    this.catalog = { value, expires: Date.now() + CACHE_TTL_MS };
    return value;
  }

  // Resources outside CiDeR have no resource_id, so they're fetched by node ID.
  // Until that route exists (D8-2976) the 404 reads as "no details".
  private async loadDetail({ nid, resource_id }: Listing): Promise<Row | null> {
    const path = resource_id ? encodeURIComponent(resource_id) : `node/${nid}`;

    const cached = this.details.get(path);
    if (cached && cached.expires > Date.now()) return cached.value;

    const response = await this.get(`${API_URL}/resources/${path}`);
    if (response.status !== 200 && response.status !== 404) {
      throw new Error(`Resource Documentation API returned ${response.status}`);
    }
    const value = response.status === 200 ? (response.data as Row) : null;
    this.details.set(path, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await this.get(url);
    if (response.status !== 200) {
      throw new Error(`Resource Documentation API returned ${response.status}`);
    }
    return response.data as T;
  }
}
