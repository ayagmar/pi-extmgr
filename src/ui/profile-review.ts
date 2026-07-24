import { type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { planProfileApplication } from "../profiles/apply.js";
import { type ProfilePolicyViolation } from "../profiles/compare.js";
import { type ProfileReview } from "../profiles/review.js";
import {
  type ExtmgrProfile,
  getEffectivePackageSource,
  inferPackageResolution,
  type ProfilePackage,
} from "../profiles/schema.js";
import { activeKeyHint } from "../utils/key-hints.js";
import { runCustomUI } from "../utils/mode.js";
import { composeColumns, TWO_PANE_MIN_WIDTH } from "./layout.js";

function effectiveResolution(pkg: ProfilePackage): string {
  return pkg.resolution ?? inferPackageResolution(pkg);
}

export function describeProfilePackage(pkg: ProfilePackage): string {
  const effectiveTarget = getEffectivePackageSource(pkg);
  const details = [
    `scope:${pkg.scope}`,
    `resolution:${effectiveResolution(pkg)}`,
    pkg.source !== effectiveTarget ? `source:${pkg.source}` : undefined,
    pkg.version ? `version:${pkg.version}` : undefined,
    pkg.ref ? `ref:${pkg.ref}` : undefined,
    `filters:${describeFilters(pkg.filters)}`,
    pkg.manifestFingerprint || pkg.checksum
      ? `manifest:${(pkg.manifestFingerprint || pkg.checksum)?.slice(0, 10)}…`
      : undefined,
  ];
  return `${effectiveTarget} (${details.filter(Boolean).join(" · ")})`;
}

function sortSettings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortSettings);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortSettings(entry)])
  );
}

function compactSetting(value: unknown): string {
  const encoded = JSON.stringify(sortSettings(value));
  if (encoded === undefined) return "undefined";
  return encoded.length > 56 ? `${encoded.slice(0, 53)}…` : encoded;
}

function describeFilters(filters: string[] | undefined): string {
  if (filters === undefined) return "default";
  return filters.length > 0 ? filters.join(", ") : "none";
}

