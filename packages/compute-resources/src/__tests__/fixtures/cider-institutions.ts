/**
 * A slice of the live CiDeR catalog (operations-api.access-ci.org, captured 2026-11-09):
 * resource groups as /wh2/cider/v1/access-active-groups/type/resource-catalog.access-ci.org/
 * returns them, with feature IDs trimmed to the resource-type ones, and organization
 * records as /wh2/cider/v1/organizations/ returns them.
 */

export const ciderFeatures = [
  { feature_id: 134, feature_name: "GPU Compute", feature_category_id: 100 },
  { feature_id: 136, feature_name: "CPU Compute", feature_category_id: 100 },
  { feature_id: 138, feature_name: "Storage", feature_category_id: 100 },
  { feature_id: 139, feature_name: "ACCESS Allocated", feature_category_id: 101 },
];

export const ciderFeatureCategories = [
  { feature_category_id: 100, feature_category_name: "Resource Type" },
  { feature_category_id: 101, feature_category_name: "Allocations" },
];

export const ciderActiveGroups = [
  {
    info_groupid: "aces.tamu.access-ci.org",
    group_descriptive_name: "ACES",
    group_description:
      "Accelerating Computing for Emerging Sciences (ACES) is a NSF-Category II-funded test bed (award number 2112356) that offers state of the art GPUs and other novel accelerators in a composable environment.",
    rollup_organization_ids: [467],
    rollup_feature_ids: [134, 136, 139],
    rollup_info_resourceids: ["aces.tamu.access-ci.org"],
  },
  {
    info_groupid: "voyager.sdsc.access-ci.org",
    group_descriptive_name: "Voyager",
    group_description:
      "Voyager is an innovative AI system designed specifically for science and engineering research at scale. Voyager is focused on supporting research in science and engineering that is increasingly dependent upon artificial intelligence and deep learning as a critical element in the experimental and/or computational work.",
    rollup_organization_ids: [856],
    rollup_feature_ids: [139],
    rollup_info_resourceids: ["voyager.sdsc.access-ci.org"],
  },
  {
    info_groupid: "repacss.ttu.access-ci.org",
    group_descriptive_name: "REPACSS",
    group_description:
      "The focus of the REPACSS project is on improvements to data center and infrastructure control to provide adaptability to emergent conditions and ability to adjust workloads to match data center load conditions including the availability and cost of electrical power. REPACSS also features advanced remote management capabilities and automation tools to manage scientific workflows that are specifically targeted to be adopted at scale by other resource facilities and industry.",
    rollup_organization_ids: [471],
    rollup_feature_ids: [134, 136, 139],
    rollup_info_resourceids: ["repacss-cpu.ttu.access-ci.org", "repacss-gpu.ttu.access-ci.org"],
  },
  {
    info_groupid: "bridges2.psc.access-ci.org",
    group_descriptive_name: "Bridges-2",
    group_description:
      "Bridges-2, a resource of Pittsburgh Supercomputing Center, is designed for converged HPC + AI + Data. Its custom topology is optimized for data-centric HPC, AI, and HPDA (High Performance Data Analytics). An extremely flexible software environment along with community data collections and BDaaS (Big Data as a Service) provide the tools necessary for modern pioneering research. The data management system, Ocean, consists of two-tiers, disk and tape, transparently managed as a single, highly usable namespace.",
    rollup_organization_ids: [848],
    rollup_feature_ids: [134, 136, 138, 139],
    rollup_info_resourceids: [
      "bridges2-em.psc.access-ci.org",
      "bridges2-gpu.psc.access-ci.org",
      "bridges2-rm.psc.access-ci.org",
      "bridges2-ocean.psc.access-ci.org",
      "bil.psc.access-ci.org",
    ],
  },
  {
    info_groupid: "stampede3.tacc.access-ci.org",
    group_descriptive_name: "Stampede3",
    group_description:
      "Stampede3 is generously funded through the National Science Foundation and is designed to serve today's researchers as well as support the research community on an evolutionary path toward many-core processors and accelerated technologies. Stampede 3 maintains the familiar programming model for all of today's users, and thus will be broadly useful for traditional simulation users, users performing data intensive computations, and emerging classes of new users.",
    rollup_organization_ids: [2058, 476],
    rollup_feature_ids: [134, 136, 139],
    rollup_info_resourceids: ["stampede3.tacc.access-ci.org"],
  },
  {
    info_groupid: "jetstream2.indiana.access-ci.org",
    group_descriptive_name: "Jetstream2",
    group_description:
      "Jetstream2 is a transformative update to the NSF\u2019s science and engineering cloud infrastructure and provides 8 petaFLOPS of supercomputing power to simplify data analysis, boost discovery, and increase availability of AI resources. It is an NSF-funded, user-friendly cloud environment designed to allow \u201calways on\u201d research infrastructure and to give researchers access to interactive computing and data analysis resources on demand, whenever and wherever they want to analyze their data.",
    rollup_organization_ids: [561],
    rollup_feature_ids: [134, 136, 138, 139],
    rollup_info_resourceids: [
      "jetstream2.indiana.access-ci.org",
      "jetstream2-gpu.indiana.access-ci.org",
      "jetstream2-lm.indiana.access-ci.org",
      "jetstream2-storage.indiana.access-ci.org",
    ],
  },
  {
    info_groupid: "anvil.purdue.access-ci.org",
    group_descriptive_name: "Anvil",
    group_description:
      "Purdue University is the home of Anvil, a powerful new supercomputer that provides advanced computing capabilities to support a wide range of computational and data-intensive research spanning from traditional high-performance computing to modern artificial intelligence applications.",
    rollup_organization_ids: [1869],
    rollup_feature_ids: [134, 136, 139],
    rollup_info_resourceids: [
      "anvil.purdue.access-ci.org",
      "anvil-gpu.purdue.access-ci.org",
      "anvil-ai.purdue.access-ci.org",
      "anvil-notebook.purdue.access-ci.org",
      "anvil-cloud.purdue.access-ci.org",
    ],
  },
  {
    info_groupid: "expanse.sdsc.access-ci.org",
    group_descriptive_name: "Expanse",
    group_description:
      "Expanse is a dedicated ACCESS cluster designed by Dell and SDSC delivering 5.16 peak petaflops, and will offer Composable Systems and Cloud Bursting.",
    rollup_organization_ids: [856],
    rollup_feature_ids: [134, 136, 138, 139],
    rollup_info_resourceids: [
      "expanse.sdsc.access-ci.org",
      "expanse-gpu.sdsc.access-ci.org",
      "expanse-ps.sdsc.access-ci.org",
      "expanse-air.sdsc.access-ci.org",
    ],
  },
  {
    info_groupid: "launch.tamu.access-ci.org",
    group_descriptive_name: "Launch",
    group_description:
      "Launch is a Dell cluster with AMD EPYC Genoa 9654 processors and NVIDIA A30 GPUs. The compute nodes are interconnected with HDR100 InfiniBand connections for MPI and access to the NFS storage.",
    rollup_organization_ids: [467],
    rollup_feature_ids: [134, 136, 139],
    rollup_info_resourceids: ["launch.tamu.access-ci.org"],
  },
  {
    info_groupid: "delta.ncsa.access-ci.org",
    group_descriptive_name: "Delta",
    group_description:
      "Delta is a dedicated, ACCESS-allocated resource designed by HPE and NCSA, delivering a highly capable GPU-focused compute environment for GPU and CPU workloads.",
    rollup_organization_ids: [844],
    rollup_feature_ids: [134, 136, 139],
    rollup_info_resourceids: ["delta-cpu.ncsa.access-ci.org", "delta-gpu.ncsa.access-ci.org"],
  },
  {
    info_groupid: "deltaai.ncsa.access-ci.org",
    group_descriptive_name: "DeltaAI",
    group_description:
      "DeltaAI is a new resource that targets the computational needs of Artificial Intelligence/Machine Learning (AI/ML) workloads.",
    rollup_organization_ids: [844],
    rollup_feature_ids: [134, 139],
    rollup_info_resourceids: ["deltaai.ncsa.access-ci.org"],
  },
];

