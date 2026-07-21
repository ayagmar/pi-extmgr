import assert from "node:assert/strict";
import test from "node:test";
import { sortRemotePackages } from "../src/packages/sorting.js";

void test("remote package sorting supports name, popularity, and recent modes without mutation", () => {
  const packages = [
    { name: "zeta", date: "2026-01-01", weeklyDownloads: 42_000 },
    { name: "alpha", date: "2026-03-01", weeklyDownloads: 120 },
  ];
  assert.deepEqual(
    sortRemotePackages(packages, "name").map((pkg) => pkg.name),
    ["alpha", "zeta"]
  );
  assert.deepEqual(
    sortRemotePackages(packages, "recent").map((pkg) => pkg.name),
    ["alpha", "zeta"]
  );
  assert.deepEqual(
    sortRemotePackages(packages, "popular").map((pkg) => pkg.name),
    ["zeta", "alpha"]
  );
  assert.deepEqual(
    sortRemotePackages(packages, "downloads").map((pkg) => pkg.name),
    ["zeta", "alpha"]
  );
  assert.equal(packages[0]?.name, "zeta");
});

void test("download sorting preserves registry relevance while metrics are unknown or tied", () => {
  const packages = [{ name: "zeta" }, { name: "alpha" }, { name: "middle", weeklyDownloads: 20 }];
  assert.deepEqual(
    sortRemotePackages(packages, "popular").map((pkg) => pkg.name),
    ["middle", "zeta", "alpha"]
  );
  assert.deepEqual(
    sortRemotePackages(
      [
        { name: "zeta", weeklyDownloads: 10 },
        { name: "alpha", weeklyDownloads: 10 },
      ],
      "popular"
    ).map((pkg) => pkg.name),
    ["zeta", "alpha"]
  );
});
