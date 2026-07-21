export function moveListSelection(
  currentIndex: number,
  delta: number,
  itemCount: number,
  options?: { wrap?: boolean }
): number {
  if (itemCount <= 0) return 0;
  if (options?.wrap && Math.abs(delta) === 1) {
    return (currentIndex + delta + itemCount) % itemCount;
  }
  return Math.max(0, Math.min(itemCount - 1, currentIndex + delta));
}

export function getCenteredVisibleRange(
  selectedIndex: number,
  itemCount: number,
  maxVisibleItems: number
): { startIndex: number; endIndex: number } {
  const maxVisible = Math.max(1, maxVisibleItems);
  const startIndex = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(maxVisible / 2), Math.max(0, itemCount - maxVisible))
  );
  return {
    startIndex,
    endIndex: Math.min(startIndex + maxVisible, itemCount),
  };
}
