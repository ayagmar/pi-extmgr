import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem } from "@earendil-works/pi-tui";
import { inspectInstalledPackageCompatibility } from "../doctor/compatibility.js";
import { findRuntimeConflicts } from "../doctor/conflicts.js";
import { getRuntimeOwners } from "../doctor/runtime.js";
import { getInstalledPackagesAllScopes } from "../packages/discovery.js";
import { promptRemove, removePackage, showInstalledPackagesList } from "../packages/management.js";
import { showRemote } from "../ui/remote.js";
import { showInstalledPackagesLegacy, showInteractive, showListOnly } from "../ui/unified.js";
import { notify } from "../utils/notify.js";
import { handleAutoUpdateSubcommand } from "./auto-update.js";
import { getLocalCompletionIndex } from "./completion.js";
import { clearMetadataCacheCommand } from "./cache.js";
import { handleHistorySubcommand } from "./history.js";
import { handleInstallSubcommand, INSTALL_USAGE } from "./install.js";
import { handleProfileSubcommand } from "./profile.js";
import { type CommandDefinition, type CommandId } from "./types.js";
import { handleUpdateSubcommand } from "./update.js";
import { handleTrashSubcommand } from "./trash.js";

const REMOVE_USAGE = "Usage: /extensions remove <npm:package|git:url|path>";

async function showDoctor(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const owners = getRuntimeOwners(pi);
  const conflicts = findRuntimeConflicts(owners);
  const packages = await getInstalledPackagesAllScopes(ctx);
  const compatibility = await inspectInstalledPackageCompatibility(packages);
  const lines = [`Runtime ownership: ${owners.length} command/tool entries`];
  lines.push("Installed package compatibility:");
  if (compatibility.length === 0) {
    lines.push("- none installed");
  } else {
    for (const diagnostic of compatibility) {
      lines.push(
        `- ${diagnostic.source} (${diagnostic.scope}): Node ${diagnostic.node}, Pi ${diagnostic.pi}`
      );
      for (const reason of diagnostic.reasons) lines.push(`  ${reason}`);
    }
  }
  if (conflicts.length === 0) {
    lines.push("No command or tool conflicts detected.");
  } else {
    lines.push(`Conflicts detected: ${conflicts.length}`);
    for (const conflict of conflicts) {
      lines.push(`- ${conflict.kind} ${conflict.name}:`);
      for (const owner of conflict.owners) {
        lines.push(`  ${owner.source} (${owner.scope}) ${owner.path}`);
      }
    }
  }
  notify(ctx, lines.join("\n"), conflicts.length > 0 ? "warning" : "info");
}

function requireInteractiveCommand(ctx: ExtensionCommandContext, feature: string): void {
  notify(ctx, `${feature} requires interactive mode.`, "warning");
}

function showNonInteractiveHelp(ctx: ExtensionCommandContext): void {
  const lines = [
    "Extensions Manager (non-interactive mode)",
    "Remote package browsing requires interactive mode.",
    "",
    "Available commands:",
    "  /extensions list      - List local extensions",
    "  /extensions installed - List installed packages",
    `  ${INSTALL_USAGE} - Install a package`,
    "  /extensions remove <source>  - Remove a package",
    "  /extensions update [source]  - Update one package or all packages",
    "  /extensions history [opts]   - Show history (supports filters)",
    "  /extensions doctor           - Inspect runtime ownership/conflicts",
    "  /extensions profile <action> - Save, import, check, review, or apply a profile",
    "  /extensions auto-update <d>  - Configure scheduled update checks (e.g. 1d, 1w, 1mo, never)",
    "",
    "History examples:",
    "  /extensions history --failed --limit 50",
    "  /extensions history --action package_update --since 7d",
    "  /extensions history --global --package extmgr --since 24h",
  ];

  notify(ctx, lines.join("\n"), "info");
}

