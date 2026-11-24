import { describe, expect, test } from "bun:test";
import { cronMatches, cronToDailyTime, dailyTimeToCron, isValidCron, nextCronDate, parseCron } from "./cron.ts";

describe("cron", () => {
  test("accepts five-field expressions", () => {
    expect(isValidCron("0 4 * * *")).toBe(true);
    expect(isValidCron("*/15 2-4 * * 1-5")).toBe(true);
    expect(isValidCron("0/15 4 * * *")).toBe(true);
    expect(isValidCron("0 4 * * 7")).toBe(true);
  });

  test("rejects malformed expressions", () => {
    expect(isValidCron("0 4 * *")).toBe(false);
    expect(isValidCron("61 4 * * *")).toBe(false);
    expect(isValidCron("0 4 32 * *")).toBe(false);
    expect(parseCron("nope")).toBeNull();
  });

  test("expands a step that starts at a value", () => {
    expect(cronMatches("0/15 * * * *", new Date("2026-11-24T04:30:00.000Z"), "UTC")).toBe(true);
    expect(cronMatches("0/15 * * * *", new Date("2026-11-24T04:35:00.000Z"), "UTC")).toBe(false);
  });

  test("matches in the requested timezone", () => {
    const date = new Date("2026-11-24T04:00:00.000Z");
    expect(cronMatches("0 4 * * *", date, "UTC")).toBe(true);
    expect(cronMatches("0 4 * * *", date, "Europe/Ljubljana")).toBe(false);
    expect(cronMatches("0 5 * * *", date, "Europe/Ljubljana")).toBe(true);
  });

  test("finds the next run", () => {
    const next = nextCronDate("0 4 * * *", "UTC", new Date("2026-11-24T03:10:00.000Z"));
    expect(next).toBe("2026-11-24T04:00:00.000Z");
  });

  test("round-trips a daily time", () => {
    expect(cronToDailyTime("15 3 * * *")).toBe("03:15");
    expect(dailyTimeToCron("03:15")).toBe("15 3 * * *");
  });
});
