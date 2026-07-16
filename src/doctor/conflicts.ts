import { type RuntimeOwner } from "./runtime.js";

export interface RuntimeConflict {
  kind: RuntimeOwner["kind"];
  name: string;
  owners: RuntimeOwner[];
}

export function findRuntimeConflicts(owners: RuntimeOwner[]): RuntimeConflict[] {
  const groups = new Map<string, RuntimeOwner[]>();
  for (const owner of owners) {
    const key = `${owner.kind}\0${owner.name}`;
    const group = groups.get(key) ?? [];
    group.push(owner);
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter((group) => new Set(group.map((owner) => owner.source)).size > 1)
    .flatMap((group) => {
      const first = group[0];
      return first ? [{ kind: first.kind, name: first.name, owners: group }] : [];
    })
    .sort((left, right) =>
      `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`)
    );
}
