/**
 * Remote package browsing UI (Discover workspace orchestration).
 *
 * Cohesive pieces live in ./discover: query planning, metadata caching,
 * formatting, and the browse component. This module owns the screen loop,
 * navigation queue, and install/detail flows.
 */
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { PAGE_SIZE, UI } from "../constants.js";
import { getRemotePackageBadges } from "../packages/badges.js";
import {
  addWeeklyDownloadsToSearchPage,
  clearSearchCache,
  getInstalledPackagesAllScopes,
  getSearchCache,
  hydrateSearchCache,
  isCacheValid,
  searchNpmPackages,
} from "../packages/discovery.js";
import {
  installPackageLocallyWithOutcome,
  installPackageWithOutcome,
} from "../packages/install.js";
import { type BrowseAction, type NpmPackage } from "../types/index.js";
import { getKnownUpdates } from "../utils/auto-update.js";
import { parseChoiceByLabel, splitCommandArgs } from "../utils/command.js";
import { parseNpmSource, truncate } from "../utils/format.js";
import { requireCustomUI, runCustomUI } from "../utils/mode.js";
import { notify } from "../utils/notify.js";
import { runTaskWithLoader } from "./async-task.js";
import { RemotePackageBrowser } from "./discover/browser.js";
import { buildPackageInfoText, packageInfoCache } from "./discover/metadata.js";
import {
  COMMUNITY_BROWSE_QUERY,
  createCommunityBrowsePlan,
  createRemoteBrowseQueryPlan,
  filterRemoteBrowseResults,
  type RemoteBrowseQueryPlan,
  type RemoteBrowseSource,
  resolveRemoteBrowseSource,
} from "./discover/query.js";
import { runAuxWorkspaceScreens } from "./workspace/router.js";

export { clearRemotePackageInfoCache } from "./discover/metadata.js";

const REMOTE_MENU_CHOICES = {
  browse: "Browse community packages",
  search: "Search npm packages",
  install: "Install by source",
} as const;

const PACKAGE_DETAILS_CHOICES = {
  installManaged: "Install via npm (managed)",
  installStandalone: "Install locally (standalone)",
  viewInfo: "View npm info",
  back: "Back to results",
} as const;

/** True when a nested mutation reloaded pi and callers must stop using this context. */
export type RemoteWorkspaceResult = boolean;

