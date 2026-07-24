/** Dedicated profile workspace for previewing and applying package sets. */
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { formatPlan, reviewAndApplyProfileWithOutcome } from "../profiles/execute.js";
import {
  buildProfileImportReview,
  deleteProfile,
  exportProfile,
  getProfile,
  listProfiles,
  prepareProfileImport,
  saveProfile,
} from "../profiles/management.js";
import { evaluateProfileReview, formatProfileReviewDetails } from "../profiles/review.js";
import { getCurrentProfile } from "../profiles/runtime-state.js";
import { type ExtmgrProfile } from "../profiles/schema.js";
import { activeKeyHint } from "../utils/key-hints.js";
import { requireCustomUI, runCustomUI } from "../utils/mode.js";
import { notify } from "../utils/notify.js";
import { confirmAction } from "../utils/ui-helpers.js";
import { showReport } from "./report.js";
import {
  buildWorkspaceNavigation,
  matchWorkspaceNavigation,
  type WorkspaceExit,
} from "./workspace/navigation.js";
import { setWorkspaceTitle } from "./workspace/title.js";

export {
  describeProfilePackageChanges,
  renderProfileDiffLines,
} from "./profile-review.js";

const SAVE_PROFILE = "__save_current__";
const IMPORT_PROFILE = "__import_profile__";
const BACK = "__back__";
const NAV_PREFIX = "__nav__:";

type ProfileSelection = string;

function profileDescription(profile: ExtmgrProfile): string {
  const global = profile.packages.filter((pkg) => pkg.scope === "global").length;
  const project = profile.packages.length - global;
  const checks =
    profile.checks?.compatibility || profile.checks?.provenance
      ? " · legacy checks (unverified)"
      : "";
  const origin = profile.importMetadata
    ? ` · imported ${profile.importMetadata.contentFingerprint?.slice(0, 15) ?? "source"}`
    : "";
  return `${profile.packages.length} package${profile.packages.length === 1 ? "" : "s"} · ${global} global · ${project} project${checks}${origin}`;
}

async function selectProfile(
  ctx: ExtensionCommandContext,
  profiles: ExtmgrProfile[]
): Promise<ProfileSelection | undefined> {
  return runCustomUI(ctx, "Profiles", () =>
    ctx.ui.custom<ProfileSelection>((tui, theme, keybindings, done) => {
      const items: SelectItem[] = profiles.map((profile) => ({
        value: profile.name,
        label: profile.name,
        description: profileDescription(profile),
      }));
      items.push(
        {
          value: SAVE_PROFILE,
          label: "Save current package set",
          description: "Capture installed packages, scopes, filters, and honest diagnostics",
        },
        {
          value: IMPORT_PROFILE,
          label: "Import profile",
          description: "Load a local or HTTPS JSON profile; save/review only, never auto-apply",
        },
        { value: BACK, label: "Back", description: "Return to the installed screen" }
      );

      const container = new Container();
      const title = new Text("", 2, 0);
      const nav = new Text("", 2, 0);
      const summary = new Text("", 2, 0);
      const footer = new Text("", 2, 0);
      const syncThemedContent = (): void => {
        title.setText(theme.fg("accent", theme.bold("Profiles")));
        nav.setText(buildWorkspaceNavigation(theme, "profiles"));
        summary.setText(
          theme.fg(
            "muted",
            `${profiles.length} saved profile${profiles.length === 1 ? "" : "s"} · choose a profile to preview or apply it`
          )
        );
        footer.setText(
          theme.fg(
            "dim",
            `${activeKeyHint(keybindings, "tui.select.up", "navigate")} · ${activeKeyHint(keybindings, "tui.select.confirm", "choose")} · ${activeKeyHint(keybindings, "tui.select.cancel", "back")}`
          )
        );
      };

      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(title);
      container.addChild(nav);
      container.addChild(summary);
      container.addChild(new Spacer(1));

      const list = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      list.onSelect = (item) => done(item.value as ProfileSelection);
      list.onCancel = () => done(BACK);
      container.addChild(list);
      container.addChild(new Spacer(1));
      container.addChild(footer);
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      syncThemedContent();

      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
          syncThemedContent();
        },
        handleInput(data: string) {
          const screen = matchWorkspaceNavigation(data, "profiles");
          if (screen) {
            if (screen !== "profiles") done(`${NAV_PREFIX}${screen}`);
            return;
          }
          list.handleInput(data);
          tui.requestRender();
        },
      };
    })
  );
}

