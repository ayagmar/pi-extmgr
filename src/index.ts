/**
 * Extensions Manager - Enhanced UI/UX for managing Pi extensions and packages
 *
 * Entry point - exports the main extension function
 */
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { createAutoUpdateNotificationHandler } from "./commands/auto-update.js";
import { refreshLocalCompletionIndex } from "./commands/completion.js";
import {
  getExtensionsAutocompleteItems,
  resolveCommand,
  runResolvedCommand,
  showNonInteractiveHelp,
  showUnknownCommandMessage,
} from "./commands/registry.js";
import { installPackage } from "./packages/install.js";
import { restorePiTitle } from "./ui/workspace/title.js";
import {
  type ContextProvider,
  startAutoUpdateTimer,
  stopAutoUpdateTimer,
} from "./utils/auto-update.js";
import { tokenizeArgs } from "./utils/command.js";
import { isPackageSource } from "./utils/format.js";
import { clearReloadRequired } from "./utils/reload-state.js";
import { getAutoUpdateConfig, hydrateAutoUpdateConfig } from "./utils/settings.js";
import { updateExtmgrStatus } from "./utils/status.js";
import { wasContextReloaded } from "./utils/ui-helpers.js";

async function executeExtensionsCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  try {
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
  } finally {
    // Workspace screens set the terminal title while open; hand it back to
    // pi's format on the way out. After an in-process reload pi re-asserts
    // its own title, so skip touching the stale context.
    if (!wasContextReloaded(ctx)) {
      restorePiTitle(ctx);
    }
  }
}

export default function extensionsManager(pi: ExtensionAPI) {
  pi.registerCommand("extensions", {
    description: "Manage local extensions and browse/install community packages",
    getArgumentCompletions: getExtensionsAutocompleteItems,
    handler: async (args, ctx) => {
      await executeExtensionsCommand(args, ctx, pi);
      if (wasContextReloaded(ctx)) return;
      await refreshLocalCompletionIndex(
        ctx.cwd,
        typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted()
      ).catch((error) => {
        console.warn("[extmgr] Failed to refresh local completions:", error);
      });
    },
  });

  pi.registerShortcut(Key.ctrlAlt("e"), {
    description: "Open the extensions manager",
    handler: async (ctx) => {
      // Shortcut contexts satisfy everything the manager uses at runtime
      // (ui, cwd, trust); command-only members like reload() are guarded.
      await executeExtensionsCommand("", ctx as ExtensionCommandContext, pi);
    },
  });

  // The context of the running session. pi retires it on reload and session
  // replacement, so background work must look it up instead of capturing it.
  let activeCtx: ExtensionContext | undefined;

  async function updateStatusBar(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
    await updateExtmgrStatus(ctx, pi);
  }

  async function bootstrapSession(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
    // Restore persisted auto-update config into session entries so sync lookups are valid.
    await hydrateAutoUpdateConfig(pi, ctx);
    await refreshLocalCompletionIndex(
      ctx.cwd,
      typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted()
    ).catch((error) => {
      console.warn("[extmgr] Failed to load local completions:", error);
    });

    if (!ctx.hasUI) {
      stopAutoUpdateTimer();
      return;
    }

    const config = getAutoUpdateConfig(ctx);
    if (config.enabled && config.intervalMs > 0) {
      const getCtx: ContextProvider = () => (activeCtx === ctx ? ctx : undefined);
      startAutoUpdateTimer(pi, getCtx, createAutoUpdateNotificationHandler(ctx));
    } else {
      stopAutoUpdateTimer();
    }

    setImmediate(() => {
      if (activeCtx !== ctx) return;
      updateStatusBar(ctx).catch((err) => {
        console.error("[extmgr] Status update failed:", err);
      });
    });
  }

  pi.on("session_start", async (event, ctx) => {
    activeCtx = ctx;
    if (event.reason === "reload") {
      await clearReloadRequired();
    }
    await bootstrapSession(ctx);
  });

  pi.on("session_shutdown", () => {
    activeCtx = undefined;
    stopAutoUpdateTimer();
  });
}
