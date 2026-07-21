import { type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { planProfileApplication } from "../profiles/apply.js";
import { type ProfilePolicyViolation } from "../profiles/compare.js";
import { type ExtmgrProfile, type ProfilePackage } from "../profiles/schema.js";
import { activeKeyHint } from "../utils/key-hints.js";
import { runCustomUI } from "../utils/mode.js";
import { composeColumns, TWO_PANE_MIN_WIDTH } from "./layout.js";

function describeProfilePackage(pkg: ProfilePackage): string {
  const details = [
    pkg.scope,
    pkg.version ? `@${pkg.version}` : undefined,
    pkg.ref ? `ref:${pkg.ref}` : undefined,
    pkg.filters !== undefined
      ? `filters:${pkg.filters.length} entrypoint${pkg.filters.length === 1 ? "" : "s"}`
      : undefined,
    pkg.manifestFingerprint || pkg.checksum
      ? `manifest:${(pkg.manifestFingerprint || pkg.checksum)?.slice(0, 10)}…`
      : undefined,
  ];
  return `${pkg.source} (${details.filter(Boolean).join(" · ")})`;
}

function describeFilters(filters: string[] | undefined): string {
  if (filters === undefined) return "default";
  return filters.length > 0 ? filters.join(", ") : "none";
}

/** Human-readable list of fields that differ between two profile packages. */
export function describeProfilePackageChanges(from: ProfilePackage, to: ProfilePackage): string[] {
  const changes: string[] = [];
  if (from.scope !== to.scope) changes.push(`scope ${from.scope} → ${to.scope}`);
  if (from.version !== to.version) {
    changes.push(`version ${from.version ?? "unknown"} → ${to.version ?? "unknown"}`);
  }
  if (from.ref !== to.ref) changes.push(`ref ${from.ref ?? "none"} → ${to.ref ?? "none"}`);
  if (JSON.stringify(from.filters) !== JSON.stringify(to.filters)) {
    changes.push(`filters ${describeFilters(from.filters)} → ${describeFilters(to.filters)}`);
  }
  const fromFingerprint = from.manifestFingerprint || from.checksum;
  const toFingerprint = to.manifestFingerprint || to.checksum;
  if (fromFingerprint !== toFingerprint) {
    changes.push(
      `manifest fingerprint ${fromFingerprint ? `${fromFingerprint.slice(0, 10)}…` : "unknown"} → ${toFingerprint ? `${toFingerprint.slice(0, 10)}…` : "unknown"}`
    );
  }
  return changes;
}

export interface ProfileDiffRenderContext {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Pure renderer for the inline current-vs-target profile diff. */
export function renderProfileDiffLines(
  current: ExtmgrProfile,
  desired: ExtmgrProfile,
  violations: ProfilePolicyViolation[],
  width: number,
  theme: ProfileDiffRenderContext,
  options: {
    canApply: boolean;
    cancelHint: string;
    identity?: { projectCwd?: string; globalCwd?: string };
  }
): string[] {
  const safeWidth = Math.max(1, width);
  const plan = planProfileApplication(current, desired, options.identity);
  const hasChanges = plan.add.length + plan.remove.length + plan.update.length > 0;
  const marker = (symbol: "+" | "-" | "~"): string =>
    theme.fg(symbol === "+" ? "success" : symbol === "-" ? "error" : "warning", symbol);

  const lines: string[] = [
    truncateToWidth(theme.fg("accent", theme.bold("Profile diff")), safeWidth, ""),
    truncateToWidth(
      theme.fg(
        "muted",
        `${plan.add.length} added · ${plan.remove.length} removed · ${plan.update.length} changed`
      ),
      safeWidth,
      ""
    ),
    "",
  ];

  const changeDetailLines = (from: ProfilePackage, to: ProfilePackage): string[] =>
    describeProfilePackageChanges(from, to).map((change) => theme.fg("muted", `    ${change}`));

  if (safeWidth >= TWO_PANE_MIN_WIDTH) {
    const left = [theme.fg("accent", theme.bold("Current"))];
    const right = [theme.fg("accent", theme.bold(`Target · ${desired.name}`))];
    for (const pkg of plan.remove) {
      left.push(`${marker("-")} ${describeProfilePackage(pkg)}`);
      right.push("");
    }
    for (const pkg of plan.add) {
      left.push("");
      right.push(`${marker("+")} ${describeProfilePackage(pkg)}`);
    }
    for (const change of plan.update) {
      left.push(`${marker("~")} ${describeProfilePackage(change.from)}`);
      right.push(`${marker("~")} ${describeProfilePackage(change.to)}`);
      for (const detail of changeDetailLines(change.from, change.to)) {
        left.push("");
        right.push(detail);
      }
    }
    if (!hasChanges) {
      left.push(theme.fg("success", "No package changes"));
      right.push(theme.fg("success", "Already matches current state"));
    }
    lines.push(...composeColumns(left, right, safeWidth, theme.fg("borderMuted", " │ ")));
  } else {
    const pushWrapped = (text: string): void => {
      for (const wrapped of wrapTextWithAnsi(text, safeWidth)) {
        lines.push(truncateToWidth(wrapped, safeWidth, ""));
      }
    };
    pushWrapped(theme.fg("accent", theme.bold(`Target · ${desired.name}`)));
    for (const pkg of plan.remove) pushWrapped(`${marker("-")} ${describeProfilePackage(pkg)}`);
    for (const pkg of plan.add) pushWrapped(`${marker("+")} ${describeProfilePackage(pkg)}`);
    for (const change of plan.update) {
      pushWrapped(`${marker("~")} ${change.to.source}`);
      for (const detail of changeDetailLines(change.from, change.to)) pushWrapped(detail);
    }
    if (!hasChanges) pushWrapped(theme.fg("success", "No package changes"));
  }

  if (violations.length > 0) {
    lines.push(
      "",
      truncateToWidth(theme.fg("error", theme.bold("Policy blocks application")), safeWidth, "")
    );
    for (const violation of violations) {
      for (const wrapped of wrapTextWithAnsi(`  • ${violation.message}`, safeWidth)) {
        lines.push(truncateToWidth(wrapped, safeWidth, ""));
      }
    }
  }

  const hints = [options.canApply ? "a apply" : undefined, options.cancelHint].filter(Boolean);
  lines.push("", truncateToWidth(theme.fg("dim", hints.join(" · ")), safeWidth, ""));
  return lines;
}

/** Render the mandatory interactive profile review gate. */
export async function showProfileDiff(
  current: ExtmgrProfile,
  desired: ExtmgrProfile,
  violations: ProfilePolicyViolation[],
  ctx: ExtensionCommandContext
): Promise<"apply" | "back" | undefined> {
  const plan = planProfileApplication(current, desired, {
    projectCwd: ctx.cwd,
    globalCwd: getAgentDir(),
  });
  const hasChanges = plan.add.length + plan.remove.length + plan.update.length > 0;
  const canApply = hasChanges && violations.length === 0;

  return runCustomUI(ctx, "Profile comparison", () =>
    ctx.ui.custom<"apply" | "back">((tui, theme, keybindings, done) => ({
      render(width: number) {
        return renderProfileDiffLines(current, desired, violations, width, theme, {
          canApply,
          cancelHint: activeKeyHint(keybindings, "tui.select.cancel", "back"),
          identity: { projectCwd: ctx.cwd, globalCwd: getAgentDir() },
        });
      },
      invalidate() {},
      handleInput(data: string) {
        if (data === "a" || data === "A") {
          if (canApply) done("apply");
          return;
        }
        if (keybindings.matches(data, "tui.select.cancel")) {
          done("back");
          return;
        }
        tui.requestRender();
      },
    }))
  );
}
