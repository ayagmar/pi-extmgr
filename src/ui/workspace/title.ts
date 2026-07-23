/**
 * Terminal title reflection while an extmgr workspace is open.
 *
 * Pi only re-asserts its own title on session events, so leaving the manager
 * must restore a title in pi's format (`π[ - session] - cwdBasename`) instead
 * of leaving the extmgr title behind.
 */
import { basename } from "node:path";
import {
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type AnyContext = ExtensionCommandContext | ExtensionContext;

const WORKSPACE_TITLE_LABELS = {
  installed: "Installed",
  discover: "Discover",
  profiles: "Profiles",
  health: "Health",
} as const;

export type WorkspaceTitleScreen = keyof typeof WORKSPACE_TITLE_LABELS;

function canSetTitle(ctx: AnyContext): boolean {
  return ctx.mode === "tui" && typeof ctx.ui?.setTitle === "function";
}

function piDefaultTitle(ctx: AnyContext): string {
  const sessionName = ctx.sessionManager?.getSessionName?.();
  const cwdBasename = basename(ctx.cwd);
  return sessionName ? `π - ${sessionName} - ${cwdBasename}` : `π - ${cwdBasename}`;
}

export function setWorkspaceTitle(ctx: AnyContext, screen: WorkspaceTitleScreen): void {
  if (!canSetTitle(ctx)) return;
  ctx.ui.setTitle(`π - extmgr ${WORKSPACE_TITLE_LABELS[screen]}`);
}

export function restorePiTitle(ctx: AnyContext): void {
  if (!canSetTitle(ctx)) return;
  ctx.ui.setTitle(piDefaultTitle(ctx));
}
