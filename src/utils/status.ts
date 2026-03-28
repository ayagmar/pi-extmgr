/**
 * Status bar helpers for extmgr
 */
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";
import { getPackageCatalog, type PackageCatalog } from "../packages/catalog.js";
import { getAutoUpdateStatus } from "./auto-update.js";
import { normalizePackageIdentity } from "./package-source.js";
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
        cwd: pkg.scope === "project" ? cwd : getAgentDir(),
      })
    )
  );
  return knownUpdates.filter((identity) => installedIdentities.has(identity));
}

export async function updateExtmgrStatus(
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI
): Promise<void> {
  if (!ctx.hasUI) return;

  try {
    const [packages, autoUpdateConfig] = await Promise.all([
      getPackageCatalog(ctx.cwd).listInstalledPackages(),
      getAutoUpdateConfigAsync(ctx),
    ]);
    const statusParts: string[] = [];

    if (packages.length > 0) {
      statusParts.push(`${packages.length} pkg${packages.length === 1 ? "" : "s"}`);
    }

    const autoUpdateStatus = getAutoUpdateStatus(ctx);
    if (autoUpdateStatus) {
      statusParts.push(autoUpdateStatus);
    }

    // Validate updates against actually installed packages (handles external pi update)
    const knownUpdates = autoUpdateConfig.updatesAvailable ?? [];
    const validUpdates = filterStaleUpdates(knownUpdates, packages, ctx.cwd);

    // If stale updates were filtered, persist the correction
    if (validUpdates.length !== knownUpdates.length) {
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
  } catch {
    // Best-effort status updates only
  }
}
