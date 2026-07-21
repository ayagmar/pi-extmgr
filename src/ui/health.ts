/** Operational health screen: compatibility, conflicts, reload state, and trash. */
import { join } from "node:path";
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { handleTrashSubcommand } from "../commands/trash.js";
import { inspectInstalledPackageCompatibility } from "../doctor/compatibility.js";
import { findRuntimeConflicts, type RuntimeConflict } from "../doctor/conflicts.js";
import { getRuntimeOwners, type RuntimeOwner } from "../doctor/runtime.js";
import { discoverExtensions, setExtensionState } from "../extensions/discovery.js";
import { listExtensionTrash, type TrashRecord } from "../extensions/trash.js";
import { getInstalledPackagesAllScopes } from "../packages/discovery.js";
import { removePackageWithOutcome } from "../packages/management.js";
import { movePackageBetweenScopes } from "../packages/scopes.js";
import { type InstalledPackage } from "../types/index.js";
import { isProjectTrusted, requireCustomUI, runCustomUI } from "../utils/mode.js";
import { notify } from "../utils/notify.js";
import { normalizePackageIdentity } from "../utils/package-source.js";
import { normalizePathIdentity } from "../utils/path-identity.js";
import {
  clearReloadRequired,
  type ReloadRequiredState,
  readReloadState,
} from "../utils/reload-state.js";
import { confirmReload, markContextReloaded } from "../utils/ui-helpers.js";
import { getStatusIcon } from "./theme.js";
import {
  buildWorkspaceNavigation,
  matchWorkspaceNavigation,
  type WorkspaceExit,
} from "./workspace/navigation.js";

function getTrashRoot(): string {
  return join(getAgentDir(), ".extmgr-trash");
}

type HealthAction =
  | { type: "refresh" }
  | { type: "trash" }
  | { type: "reload" }
  | { type: "conflict" }
  | { type: "fix-safe" }
  | { type: "back" }
  | { type: "workspace"; screen: "installed" | "discover" | "profiles" };

type LocalExtensionEntry = Awaited<ReturnType<typeof discoverExtensions>>[number];

interface HealthSnapshot {
  owners: number;
  conflicts: RuntimeConflict[];
  compatibility: Awaited<ReturnType<typeof inspectInstalledPackageCompatibility>>;
  reload: ReloadRequiredState;
  trash: TrashRecord[];
}

