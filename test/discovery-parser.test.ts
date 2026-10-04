import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getInstalledPackages } from "../src/packages/discovery.js";
import { isPackageSource, normalizePackageSource, parseNpmSource } from "../src/utils/format.js";
import { getPackageSourceKind, normalizePackageIdentity } from "../src/utils/package-source.js";
import { getProjectConfigDir } from "../src/utils/pi-paths.js";
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

void test("package identities match exact sources and resolve local paths per scope", () => {
  // npm identities ignore versions but never match by substring.
  assert.equal(
    normalizePackageIdentity("npm:demo-package-two@1.0.0"),
    normalizePackageIdentity("npm:demo-package-two")
  );
  assert.notEqual(
    normalizePackageIdentity("npm:demo-package"),
    normalizePackageIdentity("npm:demo-package-two@1.0.0")
  );

  // POSIX local paths stay case-sensitive.
  assert.notEqual(
    normalizePackageIdentity("/opt/extensions/Foo/index.ts"),
    normalizePackageIdentity("/opt/extensions/foo/index.ts")
  );

  // Relative sources resolve against their settings scope (.pi or the agent dir).
  const projectRoot = getProjectConfigDir("/workspace/project");
  assert.equal(
    normalizePackageIdentity("../vendor/demo", { cwd: projectRoot }),
    normalizePackageIdentity("/workspace/project/vendor/demo")
  );
  assert.equal(
    normalizePackageIdentity("./vendor/demo", { cwd: getAgentDir() }),
    normalizePackageIdentity(`${getAgentDir()}/vendor/demo`)
  );
  assert.equal(
    normalizePackageIdentity("../vendor/demo", {
      cwd: projectRoot,
      resolvedPath: "/workspace/project/vendor/demo",
    }),
    normalizePackageIdentity("./vendor/demo", { cwd: "/workspace/project" })
  );
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
  // pi reads git+<scheme>:// and bare git:// as local paths, so they get the git: prefix.
  assert.equal(
    normalizePackageSource("git+https://github.com/user/repo.git"),
    "git:https://github.com/user/repo.git"
  );
  assert.equal(
    normalizePackageSource("git+ssh://git@github.com/user/repo.git"),
    "git:ssh://git@github.com/user/repo.git"
  );
  assert.equal(
    normalizePackageSource("git://example.com/user/repo.git"),
    "git:git://example.com/user/repo.git"
  );
  assert.equal(
    normalizePackageSource("git:https://github.com/user/repo.git"),
    "git:https://github.com/user/repo.git"
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

void test("getInstalledPackages describes relative local files and URL git sources correctly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-describe-"));
  const extensionFile = join(root, ".pi", "extensions-src", "demo.ts");
  await mkdir(join(root, ".pi", "extensions-src"), { recursive: true });
  await writeFile(extensionFile, "// Demo extension from the settings directory\n", "utf8");
  const restoreCatalog = mockPackageCatalog({
    packages: [
      {
        source: "./extensions-src/demo.ts",
        name: "demo.ts",
        scope: "project",
        resolvedPath: extensionFile,
      },
      { source: "https://github.com/user/tool", name: "tool", scope: "global" },
    ],
  });

  try {
    const { pi, ctx } = createMockHarness({ cwd: root });
    const result = await getInstalledPackages(ctx, pi);
    assert.equal(
      result.find((pkg) => pkg.name === "demo.ts")?.description,
      "Demo extension from the settings directory"
    );
    assert.equal(result.find((pkg) => pkg.name === "tool")?.description, "git repository");
  } finally {
    restoreCatalog();
    await rm(root, { recursive: true, force: true });
  }
});

void test("git source spellings share one package identity", () => {
  const identity = normalizePackageIdentity("git:git://example.com/user/repo.git");
  assert.equal(normalizePackageIdentity("git://example.com/user/repo.git"), identity);
  assert.equal(normalizePackageIdentity("git+git://example.com/user/repo.git"), identity);
  assert.equal(
    normalizePackageIdentity("git+https://github.com/user/repo.git"),
    normalizePackageIdentity("git:https://github.com/user/repo.git")
  );
});
