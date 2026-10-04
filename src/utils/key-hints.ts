import { type Keybinding, type KeybindingsManager } from "@earendil-works/pi-tui";

const KEY_LABELS: Readonly<Record<string, string>> = {
  ctrl: "Ctrl",
  shift: "Shift",
  super: "Super",
  pageUp: "PgUp",
  pageDown: "PgDn",
  escape: "Esc",
  enter: "Enter",
  space: "Space",
  tab: "Tab",
};

/** Label every part of a combo (`ctrl+shift+x` → `Ctrl+Shift+x`); alt reads Option on macOS like pi's own hints. */
export function formatKey(key: string, platform: NodeJS.Platform = process.platform): string {
  return key
    .split("+")
    .map((part) =>
      part === "alt" ? (platform === "darwin" ? "Option" : "Alt") : (KEY_LABELS[part] ?? part)
    )
    .join("+");
}

/** Render a hint from Pi's active public keybinding configuration. */
export function activeKeyHint(
  keybindings: Pick<KeybindingsManager, "getKeys">,
  keybinding: Keybinding,
  label: string
): string {
  const keys = keybindings.getKeys(keybinding).map((key) => formatKey(key));
  return `${keys.join("/") || "(unbound)"} ${label}`;
}
