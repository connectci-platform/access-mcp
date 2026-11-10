import { describe, expect, it } from "vitest";
import type { DocumentedResource, Listing } from "./resource-documentation.js";
import { searchResources } from "./resource-search.js";

const listing = (nid: number, title: string, extra: Partial<Listing> = {}): Listing => ({
  nid,
  title,
  short_name: title,
  resource_id: String(nid),
  global_resource_id: `${title.toLowerCase().replace(/\W+/g, "-")}.example.access-ci.org`,
  org_name: "Example University",
  status: "production",
  resource_type: "Compute",
  url: `https://support.access-ci.org/documentation/resources/${nid}`,
  last_modified: null,
  ...extra,
});

const queue = (name: string, spec: Record<string, unknown>) => ({
  name,
  summary: `${name} summary`,
  ...spec,
});

const resource = (
  item: Listing,
  detail: Record<string, unknown> | null,
  group?: string
): DocumentedResource => ({
  listing: item,
  group: group ? { title: group, url: `https://support.access-ci.org/${group}`, variants: [] } : undefined,
  detail,
});

const gpuCluster = resource(
  listing(1, "Big GPU", { org_name: "National Center for Supercomputing Applications" }),
  {
    description: "<p>A cluster for <strong>AI</strong> training.</p>",
    ondemand_url: "https://ondemand.example.org",
    file_transfer: [{ method: "Globus Connect" }, { method: "scp/sftp" }, { method: "SCP" }],
    datasets: [{ name: "AlphaFold" }, { name: "COCO" }],
    queue_specs: [
      queue("small", { gpu_count: 4, gpu_type: "NVIDIA A100", gpu_vram: 40, ram: 256, cpu_count: 64, max_wall_time_hours: 48 }),
      queue("big", { gpu_count: 8, gpu_type: "NVIDIA H200", gpu_vram: 141, ram: 2048, cpu_count: 96, cpu_type: "Intel Xeon Platinum", max_wall_time_hours: 48 }),
      queue("cpu", { gpu_count: 0, gpu_type: "None", ram: 256, cpu_count: 128, cpu_type: "AMD EPYC" }),
    ],
  },
  "Big"
);

const cpuCluster = resource(listing(2, "CPU Only", { org_name: "OSG Consortium" }), {
  file_transfer: [{ method: "rsync" }, { method: "Globus (Coming Soon)" }],
  queue_specs: [queue("shared", { ram: 512, cpu_count: 128, cpu_type: "AMD EPYC", max_wall_time_hours: 168 })],
});

const gaudi = resource(listing(3, "Gaudi Box"), {
  queue_specs: [queue("gaudi", { gpu_count: 8, gpu_type: "Habana Gaudi", gpu_vram: 32, ram: 512 })],
});

const untypedGpu = resource(listing(4, "Mystery GPU"), {
  queue_specs: [queue("ind-gpu", { gpu_count: 4, gpu_type: null, ram: 1024 })],
});

const storage = resource(listing(5, "Tape", { resource_type: "Storage" }), {
  file_transfer: [{ method: "Globus" }],
});

const fabric = resource(
  listing(6, "Fabric", {
    global_resource_id: null,
    resource_id: null,
    org_name: null,
    status: null,
    resource_type: null,
  }),
  null
);

const all = [gpuCluster, cpuCluster, gaudi, untypedGpu, storage, fabric];
const search = (filters: Parameters<typeof searchResources>[1]) => searchResources(all, filters);
const names = (result: ReturnType<typeof search>) => result.items.map(({ name }) => name);
const unknownNames = (result: ReturnType<typeof search>) => result.unchecked.map(({ name }) => name);

