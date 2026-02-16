/**
 * Extensions Manager - Enhanced UI/UX for managing Pi extensions and packages
 *
 * Entry point - exports the main extension function
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { isPackageSource } from "./utils/format.js";
import { installPackage } from "./packages/install.js";
import { tokenizeArgs } from "./utils/command.js";
import { updateExtmgrStatus } from "./utils/status.js";
import {
  startAutoUpdateTimer,
  stopAutoUpdateTimer,
  type ContextProvider,
} from "./utils/auto-update.js";
import { hydrateAutoUpdateConfig, getAutoUpdateConfig } from "./utils/settings.js";
import {
  getExtensionsAutocompleteItems,
  resolveCommand,
  runResolvedCommand,
  showNonInteractiveHelp,
  showUnknownCommandMessage,
} from "./commands/registry.js";
import { createAutoUpdateNotificationHandler } from "./commands/auto-update.js";

async function executeExtensionsCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  const tokens = tokenizeArgs(args);
  const resolved = resolveCommand(tokens);

  if (resolved) {
    await runResolvedCommand(resolved, ctx, pi);
    return;
  }

  const rawSubcommand = tokens[0];
  if (rawSubcommand && isPackageSource(rawSubcommand)) {
    await installPackage(args.trim(), ctx, pi);
    return;
  }

  if (ctx.hasUI) {
    showUnknownCommandMessage(rawSubcommand, ctx);
  } else {
    showNonInteractiveHelp(ctx);
  }
}

export default function extensionsManager(pi: ExtensionAPI) {
  pi.registerCommand("extensions", {
    description: "Manage local extensions and browse/install community packages",
    getArgumentCompletions: getExtensionsAutocompleteItems,
    handler: async (args, ctx) => {
      await executeExtensionsCommand(args, ctx, pi);
    },
  });

  async function updateStatusBar(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
    await updateExtmgrStatus(ctx, pi);
  }

  async function bootstrapSession(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
    // Restore persisted auto-update config into session entries so sync lookups are valid.
    await hydrateAutoUpdateConfig(pi, ctx);

    if (!ctx.hasUI) return;

    const config = getAutoUpdateConfig(ctx);
    if (config.enabled && config.intervalMs > 0) {
      const getCtx: ContextProvider = () => ctx;
      startAutoUpdateTimer(pi, getCtx, createAutoUpdateNotificationHandler(ctx));
    }

    setImmediate(() => {
      updateStatusBar(ctx).catch((err) => {
        console.error("[extmgr] Status update failed:", err);
      });
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    await bootstrapSession(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await bootstrapSession(ctx);
  });

  pi.on("session_shutdown", () => {
    stopAutoUpdateTimer();
  });
}
