/**
 * Extensions Manager - Enhanced UI/UX for managing Pi extensions and packages
 *
 * Features:
 * - Local extension management (enable/disable with staging)
 * - Browse and search pi packages from npm with pagination
 * - Install packages from npm, git, or local paths
 * - View installed packages with better formatting
 *
 * Usage:
 *   /extensions           - Open interactive manager
 *   /extensions list      - List local extensions
 *   /extensions remote    - Browse remote packages
 *   /extensions installed - List installed packages
 */

import { access, readdir, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { Dirent } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { getSettingsListTheme, DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
  Container,
  SettingsList,
  SelectList,
  Text,
  Spacer,
  type SettingItem,
  type SelectItem,
  type AutocompleteItem,
  matchesKey,
  Key,
} from "@mariozechner/pi-tui";

type Scope = "global" | "project";
type State = "enabled" | "disabled";

interface ExtensionEntry {
  id: string;
  scope: Scope;
  state: State;
  activePath: string;
  disabledPath: string;
  displayName: string;
  summary: string;
}

interface NpmPackage {
  name: string;
  version?: string;
  description?: string;
  keywords?: string[];
  date?: string;
}

interface InstalledPackage {
  source: string;
  name: string;
  version?: string;
  scope: "global" | "project";
}

const DISABLED_SUFFIX = ".disabled";
const PAGE_SIZE = 20;

export default function extensionsManager(pi: ExtensionAPI) {
  // Register keyboard shortcut
  pi.registerShortcut("ctrl+shift+e", {
    description: "Open Extensions Manager",
    handler: (ctx) => {
      ctx.ui.setEditorText("/extensions ");
    },
  });

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
          await showInstalledPackages(ctx, pi);
          break;
        case "search":
          await searchPackages(rest.join(" "), ctx, pi);
          break;
        case "install":
          if (rest.length > 0) {
            await installPackage(rest.join(" "), ctx, pi);
          } else {
            await promptInstall(ctx, pi);
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
        default:
          // If it looks like a package source, try to install it
          if (subcommand && isPackageSource(subcommand)) {
            await installPackage(input, ctx, pi);
          } else {
            ctx.ui.notify(
              `Unknown command: ${subcommand ?? "(empty)"}. Try: local, remote, installed, search, install, remove`,
              "warning"
            );
          }
      }
    },
  });

  // Status bar integration - show installed package count
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    try {
      const packages = await getInstalledPackages(ctx, pi);
      if (packages.length > 0) {
        ctx.ui.setStatus(
          "extmgr",
          ctx.ui.theme.fg("dim", `${packages.length} pkg${packages.length === 1 ? "" : "s"}`)
        );
      }
    } catch {
      // Silently ignore status bar errors
    }
  });
}

// ============== Non-Interactive Mode ==============

async function handleNonInteractive(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  const input = args.trim();
  const [subcommand] = input.split(/\s+/).filter(Boolean);

  switch (subcommand) {
    case "list":
      await showListOnly(ctx);
      break;
    case "installed":
      await showInstalledPackages(ctx, pi);
      break;
    default:
      console.log("Extensions Manager (non-interactive mode)");
      console.log("");
      console.log("Commands:");
      console.log("  /extensions list      - List local extensions");
      console.log("  /extensions installed - List installed packages");
      console.log("");
      console.log("For full functionality, run in interactive mode.");
  }
}

// ============== Local Extension Management ==============

async function showListOnly(ctx: ExtensionCommandContext) {
  const entries = await discoverExtensions(ctx.cwd);
  if (entries.length === 0) {
    const msg = "No extensions found in ~/.pi/agent/extensions or .pi/extensions";
    if (ctx.hasUI) {
      ctx.ui.notify(msg, "info");
    } else {
      console.log(msg);
    }
    return;
  }

  const lines = entries.map(formatEntry);
  const output = lines.join("\n");

  if (ctx.hasUI) {
    ctx.ui.notify(output, "info");
  } else {
    console.log(output);
  }
}

async function showInteractive(ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  // Main loop - keeps showing the menu until user explicitly exits
  while (true) {
    const shouldExit = await showInteractiveOnce(ctx, pi);
    if (shouldExit) break;
  }
}

