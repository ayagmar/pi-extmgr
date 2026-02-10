import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export type CommandId =
  | "local"
  | "list"
  | "remote"
  | "installed"
  | "search"
  | "install"
  | "remove"
  | "update"
  | "history"
  | "clear-cache"
  | "auto-update";

export interface CommandDefinition {
  id: CommandId;
  description: string;
  aliases?: string[];
  runInteractive: (
    tokens: string[],
    ctx: ExtensionCommandContext,
    pi: ExtensionAPI
  ) => Promise<void> | void;
  runNonInteractive: (
    tokens: string[],
    ctx: ExtensionCommandContext,
    pi: ExtensionAPI
  ) => Promise<void> | void;
}
