/**
 * File system utilities
 */
import { access, readFile } from "node:fs/promises";
import { truncate } from "./format.js";

function formatSummary(text: string): string {
  return truncate(text.replace(/\s+/g, " ").trim(), 80);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readSummary(filePath: string): Promise<string> {
  try {
    const text = await readFile(filePath, "utf8");
    const trimmed = text.trimStart();

    // Look for JSDoc/description patterns
    const descriptionPatterns = [
      /registerCommand\(\s*["'`][^"'`]+["'`]\s*,\s*\{[\s\S]*?description\s*:\s*["'`]([^"'`]+)["'`]/m,
      /registerTool\(\s*\{[\s\S]*?description\s*:\s*["'`]([^"'`]+)["'`]/m,
      /description\s*:\s*["'`]([^"'`]+)["'`]/m,
    ];

    for (const pattern of descriptionPatterns) {
      const match = text.match(pattern);
      const value = match?.[1]?.trim();
      if (value) return formatSummary(value);
    }

    // Look for block comments
    const block = trimmed.match(/^\/\*+[\s\S]*?\*\//);
    if (block?.[0]) {
      const lines = block[0]
        .split("\n")
        .map((line) =>
          line
            .replace(/^\s*\/\*+\s?/, "")
            .replace(/\*\/$/, "")
            .replace(/^\s*\*\s?/, "")
            .trim()
        )
        .filter((s): s is string => Boolean(s));
      const firstLine = lines[0];
      if (firstLine) return formatSummary(firstLine);
    }

    // Look for line comments
    const lineComment = trimmed.match(/^(?:\s*\/\/.*\n?)+/);
    if (lineComment?.[0]) {
      const first = lineComment[0]
        .split("\n")
        .map((line) => line.replace(/^\s*\/\/\s?/, "").trim())
        .filter(Boolean)[0];
      if (first) return formatSummary(first);
    }

    // First non-empty line
    for (const line of text.split("\n")) {
      const clean = line.trim();
      if (clean.length > 0) return formatSummary(clean);
    }
  } catch {
    // ignore
  }
  return "No description";
}