const COMMAND_DEFINITIONS: Record<CommandId, CommandDefinition> = {
  local: {
    id: "local",
    description: "Open interactive manager (default)",
    runInteractive: (_tokens, ctx, pi) => showInteractive(ctx, pi),
    runNonInteractive: (_tokens, ctx) => showListOnly(ctx),
  },
  list: {
    id: "list",
    description: "List local extensions",
    runInteractive: (_tokens, ctx) => showListOnly(ctx),
    runNonInteractive: (_tokens, ctx) => showListOnly(ctx),
  },
  remote: {
    id: "remote",
    description: "Browse community packages",
    aliases: ["packages"],
    runInteractive: async (tokens, ctx, pi) => {
      await showRemote(tokens.join(" "), ctx, pi);
    },
    runNonInteractive: (_tokens, ctx) => {
      requireInteractiveCommand(ctx, "Remote package browsing");
      showNonInteractiveHelp(ctx);
    },
  },
  installed: {
    id: "installed",
    description: "List installed packages",
    runInteractive: (_tokens, ctx, pi) => showInstalledPackagesLegacy(ctx, pi),
    runNonInteractive: (_tokens, ctx, pi) => showInstalledPackagesList(ctx, pi),
  },
  search: {
    id: "search",
    description: "Search npm for packages",
    runInteractive: async (tokens, ctx, pi) => {
      await showRemote(`search ${tokens.join(" ")}`, ctx, pi);
    },
    runNonInteractive: (_tokens, ctx) => {
      requireInteractiveCommand(ctx, "Search");
      showNonInteractiveHelp(ctx);
    },
  },
  install: {
    id: "install",
    description: "Install a package",
    runInteractive: async (tokens, ctx, pi) => {
      if (tokens.length > 0) await handleInstallSubcommand(tokens, ctx, pi);
      else await showRemote("install", ctx, pi);
    },
    runNonInteractive: (tokens, ctx, pi) =>
      tokens.length > 0
        ? handleInstallSubcommand(tokens, ctx, pi)
        : notify(ctx, INSTALL_USAGE, "info"),
  },
  remove: {
    id: "remove",
    description: "Remove an installed package",
    aliases: ["uninstall"],
    runInteractive: (tokens, ctx, pi) =>
      tokens.length > 0 ? removePackage(tokens.join(" "), ctx, pi) : promptRemove(ctx, pi),
    runNonInteractive: (tokens, ctx, pi) =>
      tokens.length > 0
        ? removePackage(tokens.join(" "), ctx, pi)
        : notify(ctx, REMOVE_USAGE, "info"),
  },
  update: {
    id: "update",
    description: "Preview or update selected packages",
    runInteractive: (tokens, ctx, pi) => handleUpdateSubcommand(tokens, ctx, pi),
    runNonInteractive: (tokens, ctx, pi) => handleUpdateSubcommand(tokens, ctx, pi),
  },
  history: {
    id: "history",
    description: "View extension change history",
    runInteractive: (tokens, ctx, pi) => handleHistorySubcommand(ctx, pi, tokens, false),
    runNonInteractive: (tokens, ctx, pi) => handleHistorySubcommand(ctx, pi, tokens, true),
  },
  "clear-cache": {
    id: "clear-cache",
    description: "Clear metadata cache",
    runInteractive: (_tokens, ctx, pi) => clearMetadataCacheCommand(ctx, pi),
    runNonInteractive: (_tokens, ctx, pi) => clearMetadataCacheCommand(ctx, pi),
  },
  trash: {
    id: "trash",
    description: "List, restore, or purge local extension trash",
    runInteractive: (tokens, ctx, pi) => handleTrashSubcommand(tokens, ctx, pi),
    runNonInteractive: (tokens, ctx, pi) => handleTrashSubcommand(tokens, ctx, pi),
  },
  "auto-update": {
    id: "auto-update",
    description: "Configure scheduled update checks",
    runInteractive: (tokens, ctx, pi) => handleAutoUpdateSubcommand(tokens, ctx, pi),
    runNonInteractive: (tokens, ctx, pi) => handleAutoUpdateSubcommand(tokens, ctx, pi),
  },
  doctor: {
    id: "doctor",
    description: "Inspect runtime command/tool ownership and conflicts",
    runInteractive: (_tokens, ctx, pi) => showDoctor(ctx, pi),
    runNonInteractive: (_tokens, ctx, pi) => showDoctor(ctx, pi),
  },
  profile: {
    id: "profile",
    description: "Save, import, check, review, or apply a package profile",
    runInteractive: (tokens, ctx, pi) => handleProfileSubcommand(tokens, ctx, pi),
    runNonInteractive: (tokens, ctx, pi) => handleProfileSubcommand(tokens, ctx, pi),
  },
};

function buildCommandAliasMap(
  definitions: Record<CommandId, CommandDefinition>
): Record<string, CommandId> {
  const map: Record<string, CommandId> = {};
  for (const def of Object.values(definitions)) {
    map[def.id] = def.id;
    for (const alias of def.aliases ?? []) {
      map[alias] = def.id;
    }
  }
  return map;
}

