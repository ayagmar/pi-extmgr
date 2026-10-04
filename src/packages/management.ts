/**
 * Package management (update, remove)
 */
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { UI } from "../constants.js";
import { type InstalledPackage, type Scope } from "../types/index.js";
import { runTaskWithLoader } from "../ui/async-task.js";
import { showListReport } from "../ui/report.js";
import { parseChoiceByLabel } from "../utils/command.js";
import { formatInstalledPackageLabel, normalizePackageSource } from "../utils/format.js";
import { logPackageRemove, logPackageUpdate } from "../utils/history.js";
import { isProjectTrusted, requireUI } from "../utils/mode.js";
import { notify, error as notifyError, success } from "../utils/notify.js";
import { normalizePackageIdentity } from "../utils/package-source.js";
import { getProjectConfigDir } from "../utils/pi-paths.js";
import { getProgressMessage } from "../utils/progress.js";
import { clearUpdatesAvailable } from "../utils/settings.js";
import { updateExtmgrStatus } from "../utils/status.js";
import { confirmAction, confirmReload, showProgress } from "../utils/ui-helpers.js";
import { getPackageCatalog } from "./catalog.js";
import {
  clearSearchCache,
  getInstalledPackages,
  getInstalledPackagesAllScopes,
} from "./discovery.js";
import { clearPackageEntrypointCache } from "./extensions.js";

export interface PackageMutationOutcome {
  reloaded: boolean;
}

const BULK_UPDATE_LABEL = "all packages";
const REMOVAL_SCOPE_CHOICES = {
  both: "Both global + project",
  global: "Global only",
  project: "Project only",
  cancel: "Cancel",
} as const;

interface UpdateOptions {
  selectedScope?: Scope;
  /**
   * Ask to reload after a successful update (default). Batches turn this off
   * for all but the final step: pi invalidates the command context on reload,
   * so nothing may run on it afterwards.
   */
  promptReload?: boolean;
}

interface UpdateOutcome extends PackageMutationOutcome {
  updated: boolean;
}

/**
 * `/extensions install foo` installs npm:foo, so `update foo` and
 * `remove foo` must mean npm:foo too. A source that is configured exactly
 * as typed (for example a bare local path) keeps its literal meaning.
 */
async function resolveRequestedSource(
  source: string,
  ctx: ExtensionCommandContext
): Promise<string> {
  const normalized = normalizePackageSource(source);
  if (!normalized || normalized === source) return source;
  const installed = await getInstalledPackagesAllScopes(ctx);
  const identities = packageSourceIdentities(source, ctx);
  return installed.some((pkg) => installedPackageMatchesSource(pkg, identities, ctx))
    ? source
    : normalized;
}

