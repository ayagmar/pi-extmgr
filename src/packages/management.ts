/**
 * Package management (update, remove)
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { InstalledPackage } from "../types/index.js";
import { getInstalledPackages, clearSearchCache } from "./discovery.js";
import { formatInstalledPackageLabel, formatBytes } from "../utils/format.js";
import { logPackageUpdate, logPackageRemove } from "../utils/history.js";
import { notify, error as notifyError, success } from "../utils/notify.js";
import {
  confirmAction,
  confirmReload,
  confirmRestart,
  showProgress,
  formatListOutput,
} from "../utils/ui-helpers.js";
import { requireUI } from "../utils/mode.js";

export async function updatePackage(
  source: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  showProgress(ctx, "Updating", source);

  const res = await pi.exec("pi", ["update", source], { timeout: 120000, cwd: ctx.cwd });

  if (res.code !== 0) {
    const errorMsg = `Update failed: ${res.stderr || res.stdout || `exit ${res.code}`}`;
    logPackageUpdate(pi, source, source, undefined, undefined, false, errorMsg);
    notifyError(ctx, errorMsg);
    return;
  }

  const stdout = res.stdout || "";
  if (stdout.includes("already up to date") || stdout.includes("pinned")) {
    notify(ctx, `${source} is already up to date (or pinned).`, "info");
    logPackageUpdate(pi, source, source, undefined, undefined, true);
  } else {
    logPackageUpdate(pi, source, source, undefined, undefined, true);
    success(ctx, `Updated ${source}`);
    await confirmReload(ctx, "Package updated.");
  }
}

export async function updatePackages(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  showProgress(ctx, "Updating", "all packages");

  const res = await pi.exec("pi", ["update"], { timeout: 300000, cwd: ctx.cwd });

  if (res.code !== 0) {
    notifyError(ctx, `Update failed: ${res.stderr || res.stdout || `exit ${res.code}`}`);
    return;
  }

  const stdout = res.stdout || "";
  if (stdout.includes("already up to date") || stdout.trim() === "") {
    notify(ctx, "All packages are already up to date.", "info");
  } else {
    success(ctx, "Packages updated");
    await confirmReload(ctx, "Packages updated.");
  }
}

export async function removePackage(
  source: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  const confirmed = await confirmAction(ctx, "Remove Package", `Remove ${source}?`, 10000);
  if (!confirmed) {
    notify(ctx, "Removal cancelled.", "info");
    return;
  }

  showProgress(ctx, "Removing", source);

  const res = await pi.exec("pi", ["remove", source], { timeout: 60000, cwd: ctx.cwd });

  if (res.code !== 0) {
    const errorMsg = `Remove failed: ${res.stderr || res.stdout || `exit ${res.code}`}`;
    logPackageRemove(pi, source, source, false, errorMsg);
    notifyError(ctx, errorMsg);
    return;
  }

  clearSearchCache();
  logPackageRemove(pi, source, source, true);

  await confirmRestart(
    ctx,
    `Removed ${source}.\n\n⚠️  Extension will be unloaded after restarting pi.`
  );
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

export async function showPackageActions(
  pkg: InstalledPackage,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<boolean> {
  if (!requireUI(ctx, "Package actions")) {
    console.log(`Package: ${pkg.name}`);
    console.log(`Version: ${pkg.version || "unknown"}`);
    console.log(`Source: ${pkg.source}`);
    console.log(`Scope: ${pkg.scope}`);
    return true;
  }

  const choice = await ctx.ui.select(pkg.name, [
    `Remove ${pkg.name}`,
    `Update ${pkg.name}`,
    "View details",
    "Back to manager",
  ]);

  if (!choice || choice.includes("Back")) {
    return false;
  }

  if (choice.startsWith("Remove")) {
    await removePackage(pkg.source, ctx, pi);
  } else if (choice.startsWith("Update")) {
    await updatePackage(pkg.source, ctx, pi);
  } else if (choice.includes("details")) {
    const sizeStr = pkg.size !== undefined ? `\nSize: ${formatBytes(pkg.size)}` : "";
    notify(
      ctx,
      `Name: ${pkg.name}\nVersion: ${pkg.version || "unknown"}\nSource: ${pkg.source}\nScope: ${pkg.scope}${sizeStr}`,
      "info"
    );
    return showPackageActions(pkg, ctx, pi);
  }

  return false;
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
