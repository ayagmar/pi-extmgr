import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { installPackage, type InstallScope } from "../packages/install.js";
import { notify } from "../utils/notify.js";

export const INSTALL_USAGE = "Usage: /extensions install <source> [--project|--global]";

interface ParsedInstallArgs {
  source: string;
  scope?: InstallScope;
  errors: string[];
}

interface InstallParseState {
  sourceParts: string[];
  scope?: InstallScope;
  errors: string[];
}

type InstallOptionHandler = (state: InstallParseState) => void;

const INSTALL_OPTION_HANDLERS: Record<string, InstallOptionHandler> = {
  "--project": (state) => {
    if (state.scope === "global") {
      state.errors.push("Use either --project or --global, not both");
    }
    state.scope = "project";
  },
  "-l": (state) => {
    if (state.scope === "global") {
      state.errors.push("Use either --project or --global, not both");
    }
    state.scope = "project";
  },
  "--global": (state) => {
    if (state.scope === "project") {
      state.errors.push("Use either --project or --global, not both");
    }
    state.scope = "global";
  },
};

function parseInstallArgs(tokens: string[]): ParsedInstallArgs {
  const state: InstallParseState = {
    sourceParts: [],
    errors: [],
  };

  for (const token of tokens) {
    const optionHandler = INSTALL_OPTION_HANDLERS[token];
    if (optionHandler) {
      optionHandler(state);
    } else {
      state.sourceParts.push(token);
    }
  }

  return {
    source: state.sourceParts.join(" ").trim(),
    ...(state.scope ? { scope: state.scope } : {}),
    errors: state.errors,
  };
}

export async function handleInstallSubcommand(
  tokens: string[],
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  const parsed = parseInstallArgs(tokens);

  if (parsed.errors.length > 0) {
    notify(ctx, parsed.errors.join("\n"), "warning");
    notify(ctx, INSTALL_USAGE, "info");
    return;
  }

  if (!parsed.source) {
    notify(ctx, INSTALL_USAGE, "info");
    return;
  }

  await installPackage(parsed.source, ctx, pi, parsed.scope ? { scope: parsed.scope } : undefined);
}