async function loadHealthSnapshot(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<HealthSnapshot> {
  const packages = await getInstalledPackagesAllScopes(ctx);
  const owners = getRuntimeOwners(pi);
  return {
    owners: owners.length,
    conflicts: findRuntimeConflicts(owners),
    compatibility: await inspectInstalledPackageCompatibility(packages),
    reload: await readReloadState(),
    trash: await listExtensionTrash(getTrashRoot()),
  };
}

function ownerMatchesPackage(owner: RuntimeOwner, pkg: InstalledPackage): boolean {
  // Direct string forms Pi uses for package-owned commands/tools.
  if (owner.source === pkg.source || owner.source === pkg.name) return true;
  if (owner.path === pkg.source) return true;

  // Normalized identity comparison covers version-suffixed and case variants.
  const pkgIdentity = normalizePackageIdentity(
    pkg.source,
    pkg.resolvedPath ? { resolvedPath: pkg.resolvedPath } : undefined
  );
  if (normalizePackageIdentity(owner.source) === pkgIdentity) return true;

  // Path containment: the owner entrypoint lives inside the package install dir.
  if (pkg.resolvedPath && owner.path) {
    const ownerPath = normalizePathIdentity(owner.path);
    const packageRoot = normalizePathIdentity(pkg.resolvedPath);
    if (ownerPath === packageRoot || ownerPath.startsWith(`${packageRoot}/`)) return true;
  }

  return false;
}

function ownerMatchesLocalExtension(owner: RuntimeOwner, entry: LocalExtensionEntry): boolean {
  const candidates = [entry.activePath, entry.disabledPath].map(normalizePathIdentity);
  const ownerPath = owner.path ? normalizePathIdentity(owner.path) : "";
  const ownerSource = owner.source ? normalizePathIdentity(owner.source) : "";
  return candidates.some((candidate) => candidate === ownerPath || candidate === ownerSource);
}

/** Installed packages that own at least one side of the conflict. */
export function findConflictPackageOwners(
  conflict: RuntimeConflict,
  packages: InstalledPackage[]
): InstalledPackage[] {
  return packages.filter((pkg) => conflict.owners.some((owner) => ownerMatchesPackage(owner, pkg)));
}

/** Local extensions that own at least one side of the conflict. */
export function findConflictLocalOwners(
  conflict: RuntimeConflict,
  localEntries: LocalExtensionEntry[]
): LocalExtensionEntry[] {
  return localEntries.filter((entry) =>
    conflict.owners.some((owner) => ownerMatchesLocalExtension(owner, entry))
  );
}

export interface SafeConflictFix {
  conflict: string;
  extension: LocalExtensionEntry;
}

/**
 * Deterministic, reversible fixes only: disable enabled local extensions that
 * shadow a package-provided command or tool. Never removes packages.
 */
export function planSafeConflictFixes(
  conflicts: RuntimeConflict[],
  localEntries: LocalExtensionEntry[]
): SafeConflictFix[] {
  const fixes: SafeConflictFix[] = [];
  const seenPaths = new Set<string>();

  for (const conflict of conflicts) {
    const hasPackageOwner = conflict.owners.some((owner) => owner.origin === "package");
    if (!hasPackageOwner) continue;

    for (const entry of findConflictLocalOwners(conflict, localEntries)) {
      if (entry.state !== "enabled") continue;
      const key = normalizePathIdentity(entry.activePath);
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      fixes.push({ conflict: `${conflict.kind} ${conflict.name}`, extension: entry });
    }
  }

  return fixes;
}

function renderHealthLines(snapshot: HealthSnapshot, width: number, theme: Theme): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  const incompatible = snapshot.compatibility.filter(
    (diagnostic) => diagnostic.node === "incompatible" || diagnostic.pi === "incompatible"
  );
  const healthOk =
    snapshot.conflicts.length === 0 && incompatible.length === 0 && !snapshot.reload.required;

  lines.push(
    truncateToWidth(buildWorkspaceNavigation(theme, "health"), safeWidth, ""),
    "",
    truncateToWidth(
      `${getStatusIcon(theme, healthOk ? "success" : "warning")} ${theme.bold("Health")}`,
      safeWidth,
      ""
    ),
    truncateToWidth(
      theme.fg(
        "muted",
        healthOk ? "Runtime looks healthy." : "Review the findings below before continuing."
      ),
      safeWidth,
      ""
    ),
    ""
  );

  lines.push(truncateToWidth(theme.fg("accent", theme.bold("Runtime")), safeWidth, ""));
  lines.push(truncateToWidth(`  ${snapshot.owners} command/tool entries loaded`, safeWidth, ""));
  lines.push(
    truncateToWidth(
      `  ${snapshot.conflicts.length === 0 ? theme.fg("success", "No conflicts detected") : theme.fg("warning", `${snapshot.conflicts.length} conflict${snapshot.conflicts.length === 1 ? "" : "s"} detected`)}`,
      safeWidth,
      ""
    )
  );
  for (const conflict of snapshot.conflicts.slice(0, 5)) {
    lines.push(
      truncateToWidth(
        `  • ${conflict.kind} ${conflict.name} · ${conflict.owners.map((owner) => owner.source).join(", ")}`,
        safeWidth,
        ""
      )
    );
  }
  if (snapshot.conflicts.length > 5) {
    lines.push(truncateToWidth(`  … and ${snapshot.conflicts.length - 5} more`, safeWidth, ""));
  }

  lines.push("", truncateToWidth(theme.fg("accent", theme.bold("Compatibility")), safeWidth, ""));
  if (snapshot.compatibility.length === 0) {
    lines.push(truncateToWidth(theme.fg("dim", "  No installed packages"), safeWidth, ""));
  } else {
    for (const diagnostic of snapshot.compatibility.slice(0, 8)) {
      const status =
        diagnostic.node === "incompatible" || diagnostic.pi === "incompatible"
          ? theme.fg("error", "incompatible")
          : diagnostic.node === "unknown" || diagnostic.pi === "unknown"
            ? theme.fg("muted", "unknown")
            : theme.fg("success", "compatible");
      lines.push(
        truncateToWidth(`  ${status} · ${diagnostic.source} (${diagnostic.scope})`, safeWidth, "")
      );
      for (const reason of diagnostic.reasons) {
        lines.push(truncateToWidth(`    ${reason}`, safeWidth, ""));
      }
    }
    if (snapshot.compatibility.length > 8) {
      lines.push(
        truncateToWidth(`  … and ${snapshot.compatibility.length - 8} more`, safeWidth, "")
      );
    }
  }

  lines.push("", truncateToWidth(theme.fg("accent", theme.bold("Reload")), safeWidth, ""));
  if (snapshot.reload.required) {
    lines.push(truncateToWidth(theme.fg("warning", "  Reload required"), safeWidth, ""));
    for (const reason of snapshot.reload.reasons) {
      lines.push(truncateToWidth(`  • ${reason}`, safeWidth, ""));
    }
  } else {
    lines.push(
      truncateToWidth(theme.fg("success", "  Pi is up to date with extmgr changes"), safeWidth, "")
    );
  }

  lines.push("", truncateToWidth(theme.fg("accent", theme.bold("Trash")), safeWidth, ""));
  if (snapshot.trash.length === 0) {
    lines.push(
      truncateToWidth(theme.fg("dim", "  No recoverable local extensions"), safeWidth, "")
    );
  } else {
    lines.push(
      truncateToWidth(
        `  ${snapshot.trash.length} recoverable extension${snapshot.trash.length === 1 ? "" : "s"}`,
        safeWidth,
        ""
      )
    );
    for (const record of snapshot.trash.slice(0, 5)) {
      for (const line of wrapTextWithAnsi(`• ${record.originalPath}`, Math.max(1, safeWidth - 2))) {
        lines.push(truncateToWidth(`  ${line}`, safeWidth, ""));
      }
    }
  }

  lines.push(
    "",
    truncateToWidth(
      theme.fg(
        "dim",
        "c conflict actions · f fix safe issues · r refresh · l reload · t trash actions · Esc back"
      ),
      safeWidth,
      ""
    )
  );
  return lines;
}

