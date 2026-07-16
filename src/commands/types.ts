import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

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
  | "trash"
  | "auto-update"
  | "doctor"
  | "profile";

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
