import assert from "node:assert/strict";
import test from "node:test";
import { sortRemotePackages } from "../src/packages/sorting.js";

void test("remote package sorting supports name and recent modes without mutating results", () => {
  const packages = [
    { name: "zeta", date: "2026-01-01" },
    { name: "alpha", date: "2026-03-01" },
  ];
  assert.deepEqual(
    sortRemotePackages(packages, "name").map((pkg) => pkg.name),
    ["alpha", "zeta"]
  );
  assert.deepEqual(
    sortRemotePackages(packages, "recent").map((pkg) => pkg.name),
    ["alpha", "zeta"]
  );
  assert.equal(packages[0]?.name, "zeta");
});
