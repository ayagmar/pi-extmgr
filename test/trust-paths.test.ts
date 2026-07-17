import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { discoverPackageExtensions, setPackageExtensionState } from "../src/packages/extensions.js";
import { getProfileStorePath } from "../src/profiles/store.js";
import { getExtmgrTrashDir, getProjectConfigDir } from "../src/utils/pi-paths.js";
import { getReloadRequiredStatePath } from "../src/utils/reload-state.js";
import { getSavedViewsPath } from "../src/utils/views.js";

void test("untrusted project package filters are ignored and writes are rejected", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-untrusted-"));
  const root = join(cwd, "vendor", "demo");
  const settingsPath = join(cwd, CONFIG_DIR_NAME, "settings.json");
  try {
    await mkdir(root, { recursive: true });
    await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ pi: { extensions: ["index.ts"] } })
    );
    await writeFile(join(root, "index.ts"), "// demo\n");
    await writeFile(
      settingsPath,
      JSON.stringify({ packages: [{ source: "./vendor/demo", extensions: [] }] })
    );
    const pkg = {
      source: "./vendor/demo",
      name: "demo",
      scope: "project" as const,
      resolvedPath: root,
    };

    const untrusted = await discoverPackageExtensions([pkg], cwd, { projectTrusted: false });
    assert.equal(untrusted[0]?.state, "enabled");
    const rejected = await setPackageExtensionState(
      pkg.source,
      "index.ts",
      "project",
      "disabled",
      cwd,
      false
    );
    assert.equal(rejected.ok, false);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      packages: [{ source: "./vendor/demo", extensions: [] }],
    });

    const trusted = await discoverPackageExtensions([pkg], cwd, { projectTrusted: true });
    assert.equal(trusted[0]?.state, "disabled");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("Pi and extmgr path helpers resolve environment overrides at call time", () => {
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldCache = process.env.PI_EXTMGR_CACHE_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "/tmp/extmgr-agent-one";
    delete process.env.PI_EXTMGR_CACHE_DIR;
    assert.equal(getExtmgrTrashDir(), "/tmp/extmgr-agent-one/.extmgr-trash");
    assert.equal(getProfileStorePath(), "/tmp/extmgr-agent-one/.extmgr-cache/profiles.json");
    assert.equal(
      getReloadRequiredStatePath(),
      "/tmp/extmgr-agent-one/.extmgr-cache/reload-required.json"
    );
    assert.match(
      getSavedViewsPath("/workspace"),
      /^\/tmp\/extmgr-agent-one\/\.extmgr-cache\/views-/
    );

    process.env.PI_EXTMGR_CACHE_DIR = "/tmp/extmgr-cache-override";
    assert.equal(getProfileStorePath(), "/tmp/extmgr-cache-override/profiles.json");
    assert.equal(getReloadRequiredStatePath(), "/tmp/extmgr-cache-override/reload-required.json");
    assert.equal(getProjectConfigDir("/workspace"), join("/workspace", CONFIG_DIR_NAME));
  } finally {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldCache === undefined) delete process.env.PI_EXTMGR_CACHE_DIR;
    else process.env.PI_EXTMGR_CACHE_DIR = oldCache;
  }
});
