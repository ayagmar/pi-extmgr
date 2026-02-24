/**
 * Shared command/choice parsing helpers
 */

export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    const next = input[i + 1];

    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false;
      } else {
        current += char;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (char === '"') {
        inDoubleQuote = false;
        continue;
      }

      if (char === "\\" && next === '"') {
        current += next;
        i++;
        continue;
      }

      current += char;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      continue;
    }

    if (char === '"') {
      inDoubleQuote = true;
      continue;
    }

    if (char === "\\" && (next === '"' || next === "'" || /\s/.test(next ?? ""))) {
      if (next) {
        current += next;
        i++;
      } else {
        current += char;
      }
      continue;
    }

    current += char;
  }

  pushCurrent();
  return tokens;
}

export function splitCommandArgs(input: string): { subcommand: string; args: string[] } {
  const [subcommand = "", ...args] = tokenizeArgs(input);
  return { subcommand: subcommand.toLowerCase(), args };
}

export function parseChoiceByLabel<T extends string>(
  choices: Record<T, string>,
  label: string | undefined
): T | undefined {
  if (!label) return undefined;

  const match = (Object.entries(choices) as [T, string][]).find(([, value]) => value === label);
  return match?.[0];
}