async function showInteractiveOnce(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<boolean> {
  const entries = await discoverExtensions(ctx.cwd);

  // If no local extensions, offer to browse remote
  if (entries.length === 0) {
    const choice = await ctx.ui.select("No local extensions found", [
      "Browse community packages",
      "List installed packages",
      "Cancel",
    ]);

    if (choice === "Browse community packages") {
      await browseRemotePackages(ctx, "keywords:pi-package", pi);
      return false; // Return to main menu
    } else if (choice === "List installed packages") {
      await showInstalledPackages(ctx, pi);
      return false; // Return to main menu
    }
    return true; // Exit
  }

  // Staged changes tracking
  const staged = new Map(entries.map((e) => [e.id, e.state]));
  const byId = new Map(entries.map((e) => [e.id, e]));

  type Action = "cancel" | "apply" | "installed" | "remote" | "help" | "menu";

  const result = await ctx.ui.custom<Action>((tui, theme, _keybindings, done) => {
    const container = new Container();

    // Header
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Local Extensions Manager")), 2, 0));
    container.addChild(
      new Text(theme.fg("muted", "Enable/disable extensions - Changes apply on save"), 2, 0)
    );
    container.addChild(new Spacer(1));

    // Settings list for extensions
    const items: SettingItem[] = entries.map((entry) => ({
      id: entry.id,
      label: formatEntryLabel(entry, entry.state, theme),
      currentValue: entry.state,
      values: ["enabled", "disabled"],
    }));

    const settingsList = new SettingsList(
      items,
      Math.min(entries.length + 2, 12),
      getSettingsListTheme(),
      (id, newValue) => {
        const entry = byId.get(id);
        const item = items.find((x) => x.id === id);
        if (!entry || !item) return;

        const state = newValue as State;
        staged.set(id, state);
        item.currentValue = state;
        item.label = formatEntryLabel(entry, state, theme, entry.state !== state);
        tui.requestRender();
      },
      () => done("cancel"),
      { enableSearch: entries.length > 8 }
    );

    container.addChild(settingsList);
    container.addChild(new Spacer(1));

    // Footer with keyboard shortcuts
    const hasChanges = Array.from(staged.entries()).some(([id, state]) => {
      const entry = byId.get(id);
      return entry && entry.state !== state;
    });

    const helpText = hasChanges
      ? "↑↓ Navigate | Space/Enter Toggle | S Save* | I Installed | R Remote | M Menu | ? Help | Esc Cancel"
      : "↑↓ Navigate | Space/Enter Toggle | S Save | I Installed | R Remote | M Menu | ? Help | Esc Cancel";

    container.addChild(new Text(theme.fg("dim", helpText), 2, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.ctrl("s")) || data === "s" || data === "S") {
          done("apply");
          return;
        }
        if (data === "i" || data === "I") {
          done("installed");
          return;
        }
        if (data === "r" || data === "R") {
          done("remote");
          return;
        }
        if (data === "?" || data === "h" || data === "H") {
          done("help");
          return;
        }
        if (data === "m" || data === "M") {
          done("menu");
          return;
        }
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });

  switch (result) {
    case "cancel":
      ctx.ui.notify("No changes applied.", "info");
      return true; // Exit
    case "installed":
      await showInstalledPackages(ctx, pi);
      return false; // Return to main menu
    case "remote":
      await showRemote("", ctx, pi);
      return false; // Return to main menu
    case "help":
      showHelp(ctx);
      return false; // Return to main menu
    case "menu":
      return false; // Return to main menu (already there)
  }

  // Apply changes
  const apply = await applyStagedChanges(entries, staged);

  if (apply.errors.length > 0) {
    ctx.ui.notify(
      `Applied ${apply.changed} change(s), ${apply.errors.length} failed.\n${apply.errors.join("\n")}`,
      "warning"
    );
  } else if (apply.changed === 0) {
    ctx.ui.notify("No changes to apply.", "info");
    return false; // Return to main menu
  } else {
    ctx.ui.notify(`Applied ${apply.changed} extension change(s).`, "info");
  }

  // Prompt for reload
  const shouldReload = await ctx.ui.confirm(
    "Reload Required",
    "Extensions changed. Reload pi now?"
  );

  if (shouldReload) {
    ctx.ui.setEditorText("/reload");
  }

  return false; // Return to main menu
}

function formatEntryLabel(
  entry: ExtensionEntry,
  state: State,
  theme: Theme,
  changed = false
): string {
  const statusIcon = state === "enabled" ? theme.fg("success", "●") : theme.fg("error", "○");
  const scopeIcon = entry.scope === "global" ? theme.fg("muted", "G") : theme.fg("accent", "P");
  const changeMarker = changed ? theme.fg("warning", " *") : "";
  const name = theme.bold(entry.displayName);
  const summary = theme.fg("dim", entry.summary);
  return `${statusIcon} [${scopeIcon}] ${name} - ${summary}${changeMarker}`;
}

async function applyStagedChanges(entries: ExtensionEntry[], staged: Map<string, State>) {
  let changed = 0;
  const errors: string[] = [];

  for (const entry of entries) {
    const target = staged.get(entry.id) ?? entry.state;
    if (target === entry.state) continue;

    const result = await setState(entry, target);
    if (result.ok) {
      entry.state = target;
      changed++;
    } else {
      errors.push(`${entry.displayName}: ${result.error}`);
    }
  }

  return { changed, errors };
}

function showHelp(ctx: ExtensionCommandContext): void {
  const lines = [
    "Extensions Manager Help",
    "",
    "Local Extensions:",
    "  Extensions are loaded from:",
    "  - ~/.pi/agent/extensions/ (global)",
    "  - .pi/extensions/ (project-local)",
    "",
    "Navigation:",
    "  ↑↓           Navigate list",
    "  Space/Enter  Toggle enabled/disabled",
    "  S            Save changes",
    "  I            View installed packages",
    "  R            Browse remote packages",
    "  M            Main menu (exit to command line)",
    "  ?/H          Show this help",
    "  Esc          Cancel",
    "",
    "Commands:",
    "  /extensions              Open manager",
    "  /extensions list         List local extensions",
    "  /extensions installed    List installed packages",
    "  /extensions remote       Browse community packages",
    "  /extensions search <q>   Search for packages",
    "  /extensions install <s>  Install package (npm:, git:, or path)",
    "  /extensions remove <s>   Remove installed package",
  ];

  const output = lines.join("\n");
  if (ctx.hasUI) {
    ctx.ui.notify(output, "info");
  } else {
    console.log(output);
  }
  // Note: Removed auto-return to main menu (was causing memory leak potential)
}

// ============== Remote Package Management ==============

async function showRemote(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const sub = (subcommand ?? "").toLowerCase();
  const query = rest.join(" ").trim();

  switch (sub) {
    case "list":
    case "installed":
      await showInstalledPackages(ctx, pi);
      return;
    case "install":
      if (query) {
        await installPackage(query, ctx, pi);
      } else {
        await promptInstall(ctx, pi);
      }
      return;
    case "search":
      await searchPackages(query, ctx, pi);
      return;
    case "browse":
    case "":
      await browseRemotePackages(ctx, "keywords:pi-package", pi);
      return;
  }

  // Show remote menu
  await showRemoteMenu(ctx, pi);
}

async function showRemoteMenu(ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  type MenuAction = "browse" | "search" | "install" | "list" | "cancel" | "main" | "help";

  const result = await ctx.ui.custom<MenuAction>((tui, theme, _kb, done) => {
    const container = new Container();

    // Header
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Community Packages")), 2, 1));
    container.addChild(new Spacer(1));

    const menuItems: SelectItem[] = [
      {
        value: "browse",
        label: "🔍 Browse pi packages",
        description: "Discover community packages",
      },
      { value: "search", label: "🔎 Search packages", description: "Search npm with custom query" },
      { value: "install", label: "📥 Install by source", description: "npm:, git:, or local path" },
      { value: "list", label: "📋 List installed", description: "View your installed packages" },
    ];

    const selectList = new SelectList(menuItems, menuItems.length + 2, {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", theme.bold(t)),
      description: (t: string) => theme.fg("dim", t),
      scrollInfo: (t: string) => theme.fg("muted", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });

    selectList.onSelect = (item) => done(item.value as MenuAction);
    selectList.onCancel = () => done("cancel");

    container.addChild(selectList);
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        theme.fg("dim", "↑↓ Navigate • Enter Select • M Main Menu • ? Help • Esc Cancel"),
        2,
        0
      )
    );
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (data === "m" || data === "M") {
          done("main");
          return;
        }
        if (data === "?" || data === "h" || data === "H") {
          done("help");
          return;
        }
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  switch (result) {
    case "browse":
      await browseRemotePackages(ctx, "keywords:pi-package", pi);
      break;
    case "search":
      await promptSearch(ctx, pi);
      break;
    case "install":
      await promptInstall(ctx, pi);
      break;
    case "list":
      await showInstalledPackages(ctx, pi);
      break;
    case "main":
      return;
    case "help":
      showHelp(ctx);
      break;
    case "cancel":
      return;
  }
}

async function promptSearch(ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  const query = await ctx.ui.input("Search packages", "keywords:pi-package");
  if (!query?.trim()) return;
  await searchPackages(query.trim(), ctx, pi);
}

async function searchPackages(query: string, ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  if (!query) {
    await promptSearch(ctx, pi);
    return;
  }
  await browseRemotePackages(ctx, query, pi);
}

// Cache for search results during pagination
interface SearchCache {
  query: string;
  results: NpmPackage[];
  timestamp: number;
}

let searchCache: SearchCache | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function browseRemotePackages(
  ctx: ExtensionCommandContext,
  query: string,
  pi: ExtensionAPI,
  offset = 0
) {
  type BrowseAction =
    | { type: "package"; name: string }
    | { type: "prev" }
    | { type: "next" }
    | { type: "refresh" }
    | { type: "menu" }
    | { type: "main" }
    | { type: "help" }
    | { type: "cancel" };

  // Check cache first
  let allPackages: NpmPackage[] = [];
  const cacheValid =
    searchCache && searchCache.query === query && Date.now() - searchCache.timestamp < CACHE_TTL;

  if (cacheValid && searchCache && offset > 0) {
    allPackages = searchCache.results;
  } else {
    // Show loading state with abort support
    const controller = new AbortController();

    // Note: The loading UI automatically closes when this block ends
    void ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new Spacer(2));
      container.addChild(new Text(theme.fg("accent", theme.bold("Searching npm...")), 0, 1));
      container.addChild(new Text(theme.fg("muted", `Query: ${truncate(query, 50)}`), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", "Press Esc to cancel"), 0, 0));

      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.escape)) {
            controller.abort();
            done();
          }
        },
      };
    });

    // Perform search with abort signal
    const searchLimit = Math.min(PAGE_SIZE + 10, 50);
    const res = await pi.exec("npm", ["search", "--json", `--searchlimit=${searchLimit}`, query], {
      signal: controller.signal,
      timeout: 20000,
      cwd: ctx.cwd,
    });

    if (controller.signal.aborted) {
      return; // User cancelled
    }

    if (res.code !== 0) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `npm search failed: ${res.stderr || res.stdout || `exit ${res.code}`}`,
          "error"
        );
      }
      return;
    }

    let parsed: NpmPackage[] = [];
    try {
      parsed = JSON.parse(res.stdout || "[]") as NpmPackage[];
    } catch {
      if (ctx.hasUI) {
        ctx.ui.notify("Failed to parse npm search output", "error");
      }
      return;
    }

    // Filter to only pi packages when browsing
    allPackages = parsed.filter((p) => {
      if (!p?.name) return false;
      if (query.includes("keywords:pi-package")) {
        return p.keywords?.includes("pi-package");
      }
      return true;
    });

    // Cache results for pagination
    searchCache = {
      query,
      results: allPackages,
      timestamp: Date.now(),
    };
  }

  // Apply pagination from cached/filtered results
  const totalResults = allPackages.length;
  const packages = allPackages.slice(offset, offset + PAGE_SIZE);

  if (packages.length === 0) {
    const msg = offset > 0 ? "No more packages to show." : `No packages found for: ${query}`;
    ctx.ui.notify(msg, "info");

    if (offset > 0) {
      await browseRemotePackages(ctx, query, pi, 0);
    }
    return;
  }

  // Build selection items with descriptions
  const selectItems: SelectItem[] = packages.map((p) => ({
    value: p.name,
    label: themeLabel("accent", `${p.name}${p.version ? ` @${p.version}` : ""}`),
    description: truncate(p.description || "No description", 60),
  }));

  // Add navigation options
  const showLoadMore = totalResults >= PAGE_SIZE && packages.length === PAGE_SIZE;
  const showPrevious = offset > 0;

  if (showPrevious) {
    selectItems.push({
      value: "__prev",
      label: themeLabel("warning", "◀  Previous page"),
      description: "",
    });
  }
  if (showLoadMore) {
    selectItems.push({
      value: "__next",
      label: themeLabel("success", "▶  Next page"),
      description: `Showing ${offset + 1}-${offset + packages.length}`,
    });
  }
  selectItems.push({
    value: "__refresh",
    label: themeLabel("muted", "🔄 Refresh search"),
    description: "",
  });
  selectItems.push({
    value: "__menu",
    label: themeLabel("muted", "◀  Back to menu"),
    description: "",
  });

  const titleText =
    offset > 0
      ? `Search Results (${offset + 1}-${offset + packages.length})`
      : `Search: ${truncate(query, 40)}`;

  // Use custom SelectList for better visuals
  const result = await ctx.ui.custom<BrowseAction>((tui, theme, _kb, done) => {
    const container = new Container();

    // Header with border
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(titleText)), 2, 1));
    container.addChild(new Spacer(1));

    // SelectList with themed options
    const selectList = new SelectList(selectItems, Math.min(selectItems.length, 15), {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", theme.bold(t)),
      description: (t: string) => theme.fg("dim", t),
      scrollInfo: (t: string) => theme.fg("muted", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });

    selectList.onSelect = (item) => {
      if (item.value === "__prev") {
        done({ type: "prev" });
      } else if (item.value === "__next") {
        done({ type: "next" });
      } else if (item.value === "__refresh") {
        done({ type: "refresh" });
      } else if (item.value === "__menu") {
        done({ type: "menu" });
      } else {
        done({ type: "package", name: item.value });
      }
    };

    selectList.onCancel = () => done({ type: "cancel" });

    container.addChild(selectList);
    container.addChild(new Spacer(1));

    // Help text
    container.addChild(
      new Text(theme.fg("dim", "↑↓ Navigate • Enter Select • M Main • ? Help • Esc Cancel"), 2, 0)
    );
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (data === "m" || data === "M") {
          done({ type: "main" });
          return;
        }
        if (data === "?" || data === "h" || data === "H") {
          done({ type: "help" });
          return;
        }
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  // Handle result
  switch (result.type) {
    case "cancel":
      return;
    case "prev":
      await browseRemotePackages(ctx, query, pi, Math.max(0, offset - PAGE_SIZE));
      return;
    case "next":
      await browseRemotePackages(ctx, query, pi, offset + PAGE_SIZE);
      return;
    case "refresh":
      await browseRemotePackages(ctx, query, pi, 0);
      return;
    case "menu":
      await showRemoteMenu(ctx, pi);
      return;
    case "main":
      return;
    case "help":
      showHelp(ctx);
      return;
    case "package":
      await showPackageDetails(result.name, ctx, pi);
      return;
  }
}