/** Records from /wh2/cider/v1/organizations/. */
export const ciderOrganizations = [
  {
    organization_id: 848,
    organization_name: "Pittsburgh Supercomputing Center",
    organization_abbrev: "PSC",
    organization_url: "https://www.psc.edu",
  },
  {
    organization_id: 856,
    organization_name: "San Diego Supercomputer Center",
    organization_abbrev: "SDSC",
    organization_url: "https://www.sdsc.edu",
  },
  {
    organization_id: 2058,
    organization_name: "Texas Advanced Computing Center",
    organization_abbrev: "TACC",
    organization_url: "https://www.tacc.utexas.edu/",
  },
  {
    organization_id: 471,
    organization_name: "Texas Tech University",
    organization_abbrev: "Texas Tech U",
    organization_url: "https://www.ttu.edu",
  },
  {
    organization_id: 476,
    organization_name: "University of Texas at Austin",
    organization_abbrev: "UT Austin",
    organization_url: "",
  },
  {
    organization_id: 561,
    organization_name: "Indiana University",
    organization_abbrev: "Indiana U",
    organization_url: "https://pti.iu.edu/",
  },
  {
    organization_id: 467,
    organization_name: "Texas A&M University",
    organization_abbrev: "Texas A&M U",
    organization_url: "https://hprc.tamu.edu",
  },
  {
    organization_id: 1869,
    organization_name: "Purdue University",
    organization_abbrev: "Purdue U",
    organization_url: "",
  },
  {
    organization_id: 844,
    organization_name: "National Center for Supercomputing Applications",
    organization_abbrev: "NCSA",
    organization_url: "http://www.ncsa.illinois.edu/",
  },
];

