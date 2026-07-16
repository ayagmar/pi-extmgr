import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type PackageSource,
} from "@earendil-works/pi-coding-agent";
import { getPackageCatalog } from "../packages/catalog.js";
import { getInstalledPackagesAllScopes } from "../packages/discovery.js";
import { type InstalledPackage } from "../types/index.js";
import { runTaskWithLoader } from "../ui/async-task.js";
import { notify } from "../utils/notify.js";
import { parsePackageNameAndVersion, splitGitRepoAndRef } from "../utils/package-source.js";
import { confirmAction, confirmReload } from "../utils/ui-helpers.js";
import { checksumPackagePath, verifyPackageChecksum } from "../profiles/checksum.js";
import { planProfileApplication, type ProfilePlan } from "../profiles/apply.js";
import { loadProjectProfilePolicy, validateProfilePolicy } from "../profiles/compare.js";
import { type ExtmgrProfile, type ProfilePackage, normalizeProfile } from "../profiles/schema.js";
import {
  getProfileStorePath,
  readProfileStore,
  saveNamedProfile,
  deleteNamedProfile,
} from "../profiles/store.js";

export const PROFILE_USAGE =
  "Usage: /extensions profile <export|save|list|delete|dry-run|apply|compare> [name|path]";

function sourceOf(value: PackageSource): string {
  return typeof value === "string" ? value : value.source;
}

function configuredPackage(
  settings: ReturnType<SettingsManager["getGlobalSettings"]>,
  source: string
): PackageSource | undefined {
  return settings.packages?.find((entry) => sourceOf(entry) === source);
}

async function toProfilePackage(
  pkg: InstalledPackage,
  configured: PackageSource | undefined
): Promise<ProfilePackage> {
  const parsed = parsePackageNameAndVersion(pkg.source);
  const gitRef = pkg.source.startsWith("git:")
    ? splitGitRepoAndRef(pkg.source.slice(4)).ref
    : undefined;
  const filters =
    configured && typeof configured === "object" && Array.isArray(configured.extensions)
      ? configured.extensions.filter((filter): filter is string => typeof filter === "string")
      : undefined;
  const checksum = await checksumPackagePath(pkg.resolvedPath);
  return {
    source: pkg.source,
    scope: pkg.scope,
    ...(parsed.version ? { version: parsed.version } : {}),
    ...(gitRef ? { ref: gitRef } : {}),
    ...(filters ? { filters } : {}),
    ...(checksum ? { checksum } : {}),
  };
}

async function currentProfile(ctx: ExtensionCommandContext): Promise<ExtmgrProfile> {
  const packages = await getInstalledPackagesAllScopes(ctx);
  const settings = SettingsManager.create(ctx.cwd, getAgentDir());
  const profiles = await Promise.all(
    packages.map((pkg) => {
      const scopedSettings =
        pkg.scope === "project" ? settings.getProjectSettings() : settings.getGlobalSettings();
      return toProfilePackage(pkg, configuredPackage(scopedSettings, pkg.source));
    })
  );
  return normalizeProfile({ name: "current", packages: profiles });
}

async function readProfile(path: string): Promise<ExtmgrProfile> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Profile must be a JSON object.");
  }
  const value = parsed as Record<string, unknown>;
  if (value.schemaVersion !== 1) {
    throw new Error("Unsupported or missing profile schemaVersion; expected 1.");
  }
  if (!Array.isArray(value.packages)) {
    throw new Error("Profile packages must be an array.");
  }
  return normalizeProfile(parsed);
}

function formatPlan(plan: ProfilePlan): string {
  return [
    `Add: ${plan.add.length}`,
    ...plan.add.map((pkg) => `  + ${pkg.source} (${pkg.scope})`),
    `Remove: ${plan.remove.length}`,
    ...plan.remove.map((pkg) => `  - ${pkg.source} (${pkg.scope})`),
    `Change: ${plan.update.length}`,
    ...plan.update.map(({ to }) => `  ~ ${to.source} (${to.scope})`),
  ].join("\n");
}