async function showPackageDetails(
  packageName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
) {
  if (!ctx.hasUI) {
    console.log(`Package: ${packageName}`);
    return;
  }

  const choice = await ctx.ui.select(packageName, [
    `Install ${packageName}`,
    "View npm info",
    "Back to results",
  ]);

  if (!choice) return;

  if (choice.startsWith("Install")) {
    await installPackage(`npm:${packageName}`, ctx, pi);
  } else if (choice.includes("npm info")) {
    const infoRes = await pi.exec("npm", ["view", packageName, "--json"], {
      timeout: 10000,
      cwd: ctx.cwd,
    });
    if (infoRes.code === 0) {
      try {
        interface NpmViewInfo {
          description?: string;
          version?: string;
          author?: { name?: string } | string;
          homepage?: string;
        }
        const info = JSON.parse(infoRes.stdout) as NpmViewInfo;
        const description = info.description ?? "No description";
        const version = info.version ?? "unknown";
        const author =
          typeof info.author === "object" ? info.author?.name : (info.author ?? "unknown");
        const homepage = info.homepage ?? "";

        ctx.ui.notify(
          `${packageName}@${version}\n${description}\nAuthor: ${author}${homepage ? `\n${homepage}` : ""}`,
          "info"
        );
      } catch {
        ctx.ui.notify(`Package: ${packageName}\n${infoRes.stdout.slice(0, 500)}`, "info");
      }
    }
    await showPackageDetails(packageName, ctx, pi);
  } else if (choice.includes("Back")) {
    await browseRemotePackages(ctx, "keywords:pi-package", pi);
  }
}

