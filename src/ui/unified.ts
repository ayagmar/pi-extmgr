/**
 * Unified extension manager UI (Installed workspace orchestration).
 * Displays local extensions and installed packages in one view.
 *
 * Cohesive pieces live in ./installed: items, formatting, filters, browser,
 * and actions. This module owns the screen loop and non-interactive fallbacks.
 */
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { UI } from "../constants.js";
import { discoverExtensions } from "../extensions/discovery.js";
import { getInstalledPackages } from "../packages/discovery.js";
import { discoverPackageExtensions } from "../packages/extensions.js";
import { showInstalledPackagesList } from "../packages/management.js";
import { type State, type UnifiedAction } from "../types/index.js";
import { getKnownUpdates } from "../utils/auto-update.js";
import { formatEntry as formatExtEntry } from "../utils/format.js";
import { hasCustomUI, isProjectTrusted, runCustomUI } from "../utils/mode.js";
import { notify } from "../utils/notify.js";
import { readReloadState } from "../utils/reload-state.js";
import { getSavedViewsPath, readSavedViews, writeSavedViews } from "../utils/views.js";
import { formatListOutput } from "../utils/ui-helpers.js";
import { runTaskWithLoader } from "./async-task.js";
import { buildFooterShortcuts, buildFooterState } from "./footer.js";
import { handleUnifiedAction } from "./installed/actions.js";
import { UnifiedManagerBrowser } from "./installed/browser.js";
import { buildManagerSummary } from "./installed/summary.js";
import { buildUnifiedItems } from "./installed/items.js";
import { managerStateToView, viewToManagerState } from "./installed/state.js";
import { showRemote } from "./remote.js";
import { buildWorkspaceNavigation } from "./workspace/navigation.js";

export { buildUnifiedItems };

let lastReloadNoticeAt: number | undefined;

async function showInteractiveFallback(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  await showListOnly(ctx);
  await showInstalledPackagesList(ctx, pi);
}