async function resolveNamedOrPathProfile(
  requested: string | undefined,
  ctx: ExtensionCommandContext
): Promise<ExtmgrProfile | undefined> {
  if (requested) {
    const path = resolve(ctx.cwd, requested);
    try {
      return await readProfile(path);
    } catch (error) {
      if (!ctx.hasUI) throw error;
      const store = await readProfileStore(getProfileStorePath());
      const named = store.profiles[requested];
      if (named) return named;
      throw error;
    }
  }

  if (!ctx.hasUI) return undefined;
  const store = await readProfileStore(getProfileStorePath());
  const names = Object.keys(store.profiles).sort();
  if (names.length === 0) return undefined;
  const choice = await ctx.ui.select("Select saved profile", names);
  return choice ? store.profiles[choice] : undefined;
}

function configuredEntry(
  settings: ReturnType<SettingsManager["getGlobalSettings"]>,
  desired: ProfilePackage
): PackageSource | undefined {
  return settings.packages?.find((entry) => sourceOf(entry) === desired.source);
}

function buildScopedPackageSettings(
  settings: ReturnType<SettingsManager["getGlobalSettings"]>,
  desired: ProfilePackage[]
): PackageSource[] {
  return desired.map((pkg) => {
    const existing = configuredEntry(settings, pkg);
    if (existing && typeof existing === "object") {
      return {
        ...existing,
        source: pkg.source,
        ...(pkg.filters ? { extensions: [...pkg.filters] } : {}),
      };
    }
    return pkg.filters ? { source: pkg.source, extensions: [...pkg.filters] } : pkg.source;
  });
}

async function persistProfileConfiguration(
  desired: ExtmgrProfile,
  ctx: ExtensionCommandContext
): Promise<void> {
  const settings = SettingsManager.create(ctx.cwd, getAgentDir());
  const global = settings.getGlobalSettings();
  const project = settings.getProjectSettings();
  settings.setPackages(
    buildScopedPackageSettings(
      global,
      desired.packages.filter((pkg) => pkg.scope === "global")
    )
  );
  settings.setProjectPackages(
    buildScopedPackageSettings(
      project,
      desired.packages.filter((pkg) => pkg.scope === "project")
    )
  );
  await settings.flush();
}

async function verifyProfileSafety(
  current: ExtmgrProfile,
  desired: ExtmgrProfile,
  ctx: ExtensionCommandContext
): Promise<string[]> {
  const currentPackages = await getInstalledPackagesAllScopes(ctx);
  const bySource = new Map(currentPackages.map((pkg) => [`${pkg.scope}\0${pkg.source}`, pkg]));
  const problems: string[] = [];
  for (const pkg of desired.packages) {
    if (!pkg.checksum) {
      problems.push(`${pkg.source} (${pkg.scope}): checksum metadata is unknown`);
      continue;
    }
    const installed = bySource.get(`${pkg.scope}\0${pkg.source}`);
    const result = await verifyPackageChecksum(installed?.resolvedPath, pkg.checksum);
    if (result === "unknown") problems.push(`${pkg.source}: installed package metadata is unknown`);
    else if (result === "mismatch") problems.push(`${pkg.source}: checksum mismatch`);
  }
  if (current.schemaVersion !== 1 || desired.schemaVersion !== 1) {
    problems.push("profile schema is unknown");
  }
  return problems;
}

