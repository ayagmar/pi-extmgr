import { normalizePathIdentity } from "../utils/path-identity.js";
import { type RuntimeOwner } from "./runtime.js";

export interface RuntimeConflict {
  kind: RuntimeOwner["kind"];
  name: string;
  owners: RuntimeOwner[];
}

/**
 * The extension file an owner came from. pi gives every auto-discovered
 * extension the source "auto" and every settings-listed path "local", so the
 * source alone cannot tell two extensions apart; the path can.
 */
function ownerIdentity(owner: RuntimeOwner): string {
  return owner.path
    ? normalizePathIdentity(owner.path)
    : `${owner.source}\0${owner.scope}\0${owner.origin}`;
}

/**
 * Commands registered under the same name by different extensions.
 *
 * Tools are not checked: pi keeps one definition per tool name (the last
 * registration wins), so `getAllTools()` can never show a clash.
 */
export function findRuntimeConflicts(owners: RuntimeOwner[]): RuntimeConflict[] {
  const groups = new Map<string, RuntimeOwner[]>();
  for (const owner of owners) {
    if (owner.kind !== "command") continue;
    const group = groups.get(owner.name) ?? [];
    group.push(owner);
    groups.set(owner.name, group);
  }

  return [...groups.values()]
    .filter((group) => new Set(group.map(ownerIdentity)).size > 1)
    .flatMap((group) => {
      const first = group[0];
      return first ? [{ kind: first.kind, name: first.name, owners: group }] : [];
    })
    .sort((left, right) =>
      `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`)
    );
}

/** A short owner label: the package source, or the file for local extensions. */
export function describeConflictOwner(owner: RuntimeOwner): string {
  return owner.origin === "package" || !owner.path ? owner.source : owner.path;
}
