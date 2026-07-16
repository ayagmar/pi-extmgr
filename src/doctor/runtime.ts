import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface RuntimeOwner {
  kind: "command" | "tool";
  name: string;
  description?: string;
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  path: string;
}

export function getRuntimeOwners(pi: ExtensionAPI): RuntimeOwner[] {
  const commands = pi.getCommands().map((command) => ({
    kind: "command" as const,
    name: command.name,
    ...(command.description ? { description: command.description } : {}),
    source: command.sourceInfo.source,
    scope: command.sourceInfo.scope,
    origin: command.sourceInfo.origin,
    path: command.sourceInfo.path,
  }));
  const tools = pi.getAllTools().map((tool) => ({
    kind: "tool" as const,
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    source: tool.sourceInfo.source,
    scope: tool.sourceInfo.scope,
    origin: tool.sourceInfo.origin,
    path: tool.sourceInfo.path,
  }));
  return [...commands, ...tools].sort((left, right) =>
    `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`)
  );
}