export async function showInteractive(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  if (!hasCustomUI(ctx)) {
    notify(
      ctx,
      "The unified extensions manager requires the full interactive TUI. Showing read-only local and installed package lists instead.",
      "warning"
    );
    await showInteractiveFallback(ctx, pi);
    return;
  }

  const reloadState = await readReloadState();
  if (reloadState.required && reloadState.changedAt !== lastReloadNoticeAt) {
    lastReloadNoticeAt = reloadState.changedAt;
    notify(
      ctx,
      `Reload required for pending changes${reloadState.reasons.length > 0 ? `: ${reloadState.reasons.join(", ")}` : "."}`,
      "warning"
    );
  }

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
  const initialData = await runTaskWithLoader(
    ctx,
    {
      title: "Extensions Manager",
      message: "Loading extensions and packages...",
    },
    async ({ signal, setMessage }) => {
      const localEntriesPromise = discoverExtensions(ctx.cwd);
      const installedPackagesPromise = getInstalledPackages(
        ctx,
        pi,
        (current, total) => {
          if (total <= 0) {
            return;
          }
          setMessage(`Loading package metadata... ${current}/${total}`);
        },
        signal
      );

      const [localEntries, installedPackages] = await Promise.all([
        localEntriesPromise,
        installedPackagesPromise,
      ]);

      setMessage("Loading package extension states...");
      const packageExtensions = await discoverPackageExtensions(installedPackages, ctx.cwd, {
        projectTrusted: isProjectTrusted(ctx),
      });

      return { localEntries, installedPackages, packageExtensions };
    }
  );

  if (!initialData) {
    notify(
      ctx,
      "The unified extensions manager requires the full interactive TUI. Showing read-only local and installed package lists instead.",
      "warning"
    );
    await showInteractiveFallback(ctx, pi);
    return true;
  }

  const { localEntries, installedPackages, packageExtensions } = initialData;
  const viewsPath = getSavedViewsPath(ctx.cwd);
  let savedViews = await readSavedViews(viewsPath);

  // Build unified items list.
  const knownUpdates = getKnownUpdates(ctx);
  const items = buildUnifiedItems(localEntries, installedPackages, knownUpdates, packageExtensions);

  // If nothing found, show quick actions
  if (items.length === 0) {
    const choice = await ctx.ui.select("Nothing installed yet", [
      "Browse community packages",
      "Install by source",
      "Back",
    ]);

    if (choice === "Browse community packages") {
      return showRemote("", ctx, pi);
    }
    if (choice === "Install by source") {
      return showRemote("install", ctx, pi);
    }
    return true;
  }

  // Staged changes tracking for local extensions.
  const staged = new Map<string, State>();
  const byId = new Map(items.map((item) => [item.id, item]));
  let managerState = viewToManagerState(savedViews.lastView);

  while (true) {
    let nextManagerState = managerState;

    const result = await runCustomUI(
      ctx,
      "The unified extensions manager",
      () =>
        ctx.ui.custom<UnifiedAction>((tui, theme, keybindings, done) => {
          const container = new Container();

          const titleText = new Text("", 2, 0);
          const navText = new Text("", 2, 0);
          const statsText = new Text("", 2, 0);
          const footerText = new Text("", 2, 0);
          let browser!: UnifiedManagerBrowser;
          const complete = (action: UnifiedAction): void => {
            nextManagerState = browser.getViewState();
            done(action);
          };
          browser = new UnifiedManagerBrowser(
            items,
            staged,
            theme,
            keybindings,
            ctx.cwd,
            Math.max(4, Math.min(UI.maxListHeight, tui.terminal.rows - 12)),
            complete,
            new Set(savedViews.favorites),
            new Set(savedViews.recent),
            managerState
          );
          let lastWidth = tui.terminal.columns;

          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          container.addChild(titleText);
          container.addChild(navText);
          container.addChild(statsText);
          container.addChild(new Spacer(1));
          container.addChild(browser);
          container.addChild(new Spacer(1));
          container.addChild(footerText);
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

          const syncThemedContent = (width = lastWidth): void => {
            lastWidth = width;
            titleText.setText(theme.fg("accent", theme.bold("Installed")));
            navText.setText(buildWorkspaceNavigation(theme, "installed"));
            statsText.setText(
              buildManagerSummary(items, staged, byId, theme, {
                visibleItems: browser.getVisibleItems(),
                filter: browser.getFilter(),
                searchQuery: browser.getSearchQuery(),
                selectedCount: browser.getBulkSelectedCount(),
              })
            );
            footerText.setText(
              theme.fg(
                "dim",
                buildFooterShortcuts(
                  buildFooterState(
                    staged,
                    byId,
                    browser.getSelectedItem(),
                    browser.getBulkSelectedCount()
                  ),
                  keybindings
                )
              )
            );
          };

          syncThemedContent();

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
              syncThemedContent(width);
              return container.render(width);
            },
            invalidate() {
              container.invalidate();
              browser.invalidate();
              syncThemedContent(lastWidth);
            },
            handleInput(data: string) {
              if (browser.handleManagerInput(data)) {
                tui.requestRender();
              }
            },
          };
        }),
      "Showing read-only local and installed package lists instead."
    );

    if (!result) {
      await showInteractiveFallback(ctx, pi);
      return true;
    }

    if (nextManagerState) {
      const lastView = managerStateToView(
        nextManagerState,
        "last-used",
        savedViews.lastView?.createdAt
      );
      const selectedItemId = nextManagerState.selectedItemId;
      const recent = selectedItemId
        ? [selectedItemId, ...savedViews.recent.filter((id) => id !== selectedItemId)].slice(0, 20)
        : savedViews.recent;
      savedViews = { ...savedViews, lastView, recent };
      await writeSavedViews(viewsPath, savedViews);
    }

    const outcome = await handleUnifiedAction(
      result,
      items,
      staged,
      byId,
      ctx,
      pi,
      savedViews,
      viewsPath,
      nextManagerState
    );
    if (outcome === "resume") {
      managerState = viewToManagerState(savedViews.lastView) ?? nextManagerState;
      continue;
    }

    return outcome;
  }
}

// Legacy redirect
export async function showInstalledPackagesLegacy(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  if (!hasCustomUI(ctx)) {
    await showInstalledPackagesList(ctx, pi);
    return;
  }

  ctx.ui.notify(
    "Use /extensions for the Installed workspace. Packages and local extensions are managed together there.",
    "info"
  );
  await showInteractive(ctx, pi);
}

// List-only view for non-interactive mode
export async function showListOnly(ctx: ExtensionCommandContext): Promise<void> {
  const entries = await discoverExtensions(ctx.cwd);
  if (entries.length === 0) {
    notify(ctx, "No extensions found in ~/.pi/agent/extensions or .pi/extensions", "info");
    return;
  }

  formatListOutput(ctx, "Local extensions", entries.map(formatExtEntry));
}
