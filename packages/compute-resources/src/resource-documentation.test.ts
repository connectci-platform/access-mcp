import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ComputeResourcesServer } from "./server.js";

const API = "https://support.access-ci.org/api/1.0";

const listing = (nid: number, title: string, ids: { rid?: string; gid?: string } = {}) => ({
  nid,
  title,
  short_name: title,
  resource_id: ids.rid ?? null,
  global_resource_id: ids.gid ?? null,
  org_name: "Example University",
  status: ids.rid ? "production" : null,
  resource_type: "Compute",
  has_documentation: true,
  url: `https://support.access-ci.org/documentation/resources/${nid}`,
  last_modified: "2026-11-07T02:02:06-05:00",
});

const aces = listing(449, "ACES", { rid: "1659", gid: "aces.tamu.access-ci.org" });
const deltaCpu = listing(501, "Delta CPU", { rid: "2001", gid: "delta-cpu.ncsa.access-ci.org" });
const deltaGpu = listing(502, "Delta GPU", { rid: "2002", gid: "delta-gpu.ncsa.access-ci.org" });
const bridges = listing(601, "Bridges-2 RM", { rid: "3001", gid: "bridges2-rm.psc.access-ci.org" });
const kitsune = listing(701, "Kitsune", { rid: "4001", gid: "kitsune.gatech.access-ci.org" });
const fabric = listing(801, "Fabric");

const group = (nid: number, title: string, variants: ReturnType<typeof listing>[]) => ({
  nid,
  slug: title.toLowerCase(),
  title,
  url: `https://support.access-ci.org/documentation/resources/${title.toLowerCase()}`,
  populated_sections: [],
  variants,
});

const acesDetail = {
  ...aces,
  org_url: "https://hprc.tamu.edu",
  description: "<p>ACES is a <strong>composable</strong> testbed &amp; more.</p>",
  mfa_required: true,
  account_required: false,
  ondemand_url: "https://portal-aces.hprc.tamu.edu/",
  office_hours: null,
  login_text:
    '<p>Read the <a href="https://hprc.tamu.edu/access">access guide</a>.</p><ul><li>Use your ACCESS username.</li></ul>',
  file_transfer_text: "<p>Use Globus.</p>",
  storage_text: "<p>Quotas apply.</p>",
  datasets_text: null,
  jobs_info: "<p>Jobs are scheduled by Slurm.</p>",
  software_list_url: "https://hprc.tamu.edu/software/aces/",
  external_storage: null,
  ssh_logins: [
    {
      hostname: "login.aces.hprc.tamu.edu",
      username_placeholder: "<access-username>",
      docs_url: "https://hprc.tamu.edu/access",
      recommended: false,
    },
  ],
  login_help_links: [{ title: "Login help", url: "https://hprc.tamu.edu/login" }],
  account_setup_url: null,
  support_links: [{ title: "User guide", url: "https://hprc.tamu.edu/guide" }],
  file_transfer: [
    {
      method: "Globus",
      transfer_node: "ACCESS TAMU ACES DTN",
      transfer_url: "https://app.globus.org/dashboard",
      recommended: true,
    },
  ],
  storage: [
    {
      directory: "Home",
      path: "/home/<userid>",
      quota_size: 10,
      quota_inode_amount: 10000,
      purge: null,
      backup: "Backed up daily",
      notes: "Small scripts",
      summary: "10 GB, 10,000 files",
    },
  ],
  queue_specs: [
    {
      name: "gpu",
      purpose: "<p>GPU jobs</p>",
      node_count: 2,
      cpu_count: 48,
      cpu_type: "Intel Xeon",
      gpu_count: 8,
      gpu_type: "NVIDIA H100",
      gpu_vram: 80,
      ram: 512,
      max_wall_time_hours: 48,
      max_wall_time_display: "48 hours",
      summary: "8 NVIDIA H100 (80 GB vRAM), 2 nodes",
    },
  ],
  datasets: [],
  documentation_links: { login: "https://hprc.tamu.edu/access", queue_specs: null },
  queue_metrics_updated: "2026-11-07",
  queue_metrics: { gpu: { wait_time: 17.1, daily_wait: [0, 22.8] } },
  top_software: [],
  ood_software: [],
  content_hash: "abc",
};

