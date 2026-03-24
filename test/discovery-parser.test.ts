import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getInstalledPackages, isSourceInstalled } from "../src/packages/discovery.js";
import { isPackageSource, normalizePackageSource, parseNpmSource } from "../src/utils/format.js";
import { getPackageSourceKind, normalizePackageIdentity } from "../src/utils/package-source.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

void test("getInstalledPackages reads structured package records and keeps project precedence", async () => {
  const restoreCatalog = mockPackageCatalog({
    packages: [
      {
        source: "git:https://github.com/user/repo.git@v2",
        name: "repo",
        scope: "project",
        resolvedPath: "/tmp/.pi/git/github.com/user/repo",
      },
      {
        source: "npm:pi-extmgr@0.1.4",
        name: "pi-extmgr",
        version: "0.1.4",
        scope: "global",
      },
      {
        source: "git:https://github.com/user/repo.git@v1",
        name: "repo",
        scope: "global",
      },
    ],
  });

  try {
    const { pi, ctx } = createMockHarness();
    const result = await getInstalledPackages(ctx, pi);

    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
      source: "git:https://github.com/user/repo.git@v2",
      name: "repo",
      scope: "project",
      resolvedPath: "/tmp/.pi/git/github.com/user/repo",
      description: "git repository",
    });
    assert.equal(result[1]?.source, "npm:pi-extmgr@0.1.4");
    assert.equal(result[1]?.name, "pi-extmgr");
    assert.equal(result[1]?.version, "0.1.4");
    assert.equal(result[1]?.scope, "global");
  } finally {
    restoreCatalog();
  }
});

void test("isSourceInstalled matches exact package sources without substring false positives", async () => {
  const restoreCatalog = mockPackageCatalog({
    packages: [
      {
        source: "npm:demo-package-two@1.0.0",
        name: "demo-package-two",
        version: "1.0.0",
        scope: "global",
      },
    ],
  });

  try {
    const { ctx } = createMockHarness();
    assert.equal(await isSourceInstalled("npm:demo-package", ctx), false);
    assert.equal(await isSourceInstalled("npm:demo-package-two@1.0.0", ctx), true);
  } finally {
    restoreCatalog();
  }
});

void test("isSourceInstalled supports scope-aware checks", async () => {
  const restoreCatalog = mockPackageCatalog({
    packages: [
      { source: "npm:demo-package@1.0.0", name: "demo-package", version: "1.0.0", scope: "global" },
      {
        source: "npm:demo-package@1.0.0",
        name: "demo-package",
        version: "1.0.0",
        scope: "project",
      },
    ],
  });

  try {
    const { ctx } = createMockHarness();
    assert.equal(await isSourceInstalled("npm:demo-package@1.0.0", ctx, { scope: "global" }), true);
    assert.equal(
      await isSourceInstalled("npm:demo-package@1.0.0", ctx, { scope: "project" }),
      true
    );
  } finally {
    restoreCatalog();
  }
});

void test("isSourceInstalled keeps case-sensitive local paths distinct", async () => {
  const restoreCatalog = mockPackageCatalog({
    packages: [
      {
        source: "/opt/extensions/Foo/index.ts",
        name: "index.ts",
        scope: "global",
      },
    ],
  });

  try {
    const { ctx } = createMockHarness();
    assert.equal(await isSourceInstalled("/opt/extensions/Foo/index.ts", ctx), true);
    assert.equal(await isSourceInstalled("/opt/extensions/foo/index.ts", ctx), false);
  } finally {
    restoreCatalog();
  }
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

void test("normalizePackageIdentity strips git+ prefixes before matching", () => {
  assert.equal(
    normalizePackageIdentity("git+https://github.com/User/Repo.git@main"),
    "git:https://github.com/user/repo.git"
  );
  assert.equal(
    normalizePackageIdentity("git:https://github.com/User/Repo.git@main"),
    "git:https://github.com/user/repo.git"
  );
});

void test("getInstalledPackages hydrates version from resolved package.json when source has no inline version", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-discovery-"));
  const restoreCatalog = mockPackageCatalog({
    packages: [
      {
        source: "npm:pi-extmgr",
        name: "pi-extmgr",
        scope: "global",
        resolvedPath: join(root, "node_modules", "pi-extmgr"),
      },
    ],
  });

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

    const { pi, ctx } = createMockHarness({
      cwd: root,
      execImpl: (command, args) => {
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
    restoreCatalog();
    await rm(root, { recursive: true, force: true });
  }
});

void test("getInstalledPackages aborts instead of returning partial metadata", async () => {
  const restoreCatalog = mockPackageCatalog({
    packages: [
      {
        source: "npm:pi-extmgr@0.1.4",
        name: "pi-extmgr",
        version: "0.1.4",
        scope: "global",
      },
    ],
  });

  try {
    const { pi, ctx } = createMockHarness();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(getInstalledPackages(ctx, pi, undefined, controller.signal), {
      name: "AbortError",
    });
  } finally {
    restoreCatalog();
  }
});