async function promptInstall(ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  if (!ctx.hasUI) {
    console.log("Interactive input not available in non-interactive mode.");
    console.log("Usage: /extensions install <npm:package|git:url|path>");
    return;
  }
  const source = await ctx.ui.input("Install package", "npm:@scope/pkg or git:https://...");
  if (!source) return;
  await installPackage(source.trim(), ctx, pi);
}

async function installPackage(source: string, ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  const normalized = normalizePackageSource(source);

  // Confirm installation (interactive only)
  if (ctx.hasUI) {
    const confirmed = await ctx.ui.confirm("Install Package", `Install ${normalized}?`, {
      timeout: 30000,
    });

    if (!confirmed) {
      ctx.ui.notify("Installation cancelled.", "info");
      return;
    }

    ctx.ui.notify(`Installing ${normalized}...`, "info");
  } else {
    console.log(`Installing ${normalized}...`);
  }

  const res = await pi.exec("pi", ["install", normalized], { timeout: 180000, cwd: ctx.cwd });

  if (res.code !== 0) {
    const errorMsg = `Install failed:\n${res.stderr || res.stdout || `exit ${res.code}`}`;
    if (ctx.hasUI) {
      ctx.ui.notify(errorMsg, "error");
    } else {
      console.error(errorMsg);
    }
    return;
  }

  if (ctx.hasUI) {
    ctx.ui.notify(`Installed ${normalized}`, "info");

    const shouldReload = await ctx.ui.confirm(
      "Reload Required",
      "Package installed. Reload pi now?"
    );

    if (shouldReload) {
      ctx.ui.setEditorText("/reload");
    }
  } else {
    console.log(`Installed ${normalized}`);
    console.log("Run /reload to apply changes.");
  }
}

