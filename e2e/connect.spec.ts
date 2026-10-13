import { expect, test } from "@playwright/test";

// The Connect page: what a database is labelled is chosen or left alone, and the demo is offered.
test("connect: three optional labels that toggle, the demo, and nothing else in the way", async ({ page }) => {
  await page.goto("/sign-in");
  const first = (await page.getByRole("button", { name: /^(Create admin account|Sign in)$/ }).textContent()) === "Create admin account";
  if (first) await page.getByLabel("Name").fill("E2E Reviewer");
  await page.getByLabel("Email").fill("reviewer@example.com");
  await page.getByLabel("Password").fill("e2e-password-1");
  await page.getByRole("button", { name: first ? "Create admin account" : "Sign in" }).click();
  await expect(page).not.toHaveURL(/sign-in/);
  await page.goto("/connect");

  const labels = page.getByRole("group", { name: /What is this database/ });
  await expect(labels.getByRole("button")).toHaveText(["production", "staging", "development"]); // no "not labelled" option
  for (const b of await labels.getByRole("button").all()) await expect(b).toHaveAttribute("aria-pressed", "false"); // unlabelled by default
  const prod = labels.getByRole("button", { name: "production" });
  await prod.click();
  await expect(prod).toHaveAttribute("aria-pressed", "true");
  await labels.getByRole("button", { name: "staging" }).click(); // choosing another moves the choice
  await expect(prod).toHaveAttribute("aria-pressed", "false");
  await labels.getByRole("button", { name: "staging" }).click(); // clicking it again clears it
  await expect(labels.getByRole("button", { name: "staging" })).toHaveAttribute("aria-pressed", "false");

  await expect(page.getByText("Never writes to your database")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /open demo/ })).toBeVisible(); // CREMA_DEMO_URL is set for the e2e run
});