async function showHealthPanel(
  snapshot: HealthSnapshot,
  ctx: ExtensionCommandContext
): Promise<HealthAction | undefined> {
  return runCustomUI(ctx, "Health", () =>
    ctx.ui.custom<HealthAction>((tui, theme, keybindings, done) => {
      const border = new DynamicBorder((s: string) => theme.fg("accent", s));
      let focused = false;
      const component = {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
        },
        render(width: number) {
          return [
            ...border.render(width),
            ...renderHealthLines(snapshot, width, theme),
            ...border.render(width),
          ];
        },
        invalidate() {
          border.invalidate();
        },
        handleInput(data: string) {
          const screen = matchWorkspaceNavigation(data, "health");
          if (screen) {
            if (screen !== "health") done({ type: "workspace", screen });
            return;
          }
          if (data === "r" || data === "R") {
            done({ type: "refresh" });
            return;
          }
          if (data === "c" || data === "C") {
            done({ type: "conflict" });
            return;
          }
          if (data === "f" || data === "F") {
            done({ type: "fix-safe" });
            return;
          }
          if (data === "l" || data === "L") {
            done({ type: "reload" });
            return;
          }
          if (data === "t" || data === "T") {
            done({ type: "trash" });
            return;
          }
          if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
            done({ type: "back" });
            return;
          }
          tui.requestRender();
        },
      };
      return component;
    })
  );
}

async function handleFixSafeIssues(
  snapshot: HealthSnapshot,
  ctx: ExtensionCommandContext
): Promise<boolean> {
  const localEntries = await discoverExtensions(ctx.cwd);
  const fixes = planSafeConflictFixes(snapshot.conflicts, localEntries);
  if (fixes.length === 0) {
    notify(
      ctx,
      "No safe automatic fixes are available. Packages are never removed automatically; use conflict actions for manual remediation.",
      "info"
    );
    return false;
  }

  const summary = fixes
    .map((fix) => `- Disable local ${fix.extension.displayName} (${fix.conflict})`)
    .join("\n");
  const confirmed = await ctx.ui.confirm(
    "Fix all safe issues",
    `The following deterministic, reversible fixes will run:\n\n${summary}\n\nPackages are never removed automatically. Continue?`
  );
  if (!confirmed) return false;

  const errors: string[] = [];
  let changed = 0;
  for (const fix of fixes) {
    const result = await setExtensionState(
      { activePath: fix.extension.activePath, disabledPath: fix.extension.disabledPath },
      "disabled"
    );
    if (result.ok) changed += 1;
    else errors.push(`${fix.extension.displayName}: ${result.error}`);
  }

  if (errors.length > 0) {
    notify(
      ctx,
      `Applied ${changed} fix(es), ${errors.length} failed:\n${errors.join("\n")}`,
      "warning"
    );
  } else {
    notify(ctx, `Disabled ${changed} conflicting local extension(s).`, "info");
  }
  if (changed === 0) return false;
  return confirmReload(ctx, "Conflicting local extensions disabled.");
}

