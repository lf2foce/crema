import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

// Hosting the production way (`next start`): no "use this machine" shortcut, a server added from a
// superuser login that Crema trades for its own limited provisioner. Uses the local cluster.
const ADMIN_URL = "postgresql://localhost:5432/postgres";
const DB = "e2e_shop";
const psql = (sql: string) => execFileSync("psql", ["-d", "postgres", "-Atc", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const cleanup = () => {
  for (const d of [`${DB}_dev`, DB]) {
    psql(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    psql(`DROP ROLE IF EXISTS ${d}_owner`); psql(`DROP ROLE IF EXISTS ${d}_crema`);
  }
};
// as the app would: tables belong to the database's owner login
const asOwner = (db: string, sql: string) => execFileSync("psql", ["-U", `${db}_owner`, "-d", db, "-Atc", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
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
  // a natural random name, Neon-style; ↻ gives another
  const suggested = page.locator(".use-note .mono").first();
  await expect(suggested).toHaveText(/^[a-z]+_[a-z]+_[a-z0-9]{4}$/);
  const firstName = await suggested.textContent();
  await page.getByRole("button", { name: "Shuffle" }).click();
  await expect(suggested).not.toHaveText(firstName!);
  // editable before creation; reserved and taken names are refused as you type
  await page.getByRole("button", { name: "Edit" }).click();
  const dbField = page.getByLabel("Database name");
  await dbField.fill("postgres");
  await expect(page.getByText("“postgres” is reserved.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create database" })).toBeDisabled();
  await dbField.fill("template_taken_probe");
  psql("CREATE ROLE template_taken_probe_owner");
  await dbField.fill("template_taken_prob"); await dbField.fill("template_taken_probe"); // re-check after the role exists
  await expect(page.getByText("“template_taken_probe_owner” already exists on this server.")).toBeVisible();
  psql("DROP ROLE template_taken_probe_owner");
  await dbField.fill(DB);
  await page.getByRole("button", { name: "Create database" }).click();
  await expect(page.getByText(`${DB} is ready.`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "E2E Shop" })).toBeVisible();
  await expect(page.getByText("on db.example.com")).toBeVisible();
  await expect(page.locator(".conn-code")).toContainText(`postgresql://${DB}_owner:••••••••••••@db.example.com:6543/${DB}?sslmode=require`);
  expect(psql(`SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${DB}'`)).toBe(`${DB}_owner`);

  // a dev branch: a snapshot of main, copied by the worker, with its own login
  asOwner(DB, "CREATE TABLE orders (id serial PRIMARY KEY, total int); INSERT INTO orders (total) VALUES (10), (20)");
  await page.getByRole("button", { name: "New branch" }).click();
  await expect(page.getByLabel("Branch name")).toHaveValue("dev");
  await expect(page.getByText(`Database ${DB}_dev`)).toBeVisible();
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByRole("heading", { name: "E2E Shop · dev" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Copied from E2E Shop" })).toBeVisible();
  await expect(page.getByText(/Schema and data, .*ago|Schema and data, just now/)).toBeVisible({ timeout: 60_000 });
  expect(asOwner(`${DB}_dev`, "SELECT count(*) FROM orders")).toBe("2");
  await expect(page.locator(".conn-code")).toContainText(`postgresql://${DB}_dev_owner:`);
  // main can't be deleted while it has branches; delete the branch first
  await page.getByRole("button", { name: /^E2E Shop/ }).click();
  await expect(page.getByText("Delete its branches first (dev).")).toBeVisible();
  await page.getByRole("button", { name: /^↳ dev/ }).click();
  page.once("dialog", (d) => d.accept(`${DB}_dev`));
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText(`Deleted ${DB}_dev.`)).toBeVisible();

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
