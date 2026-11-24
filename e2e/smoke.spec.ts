import { expect, test } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.locator("#password").fill(password);
  const submit = page.getByRole("button", { name: /enter fleet/i });
  await submit.click();

  // better-auth allows three sign-ins per 10 seconds per client. The suite has
  // isolated contexts, so a fourth test can hit that limit while previous
  // tests are still inside the window. Retry once after it clears instead of
  // serialising every test behind a fixed delay.
  const rateLimited = page.getByText("Too many requests. Please try again later.");
  await Promise.race([
    page.waitForURL(/\/$/, { timeout: 9_000 }).catch(() => null),
    rateLimited.waitFor({ state: "visible", timeout: 9_000 }).catch(() => null),
  ]);
  if (await rateLimited.isVisible().catch(() => false)) {
    await page.waitForTimeout(10_500);
    await submit.click();
  }

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: /overview/i }).first()).toBeVisible();
  await expect(page.locator(".topbar-host")).toHaveCount(0);
}

async function login(page: import("@playwright/test").Page) {
  await signIn(
    page,
    process.env.CETUS_E2E_EMAIL ?? "admin@cetus.local",
    process.env.CETUS_E2E_PASSWORD ?? "cetus-admin",
  );
}

test.describe.configure({ mode: "serial" });

test("signs in and opens the stack cockpit", async ({ page }) => {
  await login(page);

  await page.goto("/stacks");
  await expect(page.getByRole("heading", { name: /^stacks$/i }).first()).toBeVisible();
  await expect(page.locator("table").or(page.getByText("No stacks yet"))).toBeVisible();

  const firstStack = page.locator("tbody tr").first();
  if (await firstStack.count() > 0) {
    const stackName = (await firstStack.locator("strong").first().textContent())?.trim() ?? "";
    await firstStack.click();
    await expect(page).toHaveURL(/\/stacks\/[a-f0-9-]+$/);
    if (stackName) {
      await expect(page.getByRole("heading", { name: stackName, level: 2 })).toBeVisible();
    }
    await expect(page.getByText("Services", { exact: true }).first()).toBeVisible();

    const logsButton = page.getByRole("button", { name: /^Logs for / }).first();
    if (await logsButton.count() > 0) {
      const label = (await logsButton.getAttribute("aria-label")) ?? "";
      const service = label.replace(/^Logs for /, "").trim();
      await logsButton.click();
      if (service) {
        await expect(page.locator(".stack-log-selector select")).toHaveValue(service);
        await expect(page.locator(".log-source-title")).toContainText(`/ ${service}`);
      }
    }

    const editButton = page.getByRole("button", { name: /edit compose/i });
    if (await editButton.isEnabled().catch(() => false)) {
      await editButton.click();
      await expect(page.getByRole("button", { name: /save draft/i })).toBeVisible();
      await expect(page.locator(".editor-files")).toContainText("compose.yaml");
      await page.getByRole("button", { name: /close editor/i }).click();
    }
  }

  await page.locator('a[aria-label="Hosts"]').first().click();
  await expect(page).toHaveURL(/\/hosts$/);
  await expect(page.getByRole("heading", { name: /^hosts$/i }).first()).toBeVisible();
  await expect(page.locator(".host-card").first()).toBeVisible();

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: /settings/i }).first()).toBeVisible();
  await expect(page.getByRole("tab", { name: "Authentication" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Mail" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Notifications" })).toBeVisible();
  await page.getByRole("tab", { name: "Backup" }).click();
  await expect(page.getByRole("heading", { name: "Backups", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /run backup/i })).toBeVisible();
  await page.getByRole("tab", { name: "Appearance" }).click();
  await page.getByRole("button", { name: /^Iris/ }).first().click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.palette)).toBe("iris");
  await expect(page.getByRole("button", { name: /^Iris/ }).first()).toHaveAttribute("data-active", "true");
  await page.getByRole("button", { name: /^Glacier/ }).first().click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.palette)).toBe("glacier");
});

test("tails container logs and filters them", async ({ page }) => {
  await login(page);
  await page.goto("/logs");
  await expect(page.locator(".logs-page-head h1")).toHaveText("Logs");
  await expect(page.locator(".log-pane")).toHaveCount(1);

  if (await page.locator(".log-row").count() === 0) {
    test.skip(true, "No running container logs are available.");
    return;
  }

  const firstMessage = await page.locator(".log-message").first().innerText();
  const compact = firstMessage.replace(/\s+/g, "");
  if (!compact) {
    test.skip(true, "The first log message has no text to filter.");
    return;
  }
  const token = compact.slice(0, 8);
  await page.getByPlaceholder("Filter logs").first().fill(token);
  await expect(page.locator(".log-message mark").first()).toBeVisible();
  await expect(page.locator(".log-match-count").first()).not.toHaveText("0");

  const pause = page.getByRole("button", { name: "Pause logs" }).first();
  if (await pause.count() > 0) {
    await pause.click();
    await expect(page.locator(".log-state").first()).toHaveText("PAUSED");
    await page.getByRole("button", { name: "Resume logs" }).first().click();
    await expect(page.locator(".log-state").first()).toHaveText("LIVE");
  }

  if (await page.locator(".logs-source-row").count() >= 2) {
    await page.locator(".logs-source-main").nth(1).click();
    await expect(page.locator(".log-pane")).toHaveCount(2);
    await page.locator(".log-pane").first().getByRole("button", { name: /focus this pane/i }).click();
    await expect(page.locator(".log-pane")).toHaveCount(1);
    await page.getByRole("button", { name: /show all panes/i }).click();
    await expect(page.locator(".log-pane")).toHaveCount(2);
  }
});

