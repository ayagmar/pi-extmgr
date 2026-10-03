import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { isProjectTrusted } from "../utils/mode.js";
import { type ProfilePlan, planProfileApplication } from "./apply.js";
import {
  loadProjectProfilePolicy,
  type ProfilePackageDiagnostic,
  type ProfilePolicyViolation,
  validateProfilePolicy,
} from "./compare.js";
import { calculateProfileDiagnostics } from "./runtime-state.js";
import { type ExtmgrProfile } from "./schema.js";

export const PROJECT_TRUST_REQUIRED =
  "Project-scoped profile packages require a trusted project. Trust this project in pi first.";

export interface ProfileReviewCounts {
  add: number;
  remove: number;
  change: number;
}

export interface ProfileUnknownCounts {
  compatibility: number;
  integrity: number;
  total: number;
}

export interface ProfileReview {
  current: ExtmgrProfile;
  desired: ExtmgrProfile;
  plan: ProfilePlan;
  counts: ProfileReviewCounts;
  hasChanges: boolean;
  diagnostics: ProfilePackageDiagnostic[];
  policyViolations: ProfilePolicyViolation[];
  confirmedFailures: ProfilePackageDiagnostic[];
  unknownCounts: ProfileUnknownCounts;
  originWarnings: string[];
  blockingReasons: string[];
  canApply: boolean;
}

export interface EvaluateProfileReviewOptions {
  originWarnings?: string[];
}

function diagnosticDescription(diagnostic: ProfilePackageDiagnostic): string {
  return `${diagnostic.source} (${diagnostic.scope})`;
}

/**
 * Evaluate one profile transition. Planning, runtime diagnostics, policy loading,
 * and policy validation intentionally happen once in this function so check,
 * review, and apply share the same classification.
 */
export async function evaluateProfileReview(
  current: ExtmgrProfile,
  desired: ExtmgrProfile,
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI,
  options?: EvaluateProfileReviewOptions
): Promise<ProfileReview> {
  const plan = planProfileApplication(current, desired, {
    projectCwd: ctx.cwd,
    globalCwd: getAgentDir(),
  });
  const diagnostics = await calculateProfileDiagnostics(desired, ctx, pi);
  const policy = await loadProjectProfilePolicy(ctx.cwd, undefined, isProjectTrusted(ctx));
  const policyViolations = policy ? validateProfilePolicy(desired, policy, diagnostics) : [];
  const confirmedFailures = diagnostics.filter(
    (diagnostic) => diagnostic.compatibility === "failed" || diagnostic.integrity === "failed"
  );
  const compatibilityUnknown = diagnostics.filter(
    (diagnostic) => diagnostic.compatibility === "unknown"
  ).length;
  const integrityUnknown = diagnostics.filter(
    (diagnostic) => diagnostic.integrity === "unknown"
  ).length;
  const originWarnings = [
    ...new Set([...(desired.importMetadata?.warnings ?? []), ...(options?.originWarnings ?? [])]),
  ].sort((left, right) => left.localeCompare(right));
  const hasChanges = plan.add.length + plan.remove.length + plan.update.length > 0;
  const projectTrustReasons =
    !isProjectTrusted(ctx) && desired.packages.some((pkg) => pkg.scope === "project")
      ? [PROJECT_TRUST_REQUIRED]
      : [];
  const blockingReasons = [
    ...projectTrustReasons,
    ...policyViolations.map((violation) => violation.message),
    ...confirmedFailures.map(
      (diagnostic) =>
        `confirmed diagnostic failure: ${diagnosticDescription(diagnostic)} (${[
          diagnostic.compatibility === "failed" ? "compatibility" : undefined,
          diagnostic.integrity === "failed" ? "integrity" : undefined,
        ]
          .filter(Boolean)
          .join(" and ")})`
    ),
  ];
  return {
    current,
    desired,
    plan,
    counts: { add: plan.add.length, remove: plan.remove.length, change: plan.update.length },
    hasChanges,
    diagnostics,
    policyViolations,
    confirmedFailures,
    unknownCounts: {
      compatibility: compatibilityUnknown,
      integrity: integrityUnknown,
      total: compatibilityUnknown + integrityUnknown,
    },
    originWarnings,
    blockingReasons,
    canApply: hasChanges && blockingReasons.length === 0,
  };
}

export function formatProfileDiagnosticFailure(diagnostic: ProfilePackageDiagnostic): string {
  return diagnosticDescription(diagnostic);
}

function sortedDiagnostics(review: ProfileReview): ProfilePackageDiagnostic[] {
  return [...review.diagnostics].sort((left, right) =>
    diagnosticDescription(left).localeCompare(diagnosticDescription(right))
  );
}

/** Deterministic plain-text diagnostics shared by command and import summaries. */
export function formatProfileReviewDetails(review: ProfileReview): string[] {
  const diagnostics = sortedDiagnostics(review);
  const compatibilityUnknown = diagnostics
    .filter((diagnostic) => diagnostic.compatibility === "unknown")
    .map(diagnosticDescription);
  const compatibilityFailed = diagnostics
    .filter((diagnostic) => diagnostic.compatibility === "failed")
    .map(diagnosticDescription);
  const integrityUnknown = diagnostics
    .filter((diagnostic) => diagnostic.integrity === "unknown")
    .map(diagnosticDescription);
  const integrityFailed = diagnostics
    .filter((diagnostic) => diagnostic.integrity === "failed")
    .map(diagnosticDescription);
  return [
    `Diagnostics: ${diagnostics.length} package(s) · ${review.unknownCounts.compatibility} compatibility unknown · ${review.unknownCounts.integrity} integrity unknown`,
    ...(compatibilityFailed.length
      ? [`Compatibility failed: ${compatibilityFailed.join(", ")}`]
      : []),
    ...(integrityFailed.length ? [`Integrity failed: ${integrityFailed.join(", ")}`] : []),
    ...(compatibilityUnknown.length
      ? [`Compatibility unknown: ${compatibilityUnknown.join(", ")}`]
      : []),
    ...(integrityUnknown.length ? [`Integrity unknown: ${integrityUnknown.join(", ")}`] : []),
    ...(review.confirmedFailures.length
      ? [`Confirmed failures: ${review.confirmedFailures.map(diagnosticDescription).join(", ")}`]
      : []),
    ...review.originWarnings.map((warning) => `Origin warning: ${warning}`),
    ...(review.blockingReasons.length
      ? [`Blocking reasons: ${review.blockingReasons.join("; ")}`]
      : []),
  ];
}
