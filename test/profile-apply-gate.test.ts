import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { handleProfileSubcommand } from "../src/commands/profile.js";
import { getProfileStorePath, saveNamedProfile } from "../src/profiles/store.js";
import { showProfiles } from "../src/ui/profiles.js";
import { captureCustomComponent } from "./helpers/custom-component.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

initTheme();

async function withProfileStore<T>(run: () => Promise<T>): Promise<T> {
  const cacheDir = await mkdtemp(join(tmpdir(), "pi-extmgr-apply-gate-"));
  const previous = process.env.PI_EXTMGR_CACHE_DIR;
  process.env.PI_EXTMGR_CACHE_DIR = cacheDir;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.PI_EXTMGR_CACHE_DIR;
    else process.env.PI_EXTMGR_CACHE_DIR = previous;
    await rm(cacheDir, { recursive: true, force: true });
  }
}

void test("profile action menu offers no apply path that bypasses the diff review", async () => {
  await withProfileStore(async () => {
    await saveNamedProfile(getProfileStorePath(), {
      schemaVersion: 1,
      name: "gate",
      packages: [{ source: "npm:demo", scope: "global", version: "1.0.0" }],
    });
    const restoreCatalog = mockPackageCatalog({ packages: [] });

    try {
      const { pi, ctx } = createMockHarness({ hasUI: true });
      let profileMenuOptions: string[] = [];
      (
        ctx.ui as unknown as {
          select: (title: string, options?: string[]) => Promise<string | undefined>;
        }
      ).select = (title, options) => {
        if (title.startsWith("Profile:")) {
          profileMenuOptions = options ?? [];
        }
        return Promise.resolve(undefined);
      };
      let profileSelections = 0;
      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
          if (lines.some((line) => line.includes("Save current package set"))) {
            profileSelections += 1;
            component.handleInput?.(profileSelections === 1 ? "\r" : "\u001b");
            return completion;
          }
          component.handleInput?.("\u001b");
          return completion;
        });

      await showProfiles(ctx, pi);

      assert.ok(profileMenuOptions.length > 0, "profile action menu should have been shown");
      assert.ok(
        profileMenuOptions.includes("Review and apply"),
        "apply must be labelled as review-first"
      );
      assert.ok(
        !profileMenuOptions.some(
          (option) => option === "Apply profile" || option === "Preview changes"
        ),
        "no direct apply or separate preview path may exist"
      );
    } finally {
      restoreCatalog();
    }
  });
});

void test("the direct interactive apply command also requires the inline diff review", async () => {
  await withProfileStore(async () => {
    await saveNamedProfile(getProfileStorePath(), {
      schemaVersion: 1,
      name: "direct-gate",
      packages: [{ source: "npm:demo", scope: "global", version: "1.0.0" }],
    });
    let installs = 0;
    const restoreCatalog = mockPackageCatalog({
      packages: [],
      installImpl: () => {
        installs += 1;
      },
    });

    try {
      const { pi, ctx } = createMockHarness({ hasUI: true });
      let sawDiff = false;
      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
          if (lines.some((line) => line.includes("Profile diff"))) {
            sawDiff = true;
            component.handleInput?.("\u001b");
          }
          return completion;
        });

      await handleProfileSubcommand(["apply", "direct-gate"], ctx, pi);

      assert.equal(sawDiff, true);
      assert.equal(installs, 0);
    } finally {
      restoreCatalog();
    }
  });
});

void test("backing out of the diff review never applies the profile", async () => {
  await withProfileStore(async () => {
    await saveNamedProfile(getProfileStorePath(), {
      schemaVersion: 1,
      name: "gate-cancel",
      packages: [{ source: "npm:demo", scope: "global", version: "1.0.0" }],
    });
    let installs = 0;
    const restoreCatalog = mockPackageCatalog({
      packages: [],
      installImpl: () => {
        installs += 1;
      },
    });

    try {
      const { pi, ctx } = createMockHarness({ hasUI: true });
      (
        ctx.ui as unknown as {
          select: (title: string, options?: string[]) => Promise<string | undefined>;
        }
      ).select = (title) =>
        Promise.resolve(title.startsWith("Profile:") ? "Review and apply" : undefined);

      let sawDiff = false;
      let profileSelections = 0;
      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
          if (lines.some((line) => line.includes("Profile diff"))) {
            sawDiff = true;
            component.handleInput?.("\u001b"); // back out of review
            return completion;
          }
          if (lines.some((line) => line.includes("Save current package set"))) {
            profileSelections += 1;
            component.handleInput?.(profileSelections === 1 ? "\r" : "\u001b");
            return completion;
          }
          component.handleInput?.("\u001b");
          return completion;
        });

      await showProfiles(ctx, pi);

      assert.equal(sawDiff, true, "review screen must be shown before any apply");
      assert.equal(installs, 0, "backing out of review must not mutate packages");
    } finally {
      restoreCatalog();
    }
  });
});

void test("policy violations render in the diff and disable the apply shortcut", async () => {
  await withProfileStore(async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-apply-policy-"));
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "extmgr-policy.json"),
      JSON.stringify({ schemaVersion: 1, allowedScopes: ["global"] }),
      "utf8"
    );
    await saveNamedProfile(getProfileStorePath(), {
      schemaVersion: 1,
      name: "policy-block",
      packages: [{ source: "npm:demo", scope: "project", version: "1.0.0" }],
    });
    let installs = 0;
    const restoreCatalog = mockPackageCatalog({
      packages: [],
      installImpl: () => {
        installs += 1;
      },
    });

    try {
      const { pi, ctx } = createMockHarness({ cwd, hasUI: true, projectTrusted: true });
      (
        ctx.ui as unknown as {
          select: (title: string, options?: string[]) => Promise<string | undefined>;
        }
      ).select = (title) =>
        Promise.resolve(title.startsWith("Profile:") ? "Review and apply" : undefined);

      let diffLines: string[] = [];
      let profileSelections = 0;
      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
          if (lines.some((line) => line.includes("Profile diff"))) {
            diffLines = lines;
            component.handleInput?.("a"); // apply must be inert under violations
            component.handleInput?.("\u001b");
            return completion;
          }
          if (lines.some((line) => line.includes("Save current package set"))) {
            profileSelections += 1;
            component.handleInput?.(profileSelections === 1 ? "\r" : "\u001b");
            return completion;
          }
          component.handleInput?.("\u001b");
          return completion;
        });

      await showProfiles(ctx, pi);

      assert.ok(diffLines.some((line) => line.includes("Policy blocks application")));
      assert.ok(diffLines.some((line) => line.includes("scope project is not allowed")));
      assert.ok(!diffLines.some((line) => line.includes("a apply")));
      assert.equal(installs, 0, "policy-blocked profiles must never apply");
    } finally {
      restoreCatalog();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