async function promptRemove(ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  if (!ctx.hasUI) {
    console.log("Interactive selection not available in non-interactive mode.");
    console.log("Usage: /extensions remove <npm:package|git:url|path>");
    return;
  }

  const packages = await getInstalledPackages(ctx, pi);
  if (packages.length === 0) {
    const msg = "No packages installed.";
    if (ctx.hasUI) {
      ctx.ui.notify(msg, "info");
    } else {
      console.log(msg);
    }
    return;
  }

  const items = packages.map((p) => `${p.name}${p.version ? ` @${p.version}` : ""} (${p.scope})`);

  const toRemove = await ctx.ui.select("Remove package", items);
  if (!toRemove) return;

  const packageName = toRemove.split(" @")[0]?.split(" (")[0];
  if (!packageName) return;

  const pkg = packages.find((p) => p.name === packageName);
  if (pkg) {
    await removePackage(pkg.source, ctx, pi);
  }
}

async function removePackage(source: string, ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  // Confirm removal (interactive only)
  if (ctx.hasUI) {
    const confirmed = await ctx.ui.confirm("Remove Package", `Remove ${source}?`, {
      timeout: 10000,
    });

    if (!confirmed) {
      ctx.ui.notify("Removal cancelled.", "info");
      return;
    }

    ctx.ui.notify(`Removing ${source}...`, "info");
  } else {
    console.log(`Removing ${source}...`);
  }

  const res = await pi.exec("pi", ["remove", source], { timeout: 60000, cwd: ctx.cwd });

  if (res.code !== 0) {
    const errorMsg = `Remove failed: ${res.stderr || res.stdout || `exit ${res.code}`}`;
    if (ctx.hasUI) {
      ctx.ui.notify(errorMsg, "error");
    } else {
      console.error(errorMsg);
    }
    return;
  }

  if (ctx.hasUI) {
    ctx.ui.notify(`Removed ${source}`, "info");

    const shouldReload = await ctx.ui.confirm("Reload Required", "Package removed. Reload pi now?");

    if (shouldReload) {
      ctx.ui.setEditorText("/reload");
    }
  } else {
    console.log(`Removed ${source}`);
    console.log("Run /reload to apply changes.");
  }
}