describe("searchResources", () => {
  it("lists every resource when no filter is given", () => {
    const result = search({});
    expect(result.items).toHaveLength(all.length);
    expect(result.unchecked).toEqual([]);
  });

  it("summarizes a resource from its documentation", () => {
    const [item] = search({ query: "big gpu" }).items;
    expect(item).toEqual({
      id: "big-gpu.example.access-ci.org",
      name: "Big GPU",
      organization: "National Center for Supercomputing Applications",
      type: "Compute",
      status: "production",
      group: "Big",
      accelerators: ["NVIDIA A100", "NVIDIA H200"],
      max_node_memory_gb: 2048,
      max_cores_per_node: 128,
      max_wall_time_hours: 48,
      ondemand_url: "https://ondemand.example.org",
      transfer_methods: ["Globus", "scp", "sftp"],
      citation_url: "https://support.access-ci.org/Big",
      details_available: true,
    });
  });

  it("gives a resource without queues null accelerators, and keeps a null id", () => {
    const items = search({}).items;
    expect(items.find(({ name }) => name === "Tape")?.accelerators).toBeNull();
    expect(items.find(({ name }) => name === "Fabric")).toMatchObject({ id: null, details_available: false });
  });

  describe("query", () => {
    it("requires every word to appear somewhere in the resource", () => {
      expect(names(search({ query: "AI training" }))).toEqual(["Big GPU"]);
      expect(names(search({ query: "AI nonsense" }))).toEqual([]);
    });

    it("searches hardware models and dataset names", () => {
      expect(names(search({ query: "h200" }))).toEqual(["Big GPU"]);
      expect(names(search({ query: "alphafold" }))).toEqual(["Big GPU"]);
      expect(names(search({ query: "gaudi" }))).toEqual(["Gaudi Box"]);
    });
  });

  describe("organization", () => {
    it("expands an abbreviation", () => {
      expect(names(search({ organization: "NCSA" }))).toEqual(["Big GPU"]);
    });

    it("doesn't match an abbreviation inside another name", () => {
      expect(names(search({ organization: "IU" }))).toEqual([]);
    });

    it("reports resources with no organization as undocumented", () => {
      expect(unknownNames(search({ organization: "OSG" }))).toEqual(["Fabric"]);
    });
  });

  describe("has_gpu", () => {
    it("counts any accelerator, including a queue with a count but no model", () => {
      expect(names(search({ has_gpu: true }))).toEqual(["Big GPU", "Gaudi Box", "Mystery GPU"]);
    });

    it("leaves out models that aren't documented, rather than inventing one", () => {
      expect(search({ query: "mystery" }).items[0].accelerators).toEqual([]);
    });

    it("false matches only resources whose documented queues have no accelerator", () => {
      const result = search({ has_gpu: false });
      expect(names(result)).toEqual(["CPU Only"]);
      // Storage doesn't run jobs, so it's neither a CPU-only match nor unknown.
      expect(unknownNames(result)).toEqual(["Fabric"]);
    });

    it("lists the matching queues", () => {
      const [item] = search({ has_gpu: true, query: "big" }).items;
      expect(item.matching_queues).toEqual([
        { name: "small", summary: "small summary" },
        { name: "big", summary: "big summary" },
      ]);
    });
  });

  describe("queue filters", () => {
    it("must all hold on the same queue", () => {
      // small has 64 cores and big has 2 TB, but no one queue has both.
      expect(names(search({ min_memory_gb: 1000, min_cores_per_node: 128 }))).toEqual([]);
      const [item] = search({ min_gpu_memory_gb: 80, min_memory_gb: 1000 }).items;
      expect(item.matching_queues).toEqual([{ name: "big", summary: "big summary" }]);
    });

    it("matches accelerator and CPU model text", () => {
      expect(names(search({ gpu_type: "a100" }))).toEqual(["Big GPU"]);
      expect(names(search({ cpu_type: "epyc" }))).toEqual(["Big GPU", "CPU Only"]);
    });

    it("treats an undocumented GPU model as unknown, not a miss", () => {
      expect(unknownNames(search({ gpu_type: "H100" }))).toContain("Mystery GPU");
    });

    it("only checks GPU memory on GPU queues", () => {
      expect(names(search({ min_gpu_memory_gb: 32 }))).toEqual(["Big GPU", "Gaudi Box"]);
    });

    it("reports a resource as undocumented when the deciding field is empty", () => {
      const result = search({ min_wall_time_hours: 100 });
      expect(names(result)).toEqual(["CPU Only"]);
      expect(result.unchecked).toEqual(
        expect.arrayContaining([
          { name: "Big GPU", filters: ["min_wall_time_hours"] },
          { name: "Gaudi Box", filters: ["min_wall_time_hours"] },
        ])
      );
    });

    it("counts a resource as a miss when a known queue fails and none is unknown", () => {
      expect(unknownNames(search({ min_memory_gb: 4000 }))).not.toContain("Big GPU");
    });
  });

  describe("resource filters", () => {
    it("matches datasets by name and lists the matching ones", () => {
      const result = search({ dataset: "alpha" });
      expect(result.items.map(({ name, matching_datasets }) => ({ name, matching_datasets }))).toEqual([
        { name: "Big GPU", matching_datasets: ["AlphaFold"] },
      ]);
      expect(unknownNames(result)).toContain("CPU Only");
    });

    it("normalizes transfer methods and skips ones marked coming soon", () => {
      expect(names(search({ transfer_method: "globus" }))).toEqual(["Big GPU", "Tape"]);
      expect(search({ query: "cpu only" }).items[0].transfer_methods).toEqual(["rsync"]);
    });

    it("treats a missing OnDemand URL as undocumented", () => {
      const result = search({ ondemand: true });
      expect(names(result)).toEqual(["Big GPU"]);
      expect(unknownNames(result)).toContain("CPU Only");
    });

    it("filters by type and status", () => {
      expect(names(search({ type: "storage" }))).toEqual(["Tape"]);
      expect(unknownNames(search({ type: "storage" }))).toEqual(["Fabric"]);
      expect(names(search({ status: "Production" }))).toEqual([
        "Big GPU", "CPU Only", "Gaudi Box", "Mystery GPU", "Tape",
      ]);
      expect(unknownNames(search({ status: "production" }))).toEqual(["Fabric"]);
    });
  });

  describe("word matching", () => {
    const described = (title: string, description: string) =>
      resource(listing(50, title), { description, queue_specs: [queue("q", { ram: 64 })] });

    it("doesn't match a short term inside another word", () => {
      const avail = described("Avail", "Resources available to researchers");
      expect(searchResources([avail], { query: "AI" }).items).toEqual([]);
      expect(searchResources([described("AI Box", "For AI work")], { query: "ai" }).items).toHaveLength(1);
    });

    it("keeps short model names from matching longer ones", () => {
      const l40s = resource(listing(51, "L40S Box"), {
        queue_specs: [queue("g", { gpu_count: 4, gpu_type: "NVIDIA L40S-48GB" })],
      });
      expect(searchResources([l40s, gpuCluster], { gpu_type: "L4" }).items).toEqual([]);
      expect(searchResources([gpuCluster], { gpu_type: "A10" }).items).toEqual([]);
    });

    it("lets longer terms match the start of a word", () => {
      expect(names(search({ dataset: "alpha" }))).toEqual(["Big GPU"]);
      expect(names(search({ cpu_type: "xeon plat" }))).toEqual(["Big GPU"]);
    });

    it("matches comma-separated GPU models", () => {
      const jetstream = resource(listing(52, "Jetstream2 GPU"), {
        queue_specs: [queue("g", { gpu_count: 4, gpu_type: "NVIDIA A100 SXM4, NVIDIA H100 SXM, NVIDIA L40S" })],
      });
      const result = searchResources([jetstream], { gpu_type: "h100", min_gpu_memory_gb: 80 });
      expect(result.unchecked).toEqual([{ name: "Jetstream2 GPU", filters: ["gpu_type", "min_gpu_memory_gb"] }]);
      expect(searchResources([jetstream], { gpu_type: "h100" }).items).toHaveLength(1);
    });

    it("drops generic words and finds GPU resources by the word GPU", () => {
      expect(names(search({ query: "GPU clusters" }))).toEqual(["Big GPU", "Gaudi Box", "Mystery GPU"]);
    });

    it("matches organizations by word, abbreviation or exact name", () => {
      const utexas = resource(listing(53, "Longhorn", { org_name: "Texas Advanced Computing Center" }), null);
      const named = resource(listing(54, "Odd", { org_name: "IU" }), null);
      const resources = [gpuCluster, cpuCluster, utexas, named];
      const orgs = (organization: string) =>
        searchResources(resources, { organization }).items.map(({ name }) => name);
      expect(orgs("UT")).toEqual(["Longhorn"]);
      expect(orgs("ncsa")).toEqual(["Big GPU"]);
      expect(orgs("IU")).toEqual(["Odd"]);
      expect(orgs("computing")).toEqual(["Longhorn"]);
      expect(orgs("comput")).toEqual(["Longhorn"]);
      expect(orgs("put")).toEqual([]);
    });

    it("matches a center by its university", () => {
      const psc = resource(listing(55, "Bridges", { org_name: "Pittsburgh Supercomputing Center" }), null);
      const orgs = (organization: string) =>
        searchResources([gpuCluster, cpuCluster, psc], { organization }).items.map(({ name }) => name);
      expect(orgs("University of Illinois")).toEqual(["Big GPU"]);
      expect(orgs("UIUC")).toEqual(["Big GPU"]);
      expect(orgs("Carnegie Mellon")).toEqual(["Bridges"]);
      expect(orgs("the University of Pittsburgh")).toEqual(["Bridges"]);
      // Only the whole name maps, so a different Illinois institution doesn't.
      expect(orgs("Illinois Institute of Technology")).toEqual([]);
    });
  });

  describe("accelerators", () => {
    it("counts a GPU model with no count", () => {
      const notebook = resource(listing(60, "Notebook"), {
        queue_specs: [queue("nb", { gpu_count: null, gpu_type: "Nvidia H100" })],
      });
      expect(searchResources([notebook], { has_gpu: true }).items).toHaveLength(1);
    });

    it("treats a system describing an accelerator outside its queues as unknown", () => {
      const cerebras = resource(listing(61, "Wafer"), {
        description: "<p>An AI accelerator system with two Cerebras CS-2 engines.</p>",
        queue_specs: [queue("sdf", { cpu_type: "Intel Xeon", ram: 12000 })],
      });
      expect(searchResources([cerebras], { has_gpu: false }).unchecked).toEqual([
        { name: "Wafer", filters: ["has_gpu"] },
      ]);
      expect(searchResources([cerebras], { has_gpu: true }).unchecked).toEqual([
        { name: "Wafer", filters: ["has_gpu"] },
      ]);
      expect(searchResources([cerebras], { min_memory_gb: 1000 }).items).toHaveLength(1);
    });

    it("doesn't treat a CPU system that mentions GPUs as having one", () => {
      const cpu = resource(listing(62, "Delta CPU"), {
        description: "<p>Delta also has GPU nodes.</p>",
        queue_specs: [queue("cpu", { cpu_count: 128 })],
      });
      expect(searchResources([cpu], { has_gpu: false }).items).toHaveLength(1);
    });
  });

  describe("combining outcomes", () => {
    it("drops a resource that fails one filter even if another is unknown", () => {
      const result = search({ organization: "OSG", min_wall_time_hours: 200 });
      expect(result.items).toEqual([]);
      expect(unknownNames(result)).toEqual(["Fabric"]);
    });

    it("lists every filter that couldn't be checked", () => {
      expect(search({ min_wall_time_hours: 24, dataset: "coco" }).unchecked).toContainEqual({
        name: "Gaudi Box",
        filters: ["min_wall_time_hours", "dataset"],
      });
    });

    it("keeps storage out of hardware results", () => {
      const result = search({ min_memory_gb: 1 });
      expect(names(result)).not.toContain("Tape");
      expect(unknownNames(result)).not.toContain("Tape");
    });

    it("reports a resource whose page failed as unavailable, not undocumented", () => {
      const failed = { ...resource(listing(70, "Flaky"), null), failed: true };
      const result = searchResources([failed], { has_gpu: true });
      expect(result.unavailable).toEqual(["Flaky"]);
      expect(result.unchecked).toEqual([]);
    });

    it("can't rule out a failed page by query unless its name matches", () => {
      const failed = { ...resource(listing(70, "Flaky"), null), failed: true };
      const byHardware = searchResources([failed], { query: "h100" });
      expect(byHardware.items).toEqual([]);
      expect(byHardware.unavailable).toEqual(["Flaky"]);
      const byName = searchResources([failed], { query: "flaky" });
      expect(byName.items.map(({ name }) => name)).toEqual(["Flaky"]);
      expect(byName.unavailable).toEqual([]);
    });
  });

  describe("query words", () => {
    const bridges = resource(listing(80, "Bridges-2 GPU"), { queue_specs: [] });
    const stampede = resource(listing(81, "Stampede3"), { queue_specs: [] });

    it("ignores question words from a sentence passed as the query", () => {
      expect(names(search({ query: "Which resources have H200s?" }))).toEqual(["Big GPU"]);
    });

    it("matches a version written with a space or a hyphen", () => {
      const found = (query: string) => names(searchResources([bridges, stampede], { query }));
      expect(found("Bridges 2")).toEqual(["Bridges-2 GPU"]);
      expect(found("bridges2")).toEqual(["Bridges-2 GPU"]);
      expect(found("Stampede 3")).toEqual(["Stampede3"]);
      expect(found("stampede-3")).toEqual(["Stampede3"]);
    });

    it("doesn't join a number to a generic word", () => {
      expect(names(search({ query: "gaudi with 8" }))).toEqual([]);
      expect(names(search({ query: "gaudi" }))).toEqual(["Gaudi Box"]);
    });

    it("filters nothing when every word is generic", () => {
      expect(search({ query: "HPC resources" }).items).toHaveLength(all.length);
    });
  });

  describe("transfer methods", () => {
    const methods = (rows: unknown[]) =>
      searchResources([resource(listing(80, "T"), { file_transfer: rows })], {}).items[0].transfer_methods;

    it("returns null when only coming-soon, empty or missing methods are documented", () => {
      expect(methods([{ method: "Globus (Coming Soon)" }])).toBeNull();
      expect(methods([{ method: null }])).toBeNull();
      expect(methods([])).toBeNull();
    });

    it("keeps the first spelling of a repeated method", () => {
      expect(methods([{ method: "SCP" }, { method: "scp/sftp" }])).toEqual(["SCP", "sftp"]);
    });
  });
});
