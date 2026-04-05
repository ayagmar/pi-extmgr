export function normalizePathIdentity(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const looksWindowsPath =
    /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//") || value.includes("\\");

  return looksWindowsPath ? normalized.toLowerCase() : normalized;
}
