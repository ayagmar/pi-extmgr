/** Shared workspace navigation header and keyboard handling. */
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { type WorkspaceScreen } from "../../types/index.js";

/**
 * How a workspace screen ended: navigate to another screen, "reloaded" when
 * pi was reloaded (callers must stop using pre-reload contexts), or undefined
 * when the user simply backed out.
 */
export type WorkspaceExit = WorkspaceScreen | "reloaded" | undefined;

export const WORKSPACE_SCREENS: ReadonlyArray<{
  id: WorkspaceScreen;
  label: string;
}> = [
  { id: "installed", label: "Installed" },
  { id: "discover", label: "Discover" },
  { id: "profiles", label: "Profiles" },
  { id: "health", label: "Health" },
];

export function buildWorkspaceNavigation(
  theme: { fg(color: string, text: string): string },
  active: WorkspaceScreen
): string {
  const screens = WORKSPACE_SCREENS.map(({ id, label }) =>
    id === active ? theme.fg("accent", `[${label}]`) : theme.fg("muted", label)
  ).join("  ");
  return `${theme.fg("dim", "Shift+Tab ‹")}  ${screens}  ${theme.fg("dim", "› Tab")}`;
}

function adjacentWorkspace(active: WorkspaceScreen, direction: -1 | 1): WorkspaceScreen {
  const index = WORKSPACE_SCREENS.findIndex(({ id }) => id === active);
  const next = (index + direction + WORKSPACE_SCREENS.length) % WORKSPACE_SCREENS.length;
  return WORKSPACE_SCREENS[next]?.id ?? "installed";
}

/**
 * Match portable workspace navigation keys. Tab and Shift+Tab are decoded by
 * pi-tui across legacy terminals, Kitty CSI-u input, tmux, and macOS terminals.
 */
export function matchWorkspaceNavigation(
  data: string,
  active: WorkspaceScreen
): WorkspaceScreen | undefined {
  if (isKeyRelease(data)) return undefined;
  // Check the modified form first so a permissive matcher cannot treat it as Tab.
  if (matchesKey(data, Key.shift("tab"))) return adjacentWorkspace(active, -1);
  if (matchesKey(data, Key.tab)) return adjacentWorkspace(active, 1);
  return undefined;
}
