import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

// Hosting the production way (`next start`): no "use this machine" shortcut, a server added from a
// superuser login that Crema trades for its own limited provisioner. Uses the local cluster.
const ADMIN_URL = "postgresql://localhost:5432/postgres";
const DB = "e2e_shop";
const psql = (sql: string) => execFileSync("psql", ["-d", "postgres", "-Atc", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const cleanup = () => {
  for (const d of [`${DB}_staging`, `${DB}_development`, DB]) {
    psql(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    psql(`DROP ROLE IF EXISTS ${d}_owner`); psql(`DROP ROLE IF EXISTS ${d}_crema`);
  }
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
  // the Servers section is collapsed while there's just the one server
  const openServers = async () => {
    const d = page.locator("details.side-servers");
    if (!(await d.evaluate((e: HTMLDetailsElement) => e.open))) await d.locator("summary").click();
  };
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
  await page.goto("/projects");
  await page.getByRole("button", { name: "+ New project" }).click(); // the sidebar's: there whatever else exists (the full run has a demo already)
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

  // a project for an app: production, with its connection string on the public address, TLS required
  await page.getByRole("button", { name: "+ New project" }).click();
  await page.getByLabel("Name").fill("E2E Shop");
  // a natural random name, Neon-style; ↻ gives another
  const suggested = page.locator(".use-note .mono").first();
  await expect(suggested).toHaveText(/^[a-z]+_[a-z]+_[a-z0-9]{4}$/);
  const firstName = await suggested.textContent();
  await page.getByRole("button", { name: "Shuffle" }).click();
  await expect(suggested).not.toHaveText(firstName!);
  // editable before creation (what's refused, reserved or taken, is covered by the unit and service tests)
  await page.getByRole("button", { name: "Edit" }).click();
  const dbField = page.getByLabel("Production database name");
  await dbField.fill(DB);
  // a development branch alongside is on by default
  await expect(page.getByLabel(/Also create a development branch/)).toBeChecked();
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByText("E2E Shop is ready, with a development branch.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "E2E Shop" })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Branches" });
  await expect(page).toHaveURL(new RegExp(`/projects/${DB}$`)); // a real path, and a database is addressed by its name
  await expect(tabs.getByRole("link", { name: /^production/ })).toContainText("PROD");
  await expect(tabs.getByRole("link", { name: /^development/ })).toContainText("DEV");
  // the sidebar groups by project, branches under it
  await expect(page.locator(".proj-name", { hasText: "E2E Shop" })).toHaveCount(1);
  await expect(page.getByText("on db.example.com")).toBeVisible();
  await expect(page.locator(".conn-code")).toContainText(`postgresql://${DB}_owner:••••••••••••@db.example.com:6543/${DB}?sslmode=require`);
  // one click from the connection to its tables, SQL editor and metrics
  const sections = page.getByRole("navigation", { name: "Section" });
  await expect(sections.getByRole("link", { name: "Tables" })).toHaveAttribute("href", `/projects/${DB}/tables`);
  await expect(sections.getByRole("link", { name: "SQL editor" })).toHaveAttribute("href", `/projects/${DB}/sql`);

  // a real route: its own page, with the PROD badge and the tab bar, and back goes where you came from
  await sections.getByRole("link", { name: "Tables" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${DB}/tables$`));
  await expect(page.getByRole("navigation", { name: "Database" })).toContainText("PROD");
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${DB}$`));
  await expect(page.getByRole("heading", { name: "E2E Shop" })).toBeVisible();
  await page.reload(); // Enter on the URL is a real load now
  await expect(page.getByRole("heading", { name: "E2E Shop" })).toBeVisible();

  // + Branch: a staging branch (the copy itself is the service test's job)
  await expect(tabs.getByRole("link", { name: /^development/ })).toBeVisible();
  await tabs.getByRole("button", { name: "+ Branch" }).click();
  await page.getByRole("tab", { name: "Staging" }).click();
  await expect(page.getByLabel("Branch name")).toHaveValue("staging");
  await expect(page.getByText(`Database ${DB}_staging`)).toBeVisible();
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(tabs.getByRole("link", { name: /^staging/ })).toContainText("STG");
  await expect(page.getByRole("heading", { name: "Copied from production" })).toBeVisible();
  await expect(page.getByText(/Schema only, (just now|.*ago)/)).toBeVisible({ timeout: 60_000 }); // copied: deleting during a copy is refused
  await expect(page.locator(".conn-code")).toContainText(`postgresql://${DB}_staging_owner:`);
  // the page says what Crema does with development
  await tabs.getByRole("link", { name: /^development/ }).click();
  await expect(page.getByText(/Crema doesn’t analyse development on its own/)).toBeVisible();
  // production can't be deleted while it has branches
  await tabs.getByRole("link", { name: /^production/ }).click();
  await expect(page.getByText(/Delete its branches first \(development, staging\)/)).toBeVisible();
  // delete the branches: the dialog shows exactly what to type; the button stays off until it matches
  await tabs.getByRole("link", { name: /^staging/ }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Type this to confirm")).toBeVisible();
  await expect(dialog.locator("code")).toHaveText(`${DB}_staging`);
  const confirmBtn = dialog.getByRole("button", { name: "Delete branch" });
  await expect(confirmBtn).toBeDisabled();
  await dialog.getByLabel(`Type ${DB}_staging to confirm`).fill(`${DB}_stagin`);
  await expect(confirmBtn).toBeDisabled();
  await dialog.getByLabel(`Type ${DB}_staging to confirm`).fill(`${DB}_staging`);
  await confirmBtn.click();
  await expect(page.getByText(`Deleted ${DB}_staging.`)).toBeVisible();
  await tabs.getByRole("link", { name: /^development/ }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByLabel(`Type ${DB}_development to confirm`).fill(`${DB}_development`);
  await page.getByRole("dialog").getByRole("button", { name: "Delete branch" }).click();
  await expect(page.getByText(`Deleted ${DB}_development.`)).toBeVisible();

  // renaming changes the project's name everywhere, never the database
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("E2E Shop App");
  await page.getByRole("dialog").getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("heading", { name: "E2E Shop App" })).toBeVisible();
  await expect(page.locator(".conn-code")).toContainText(`/${DB}?sslmode=require`);

  // the page fills the window: no white strip under it
  const gap = await page.evaluate(() => window.innerHeight - document.querySelector(".hostedpage")!.getBoundingClientRect().bottom);
  expect(Math.abs(gap)).toBeLessThanOrEqual(1);

  // a server with databases can't be removed
  await openServers();
  await page.getByRole("button", { name: /^db\.example\.com/ }).click();
  await expect(page.getByRole("button", { name: "Remove" })).toBeDisabled();

  // delete the database (typed confirmation), then the server
  await page.getByRole("button", { name: /^production/ }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByLabel(`Type ${DB} to confirm`).fill(DB);
  await page.getByRole("dialog").getByRole("button", { name: "Delete project" }).click();
  await expect(page.getByText(`Deleted ${DB}.`)).toBeVisible();

  await openServers();
  await page.getByRole("button", { name: /^db\.example\.com/ }).click();
  await page.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove server" }).click();
  await expect(page.getByText(`Its login ${provisioner} is still on the server`)).toBeVisible();
  await expect(page.getByRole("button", { name: /^db\.example\.com/ })).toHaveCount(0);

  expect(errors).toEqual([]);
});
