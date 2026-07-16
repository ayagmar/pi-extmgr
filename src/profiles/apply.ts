import { type ExtmgrProfile, type ProfilePackage } from "./schema.js";

export interface ProfilePlan {
  add: ProfilePackage[];
  remove: ProfilePackage[];
  update: Array<{ from: ProfilePackage; to: ProfilePackage }>;
}

function key(pkg: ProfilePackage): string {
  return `${pkg.scope}\0${pkg.source}`;
}

export function planProfileApplication(
  current: ExtmgrProfile,
  desired: ExtmgrProfile
): ProfilePlan {
  const currentByKey = new Map(current.packages.map((pkg) => [key(pkg), pkg]));
  const desiredByKey = new Map(desired.packages.map((pkg) => [key(pkg), pkg]));
  const add = desired.packages.filter((pkg) => !currentByKey.has(key(pkg)));
  const remove = current.packages.filter((pkg) => !desiredByKey.has(key(pkg)));
  const update = desired.packages.flatMap((pkg) => {
    const previous = currentByKey.get(key(pkg));
    return previous && JSON.stringify(previous) !== JSON.stringify(pkg)
      ? [{ from: previous, to: pkg }]
      : [];
  });
  return { add, remove, update };
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