const COMMAND_ALIAS_TO_ID: Record<string, CommandId> = buildCommandAliasMap(COMMAND_DEFINITIONS);

export function resolveCommand(tokens: string[]): { id: CommandId; args: string[] } | undefined {
  if (tokens.length === 0) {
    return { id: "local", args: [] };
  }

  const normalized = tokens[0]?.toLowerCase() ?? "";
  const id = COMMAND_ALIAS_TO_ID[normalized];
  if (!id) return undefined;

  return { id, args: tokens.slice(1) };
}

export function runResolvedCommand(
  resolved: { id: CommandId; args: string[] },
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> | void {
  const definition = COMMAND_DEFINITIONS[resolved.id];
  const runner = ctx.hasUI ? definition.runInteractive : definition.runNonInteractive;
  return runner(resolved.args, ctx, pi);
}

function completionItems(options: string[], prefix: string): AutocompleteItem[] | null {
  const matches = options.filter((option) => option.toLowerCase().startsWith(prefix.toLowerCase()));
  return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
}

export function getExtensionsAutocompleteItems(prefix: string): AutocompleteItem[] | null {
  const commandPrefix = (prefix ?? "").trimStart();
  if (commandPrefix.includes(" ")) {
    const trailingSpace = /\s$/.test(commandPrefix);
    const tokens = commandPrefix.replace(/^\//, "").split(/\s+/).filter(Boolean);
    const command = tokens.shift()?.toLowerCase() ?? "";
    const activePrefix = trailingSpace ? "" : (tokens.pop() ?? "");
    const completedArgs = tokens;
    const local = getLocalCompletionIndex();

    if ((command === "remove" || command === "uninstall") && completedArgs.length === 0) {
      return completionItems(local.installedPackages, activePrefix);
    }
    if (command === "update" && completedArgs.length === 0) {
      return completionItems(["--all", "--preview", ...local.installedPackages], activePrefix);
    }
    if (command === "profile") {
      const actions = [
        "export",
        "save",
        "list",
        "delete",
        "dry-run",
        "apply",
        "compare",
        "import",
        "check",
        "recover",
      ];
      if (completedArgs.length === 0) return completionItems(actions, activePrefix);
      const action = completedArgs[0];
      if (["delete", "dry-run", "apply", "compare"].includes(action ?? "")) {
        return completionItems(local.savedProfiles, activePrefix);
      }
      if (action === "import") return completionItems(["--name", "--force"], activePrefix);
      if (action === "check") return completionItems(["--json", "--strict"], activePrefix);
      if (action === "recover") return completionItems(["list"], activePrefix);
      return null;
    }
    if (command === "history") {
      const historyActions = [
        "extension_toggle",
        "extension_delete",
        "package_install",
        "package_update",
        "package_remove",
        "cache_clear",
        "auto_update_config",
      ];
      if (completedArgs.at(-1) === "--action") {
        return completionItems(historyActions, activePrefix);
      }
      return completionItems(
        ["--action", "--failed", "--success", "--global", "--limit", "--package", "--since"],
        activePrefix
      );
    }
    const argumentOptions: Record<string, string[]> = {
      install: ["--global", "--project"],
      "auto-update": ["daily", "weekly", "monthly", "never"],
      trash: ["list", "restore", "purge", "all"],
    };
    return completionItems(argumentOptions[command] ?? [], activePrefix);
  }

  const items = Object.values(COMMAND_DEFINITIONS).flatMap((def) => {
    const base = [{ value: def.id, description: def.description }];
    const aliases = (def.aliases ?? []).map((alias) => ({
      value: alias,
      description: `${def.description} (alias)`,
    }));
    return [...base, ...aliases];
  });

  const safePrefix = (prefix ?? "").toLowerCase();
  const filtered = items.filter(
    (item) =>
      item.value.toLowerCase().startsWith(safePrefix) ||
      item.description.toLowerCase().includes(safePrefix)
  );

  return filtered.length > 0
    ? filtered.map((item) => ({ value: item.value, label: `${item.value} - ${item.description}` }))
    : null;
}

export function showUnknownCommandMessage(
  rawSubcommand: string | undefined,
  ctx: ExtensionCommandContext
): void {
  const known = Object.keys(COMMAND_ALIAS_TO_ID)
    .filter((key) => key === COMMAND_ALIAS_TO_ID[key])
    .sort()
    .join(", ");

  notify(ctx, `Unknown command: ${rawSubcommand ?? "(empty)"}. Try: ${known}`, "warning");
}

export { showNonInteractiveHelp };