describe("Resource Documentation tools", () => {
  let server: ComputeResourcesServer;
  let get: Mock<(url: string) => Promise<{ status: number; data: unknown }>>;
  let detailOverrides: Record<string, Record<string, unknown>>;
  let nodeRouteLive: boolean;
  let listedFlags: Record<number, boolean>;

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await server.handleToolCall({
      method: "tools/call",
      params: { name, arguments: args },
    });
    return { result, data: JSON.parse(result.content[0].text as string) };
  };

  const detailRequests = () =>
    get.mock.calls.filter(([url]) => /\/resources\/[^/]+$/.test(url)).length;

  beforeEach(() => {
    server = new ComputeResourcesServer();
    detailOverrides = {};
    nodeRouteLive = false;
    listedFlags = {};
    get = vi.fn(async (url: string) => {
      if (url === `${API}/resources`) {
        const resources = [aces, deltaCpu, deltaGpu, bridges, kitsune, fabric].map((resource) =>
          resource.nid in listedFlags ? { ...resource, listed: listedFlags[resource.nid] } : resource
        );
        return { status: 200, data: { count: resources.length, resources } };
      }
      if (url === `${API}/resource-groups`) {
        const groups = [
          group(12001, "ACES", [aces]),
          group(12002, "Delta", [deltaCpu, deltaGpu]),
          group(12003, "Bridges-2", [bridges]),
          group(12004, "Fabric", [fabric]),
        ];
        return { status: 200, data: { count: groups.length, groups } };
      }
      if (url === `${API}/resources/1659`) {
        return { status: 200, data: { ...acesDetail, ...detailOverrides["1659"] } };
      }
      if (url === `${API}/resources/node/801` && nodeRouteLive) {
        return { status: 200, data: { ...acesDetail, ...fabric, queue_specs: [] } };
      }
      if (url === `${API}/resources/2001`) {
        return { status: 200, data: { ...acesDetail, ...deltaCpu, queue_specs: [] } };
      }
      if (url === `${API}/resources/4001`) {
        return { status: 200, data: { ...acesDetail, ...kitsune } };
      }
      return { status: 404, data: { error: "Resource not found" } };
    });
    Object.defineProperty(server, "httpClient", { get: () => ({ get }), configurable: true });
  });

  describe("get_resource", () => {
    it("returns documented details as typed plain text", async () => {
      const { data } = await call("get_resource", { resource: "ACES" });

      expect(data).toMatchObject({
        id: "aces.tamu.access-ci.org",
        name: "ACES",
        organization: "Example University",
        status: "production",
        details_available: true,
        description: "ACES is a composable testbed & more.",
        access: { mfa_required: true, account_required: false },
        login: {
          ondemand_url: "https://portal-aces.hprc.tamu.edu/",
          ssh_hosts: [{ hostname: "login.aces.hprc.tamu.edu", recommended: false }],
        },
        file_transfer: { methods: [{ method: "Globus", recommended: true }] },
        storage: {
          filesystems: [{ name: "Home", quota_gb: 10, quota_files: 10000 }],
        },
        queues: [
          {
            name: "gpu",
            purpose: "GPU jobs",
            gpus_per_node: 8,
            gpu_memory_gb: 80,
            memory_gb: 512,
            max_wall_time_hours: 48,
          },
        ],
      });
    });

    it("keeps links in converted text", async () => {
      const { data } = await call("get_resource", { resource: "ACES" });

      expect(data.login.instructions).toContain(
        "access guide (https://hprc.tamu.edu/access)"
      );
      expect(data.login.instructions).toContain("- Use your ACCESS username.");
    });

    it("cites the group page when the resource has one", async () => {
      const { data } = await call("get_resource", { resource: "ACES" });

      expect(data.citation_url).toBe("https://support.access-ci.org/documentation/resources/aces");
      expect(data.group).toBe("ACES");
    });

    it("cites the resource page when it isn't in a group", async () => {
      const { data } = await call("get_resource", { resource: "Kitsune" });

      expect(data.citation_url).toBe(kitsune.url);
      expect(data.group).toBeNull();
    });

    it("returns missing values as null", async () => {
      const { data } = await call("get_resource", { resource: "ACES" });

      expect(data.office_hours).toBeNull();
      expect(data.datasets).toBeNull();
      expect(data.storage.external).toBeNull();
      expect(data).not.toHaveProperty("unavailable");
    });

    it("holds back wait times until the API reports the last date with data", async () => {
      const { result, data } = await call("get_resource", { resource: "ACES" });

      expect(data.wait_times).toBeNull();
      expect(result.content[0].text).not.toMatch(/17\.1|daily_wait|queue_metrics/);
    });

    it("returns wait times once the API reports the last date with data", async () => {
      detailOverrides["1659"] = {
        queue_metrics_last_data: "2026-11-05",
        queue_metrics: {
          gpu: { wait_time: 17.1, job_count: 37, daily_wait: [0, 22.8] },
          cpu: { wait_time: null, job_count: 0, daily_wait: [null] },
        },
      };

      const { result, data } = await call("get_resource", { resource: "ACES" });

      expect(data.wait_times).toEqual({
        as_of: "2026-11-05",
        queues: [
          { queue: "gpu", average_wait_hours: 17.1, job_count: 37 },
          { queue: "cpu", average_wait_hours: null, job_count: 0 },
        ],
      });
      expect(result.content[0].text).not.toContain("daily_wait");
    });

    it.each([
      ["a global resource ID", "delta-gpu.ncsa.access-ci.org", "Delta GPU"],
      ["different case and spacing", "kitsune ", "Kitsune"],
      ["a name without punctuation", "bridges2 rm", "Bridges-2 RM"],
      ["a one-member group", "Bridges-2", "Bridges-2 RM"],
      ["part of a unique name", "bridges", "Bridges-2 RM"],
    ])("finds a resource by %s", async (_label, resource, name) => {
      const { data } = await call("get_resource", { resource });

      expect(data.name ?? data.matches).toBe(name);
    });

    it.each(["Delta", "delta.ncsa.access-ci.org"])(
      "offers the members of a multi-resource group for %s",
      async (resource) => {
        const { data } = await call("get_resource", { resource });

        expect(data.matches).toEqual([
          { id: "delta-cpu.ncsa.access-ci.org", name: "Delta CPU" },
          { id: "delta-gpu.ncsa.access-ci.org", name: "Delta GPU" },
        ]);
        expect(detailRequests()).toBe(0);
      }
    );

    it("returns listing data for a resource the detail API can't reach", async () => {
      const { data } = await call("get_resource", { resource: "Fabric" });

      expect(data).toMatchObject({
        id: null,
        name: "Fabric",
        organization: "Example University",
        citation_url: "https://support.access-ci.org/documentation/resources/fabric",
        details_available: false,
        description: null,
        queues: null,
      });
    });

    it("reads details by node ID once that route exists", async () => {
      nodeRouteLive = true;

      const { data } = await call("get_resource", { resource: "Fabric" });

      expect(get).toHaveBeenCalledWith(`${API}/resources/node/801`);
      expect(data.details_available).toBe(true);
      expect(data.login.instructions).toContain("access guide");
    });

    it("leaves out a resource the API marks as not listed", async () => {
      listedFlags = { [kitsune.nid]: false, [aces.nid]: true };

      const hidden = await call("get_resource", { resource: "Kitsune" });
      const shown = await call("get_resource", { resource: "ACES" });

      expect(hidden.result.isError).toBe(true);
      expect(shown.data.name).toBe("ACES");
    });

    it("treats a listed resource missing from the detail API the same way", async () => {
      const { data } = await call("get_resource", { resource: "Delta GPU" });

      expect(data.details_available).toBe(false);
      expect(data.name).toBe("Delta GPU");
    });

    it("reports an unknown resource", async () => {
      const { result, data } = await call("get_resource", { resource: "Nonexistent" });

      expect(result.isError).toBe(true);
      expect(data.error.message).toContain("Nonexistent");
    });

    it("requires a resource", async () => {
      const { result } = await call("get_resource", {});

      expect(result.isError).toBe(true);
    });

    it("projects the response to requested fields", async () => {
      const { data } = await call("get_resource", {
        resource: "ACES",
        fields: ["name", "queues[].name"],
      });

      expect(data).toEqual({ name: "ACES", queues: [{ name: "gpu" }] });
    });

    it("reports a server failure instead of calling the resource undocumented", async () => {
      get.mockImplementation(async (url: string) =>
        url.endsWith("/1659")
          ? { status: 503, data: {} }
          : url.endsWith("/resources")
            ? { status: 200, data: { resources: [aces] } }
            : { status: 200, data: { groups: [] } }
      );

      const { result } = await call("get_resource", { resource: "ACES" });

      expect(result.isError).toBe(true);
    });
  });

  describe("caching", () => {
    it("reuses the catalog and details between calls", async () => {
      await call("get_resource", { resource: "ACES" });
      await call("get_resource", { resource: "ACES" });

      expect(get).toHaveBeenCalledTimes(3);
    });

    it("fetches again after the cache expires", async () => {
      vi.useFakeTimers();
      try {
        await call("get_resource", { resource: "ACES" });
        vi.advanceTimersByTime(10 * 60 * 1000 + 1);
        await call("get_resource", { resource: "ACES" });

        expect(get).toHaveBeenCalledTimes(6);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not keep a failed catalog request", async () => {
      const working = get.getMockImplementation()!;
      get.mockImplementationOnce(async () => ({ status: 503, data: {} }));

      const failed = await call("get_resource", { resource: "ACES" });
      get.mockImplementation(working);
      const retried = await call("get_resource", { resource: "ACES" });

      expect(failed.result.isError).toBe(true);
      expect(retried.data.name).toBe("ACES");
    });
  });

  describe("compare_resources", () => {
    it("returns the comparable facts for each resource", async () => {
      const { data } = await call("compare_resources", { resources: ["ACES", "Kitsune"] });

      expect(data.total).toBe(2);
      expect(data.items.map((item: { name: string }) => item.name)).toEqual(["ACES", "Kitsune"]);
      expect(data.items[0]).toMatchObject({
        citation_url: "https://support.access-ci.org/documentation/resources/aces",
        mfa_required: true,
        ondemand_url: "https://portal-aces.hprc.tamu.edu/",
        ssh_hosts: ["login.aces.hprc.tamu.edu"],
        transfer_methods: ["Globus"],
        queues: [{ name: "gpu", summary: expect.any(String), max_wall_time_hours: 48 }],
        filesystems: [{ name: "Home", summary: "10 GB, 10,000 files" }],
      });
      expect(data.items[0]).not.toHaveProperty("login");
    });

    it("includes a resource without details and says so", async () => {
      const { data } = await call("compare_resources", { resources: ["ACES", "Fabric"] });

      expect(data.items[1]).toMatchObject({
        name: "Fabric",
        details_available: false,
        queues: null,
      });
    });

    it("lists names it couldn't settle and still compares the rest", async () => {
      const { data } = await call("compare_resources", {
        resources: ["ACES", "Kitsune", "Delta"],
      });

      expect(data.total).toBe(2);
      expect(data.unresolved).toEqual([
        {
          resource: "Delta",
          matches: [
            { id: "delta-cpu.ncsa.access-ci.org", name: "Delta CPU" },
            { id: "delta-gpu.ncsa.access-ci.org", name: "Delta GPU" },
          ],
        },
      ]);
    });

    it("reports unknown names as unresolved", async () => {
      const { data } = await call("compare_resources", { resources: ["ACES", "Nonexistent"] });

      expect(data.unresolved).toEqual([{ resource: "Nonexistent", matches: [] }]);
    });

    it("does not compare a resource with itself", async () => {
      const { data } = await call("compare_resources", { resources: ["ACES", "aces"] });

      expect(data.total).toBe(1);
    });

    it("holds back wait times until the API reports the last date with data", async () => {
      const { result, data } = await call("compare_resources", {
        resources: ["ACES", "Kitsune"],
      });

      expect(data.items[0].wait_times).toBeNull();
      expect(result.content[0].text).not.toMatch(/17\.1|daily_wait|queue_metrics/);
    });

    it("compares wait times once the API reports the last date with data", async () => {
      detailOverrides["1659"] = {
        queue_metrics_last_data: "2026-11-05",
        queue_metrics: { gpu: { wait_time: 17.1, job_count: 37 } },
      };

      const { data } = await call("compare_resources", { resources: ["ACES", "Kitsune"] });

      expect(data.items[0].wait_times).toEqual({
        as_of: "2026-11-05",
        queues: [{ queue: "gpu", average_wait_hours: 17.1, job_count: 37 }],
      });
    });

    it.each([[["ACES"]], [["ACES", "Kitsune", "Fabric", "Delta CPU"]], [undefined]])(
      "needs two or three resources, not %j",
      async (resources) => {
        const { result } = await call("compare_resources", { resources });

        expect(result.isError).toBe(true);
      }
    );
  });
});
