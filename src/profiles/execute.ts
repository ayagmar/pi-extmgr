/**
 * Profile application engine: validated, policy-gated execution with
 * settings persistence, final-state verification, and rollback to a saved
 * restore point on any failure.
 */
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
  type PackageSource,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getPackageCatalog } from "../packages/catalog.js";
import { runTaskWithLoader } from "../ui/async-task.js";
import {
  describeProfilePackage,
  describeProfilePackageChanges,
  describeProfilePackageSettings,
  showProfileDiff,
} from "../ui/profile-review.js";
import { hasCustomUI, isProjectTrusted } from "../utils/mode.js";
import { notify } from "../utils/notify.js";
import {
  getPackageSourceKind,
  normalizePackageIdentity,
  packageSourceString,
} from "../utils/package-source.js";
import { getProjectConfigDir } from "../utils/pi-paths.js";
import { markReloadRequired } from "../utils/reload-state.js";
import { throwIfSettingsErrors } from "../utils/settings-errors.js";
import { confirmAction, confirmReload } from "../utils/ui-helpers.js";
import { type ProfilePlan } from "./apply.js";
import {
  evaluateProfileReview,
  formatProfileReviewDetails,
  PROJECT_TRUST_REQUIRED,
  type ProfileReview,
} from "./review.js";
import {
  calculateProfileDiagnostics,
  profileMutationSource,
  verifyFinalProfile,
  verifyInstalledTargets,
} from "./runtime-state.js";
import {
  type ExtmgrProfile,
  getEffectivePackageSource,
  getProfilePackageIdentity,
  type ProfilePackage,
  parseExternalProfile,
} from "./schema.js";
import { markProfileRestorePointIncomplete, saveProfileRestorePoint } from "./store.js";

/** Package manager output would corrupt pi's TUI, so it is captured there. */
function mutationCatalog(ctx: ExtensionCommandContext) {
  return getPackageCatalog(ctx.cwd, isProjectTrusted(ctx), {
    suppressOutput: ctx.mode === "tui",
  });
}
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

export function formatPlan(plan: ProfilePlan): string {
  return [
    `Add: ${plan.add.length}`,
    ...plan.add.flatMap((pkg) => [
      `  + ${describeProfilePackage(pkg)}`,
      ...describeProfilePackageSettings(pkg).map((detail) => `    ${detail}`),
    ]),
    `Remove: ${plan.remove.length}`,
    ...plan.remove.flatMap((pkg) => [
      `  - ${describeProfilePackage(pkg)}`,
      ...describeProfilePackageSettings(pkg, "-").map((detail) => `    ${detail}`),
    ]),
    `Change: ${plan.update.length}`,
    ...plan.update.flatMap(({ from, to }) => [
      `  ~ ${describeProfilePackage(from)} -> ${describeProfilePackage(to)}`,
      ...describeProfilePackageChanges(from, to).map((change) => `    ${change}`),
    ]),
  ].join("\n");
}

