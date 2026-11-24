interface CronField {
  values: Set<number>;
  wildcard: boolean;
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseField(input: string, min: number, max: number, normalize?: (value: number) => number): CronField | null {
  const pieces = input.split(",").map((value) => value.trim()).filter(Boolean);
  if (!pieces.length) return null;
  const values = new Set<number>();
  let wildcard = false;

  for (const piece of pieces) {
    const [base, stepRaw] = piece.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1 || step > max) return null;
    let start: number;
    let end: number;
    if (base === "*" || base === "?") {
      start = min;
      end = max;
      wildcard = true;
    } else if (base.includes("-")) {
      const [startRaw, endRaw] = base.split("-");
      start = Number(startRaw);
      end = Number(endRaw);
    } else {
      start = Number(base);
      end = stepRaw === undefined ? start : max;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || end < start) return null;
    for (let value = start; value <= end; value += step) {
      values.add(normalize ? normalize(value) : value);
    }
  }

  return { values, wildcard };
}

export function parseCron(expression: string): ParsedCron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dayOfMonth = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dayOfWeek = parseField(fields[4], 0, 7, (value) => value === 7 ? 0 : value);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

export function isValidCron(expression: string) {
  return parseCron(expression) !== null;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(date: Date, timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    }).formatToParts(date);
    const map = new Map(parts.map((part) => [part.type, part.value]));
    return {
      minute: Number(map.get("minute")),
      hour: Number(map.get("hour")) % 24,
      day: Number(map.get("day")),
      month: Number(map.get("month")),
      weekday: WEEKDAYS[map.get("weekday") ?? "Sun"] ?? 0,
    };
  } catch {
    return null;
  }
}

export function cronMatches(expression: string, date: Date, timeZone: string) {
  const cron = parseCron(expression);
  if (!cron) return false;
  const parts = zonedParts(date, timeZone);
  if (!parts) return false;
  if (!cron.minute.values.has(parts.minute)) return false;
  if (!cron.hour.values.has(parts.hour)) return false;
  if (!cron.month.values.has(parts.month)) return false;
  const dayMatches = cron.dayOfMonth.values.has(parts.day);
  const weekdayMatches = cron.dayOfWeek.values.has(parts.weekday);
  if (cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard) return true;
  if (cron.dayOfMonth.wildcard) return weekdayMatches;
  if (cron.dayOfWeek.wildcard) return dayMatches;
  return dayMatches || weekdayMatches;
}

export function nextCronDate(expression: string, timeZone: string, from = new Date(), horizonDays = 40) {
  if (!parseCron(expression)) return null;
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = horizonDays * 24 * 60;
  for (let index = 0; index < limit; index += 1) {
    if (cronMatches(expression, cursor, timeZone)) return cursor.toISOString();
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

export function cronToDailyTime(expression: string) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = Number(fields[0]);
  const hour = Number(fields[1]);
  if (!Number.isInteger(minute) || !Number.isInteger(hour) || minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  if (!fields[2].includes("*") || !fields[3].includes("*") || !fields[4].includes("*")) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function dailyTimeToCron(time: string) {
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return "0 4 * * *";
  return `${Number(match[2])} ${Number(match[1])} * * *`;
}