async function applyProfileFromCommand(
  current: ExtmgrProfile,
  desired: ExtmgrProfile,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  const policy = await loadProjectProfilePolicy(ctx.cwd);
  const violations = policy ? validateProfilePolicy(desired, policy) : [];
  if (violations.length > 0) {
    notify(
      ctx,
      `Profile policy rejected application:\n${violations.map((v) => `- ${v.message}`).join("\n")}`,
      "error"
    );
    return;
  }

  const safetyProblems = await verifyProfileSafety(current, desired, ctx);
  if (safetyProblems.length > 0) {
    notify(
      ctx,
      `Profile application is not safe:\n${safetyProblems.map((problem) => `- ${problem}`).join("\n")}`,
      "error"
    );
    return;
  }

  const plan = planProfileApplication(current, desired);
  if (plan.add.length + plan.remove.length + plan.update.length === 0) {
    notify(ctx, "Profile already matches the installed package state.", "info");
    return;
  }

  if (
    !(await confirmAction(
      ctx,
      "Apply profile",
      `${desired.name}\n\n${formatPlan(plan)}\n\nApply these changes?`
    ))
  ) {
    notify(ctx, "Profile application cancelled.", "info");
    return;
  }

  await runTaskWithLoader(
    ctx,
    { title: "Apply profile", message: `Applying ${desired.name}...`, cancellable: false },
    async ({ setMessage }) => {
      const catalog = getPackageCatalog(ctx.cwd);
      for (const pkg of plan.remove) {
        setMessage(`Removing ${pkg.source}...`);
        await catalog.remove(pkg.source, pkg.scope);
      }
      for (const pkg of plan.add) {
        setMessage(`Installing ${pkg.source}...`);
        await catalog.install(pkg.source, pkg.scope);
      }
      for (const change of plan.update) {
        if (change.from.source === change.to.source) continue;
        setMessage(`Changing ${change.to.source}...`);
        await catalog.remove(change.from.source, change.from.scope);
        await catalog.install(change.to.source, change.to.scope);
      }
      setMessage("Preserving package settings and filters...");
      await persistProfileConfiguration(desired, ctx);
      return undefined;
    }
  );

  notify(ctx, `Applied profile ${desired.name}.`, "info");
  await confirmReload(ctx, "Profile package configuration changed.");
  void pi;
}

export async function handleProfileSubcommand(
  tokens: string[],
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<void> {
  const action = tokens[0];
  const requested = tokens[1];
  if (
    !action ||
    !["export", "save", "list", "delete", "dry-run", "apply", "compare"].includes(action)
  ) {
    notify(ctx, PROFILE_USAGE, "info");
    return;
  }

  try {
    const storePath = getProfileStorePath();
    if (action === "list") {
      const names = Object.keys((await readProfileStore(storePath)).profiles).sort();
      notify(
        ctx,
        names.length > 0 ? `Saved profiles:\n${names.join("\n")}` : "No saved profiles.",
        "info"
      );
      return;
    }
    if (action === "save") {
      if (!requested) {
        notify(ctx, "Usage: /extensions profile save <name>", "info");
        return;
      }
      const profile = await currentProfile(ctx);
      profile.name = requested;
      await saveNamedProfile(storePath, profile);
      notify(ctx, `Saved profile ${requested}.`, "info");
      return;
    }
    if (action === "delete") {
      if (!requested || !(await deleteNamedProfile(storePath, requested))) {
        notify(ctx, `Saved profile not found: ${requested ?? "(missing name)"}`, "warning");
      } else {
        notify(ctx, `Deleted profile ${requested}.`, "info");
      }
      return;
    }

    const current = await currentProfile(ctx);
    if (action === "export") {
      if (!requested) {
        notify(ctx, "Usage: /extensions profile export <path>", "info");
        return;
      }
      await writeFile(resolve(ctx.cwd, requested), `${JSON.stringify(current, null, 2)}\n`, {
        flag: "wx",
      });
      notify(ctx, `Exported profile to ${resolve(ctx.cwd, requested)}`, "info");
      return;
    }

    const desired = await resolveNamedOrPathProfile(requested, ctx);
    if (!desired) {
      notify(ctx, "No saved profile selected.", "info");
      return;
    }
    const plan = planProfileApplication(current, desired);
    if (action === "apply") {
      if (!pi) throw new Error("Profile application requires the extension API.");
      await applyProfileFromCommand(current, desired, ctx, pi);
      return;
    }
    notify(ctx, formatPlan(plan), "info");
  } catch (error) {
    notify(
      ctx,
      `Profile ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
      "error"
    );
  }
}