async function runProfileAction(
  profile: ExtmgrProfile,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<{ reloaded: boolean }> {
  const selection = profile.name;
  const action = await ctx.ui.select(`Profile: ${selection}`, [
    "Review and apply",
    "Export profile",
    "Delete profile",
    "Back",
  ]);

  switch (action) {
    case "Review and apply": {
      const current = await getCurrentProfile(ctx, pi);
      const outcome = await reviewAndApplyProfileWithOutcome(current, profile, ctx, pi);
      return { reloaded: outcome.reloaded };
    }
    case "Export profile": {
      const path = await ctx.ui.input("Export profile", `${selection}.json`);
      if (!path?.trim()) return { reloaded: false };
      try {
        const destination = await exportProfile(profile, path, { cwd: ctx.cwd });
        notify(ctx, `Exported profile to ${destination}`, "info");
      } catch (error) {
        notify(
          ctx,
          `Profile export failed: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      }
      return { reloaded: false };
    }
    case "Delete profile":
      if (await ctx.ui.confirm("Delete profile", `Delete saved profile “${selection}”?`)) {
        try {
          if (await deleteProfile(selection)) notify(ctx, `Deleted profile ${selection}.`, "info");
          else notify(ctx, `Saved profile not found: ${selection}`, "warning");
        } catch (error) {
          notify(
            ctx,
            `Profile delete failed: ${error instanceof Error ? error.message : String(error)}`,
            "error"
          );
        }
      }
      return { reloaded: false };
    default:
      return { reloaded: false };
  }
}

export async function showProfiles(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<WorkspaceExit> {
  if (
    !requireCustomUI(ctx, "Profiles", "Use `/extensions profile <action>` outside the full TUI.")
  ) {
    return undefined;
  }

  while (true) {
    setWorkspaceTitle(ctx, "profiles");
    let profiles: ExtmgrProfile[];
    try {
      profiles = await listProfiles();
    } catch (error) {
      notify(
        ctx,
        `Profiles could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
      return undefined;
    }
    const selection = await selectProfile(ctx, profiles);
    if (!selection || selection === BACK) return undefined;
    if (selection.startsWith(NAV_PREFIX)) {
      return selection.slice(NAV_PREFIX.length) as Exclude<WorkspaceExit, undefined>;
    }

    if (selection === SAVE_PROFILE) {
      const name = await ctx.ui.input("Save current profile", "workstation");
      if (name?.trim()) {
        try {
          const normalizedName = name.trim();
          const existing = await getProfile(normalizedName);
          const replace = existing
            ? await ctx.ui.confirm("Replace saved profile", `Replace ${normalizedName}?`)
            : false;
          if (existing && !replace) {
            notify(ctx, `Saving profile ${normalizedName} cancelled.`, "info");
          } else {
            await saveProfile(await getCurrentProfile(ctx, pi), normalizedName, { replace });
            notify(ctx, `Saved profile ${normalizedName}.`, "info");
          }
        } catch (error) {
          notify(
            ctx,
            `Profile save failed: ${error instanceof Error ? error.message : String(error)}`,
            "error"
          );
        }
      }
      continue;
    }
    if (selection === IMPORT_PROFILE) {
      const source = await ctx.ui.input("Import profile source", "./profile.json");
      if (source?.trim()) {
        try {
          const prepared = await prepareProfileImport(source, {
            cwd: ctx.cwd,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          let imported = prepared.profile;
          let replace = false;
          const current = await getCurrentProfile(ctx, pi);
          const importReview = await evaluateProfileReview(current, imported, ctx, pi, {
            originWarnings: [...prepared.warnings, ...prepared.loaded.warnings],
          });
          const importDiagnostics = importReview.diagnostics;
          const importViolations = importReview.policyViolations;
          const review = buildProfileImportReview(prepared, current, {
            projectCwd: ctx.cwd,
            globalCwd: getAgentDir(),
            diagnostics: importDiagnostics,
            policyViolations: importViolations,
            review: importReview,
          });
          await showReport(ctx, {
            title: `Import profile: ${imported.name}`,
            placement: "center",
            level: review.level,
            lines: review.summaryLines,
          });
          const action = await ctx.ui.select("Import profile", [
            "Save",
            "Review changes",
            "Cancel",
          ]);
          if (action === "Cancel" || !action) continue;
          if (action === "Review changes") {
            await showReport(ctx, {
              title: `Planned changes: ${imported.name}`,
              placement: "center",
              lines: [
                ...formatPlan(review.plan).split("\n"),
                ...formatProfileReviewDetails(importReview),
              ],
            });
            if (
              !(await confirmAction(
                ctx,
                "Save imported profile",
                "Save this profile without applying it?"
              ))
            ) {
              continue;
            }
          }
          if (await getProfile(imported.name)) {
            const collision = await ctx.ui.select("Profile name collision", [
              "Overwrite",
              "Rename",
              "Cancel",
            ]);
            if (collision === "Overwrite") replace = true;
            else if (collision === "Rename") {
              const renamed = await ctx.ui.input("Imported profile name", imported.name);
              if (!renamed?.trim()) continue;
              imported = { ...imported, name: renamed.trim() };
            } else continue;
          }
          await saveProfile(imported, imported.name, { replace });
          notify(ctx, `Imported profile ${imported.name}. It was saved but not applied.`, "info");
        } catch (error) {
          notify(
            ctx,
            `Profile import failed: ${error instanceof Error ? error.message : String(error)}`,
            "error"
          );
        }
      }
      continue;
    }

    const profile = profiles.find((candidate) => candidate.name === selection);
    if (profile) {
      const outcome = await runProfileAction(profile, ctx, pi);
      if (outcome.reloaded) return "reloaded";
    }
  }
}
