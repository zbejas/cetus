import { describe, expect, test } from "bun:test";
import { isRateLimitError, pullRateLimitBackoffMinutes } from "./rateLimit.ts";

describe("registry rate limits", () => {
  test("recognizes Docker Hub and HTTP 429 errors", () => {
    expect(isRateLimitError("Error response from daemon: toomanyrequests: You have reached your pull rate limit")).toBe(true);
    expect(isRateLimitError("[stderr] 429 Too Many Requests")).toBe(true);
    expect(isRateLimitError("unauthorized: authentication required")).toBe(false);
  });

  test("clamps the backoff setting", () => {
    const previous = process.env.CETUS_PULL_RATE_LIMIT_BACKOFF_MINUTES;
    process.env.CETUS_PULL_RATE_LIMIT_BACKOFF_MINUTES = "1";
    expect(pullRateLimitBackoffMinutes()).toBe(5);
    process.env.CETUS_PULL_RATE_LIMIT_BACKOFF_MINUTES = "9999";
    expect(pullRateLimitBackoffMinutes()).toBe(1440);
    process.env.CETUS_PULL_RATE_LIMIT_BACKOFF_MINUTES = "360";
    expect(pullRateLimitBackoffMinutes()).toBe(360);
    if (previous === undefined) delete process.env.CETUS_PULL_RATE_LIMIT_BACKOFF_MINUTES;
    else process.env.CETUS_PULL_RATE_LIMIT_BACKOFF_MINUTES = previous;
  });
});
