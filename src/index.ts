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
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { isPackageSource } from "./utils/format.js";
import { showInteractive, showListOnly, showInstalledPackagesLegacy } from "./ui/unified.js";
import { showRemote } from "./ui/remote.js";
import { showHelp } from "./ui/help.js";
import { installPackage } from "./packages/install.js";
import { removePackage, promptRemove, showInstalledPackagesList } from "./packages/management.js";
import { getInstalledPackages } from "./packages/discovery.js";
import { getRecentChanges, formatChangeEntry, getChangeStats } from "./utils/history.js";
import { clearCache } from "./utils/cache.js";
import { notify } from "./utils/notify.js";
import { formatListOutput } from "./utils/ui-helpers.js";
import { parseDuration } from "./utils/settings.js";
import {
  startAutoUpdateTimer,
  stopAutoUpdateTimer,
  enableAutoUpdate,
  disableAutoUpdate,
  getAutoUpdateStatus,
} from "./utils/auto-update.js";

export default function extensionsManager(pi: ExtensionAPI) {
  pi.registerCommand("extensions", {
    description: "Manage local extensions and browse/install community packages",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const commands = [
        { value: "list", description: "List local extensions" },
        { value: "local", description: "Open interactive manager (default)" },
        { value: "remote", description: "Browse community packages" },
        { value: "packages", description: "Browse community packages (alias)" },
        { value: "installed", description: "List installed packages" },
        { value: "search", description: "Search npm for packages" },
        { value: "install", description: "Install a package" },
        { value: "remove", description: "Remove an installed package" },
        { value: "uninstall", description: "Remove an installed package (alias)" },
        { value: "history", description: "View extension change history" },
        { value: "stats", description: "View extension manager statistics" },
        { value: "clear-cache", description: "Clear metadata cache" },
        { value: "auto-update", description: "Configure auto-update schedule" },
      ];

      const safePrefix = (prefix ?? "").toLowerCase();
      const filtered = commands.filter(
        (c) => c.value.startsWith(safePrefix) || c.description.toLowerCase().includes(safePrefix)
      );

      return filtered.length > 0
        ? filtered.map((c) => ({ value: c.value, label: `${c.value} - ${c.description}` }))
        : null;
    },
    handler: async (args, ctx) => {
      // Check if we have UI support
      if (!ctx.hasUI) {
        await handleNonInteractive(args, ctx, pi);
        return;
      }

      const input = args.trim();
      const [subcommand, ...rest] = input.split(/\s+/).filter(Boolean);
      const sub = (subcommand ?? "").toLowerCase();

      switch (sub) {
        case "":
        case "local":
          await showInteractive(ctx, pi);
          break;
        case "list":
          await showListOnly(ctx);
          break;
        case "remote":
        case "packages":
          await showRemote(rest.join(" "), ctx, pi);
          break;
        case "installed":
          await showInstalledPackagesLegacy(ctx, pi);
          break;
        case "search":
          await showRemote(`search ${rest.join(" ")}`, ctx, pi);
          break;
        case "install":
          if (rest.length > 0) {
            await installPackage(rest.join(" "), ctx, pi);
          } else {
            await showRemote("install", ctx, pi);
          }
          break;
        case "remove":
        case "uninstall":
          if (rest.length > 0) {
            await removePackage(rest.join(" "), ctx, pi);
          } else {
            await promptRemove(ctx, pi);
          }
          break;
        case "auto-update":
          handleAutoUpdateCommand(rest.join(" "), ctx);
          break;
        case "history":
          showHistory(ctx, pi);
          break;
        case "stats":
          await showStats(ctx, pi);
          break;
        case "clear-cache":
          await clearMetadataCache(ctx, pi);
          break;
        default:
          // If it looks like a package source, try to install it
          if (subcommand && isPackageSource(subcommand)) {
            await installPackage(input, ctx, pi);
          } else {
            notify(
              ctx,
              `Unknown command: ${subcommand ?? "(empty)"}. Try: local, remote, installed, search, install, remove`,
              "warning"
            );
          }
      }
    },
  });

  // Status bar update function
  async function updateStatusBar(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;

    try {
      const packages = await getInstalledPackages(ctx, pi);
      const statusParts: string[] = [];

      if (packages.length > 0) {
        statusParts.push(`${packages.length} pkg${packages.length === 1 ? "" : "s"}`);
      }

      const autoUpdateStatus = getAutoUpdateStatus(ctx);
      if (autoUpdateStatus) {
        statusParts.push(autoUpdateStatus);
      }

      if (statusParts.length > 0) {
        ctx.ui.setStatus("extmgr", ctx.ui.theme.fg("dim", statusParts.join(" • ")));
      } else {
        ctx.ui.setStatus("extmgr", undefined);
      }
    } catch {
      // Silently ignore status bar errors
    }
  }

  // Status bar integration and auto-update startup
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Start auto-update timer if configured
    startAutoUpdateTimer(pi, ctx, (packages) => {
      notify(
        ctx,
        `Updates available for ${packages.length} package(s): ${packages.join(", ")}`,
        "info"
      );
    });

    // Defer status update to avoid interfering with extension loading lifecycle
    setImmediate(() => {
      void updateStatusBar(ctx);
    });
  });

  // Clean up timer on shutdown
  pi.on("session_shutdown", () => {
    stopAutoUpdateTimer();
  });

  // Handle auto-update command
  function handleAutoUpdateCommand(
    args: string,
    ctx: ExtensionCommandContext | ExtensionContext
  ): void {
    const duration = parseDuration(args);

    if (!duration) {
      // Show current status
      const status = getAutoUpdateStatus(ctx);
      notify(ctx, `Auto-update: ${status}`, "info");

      // Show usage
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
      enableAutoUpdate(pi, ctx, duration.ms, duration.display, (packages) => {
        notify(
          ctx,
          `Updates available for ${packages.length} package(s): ${packages.join(", ")}`,
          "info"
        );
      });
    }

    // Update status bar after enabling/disabling
    void updateStatusBar(ctx);
  }
}

