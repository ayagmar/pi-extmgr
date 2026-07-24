/**
 * /extensions profile command handlers: save/list/delete/export, import,
 * check, dry-run/compare, apply, and restore-point recovery.
 *
 * The application engine lives in ../profiles/execute.ts and runtime-state
 * capture/diagnostics in ../profiles/runtime-state.ts.
 */
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { formatPlan, reviewAndApplyProfileWithOutcome } from "../profiles/execute.js";
import {
  buildProfileImportReview,
  deleteProfile,
  duplicateProfile,
  exportProfile,
  getProfile,
  listProfiles,
  type PreparedProfileImport,
  prepareProfileImport,
  renameProfile,
  saveProfile,
} from "../profiles/management.js";
import { evaluateProfileReview, formatProfileReviewDetails } from "../profiles/review.js";
import { getCurrentProfile } from "../profiles/runtime-state.js";
import {
  type ExtmgrProfile,
  type ProfilePackage,
  parseExternalProfile,
} from "../profiles/schema.js";
import { loadProfileSource } from "../profiles/source.js";
import { readProfileRestorePoints } from "../profiles/store.js";
import { showListReport, showReport } from "../ui/report.js";
import { notify } from "../utils/notify.js";
import { confirmAction } from "../utils/ui-helpers.js";

export const PROFILE_USAGE =
  "Usage: /extensions profile <export|save|list|delete|rename|duplicate|dry-run|apply|compare|import|check|recover> [name|source] [destination] [--json|--strict|--force|--name <name>]";

interface ResolvedProfile {
  profile: ExtmgrProfile;
  originWarnings: string[];
}

