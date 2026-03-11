import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { clearSearchCache } from "../packages/discovery.js";
import { clearRemotePackageInfoCache } from "../ui/remote.js";
import { clearCache } from "../utils/cache.js";
import { logCacheClear } from "../utils/history.js";
import { notify } from "../utils/notify.js";
import { updateExtmgrStatus } from "../utils/status.js";

export async function clearMetadataCacheCommand(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  try {
    await clearCache();
    clearSearchCache();
    clearRemotePackageInfoCache();
    logCacheClear(pi, true);
    notify(ctx, "Metadata and in-memory extmgr caches cleared.", "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logCacheClear(pi, false, message);
    notify(ctx, `Failed to clear metadata cache: ${message}`, "error");
  }

  void updateExtmgrStatus(ctx, pi);
}