async function handleNonInteractive(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  const input = args.trim();
  const [subcommand, ...rest] = input.split(/\s+/).filter(Boolean);
  const sub = (subcommand ?? "").toLowerCase();

  switch (sub) {
    case "list":
      await showListOnly(ctx);
      break;
    case "installed":
      await showInstalledPackagesList(ctx, pi);
      break;
    case "remote":
    case "packages":
      console.log("Extensions Manager (non-interactive mode)");
      console.log("Remote package browsing requires interactive mode.");
      console.log("");
      console.log("Available commands:");
      console.log("  /extensions list      - List local extensions");
      console.log("  /extensions installed - List installed packages");
      console.log("  /extensions install <source> - Install a package");
      console.log("  /extensions remove <source>  - Remove a package");
      break;
    case "search":
      console.log("Search requires interactive mode.");
      break;
    case "install":
      if (rest.length > 0) {
        await installPackage(rest.join(" "), ctx, pi);
      } else {
        console.log("Usage: /extensions install <npm:package|git:url|path>");
      }
      break;
    case "remove":
    case "uninstall":
      if (rest.length > 0) {
        await removePackage(rest.join(" "), ctx, pi);
      } else {
        console.log("Usage: /extensions remove <npm:package|git:url|path>");
      }
      break;
    case "auto-update":
      console.log("Auto-update requires interactive mode.");
      console.log("Usage: /extensions auto-update <duration>");
      console.log("");
      console.log("Duration examples: 1h, 2h, 1d, 3d, 1w, 2w, 1m, never");
      break;
    default:
      // If it looks like a package source, try to install it
      if (subcommand && isPackageSource(subcommand)) {
        await installPackage(input, ctx, pi);
      } else {
        console.log("Extensions Manager (non-interactive mode)");
        console.log("");
        console.log("Commands:");
        console.log("  /extensions list      - List local extensions");
        console.log("  /extensions installed - List installed packages");
        console.log("");
        console.log("For full functionality, run in interactive mode.");
      }
  }
}

export { showHelp };

function showHistory(ctx: ExtensionCommandContext, _pi: ExtensionAPI): void {
  const changes = getRecentChanges(ctx, 20);

  if (changes.length === 0) {
    notify(ctx, "No extension changes recorded in this session.", "info");
    return;
  }

  const lines = changes.map(formatChangeEntry);
  formatListOutput(ctx, "Extension Change History (recent 20)", lines);
}

async function showStats(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const stats = getChangeStats(ctx);
  const packages = await getInstalledPackages(ctx, pi);

  const lines = [
    "Extension Manager Statistics",
    "",
    `Installed packages: ${packages.length}`,
    `Session changes: ${stats.total}`,
    `  - Successful: ${stats.successful}`,
    `  - Failed: ${stats.failed}`,
    "",
    "Changes by type:",
    `  - Extension toggles: ${stats.byAction.extension_toggle}`,
    `  - Package installs: ${stats.byAction.package_install}`,
    `  - Package updates: ${stats.byAction.package_update}`,
    `  - Package removals: ${stats.byAction.package_remove}`,
  ];

  formatListOutput(ctx, "Statistics", lines);
}

async function clearMetadataCache(ctx: ExtensionCommandContext, _pi: ExtensionAPI): Promise<void> {
  await clearCache();
  notify(ctx, "Metadata cache cleared.", "info");
}
