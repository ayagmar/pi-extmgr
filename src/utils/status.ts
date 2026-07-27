/**
 * Status bar helpers for extmgr
 */
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { getPackageCatalog, type PackageCatalog } from "../packages/catalog.js";
import { getAutoUpdateStatus, refreshKnownUpdates } from "./auto-update.js";
import { isProjectTrusted } from "./mode.js";
import { normalizePackageIdentity } from "./package-source.js";
import { getProjectConfigDir } from "./pi-paths.js";
import { readReloadState } from "./reload-state.js";
import { getAutoUpdateConfigAsync, saveAutoUpdateConfig } from "./settings.js";

type CatalogInstalledPackages = Awaited<ReturnType<PackageCatalog["listInstalledPackages"]>>;

function filterStaleUpdates(
  knownUpdates: string[],
  installedPackages: CatalogInstalledPackages,
  cwd: string
): string[] {
  const installedIdentities = new Set(
    installedPackages.map((pkg) =>
      normalizePackageIdentity(pkg.source, {
        ...(pkg.resolvedPath ? { resolvedPath: pkg.resolvedPath } : {}),
        cwd: pkg.scope === "project" ? getProjectConfigDir(cwd) : getAgentDir(),
      })
    )
  );
  return knownUpdates.filter((identity) => installedIdentities.has(identity));
}

/**
 * One-line attention widget above the editor. Present only while something
 * needs the user: known package updates or a pending reload.
 */
function updateAttentionWidget(
  ctx: ExtensionCommandContext | ExtensionContext,
  updateCount: number,
  reloadPending: boolean
): void {
  const parts: string[] = [];
  if (updateCount > 0) parts.push(`${updateCount} update${updateCount === 1 ? "" : "s"}`);
  if (reloadPending) parts.push("reload pending");

  ctx.ui.setWidget(
    "extmgr-attention",
    parts.length > 0
      ? [ctx.ui.theme.fg("warning", `extmgr: ${parts.join(" \u00b7 ")} \u2014 /extensions`)]
      : undefined
  );
}

export async function updateExtmgrStatus(
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI
): Promise<void> {
  if (!ctx.hasUI) return;

  try {
    const [packages, autoUpdateConfig, reloadState] = await Promise.all([
      getPackageCatalog(ctx.cwd, isProjectTrusted(ctx)).listInstalledPackages(),
      getAutoUpdateConfigAsync(ctx),
      readReloadState(),
    ]);
    const statusParts: string[] = [];

    if (packages.length > 0) {
      statusParts.push(`${packages.length} pkg${packages.length === 1 ? "" : "s"}`);
    }

    const autoUpdateStatus = getAutoUpdateStatus(ctx);
    if (autoUpdateStatus) {
      statusParts.push(autoUpdateStatus);
    }

    // Remove markers for uninstalled packages first. If any cached markers
    // remain, reconcile them with a live package-manager check so updates made
    // outside extmgr do not leave stale badges and attention prompts behind.
    const knownUpdates = autoUpdateConfig.updatesAvailable ?? [];
    let validUpdates = filterStaleUpdates(knownUpdates, packages, ctx.cwd);
    if (validUpdates.length > 0) {
      validUpdates = filterStaleUpdates(
        [...(await refreshKnownUpdates(pi, ctx))],
        packages,
        ctx.cwd
      );
    } else if (validUpdates.length !== knownUpdates.length) {
      saveAutoUpdateConfig(pi, {
        ...autoUpdateConfig,
        updatesAvailable: validUpdates,
      });
    }

    if (validUpdates.length > 0) {
      statusParts.push(`${validUpdates.length} update${validUpdates.length === 1 ? "" : "s"}`);
    }

    if (statusParts.length > 0) {
      ctx.ui.setStatus("extmgr", ctx.ui.theme.fg("dim", statusParts.join(" • ")));
    } else {
      ctx.ui.setStatus("extmgr", undefined);
    }

    updateAttentionWidget(ctx, validUpdates.length, reloadState.required);
  } catch {
    // Best-effort status updates only
  }
}
