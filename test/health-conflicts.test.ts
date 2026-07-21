import assert from "node:assert/strict";
import test from "node:test";
import { type RuntimeConflict } from "../src/doctor/conflicts.js";
import {
  findConflictLocalOwners,
  findConflictPackageOwners,
  planSafeConflictFixes,
} from "../src/ui/health.js";
import { type ExtensionEntry, type InstalledPackage } from "../src/types/index.js";

function conflictWith(owners: Array<Partial<RuntimeConflict["owners"][number]>>): RuntimeConflict {
  return {
    kind: "command",
    name: "demo",
    owners: owners.map((owner) => ({
      kind: "command" as const,
      name: "demo",
      source: owner.source ?? "unknown",
      scope: owner.scope ?? "user",
      origin: owner.origin ?? "package",
      path: owner.path ?? "/nowhere",
    })),
  };
}

const npmPackage: InstalledPackage = {
  source: "npm:demo-pkg@1.2.3",
  name: "demo-pkg",
  version: "1.2.3",
  scope: "global",
  resolvedPath: "/home/user/.pi/agent/npm/node_modules/demo-pkg",
};

void test("conflict package owners match source, name, identity, and path containment", () => {
  // Exact source string
  assert.equal(
    findConflictPackageOwners(conflictWith([{ source: "npm:demo-pkg@1.2.3" }]), [npmPackage])
      .length,
    1
  );
  // Bare package name (Pi sourceInfo.source often carries the package name)
  assert.equal(
    findConflictPackageOwners(conflictWith([{ source: "demo-pkg" }]), [npmPackage]).length,
    1
  );
  // Version-suffix / case variants through normalized identity
  assert.equal(
    findConflictPackageOwners(conflictWith([{ source: "npm:Demo-Pkg" }]), [npmPackage]).length,
    1
  );
  // Entrypoint path inside the package install directory
  assert.equal(
    findConflictPackageOwners(
      conflictWith([
        {
          source: "something-else",
          path: "/home/user/.pi/agent/npm/node_modules/demo-pkg/extensions/index.ts",
        },
      ]),
      [npmPackage]
    ).length,
    1
  );
  // Unrelated owner does not match
  assert.equal(
    findConflictPackageOwners(
      conflictWith([{ source: "npm:other", path: "/elsewhere/entry.ts" }]),
      [npmPackage]
    ).length,
    0
  );
});

const localEntry: ExtensionEntry = {
  id: "project:/repo/.pi/extensions/demo.ts",
  scope: "project",
  state: "enabled",
  activePath: "/repo/.pi/extensions/demo.ts",
  disabledPath: "/repo/.pi/extensions/demo.ts.disabled",
  displayName: "project/demo.ts",
  summary: "demo",
};

void test("conflict local owners match active and disabled paths from either owner field", () => {
  assert.equal(
    findConflictLocalOwners(conflictWith([{ path: "/repo/.pi/extensions/demo.ts" }]), [localEntry])
      .length,
    1
  );
  assert.equal(
    findConflictLocalOwners(conflictWith([{ source: "/repo/.pi/extensions/demo.ts.disabled" }]), [
      localEntry,
    ]).length,
    1
  );
  assert.equal(
    findConflictLocalOwners(conflictWith([{ path: "/other/entry.ts" }]), [localEntry]).length,
    0
  );
});

void test("safe conflict fixes only disable enabled local extensions shadowing packages", () => {
  const conflict: RuntimeConflict = {
    kind: "command",
    name: "demo",
    owners: [
      {
        kind: "command",
        name: "demo",
        source: "npm:demo-pkg@1.2.3",
        scope: "user",
        origin: "package",
        path: "/home/user/.pi/agent/npm/node_modules/demo-pkg/extensions/index.ts",
      },
      {
        kind: "command",
        name: "demo",
        source: "/repo/.pi/extensions/demo.ts",
        scope: "project",
        origin: "top-level",
        path: "/repo/.pi/extensions/demo.ts",
      },
    ],
  };

  const fixes = planSafeConflictFixes([conflict], [localEntry]);
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0]?.extension.activePath, localEntry.activePath);
  assert.ok(fixes[0]?.conflict.includes("command demo"));

  // Already-disabled local extensions are not re-fixed.
  const disabledEntry = { ...localEntry, state: "disabled" as const };
  assert.equal(planSafeConflictFixes([conflict], [disabledEntry]).length, 0);

  // Conflicts without a package owner never yield automatic fixes.
  const localOnlyConflict: RuntimeConflict = {
    ...conflict,
    owners: conflict.owners.map((owner) => ({ ...owner, origin: "top-level" as const })),
  };
  assert.equal(planSafeConflictFixes([localOnlyConflict], [localEntry]).length, 0);

  // The same extension is only fixed once across multiple conflicts.
  assert.equal(
    planSafeConflictFixes([conflict, { ...conflict, name: "demo2" }], [localEntry]).length,
    1
  );
});
