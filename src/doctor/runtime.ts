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

const DUPLICATE_SUFFIX = /^(.+):(\d+)$/;

/**
 * pi lists extension commands by invocation name. When several extensions
 * register the same name it suffixes every copy (`deploy:1`, `deploy:2`), so
 * the registered name has to be recovered to see the clash.
 */
function registeredCommandNames(commands: ReturnType<ExtensionAPI["getCommands"]>): string[] {
  const suffixedBases = new Map<string, number>();
  for (const command of commands) {
    const base =
      command.source === "extension" ? DUPLICATE_SUFFIX.exec(command.name)?.[1] : undefined;
    if (base) suffixedBases.set(base, (suffixedBases.get(base) ?? 0) + 1);
  }
  return commands.map((command) => {
    if (command.source !== "extension") return command.name;
    const base = DUPLICATE_SUFFIX.exec(command.name)?.[1];
    return base && (suffixedBases.get(base) ?? 0) > 1 ? base : command.name;
  });
}

export function getRuntimeOwners(pi: ExtensionAPI): RuntimeOwner[] {
  const registeredCommands = pi.getCommands();
  const names = registeredCommandNames(registeredCommands);
  const commands = registeredCommands.map((command, index) => ({
    kind: "command" as const,
    name: names[index] ?? command.name,
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
