import { planProfileApplication } from "./apply.js";
import { type ExtmgrProfile } from "./schema.js";

export interface ProfilePolicy {
  allowedScopes?: Array<"global" | "project">;
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
    if (policy.requireChecksums && !pkg.checksum) {
      violations.push({ packageSource: pkg.source, message: "checksum is required" });
    }
  }
  if (policy.requireCompatibilityCheck && profile.checks?.compatibility !== true) {
    violations.push({ message: "profile compatibility checks are required" });
  }
  return violations;
}
