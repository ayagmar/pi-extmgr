/**
 * Routes between the auxiliary workspace screens (Profiles, Health).
 *
 * Installed and Discover own their own long-lived loops; this router only
 * bounces between the lightweight screens and reports which primary screen
 * the user asked for so the caller can resume or hand off its own loop.
 */
import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type WorkspaceScreen } from "../../types/index.js";
import { showHealth } from "../health.js";
import { showProfiles } from "../profiles.js";

export type AuxWorkspaceScreen = Extract<WorkspaceScreen, "profiles" | "health">;
export type PrimaryWorkspaceScreen = Exclude<WorkspaceScreen, AuxWorkspaceScreen>;

export interface AuxWorkspaceOutcome {
  /** Primary screen the user navigated to, if any. */
  navigate?: PrimaryWorkspaceScreen;
  /** True when pi was reloaded; callers must not reuse pre-reload contexts. */
  reloaded: boolean;
}

/**
 * Run the requested auxiliary screen until the user leaves. Bounces between
 * Profiles and Health during workspace cycling and reports the final outcome.
 */
export async function runAuxWorkspaceScreens(
  initial: AuxWorkspaceScreen,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<AuxWorkspaceOutcome> {
  let screen: AuxWorkspaceScreen = initial;
  while (true) {
    const exit = screen === "profiles" ? await showProfiles(ctx, pi) : await showHealth(ctx, pi);
    if (exit === undefined) return { reloaded: false };
    if (exit === "reloaded") return { reloaded: true };
    if (exit === "installed" || exit === "discover") return { navigate: exit, reloaded: false };
    screen = exit;
  }
}