async function resolveNamedOrSourceProfile(
  requested: string | undefined,
  ctx: ExtensionCommandContext
): Promise<ResolvedProfile | undefined> {
  if (requested) {
    const named = await getProfile(requested);
    if (named) return { profile: named, originWarnings: [] };
    const loaded = await loadProfileSource(requested, {
      cwd: ctx.cwd,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const parsed = parseExternalProfile(loaded.value);
    if (!parsed.ok)
      throw new Error(parsed.errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    return { profile: parsed.profile, originWarnings: loaded.warnings };
  }
  if (!ctx.hasUI) return undefined;
  const profiles = await listProfiles();
  const names = profiles.map((profile) => profile.name);
  if (names.length === 0) return undefined;
  const choice = await ctx.ui.select("Select saved profile", names);
  const profile = choice ? profiles.find((candidate) => candidate.name === choice) : undefined;
  return profile ? { profile, originWarnings: [] } : undefined;
}

interface ParsedOptions {
  positionals: string[];
  json: boolean;
  strict: boolean;
  force: boolean;
  name?: string;
}

function parseOptions(tokens: string[]): ParsedOptions {
  const positionals: string[] = [];
  let json = false;
  let strict = false;
  let force = false;
  let name: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--json") json = true;
    else if (token === "--strict") strict = true;
    else if (token === "--force") force = true;
    else if (token === "--name") {
      const value = tokens[index + 1];
      if (!value) throw new Error("--name requires a value.");
      name = value;
      index += 1;
    } else if (token?.startsWith("--")) throw new Error(`Unknown option: ${token}`);
    else if (token) positionals.push(token);
  }
  return { positionals, json, strict, force, ...(name ? { name } : {}) };
}

async function saveImportedProfile(
  prepared: PreparedProfileImport,
  options: ParsedOptions,
  ctx: ExtensionCommandContext
): Promise<void> {
  let imported = prepared.profile;
  const existing = await getProfile(imported.name);
  let replace = options.force;
  if (existing && !replace) {
    if (!ctx.hasUI)
      throw new Error(
        `A saved profile named ${imported.name} already exists; pass --force to replace it.`
      );
    const choice = await ctx.ui.select("Profile name collision", ["Overwrite", "Rename", "Cancel"]);
    if (choice === "Overwrite") replace = true;
    else if (choice === "Rename") {
      const renamed = await ctx.ui.input("Imported profile name", imported.name);
      if (!renamed?.trim()) return;
      imported = { ...imported, name: renamed.trim() };
    } else return;
  }
  await saveProfile(imported, imported.name, { replace });
  notify(ctx, `Imported profile ${imported.name}. It was saved but not applied.`, "info");
}

async function handleImport(
  tokens: string[],
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<void> {
  const options = parseOptions(tokens);
  const source = options.positionals[0];
  if (!source)
    throw new Error(
      "Usage: /extensions profile import <local-path|https-url> [--name <name>] [--force]"
    );
  const prepared = await prepareProfileImport(source, {
    cwd: ctx.cwd,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(options.name ? { name: options.name } : {}),
  });
  const { profile } = prepared;
  const current = await getCurrentProfile(ctx, pi);
  const importReview = await evaluateProfileReview(current, profile, ctx, pi, {
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
    title: `Import profile: ${profile.name}`,
    placement: "center",
    level: review.level,
    lines: review.summaryLines,
  });
  if (ctx.hasUI) {
    const action = await ctx.ui.select("Import profile", ["Save", "Review changes", "Cancel"]);
    if (action === "Cancel" || !action) return;
    if (action === "Review changes") {
      await showReport(ctx, {
        title: `Planned changes: ${profile.name}`,
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
      )
        return;
    }
  }
  await saveImportedProfile(prepared, options, ctx);
}

export interface ProfileCheckResult {
  ok: boolean;
  valid: boolean;
  drift: boolean | null;
  strict: boolean;
  status: "ok" | "drift" | "invalid" | "policy-violation" | "diagnostic-failure" | "origin-warning";
  counts: { add: number; remove: number; change: number };
  policyViolations: string[];
  compatibilityUnknown: string[];
  compatibilityFailed: string[];
  integrityUnknown: string[];
  integrityFailed: string[];
  originWarnings: string[];
  changes: {
    add: ProfilePackage[];
    remove: ProfilePackage[];
    update: Array<{ from: ProfilePackage; to: ProfilePackage }>;
  };
  error?: string;
}

function invalidProfileCheckResult(error: unknown, strict: boolean): ProfileCheckResult {
  return {
    ok: false,
    valid: false,
    drift: null,
    strict,
    status: "invalid",
    counts: { add: 0, remove: 0, change: 0 },
    policyViolations: [],
    compatibilityUnknown: [],
    compatibilityFailed: [],
    integrityUnknown: [],
    integrityFailed: [],
    originWarnings: [],
    changes: { add: [], remove: [], update: [] },
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Check semantics:
 * - non-strict mode validates and reports drift without treating drift as failure;
 * - confirmed diagnostic failures and project-policy violations always fail;
 * - strict mode additionally fails on drift or a floating-origin warning;
 * - unknown diagnostics remain informational unless project policy requires them.
 */
export async function checkProfileSource(
  source: string,
  ctx: ExtensionCommandContext,
  options?: { strict?: boolean; pi?: ExtensionAPI }
): Promise<ProfileCheckResult> {
  const strict = options?.strict ?? false;
  try {
    const loaded = await loadProfileSource(source, {
      cwd: ctx.cwd,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const parsed = parseExternalProfile(loaded.value);
    if (!parsed.ok)
      throw new Error(parsed.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    const current = await getCurrentProfile(ctx, options?.pi);
    const review = await evaluateProfileReview(current, parsed.profile, ctx, options?.pi, {
      originWarnings: loaded.warnings,
    });
    const { plan, diagnostics, policyViolations: violations, originWarnings } = review;
    const drift = review.hasChanges;
    const hasDiagnosticFailure = review.confirmedFailures.length > 0;
    const status: ProfileCheckResult["status"] =
      violations.length > 0
        ? "policy-violation"
        : hasDiagnosticFailure
          ? "diagnostic-failure"
          : drift
            ? "drift"
            : originWarnings.length > 0
              ? "origin-warning"
              : "ok";
    return {
      ok:
        violations.length === 0 &&
        !hasDiagnosticFailure &&
        (!strict || (!drift && originWarnings.length === 0)),
      valid: true,
      drift,
      strict,
      status,
      counts: review.counts,
      policyViolations: violations.map((violation) => violation.message),
      compatibilityUnknown: diagnostics
        .filter((item) => item.compatibility === "unknown")
        .map((item) => `${item.source} (${item.scope})`),
      compatibilityFailed: diagnostics
        .filter((item) => item.compatibility === "failed")
        .map((item) => `${item.source} (${item.scope})`),
      integrityUnknown: diagnostics
        .filter((item) => item.integrity === "unknown")
        .map((item) => `${item.source} (${item.scope})`),
      integrityFailed: diagnostics
        .filter((item) => item.integrity === "failed")
        .map((item) => `${item.source} (${item.scope})`),
      originWarnings,
      changes: plan,
    };
  } catch (error) {
    return invalidProfileCheckResult(error, strict);
  }
}

async function handleCheck(
  tokens: string[],
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<void> {
  const options = parseOptions(tokens);
  const source = options.positionals[0];
  const result = source
    ? await checkProfileSource(source, ctx, { strict: options.strict, ...(pi ? { pi } : {}) })
    : invalidProfileCheckResult(
        new Error("Usage: /extensions profile check <source> [--json] [--strict]"),
        options.strict
      );
  if (options.json) {
    const encoded = JSON.stringify(result);
    if (ctx.hasUI) ctx.ui.notify(encoded, result.ok ? "info" : "error");
    else console.log(encoded);
    return;
  }
  await showReport(ctx, {
    title: `Profile check: ${source ?? "(missing source)"}`,
    placement: "center",
    level: result.ok ? "info" : "error",
    lines: [
      `Profile: ${result.valid ? "valid" : "invalid"}`,
      `Drift: ${result.drift === null ? "unknown" : result.drift ? "yes" : "no"}`,
      `Changes: ${result.counts.add} add, ${result.counts.remove} remove, ${result.counts.change} change`,
      `Status: ${result.status}`,
      ...(result.policyViolations.length
        ? [`Policy violations: ${result.policyViolations.join("; ")}`]
        : []),
      ...(result.compatibilityFailed.length
        ? [`Compatibility failed: ${result.compatibilityFailed.join(", ")}`]
        : []),
      ...(result.compatibilityUnknown.length
        ? [`Compatibility unknown: ${result.compatibilityUnknown.join(", ")}`]
        : []),
      ...(result.integrityFailed.length
        ? [`Integrity failed: ${result.integrityFailed.join(", ")}`]
        : []),
      ...(result.integrityUnknown.length
        ? [`Integrity unknown: ${result.integrityUnknown.join(", ")}`]
        : []),
      ...result.originWarnings.map((warning) => `Warning: ${warning}`),
      ...(result.error ? [`Error: ${result.error}`] : []),
      ...(options.strict
        ? [
            "Strict mode fails on drift, confirmed diagnostic failures, policy violations, and floating-origin warnings. Unknown diagnostics fail only when policy requires them.",
            "Pi's command API has no supported process status channel; failures are reported without terminating Pi.",
          ]
        : []),
    ],
  });
}

async function handleRecover(
  tokens: string[],
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<void> {
  const points = await readProfileRestorePoints();
  const requested = tokens[0];
  if (!requested || requested === "list") {
    await showListReport(
      ctx,
      "Profile restore points",
      points.map(
        (point, index) =>
          `${index + 1}. ${point.id}${point.incomplete ? " (incomplete rollback)" : ""} - ${point.reason}`
      )
    );
    return;
  }
  const point =
    points.find((candidate) => candidate.id === requested) ?? points[Number(requested) - 1];
  if (!point) throw new Error(`Profile restore point not found: ${requested}`);
  if (!pi) throw new Error("Profile recovery requires the extension API.");
  const current = await getCurrentProfile(ctx, pi);
  await reviewAndApplyProfileWithOutcome(
    current,
    { ...point.profile, name: `restore-${point.id}` },
    ctx,
    pi
  );
}

export async function handleProfileSubcommand(
  tokens: string[],
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<void> {
  const action = tokens[0];
  if (
    !action ||
    ![
      "export",
      "save",
      "list",
      "delete",
      "rename",
      "duplicate",
      "dry-run",
      "apply",
      "compare",
      "import",
      "check",
      "recover",
    ].includes(action)
  ) {
    notify(ctx, PROFILE_USAGE, "info");
    return;
  }
  try {
    if (action === "import") return await handleImport(tokens.slice(1), ctx, pi);
    if (action === "check") return await handleCheck(tokens.slice(1), ctx, pi);
    if (action === "recover") return await handleRecover(tokens.slice(1), ctx, pi);
    const requested = tokens[1];
    const force = tokens.includes("--force");
    if (action === "list") {
      const names = (await listProfiles()).map((profile) => profile.name);
      notify(
        ctx,
        names.length ? `Saved profiles:\n${names.join("\n")}` : "No saved profiles.",
        "info"
      );
      return;
    }
    if (action === "save") {
      if (!requested?.trim()) {
        notify(ctx, "Usage: /extensions profile save <name> [--force]", "info");
        return;
      }
      const name = requested.trim();
      const current = await getCurrentProfile(ctx, pi);
      let replace = force;
      if ((await getProfile(name)) && !replace) {
        if (!ctx.hasUI) {
          throw new Error(
            `A saved profile named ${name} already exists; pass --force to replace it.`
          );
        }
        replace = await confirmAction(ctx, "Replace saved profile", `Replace ${name}?`);
        if (!replace) {
          notify(ctx, `Saving profile ${name} cancelled.`, "info");
          return;
        }
      }
      await saveProfile(current, name, { replace });
      notify(ctx, `Saved profile ${name}.`, "info");
      return;
    }
    if (action === "delete") {
      if (!requested || !(await deleteProfile(requested)))
        notify(ctx, `Saved profile not found: ${requested ?? "(missing name)"}`, "warning");
      else notify(ctx, `Deleted profile ${requested}.`, "info");
      return;
    }
    if (action === "rename" || action === "duplicate") {
      const destination = tokens[2];
      if (!requested?.trim() || !destination?.trim()) {
        notify(ctx, `Usage: /extensions profile ${action} <from> <to> [--force]`, "info");
        return;
      }
      if (action === "rename") {
        await renameProfile(requested, destination, { replace: force });
        notify(ctx, `Renamed profile ${requested} to ${destination}.`, "info");
      } else {
        await duplicateProfile(requested, destination, { replace: force });
        notify(ctx, `Duplicated profile ${requested} as ${destination}.`, "info");
      }
      return;
    }

    const current = await getCurrentProfile(ctx, pi);
    if (action === "export") {
      if (!requested) {
        notify(ctx, "Usage: /extensions profile export <path>", "info");
        return;
      }
      const destination = await exportProfile(current, requested, { cwd: ctx.cwd });
      notify(ctx, `Exported profile to ${destination}`, "info");
      return;
    }
    const resolved = await resolveNamedOrSourceProfile(requested, ctx);
    if (!resolved) {
      notify(ctx, "No saved profile selected.", "info");
      return;
    }
    const { profile: desired, originWarnings } = resolved;
    if (action === "apply") {
      if (!pi) throw new Error("Profile application requires the extension API.");
      await reviewAndApplyProfileWithOutcome(current, desired, ctx, pi, { originWarnings });
      return;
    }
    const review = await evaluateProfileReview(current, desired, ctx, pi, { originWarnings });
    await showReport(ctx, {
      title: `Planned changes: ${desired.name}`,
      placement: "center",
      level: review.blockingReasons.length > 0 ? "error" : "info",
      lines: [...formatPlan(review.plan).split("\n"), ...formatProfileReviewDetails(review)],
    });
  } catch (error) {
    notify(
      ctx,
      `Profile ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
      "error"
    );
  }
}
