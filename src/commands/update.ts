import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getPackageCatalog } from "../packages/catalog.js";
import { isProjectTrusted } from "../utils/mode.js";
import { getInstalledPackagesAllScopes } from "../packages/discovery.js";
import { updatePackage, updatePackages } from "../packages/management.js";
import { buildUpdatePreview } from "../packages/update-preview.js";
import { notify } from "../utils/notify.js";

export async function handleUpdateSubcommand(
  tokens: string[],
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  if (tokens.includes("--preview")) {
    try {
      const [installed, available] = await Promise.all([
        getInstalledPackagesAllScopes(ctx),
        getPackageCatalog(ctx.cwd, isProjectTrusted(ctx)).checkForAvailableUpdates(),
      ]);
      const preview = buildUpdatePreview(installed, available).filter((pkg) => pkg.updateAvailable);
      notify(
        ctx,
        preview.length > 0
          ? `Updates available:\n${preview.map((pkg) => `- ${pkg.name}${pkg.currentVersion ? `@${pkg.currentVersion}` : ""} (${pkg.scope})`).join("\n")}`
          : "All packages are up to date (or pinned).",
        "info"
      );
    } catch (error) {
      notify(
        ctx,
        `Update preview failed: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }
    return;
  }

  const sources = tokens.filter((token) => token !== "--all");
  if (tokens.includes("--all") || sources.length === 0) {
    await updatePackages(ctx, pi);
    return;
  }

  for (const source of sources) await updatePackage(source, ctx, pi);
}
