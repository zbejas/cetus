import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const MOBILE = { width: 390, height: 844 };

async function openStacks(page: import("@playwright/test").Page) {
  await page.goto("/stacks");
  await expect(page.getByRole("heading", { name: /^stacks$/i }).first()).toBeVisible();
  await expect(page.getByRole("table", { name: "Stacks across the fleet" })).toBeVisible();
  await page.waitForTimeout(400);
  await page.locator("tbody tr td:nth-child(6)").evaluateAll((cells) => {
    for (const cell of cells) cell.textContent = "1m ago";
  });
}

test("login screen", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/login");
  await expect(page.getByRole("button", { name: /enter fleet/i })).toBeVisible();
  await expect(page).toHaveScreenshot("login-dark-1440.png");
});

test("stacks dark desktop", async ({ page }) => {
  await openStacks(page);
  await expect(page).toHaveScreenshot("stacks-dark-1440.png");
});

test("stack detail dark desktop", async ({ page }) => {
  await openStacks(page);
  await page.locator("tbody tr").first().click();
  await expect(page).toHaveURL(/\/stacks\/[a-f0-9-]+$/);
  await expect(page.getByRole("button", { name: /edit compose/i })).toBeVisible();
  const composePath = page.locator("span.mono").filter({ hasText: /\/compose\.yaml$/ }).first();
  if (await composePath.count() > 0) {
    await composePath.evaluate((element) => {
      element.textContent = "/opt/stacks/docs/compose.yaml";
    });
  }
  await expect(page).toHaveScreenshot("stack-detail-dark-1440.png");
});

test("settings appearance dark desktop", async ({ page }) => {
  await page.goto("/settings?tab=appearance");
  await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("settings-dark-1440.png");
});

test("stacks light desktop", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("cetus-theme", "light"));
  await openStacks(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("light"))).toBe(true);
  await expect(page).toHaveScreenshot("stacks-light-1440.png");
});

test("stacks mobile", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await openStacks(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page).toHaveScreenshot("stacks-dark-390.png");
});

test("settings mobile", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto("/settings?tab=appearance");
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page).toHaveScreenshot("settings-dark-390.png");
});

test("key screens have no serious accessibility violations", async ({ page }) => {
  await openStacks(page);
  const stacks = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(stacks.violations, stacks.violations.map((violation) => `${violation.id}: ${violation.help}`).join("\n")).toEqual([]);

  await page.goto("/settings?tab=appearance");
  const settings = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(settings.violations, settings.violations.map((violation) => `${violation.id}: ${violation.help}`).join("\n")).toEqual([]);
});
