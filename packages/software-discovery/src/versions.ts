/**
 * Cleans one resource's version list from the SDS index before the assistant
 * shows it. The index has entries such as " 2020.2", the same version twice,
 * the package's own name ("gromacs" on Stampede3), and a version split in two
 * ("2025.3-openmpi4.1.6-gcc12", "2" on KyRIC). The order is kept, since the
 * index lists the newest first.
 */
export function cleanVersions(
  softwareName: string,
  versions: readonly unknown[] | undefined
): string[] {
  const name = softwareName.trim().toLowerCase();
  const trimmed = (versions ?? [])
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v !== "");

  const kept: string[] = [];
  const seen = new Set<string>();
  for (const v of trimmed) {
    if (v.toLowerCase() === name || isSplitFragment(v, trimmed) || seen.has(v)) continue;
    seen.add(v);
    kept.push(v);
  }
  return kept;
}

/**
 * A bare one- or two-digit entry that begins a longer version in the same
 * list, like the "2" left over from "2025.3-openmpi4.1.6-gcc12", tells the
 * reader nothing the longer version doesn't.
 */
function isSplitFragment(v: string, all: readonly string[]): boolean {
  if (!/^\d{1,2}$/.test(v)) return false;
  return all.some(
    (other) =>
      other.length > v.length && other.startsWith(v) && /^[\d.]/.test(other.slice(v.length))
  );
}
