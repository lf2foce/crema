import { expect, test } from "@playwright/test";

// A tab left open across a deploy runs the old build; it should say so instead of misbehaving.
test("a tab from an older build is told to reload", async ({ page }) => {
  await page.goto("/sign-in");
  const first = (await page.getByRole("button", { name: /^(Create admin account|Sign in)$/ }).textContent()) === "Create admin account";
  if (first) await page.getByLabel("Name").fill("E2E Reviewer");
  await page.getByLabel("Email").fill("reviewer@example.com");
  await page.getByLabel("Password").fill("e2e-password-1");
  await page.getByRole("button", { name: first ? "Create admin account" : "Sign in" }).click();
  await expect(page).not.toHaveURL(/sign-in/);
  await page.goto("/projects");
  await expect(page.getByText("A new version of Crema is available.")).toHaveCount(0); // same build: quiet
  // the server now answers with a different build id, as after a deploy
  await page.route("**/api/version", (r) => r.fulfill({ json: { build: "newer" } }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("A new version of Crema is available.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
});
