import { expect, test } from "@playwright/test";

// The Connect page stays compact: a connection string, the alternatives on one line, the three promises.
test("connect: one input and one action, the demo beside 'create one', the promises", async ({ page }) => {
  await page.goto("/sign-in");
  const first = (await page.getByRole("button", { name: /^(Create admin account|Sign in)$/ }).textContent()) === "Create admin account";
  if (first) await page.getByLabel("Name").fill("E2E Reviewer");
  await page.getByLabel("Email").fill("reviewer@example.com");
  await page.getByLabel("Password").fill("e2e-password-1");
  await page.getByRole("button", { name: first ? "Create admin account" : "Sign in" }).click();
  await expect(page).not.toHaveURL(/sign-in/);
  await page.goto("/connect");

  await expect(page.getByLabel("Postgres connection string")).toBeVisible();
  await expect(page.getByRole("button", { name: /connect & scan/ })).toBeVisible();
  // no label row and no demo row inside the box: what a database is gets set on its own page afterwards
  await expect(page.getByRole("group", { name: /What is this database/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /open demo/ })).toHaveCount(0);
  // the demo sits on the "No database yet?" line (CREMA_DEMO_URL is set for the e2e run)
  const alt = page.locator(".connect-alt");
  await expect(alt).toContainText("No database yet?");
  await expect(alt.getByRole("button", { name: "try the demo database" })).toBeVisible();
  await expect(page.getByText("Never writes to your database")).toBeVisible();
  await expect(page.getByText("No rows sent to the AI")).toBeVisible();
  await expect(page.getByText("A person certifies every metric")).toBeVisible();
});