function formatProfileApplySummary(review: ProfileReview): string {
  return [formatPlan(review.plan), ...formatProfileReviewDetails(review)].join("\n");
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
  const projectTrusted = isProjectTrusted(ctx);
  const projectPackages = desired.packages.filter((pkg) => pkg.scope === "project");
  if (!projectTrusted && projectPackages.length > 0) {
    throw new Error(PROJECT_TRUST_REQUIRED);
  }
  const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted });
  throwIfSettingsErrors(settings, "Profile application");
  const global = settings.getGlobalSettings();
  settings.setPackages(
    buildScopedPackageSettings(
      global,
      desired.packages.filter((pkg) => pkg.scope === "global"),
      ctx.cwd
    )
  );
  // pi refuses project settings writes in untrusted projects; there is nothing
  // to write there anyway, since untrusted project settings are never loaded.
  if (projectTrusted) {
    settings.setProjectPackages(
      buildScopedPackageSettings(settings.getProjectSettings(), projectPackages, ctx.cwd)
    );
  }
  await settings.flush();
  throwIfSettingsErrors(settings, "Profile application");
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
        mutationCatalog(ctx).install(profileMutationSource(change.from, ctx.cwd), change.from.scope)
    );
  }
  for (const pkg of plan.remove) {
    await attempt(
      { action: "rollback", source: profileMutationSource(pkg, ctx.cwd), scope: pkg.scope },
      () => mutationCatalog(ctx).install(profileMutationSource(pkg, ctx.cwd), pkg.scope)
    );
  }
  await attempt({ action: "rollback" }, () => persistProfileConfiguration(current, ctx));
  for (const pkg of plan.add) {
    await attempt(
      { action: "rollback", source: profileMutationSource(pkg, ctx.cwd), scope: pkg.scope },
      () => mutationCatalog(ctx).remove(profileMutationSource(pkg, ctx.cwd), pkg.scope)
    );
  }
  for (const change of plan.update.filter((item) => item.from.scope !== item.to.scope)) {
    await attempt(
      {
        action: "rollback",
        source: profileMutationSource(change.to, ctx.cwd),
        scope: change.to.scope,
      },
      () => mutationCatalog(ctx).remove(profileMutationSource(change.to, ctx.cwd), change.to.scope)
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
  options?: { preflight?: ProfileReview; originWarnings?: string[] }
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
  const review =
    options?.preflight ??
    (await evaluateProfileReview(current, desired, ctx, pi, {
      ...(options?.originWarnings ? { originWarnings: options.originWarnings } : {}),
    }));
  const reviewSummary = formatProfileApplySummary(review);
  if (review.blockingReasons.length > 0) {
    notify(ctx, `Profile preflight rejected application:\n${reviewSummary}`, "error");
    return { applied: false, reloaded: false, operations: [] };
  }

  const plan = review.plan;
  if (!review.hasChanges) {
    notify(ctx, `Profile already matches the installed package state.\n\n${reviewSummary}`, "info");
    return { applied: false, reloaded: false, operations: [] };
  }
  if (options?.preflight === undefined) {
    if (!ctx.hasUI) {
      notify(ctx, `Profile apply summary:\n${reviewSummary}`, "info");
    } else if (
      !(await confirmAction(
        ctx,
        "Apply profile",
        `${desired.name}\n\n${reviewSummary}\n\nApply these changes?`
      ))
    ) {
      notify(ctx, "Profile application cancelled.", "info");
      return { applied: false, reloaded: false, operations: [] };
    }
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
          await mutationCatalog(ctx).install(source, pkg.scope);
          operations.push({ ...pendingOperation, status: "completed" });
          pendingOperation = undefined;
        }
        for (const change of plan.update.filter((item) => requiresInstall(item, ctx))) {
          const source = profileMutationSource(change.to, ctx.cwd);
          setMessage(`Installing replacement ${source}...`);
          pendingOperation = { action: "install", source, scope: change.to.scope };
          await mutationCatalog(ctx).install(source, change.to.scope);
          operations.push({ ...pendingOperation, status: "completed" });
          pendingOperation = undefined;
        }
        pendingOperation = { action: "verify" };
        const installedTargets = [
          ...plan.add,
          ...plan.update
            .filter((change) => requiresInstall(change, ctx))
            .map((change) => change.to),
        ];
        const missingBeforePersist = await verifyInstalledTargets(
          { ...desired, packages: installedTargets },
          ctx,
          pi
        );
        if (missingBeforePersist.length > 0)
          throw new Error(
            `Installed result verification failed: ${missingBeforePersist.join(", ")}`
          );
        const postInstallDiagnostics = await calculateProfileDiagnostics(
          { ...desired, packages: installedTargets },
          ctx,
          pi
        );
        const postInstallFailures = postInstallDiagnostics.filter(
          (diagnostic) => diagnostic.compatibility === "failed" || diagnostic.integrity === "failed"
        );
        if (postInstallFailures.length > 0)
          throw new Error(
            `Post-install diagnostic verification failed: ${postInstallFailures.map((diagnostic) => `${diagnostic.source} (${diagnostic.scope})`).join(", ")}`
          );
        operations.push({ ...pendingOperation, status: "completed" });
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
          await mutationCatalog(ctx).remove(source, pkg.scope);
          operations.push({ ...pendingOperation, status: "completed" });
          pendingOperation = undefined;
        }
        for (const change of plan.update.filter((item) => item.from.scope !== item.to.scope)) {
          const source = profileMutationSource(change.from, ctx.cwd);
          setMessage(`Removing old-scope ${source}...`);
          pendingOperation = { action: "remove", source, scope: change.from.scope };
          await mutationCatalog(ctx).remove(source, change.from.scope);
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
  pi: ExtensionAPI,
  options?: { originWarnings?: string[] }
): Promise<ProfileApplicationOutcome> {
  if (!hasCustomUI(ctx)) return applyProfileWithOutcome(current, desired, ctx, pi, options);

  const preflight = await evaluateProfileReview(current, desired, ctx, pi, options);
  if (!preflight.hasChanges) {
    return applyProfileWithOutcome(current, desired, ctx, pi, { preflight });
  }

  const decision = await showProfileDiff(current, desired, preflight, ctx);
  if (decision !== "apply") {
    return { applied: false, reloaded: false, operations: [] };
  }
  return applyProfileWithOutcome(current, desired, ctx, pi, { preflight });
}
