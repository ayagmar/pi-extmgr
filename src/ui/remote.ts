/**
 * Remote package browsing UI
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { BrowseAction, NpmPackage } from "../types/index.js";
import { PAGE_SIZE } from "../constants.js";
import { truncate, dynamicTruncate } from "../utils/format.js";
import {
  searchNpmPackages,
  getSearchCache,
  setSearchCache,
  isCacheValid,
} from "../packages/discovery.js";
import { installPackage, installPackageLocally } from "../packages/install.js";

export async function showRemote(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const sub = (subcommand ?? "").toLowerCase();
  const query = rest.join(" ").trim();

  switch (sub) {
    case "list":
    case "installed":
      // Legacy: redirect to unified view
      ctx.ui.notify("📦 Use /extensions for the unified view.", "info");
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

async function showRemoteMenu(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (!ctx.hasUI) return;

  const choice = await ctx.ui.select("Community Packages", [
    "🔍 Browse pi packages",
    "🔎 Search packages",
    "📥 Install by source",
  ]);

  if (!choice) return;

  if (choice.includes("Browse")) {
    await browseRemotePackages(ctx, "keywords:pi-package", pi);
  } else if (choice.includes("Search")) {
    await promptSearch(ctx, pi);
  } else if (choice.includes("Install")) {
    await promptInstall(ctx, pi);
  }
}

export async function browseRemotePackages(
  ctx: ExtensionCommandContext,
  query: string,
  pi: ExtensionAPI,
  offset = 0
): Promise<void> {
  // Check cache first
  let allPackages: NpmPackage[] = [];

  if (isCacheValid(query) && offset > 0) {
    const cache = getSearchCache();
    if (cache) allPackages = cache.results;
  } else {
    // Show searching notification
    ctx.ui.notify(`Searching npm for: ${truncate(query, 40)}...`, "info");

    // Perform search
    allPackages = await searchNpmPackages(query, ctx, pi);

    // Cache results for pagination
    setSearchCache({
      query,
      results: allPackages,
      timestamp: Date.now(),
    });
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

  // Add navigation options
  const showLoadMore = totalResults >= PAGE_SIZE && packages.length === PAGE_SIZE;
  const showPrevious = offset > 0;

  const titleText =
    offset > 0
      ? `Search Results (${offset + 1}-${offset + packages.length})`
      : `Search: ${truncate(query, 40)}`;

  // Use simple select instead of custom component to avoid hanging issues
  // Calculate reserved space: name (~25) + version (~10) + separator (3) = ~40 chars
  const reservedSpace = 40;
  const selectItems: string[] = packages.map(
    (p) =>
      `${p.name}${p.version ? ` @${p.version}` : ""} - ${dynamicTruncate(p.description || "No description", reservedSpace)}`
  );

  // Add navigation options
  if (showPrevious) {
    selectItems.push("◀  Previous page");
  }
  if (showLoadMore) {
    selectItems.push(`▶  Next page (${offset + 1}-${offset + packages.length})`);
  }
  selectItems.push("🔄 Refresh search");
  selectItems.push("← Back to menu");

  const choice = await ctx.ui.select(titleText, selectItems);

  if (!choice) {
    return; // User cancelled
  }

  // Determine action based on selection
  let result: BrowseAction;
  if (choice.includes("◀  Previous")) {
    result = { type: "prev" };
  } else if (choice.includes("▶  Next")) {
    result = { type: "next" };
  } else if (choice.includes("🔄 Refresh")) {
    result = { type: "refresh" };
  } else if (choice.includes("← Back")) {
    result = { type: "menu" };
  } else {
    // Extract package name from the choice (format: "name @version - description")
    const pkgName = choice.split(" ")[0] ?? "";
    result = { type: "package", name: pkgName };
  }

  // Handle result
  switch (result.type) {
    case "prev":
      await browseRemotePackages(ctx, query, pi, Math.max(0, offset - PAGE_SIZE));
      return;
    case "next":
      await browseRemotePackages(ctx, query, pi, offset + PAGE_SIZE);
      return;
    case "refresh":
      setSearchCache(null);
      await browseRemotePackages(ctx, query, pi, 0);
      return;
    case "menu":
      await showRemoteMenu(ctx, pi);
      return;
    case "package":
      await showPackageDetails(result.name, ctx, pi, query, offset);
      return;
  }
}

async function showPackageDetails(
  packageName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  previousQuery: string,
  previousOffset: number
): Promise<void> {
  if (!ctx.hasUI) {
    console.log(`Package: ${packageName}`);
    return;
  }

  const choice = await ctx.ui.select(packageName, [
    `Install via npm (managed)`,
    `Install locally (standalone)`,
    "View npm info",
    "Back to results",
  ]);

  if (!choice) return;

  if (choice.includes("via npm")) {
    await installPackage(`npm:${packageName}`, ctx, pi);
  } else if (choice.includes("locally")) {
    await installPackageLocally(packageName, ctx, pi);
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
    await showPackageDetails(packageName, ctx, pi, previousQuery, previousOffset);
  } else if (choice.includes("Back")) {
    await browseRemotePackages(ctx, previousQuery, pi, previousOffset);
  }
}

async function promptSearch(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const query = await ctx.ui.input("Search packages", "keywords:pi-package");
  if (!query?.trim()) return;
  await searchPackages(query.trim(), ctx, pi);
}

async function searchPackages(
  query: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  if (!query) {
    await promptSearch(ctx, pi);
    return;
  }
  await browseRemotePackages(ctx, query, pi);
}

async function promptInstall(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (!ctx.hasUI) {
    console.log("Interactive input not available in non-interactive mode.");
    console.log("Usage: /extensions install <npm:package|git:url|path>");
    return;
  }
  const source = await ctx.ui.input("Install package", "npm:@scope/pkg or git:https://...");
  if (!source) return;
  await installPackage(source.trim(), ctx, pi);
}
