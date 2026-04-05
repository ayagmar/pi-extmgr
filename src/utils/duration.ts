export type DurationUnit = "minute" | "hour" | "day" | "week" | "month";

interface ParsedDuration {
  ms: number;
  display: string;
}

interface DurationAlias {
  ms: number;
  display: string;
}

interface DurationUnitDefinition {
  aliases: readonly string[];
  ms: number;
  singular: string;
  plural: string;
}

interface ParseDurationOptions {
  allowedUnits: readonly DurationUnit[];
  aliases?: Readonly<Record<string, DurationAlias>>;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

const DURATION_UNITS: Record<DurationUnit, DurationUnitDefinition> = {
  minute: {
    aliases: ["m", "min", "mins", "minute", "minutes"],
    ms: 60 * 1000,
    singular: "minute",
    plural: "minutes",
  },
  hour: {
    aliases: ["h", "hr", "hrs", "hour", "hours"],
    ms: HOUR_MS,
    singular: "hour",
    plural: "hours",
  },
  day: {
    aliases: ["d", "day", "days"],
    ms: DAY_MS,
    singular: "day",
    plural: "days",
  },
  week: {
    aliases: ["w", "wk", "wks", "week", "weeks"],
    ms: WEEK_MS,
    singular: "week",
    plural: "weeks",
  },
  month: {
    aliases: ["mo", "mos", "month", "months"],
    ms: MONTH_MS,
    singular: "month",
    plural: "months",
  },
};

function formatDisplay(value: number, unit: DurationUnit): string {
  const definition = DURATION_UNITS[unit];
  return `${value} ${value === 1 ? definition.singular : definition.plural}`;
}

function findDurationUnit(
  rawUnit: string,
  allowedUnits: readonly DurationUnit[]
): DurationUnit | undefined {
  return allowedUnits.find((unit) => DURATION_UNITS[unit].aliases.includes(rawUnit));
}

export function parseDurationValue(
  input: string,
  options: ParseDurationOptions
): ParsedDuration | undefined {
  const normalized = input.toLowerCase().trim();
  if (!normalized) {
    return undefined;
  }

  const alias = options.aliases?.[normalized];
  if (alias) {
    return { ...alias };
  }

  const match = normalized.match(/^(\d+)\s*([a-z]+)$/i);
  if (!match) {
    return undefined;
  }

  const value = Number.parseInt(match[1] ?? "", 10);
  const rawUnit = match[2] ?? "";
  if (!Number.isFinite(value) || value <= 0 || !rawUnit) {
    return undefined;
  }

  const unit = findDurationUnit(rawUnit, options.allowedUnits);
  if (!unit) {
    return undefined;
  }

  return {
    ms: value * DURATION_UNITS[unit].ms,
    display: formatDisplay(value, unit),
  };
}

const SCHEDULE_DURATION_ALIASES = {
  never: { ms: 0, display: "off" },
  off: { ms: 0, display: "off" },
  disable: { ms: 0, display: "off" },
  daily: { ms: DAY_MS, display: "daily" },
  day: { ms: DAY_MS, display: "daily" },
  weekly: { ms: WEEK_MS, display: "weekly" },
  week: { ms: WEEK_MS, display: "weekly" },
} satisfies Record<string, DurationAlias>;

export function parseScheduleDuration(input: string): ParsedDuration | undefined {
  return parseDurationValue(input, {
    allowedUnits: ["hour", "day", "week", "month"],
    aliases: SCHEDULE_DURATION_ALIASES,
  });
}

export function parseLookbackDuration(input: string): number | undefined {
  return parseDurationValue(input, {
    allowedUnits: ["minute", "hour", "day", "week", "month"],
  })?.ms;
}
