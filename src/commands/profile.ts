import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
  type PackageSource,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { inspectInstalledPackageCompatibility } from "../doctor/compatibility.js";
import { getPackageCatalog } from "../packages/catalog.js";
import { getInstalledPackagesAllScopes } from "../packages/discovery.js";
import { type ProfilePlan, planProfileApplication } from "../profiles/apply.js";
import { readPackageManifestSnapshot } from "../profiles/checksum.js";
import {
  loadProjectProfilePolicy,
  type ProfilePackageDiagnostic,
  validateProfilePolicy,
} from "../profiles/compare.js";
import {
  type ExtmgrProfile,
  getEffectivePackageSource,
  getProfilePackageIdentity,
  isExactNpmVersion,
  normalizeProfile,
  type ProfilePackage,
  parseExternalProfile,
} from "../profiles/schema.js";
import { type LoadedProfileSource, loadProfileSource } from "../profiles/source.js";
import {
  deleteNamedProfile,
  getNamedProfile,
  getProfileStorePath,
  markProfileRestorePointIncomplete,
  readProfileRestorePoints,
  readProfileStore,
  saveNamedProfile,
  saveProfileRestorePoint,
} from "../profiles/store.js";
import { type InstalledPackage } from "../types/index.js";
import { runTaskWithLoader } from "../ui/async-task.js";
import { showProfileDiff } from "../ui/profile-review.js";
import { isProjectTrusted } from "../utils/mode.js";
import { notify } from "../utils/notify.js";
import {
  getPackageSourceKind,
  normalizePackageIdentity,
  packageSourceString,
  parsePackageNameAndVersion,
  splitGitRepoAndRef,
  stripGitSourcePrefix,
} from "../utils/package-source.js";
import { getProjectConfigDir } from "../utils/pi-paths.js";
import { markReloadRequired } from "../utils/reload-state.js";
import { throwIfSettingsErrors } from "../utils/settings-errors.js";
import { confirmAction, confirmReload } from "../utils/ui-helpers.js";

export const PROFILE_USAGE =
  "Usage: /extensions profile <export|save|list|delete|dry-run|apply|compare|import|check|recover> [name|source] [--json|--strict|--force|--name <name>]";

export interface ProfileApplicationOperation {
  action: "install" | "remove" | "settings" | "verify" | "rollback";
  source?: string;
  scope?: "global" | "project";
  status: "completed" | "failed";
  error?: string;
}

export interface ProfileApplicationOutcome {
  applied: boolean;
  reloaded: boolean;
  restored?: boolean;
  restorePointId?: string;
  operations?: ProfileApplicationOperation[];
}

function profileMutationSource(pkg: ProfilePackage, cwd: string): string {
  const source = getEffectivePackageSource(pkg);
  if (
    getPackageSourceKind(source) !== "local" ||
    !(
      source.startsWith("./") ||
      source.startsWith("../") ||
      source.startsWith(".\\") ||
      source.startsWith("..\\")
    )
  ) {
    return source;
  }
  const root = pkg.scope === "project" ? getProjectConfigDir(cwd) : getAgentDir();
  return resolve(root, source.replace(/\\/g, "/"));
}

function packageSettingsMatch(entry: PackageSource, pkg: InstalledPackage, cwd: string): boolean {
  const root = pkg.scope === "project" ? getProjectConfigDir(cwd) : getAgentDir();
  return (
    normalizePackageIdentity(packageSourceString(entry), { cwd: root }) ===
    normalizePackageIdentity(pkg.source, {
      ...(pkg.resolvedPath ? { resolvedPath: pkg.resolvedPath } : {}),
      cwd: root,
    })
  );
}

function packageRoot(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return /(?:^|[\\/])package\.json$/i.test(path) ? dirname(path) : path;
}

