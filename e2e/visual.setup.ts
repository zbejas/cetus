import { expect, test as setup } from "@playwright/test";

setup("authenticate", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("admin@cetus.local");
  await page.locator("#password").fill("cetus-admin");
  await page.getByRole("button", { name: /enter fleet/i }).click();
  await expect(page.getByRole("heading", { name: /overview/i }).first()).toBeVisible({ timeout: 20_000 });
  await page.context().storageState({ path: ".playwright-visual/auth.json" });
});