/** The organizations block embedded in the catalog response. */
export const ciderEmbeddedOrganizations = [
  {
    organization_id: 848,
    organization_name: "Pittsburgh Supercomputing Center",
    organization_abbreviation: "PSC",
    organization_url: "https://www.psc.edu",
  },
  {
    organization_id: 856,
    organization_name: "San Diego Supercomputer Center",
    organization_abbreviation: "SDSC",
    organization_url: "https://www.sdsc.edu",
  },
  {
    organization_id: 2058,
    organization_name: "Texas Advanced Computing Center",
    organization_abbreviation: "TACC",
    organization_url: "https://www.tacc.utexas.edu/",
  },
  {
    organization_id: 471,
    organization_name: "Texas Tech University",
    organization_abbreviation: "Texas Tech U",
    organization_url: "https://www.ttu.edu",
  },
  {
    organization_id: 476,
    organization_name: "University of Texas at Austin",
    organization_abbreviation: "UT Austin",
    organization_url: "",
  },
  {
    organization_id: 561,
    organization_name: "Indiana University",
    organization_abbreviation: "Indiana U",
    organization_url: "https://pti.iu.edu/",
  },
  {
    organization_id: 467,
    organization_name: "Texas A&M University",
    organization_abbreviation: "Texas A&M U",
    organization_url: "https://hprc.tamu.edu",
  },
  {
    organization_id: 1869,
    organization_name: "Purdue University",
    organization_abbreviation: "Purdue U",
    organization_url: "",
  },
  {
    organization_id: 844,
    organization_name: "National Center for Supercomputing Applications",
    organization_abbreviation: "NCSA",
    organization_url: "http://www.ncsa.illinois.edu/",
  },
];

export const ciderCatalogResponse = {
  results: {
    active_groups: ciderActiveGroups,
    features: ciderFeatures,
    feature_categories: ciderFeatureCategories,
    organizations: ciderEmbeddedOrganizations,
  },
};

export const ciderOrganizationsResponse = { results: ciderOrganizations, status_code: 200 };
