import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getInstalledPackages,
  parseInstalledPackagesOutput,
  parseInstalledPackagesOutputAllScopes,
} from "../src/packages/discovery.js";
import { parseNpmSource } from "../src/utils/format.js";
import { getPackageSourceKind } from "../src/utils/package-source.js";
import { createMockHarness } from "./helpers/mocks.js";

void test("parseInstalledPackagesOutput parses scopes, names, versions, and resolved path lines", () => {
  const input = `
User packages:
  npm:pi-extmgr@0.1.4
Project packages:
  git:https://github.com/user/repo.git@main (filtered)
    resolved: /tmp/.pi/git/github.com/user/repo
  /home/user/.fnm/node_modules/local-pkg
    /tmp/.pi/npm/local-pkg
`;

  const result = parseInstalledPackagesOutput(input);

  assert.equal(result.length, 3);

  assert.deepEqual(result[0], {
    source: "npm:pi-extmgr@0.1.4",
    name: "pi-extmgr",
    version: "0.1.4",
    scope: "global",
  });

  assert.deepEqual(result[1], {
    source: "git:https://github.com/user/repo.git@main",
    name: "repo",
    scope: "project",
    resolvedPath: "/tmp/.pi/git/github.com/user/repo",
  });

  assert.deepEqual(result[2], {
    source: "/home/user/.fnm/node_modules/local-pkg",
    name: "local-pkg",
    scope: "project",
    resolvedPath: "/tmp/.pi/npm/local-pkg",
  });
});

void test("parseInstalledPackagesOutput deduplicates by normalized source", () => {
  const input = `
Global:
  npm:dup-pkg@1.0.0
  npm:dup-pkg@1.0.0 (filtered)
`;

  const result = parseInstalledPackagesOutput(input);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.source, "npm:dup-pkg@1.0.0");
});

void test("parseInstalledPackagesOutputAllScopes keeps duplicates across scopes", () => {
  const input = `
Global:
  npm:dup-pkg@1.0.0
Project:
  npm:dup-pkg@1.0.0
`;

  const result = parseInstalledPackagesOutputAllScopes(input);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.scope, "global");
  assert.equal(result[1]?.scope, "project");
});

void test("parseInstalledPackagesOutput parses ssh git sources", () => {
  const input = `
Global:
  git:git@github.com:user/super-ext.git@v1
`;

  const result = parseInstalledPackagesOutput(input);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, "super-ext");
});

void test("parseInstalledPackagesOutput parses https git sources without git: prefix", () => {
  const input = `
Global:
  https://github.com/user/super-ext.git@v1
`;

  const result = parseInstalledPackagesOutput(input);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, "super-ext");
});

void test("parseNpmSource parses scoped and unscoped package specs", () => {
  assert.deepEqual(parseNpmSource("npm:demo@1.2.3"), { name: "demo", version: "1.2.3" });
  assert.deepEqual(parseNpmSource("npm:@scope/demo@1.2.3"), {
    name: "@scope/demo",
    version: "1.2.3",
  });
  assert.deepEqual(parseNpmSource("npm:@scope/demo"), { name: "@scope/demo" });
  assert.equal(parseNpmSource("git:https://example.com/repo.git"), undefined);
});

void test("getPackageSourceKind classifies npm/git/local sources", () => {
  assert.equal(getPackageSourceKind("npm:pi-extmgr"), "npm");
  assert.equal(getPackageSourceKind("git:https://github.com/user/repo.git@main"), "git");
  assert.equal(getPackageSourceKind("https://github.com/user/repo@main"), "git");
  assert.equal(getPackageSourceKind("git@github.com:user/repo"), "git");
  assert.equal(getPackageSourceKind("./vendor/demo"), "local");
  assert.equal(getPackageSourceKind("/opt/pi/pkg"), "local");
});

void test("getInstalledPackages hydrates version from resolved package.json when source has no inline version", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-discovery-"));

  try {
    const installedPath = join(root, "node_modules", "pi-extmgr");
    await mkdir(installedPath, { recursive: true });
    await writeFile(
      join(installedPath, "package.json"),
      `${JSON.stringify(
        {
          name: "pi-extmgr",
          version: "0.1.10",
          description: "Enhanced UX for managing local Pi extensions",
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const listOutput = `User packages:\n  npm:pi-extmgr\n    ${installedPath}\n`;

    const { pi, ctx } = createMockHarness({
      cwd: root,
      execImpl: (command, args) => {
        if (command === "pi" && args[0] === "list") {
          return { code: 0, stdout: listOutput, stderr: "", killed: false };
        }

        if (command === "npm" && args[0] === "view" && args[2] === "dist.unpackedSize") {
          return { code: 0, stdout: "173693", stderr: "", killed: false };
        }

        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    });

    const result = await getInstalledPackages(ctx, pi);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.source, "npm:pi-extmgr");
    assert.equal(result[0]?.version, "0.1.10");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
