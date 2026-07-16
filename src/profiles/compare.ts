import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { planProfileApplication } from "./apply.js";
import { type ExtmgrProfile } from "./schema.js";

export interface ProfilePolicy {
  allowedScopes?: Array<"global" | "project">;
  allowedSources?: string[];
  forbiddenSources?: string[];
  requiredPackages?: string[];
  requireChecksums?: boolean;
  requireCompatibilityCheck?: boolean;
}

export interface ProfilePolicyViolation {
  packageSource?: string;
  message: string;
}

export function compareProfiles(
  left: ExtmgrProfile,
  right: ExtmgrProfile
): ReturnType<typeof planProfileApplication> {
  return planProfileApplication(left, right);
}

export function validateProfilePolicy(
  profile: ExtmgrProfile,
  policy: ProfilePolicy
): ProfilePolicyViolation[] {
  const violations: ProfilePolicyViolation[] = [];
  for (const pkg of profile.packages) {
    if (policy.allowedScopes && !policy.allowedScopes.includes(pkg.scope)) {
      violations.push({ packageSource: pkg.source, message: `scope ${pkg.scope} is not allowed` });
    }
    if (policy.allowedSources && !policy.allowedSources.includes(pkg.source)) {
      violations.push({ packageSource: pkg.source, message: "source is not allowed" });
    }
    if (policy.forbiddenSources?.includes(pkg.source)) {
      violations.push({ packageSource: pkg.source, message: "source is forbidden" });
    }
    if (policy.requireChecksums && !pkg.checksum) {
      violations.push({ packageSource: pkg.source, message: "checksum is unknown" });
    }
  }
  for (const requiredSource of policy.requiredPackages ?? []) {
    if (!profile.packages.some((pkg) => pkg.source === requiredSource)) {
      violations.push({ packageSource: requiredSource, message: "required package is missing" });
    }
  }
  if (policy.requireCompatibilityCheck && profile.checks?.compatibility !== true) {
    violations.push({ message: "profile compatibility checks are required" });
  }
  return violations;
}

export async function loadProjectProfilePolicy(
  cwd: string,
  path?: string
): Promise<ProfilePolicy | undefined> {
  const policyPath = path ?? join(cwd, ".pi", "extmgr-policy.json");
  try {
    const raw = JSON.parse(await readFile(policyPath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Invalid profile policy in ${policyPath}`);
    }
    const value = raw as Record<string, unknown>;
    if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
      throw new Error(`Unsupported profile policy schema in ${policyPath}`);
    }
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
      ...(value.requireCompatibilityCheck === true ? { requireCompatibilityCheck: true } : {}),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