export async function showRemote(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<RemoteWorkspaceResult> {
  const { subcommand: sub, args: rest } = splitCommandArgs(args);
  const query = rest.join(" ").trim();

  switch (sub) {
    case "list":
    case "installed":
      // Legacy: redirect to unified view
      ctx.ui.notify("Use /extensions for the Installed workspace.", "info");
      return false;
    case "install":
      if (query) {
        return (await installPackageWithOutcome(query, ctx, pi)).reloaded;
      }
      return promptInstall(ctx, pi);
    case "search":
      return searchPackages(query, ctx, pi);
    case "browse":
    case "":
      return browseRemotePackages(ctx, COMMUNITY_BROWSE_QUERY, pi);
  }

  // Show remote menu
  return showRemoteMenu(ctx, pi);
}

async function showRemoteMenu(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<RemoteWorkspaceResult> {
  if (!ctx.hasUI) return false;

  const choice = parseChoiceByLabel(
    REMOTE_MENU_CHOICES,
    await ctx.ui.select("Community Packages", Object.values(REMOTE_MENU_CHOICES))
  );

  switch (choice) {
    case "browse":
      return browseRemotePackages(ctx, COMMUNITY_BROWSE_QUERY, pi);
    case "search":
      return promptSearch(ctx, pi);
    case "install":
      return promptInstall(ctx, pi);
    default:
      return false;
  }
}

async function selectBrowseAction(
  ctx: ExtensionCommandContext,
  plan: Exclude<RemoteBrowseQueryPlan, { kind: "unsupported" }>,
  browseSource: RemoteBrowseSource,
  packages: NpmPackage[],
  offset: number,
  totalResults: number,
  showPrevious: boolean,
  showLoadMore: boolean,
  hydrateDownloads?: (signal: AbortSignal) => Promise<void>
): Promise<BrowseAction | undefined> {
  if (!ctx.hasUI) return undefined;

  return runCustomUI(ctx, "Remote package browsing", () =>
    ctx.ui.custom<BrowseAction>((tui, theme, keybindings, done) => {
      const container = new Container();
      const title = new Text("", 2, 0);
      const browser = new RemotePackageBrowser(
        packages,
        theme,
        keybindings,
        browseSource,
        plan.displayQuery,
        totalResults,
        offset,
        Math.max(4, Math.min(UI.maxListHeight, tui.terminal.rows - 10)),
        showPrevious,
        showLoadMore,
        done
      );
      const syncThemedContent = (): void => {
        title.setText(theme.fg("accent", theme.bold(plan.title)));
      };
      const hydrationController = new AbortController();
      let disposed = false;
      if (hydrateDownloads) {
        void hydrateDownloads(hydrationController.signal)
          .then(() => {
            // Ignore results that land after disposal or cancellation.
            if (disposed || hydrationController.signal.aborted) return;
            browser.refreshSort();
            tui.requestRender();
          })
          .catch(() => {
            // Background hydration is best-effort; abort/network errors are expected.
          });
      }

      syncThemedContent();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(title);
      container.addChild(new Spacer(1));
      container.addChild(browser);
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      let focused = false;

      return {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          browser.focused = value;
        },
        render(width: number) {
          syncThemedContent();
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
          browser.invalidate();
          syncThemedContent();
        },
        dispose() {
          disposed = true;
          hydrationController.abort();
        },
        handleInput(data: string) {
          if (browser.handleBrowseInput(data)) {
            tui.requestRender();
          }
        },
      };
    })
  );
}

type BrowseRequest = {
  ctx: ExtensionCommandContext;
  query: string;
  pi: ExtensionAPI;
  offset: number;
  source?: RemoteBrowseSource;
  forceRefresh: boolean;
};

let browseNavigationActive = false;
const browseNavigationQueue: BrowseRequest[] = [];

export async function browseRemotePackages(
  ctx: ExtensionCommandContext,
  query: string,
  pi: ExtensionAPI,
  offset = 0,
  source?: RemoteBrowseSource,
  forceRefresh = false
): Promise<RemoteWorkspaceResult> {
  const request: BrowseRequest = {
    ctx,
    query,
    pi,
    offset,
    forceRefresh,
    ...(source ? { source } : {}),
  };
  if (browseNavigationActive) {
    browseNavigationQueue.push(request);
    return false;
  }

  browseNavigationActive = true;
  try {
    let next: BrowseRequest | undefined = request;
    while (next) {
      if (await browseRemotePackagesPage(next)) return true;
      next = browseNavigationQueue.shift();
    }
  } finally {
    browseNavigationQueue.length = 0;
    browseNavigationActive = false;
  }
  return false;
}

async function browseRemotePackagesPage({
  ctx,
  query,
  pi,
  offset = 0,
  source,
  forceRefresh = false,
}: BrowseRequest): Promise<RemoteWorkspaceResult> {
  if (
    !requireCustomUI(
      ctx,
      "Remote package browsing",
      "Use `/extensions install <source>` to install directly outside the full interactive TUI."
    )
  ) {
    return false;
  }

  const browseSource = resolveRemoteBrowseSource(query, source);
  const plan =
    browseSource === "community"
      ? createCommunityBrowsePlan(query)
      : createRemoteBrowseQueryPlan(query);
  if (plan.kind === "unsupported") {
    notify(ctx, plan.message, "warning");
    return false;
  }

  const searchLabel = plan.displayQuery || "community packages";
  let searchPage: Awaited<ReturnType<typeof searchNpmPackages>> | undefined;
  if (!forceRefresh && isCacheValid(plan.searchQuery, offset)) {
    searchPage = getSearchCache(plan.searchQuery, offset) ?? undefined;
  }

  if (!searchPage && !forceRefresh) {
    searchPage = (await hydrateSearchCache(plan.searchQuery, offset)) ?? undefined;
  }

  if (!searchPage) {
    try {
      searchPage = await runTaskWithLoader(
        ctx,
        {
          title: plan.title,
          message: `Searching npm for ${truncate(searchLabel, 40)}...`,
        },
        async ({ signal }) => {
          return searchNpmPackages(plan.searchQuery, ctx, {
            signal,
            offset,
            size: PAGE_SIZE,
            forceRefresh,
          });
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify(ctx, `Remote package search failed: ${message}`, "warning");
      return false;
    }
  }

  if (!searchPage) {
    notify(ctx, "Remote package search was cancelled.", "info");
    return false;
  }

  const resolvedSearchPage = searchPage;
  const installed = await getInstalledPackagesAllScopes(ctx);
  const installedNames = new Set(
    installed.flatMap((pkg) => {
      const parsed = parseNpmSource(pkg.source);
      return parsed?.name ? [parsed.name] : [];
    })
  );
  const updateNames = new Set(
    [...getKnownUpdates(ctx)].flatMap((identity) => {
      const parsed = parseNpmSource(identity);
      return parsed?.name ? [parsed.name] : [];
    })
  );
  const packages = filterRemoteBrowseResults(plan, resolvedSearchPage.results).map((pkg) => ({
    ...pkg,
    ...getRemotePackageBadges(pkg, installedNames, updateNames),
  }));
  const totalResults =
    plan.kind === "search" && plan.exactPackageName ? packages.length : resolvedSearchPage.total;
  const reloadQuery =
    browseSource === "community" ? plan.displayQuery || COMMUNITY_BROWSE_QUERY : plan.rawQuery;

  if (packages.length === 0) {
    const msg =
      offset > 0
        ? "No more packages to show."
        : `No packages found for: ${plan.displayQuery || "community packages"}`;
    ctx.ui.notify(msg, "info");

    if (offset > 0) {
      return browseRemotePackages(ctx, reloadQuery, pi, 0, browseSource);
    }
    return false;
  }

  const showLoadMore = offset + resolvedSearchPage.results.length < totalResults;
  const showPrevious = offset > 0;
  const hydrateDownloads = packages.some((pkg) => pkg.weeklyDownloads === undefined)
    ? async (signal: AbortSignal): Promise<void> => {
        await addWeeklyDownloadsToSearchPage(resolvedSearchPage, signal);
        if (signal.aborted) return;
        const hydrated = new Map(
          resolvedSearchPage.results.map((pkg) => [pkg.name, pkg.weeklyDownloads] as const)
        );
        for (const pkg of packages) {
          const weeklyDownloads = hydrated.get(pkg.name);
          if (weeklyDownloads !== undefined) pkg.weeklyDownloads = weeklyDownloads;
        }
      }
    : undefined;

  const result = await selectBrowseAction(
    ctx,
    plan,
    browseSource,
    packages,
    offset,
    totalResults,
    showPrevious,
    showLoadMore,
    hydrateDownloads
  );

  if (!result || result.type === "cancel") {
    return false;
  }

  if (result.type === "workspace") {
    if (result.screen === "installed") return false;
    if (result.screen === "profiles" || result.screen === "health") {
      const outcome = await runAuxWorkspaceScreens(result.screen, ctx, pi);
      // After a reload the pre-reload context must not drive further UI.
      if (outcome.reloaded) return true;
      if (outcome.navigate === "installed") return false;
    }
    return browseRemotePackages(ctx, reloadQuery, pi, offset, browseSource);
  }

  switch (result.type) {
    case "prev":
      return browseRemotePackages(
        ctx,
        reloadQuery,
        pi,
        Math.max(0, offset - PAGE_SIZE),
        browseSource
      );
    case "next":
      return browseRemotePackages(ctx, reloadQuery, pi, offset + PAGE_SIZE, browseSource);
    case "refresh":
      clearSearchCache(plan.searchQuery);
      return browseRemotePackages(ctx, reloadQuery, pi, 0, browseSource, true);
    case "search": {
      const nextQuery = result.query.trim();
      if (browseSource === "community") {
        return browseRemotePackages(ctx, nextQuery || COMMUNITY_BROWSE_QUERY, pi, 0, "community");
      }
      return browseRemotePackages(
        ctx,
        nextQuery || COMMUNITY_BROWSE_QUERY,
        pi,
        0,
        nextQuery ? "npm" : undefined
      );
    }
    case "install": {
      if (await promptInstall(ctx, pi)) return true;
      return browseRemotePackages(ctx, reloadQuery, pi, offset, browseSource);
    }
    case "menu":
      return showRemoteMenu(ctx, pi);
    case "package":
      return showPackageDetails(result.name, ctx, pi, reloadQuery, offset, browseSource);
  }
}

async function confirmMarketplaceInstall(
  packageName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  mode: "managed" | "standalone"
): Promise<"global" | "project" | undefined> {
  const scopeChoice = parseChoiceByLabel(
    {
      global: "Global (~/.pi/agent/settings.json)",
      project: ".pi/settings.json",
      cancel: "Cancel",
    },
    await ctx.ui.select("Install scope", [
      "Global (~/.pi/agent/settings.json)",
      ".pi/settings.json",
      "Cancel",
    ])
  );
  if (!scopeChoice || scopeChoice === "cancel") return undefined;

  const info =
    packageInfoCache.get(packageName)?.text ??
    (await runTaskWithLoader(
      ctx,
      {
        title: "Pre-install review",
        message: `Inspecting ${packageName} metadata...`,
      },
      ({ signal }) => buildPackageInfoText(packageName, ctx, pi, signal)
    ));
  if (!info) {
    notify(ctx, "Pre-install review cancelled; nothing was installed.", "info");
    return undefined;
  }

  const review = [
    `Source: npm:${packageName}`,
    `Scope: ${scopeChoice}`,
    `Mode: ${mode}`,
    "",
    info,
    "",
    "Missing provenance or compatibility metadata is unknown, not safe.",
  ].join("\n");
  if (!(await ctx.ui.confirm("Review before install", `${review}\n\nInstall now?`))) {
    notify(ctx, "Installation cancelled.", "info");
    return undefined;
  }
  return scopeChoice;
}

async function showPackageDetails(
  packageName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  previousQuery: string,
  previousOffset: number,
  browseSource?: RemoteBrowseSource
): Promise<RemoteWorkspaceResult> {
  if (!ctx.hasUI) {
    console.log(`Package: ${packageName}`);
    return false;
  }

  const choice = parseChoiceByLabel(
    PACKAGE_DETAILS_CHOICES,
    await ctx.ui.select(packageName, Object.values(PACKAGE_DETAILS_CHOICES))
  );

  switch (choice) {
    case "installManaged": {
      const scope = await confirmMarketplaceInstall(packageName, ctx, pi, "managed");
      if (!scope) return false;
      const outcome = await installPackageWithOutcome(`npm:${packageName}`, ctx, pi, {
        scope,
        skipConfirmation: true,
      });
      if (outcome.reloaded) return true;
      if (outcome.installed) {
        return browseRemotePackages(ctx, previousQuery, pi, previousOffset, browseSource);
      }
      return showPackageDetails(packageName, ctx, pi, previousQuery, previousOffset, browseSource);
    }
    case "installStandalone": {
      const scope = await confirmMarketplaceInstall(packageName, ctx, pi, "standalone");
      if (!scope) return false;
      const outcome = await installPackageLocallyWithOutcome(packageName, ctx, pi, {
        scope,
        skipConfirmation: true,
      });
      if (outcome.reloaded) return true;
      if (outcome.installed) {
        return browseRemotePackages(ctx, previousQuery, pi, previousOffset, browseSource);
      }
      return showPackageDetails(packageName, ctx, pi, previousQuery, previousOffset, browseSource);
    }
    case "viewInfo":
      try {
        const text =
          packageInfoCache.get(packageName)?.text ??
          (await runTaskWithLoader(
            ctx,
            {
              title: packageName,
              message: `Fetching package details for ${packageName}...`,
            },
            ({ signal }) => buildPackageInfoText(packageName, ctx, pi, signal)
          ));

        if (!text) {
          notify(ctx, `Loading ${packageName} details was cancelled.`, "info");
          return showPackageDetails(
            packageName,
            ctx,
            pi,
            previousQuery,
            previousOffset,
            browseSource
          );
        }

        ctx.ui.notify(text, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Package: ${packageName}\n${message}`, "warning");
      }
      return showPackageDetails(packageName, ctx, pi, previousQuery, previousOffset, browseSource);
    case "back":
      return browseRemotePackages(ctx, previousQuery, pi, previousOffset, browseSource);
    default:
      return false;
  }
}

async function promptSearch(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<RemoteWorkspaceResult> {
  const query = await ctx.ui.input("Search packages", "package name, keyword, or npm:@scope/pkg");
  if (!query?.trim()) return false;
  return searchPackages(query.trim(), ctx, pi);
}

async function searchPackages(
  query: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<RemoteWorkspaceResult> {
  if (!query) return promptSearch(ctx, pi);
  return browseRemotePackages(ctx, query, pi);
}

async function promptInstall(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<RemoteWorkspaceResult> {
  if (!ctx.hasUI) {
    notify(
      ctx,
      "Interactive input not available in non-interactive mode.\nUsage: /extensions install <npm:package|git:url|path>",
      "warning"
    );
    return false;
  }
  const source = await ctx.ui.input("Install package", "npm:@scope/pkg or git:https://...");
  if (!source) return false;
  return (await installPackageWithOutcome(source.trim(), ctx, pi)).reloaded;
}
