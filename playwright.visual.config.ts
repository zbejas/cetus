import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:3204";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.001,
      animations: "disabled",
      caret: "hide",
    },
  },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    ...devices["Desktop Chrome"],
    channel: "chrome",
    launchOptions: {
      executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    },
    trace: "only-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /visual\.setup\.ts/,
    },
    {
      name: "visual",
      testMatch: /visual\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        storageState: ".playwright-visual/auth.json",
      },
    },
  ],
  webServer: {
    command: "rm -rf .playwright-visual && bun run build:web && bun apps/server/src/index.ts",
    port: 3204,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      CETUS_PORT: "3204",
      CETUS_HOST: "127.0.0.1",
      CETUS_DATA_DIR: path.resolve(process.cwd(), ".playwright-visual/data"),
      CETUS_STACKS_DIR: path.resolve(process.cwd(), "e2e/fixtures/stacks"),
      CETUS_PUBLIC_URL: baseURL,
      CETUS_ADMIN_EMAIL: "admin@cetus.local",
      CETUS_ADMIN_PASSWORD: "cetus-admin",
      CETUS_BACKUP_ENABLED: "false",
      CETUS_UPDATE_CHECK_ENABLED: "false",
      NODE_ENV: "development",
    },
  },
});
