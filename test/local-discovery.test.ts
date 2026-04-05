import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverExtensions } from "../src/extensions/discovery.js";

void test("discoverExtensions includes manifest-declared local entrypoints, including disabled files", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "pi-extmgr-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-local-discovery-"));
  const previousHome = process.env.HOME;

  try {
    process.env.HOME = tempHome;

    const pkgRoot = join(cwd, ".pi", "extensions", "demo-pkg");
    await mkdir(join(pkgRoot, "extensions"), { recursive: true });
    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify(
        {
          name: "demo-pkg",
          pi: { extensions: ["./custom.ts", "./extensions/*.ts"] },
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(join(pkgRoot, "custom.ts"), "// custom entrypoint\n", "utf8");
    await writeFile(
      join(pkgRoot, "extensions", "queue.ts.disabled"),
      "// disabled entrypoint\n",
      "utf8"
    );

    const entries = await discoverExtensions(cwd);
    const customEntry = entries.find((entry) => entry.displayName.endsWith("demo-pkg/custom.ts"));
    const disabledEntry = entries.find((entry) =>
      entry.displayName.endsWith("demo-pkg/extensions/queue.ts")
    );

    assert.equal(customEntry?.scope, "project");
    assert.equal(customEntry?.state, "enabled");
    assert.equal(disabledEntry?.scope, "project");
    assert.equal(disabledEntry?.state, "disabled");
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(tempHome, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