// ============== Installed Packages ==============

async function showInstalledPackages(ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  const packages = await getInstalledPackages(ctx, pi);

  if (packages.length === 0) {
    const msg = "No packages installed.";
    if (ctx.hasUI) {
      ctx.ui.notify(msg, "info");
    } else {
      console.log(msg);
    }
    return;
  }

  if (!ctx.hasUI) {
    // Non-interactive mode: just list packages
    const lines = packages.map((p) => `${p.name}${p.version ? ` @${p.version}` : ""} (${p.scope})`);
    console.log(lines.join("\n"));
    return;
  }

  const items = packages.map((p) => `${p.name}${p.version ? ` @${p.version}` : ""} (${p.scope})`);

  items.push("[Update all packages]");
  items.push("[Back]");

  const picked = await ctx.ui.select(`Installed Packages (${packages.length})`, items);
  if (!picked) return;

  if (picked === "[Update all packages]") {
    await updatePackages(ctx, pi);
  } else if (picked === "[Back]") {
    await showInteractive(ctx, pi);
  } else {
    const packageName = picked.split(" @")[0]?.split(" (")[0];
    if (!packageName) return;
    const pkg = packages.find((p) => p.name === packageName);
    if (pkg) {
      await showPackageActions(pkg.source, pkg, ctx, pi);
    }
  }
}

async function showPackageActions(
  source: string,
  pkg: InstalledPackage,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
) {
  if (!ctx.hasUI) {
    console.log(`Package: ${pkg.name}`);
    console.log(`Version: ${pkg.version || "unknown"}`);
    console.log(`Source: ${pkg.source}`);
    console.log(`Scope: ${pkg.scope}`);
    return;
  }

  const choice = await ctx.ui.select(pkg.name, [
    `Remove ${pkg.name}`,
    `Update ${pkg.name}`,
    "View details",
    "Back to list",
  ]);

  if (!choice) return;

  if (choice.startsWith("Remove")) {
    await removePackage(source, ctx, pi);
  } else if (choice.startsWith("Update")) {
    await updatePackage(source, ctx, pi);
  } else if (choice.includes("details")) {
    ctx.ui.notify(
      `Name: ${pkg.name}\nVersion: ${pkg.version || "unknown"}\nSource: ${pkg.source}\nScope: ${pkg.scope}`,
      "info"
    );
    await showPackageActions(source, pkg, ctx, pi);
  } else if (choice.includes("Back")) {
    await showInstalledPackages(ctx, pi);
  }
}

async function updatePackage(source: string, ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  if (ctx.hasUI) {
    ctx.ui.notify(`Updating ${source}...`, "info");
  } else {
    console.log(`Updating ${source}...`);
  }

  const res = await pi.exec("pi", ["update", source], { timeout: 120000, cwd: ctx.cwd });

  if (res.code !== 0) {
    const errorMsg = `Update failed: ${res.stderr || res.stdout || `exit ${res.code}`}`;
    if (ctx.hasUI) {
      ctx.ui.notify(errorMsg, "error");
    } else {
      console.error(errorMsg);
    }
    return;
  }

  const stdout = res.stdout || "";
  if (stdout.includes("already up to date") || stdout.includes("pinned")) {
    const msg = `${source} is already up to date (or pinned).`;
    if (ctx.hasUI) {
      ctx.ui.notify(msg, "info");
    } else {
      console.log(msg);
    }
  } else {
    if (ctx.hasUI) {
      ctx.ui.notify(`Updated ${source}`, "info");

      const shouldReload = await ctx.ui.confirm(
        "Reload Required",
        "Package updated. Reload pi now?"
      );

      if (shouldReload) {
        ctx.ui.setEditorText("/reload");
      }
    } else {
      console.log(`Updated ${source}`);
      console.log("Run /reload to apply changes.");
    }
  }
}

async function updatePackages(ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  if (ctx.hasUI) {
    ctx.ui.notify("Updating all packages...", "info");
  } else {
    console.log("Updating all packages...");
  }

  const res = await pi.exec("pi", ["update"], { timeout: 300000, cwd: ctx.cwd });

  if (res.code !== 0) {
    const errorMsg = `Update failed: ${res.stderr || res.stdout || `exit ${res.code}`}`;
    if (ctx.hasUI) {
      ctx.ui.notify(errorMsg, "error");
    } else {
      console.error(errorMsg);
    }
    return;
  }

  const stdout = res.stdout || "";
  if (stdout.includes("already up to date") || stdout.trim() === "") {
    const msg = "All packages are already up to date.";
    if (ctx.hasUI) {
      ctx.ui.notify(msg, "info");
    } else {
      console.log(msg);
    }
  } else {
    if (ctx.hasUI) {
      ctx.ui.notify("Packages updated", "info");

      const shouldReload = await ctx.ui.confirm(
        "Reload Required",
        "Packages updated. Reload pi now?"
      );

      if (shouldReload) {
        ctx.ui.setEditorText("/reload");
      }
    } else {
      console.log("Packages updated");
      console.log("Run /reload to apply changes.");
    }
  }
}

