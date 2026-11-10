/**
 * Names a person might use for the institution that provides a resource.
 *
 * People ask about "TAMU" or "Texas A&M", not "Texas A&M University", and the
 * resource text rarely spells the institution out, so search has to know an
 * organization's short forms. Most come from the CiDeR organization record
 * (its abbreviation and website); the table below adds the well-known short
 * names that record doesn't carry.
 */

export interface OrganizationRecord {
  organization_id?: number;
  organization_name?: string;
  organization_abbrev?: string;
  organization_abbreviation?: string;
  organization_url?: string | null;
}

/**
 * Well-known short names, keyed by short name, listing the organization names
 * (as CiDeR spells them) they stand for. Also used to expand an abbreviation
 * passed as the organization filter.
 */
export const ORG_ABBREVIATIONS: Record<string, string[]> = {
  // Major HPC/Supercomputing Centers
  NCSA: ["National Center for Supercomputing Applications", "Illinois"],
  SDSC: ["San Diego Supercomputer Center"],
  PSC: ["Pittsburgh Supercomputing Center"],
  TACC: ["Texas Advanced Computing Center"],
  NCAR: [
    "NSF National Center for Atmospheric Research",
    "National Center for Atmospheric Research",
  ],
  NERSC: ["National Energy Research Scientific Computing Center"],
  ALCF: ["Argonne Leadership Computing Facility"],
  OLCF: ["Oak Ridge Leadership Computing Facility"],
  SBSC: ["Stony Brook Supercomputing Center"],
  "Stony Brook": ["Stony Brook Supercomputing Center"],

  // Universities (common abbreviations)
  IU: ["Indiana University"],
  UK: ["University of Kentucky"],
  UKY: ["University of Kentucky"],
  TAMU: ["Texas A&M University", "Texas A&M"],
  "Texas A&M": ["Texas A&M University"],
  Purdue: ["Purdue University"],
  UT: ["University of Texas at Austin"],
  "UT Austin": ["University of Texas at Austin"],
  TTU: ["Texas Tech University"],
  "Georgia Tech": ["Georgia Institute of Technology"],
  GT: ["Georgia Institute of Technology"],
  OSU: ["Ohio State University"],
  ASU: ["Arizona State University"],
  FSU: ["Florida State University"],
  PSU: ["Pennsylvania State University", "Penn State"],
  MSU: ["Michigan State University"],
  USC: ["University of Southern California"],
  UCLA: ["University of California, Los Angeles"],
  UIUC: ["University of Illinois at Urbana-Champaign", "Illinois"],
  MIT: ["Massachusetts Institute of Technology"],
  CU: ["University of Colorado"],
  "CU Boulder": ["University of Colorado Boulder"],
  UChicago: ["University of Chicago"],

  // Research Computing Consortia & Networks
  OSG: ["OSG Consortium", "Open Science Grid"],
  OSN: ["Open Storage Network"],
  SGCI: ["Science Gateways Center of Excellence", "Science Gateways Community Institute"],
  RENCI: ["Renaissance Computing Institute"],
  ACCESS: ["ACCESS Support", "Advanced Cyberinfrastructure Coordination Ecosystem"],
  XSEDE: ["Extreme Science and Engineering Discovery Environment"], // Legacy
};

/**
 * Short names for a center that CiDeR lists under its own name rather than its
 * host university, so "Illinois" finds NCSA and "UT Austin" finds TACC.
 */
const HOST_INSTITUTION_NAMES: Record<string, string[]> = {
  "National Center for Supercomputing Applications": [
    "Illinois",
    "UIUC",
    "University of Illinois",
    "University of Illinois Urbana-Champaign",
  ],
  "San Diego Supercomputer Center": ["UCSD", "UC San Diego"],
  "Pittsburgh Supercomputing Center": ["Carnegie Mellon", "CMU", "University of Pittsburgh"],
  "Texas Advanced Computing Center": ["UT Austin", "University of Texas at Austin"],
};

/** Website labels that name a hosting service, not an institution. */
const GENERIC_DOMAIN_LABELS = new Set(["access ci", "www"]);

/** Lowercase, "&" as "and", and punctuation as single spaces: "Texas A&M" -> "texas a and m". */
export function normalizeInstitutionText(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The registrable label of a website: "https://hprc.tamu.edu" -> "tamu". */
function domainLabel(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  const labels = host.split(".").filter(Boolean);
  return labels.length >= 2 ? labels[labels.length - 2] : undefined;
}

/**
 * The institution label of an ACCESS resource ID: "aces.tamu.access-ci.org" -> "tamu",
 * "fabric.renci.org" -> "renci". Resource IDs with no such label ("osg.access-ci.org")
 * give nothing.
 */
export function resourceIdInstitutionLabel(resourceId: unknown): string | undefined {
  if (typeof resourceId !== "string") return undefined;
  const labels = resourceId.split(".").filter(Boolean);
  if (labels.length < 3) return undefined;
  const label = normalizeInstitutionText(labels[1]);
  return label && !GENERIC_DOMAIN_LABELS.has(label) ? label : undefined;
}

/** An abbreviation's spelled-out short form: "Texas A&M U" -> "Texas A&M", "NSF NCAR" -> "NCAR". */
function abbreviationShortForms(abbrev: string): string[] {
  const forms = [abbrev];
  const withoutU = abbrev.replace(/^U\s+/, "").replace(/\s+U$/, "");
  if (withoutU !== abbrev) forms.push(withoutU);
  const withoutNsf = abbrev.replace(/^NSF\s+/, "");
  if (withoutNsf !== abbrev) forms.push(withoutNsf);
  return forms;
}

/** Every normalized name an organization goes by. */
export function organizationAliases(org: OrganizationRecord): string[] {
  const raw: string[] = [];
  const name = org.organization_name;
  if (name) {
    raw.push(name);
    const withoutNsf = name.replace(/^NSF\s+/, "");
    if (withoutNsf !== name) raw.push(withoutNsf);
    raw.push(...(HOST_INSTITUTION_NAMES[name] ?? []));
    const normalizedName = normalizeInstitutionText(name);
    for (const [short, names] of Object.entries(ORG_ABBREVIATIONS)) {
      if (names.some((n) => normalizeInstitutionText(n) === normalizedName)) raw.push(short);
    }
  }
  for (const abbrev of [org.organization_abbrev, org.organization_abbreviation]) {
    if (abbrev) raw.push(...abbreviationShortForms(abbrev));
  }
  const label = domainLabel(org.organization_url);
  if (label) raw.push(label);

  const aliases = new Set<string>();
  for (const value of raw) {
    const normalized = normalizeInstitutionText(value);
    if (normalized && !GENERIC_DOMAIN_LABELS.has(normalized)) aliases.add(normalized);
  }
  return [...aliases];
}

/**
 * Whether a search term names one of these institution aliases. A term matches an
 * alias it equals (ignoring case, punctuation and spacing, so "Georgia Tech" and
 * "GeorgiaTech" both work) or a whole-word run of a longer alias ("Texas A&M" in
 * "texas a and m university"). Short terms only match exactly, so "UT" doesn't
 * match every name that contains a "ut".
 */
export function matchesInstitution(aliases: string[], term: string): boolean {
  const q = normalizeInstitutionText(term);
  if (!q) return false;
  const squashed = q.replace(/ /g, "");
  return aliases.some(
    (alias) =>
      alias === q ||
      alias.replace(/ /g, "") === squashed ||
      (q.length >= 3 && ` ${alias} `.includes(` ${q} `))
  );
}
