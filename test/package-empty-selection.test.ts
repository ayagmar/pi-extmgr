import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { applyPackageExtensionStateChanges } from "../src/packages/extensions.js";

for (const { target, enabled } of [
  { target: "enabled", enabled: ["a.ts"] },
  { target: "disabled", enabled: [] },
] as const) {
  void test(`an explicit empty extension filter stays selective when a.ts is ${target}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-empty-selection-"));
    const source = join(cwd, "package");
    try {
      await mkdir(source);
      await mkdir(join(cwd, ".pi"));
      const entrypoints = [
        "a.ts",
        "extensions/a.ts",
        "b.ts",
        ".hidden.ts",
        "extensions/.hidden.ts",
        ".private/nested.ts",
      ];
      await writeFile(
        join(source, "package.json"),
        JSON.stringify({ pi: { extensions: entrypoints } })
      );
      for (const file of entrypoints) {
        await mkdir(dirname(join(source, file)), { recursive: true });
        await writeFile(join(source, file), "export default () => {};\n");
      }
      await writeFile(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({ packages: [{ source, extensions: [] }] })
      );

      const readEnabled = async () => {
        const settingsManager = SettingsManager.create(cwd, getAgentDir(), {
          projectTrusted: true,
        });
        const manager = new DefaultPackageManager({
          cwd,
          agentDir: getAgentDir(),
          settingsManager,
        });
        const resources = await manager.resolve(async () => "skip");
        return resources.extensions
          .filter((entry) => entry.enabled)
          .map((entry) => relative(source, entry.path).replaceAll("\\", "/"))
          .sort();
      };
      assert.deepEqual(
        await applyPackageExtensionStateChanges(
          source,
          "project",
          [{ extensionPath: "a.ts", target }],
          cwd,
          true
        ),
        { ok: true }
      );
      assert.deepEqual(await readEnabled(), enabled);
      if (target === "enabled") {
        for (const [path, state, want] of [
          ["extensions/a.ts", "enabled", ["a.ts", "extensions/a.ts"]],
          [".hidden.ts", "enabled", [".hidden.ts", "a.ts", "extensions/a.ts"]],
          [
            ".private/nested.ts",
            "enabled",
            [".hidden.ts", ".private/nested.ts", "a.ts", "extensions/a.ts"],
          ],
          ["a.ts", "disabled", [".hidden.ts", ".private/nested.ts", "extensions/a.ts"]],
          ["extensions/a.ts", "disabled", [".hidden.ts", ".private/nested.ts"]],
          [".hidden.ts", "disabled", [".private/nested.ts"]],
          [".private/nested.ts", "disabled", []],
          ["b.ts", "enabled", ["b.ts"]],
        ] as const) {
          assert.deepEqual(
            await applyPackageExtensionStateChanges(
              source,
              "project",
              [{ extensionPath: path, target: state }],
              cwd,
              true
            ),
            { ok: true }
          );
          assert.deepEqual(await readEnabled(), want, `${state} ${path}`);
          if (want.length === 0) {
            const saved = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
            assert.deepEqual(saved.getProjectSettings().packages, [{ source, extensions: [] }]);
          }
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
