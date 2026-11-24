import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: /visual\.(spec|setup)\.ts/,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    ...devices["Desktop Chrome"],
    channel: "chrome",
    launchOptions: {
      executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    },
    trace: "only-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "CETUS_ADMIN_EMAIL=admin@cetus.local CETUS_ADMIN_PASSWORD=cetus-admin bun run dev:all",
    port: 5173,
    reuseExistingServer: true,
    timeout: 90_000,
  },
});
