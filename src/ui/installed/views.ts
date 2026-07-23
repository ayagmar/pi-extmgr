/** Saved manager views and favorites for the Installed workspace. */
import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { notify } from "../../utils/notify.js";
import { type readSavedViews, writeSavedViews } from "../../utils/views.js";
import { managerStateToView, type UnifiedManagerViewState } from "./state.js";

export type SavedViewsState = Awaited<ReturnType<typeof readSavedViews>>;

export type ViewsAction = "save" | "load" | "delete" | "favorite";

/** Handle a saved-views action. Always resumes the manager afterwards. */
export async function handleViewsAction(
  action: ViewsAction,
  itemId: string | undefined,
  savedViews: SavedViewsState,
  viewsPath: string,
  ctx: ExtensionCommandContext,
  currentViewState?: UnifiedManagerViewState
): Promise<"resume"> {
  if (action === "favorite") {
    if (!itemId) return "resume";
    const favorites = new Set(savedViews.favorites);
    if (favorites.has(itemId)) {
      favorites.delete(itemId);
      notify(ctx, "Removed from favorites.", "info");
    } else {
      favorites.add(itemId);
      notify(ctx, "Added to favorites.", "info");
    }
    savedViews.favorites = [...favorites];
    await writeSavedViews(viewsPath, savedViews);
    return "resume";
  }

  if (action === "save") {
    if (!currentViewState) return "resume";
    const name = (await ctx.ui.input("Save manager view", "name"))?.trim();
    if (!name) return "resume";
    const existing = savedViews.views.find((view) => view.name === name);
    if (existing && !(await ctx.ui.confirm("Overwrite view", `Replace saved view “${name}”?`))) {
      return "resume";
    }
    const now = Date.now();
    const saved = managerStateToView(currentViewState, name, existing?.createdAt ?? now);
    savedViews.views = existing
      ? savedViews.views.map((view) => (view.name === name ? saved : view))
      : [...savedViews.views, saved];
    await writeSavedViews(viewsPath, savedViews);
    notify(ctx, `Saved view “${name}”.`, "info");
    return "resume";
  }

  if (action === "load") {
    if (savedViews.views.length === 0) {
      notify(ctx, "No saved views yet. Press W to save the current view.", "info");
      return "resume";
    }
    const choice = await ctx.ui.select(
      "Load manager view",
      savedViews.views.map((view) => view.name)
    );
    const selected = savedViews.views.find((view) => view.name === choice);
    if (selected) {
      savedViews.lastView = selected;
      await writeSavedViews(viewsPath, savedViews);
      notify(ctx, `Loaded view “${selected.name}”.`, "info");
    }
    return "resume";
  }

  if (savedViews.views.length === 0) {
    notify(ctx, "No saved views to delete.", "info");
    return "resume";
  }
  const choice = await ctx.ui.select(
    "Delete manager view",
    savedViews.views.map((view) => view.name)
  );
  if (choice && (await ctx.ui.confirm("Delete view", `Delete saved view “${choice}”?`))) {
    savedViews.views = savedViews.views.filter((view) => view.name !== choice);
    await writeSavedViews(viewsPath, savedViews);
    notify(ctx, `Deleted view “${choice}”.`, "info");
  }
  return "resume";
}
