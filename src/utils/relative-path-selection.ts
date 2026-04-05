import { matchesGlob } from "node:path";

export function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function hasGlobMagic(path: string): boolean {
  return /[*?{}[\]]/.test(path);
}

export function isSafeRelativePath(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/");

  return (
    normalizedPath !== "" &&
    normalizedPath !== ".." &&
    !normalizedPath.startsWith("/") &&
    !path.startsWith("\\") &&
    !/^[A-Za-z]:/.test(normalizedPath) &&
    !normalizedPath.startsWith("../") &&
    !normalizedPath.includes("/../") &&
    !normalizedPath.endsWith("/..")
  );
}

export function safeMatchesGlob(targetPath: string, pattern: string): boolean {
  try {
    return matchesGlob(targetPath, pattern);
  } catch {
    return false;
  }
}

export function matchesFilterPattern(targetPath: string, pattern: string): boolean {
  const normalizedPattern = normalizeRelativePath(pattern.trim());
  if (!normalizedPattern) return false;
  if (targetPath === normalizedPattern) return true;

  return safeMatchesGlob(targetPath, normalizedPattern);
}

export function selectDirectoryFiles(allFiles: readonly string[], directoryPath: string): string[] {
  const prefix = `${directoryPath}/`;
  return allFiles.filter((file) => file.startsWith(prefix));
}

export function applySelection(
  selected: Set<string>,
  files: Iterable<string>,
  exclude: boolean
): void {
  for (const file of files) {
    if (exclude) {
      selected.delete(file);
    } else {
      selected.add(file);
    }
  }
}

export function resolveRelativePathSelection(
  allFiles: readonly string[],
  entries: readonly string[],
  isExactPathSelectable: (path: string, allFiles: readonly string[]) => boolean
): string[] {
  const selected = new Set<string>();

  for (const rawToken of entries) {
    const token = rawToken.trim();
    if (!token) continue;

    const exclude = token.startsWith("!");
    const normalizedToken = normalizeRelativePath(exclude ? token.slice(1) : token);
    const pattern = normalizedToken.replace(/[\\/]+$/g, "");
    if (!isSafeRelativePath(pattern)) {
      continue;
    }

    if (hasGlobMagic(pattern)) {
      applySelection(
        selected,
        allFiles.filter((file) => matchesFilterPattern(file, pattern)),
        exclude
      );
      continue;
    }

    const directoryFiles = selectDirectoryFiles(allFiles, pattern);
    if (directoryFiles.length > 0) {
      applySelection(selected, directoryFiles, exclude);
      continue;
    }

    if (isExactPathSelectable(pattern, allFiles)) {
      applySelection(selected, [pattern], exclude);
    }
  }

  return Array.from(selected).sort((a, b) => a.localeCompare(b));
}
