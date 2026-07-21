import { readFile } from "node:fs/promises";
import { getProjectConfigPath } from "../utils/pi-paths.js";
import { planProfileApplication } from "./apply.js";
import { getEffectivePackageSource, type DiagnosticStatus, type ExtmgrProfile } from "./schema.js";

export interface ProfilePolicy {
  allowedScopes?: Array<"global" | "project">;
  allowedSources?: string[];
  forbiddenSources?: string[];
  requiredPackages?: string[];
  /** Legacy policy name. It now means locally verified artifact integrity. */
  requireChecksums?: boolean;
  requireIntegrity?: boolean;
  requireCompatibilityCheck?: boolean;
}

export interface ProfilePolicyViolation {
  packageSource?: string;
  message: string;
}

export interface ProfilePackageDiagnostic {
  source: string;
  scope: "global" | "project";
  compatibility: DiagnosticStatus;
  integrity: DiagnosticStatus;
  notes: string[];
}

export function compareProfiles(
  left: ExtmgrProfile,
  right: ExtmgrProfile
): ReturnType<typeof planProfileApplication> {
  return planProfileApplication(left, right);
}

export function validateProfilePolicy(
  profile: ExtmgrProfile,
  policy: ProfilePolicy,
  diagnostics: ProfilePackageDiagnostic[] = []
): ProfilePolicyViolation[] {
  const violations: ProfilePolicyViolation[] = [];
  for (const pkg of profile.packages) {
    const effectiveSource = getEffectivePackageSource(pkg);
    if (policy.allowedScopes && !policy.allowedScopes.includes(pkg.scope)) {
      violations.push({
        packageSource: effectiveSource,
        message: `scope ${pkg.scope} is not allowed`,
      });
    }
    if (
      policy.allowedSources &&
      !policy.allowedSources.includes(effectiveSource) &&
      !policy.allowedSources.includes(pkg.source)
    ) {
      violations.push({ packageSource: effectiveSource, message: "source is not allowed" });
    }
    if (
      policy.forbiddenSources?.includes(effectiveSource) ||
      policy.forbiddenSources?.includes(pkg.source)
    ) {
      violations.push({ packageSource: effectiveSource, message: "source is forbidden" });
    }
    const diagnostic = diagnostics.find(
      (item) => item.scope === pkg.scope && item.source === effectiveSource
    );
    if (
      (policy.requireChecksums || policy.requireIntegrity) &&
      diagnostic?.integrity !== "verified"
    ) {
      violations.push({
        packageSource: effectiveSource,
        message: "artifact integrity is unknown or unverified",
      });
    }
    if (policy.requireCompatibilityCheck && diagnostic?.compatibility !== "verified") {
      violations.push({
        packageSource: effectiveSource,
        message: "local compatibility is unknown or failed",
      });
    }
  }
  for (const requiredSource of policy.requiredPackages ?? []) {
    if (
      !profile.packages.some(
        (pkg) => pkg.source === requiredSource || getEffectivePackageSource(pkg) === requiredSource
      )
    ) {
      violations.push({ packageSource: requiredSource, message: "required package is missing" });
    }
  }
  return violations;
}

export async function loadProjectProfilePolicy(
  cwd: string,
  path?: string,
  projectTrusted = false
): Promise<ProfilePolicy | undefined> {
  if (!path && !projectTrusted) return undefined;
  const policyPath = path ?? getProjectConfigPath(cwd, "extmgr-policy.json");
  try {
    const raw = JSON.parse(await readFile(policyPath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error(`Invalid profile policy in ${policyPath}`);
    const value = raw as Record<string, unknown>;
    if (value.schemaVersion !== undefined && value.schemaVersion !== 1)
      throw new Error(`Unsupported profile policy schema in ${policyPath}`);
    const scopes = Array.isArray(value.allowedScopes)
      ? value.allowedScopes.filter(
          (scope): scope is "global" | "project" => scope === "global" || scope === "project"
        )
      : undefined;
    const strings = (candidate: unknown): string[] | undefined =>
      Array.isArray(candidate)
        ? candidate.filter(
            (entry): entry is string => typeof entry === "string" && Boolean(entry.trim())
          )
        : undefined;
    const allowedSources = strings(value.allowedSources);
    const forbiddenSources = strings(value.forbiddenSources);
    const requiredPackages = strings(value.requiredPackages);
    return {
      ...(scopes && scopes.length > 0 ? { allowedScopes: scopes } : {}),
      ...(allowedSources ? { allowedSources } : {}),
      ...(forbiddenSources ? { forbiddenSources } : {}),
      ...(requiredPackages ? { requiredPackages } : {}),
      ...(value.requireChecksums === true ? { requireChecksums: true } : {}),
      ...(value.requireIntegrity === true ? { requireIntegrity: true } : {}),
      ...(value.requireCompatibilityCheck === true ? { requireCompatibilityCheck: true } : {}),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
