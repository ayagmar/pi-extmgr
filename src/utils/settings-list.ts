interface SelectableListLike {
  selectedIndex?: number;
}

export function getSettingsListSelectedIndex(settingsList: unknown): number | undefined {
  if (!settingsList || typeof settingsList !== "object") {
    return undefined;
  }

  const selectable = settingsList as SelectableListLike;
  return Number.isInteger(selectable.selectedIndex) ? selectable.selectedIndex : undefined;
}
