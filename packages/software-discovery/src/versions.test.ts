import { describe, it, expect } from "vitest";
import { cleanVersions } from "./versions.js";

describe("cleanVersions", () => {
  it("drops a bare fragment left from a split version", () => {
    expect(cleanVersions("gromacs", ["2025.3-openmpi4.1.6-gcc12", "2"])).toEqual([
      "2025.3-openmpi4.1.6-gcc12",
    ]);
  });

  it("keeps a short version that doesn't begin a longer one", () => {
    expect(cleanVersions("r", ["4.3", "3"])).toEqual(["4.3", "3"]);
    expect(cleanVersions("perl", ["5"])).toEqual(["5"]);
  });

  it("keeps a two-digit version when the longer one only shares a digit", () => {
    expect(cleanVersions("gcc", ["12.2", "1"])).toEqual(["12.2"]);
    expect(cleanVersions("gcc", ["12.2", "11"])).toEqual(["12.2", "11"]);
  });

  it("drops the package's own name in any case", () => {
    expect(cleanVersions("GROMACS", ["gromacs"])).toEqual([]);
    expect(cleanVersions("gromacs", ["GROMACS ", "2024.1"])).toEqual(["2024.1"]);
  });

  it("trims, drops blanks and non-strings, and removes repeats in order", () => {
    expect(
      cleanVersions("x", ["2021.2", "2021.2", "", "  ", " 2020.2", null, 7, "2021.2"])
    ).toEqual(["2021.2", "2020.2"]);
  });

  it("handles a missing list", () => {
    expect(cleanVersions("x", undefined)).toEqual([]);
  });
});
