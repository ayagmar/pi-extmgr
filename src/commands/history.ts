import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  formatChangeEntry,
  queryGlobalHistory,
  querySessionChanges,
  type ChangeAction,
  type HistoryFilters,
} from "../utils/history.js";
import { notify } from "../utils/notify.js";
import { formatListOutput } from "../utils/ui-helpers.js";

const HISTORY_ACTIONS: ChangeAction[] = [
  "extension_toggle",
  "package_install",
  "package_update",
  "package_remove",
  "cache_clear",
];

interface ParsedHistoryArgs {
  filters: HistoryFilters;
  global: boolean;
  showHelp: boolean;
  errors: string[];
}

interface HistoryParseState {
  filters: HistoryFilters;
  global: boolean;
  showHelp: boolean;
  errors: string[];
}

type HistoryOptionHandler = (tokens: string[], index: number, state: HistoryParseState) => number;

const HISTORY_ACTION_SET = new Set<ChangeAction>(HISTORY_ACTIONS);

function parseHistorySinceDuration(input: string): number | undefined {
  const normalized = input.toLowerCase().trim();
  const match = normalized.match(
    /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|mos|month|months)$/
  );
  if (!match) return undefined;

  const value = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) return undefined;

  const unit = match[2] ?? "";
  if (unit.startsWith("m") && !unit.startsWith("mo")) {
    return value * 60 * 1000;
  }
  if (unit.startsWith("h")) {
    return value * 60 * 60 * 1000;
  }
  if (unit.startsWith("d")) {
    return value * 24 * 60 * 60 * 1000;
  }
  if (unit.startsWith("w")) {
    return value * 7 * 24 * 60 * 60 * 1000;
  }
  if (unit.startsWith("mo")) {
    return value * 30 * 24 * 60 * 60 * 1000;
  }

  return undefined;
}

const HISTORY_OPTION_HANDLERS: Record<string, HistoryOptionHandler> = {
  "--help": (_tokens, _index, state) => {
    state.showHelp = true;
    return 0;
  },
  "-h": (_tokens, _index, state) => {
    state.showHelp = true;
    return 0;
  },
  "--global": (_tokens, _index, state) => {
    state.global = true;
    return 0;
  },
  "--limit": (tokens, index, state) => {
    const value = tokens[index + 1];
    if (!value) {
      state.errors.push("--limit requires a number");
      return 0;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      state.errors.push(`Invalid --limit value: ${value}`);
    } else {
      state.filters.limit = parsed;
    }

    return 1;
  },
  "--action": (tokens, index, state) => {
    const value = tokens[index + 1] as ChangeAction | undefined;
    if (!value) {
      state.errors.push("--action requires a value");
      return 0;
    }

    if (!HISTORY_ACTION_SET.has(value)) {
      state.errors.push(`Invalid --action value: ${value}`);
    } else {
      state.filters.action = value;
    }

    return 1;
  },
  "--failed": (_tokens, _index, state) => {
    if (state.filters.success === true) {
      state.errors.push("Use either --success or --failed, not both");
    }
    state.filters.success = false;
    return 0;
  },
  "--success": (_tokens, _index, state) => {
    if (state.filters.success === false) {
      state.errors.push("Use either --success or --failed, not both");
    }
    state.filters.success = true;
    return 0;
  },
  "--package": (tokens, index, state) => {
    const value = tokens[index + 1];
    if (!value) {
      state.errors.push("--package requires a value");
      return 0;
    }

    state.filters.packageQuery = value;
    return 1;
  },
  "--since": (tokens, index, state) => {
    const value = tokens[index + 1];
    if (!value) {
      state.errors.push("--since requires a duration (e.g. 30m, 7d, 24h)");
      return 0;
    }

    const ms = parseHistorySinceDuration(value);
    if (!ms) {
      state.errors.push(`Invalid --since duration: ${value}`);
    } else {
      state.filters.sinceTimestamp = Date.now() - ms;
    }

    return 1;
  },
};

function parseHistoryArgs(tokens: string[]): ParsedHistoryArgs {
  const state: HistoryParseState = {
    filters: { limit: 20 },
    global: false,
    showHelp: false,
    errors: [],
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    const handler = HISTORY_OPTION_HANDLERS[token];

    if (!handler) {
      state.errors.push(`Unknown history option: ${token}`);
      continue;
    }

    const consumed = handler(tokens, i, state);
    i += consumed;
  }

  return {
    filters: state.filters,
    global: state.global,
    showHelp: state.showHelp,
    errors: state.errors,
  };
}

function showHistoryHelp(ctx: ExtensionCommandContext): void {
  const lines = [
    "Usage: /extensions history [options]",
    "",
    "Options:",
    "  --limit <n>      Maximum entries to show (default: 20)",
    "  --action <type>  Filter by action",
    "                   extension_toggle | package_install | package_update | package_remove | cache_clear",
    "  --success        Show only successful entries",
    "  --failed         Show only failed entries",
    "  --package <q>    Filter by package/source/extension id",
    "  --since <d>      Show only entries newer than duration (e.g. 30m, 24h, 7d, 1mo)",
    "  --global         Read all persisted sessions (non-interactive mode only)",
    "",
    "Examples:",
    "  /extensions history --failed --limit 50",
    "  /extensions history --action package_update --since 7d",
    "  /extensions history --package extmgr --since 30m",
    "  /extensions history --global --failed --since 14d",
  ];

  notify(ctx, lines.join("\n"), "info");
}

function formatSessionSuffix(sessionFile: string): string {
  const marker = "/.pi/agent/sessions/";
  const normalized = sessionFile.replace(/\\/g, "/");
  const index = normalized.indexOf(marker);
  if (index >= 0) {
    return normalized.slice(index + marker.length);
  }
  return sessionFile;
}

export async function handleHistorySubcommand(
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
  tokens: string[],
  allowGlobal: boolean
): Promise<void> {
  const parsed = parseHistoryArgs(tokens);

  if (parsed.showHelp) {
    showHistoryHelp(ctx);
    return;
  }

  if (parsed.errors.length > 0) {
    notify(ctx, parsed.errors.join("\n"), "warning");
    showHistoryHelp(ctx);
    return;
  }

  if (parsed.global && !allowGlobal) {
    notify(ctx, "--global is only available in non-interactive mode.", "warning");
    return;
  }

  if (parsed.global) {
    const changes = await queryGlobalHistory(parsed.filters);
    if (changes.length === 0) {
      notify(ctx, "No matching extension changes found across persisted sessions.", "info");
      return;
    }

    const lines = changes.map(
      ({ change, sessionFile }) =>
        `${formatChangeEntry(change)}  [${formatSessionSuffix(sessionFile)}]`
    );
    formatListOutput(ctx, `Extension Change History (global, recent ${changes.length})`, lines);
    return;
  }

  const changes = querySessionChanges(ctx, parsed.filters);
  if (changes.length === 0) {
    notify(ctx, "No matching extension changes found in this session.", "info");
    return;
  }

  const lines = changes.map(formatChangeEntry);
  formatListOutput(ctx, `Extension Change History (recent ${changes.length})`, lines);
}