test("creates a scoped key and calls MCP", async ({ page }) => {
  await login(page);

  const keyResponse = await page.request.post("/api/keys", {
    data: {
      name: "e2e-mcp",
      scopes: ["mcp:read", "stacks:read", "hosts:read", "logs:read"],
    },
  });
  expect(keyResponse.status()).toBe(200);
  const key = await keyResponse.json();
  expect(key.secret).toMatch(/^cetus_/);

  const mcpResponse = await page.request.post("/mcp", {
    headers: { Authorization: `Bearer ${key.secret}` },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  expect(mcpResponse.status()).toBe(200);
  const mcp = await mcpResponse.json();
  const toolNames = mcp.result.tools.map((tool: { name: string }) => tool.name);
  expect(toolNames).toContain("list_stacks");
  expect(toolNames).toContain("get_stack");
  expect(toolNames).toContain("get_stack_compose");
  expect(toolNames).not.toContain("deploy_stack");
  expect(toolNames).not.toContain("delete_stack");

  const callResponse = await page.request.post("/mcp", {
    headers: { Authorization: `Bearer ${key.secret}` },
    data: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_stacks", arguments: {} } },
  });
  expect(callResponse.status()).toBe(200);
  const call = await callResponse.json();
  expect(call.result.content[0].text).toBeTruthy();

  const prematureDelete = await page.request.delete(`/api/keys/${key.summary.id}/permanent`);
  expect(prematureDelete.status()).toBe(422);

  const revoke = await page.request.delete(`/api/keys/${key.summary.id}`);
  expect(revoke.status()).toBe(200);

  const remove = await page.request.delete(`/api/keys/${key.summary.id}/permanent`);
  expect(remove.status()).toBe(200);
  const remaining = await page.request.get("/api/keys");
  const remainingKeys = await remaining.json();
  expect(remainingKeys.some((entry: { id: string }) => entry.id === key.summary.id)).toBe(false);
});

test("creates and removes a backup", async ({ page }) => {
  await login(page);
  const created = await page.request.post("/api/backups");
  expect(created.status()).toBe(200);
  const backup = await created.json();
  expect(backup.status).toBe("complete");
  expect(backup.size).toBeGreaterThan(0);

  const listed = await page.request.get("/api/backups");
  expect(listed.status()).toBe(200);
  const backups = await listed.json();
  expect(backups.some((entry: { id: string }) => entry.id === backup.id)).toBe(true);

  const archive = await page.request.get(`/api/backups/${backup.id}/download`);
  expect(archive.status()).toBe(200);
  expect(archive.headers()["content-type"]).toContain("application/gzip");

  const refused = await page.request.delete(`/api/backups/${backup.id}`);
  expect(refused.status()).toBe(422);
  const removed = await page.request.delete(`/api/backups/${backup.id}?confirm=true`);
  expect(removed.status()).toBe(200);
  const after = await page.request.get("/api/backups");
  const remaining = await after.json();
  expect(remaining.some((entry: { id: string }) => entry.id === backup.id)).toBe(false);
});

test("provisions a user with a one-time invite", async ({ page }) => {
  await login(page);
  const email = `e2e-invite-${Date.now()}@cetus.local`;
  const password = "e2e-invite-pass-123";

  const created = await page.request.post("/api/invites", {
    data: { email, name: "E2E Invite", role: "operator" },
  });
  expect(created.status()).toBe(200);
  const invite = await created.json();

  await page.goto(`/invite/${invite.token}`);
  await expect(page.getByRole("heading", { name: /create your account/i })).toBeVisible();
  await expect(page.locator("#invite-email")).toHaveValue(email);
  await page.locator("#invite-password").fill(password);
  await page.locator("#invite-confirm").fill(password);
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText("Account created")).toBeVisible();

  await signIn(page, email, password);
  await page.goto("/settings");
  await expect(page.getByRole("tab", { name: "Appearance" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Access" })).toHaveCount(0);

  await page.context().clearCookies();
  const adminLogin = await page.request.post("/api/auth/sign-in/email", {
    data: {
      email: process.env.CETUS_E2E_EMAIL ?? "admin@cetus.local",
      password: process.env.CETUS_E2E_PASSWORD ?? "cetus-admin",
    },
  });
  expect(adminLogin.status()).toBe(200);
  const users = await page.request.get("/api/users");
  expect(users.status()).toBe(200);
  const provisioned = (await users.json()).find((user: { email: string }) => user.email === email);
  expect(provisioned).toBeTruthy();
  const removed = await page.request.delete(`/api/users/${provisioned.id}`);
  expect(removed.status()).toBe(200);
});

test("rejects an anonymous API request", async ({ page }) => {
  const response = await page.request.get("/api/stacks");
  expect(response.status()).toBe(401);
});