function settingEntries(settings: Record<string, unknown> | undefined): string[] {
  return Object.keys(settings ?? {})
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${key}=${compactSetting(settings?.[key])}`);
}

/** Explicit settings details for additions and changes, including opaque Pi keys. */
export function describeProfilePackageSettings(
  pkg: ProfilePackage,
  marker: "+" | "-" = "+"
): string[] {
  const entries = settingEntries(pkg.packageSettings);
  return entries.length
    ? entries.map((entry) => `packageSettings ${marker}${entry}`)
    : pkg.packageSettings !== undefined
      ? [
          marker === "-"
            ? "packageSettings removed explicit {}"
            : "packageSettings explicitly set to {}",
        ]
      : [];
}

/** Human-readable list of fields that differ between two profile packages. */
export function describeProfilePackageChanges(from: ProfilePackage, to: ProfilePackage): string[] {
  const changes: string[] = [];
  if (from.scope !== to.scope) changes.push(`scope ${from.scope} → ${to.scope}`);
  const fromTarget = getEffectivePackageSource(from);
  const toTarget = getEffectivePackageSource(to);
  if (from.version !== to.version) {
    changes.push(
      `version ${from.version ?? "unknown"} → ${to.version ?? "unknown"} (effective target ${fromTarget} → ${toTarget}; resolution ${effectiveResolution(from)} → ${effectiveResolution(to)})`
    );
  } else if (fromTarget !== toTarget) {
    changes.push(
      `effective target ${fromTarget} → ${toTarget} (resolution ${effectiveResolution(from)} → ${effectiveResolution(to)})`
    );
  } else if (effectiveResolution(from) !== effectiveResolution(to)) {
    changes.push(`resolution ${effectiveResolution(from)} → ${effectiveResolution(to)}`);
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
  if (to.packageSettings !== undefined) {
    const fromSettings = from.packageSettings ?? {};
    const toSettings = to.packageSettings;
    const keys = [...new Set([...Object.keys(fromSettings), ...Object.keys(toSettings)])].sort(
      (a, b) => a.localeCompare(b)
    );
    if (keys.length === 0) changes.push("packageSettings explicitly set to {}");
    for (const key of keys) {
      const hasFrom = Object.hasOwn(fromSettings, key);
      const hasTo = Object.hasOwn(toSettings, key);
      if (!hasFrom && hasTo)
        changes.push(`packageSettings +${key}=${compactSetting(toSettings[key])}`);
      else if (hasFrom && !hasTo)
        changes.push(`packageSettings -${key}=${compactSetting(fromSettings[key])}`);
      else if (
        JSON.stringify(sortSettings(fromSettings[key])) !==
        JSON.stringify(sortSettings(toSettings[key]))
      ) {
        changes.push(
          `packageSettings ~${key}: ${compactSetting(fromSettings[key])} → ${compactSetting(toSettings[key])}`
        );
      } else {
        changes.push(`packageSettings retained ${key}=${compactSetting(toSettings[key])}`);
      }
    }
  } else if (from.packageSettings && Object.keys(from.packageSettings).length > 0) {
    changes.push(
      `packageSettings retained (unknown keys preserved): ${settingEntries(from.packageSettings).join(", ")}`
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
    review?: ProfileReview;
  }
): string[] {
  const safeWidth = Math.max(1, width);
  const plan = options.review?.plan ?? planProfileApplication(current, desired, options.identity);
  const hasChanges =
    options.review?.hasChanges ?? plan.add.length + plan.remove.length + plan.update.length > 0;
  const effectiveViolations = options.review?.policyViolations ?? violations;
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
  const addDetailLines = (pkg: ProfilePackage): string[] =>
    describeProfilePackageSettings(pkg).map((detail) => theme.fg("muted", `    ${detail}`));
  const removeDetailLines = (pkg: ProfilePackage): string[] =>
    describeProfilePackageSettings(pkg, "-").map((detail) => theme.fg("muted", `    ${detail}`));

  if (safeWidth >= TWO_PANE_MIN_WIDTH) {
    const left = [theme.fg("accent", theme.bold("Current"))];
    const right = [theme.fg("accent", theme.bold(`Target · ${desired.name}`))];
    for (const pkg of plan.remove) {
      left.push(`${marker("-")} ${describeProfilePackage(pkg)}`);
      right.push("");
      for (const detail of removeDetailLines(pkg)) {
        left.push(detail);
        right.push("");
      }
    }
    for (const pkg of plan.add) {
      left.push("");
      right.push(`${marker("+")} ${describeProfilePackage(pkg)}`);
      right.push(...addDetailLines(pkg));
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
      for (const wrapped of wrapTextWithAnsi(text, safeWidth))
        lines.push(truncateToWidth(wrapped, safeWidth, ""));
    };
    pushWrapped(theme.fg("accent", theme.bold(`Target · ${desired.name}`)));
    for (const pkg of plan.remove) {
      pushWrapped(`${marker("-")} ${describeProfilePackage(pkg)}`);
      for (const detail of removeDetailLines(pkg)) pushWrapped(detail);
    }
    for (const pkg of plan.add) {
      pushWrapped(`${marker("+")} ${describeProfilePackage(pkg)}`);
      for (const detail of addDetailLines(pkg)) pushWrapped(detail);
    }
    for (const change of plan.update) {
      pushWrapped(`${marker("~")} ${describeProfilePackage(change.to)}`);
      for (const detail of changeDetailLines(change.from, change.to)) pushWrapped(detail);
    }
    if (!hasChanges) pushWrapped(theme.fg("success", "No package changes"));
  }

  if (effectiveViolations.length > 0 || (options.review?.confirmedFailures.length ?? 0) > 0) {
    const heading =
      effectiveViolations.length > 0 ? "Policy blocks application" : "Application blocked";
    lines.push("", truncateToWidth(theme.fg("error", theme.bold(heading)), safeWidth, ""));
    for (const violation of effectiveViolations) {
      for (const wrapped of wrapTextWithAnsi(`  • ${violation.message}`, safeWidth))
        lines.push(truncateToWidth(wrapped, safeWidth, ""));
    }
    for (const failure of options.review?.confirmedFailures ?? []) {
      for (const wrapped of wrapTextWithAnsi(
        `  • confirmed diagnostic failure: ${failure.source} (${failure.scope})`,
        safeWidth
      ))
        lines.push(truncateToWidth(wrapped, safeWidth, ""));
    }
  }

  const review = options.review;
  if (review && review.diagnostics.length > 0) {
    const unknownLines = review.diagnostics.flatMap((diagnostic) => [
      ...(diagnostic.compatibility === "unknown"
        ? [`  • ${diagnostic.source} (${diagnostic.scope}): compatibility unknown`]
        : []),
      ...(diagnostic.integrity === "unknown"
        ? [`  • ${diagnostic.source} (${diagnostic.scope}): integrity unknown`]
        : []),
    ]);
    if (unknownLines.length > 0) {
      lines.push(
        "",
        truncateToWidth(theme.fg("warning", theme.bold("Informational diagnostics")), safeWidth, "")
      );
      for (const line of unknownLines) {
        for (const wrapped of wrapTextWithAnsi(line, safeWidth))
          lines.push(truncateToWidth(wrapped, safeWidth, ""));
      }
    }
  }
  if (review && review.originWarnings.length > 0) {
    lines.push(
      "",
      truncateToWidth(theme.fg("warning", theme.bold("Origin warnings")), safeWidth, "")
    );
    for (const warning of review.originWarnings) {
      for (const wrapped of wrapTextWithAnsi(`  • ${warning}`, safeWidth))
        lines.push(truncateToWidth(wrapped, safeWidth, ""));
    }
  }
  if (review && review.blockingReasons.length > 0) {
    lines.push(
      "",
      truncateToWidth(theme.fg("error", theme.bold("Blocking reasons")), safeWidth, "")
    );
    for (const reason of review.blockingReasons) {
      for (const wrapped of wrapTextWithAnsi(`  • ${reason}`, safeWidth))
        lines.push(truncateToWidth(wrapped, safeWidth, ""));
    }
  }
  const canApply = options.review?.canApply ?? options.canApply;
  const hints = [canApply ? "a apply" : undefined, options.cancelHint].filter(Boolean);
  lines.push("", truncateToWidth(theme.fg("dim", hints.join(" · ")), safeWidth, ""));
  return lines;
}

/** Render the mandatory interactive profile review gate. */
export async function showProfileDiff(
  current: ExtmgrProfile,
  desired: ExtmgrProfile,
  review: ProfileReview,
  ctx: ExtensionCommandContext
): Promise<"apply" | "back" | undefined> {
  return runCustomUI(ctx, "Profile comparison", () =>
    ctx.ui.custom<"apply" | "back">((tui, theme, keybindings, done) => ({
      render(width: number) {
        return renderProfileDiffLines(current, desired, review.policyViolations, width, theme, {
          canApply: review.canApply,
          cancelHint: activeKeyHint(keybindings, "tui.select.cancel", "back"),
          identity: { projectCwd: ctx.cwd, globalCwd: getAgentDir() },
          review,
        });
      },
      invalidate() {},
      handleInput(data: string) {
        if (data === "a" || data === "A") {
          if (review.canApply) done("apply");
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