async function updatePackageInternal(
  requestedSource: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  options: UpdateOptions = {}
): Promise<UpdateOutcome> {
  const { selectedScope } = options;
  const source = await resolveRequestedSource(requestedSource, ctx);
  showProgress(ctx, "Updating", source);

  const updateIdentity = normalizePackageIdentity(source, { cwd: ctx.cwd });
  let updatesEveryMatchingScope = false;

  try {
    const matchingScopes = new Set(
      (await getInstalledPackagesAllScopes(ctx))
        .filter((pkg) => normalizePackageIdentity(pkg.source, { cwd: ctx.cwd }) === updateIdentity)
        .map((pkg) => pkg.scope)
    );
    updatesEveryMatchingScope = matchingScopes.size > 1;

    if (ctx.hasUI && updatesEveryMatchingScope) {
      const confirmed = await ctx.ui.confirm(
        "Update package in all scopes",
        `Update ${source} in every configured scope matching this source${
          selectedScope ? ` (selected ${selectedScope} row)` : ""
        }?`
      );
      if (!confirmed) {
        notify(ctx, "Package update cancelled.", "info");
        return { reloaded: false, updated: false };
      }
    }

    // Like `pi update <source>`: no availability pre-check, which would skip
    // pinned git refs that changed and packages whose install is missing.
    const changed = await runTaskWithLoader(
      ctx,
      {
        title: "Update Package",
        message: `Updating ${source}...`,
        cancellable: false,
        fallbackWithoutLoader: true,
        overlay: true,
      },
      ({ setMessage }) =>
        getPackageCatalog(ctx.cwd, isProjectTrusted(ctx), {
          suppressOutput: ctx.mode === "tui",
        }).update(source, (event) => {
          setMessage(getProgressMessage(event, `Updating ${source}...`));
        })
    );

    if (changed === false) {
      notify(ctx, `${source} is already up to date (or pinned).`, "info");
      logPackageUpdate(pi, source, source, undefined, true);
      clearUpdatesAvailable(pi, ctx, [updateIdentity]);
      void updateExtmgrStatus(ctx, pi);
      return { reloaded: false, updated: false };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorMsg = `Update failed: ${message}`;
    logPackageUpdate(pi, source, source, undefined, false, errorMsg);
    notifyError(ctx, errorMsg);
    void updateExtmgrStatus(ctx, pi);
    return { reloaded: false, updated: false };
  }

  clearSearchCache();
  clearPackageEntrypointCache();
  logPackageUpdate(pi, source, source, undefined, true);
  success(
    ctx,
    updatesEveryMatchingScope
      ? `Updated ${source} in every configured scope matching this source.`
      : `Updated ${source}.`
  );
  clearUpdatesAvailable(pi, ctx, [updateIdentity]);

  if (options.promptReload === false) {
    void updateExtmgrStatus(ctx, pi);
    return { reloaded: false, updated: true };
  }

  const reloaded = await confirmReload(ctx, "Package updated.");
  if (!reloaded) {
    void updateExtmgrStatus(ctx, pi);
  }
  return { reloaded, updated: true };
}

async function updatePackagesInternal(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<PackageMutationOutcome> {
  showProgress(ctx, "Updating", "all packages");

  try {
    // Like `pi update`: no availability pre-check (see updatePackageInternal).
    const changed = await runTaskWithLoader(
      ctx,
      {
        title: "Update Packages",
        message: "Updating all packages...",
        cancellable: false,
        fallbackWithoutLoader: true,
        overlay: true,
      },
      ({ setMessage }) =>
        getPackageCatalog(ctx.cwd, isProjectTrusted(ctx), {
          suppressOutput: ctx.mode === "tui",
        }).update(undefined, (event) => {
          setMessage(getProgressMessage(event, "Updating all packages..."));
        })
    );

    if (changed === false) {
      notify(ctx, "All packages are already up to date.", "info");
      logPackageUpdate(pi, BULK_UPDATE_LABEL, BULK_UPDATE_LABEL, undefined, true);
      clearUpdatesAvailable(pi, ctx);
      void updateExtmgrStatus(ctx, pi);
      return { reloaded: false };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorMsg = `Update failed: ${message}`;
    logPackageUpdate(pi, BULK_UPDATE_LABEL, BULK_UPDATE_LABEL, undefined, false, errorMsg);
    notifyError(ctx, errorMsg);
    void updateExtmgrStatus(ctx, pi);
    return { reloaded: false };
  }

  clearSearchCache();
  clearPackageEntrypointCache();
  logPackageUpdate(pi, BULK_UPDATE_LABEL, BULK_UPDATE_LABEL, undefined, true);
  success(ctx, "Packages updated in every configured scope.");
  clearUpdatesAvailable(pi, ctx);

  const reloaded = await confirmReload(ctx, "Packages updated.");
  if (!reloaded) {
    void updateExtmgrStatus(ctx, pi);
  }
  return { reloaded };
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
  pi: ExtensionAPI,
  selectedScope?: Scope
): Promise<PackageMutationOutcome> {
  const { reloaded } = await updatePackageInternal(
    source,
    ctx,
    pi,
    selectedScope ? { selectedScope } : {}
  );
  return { reloaded };
}

/**
 * Update several explicit sources, then offer a single reload at the end.
 * Reloading mid-batch would invalidate the command context for the rest.
 */
export async function updateSelectedPackagesWithOutcome(
  sources: readonly string[],
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<PackageMutationOutcome> {
  let updated = 0;
  for (const source of sources) {
    const outcome = await updatePackageInternal(source, ctx, pi, { promptReload: false });
    if (outcome.updated) updated += 1;
  }
  if (updated === 0) return { reloaded: false };

  const reloaded = await confirmReload(
    ctx,
    updated === 1 ? "Package updated." : "Packages updated."
  );
  if (!reloaded) {
    void updateExtmgrStatus(ctx, pi);
  }
  return { reloaded };
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

function packageIdentity(
  source: string,
  options?: { resolvedPath?: string; cwd?: string }
): string {
  return normalizePackageIdentity(source, options);
}

function packageSourceIdentities(source: string, ctx: ExtensionCommandContext): Set<string> {
  return new Set([
    packageIdentity(source, { cwd: ctx.cwd }),
    packageIdentity(source, { cwd: getProjectConfigDir(ctx.cwd) }),
    packageIdentity(source, { cwd: getAgentDir() }),
  ]);
}

function installedPackageMatchesSource(
  pkg: InstalledPackage,
  identities: Set<string>,
  ctx: ExtensionCommandContext
): boolean {
  return identities.has(
    packageIdentity(pkg.source, {
      ...(pkg.resolvedPath ? { resolvedPath: pkg.resolvedPath } : {}),
      cwd: pkg.scope === "project" ? getProjectConfigDir(ctx.cwd) : getAgentDir(),
    })
  );
}

async function getInstalledPackagesAllScopesForRemoval(
  ctx: ExtensionCommandContext
): Promise<InstalledPackage[]> {
  return getInstalledPackagesAllScopes(ctx);
}

type RemovalScopeChoice = "both" | "global" | "project" | "cancel";

interface RemovalTarget {
  scope: "global" | "project";
  source: string;
  name: string;
}

async function selectRemovalScope(ctx: ExtensionCommandContext): Promise<RemovalScopeChoice> {
  if (!ctx.hasUI) return "global";

  return (
    parseChoiceByLabel(
      REMOVAL_SCOPE_CHOICES,
      await ctx.ui.select("Remove scope", Object.values(REMOVAL_SCOPE_CHOICES))
    ) ?? "cancel"
  );
}

function buildRemovalTargets(
  matching: InstalledPackage[],
  hasUI: boolean,
  scopeChoice: RemovalScopeChoice
): RemovalTarget[] {
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

    try {
      await runTaskWithLoader(
        ctx,
        {
          title: "Remove Package",
          message: `Removing ${target.source}...`,
          cancellable: false,
          fallbackWithoutLoader: true,
        },
        async ({ setMessage }) => {
          await getPackageCatalog(ctx.cwd, isProjectTrusted(ctx), {
            suppressOutput: ctx.mode === "tui",
          }).remove(target.source, target.scope, (event) => {
            setMessage(getProgressMessage(event, `Removing ${target.source}...`));
          });
          return undefined;
        }
      );

      logPackageRemove(pi, target.source, target.name, true);
      results.push({ target, success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorMsg = `Remove failed (${target.scope}): ${message}`;
      logPackageRemove(pi, target.source, target.name, false, errorMsg);
      results.push({ target, success: false, error: errorMsg });
    }
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
  requestedSource: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<PackageMutationOutcome> {
  const source = await resolveRequestedSource(requestedSource, ctx);
  const installed = await getInstalledPackagesAllScopesForRemoval(ctx);
  const identities = packageSourceIdentities(source, ctx);
  const matching = installed.filter((pkg) => installedPackageMatchesSource(pkg, identities, ctx));

  const hasBothScopes =
    matching.some((pkg) => pkg.scope === "global") &&
    matching.some((pkg) => pkg.scope === "project");
  const scopeChoice = hasBothScopes ? await selectRemovalScope(ctx) : "both";

  if (scopeChoice === "cancel") {
    notify(ctx, "Removal cancelled.", "info");
    return { reloaded: false };
  }

  if (matching.length === 0) {
    notify(ctx, `${source} is not installed.`, "info");
    return { reloaded: false };
  }

  const targets = buildRemovalTargets(matching, ctx.hasUI, scopeChoice);
  if (targets.length === 0) {
    notify(ctx, "Nothing to remove.", "info");
    return { reloaded: false };
  }

  const confirmed = await confirmAction(
    ctx,
    "Remove Package",
    `Remove:\n${formatRemovalTargets(targets)}?`,
    UI.longConfirmTimeout
  );
  if (!confirmed) {
    notify(ctx, "Removal cancelled.", "info");
    return { reloaded: false };
  }

  const results = await executeRemovalTargets(targets, ctx, pi);
  clearSearchCache();
  if (results.some((result) => result.success)) {
    clearPackageEntrypointCache();
  }

  const failures = results
    .filter((result): result is RemovalExecutionResult & { success: false; error: string } =>
      Boolean(!result.success && result.error)
    )
    .map((result) => result.error);
  const successfulTargets = results
    .filter((result) => result.success)
    .map((result) => result.target);

  const remaining = (await getInstalledPackagesAllScopesForRemoval(ctx)).filter((pkg) =>
    installedPackageMatchesSource(pkg, identities, ctx)
  );
  notifyRemovalSummary(source, remaining, failures, ctx);

  if (failures.length === 0 && remaining.length === 0) {
    clearUpdatesAvailable(pi, ctx, identities);
  }

  const successfulRemovalCount = successfulTargets.length;

  if (successfulRemovalCount === 0) {
    void updateExtmgrStatus(ctx, pi);
    return { reloaded: false };
  }

  const reloaded = await confirmReload(ctx, "Removal complete.");
  if (!reloaded) {
    void updateExtmgrStatus(ctx, pi);
  }

  return { reloaded };
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
  _pi: ExtensionAPI
): Promise<void> {
  const packages = await getInstalledPackagesAllScopes(ctx);

  if (packages.length === 0) {
    notify(ctx, "No packages installed.", "info");
    return;
  }

  const lines = packages.map((p: InstalledPackage, index: number) =>
    formatInstalledPackageLabel(p, index)
  );

  await showListReport(ctx, "Installed packages", lines);
}