// Kept for future use
async function _getInstalledPackagesSummary(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<string> {
  const packages = await getInstalledPackages(ctx, pi);
  if (packages.length === 0) return "none";
  return `${packages.length} package${packages.length === 1 ? "" : "s"}`;
}

async function getInstalledPackages(
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI
): Promise<InstalledPackage[]> {
  const res = await pi.exec("pi", ["list"], { timeout: 10000, cwd: ctx.cwd });
  if (res.code !== 0) return [];

  const text = res.stdout || "";
  if (!text.trim() || /No packages installed/i.test(text)) {
    return [];
  }

  const packages: InstalledPackage[] = [];
  const seen = new Set<string>();

  const lines = text.split("\n");
  let currentScope: "global" | "project" = "global";

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect scope headers
    if (trimmed.toLowerCase().includes("global")) {
      currentScope = "global";
      continue;
    }
    if (trimmed.toLowerCase().includes("project") || trimmed.toLowerCase().includes("local")) {
      currentScope = "project";
      continue;
    }

    // Parse package lines
    const match = trimmed.match(/^[-•]?\s*(npm:|git:|https?:|\/|\.\/)(.+)$/);
    if (match?.[1] && match[2]) {
      const fullSource = match[1] + match[2];

      // Deduplicate by source
      if (seen.has(fullSource)) continue;
      seen.add(fullSource);

      // Extract name and version
      let name = fullSource;
      let version: string | undefined;
      let source = fullSource;

      if (fullSource.startsWith("npm:")) {
        const npmPart = fullSource.slice(4);
        // Scoped packages: @scope/name@version
        const scopedMatch = npmPart.match(/^(@[^@]+\/[^@]+)@(.+)$/);
        if (scopedMatch?.[1] && scopedMatch[2]) {
          name = scopedMatch[1];
          version = scopedMatch[2];
        } else {
          // Regular packages: name@version
          const simpleMatch = npmPart.match(/^([^@]+)@(.+)$/);
          if (simpleMatch?.[1] && simpleMatch[2]) {
            name = simpleMatch[1];
            version = simpleMatch[2];
          } else {
            name = npmPart;
          }
        }
      } else if (fullSource.startsWith("git:")) {
        name = fullSource.slice(4).split("@")[0] || fullSource;
      }

      const pkg: InstalledPackage = { source, name, scope: currentScope };
      if (version !== undefined) {
        pkg.version = version;
      }
      packages.push(pkg);
    }
  }

  return packages;
}

// ============== Utility Functions ==============

function isPackageSource(str: string): boolean {
  return (
    str.startsWith("npm:") ||
    str.startsWith("git:") ||
    str.startsWith("http") ||
    str.startsWith("/") ||
    str.startsWith("./") ||
    str.startsWith("../")
  );
}

function normalizePackageSource(source: string): string {
  if (
    source.startsWith("npm:") ||
    source.startsWith("git:") ||
    source.startsWith("http") ||
    source.startsWith("/") ||
    source.startsWith(".")
  ) {
    return source;
  }
  return `npm:${source}`;
}

