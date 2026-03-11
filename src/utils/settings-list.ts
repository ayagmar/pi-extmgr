interface SelectableListLike {
  selectedIndex?: number;
}

export function getSettingsListSelectedIndex(settingsList: unknown): number | undefined {
  if (!settingsList || typeof settingsList !== "object") {
    return undefined;
  }

  const selectable = settingsList as SelectableListLike;
  return typeof selectable.selectedIndex === "number" ? selectable.selectedIndex : undefined;
}
