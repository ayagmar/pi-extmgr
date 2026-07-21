import {
  type ExtmgrProfile,
  getEffectivePackageSource,
  getProfilePackageIdentity,
  inferPackageResolution,
  type ProfilePackage,
} from "./schema.js";

export interface ProfilePlan {
  add: ProfilePackage[];
  remove: ProfilePackage[];
  update: Array<{ from: ProfilePackage; to: ProfilePackage }>;
}

export interface ProfileIdentityOptions {
  projectCwd?: string;
  globalCwd?: string;
}

function exactKey(pkg: ProfilePackage, options?: ProfileIdentityOptions): string {
  return `${pkg.scope}\0${getProfilePackageIdentity(pkg, options)}`;
}

function comparablePackage(pkg: ProfilePackage): unknown {
  return {
    source: getEffectivePackageSource(pkg),
    scope: pkg.scope,
    resolution: pkg.resolution ?? inferPackageResolution(pkg),
    // The effective source already contains the npm version or git ref. Comparing
    // the raw duplicate fields would report a change for equivalent encodings such
    // as npm:demo@1.0.0 versus { source: npm:demo, version: 1.0.0 }.
    // Omitted filters mean Pi's default, while [] disables every entrypoint.
    filters: pkg.filters,
  };
}

export function profilePackagesEqual(left: ProfilePackage, right: ProfilePackage): boolean {
  if (JSON.stringify(comparablePackage(left)) !== JSON.stringify(comparablePackage(right))) {
    return false;
  }
  // An omitted target preserves existing Pi settings; an explicit object (including
  // {}) is a requested replacement and must be compared.
  if (right.packageSettings === undefined) return true;
  return (
    left.packageSettings !== undefined &&
    JSON.stringify(left.packageSettings) === JSON.stringify(right.packageSettings)
  );
}

/**
 * Match exact scope+identity first, then pair remaining identities as scope
 * moves. This makes a scope move one reviewed change rather than a destructive
 * remove/add pair.
 */
export function planProfileApplication(
  current: ExtmgrProfile,
  desired: ExtmgrProfile,
  options?: ProfileIdentityOptions
): ProfilePlan {
  const unmatchedCurrent = new Set(current.packages.map((_, index) => index));
  const matchedDesired = new Set<number>();
  const update: Array<{ from: ProfilePackage; to: ProfilePackage }> = [];

  for (let desiredIndex = 0; desiredIndex < desired.packages.length; desiredIndex += 1) {
    const target = desired.packages[desiredIndex];
    if (!target) continue;
    const currentIndex = [...unmatchedCurrent].find((index) => {
      const candidate = current.packages[index];
      return candidate ? exactKey(candidate, options) === exactKey(target, options) : false;
    });
    if (currentIndex === undefined) continue;
    unmatchedCurrent.delete(currentIndex);
    matchedDesired.add(desiredIndex);
    const previous = current.packages[currentIndex];
    if (previous && !profilePackagesEqual(previous, target))
      update.push({ from: previous, to: target });
  }

  for (let desiredIndex = 0; desiredIndex < desired.packages.length; desiredIndex += 1) {
    if (matchedDesired.has(desiredIndex)) continue;
    const target = desired.packages[desiredIndex];
    if (!target) continue;
    const currentIndex = [...unmatchedCurrent].find((index) => {
      const candidate = current.packages[index];
      return (
        candidate &&
        getProfilePackageIdentity(candidate, options) === getProfilePackageIdentity(target, options)
      );
    });
    if (currentIndex === undefined) continue;
    unmatchedCurrent.delete(currentIndex);
    matchedDesired.add(desiredIndex);
    const previous = current.packages[currentIndex];
    if (previous) update.push({ from: previous, to: target });
  }

  return {
    add: desired.packages.filter((_, index) => !matchedDesired.has(index)),
    remove: current.packages.filter((_, index) => unmatchedCurrent.has(index)),
    update,
  };
}

export async function applyProfile(
  current: ExtmgrProfile,
  desired: ExtmgrProfile,
  options: { dryRun?: boolean; apply: (plan: ProfilePlan) => Promise<void> }
): Promise<ProfilePlan> {
  const plan = planProfileApplication(current, desired);
  if (!options.dryRun) await options.apply(plan);
  return plan;
}
