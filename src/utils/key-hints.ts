import { type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type Keybinding } from "@earendil-works/pi-tui";

function formatKey(key: string): string {
  return key
    .replace(/^ctrl\+/, "Ctrl+")
    .replace(/^shift\+/, "Shift+")
    .replace(/^alt\+/, "Alt+")
    .replace(/^pageUp$/, "PgUp")
    .replace(/^pageDown$/, "PgDn")
    .replace(/^escape$/, "Esc")
    .replace(/^enter$/, "Enter")
    .replace(/^space$/, "Space")
    .replace(/^tab$/, "Tab");
}

/** Render a hint from Pi's active public keybinding configuration. */
export function activeKeyHint(
  keybindings: KeybindingsManager,
  keybinding: Keybinding,
  label: string
): string {
  const keys = keybindings.getKeys(keybinding).map(formatKey);
  return `${keys.join("/") || "(unbound)"} ${label}`;
}
