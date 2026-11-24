export function isRateLimitError(text: string) {
  return /toomanyrequests|too many requests|rate limit|429\b/i.test(text);
}

export function pullRateLimitBackoffMinutes() {
  const configured = Number(process.env.CETUS_PULL_RATE_LIMIT_BACKOFF_MINUTES ?? 360);
  if (!Number.isFinite(configured)) return 360;
  return Math.max(5, Math.min(1440, Math.floor(configured)));
}
