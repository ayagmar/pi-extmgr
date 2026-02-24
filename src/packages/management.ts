/**
 * Package management (update, remove)
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { InstalledPackage } from "../types/index.js";
import {
  getInstalledPackages,
  clearSearchCache,
  parseInstalledPackagesOutputAllScopes,
  isSourceInstalled,
} from "./discovery.js";
import { waitForCondition } from "../utils/retry.js";
import { formatInstalledPackageLabel, parseNpmSource } from "../utils/format.js";
import {
  getPackageSourceKind,
  normalizeLocalSourceIdentity,
  splitGitRepoAndRef,
} from "../utils/package-source.js";
import { logPackageUpdate, logPackageRemove } from "../utils/history.js";
import { clearUpdatesAvailable } from "../utils/settings.js";
import { notify, error as notifyError, success } from "../utils/notify.js";
import {
  confirmAction,
  confirmReload,
  showProgress,
  formatListOutput,
} from "../utils/ui-helpers.js";
import { requireUI } from "../utils/mode.js";
import { updateExtmgrStatus } from "../utils/status.js";
import { TIMEOUTS, UI } from "../constants.js";

export interface PackageMutationOutcome {
  reloaded: boolean;
}

const NO_PACKAGE_MUTATION_OUTCOME: PackageMutationOutcome = {
  reloaded: false,
};

const BULK_UPDATE_LABEL = "all packages";

function packageMutationOutcome(
  overrides: Partial<PackageMutationOutcome>
): PackageMutationOutcome {
  return { ...NO_PACKAGE_MUTATION_OUTCOME, ...overrides };
}

function isUpToDateOutput(stdout: string): boolean {
  const pinnedAsStatus = /^\s*pinned\b(?!\s+dependency\b)(?:\s*$|\s*[:(-])/im.test(stdout);
  return /already\s+up\s+to\s+date/i.test(stdout) || pinnedAsStatus;
}

async function updatePackageInternal(
  source: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<PackageMutationOutcome> {
  showProgress(ctx, "Updating", source);

  const res = await pi.exec("pi", ["update", source], {
    timeout: TIMEOUTS.packageUpdate,
    cwd: ctx.cwd,
  });

  if (res.code !== 0) {
    const errorMsg = `Update failed: ${res.stderr || res.stdout || `exit ${res.code}`}`;
    logPackageUpdate(pi, source, source, undefined, false, errorMsg);
    notifyError(ctx, errorMsg);
    void updateExtmgrStatus(ctx, pi);
    return NO_PACKAGE_MUTATION_OUTCOME;
  }

  const stdout = res.stdout || "";
  if (isUpToDateOutput(stdout)) {
    notify(ctx, `${source} is already up to date (or pinned).`, "info");
    logPackageUpdate(pi, source, source, undefined, true);
    clearUpdatesAvailable(pi, ctx);
    void updateExtmgrStatus(ctx, pi);
    return NO_PACKAGE_MUTATION_OUTCOME;
  }

  logPackageUpdate(pi, source, source, undefined, true);
  success(ctx, `Updated ${source}`);
  clearUpdatesAvailable(pi, ctx);

  const reloaded = await confirmReload(ctx, "Package updated.");
  if (!reloaded) {
    void updateExtmgrStatus(ctx, pi);
  }
  return packageMutationOutcome({ reloaded });
}

async function updatePackagesInternal(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<PackageMutationOutcome> {
  showProgress(ctx, "Updating", "all packages");

  const res = await pi.exec("pi", ["update"], { timeout: TIMEOUTS.packageUpdateAll, cwd: ctx.cwd });

  if (res.code !== 0) {
    const errorMsg = `Update failed: ${res.stderr || res.stdout || `exit ${res.code}`}`;
    logPackageUpdate(pi, BULK_UPDATE_LABEL, BULK_UPDATE_LABEL, undefined, false, errorMsg);
    notifyError(ctx, errorMsg);
    void updateExtmgrStatus(ctx, pi);
    return NO_PACKAGE_MUTATION_OUTCOME;
  }

  const stdout = res.stdout || "";
  if (isUpToDateOutput(stdout) || stdout.trim() === "") {
    notify(ctx, "All packages are already up to date.", "info");
    logPackageUpdate(pi, BULK_UPDATE_LABEL, BULK_UPDATE_LABEL, undefined, true);
    clearUpdatesAvailable(pi, ctx);
    void updateExtmgrStatus(ctx, pi);
    return NO_PACKAGE_MUTATION_OUTCOME;
  }

  logPackageUpdate(pi, BULK_UPDATE_LABEL, BULK_UPDATE_LABEL, undefined, true);
  success(ctx, "Packages updated");
  clearUpdatesAvailable(pi, ctx);

  const reloaded = await confirmReload(ctx, "Packages updated.");
  if (!reloaded) {
    void updateExtmgrStatus(ctx, pi);
  }
  return packageMutationOutcome({ reloaded });
}

export async function updatePackage(
  source: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  await updatePackageInternal(source, ctx, pi);
}

export async function updatePackageWithOutcome(
  source: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<PackageMutationOutcome> {
  return updatePackageInternal(source, ctx, pi);
}

export async function updatePackages(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  await updatePackagesInternal(ctx, pi);
}

export async function updatePackagesWithOutcome(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<PackageMutationOutcome> {
  return updatePackagesInternal(ctx, pi);
}

function packageIdentity(source: string, fallbackName?: string): string {
  const npm = parseNpmSource(source);
  if (npm?.name) {
    return `npm:${npm.name}`;
  }

  const sourceKind = getPackageSourceKind(source);

  if (sourceKind === "git") {
    const gitSpec = source.startsWith("git:") ? source.slice(4) : source;
    const { repo } = splitGitRepoAndRef(gitSpec);
    return `git:${repo}`;
  }

  if (sourceKind === "local") {
    return `src:${normalizeLocalSourceIdentity(source)}`;
  }

  if (fallbackName) {
    return `name:${fallbackName}`;
  }

  return `src:${source}`;
}

async function getInstalledPackagesAllScopes(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<InstalledPackage[]> {
  const res = await pi.exec("pi", ["list"], { timeout: TIMEOUTS.listPackages, cwd: ctx.cwd });
  if (res.code !== 0) return [];
  return parseInstalledPackagesOutputAllScopes(res.stdout || "");
}

type RemovalScopeChoice = "both" | "global" | "project" | "cancel";

interface RemovalTarget {
  scope: "global" | "project";
  source: string;
  name: string;
}

function scopeChoiceFromLabel(choice: string | undefined): RemovalScopeChoice {
  if (!choice || choice === "Cancel") return "cancel";
  if (choice.includes("Both")) return "both";
  if (choice.includes("Global")) return "global";
  if (choice.includes("Project")) return "project";
  return "cancel";
}

async function selectRemovalScope(ctx: ExtensionCommandContext): Promise<RemovalScopeChoice> {
  if (!ctx.hasUI) return "global";

  const choice = await ctx.ui.select("Remove scope", [
    "Both global + project",
    "Global only",
    "Project only",
    "Cancel",
  ]);

  return scopeChoiceFromLabel(choice);
}

function buildRemovalTargets(
  matching: InstalledPackage[],
  source: string,
  hasUI: boolean,
  scopeChoice: RemovalScopeChoice
): RemovalTarget[] {
  if (matching.length === 0) {
    return [{ scope: "global", source, name: source }];
  }

  const byScope = new Map(matching.map((pkg) => [pkg.scope, pkg] as const));
  const addTarget = (scope: "global" | "project") => {
    const pkg = byScope.get(scope);
    return pkg ? [{ scope, source: pkg.source, name: pkg.name }] : [];
  };

  if (byScope.has("global") && byScope.has("project")) {
    switch (scopeChoice) {
      case "both":
        return [...addTarget("global"), ...addTarget("project")];
      case "global":
        return addTarget("global");
      case "project":
        return addTarget("project");
      case "cancel":
      default:
        return [];
    }
  }

  const allTargets = matching.map((pkg) => ({
    scope: pkg.scope,
    source: pkg.source,
    name: pkg.name,
  }));
  return hasUI ? allTargets : allTargets.slice(0, 1);
}

function formatRemovalTargets(targets: RemovalTarget[]): string {
  return targets.map((t) => `${t.scope}: ${t.source}`).join("\n");
}

interface RemovalExecutionResult {
  target: RemovalTarget;
  success: boolean;
  error?: string;
}

async function executeRemovalTargets(
  targets: RemovalTarget[],
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<RemovalExecutionResult[]> {
  const results: RemovalExecutionResult[] = [];

  for (const target of targets) {
    showProgress(ctx, "Removing", `${target.source} (${target.scope})`);

    const args = ["remove", ...(target.scope === "project" ? ["-l"] : []), target.source];
    const res = await pi.exec("pi", args, { timeout: TIMEOUTS.packageRemove, cwd: ctx.cwd });

    if (res.code !== 0) {
      const errorMsg = `Remove failed (${target.scope}): ${res.stderr || res.stdout || `exit ${res.code}`}`;
      logPackageRemove(pi, target.source, target.name, false, errorMsg);
      results.push({ target, success: false, error: errorMsg });
      continue;
    }

    logPackageRemove(pi, target.source, target.name, true);
    results.push({ target, success: true });
  }

  return results;
}

function notifyRemovalSummary(
  source: string,
  remaining: InstalledPackage[],
  failures: string[],
  ctx: ExtensionCommandContext
): void {
  if (failures.length > 0) {
    notifyError(ctx, failures.join("\n"));
  }

  if (remaining.length > 0) {
    const remainingScopes = Array.from(new Set(remaining.map((p) => p.scope))).join(", ");
    notify(
      ctx,
      `Removed from selected scope(s). Still installed in: ${remainingScopes}.`,
      "warning"
    );
    return;
  }

  if (failures.length === 0) {
    success(ctx, `Removed ${source}.`);
  }
}

async function removePackageInternal(
  source: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<PackageMutationOutcome> {
  const installed = await getInstalledPackagesAllScopes(ctx, pi);
  const direct = installed.find((p) => p.source === source);
  const identity = packageIdentity(source, direct?.name);
  const matching = installed.filter((p) => packageIdentity(p.source, p.name) === identity);

  const hasBothScopes =
    matching.some((pkg) => pkg.scope === "global") &&
    matching.some((pkg) => pkg.scope === "project");
  const scopeChoice = hasBothScopes ? await selectRemovalScope(ctx) : "both";

  if (scopeChoice === "cancel") {
    notify(ctx, "Removal cancelled.", "info");
    return NO_PACKAGE_MUTATION_OUTCOME;
  }

  const targets = buildRemovalTargets(matching, source, ctx.hasUI, scopeChoice);
  if (targets.length === 0) {
    notify(ctx, "Nothing to remove.", "info");
    return NO_PACKAGE_MUTATION_OUTCOME;
  }

  const confirmed = await confirmAction(
    ctx,
    "Remove Package",
    `Remove:\n${formatRemovalTargets(targets)}?`,
    UI.longConfirmTimeout
  );
  if (!confirmed) {
    notify(ctx, "Removal cancelled.", "info");
    return NO_PACKAGE_MUTATION_OUTCOME;
  }

  const results = await executeRemovalTargets(targets, ctx, pi);
  clearSearchCache();

  const failures = results
    .filter((result): result is RemovalExecutionResult & { success: false; error: string } =>
      Boolean(!result.success && result.error)
    )
    .map((result) => result.error);
  const successfulTargets = results
    .filter((result) => result.success)
    .map((result) => result.target);

  const remaining = (await getInstalledPackagesAllScopes(ctx, pi)).filter(
    (p) => packageIdentity(p.source, p.name) === identity
  );
  notifyRemovalSummary(source, remaining, failures, ctx);

  if (failures.length === 0) {
    clearUpdatesAvailable(pi, ctx);
  }

  const successfulRemovalCount = successfulTargets.length;

  // Wait for successfully removed targets to disappear from their target scopes before reloading.
  if (successfulTargets.length > 0) {
    notify(ctx, "Waiting for removal to complete...", "info");
    const isRemoved = await waitForCondition(
      async () => {
        const installedChecks = await Promise.all(
          successfulTargets.map((target) =>
            isSourceInstalled(target.source, ctx, pi, {
              scope: target.scope,
            })
          )
        );
        return installedChecks.every((installedInScope) => !installedInScope);
      },
      { maxAttempts: 10, delayMs: 100, backoff: "exponential" }
    );

    if (!isRemoved) {
      notify(ctx, "Extension may still be active. Restart pi manually if needed.", "warning");
    }
  }

  if (successfulRemovalCount === 0) {
    void updateExtmgrStatus(ctx, pi);
    return NO_PACKAGE_MUTATION_OUTCOME;
  }

  const reloaded = await confirmReload(ctx, "Removal complete.");
  if (!reloaded) {
    void updateExtmgrStatus(ctx, pi);
  }

  return packageMutationOutcome({ reloaded });
}

export async function removePackage(
  source: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  await removePackageInternal(source, ctx, pi);
}

export async function removePackageWithOutcome(
  source: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<PackageMutationOutcome> {
  return removePackageInternal(source, ctx, pi);
}

export async function promptRemove(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (!requireUI(ctx, "Interactive package removal")) return;

  const packages = await getInstalledPackages(ctx, pi);
  if (packages.length === 0) {
    notify(ctx, "No packages installed.", "info");
    return;
  }

  const items = packages.map((p: InstalledPackage, index: number) =>
    formatInstalledPackageLabel(p, index)
  );

  const toRemove = await ctx.ui.select("Remove package", items);
  if (!toRemove) return;

  const indexMatch = toRemove.match(/^\[(\d+)\]\s+/);
  const selectedIndex = indexMatch ? Number(indexMatch[1]) - 1 : -1;
  const pkg = selectedIndex >= 0 ? packages[selectedIndex] : undefined;
  if (pkg) {
    await removePackage(pkg.source, ctx, pi);
  }
}

export async function showInstalledPackagesList(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  const packages = await getInstalledPackages(ctx, pi);

  if (packages.length === 0) {
    notify(ctx, "No packages installed.", "info");
    return;
  }

  const lines = packages.map((p: InstalledPackage, index: number) =>
    formatInstalledPackageLabel(p, index)
  );

  formatListOutput(ctx, "Installed packages", lines);
}