function formatEntry(entry: ExtensionEntry): string {
  const state = entry.state === "enabled" ? "on " : "off";
  const scope = entry.scope === "global" ? "G" : "P";
  return `[${state}] [${scope}] ${entry.displayName} - ${entry.summary}`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

// Helper to apply theme colors (used for SelectItem labels which are strings)
function themeLabel(_color: string, text: string): string {
  // The actual coloring happens in render via theme functions
  // We just return the text here - SelectList applies its own styling
  return text;
}

// ============== Extension Discovery ==============

async function discoverExtensions(cwd: string): Promise<ExtensionEntry[]> {
  const roots: { root: string; scope: Scope; label: string }[] = [
    {
      root: join(homedir(), ".pi", "agent", "extensions"),
      scope: "global",
      label: "~/.pi/agent/extensions",
    },
    { root: join(cwd, ".pi", "extensions"), scope: "project", label: ".pi/extensions" },
  ];

  const all: ExtensionEntry[] = [];
  for (const root of roots) {
    all.push(...(await discoverInRoot(root.root, root.scope, root.label)));
  }

  all.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return dedupeExtensions(all);
}

async function discoverInRoot(
  root: string,
  scope: Scope,
  label: string
): Promise<ExtensionEntry[]> {
  let dirEntries: Dirent[];
  try {
    dirEntries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    // Silently ignore ENOENT (directory doesn't exist) - this is expected
    // for project scope when .pi/extensions doesn't exist yet
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    // Log other errors for debugging
    console.error(`[extensions-manager] Error reading ${root}:`, error);
    return [];
  }

  const found: ExtensionEntry[] = [];

  for (const item of dirEntries) {
    const name = item.name;

    if (item.isFile()) {
      const entry = await parseTopLevelFile(root, label, scope, name);
      if (entry) found.push(entry);
      continue;
    }

    if (item.isDirectory()) {
      const entry = await parseDirectoryIndex(root, label, scope, name);
      if (entry) found.push(entry);
    }
  }

  return found;
}

async function parseTopLevelFile(
  root: string,
  label: string,
  scope: Scope,
  fileName: string
): Promise<ExtensionEntry | undefined> {
  const isEnabledTsJs = /\.(ts|js)$/i.test(fileName) && !fileName.endsWith(DISABLED_SUFFIX);
  const isDisabledTsJs = /\.(ts|js)\.disabled$/i.test(fileName);

  if (!isEnabledTsJs && !isDisabledTsJs) return undefined;

  const currentPath = join(root, fileName);
  const activePath = isDisabledTsJs ? currentPath.slice(0, -DISABLED_SUFFIX.length) : currentPath;
  const disabledPath = `${activePath}${DISABLED_SUFFIX}`;
  const state: State = isDisabledTsJs ? "disabled" : "enabled";
  const summary = await readSummary(state === "enabled" ? activePath : disabledPath);

  const relativePath = relative(root, activePath).replace(/\.disabled$/i, "");

  return {
    id: `${scope}:${activePath}`,
    scope,
    state,
    activePath,
    disabledPath,
    displayName: `${label}/${relativePath}`,
    summary,
  };
}

async function parseDirectoryIndex(
  root: string,
  label: string,
  scope: Scope,
  dirName: string
): Promise<ExtensionEntry | undefined> {
  const dir = join(root, dirName);

  for (const ext of [".ts", ".js"]) {
    const activePath = join(dir, `index${ext}`);
    const disabledPath = `${activePath}${DISABLED_SUFFIX}`;

    if (await fileExists(activePath)) {
      return {
        id: `${scope}:${activePath}`,
        scope,
        state: "enabled",
        activePath,
        disabledPath,
        displayName: `${label}/${dirName}/index${ext}`,
        summary: await readSummary(activePath),
      };
    }

    if (await fileExists(disabledPath)) {
      return {
        id: `${scope}:${activePath}`,
        scope,
        state: "disabled",
        activePath,
        disabledPath,
        displayName: `${label}/${dirName}/index${ext}`,
        summary: await readSummary(disabledPath),
      };
    }
  }

  return undefined;
}

async function setState(
  entry: ExtensionEntry,
  target: State
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (target === "enabled") {
      await rename(entry.disabledPath, entry.activePath);
    } else {
      await rename(entry.activePath, entry.disabledPath);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readSummary(filePath: string): Promise<string> {
  try {
    const text = await readFile(filePath, "utf8");
    const trimmed = text.trimStart();

    // Look for JSDoc/description patterns
    const descriptionPatterns = [
      /registerCommand\(\s*["'`][^"'`]+["'`]\s*,\s*\{[\s\S]*?description\s*:\s*["'`]([^"'`]+)["'`]/m,
      /registerTool\(\s*\{[\s\S]*?description\s*:\s*["'`]([^"'`]+)["'`]/m,
      /description\s*:\s*["'`]([^"'`]+)["'`]/m,
    ];

    for (const pattern of descriptionPatterns) {
      const match = text.match(pattern);
      const value = match?.[1]?.trim();
      if (value) return truncate(value, 80);
    }

    // Look for block comments
    const block = trimmed.match(/^\/\*+[\s\S]*?\*\//);
    if (block?.[0]) {
      const lines = block[0]
        .split("\n")
        .map((line) =>
          line
            .replace(/^\s*\/\*+\s?/, "")
            .replace(/\*\/$/, "")
            .replace(/^\s*\*\s?/, "")
            .trim()
        )
        .filter((s): s is string => Boolean(s));
      const firstLine = lines[0];
      if (firstLine) return truncate(firstLine, 80);
    }

    // Look for line comments
    const lineComment = trimmed.match(/^(?:\s*\/\/.*\n?)+/);
    if (lineComment?.[0]) {
      const first = lineComment[0]
        .split("\n")
        .map((line) => line.replace(/^\s*\/\/\s?/, "").trim())
        .filter(Boolean)[0];
      if (first) return truncate(first, 80);
    }

    // First non-empty line
    for (const line of text.split("\n")) {
      const clean = line.trim();
      if (clean.length > 0) return truncate(clean, 80);
    }
  } catch {
    // ignore
  }
  return "No description";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function dedupeExtensions(entries: ExtensionEntry[]): ExtensionEntry[] {
  const byId = new Map<string, ExtensionEntry>();
  for (const entry of entries) {
    if (!byId.has(entry.id)) {
      byId.set(entry.id, entry);
    }
  }
  return [...byId.values()];
}