async function handleConflictAction(
  snapshot: HealthSnapshot,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<boolean> {
  let reloaded = false;
  if (snapshot.conflicts.length === 0) {
    notify(ctx, "No runtime conflicts need remediation.", "info");
    return reloaded;
  }

  const conflictChoice = await ctx.ui.select(
    "Select a conflict",
    snapshot.conflicts.map((conflict) => `${conflict.kind} ${conflict.name}`)
  );
  const conflict = snapshot.conflicts.find(
    (candidate) => `${candidate.kind} ${candidate.name}` === conflictChoice
  );
  if (!conflict) return reloaded;

  const packages = await getInstalledPackagesAllScopes(ctx);
  const packageCandidates = findConflictPackageOwners(conflict, packages);
  const localEntries = await discoverExtensions(ctx.cwd);
  const localCandidates = findConflictLocalOwners(conflict, localEntries);

  const actions = new Map<string, () => Promise<void>>();
  actions.set("Inspect owners", async () => {
    notify(
      ctx,
      conflict.owners
        .map(
          (owner) =>
            `${owner.kind} ${owner.name}\n  ${owner.source} (${owner.scope})\n  ${owner.path}`
        )
        .join("\n"),
      "info"
    );
  });
  for (const pkg of packageCandidates) {
    actions.set(`Remove package ${pkg.name} (${pkg.scope})`, async () => {
      if (
        await ctx.ui.confirm(
          "Remove conflicting package",
          `Remove ${pkg.source} from ${pkg.scope}?`
        )
      ) {
        const outcome = await removePackageWithOutcome(pkg.source, ctx, pi);
        reloaded ||= outcome.reloaded;
      }
    });
    const targetScope = pkg.scope === "global" ? "project" : "global";
    actions.set(`Move ${pkg.name} to ${targetScope}`, async () => {
      if (
        !(await ctx.ui.confirm(
          "Move conflicting package",
          `Move ${pkg.source} from ${pkg.scope} to ${targetScope}?`
        ))
      ) {
        return;
      }
      const result = await movePackageBetweenScopes(
        pkg.source,
        pkg.scope,
        targetScope,
        ctx.cwd,
        isProjectTrusted(ctx)
      );
      if (!result.moved) notify(ctx, result.conflict ?? "Package scope move failed.", "error");
      else reloaded = await confirmReload(ctx, "Package conflict scope changed.");
    });
  }
  for (const entry of localCandidates) {
    actions.set(`Disable local ${entry.displayName}`, async () => {
      if (
        await ctx.ui.confirm(
          "Disable conflicting extension",
          `Disable ${entry.displayName}? This changes its local extension state.`
        )
      ) {
        const result = await setExtensionState(
          { activePath: entry.activePath, disabledPath: entry.disabledPath },
          "disabled"
        );
        if (!result.ok) notify(ctx, result.error, "error");
        else reloaded = await confirmReload(ctx, "Conflicting local extension disabled.");
      }
    });
  }

  const choice = await ctx.ui.select("Conflict remediation", [...actions.keys(), "Back"]);
  const action = choice ? actions.get(choice) : undefined;
  if (action) await action();
  return reloaded;
}

export async function showHealth(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<WorkspaceExit> {
  if (
    !requireCustomUI(
      ctx,
      "Health",
      "Use `/extensions doctor` and `/extensions trash` outside the full TUI."
    )
  ) {
    return undefined;
  }

  while (true) {
    let snapshot: HealthSnapshot;
    try {
      snapshot = await loadHealthSnapshot(ctx, pi);
    } catch (error) {
      notify(
        ctx,
        `Health check failed: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
      return undefined;
    }

    const action = await showHealthPanel(snapshot, ctx);
    if (!action || action.type === "back") return undefined;
    if (action.type === "workspace") return action.screen;
    if (action.type === "refresh") continue;
    if (action.type === "reload") {
      await ctx.reload();
      markContextReloaded(ctx);
      await clearReloadRequired();
      return "reloaded";
    }
    if (action.type === "fix-safe") {
      if (await handleFixSafeIssues(snapshot, ctx)) return "reloaded";
      continue;
    }
    if (action.type === "conflict") {
      if (await handleConflictAction(snapshot, ctx, pi)) return "reloaded";
      continue;
    }

    await handleTrashSubcommand(["list"], ctx, pi);
    if (snapshot.trash.length > 0) {
      const choice = await ctx.ui.select("Trash actions", [
        "Restore an extension",
        "Purge an extension",
        "Back",
      ]);
      if (choice === "Restore an extension") await handleTrashSubcommand(["restore"], ctx, pi);
      if (choice === "Purge an extension") await handleTrashSubcommand(["purge"], ctx, pi);
    }
  }
}
