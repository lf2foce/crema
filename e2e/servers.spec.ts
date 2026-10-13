import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

// Hosting the production way (`next start`): no "use this machine" shortcut, a server added from a
// superuser login that Crema trades for its own limited provisioner. Uses the local cluster.
const ADMIN_URL = "postgresql://localhost:5432/postgres";
const DB = "app_e2e_shop";
const psql = (sql: string) => execFileSync("psql", ["-d", "postgres", "-Atc", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const cleanup = () => {
  psql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  psql(`DROP ROLE IF EXISTS ${DB}_owner`); psql(`DROP ROLE IF EXISTS ${DB}_crema`);
};
let provisioners: string[] = [];

test.beforeAll(() => {
  cleanup();
  provisioners = psql("SELECT string_agg(rolname, ' ') FROM pg_roles WHERE rolname LIKE 'crema\\_provisioner\\_%'").split(" ").filter(Boolean);
});
test.afterAll(() => {
  cleanup();
  // only the provisioner this run created
  for (const r of psql("SELECT string_agg(rolname, ' ') FROM pg_roles WHERE rolname LIKE 'crema\\_provisioner\\_%'").split(" ").filter(Boolean)) {
    if (!provisioners.includes(r)) psql(`DROP ROLE IF EXISTS ${r}`);
  }
});

test("add a server → create a database → connect → delete → remove the server", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // signed in as the admin (first account on a fresh instance, or the one an earlier spec created)
  await page.goto("/sign-in");
  const submit = page.getByRole("button", { name: /^(Create admin account|Sign in)$/ });
  await expect(submit).toBeVisible(); // wait for the form before deciding which one it is
  const first = (await submit.textContent()) === "Create admin account";
  if (first) await page.getByLabel("Name").fill("E2E Reviewer");
  await page.getByLabel("Email").fill("reviewer@example.com");
  await page.getByLabel("Password").fill("e2e-password-1");
  await page.getByRole("button", { name: first ? "Create admin account" : "Sign in" }).click();
  await expect(page).not.toHaveURL(/sign-in/);

  // no server yet: creating a database starts by adding one; production offers no shortcut
  await page.goto("/#databases");
  await page.getByRole("button", { name: "Create a new one" }).click();
  await expect(page.getByRole("heading", { name: "Add a hosting server" })).toBeVisible();
  await page.getByLabel("Admin connection string").fill(ADMIN_URL);
  await page.getByLabel("Address apps use").fill("db.example.com:6543");
  await page.getByRole("button", { name: "Add server" }).click();
  await expect(page.getByText(/Crema created its own login crema_provisioner_[0-9a-f]{6}; the superuser password wasn’t kept/)).toBeVisible();

  // the server page: Crema's limited login, reachable
  await expect(page.getByRole("heading", { name: "db.example.com" })).toBeVisible();
  await expect(page.getByText("reachable")).toBeVisible();
  const provisioner = (await page.locator(".hosted-card .mono").first().textContent())!;
  expect(provisioner).toMatch(/^crema_provisioner_/);
  expect(psql(`SELECT rolsuper::text || rolcreatedb::text || rolcreaterole::text FROM pg_roles WHERE rolname = '${provisioner}'`)).toBe("falsetruetrue");

  // a database for an app, with its connection string on the public address, TLS required
  await page.getByRole("button", { name: "+ New database" }).click();
  await page.getByLabel("Name").fill("E2E Shop");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText(`${DB} is ready.`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "E2E Shop" })).toBeVisible();
  await expect(page.getByText("on db.example.com")).toBeVisible();
  await expect(page.locator(".conn-code")).toContainText(`postgresql://${DB}_owner:••••••••••••@db.example.com:6543/${DB}?sslmode=require`);
  expect(psql(`SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${DB}'`)).toBe(`${DB}_owner`);

  // a server with databases can't be removed
  await page.getByRole("button", { name: /^db\.example\.com/ }).click();
  await expect(page.getByRole("button", { name: "Remove" })).toBeDisabled();

  // delete the database (typed confirmation), then the server
  await page.getByRole("button", { name: /^E2E Shop/ }).click();
  page.once("dialog", (d) => d.accept(DB));
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText(`Deleted ${DB}.`)).toBeVisible();
  expect(psql(`SELECT count(*) FROM pg_database WHERE datname = '${DB}'`)).toBe("0");

  await page.getByRole("button", { name: /^db\.example\.com/ }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText(`Its login ${provisioner} is still on the server`)).toBeVisible();
  await expect(page.getByRole("button", { name: /^db\.example\.com/ })).toHaveCount(0);

  expect(errors).toEqual([]);
});
