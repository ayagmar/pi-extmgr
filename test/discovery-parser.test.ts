import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getInstalledPackages,
  isSourceInstalled,
  parseInstalledPackagesOutput,
  parseInstalledPackagesOutputAllScopes,
} from "../src/packages/discovery.js";
import { isPackageSource, normalizePackageSource, parseNpmSource } from "../src/utils/format.js";
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

void test("isSourceInstalled matches exact package sources (no substring false positives)", async () => {
  const { pi, ctx } = createMockHarness({
    execImpl: (command, args) => {
      if (command === "pi" && args[0] === "list") {
        return {
          code: 0,
          stdout: "Global:\n  npm:demo-package-two@1.0.0\n",
          stderr: "",
          killed: false,
        };
      }
      return { code: 1, stdout: "", stderr: "unexpected", killed: false };
    },
  });

  assert.equal(await isSourceInstalled("npm:demo-package", ctx, pi), false);
  assert.equal(await isSourceInstalled("npm:demo-package-two@1.0.0", ctx, pi), true);
});

void test("isSourceInstalled supports scope-aware checks", async () => {
  const { pi, ctx } = createMockHarness({
    execImpl: (command, args) => {
      if (command === "pi" && args[0] === "list") {
        return {
          code: 0,
          stdout: "Global:\n  npm:demo-package@1.0.0\nProject:\n  npm:demo-package@1.0.0\n",
          stderr: "",
          killed: false,
        };
      }
      return { code: 1, stdout: "", stderr: "unexpected", killed: false };
    },
  });

  assert.equal(
    await isSourceInstalled("npm:demo-package@1.0.0", ctx, pi, { scope: "global" }),
    true
  );
  assert.equal(
    await isSourceInstalled("npm:demo-package@1.0.0", ctx, pi, { scope: "project" }),
    true
  );
});

void test("isSourceInstalled keeps case-sensitive local paths distinct", async () => {
  const { pi, ctx } = createMockHarness({
    execImpl: (command, args) => {
      if (command === "pi" && args[0] === "list") {
        return {
          code: 0,
          stdout: "Global:\n  /opt/extensions/Foo/index.ts\n",
          stderr: "",
          killed: false,
        };
      }
      return { code: 1, stdout: "", stderr: "unexpected", killed: false };
    },
  });

  assert.equal(await isSourceInstalled("/opt/extensions/Foo/index.ts", ctx, pi), true);
  assert.equal(await isSourceInstalled("/opt/extensions/foo/index.ts", ctx, pi), false);
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

void test("parseInstalledPackagesOutput parses git@ ssh sources without git: prefix", () => {
  const input = `
Global:
  git@github.com:user/super-ext.git@v1
`;

  const result = parseInstalledPackagesOutput(input);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, "super-ext");
});

void test("parseInstalledPackagesOutput parses ssh:// sources without git: prefix", () => {
  const input = `
Global:
  ssh://git@github.com/user/super-ext.git@v1
`;

  const result = parseInstalledPackagesOutput(input);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, "super-ext");
});

void test("parseInstalledPackagesOutput parses git:// sources", () => {
  const input = `
Global:
  git://github.com/user/super-ext.git
`;

  const result = parseInstalledPackagesOutput(input);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, "super-ext");
});

void test("normalizePackageSource preserves git and local path sources", () => {
  assert.equal(
    normalizePackageSource("git@github.com:user/repo.git"),
    "git:git@github.com:user/repo.git"
  );
  assert.equal(
    normalizePackageSource("ssh://git@github.com/user/repo.git"),
    "ssh://git@github.com/user/repo.git"
  );
  assert.equal(
    normalizePackageSource("git+https://github.com/user/repo.git"),
    "git+https://github.com/user/repo.git"
  );
  assert.equal(normalizePackageSource("~/dev/ext"), "~/dev/ext");
  assert.equal(normalizePackageSource(".\\extensions\\demo"), ".\\extensions\\demo");
  assert.equal(normalizePackageSource("@scope/pkg"), "npm:@scope/pkg");
});

void test("normalizePackageSource unwraps quoted sources", () => {
  assert.equal(
    normalizePackageSource('"./extensions/My Cool Extension.ts"'),
    "./extensions/My Cool Extension.ts"
  );
  assert.equal(normalizePackageSource("'@scope/pkg'"), "npm:@scope/pkg");
});

void test("isPackageSource recognizes git ssh and local path sources", () => {
  assert.equal(isPackageSource("git@github.com:user/repo.git"), true);
  assert.equal(isPackageSource("ssh://git@github.com/user/repo.git"), true);
  assert.equal(isPackageSource("git+https://github.com/user/repo.git"), true);
  assert.equal(isPackageSource("~/dev/ext"), true);
  assert.equal(isPackageSource(".\\extensions\\demo"), true);
  assert.equal(isPackageSource("pi-extmgr"), false);
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
  assert.equal(getPackageSourceKind("git+https://github.com/user/repo.git"), "git");
  assert.equal(getPackageSourceKind("git://github.com/user/repo.git"), "git");
  assert.equal(getPackageSourceKind("git@github.com:user/repo"), "git");
  assert.equal(getPackageSourceKind("./vendor/demo"), "local");
  assert.equal(getPackageSourceKind(".\\vendor\\demo"), "local");
  assert.equal(getPackageSourceKind("file:///opt/pi/pkg"), "local");
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
