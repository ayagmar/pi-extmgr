import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  disableAutoUpdate,
  enableAutoUpdate,
  getAutoUpdateStatus,
  promptAutoUpdateWizard,
} from "../utils/auto-update.js";
import { notify } from "../utils/notify.js";
import { parseDuration } from "../utils/settings.js";
import { updateExtmgrStatus } from "../utils/status.js";

function onUpdateAvailable(
  ctx: ExtensionCommandContext | ExtensionContext,
  packages: string[]
): void {
  notify(
    ctx,
    `Updates available for ${packages.length} package(s): ${packages.join(", ")}`,
    "info"
  );
}

export async function handleAutoUpdateSubcommand(
  tokens: string[],
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI
): Promise<void> {
  const trimmed = tokens.join(" ").trim();

  if (!trimmed && ctx.hasUI) {
    await promptAutoUpdateWizard(pi, ctx, (packages) => onUpdateAvailable(ctx, packages));
    void updateExtmgrStatus(ctx, pi);
    return;
  }

  const duration = parseDuration(trimmed);

  if (!duration) {
    const status = getAutoUpdateStatus(ctx);
    notify(ctx, `Auto-update: ${status}`, "info");

    const usage = [
      "Usage: /extensions auto-update <duration>",
      "",
      "Duration examples:",
      "  never   - Disable auto-updates",
      "  1h      - Check every hour",
      "  2h      - Check every 2 hours",
      "  1d      - Check daily",
      "  3d      - Check every 3 days",
      "  1w      - Check weekly",
      "  2w      - Check every 2 weeks",
      "  1m      - Check monthly",
      "  daily   - Check daily (alias)",
      "  weekly  - Check weekly (alias)",
    ];
    notify(ctx, usage.join("\n"), "info");
    return;
  }

  if (duration.ms === 0) {
    disableAutoUpdate(pi, ctx);
  } else {
    enableAutoUpdate(pi, ctx, duration.ms, duration.display, (packages) =>
      onUpdateAvailable(ctx, packages)
    );
  }

  void updateExtmgrStatus(ctx, pi);
}

export function createAutoUpdateNotificationHandler(
  ctx: ExtensionCommandContext | ExtensionContext
): (packages: string[]) => void {
  return (packages) => onUpdateAvailable(ctx, packages);
}