async function resolveInstalledGitCommit(
  pkg: InstalledPackage,
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<string | undefined> {
  const cwd = packageRoot(pkg.resolvedPath);
  if (!pi || !cwd) return undefined;
  try {
    const result = await pi.exec("git", ["rev-parse", "HEAD"], {
      cwd,
      timeout: 5_000,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const commit = result.stdout.trim();
    return result.code === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)
      ? commit
      : undefined;
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    return undefined;
  }
}

async function toProfilePackage(
  pkg: InstalledPackage,
  configured: PackageSource | undefined,
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<ProfilePackage> {
  const configuredSource = configured ? packageSourceString(configured) : pkg.source;
  const sourceKind = getPackageSourceKind(configuredSource);
  const parsed = parsePackageNameAndVersion(configuredSource);
  const manifest = await readPackageManifestSnapshot(pkg.resolvedPath);
  const installedVersion =
    manifest?.version ?? (isExactNpmVersion(pkg.version) ? pkg.version : undefined);
  const configuredGit =
    sourceKind === "git" ? splitGitRepoAndRef(stripGitSourcePrefix(configuredSource)) : undefined;
  const installedCommit =
    sourceKind === "git" ? await resolveInstalledGitCommit(pkg, ctx, pi) : undefined;
  const filters =
    configured && typeof configured === "object" && Array.isArray(configured.extensions)
      ? configured.extensions.filter((filter): filter is string => typeof filter === "string")
      : undefined;
  const packageSettings =
    configured && typeof configured === "object"
      ? Object.fromEntries(
          Object.entries(configured)
            .filter(([key]) => key !== "source" && key !== "extensions")
            .map(([key, value]) => [key, structuredClone(value)])
        )
      : undefined;

  // Saved/exported profiles are snapshots. Strip mutable npm ranges and git
  // refs when the installed artifact gives us an exact reproducible target.
  const source =
    sourceKind === "npm" && installedVersion
      ? `npm:${parsed.name}`
      : sourceKind === "git" && installedCommit && configuredGit
        ? `${configuredSource.startsWith("git:") ? "git:" : configuredSource.startsWith("git+") ? "git+" : ""}${configuredGit.repo}`
        : configuredSource;
  const version = sourceKind === "npm" ? (installedVersion ?? parsed.version) : undefined;
  const ref = sourceKind === "git" ? (installedCommit ?? configuredGit?.ref) : undefined;
  const locked =
    (sourceKind === "npm" && Boolean(installedVersion)) ||
    (sourceKind === "git" && Boolean(installedCommit));

  return {
    source,
    scope: pkg.scope,
    ...(version ? { version } : {}),
    ...(ref ? { ref } : {}),
    ...(locked ? { resolution: "locked" as const } : {}),
    ...(filters !== undefined ? { filters } : {}),
    ...(packageSettings && Object.keys(packageSettings).length > 0 ? { packageSettings } : {}),
    ...(manifest ? { manifestFingerprint: manifest.fingerprint } : {}),
  };
}

export async function getCurrentProfile(
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<ExtmgrProfile> {
  const packages = await getInstalledPackagesAllScopes(ctx);
  const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
    projectTrusted: isProjectTrusted(ctx),
  });
  const global = settings.getGlobalSettings();
  const project = settings.getProjectSettings();
  const profiles = await Promise.all(
    packages.map((pkg) => {
      const scoped = pkg.scope === "project" ? project : global;
      const configured = scoped.packages?.find((entry) =>
        packageSettingsMatch(entry, pkg, ctx.cwd)
      );
      return toProfilePackage(pkg, configured, ctx, pi);
    })
  );
  return normalizeProfile({ name: "current", packages: profiles });
}

function formatPlan(plan: ProfilePlan): string {
  return [
    `Add: ${plan.add.length}`,
    ...plan.add.map((pkg) => `  + ${getEffectivePackageSource(pkg)} (${pkg.scope})`),
    `Remove: ${plan.remove.length}`,
    ...plan.remove.map((pkg) => `  - ${getEffectivePackageSource(pkg)} (${pkg.scope})`),
    `Change: ${plan.update.length}`,
    ...plan.update.map(
      ({ from, to }) =>
        `  ~ ${getEffectivePackageSource(from)} (${from.scope}) -> ${getEffectivePackageSource(to)} (${to.scope})`
    ),
  ].join("\n");
}

async function resolveNamedOrSourceProfile(
  requested: string | undefined,
  ctx: ExtensionCommandContext
): Promise<ExtmgrProfile | undefined> {
  const store = await readProfileStore(getProfileStorePath());
  if (requested) {
    const named = getNamedProfile(store, requested);
    if (named) return named;
    const loaded = await loadProfileSource(requested, {
      cwd: ctx.cwd,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const parsed = parseExternalProfile(loaded.value);
    if (!parsed.ok)
      throw new Error(parsed.errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    return parsed.profile;
  }
  if (!ctx.hasUI) return undefined;
  const names = Object.keys(store.profiles).sort();
  if (names.length === 0) return undefined;
  const choice = await ctx.ui.select("Select saved profile", names);
  return choice ? getNamedProfile(store, choice) : undefined;
}

function configuredEntry(
  settings: ReturnType<SettingsManager["getGlobalSettings"]>,
  desired: ProfilePackage,
  cwd: string
): PackageSource | undefined {
  return settings.packages?.find(
    (entry) =>
      normalizePackageIdentity(packageSourceString(entry), {
        cwd: desired.scope === "project" ? getProjectConfigDir(cwd) : getAgentDir(),
      }) ===
      getProfilePackageIdentity(desired, {
        projectCwd: cwd,
        globalCwd: getAgentDir(),
      })
  );
}

function buildScopedPackageSettings(
  settings: ReturnType<SettingsManager["getGlobalSettings"]>,
  desired: ProfilePackage[],
  cwd: string
): PackageSource[] {
  return desired.map((pkg) => {
    const source = profileMutationSource(pkg, cwd);
    const existing = configuredEntry(settings, pkg, cwd);
    const packageSettings = pkg.packageSettings ? structuredClone(pkg.packageSettings) : undefined;
    if (existing && typeof existing === "object") {
      const next: Record<string, unknown> = packageSettings
        ? { ...packageSettings, source }
        : { ...existing, source };
      if (pkg.filters) next.extensions = [...pkg.filters];
      else delete next.extensions;
      return next as PackageSource;
    }
    if (packageSettings) {
      const next: Record<string, unknown> = { ...packageSettings, source };
      if (pkg.filters) next.extensions = [...pkg.filters];
      return next as PackageSource;
    }
    return pkg.filters ? { source, extensions: [...pkg.filters] } : source;
  });
}

async function persistProfileConfiguration(
  desired: ExtmgrProfile,
  ctx: ExtensionCommandContext
): Promise<void> {
  const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
    projectTrusted: isProjectTrusted(ctx),
  });
  throwIfSettingsErrors(settings, "Profile application");
  const global = settings.getGlobalSettings();
  const project = settings.getProjectSettings();
  settings.setPackages(
    buildScopedPackageSettings(
      global,
      desired.packages.filter((pkg) => pkg.scope === "global"),
      ctx.cwd
    )
  );
  settings.setProjectPackages(
    buildScopedPackageSettings(
      project,
      desired.packages.filter((pkg) => pkg.scope === "project"),
      ctx.cwd
    )
  );
  await settings.flush();
  throwIfSettingsErrors(settings, "Profile application");
}

interface InstalledRuntimeTarget {
  pkg: InstalledPackage;
  version?: string;
  gitCommit?: string;
}

async function describeInstalledRuntimeTargets(
  installed: InstalledPackage[],
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<InstalledRuntimeTarget[]> {
  return Promise.all(
    installed.map(async (pkg) => {
      const snapshot = await readPackageManifestSnapshot(pkg.resolvedPath);
      const sourceVersion = parsePackageNameAndVersion(pkg.source).version;
      const version =
        snapshot?.version ??
        (isExactNpmVersion(pkg.version) ? pkg.version : undefined) ??
        (isExactNpmVersion(sourceVersion) ? sourceVersion : undefined);
      const gitCommit =
        getPackageSourceKind(pkg.source) === "git"
          ? await resolveInstalledGitCommit(pkg, ctx, pi)
          : undefined;
      return {
        pkg,
        ...(version ? { version } : {}),
        ...(gitCommit ? { gitCommit } : {}),
      };
    })
  );
}

function installedRuntimeMatchesProfileTarget(
  runtime: InstalledRuntimeTarget,
  target: ProfilePackage,
  ctx: ExtensionCommandContext
): boolean {
  const { pkg: candidate } = runtime;
  if (candidate.scope !== target.scope) return false;
  const expectedIdentity = getProfilePackageIdentity(target, {
    projectCwd: ctx.cwd,
    globalCwd: getAgentDir(),
  });
  const actualIdentity = normalizePackageIdentity(candidate.source, {
    ...(candidate.resolvedPath ? { resolvedPath: candidate.resolvedPath } : {}),
    cwd: candidate.scope === "project" ? getProjectConfigDir(ctx.cwd) : getAgentDir(),
  });
  if (actualIdentity !== expectedIdentity) return false;

  const expectedSource = getEffectivePackageSource(target);
  const expectedKind = getPackageSourceKind(expectedSource);
  if (expectedKind === "npm") {
    const expectedVersion = parsePackageNameAndVersion(expectedSource).version;
    return !expectedVersion || runtime.version === expectedVersion;
  }
  if (expectedKind === "git") {
    const expectedRef = splitGitRepoAndRef(stripGitSourcePrefix(expectedSource)).ref;
    if (!expectedRef) return true;
    if (runtime.gitCommit) return runtime.gitCommit === expectedRef;
    const configuredRef = splitGitRepoAndRef(stripGitSourcePrefix(candidate.source)).ref;
    return configuredRef === expectedRef;
  }
  return true;
}

export async function calculateProfileDiagnostics(
  desired: ExtmgrProfile,
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<ProfilePackageDiagnostic[]> {
  const installed = await getInstalledPackagesAllScopes(ctx);
  const [runtimeTargets, compatibility] = await Promise.all([
    describeInstalledRuntimeTargets(installed, ctx, pi),
    inspectInstalledPackageCompatibility(installed),
  ]);
  return desired.packages.map((pkg) => {
    const source = getEffectivePackageSource(pkg);
    const runtime = runtimeTargets.find((candidate) =>
      installedRuntimeMatchesProfileTarget(candidate, pkg, ctx)
    );
    const local = runtime
      ? compatibility.find(
          (candidate) =>
            candidate.scope === runtime.pkg.scope && candidate.source === runtime.pkg.source
        )
      : undefined;
    const compatibilityStatus =
      local && (local.node === "incompatible" || local.pi === "incompatible")
        ? "failed"
        : !local || local.node === "unknown" || local.pi === "unknown"
          ? "unknown"
          : "verified";
    return {
      source,
      scope: pkg.scope,
      compatibility: compatibilityStatus,
      // Pi's public package APIs do not expose artifact integrity evidence.
      integrity: "unknown",
      notes: [
        ...(!local
          ? ["exact target is not installed; compatibility cannot be established before install"]
          : local.reasons),
        "artifact integrity is unavailable through Pi public APIs",
      ],
    };
  });
}

function validateOwnedProfile(profile: ExtmgrProfile): string[] {
  const parsed = parseExternalProfile(profile);
  return parsed.ok ? [] : parsed.errors.map((issue) => `${issue.path}: ${issue.message}`);
}

function requiresInstall(
  change: { from: ProfilePackage; to: ProfilePackage },
  ctx?: ExtensionCommandContext
): boolean {
  if (change.from.scope !== change.to.scope) return true;
  const fromSource = getEffectivePackageSource(change.from);
  const toSource = getEffectivePackageSource(change.to);
  if (getPackageSourceKind(fromSource) === "local" && getPackageSourceKind(toSource) === "local") {
    if (!ctx) return fromSource !== toSource;
    return (
      getProfilePackageIdentity(change.from, {
        projectCwd: ctx.cwd,
        globalCwd: getAgentDir(),
      }) !==
      getProfilePackageIdentity(change.to, {
        projectCwd: ctx.cwd,
        globalCwd: getAgentDir(),
      })
    );
  }
  return fromSource !== toSource;
}

async function verifyInstalledTargets(
  desired: ExtmgrProfile,
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<string[]> {
  const installed = await getInstalledPackagesAllScopes(ctx);
  const runtimeTargets = await describeInstalledRuntimeTargets(installed, ctx, pi);
  const missing: string[] = [];
  for (const pkg of desired.packages) {
    const source = getEffectivePackageSource(pkg);
    if (
      !runtimeTargets.some((candidate) => installedRuntimeMatchesProfileTarget(candidate, pkg, ctx))
    ) {
      missing.push(`${source} (${pkg.scope})`);
    }
  }
  return missing;
}

function profileSourcesMatch(
  left: ProfilePackage,
  right: ProfilePackage,
  ctx: ExtensionCommandContext
): boolean {
  const leftSource = getEffectivePackageSource(left);
  const rightSource = getEffectivePackageSource(right);
  const sameSource =
    getPackageSourceKind(leftSource) === "local" && getPackageSourceKind(rightSource) === "local"
      ? getProfilePackageIdentity(left, {
          projectCwd: ctx.cwd,
          globalCwd: getAgentDir(),
        }) ===
        getProfilePackageIdentity(right, {
          projectCwd: ctx.cwd,
          globalCwd: getAgentDir(),
        })
      : leftSource === rightSource;
  return left.scope === right.scope && sameSource;
}

async function verifyFinalProfile(
  desired: ExtmgrProfile,
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<string[]> {
  const actual = await getCurrentProfile(ctx, pi);
  const drift: string[] = [];
  for (const pkg of desired.packages) {
    const match = actual.packages.find(
      (candidate) =>
        profileSourcesMatch(candidate, pkg, ctx) &&
        JSON.stringify(candidate.filters) === JSON.stringify(pkg.filters) &&
        (pkg.packageSettings === undefined ||
          JSON.stringify(candidate.packageSettings ?? {}) === JSON.stringify(pkg.packageSettings))
    );
    if (!match) drift.push(`${getEffectivePackageSource(pkg)} (${pkg.scope})`);
  }
  for (const pkg of actual.packages) {
    const match = desired.packages.some((candidate) => profileSourcesMatch(candidate, pkg, ctx));
    if (!match) drift.push(`unexpected ${getEffectivePackageSource(pkg)} (${pkg.scope})`);
  }
  return [...new Set(drift)];
}

async function rollbackProfile(
  current: ExtmgrProfile,
  desired: ExtmgrProfile,
  plan: ProfilePlan,
  ctx: ExtensionCommandContext,
  operations: ProfileApplicationOperation[],
  pi: ExtensionAPI
): Promise<boolean> {
  const errors: string[] = [];
  const attempt = async (
    operation: Omit<ProfileApplicationOperation, "status">,
    run: () => Promise<void>
  ): Promise<void> => {
    try {
      await run();
      operations.push({ ...operation, status: "completed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      operations.push({ ...operation, status: "failed", error: message });
    }
  };
  for (const change of plan.update.filter((item) => requiresInstall(item, ctx))) {
    await attempt(
      {
        action: "rollback",
        source: profileMutationSource(change.from, ctx.cwd),
        scope: change.from.scope,
      },
      () =>
        getPackageCatalog(ctx.cwd, isProjectTrusted(ctx)).install(
          profileMutationSource(change.from, ctx.cwd),
          change.from.scope
        )
    );
  }
  for (const pkg of plan.remove) {
    await attempt(
      { action: "rollback", source: profileMutationSource(pkg, ctx.cwd), scope: pkg.scope },
      () =>
        getPackageCatalog(ctx.cwd, isProjectTrusted(ctx)).install(
          profileMutationSource(pkg, ctx.cwd),
          pkg.scope
        )
    );
  }
  await attempt({ action: "rollback" }, () => persistProfileConfiguration(current, ctx));
  for (const pkg of plan.add) {
    await attempt(
      { action: "rollback", source: profileMutationSource(pkg, ctx.cwd), scope: pkg.scope },
      () =>
        getPackageCatalog(ctx.cwd, isProjectTrusted(ctx)).remove(
          profileMutationSource(pkg, ctx.cwd),
          pkg.scope
        )
    );
  }
  for (const change of plan.update.filter((item) => item.from.scope !== item.to.scope)) {
    await attempt(
      {
        action: "rollback",
        source: profileMutationSource(change.to, ctx.cwd),
        scope: change.to.scope,
      },
      () =>
        getPackageCatalog(ctx.cwd, isProjectTrusted(ctx)).remove(
          profileMutationSource(change.to, ctx.cwd),
          change.to.scope
        )
    );
  }
  const drift = await verifyFinalProfile(current, ctx, pi).catch((error) => [String(error)]);
  return errors.length === 0 && drift.length === 0 && desired.schemaVersion === 1;
}

/** Apply only after strict preflight, local policy diagnostics, and confirmation. */
export async function applyProfileWithOutcome(
  current: ExtmgrProfile,
  desired: ExtmgrProfile,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  options?: { reviewed?: boolean }
): Promise<ProfileApplicationOutcome> {
  const validationProblems = [
    ...validateOwnedProfile(current).map((problem) => `current: ${problem}`),
    ...validateOwnedProfile(desired).map((problem) => `desired: ${problem}`),
  ];
  if (validationProblems.length > 0) {
    notify(
      ctx,
      `Profile validation rejected application:\n${validationProblems.map((problem) => `- ${problem}`).join("\n")}`,
      "error"
    );
    return { applied: false, reloaded: false, operations: [] };
  }
  const diagnostics = await calculateProfileDiagnostics(desired, ctx, pi);
  const policy = await loadProjectProfilePolicy(ctx.cwd, undefined, isProjectTrusted(ctx));
  const violations = policy ? validateProfilePolicy(desired, policy, diagnostics) : [];
  if (violations.length > 0) {
    notify(
      ctx,
      `Profile policy rejected application:\n${violations.map((violation) => `- ${violation.message}`).join("\n")}`,
      "error"
    );
    return { applied: false, reloaded: false, operations: [] };
  }

  const plan = planProfileApplication(current, desired, {
    projectCwd: ctx.cwd,
    globalCwd: getAgentDir(),
  });
  if (plan.add.length + plan.remove.length + plan.update.length === 0) {
    notify(ctx, "Profile already matches the installed package state.", "info");
    return { applied: false, reloaded: false, operations: [] };
  }
  if (
    options?.reviewed !== true &&
    !(await confirmAction(
      ctx,
      "Apply profile",
      `${desired.name}\n\n${formatPlan(plan)}\n\nApply these changes?`
    ))
  ) {
    notify(ctx, "Profile application cancelled.", "info");
    return { applied: false, reloaded: false, operations: [] };
  }

  const restorePoint = await saveProfileRestorePoint(current, `Before applying ${desired.name}`);
  const operations: ProfileApplicationOperation[] = [];
  let pendingOperation: Omit<ProfileApplicationOperation, "status"> | undefined;
  try {
    await runTaskWithLoader(
      ctx,
      { title: "Apply profile", message: `Applying ${desired.name}...`, cancellable: false },
      async ({ setMessage }) => {
        for (const pkg of plan.add) {
          const source = profileMutationSource(pkg, ctx.cwd);
          setMessage(`Installing ${source}...`);
          pendingOperation = { action: "install", source, scope: pkg.scope };
          await getPackageCatalog(ctx.cwd, isProjectTrusted(ctx)).install(source, pkg.scope);
          operations.push({ ...pendingOperation, status: "completed" });
          pendingOperation = undefined;
        }
        for (const change of plan.update.filter((item) => requiresInstall(item, ctx))) {
          const source = profileMutationSource(change.to, ctx.cwd);
          setMessage(`Installing replacement ${source}...`);
          pendingOperation = { action: "install", source, scope: change.to.scope };
          await getPackageCatalog(ctx.cwd, isProjectTrusted(ctx)).install(source, change.to.scope);
          operations.push({ ...pendingOperation, status: "completed" });
          pendingOperation = undefined;
        }
        pendingOperation = { action: "verify" };
        const missingBeforePersist = await verifyInstalledTargets(
          {
            ...desired,
            packages: desired.packages.filter(
              (pkg) =>
                plan.add.includes(pkg) ||
                plan.update.some((change) => change.to === pkg && requiresInstall(change, ctx))
            ),
          },
          ctx,
          pi
        );
        if (missingBeforePersist.length > 0)
          throw new Error(
            `Installed result verification failed: ${missingBeforePersist.join(", ")}`
          );
        pendingOperation = undefined;

        setMessage("Preserving complete package settings and filters...");
        pendingOperation = { action: "settings" };
        await persistProfileConfiguration(desired, ctx);
        operations.push({ ...pendingOperation, status: "completed" });
        pendingOperation = undefined;

        for (const pkg of plan.remove) {
          const source = profileMutationSource(pkg, ctx.cwd);
          setMessage(`Removing obsolete ${source}...`);
          pendingOperation = { action: "remove", source, scope: pkg.scope };
          await getPackageCatalog(ctx.cwd, isProjectTrusted(ctx)).remove(source, pkg.scope);
          operations.push({ ...pendingOperation, status: "completed" });
          pendingOperation = undefined;
        }
        for (const change of plan.update.filter((item) => item.from.scope !== item.to.scope)) {
          const source = profileMutationSource(change.from, ctx.cwd);
          setMessage(`Removing old-scope ${source}...`);
          pendingOperation = { action: "remove", source, scope: change.from.scope };
          await getPackageCatalog(ctx.cwd, isProjectTrusted(ctx)).remove(source, change.from.scope);
          operations.push({ ...pendingOperation, status: "completed" });
          pendingOperation = undefined;
        }
        pendingOperation = { action: "verify" };
        const drift = await verifyFinalProfile(desired, ctx, pi);
        if (drift.length > 0)
          throw new Error(`Final-state verification detected drift: ${drift.join(", ")}`);
        operations.push({ ...pendingOperation, status: "completed" });
        pendingOperation = undefined;
        return undefined;
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    operations.push({
      ...(pendingOperation ?? { action: "verify" }),
      status: "failed",
      error: message,
    });
    const restored = await rollbackProfile(current, desired, plan, ctx, operations, pi);
    if (!restored) {
      await markProfileRestorePointIncomplete(restorePoint.id);
      await markReloadRequired(`Profile ${desired.name} rollback is incomplete.`);
    }
    notify(
      ctx,
      `Profile ${desired.name} failed: ${message}\nRollback ${restored ? "completed" : "incomplete"}. Restore point: ${restorePoint.id}\n${operations.map((item) => `- ${item.action} ${item.source ?? "configuration"}: ${item.status}${item.error ? ` (${item.error})` : ""}`).join("\n")}`,
      "error"
    );
    return {
      applied: false,
      reloaded: false,
      restored,
      restorePointId: restorePoint.id,
      operations,
    };
  }

  notify(ctx, `Applied profile ${desired.name}.`, "info");
  const reloaded = await confirmReload(ctx, "Profile package configuration changed.");
  return { applied: true, reloaded, restorePointId: restorePoint.id, operations };
}

/** Route every interactive apply through the same inline review gate. */
export async function reviewAndApplyProfileWithOutcome(
  current: ExtmgrProfile,
  desired: ExtmgrProfile,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<ProfileApplicationOutcome> {
  if (!ctx.hasUI) return applyProfileWithOutcome(current, desired, ctx, pi);

  const plan = planProfileApplication(current, desired, {
    projectCwd: ctx.cwd,
    globalCwd: getAgentDir(),
  });
  if (plan.add.length + plan.remove.length + plan.update.length === 0) {
    return applyProfileWithOutcome(current, desired, ctx, pi);
  }

  const policy = await loadProjectProfilePolicy(ctx.cwd, undefined, isProjectTrusted(ctx));
  const diagnostics = policy ? await calculateProfileDiagnostics(desired, ctx, pi) : [];
  const violations = policy ? validateProfilePolicy(desired, policy, diagnostics) : [];
  const review = await showProfileDiff(current, desired, violations, ctx);
  if (review !== "apply") {
    return { applied: false, reloaded: false, operations: [] };
  }
  return applyProfileWithOutcome(current, desired, ctx, pi, { reviewed: true });
}

interface ParsedOptions {
  positionals: string[];
  json: boolean;
  strict: boolean;
  force: boolean;
  name?: string;
}

function parseOptions(tokens: string[]): ParsedOptions {
  const positionals: string[] = [];
  let json = false;
  let strict = false;
  let force = false;
  let name: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--json") json = true;
    else if (token === "--strict") strict = true;
    else if (token === "--force" || token === "--replace") force = true;
    else if (token === "--name") {
      const value = tokens[index + 1];
      if (!value) throw new Error("--name requires a value.");
      name = value;
      index += 1;
    } else if (token?.startsWith("--")) throw new Error(`Unknown option: ${token}`);
    else if (token) positionals.push(token);
  }
  return { positionals, json, strict, force, ...(name ? { name } : {}) };
}

function withImportMetadata(profile: ExtmgrProfile, loaded: LoadedProfileSource): ExtmgrProfile {
  return {
    ...profile,
    importMetadata: {
      origin: loaded.origin,
      finalOrigin: loaded.finalOrigin,
      ...(loaded.fetchedAt ? { fetchedAt: loaded.fetchedAt } : {}),
      contentFingerprint: loaded.contentFingerprint,
      warnings: [...loaded.warnings],
    },
  };
}

async function saveImportedProfile(
  profile: ExtmgrProfile,
  loaded: LoadedProfileSource,
  options: ParsedOptions,
  ctx: ExtensionCommandContext
): Promise<void> {
  let imported = withImportMetadata(
    { ...profile, ...(options.name ? { name: options.name.trim() } : {}) },
    loaded
  );
  if (!imported.name.trim()) throw new Error("Imported profile requires a name or --name value.");
  const storePath = getProfileStorePath();
  const existing = getNamedProfile(await readProfileStore(storePath), imported.name);
  let replace = options.force;
  if (existing && !replace) {
    if (!ctx.hasUI)
      throw new Error(
        `A saved profile named ${imported.name} already exists; pass --force to replace it.`
      );
    const choice = await ctx.ui.select("Profile name collision", ["Overwrite", "Rename", "Cancel"]);
    if (choice === "Overwrite") replace = true;
    else if (choice === "Rename") {
      const renamed = await ctx.ui.input("Imported profile name", imported.name);
      if (!renamed?.trim()) return;
      imported = { ...imported, name: renamed.trim() };
    } else return;
  }
  await saveNamedProfile(storePath, imported, { replace });
  notify(ctx, `Imported profile ${imported.name}. It was saved but not applied.`, "info");
}

async function handleImport(
  tokens: string[],
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<void> {
  const options = parseOptions(tokens);
  const source = options.positionals[0];
  if (!source)
    throw new Error(
      "Usage: /extensions profile import <local-path|https-url> [--name <name>] [--force]"
    );
  const loaded = await loadProfileSource(source, {
    cwd: ctx.cwd,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const parsed = parseExternalProfile(loaded.value, { requireName: !options.name });
  if (!parsed.ok)
    throw new Error(parsed.errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  const profile = options.name ? { ...parsed.profile, name: options.name.trim() } : parsed.profile;
  const current = await getCurrentProfile(ctx, pi);
  const plan = planProfileApplication(current, profile, {
    projectCwd: ctx.cwd,
    globalCwd: getAgentDir(),
  });
  const importDiagnostics = await calculateProfileDiagnostics(profile, ctx, pi);
  const importPolicy = await loadProjectProfilePolicy(ctx.cwd, undefined, isProjectTrusted(ctx));
  const importViolations = importPolicy
    ? validateProfilePolicy(profile, importPolicy, importDiagnostics)
    : [];
  const summary = [
    `Origin: ${loaded.origin}`,
    `Final origin: ${loaded.finalOrigin}`,
    `Origin status: ${loaded.immutableOrigin === true ? "immutable" : loaded.immutableOrigin === false ? "floating" : "local"}`,
    `Content fingerprint: ${loaded.contentFingerprint}`,
    `Schema: v${parsed.migration.fromVersion}${parsed.migration.migrated ? " (migrated)" : ""}`,
    `Packages: ${profile.packages.length} (${profile.packages.filter((pkg) => pkg.scope === "global").length} global, ${profile.packages.filter((pkg) => pkg.scope === "project").length} project)`,
    `Preview: ${plan.add.length} add, ${plan.remove.length} remove, ${plan.update.length} change`,
    `Policy: ${importViolations.length === 0 ? "pass" : `${importViolations.length} violation(s)`}`,
    `Compatibility: ${importDiagnostics.filter((item) => item.compatibility === "unknown").length} unknown`,
    `Integrity: ${importDiagnostics.filter((item) => item.integrity === "unknown").length} unknown`,
    ...importViolations.map((violation) => `Policy violation: ${violation.message}`),
    ...[...parsed.warnings, ...loaded.warnings].map((warning) => `Warning: ${warning}`),
  ].join("\n");
  notify(ctx, summary, loaded.warnings.length > 0 ? "warning" : "info");
  if (ctx.hasUI) {
    const action = await ctx.ui.select("Import profile", ["Save", "Review changes", "Cancel"]);
    if (action === "Cancel" || !action) return;
    if (action === "Review changes") {
      notify(ctx, formatPlan(plan), "info");
      if (
        !(await confirmAction(
          ctx,
          "Save imported profile",
          "Save this profile without applying it?"
        ))
      )
        return;
    }
  }
  await saveImportedProfile(profile, loaded, options, ctx);
}

export interface ProfileCheckResult {
  ok: boolean;
  valid: boolean;
  drift: boolean | null;
  strict: boolean;
  status: "ok" | "drift" | "invalid" | "policy-violation" | "diagnostic-failure" | "origin-warning";
  counts: { add: number; remove: number; change: number };
  policyViolations: string[];
  compatibilityUnknown: string[];
  compatibilityFailed: string[];
  integrityUnknown: string[];
  integrityFailed: string[];
  originWarnings: string[];
  changes: {
    add: ProfilePackage[];
    remove: ProfilePackage[];
    update: Array<{ from: ProfilePackage; to: ProfilePackage }>;
  };
  error?: string;
}

function invalidProfileCheckResult(error: unknown, strict: boolean): ProfileCheckResult {
  return {
    ok: false,
    valid: false,
    drift: null,
    strict,
    status: "invalid",
    counts: { add: 0, remove: 0, change: 0 },
    policyViolations: [],
    compatibilityUnknown: [],
    compatibilityFailed: [],
    integrityUnknown: [],
    integrityFailed: [],
    originWarnings: [],
    changes: { add: [], remove: [], update: [] },
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Check semantics:
 * - non-strict mode validates and reports drift without treating drift as failure;
 * - confirmed diagnostic failures and project-policy violations always fail;
 * - strict mode additionally fails on drift or a floating-origin warning;
 * - unknown diagnostics remain informational unless project policy requires them.
 */
export async function checkProfileSource(
  source: string,
  ctx: ExtensionCommandContext,
  options?: { strict?: boolean; pi?: ExtensionAPI }
): Promise<ProfileCheckResult> {
  const strict = options?.strict ?? false;
  try {
    const loaded = await loadProfileSource(source, {
      cwd: ctx.cwd,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const parsed = parseExternalProfile(loaded.value);
    if (!parsed.ok)
      throw new Error(parsed.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    const current = await getCurrentProfile(ctx, options?.pi);
    const plan = planProfileApplication(current, parsed.profile, {
      projectCwd: ctx.cwd,
      globalCwd: getAgentDir(),
    });
    const diagnostics = await calculateProfileDiagnostics(parsed.profile, ctx, options?.pi);
    const policy = await loadProjectProfilePolicy(ctx.cwd, undefined, isProjectTrusted(ctx));
    const violations = policy ? validateProfilePolicy(parsed.profile, policy, diagnostics) : [];
    const originWarnings = [
      ...new Set([...loaded.warnings, ...(parsed.profile.importMetadata?.warnings ?? [])]),
    ];
    const drift = plan.add.length + plan.remove.length + plan.update.length > 0;
    const hasDiagnosticFailure = diagnostics.some(
      (item) => item.compatibility === "failed" || item.integrity === "failed"
    );
    const status: ProfileCheckResult["status"] =
      violations.length > 0
        ? "policy-violation"
        : hasDiagnosticFailure
          ? "diagnostic-failure"
          : drift
            ? "drift"
            : originWarnings.length > 0
              ? "origin-warning"
              : "ok";
    return {
      ok:
        violations.length === 0 &&
        !hasDiagnosticFailure &&
        (!strict || (!drift && originWarnings.length === 0)),
      valid: true,
      drift,
      strict,
      status,
      counts: { add: plan.add.length, remove: plan.remove.length, change: plan.update.length },
      policyViolations: violations.map((violation) => violation.message),
      compatibilityUnknown: diagnostics
        .filter((item) => item.compatibility === "unknown")
        .map((item) => `${item.source} (${item.scope})`),
      compatibilityFailed: diagnostics
        .filter((item) => item.compatibility === "failed")
        .map((item) => `${item.source} (${item.scope})`),
      integrityUnknown: diagnostics
        .filter((item) => item.integrity === "unknown")
        .map((item) => `${item.source} (${item.scope})`),
      integrityFailed: diagnostics
        .filter((item) => item.integrity === "failed")
        .map((item) => `${item.source} (${item.scope})`),
      originWarnings,
      changes: plan,
    };
  } catch (error) {
    return invalidProfileCheckResult(error, strict);
  }
}

async function handleCheck(
  tokens: string[],
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<void> {
  const options = parseOptions(tokens);
  const source = options.positionals[0];
  const result = source
    ? await checkProfileSource(source, ctx, { strict: options.strict, ...(pi ? { pi } : {}) })
    : invalidProfileCheckResult(
        new Error("Usage: /extensions profile check <source> [--json] [--strict]"),
        options.strict
      );
  if (options.json) {
    const encoded = JSON.stringify(result);
    if (ctx.hasUI) ctx.ui.notify(encoded, result.ok ? "info" : "error");
    else console.log(encoded);
    return;
  }
  notify(
    ctx,
    [
      `Profile: ${result.valid ? "valid" : "invalid"}`,
      `Drift: ${result.drift === null ? "unknown" : result.drift ? "yes" : "no"}`,
      `Changes: ${result.counts.add} add, ${result.counts.remove} remove, ${result.counts.change} change`,
      `Status: ${result.status}`,
      ...(result.policyViolations.length
        ? [`Policy violations: ${result.policyViolations.join("; ")}`]
        : []),
      ...(result.compatibilityFailed.length
        ? [`Compatibility failed: ${result.compatibilityFailed.join(", ")}`]
        : []),
      ...(result.compatibilityUnknown.length
        ? [`Compatibility unknown: ${result.compatibilityUnknown.join(", ")}`]
        : []),
      ...(result.integrityFailed.length
        ? [`Integrity failed: ${result.integrityFailed.join(", ")}`]
        : []),
      ...(result.integrityUnknown.length
        ? [`Integrity unknown: ${result.integrityUnknown.join(", ")}`]
        : []),
      ...result.originWarnings.map((warning) => `Warning: ${warning}`),
      ...(result.error ? [`Error: ${result.error}`] : []),
      ...(options.strict
        ? [
            "Strict mode fails on drift, confirmed diagnostic failures, policy violations, and floating-origin warnings. Unknown diagnostics fail only when policy requires them.",
            "Pi's command API has no supported process status channel; failures are reported without terminating Pi.",
          ]
        : []),
    ].join("\n"),
    result.ok ? "info" : "error"
  );
}

async function handleRecover(
  tokens: string[],
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<void> {
  const points = await readProfileRestorePoints();
  const requested = tokens[0];
  if (!requested || requested === "list") {
    notify(
      ctx,
      points.length
        ? `Profile restore points:\n${points.map((point, index) => `${index + 1}. ${point.id}${point.incomplete ? " (incomplete rollback)" : ""} - ${point.reason}`).join("\n")}`
        : "No profile restore points.",
      "info"
    );
    return;
  }
  const point =
    points.find((candidate) => candidate.id === requested) ?? points[Number(requested) - 1];
  if (!point) throw new Error(`Profile restore point not found: ${requested}`);
  if (!pi) throw new Error("Profile recovery requires the extension API.");
  const current = await getCurrentProfile(ctx, pi);
  await reviewAndApplyProfileWithOutcome(
    current,
    { ...point.profile, name: `restore-${point.id}` },
    ctx,
    pi
  );
}

export async function handleProfileSubcommand(
  tokens: string[],
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<void> {
  const action = tokens[0];
  if (
    !action ||
    ![
      "export",
      "save",
      "list",
      "delete",
      "dry-run",
      "apply",
      "compare",
      "import",
      "check",
      "recover",
    ].includes(action)
  ) {
    notify(ctx, PROFILE_USAGE, "info");
    return;
  }
  try {
    if (action === "import") return await handleImport(tokens.slice(1), ctx, pi);
    if (action === "check") return await handleCheck(tokens.slice(1), ctx, pi);
    if (action === "recover") return await handleRecover(tokens.slice(1), ctx, pi);
    const requested = tokens[1];
    const storePath = getProfileStorePath();
    if (action === "list") {
      const names = Object.keys((await readProfileStore(storePath)).profiles).sort();
      notify(
        ctx,
        names.length ? `Saved profiles:\n${names.join("\n")}` : "No saved profiles.",
        "info"
      );
      return;
    }
    if (action === "save") {
      if (!requested?.trim()) {
        notify(ctx, "Usage: /extensions profile save <name>", "info");
        return;
      }
      const profile = { ...(await getCurrentProfile(ctx, pi)), name: requested.trim() };
      const existing = getNamedProfile(await readProfileStore(storePath), profile.name);
      let replace = tokens.includes("--force") || tokens.includes("--replace");
      if (existing && !replace && ctx.hasUI)
        replace = await confirmAction(ctx, "Replace saved profile", `Replace ${profile.name}?`);
      await saveNamedProfile(storePath, profile, { replace });
      notify(ctx, `Saved profile ${profile.name}.`, "info");
      return;
    }
    if (action === "delete") {
      if (!requested || !(await deleteNamedProfile(storePath, requested)))
        notify(ctx, `Saved profile not found: ${requested ?? "(missing name)"}`, "warning");
      else notify(ctx, `Deleted profile ${requested}.`, "info");
      return;
    }

    const current = await getCurrentProfile(ctx, pi);
    if (action === "export") {
      if (!requested) {
        notify(ctx, "Usage: /extensions profile export <path>", "info");
        return;
      }
      const destination = resolve(ctx.cwd, requested);
      await writeFile(destination, `${JSON.stringify(current, null, 2)}\n`, { flag: "wx" });
      notify(ctx, `Exported profile to ${destination}`, "info");
      return;
    }
    const desired = await resolveNamedOrSourceProfile(requested, ctx);
    if (!desired) {
      notify(ctx, "No saved profile selected.", "info");
      return;
    }
    const plan = planProfileApplication(current, desired, {
      projectCwd: ctx.cwd,
      globalCwd: getAgentDir(),
    });
    if (action === "apply") {
      if (!pi) throw new Error("Profile application requires the extension API.");
      await reviewAndApplyProfileWithOutcome(current, desired, ctx, pi);
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
