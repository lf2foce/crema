import { expect, test } from "@playwright/test";

test("set up → connect → discover → review → certify → reuse", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const request = page.request; // shares the signed-in session

  // 0. nobody can use an empty instance before an admin exists; the first account is the admin
  expect((await request.get("/api/state")).status()).toBe(401);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByRole("heading", { name: "Set up Crema" })).toBeVisible();
  await page.getByLabel("Name").fill("E2E Reviewer");
  await page.getByLabel("Email").fill("reviewer@example.com");
  await page.getByLabel("Password").fill("e2e-password-1");
  await page.getByRole("button", { name: "Create admin account" }).click();

  // 1. connect
  await expect(page).not.toHaveURL(/sign-in/);
  await expect(page.getByRole("heading", { name: /Connect a database/ })).toBeVisible();
  await page.getByRole("button", { name: "try the demo database" }).click();
  // the status bar knows the database you just made (it once showed the first one in the list)
  await expect(page).toHaveURL(/\/projects\/[^/]+\/metrics/);
  await expect(page.getByLabel("Database", { exact: true })).toHaveValue(new URL(page.url()).pathname.split("/")[2]);

  // 2. discover: the live log, then the review queue
  await expect(page.getByText("Reading your schema")).toBeVisible();
  await expect(page.getByRole("heading", { name: /We found \d+ metrics in your business/ })).toBeVisible({ timeout: 200_000 });

  // the slim header: crema, all metrics, and business & API · database on the right; the picker lives in the sidebar
  const header = page.locator("header.statusbar");
  await expect(header.getByRole("link", { name: "crema" })).toBeVisible();
  await expect(header.getByRole("link", { name: "all metrics" })).toBeVisible();
  await expect(header.getByRole("link", { name: "business & API" })).toBeVisible();
  await expect(header.getByRole("link", { name: "database", exact: true })).toBeVisible();
  await expect(header.getByLabel("Database", { exact: true })).toHaveCount(0);
  const nav = page.getByRole("complementary", { name: "Navigation" });
  await expect(nav.getByLabel("Database", { exact: true })).toBeVisible();
  // the sidebar: "+ New metric" above the list; the counts above the line, the person below it, at the bottom
  const picker = await nav.getByLabel("Database", { exact: true }).boundingBox();
  const newMetric = await nav.getByRole("link", { name: "+ New metric" }).boundingBox();
  const firstItem = await nav.locator(".nav-item").first().boundingBox();
  expect(picker!.y).toBeLessThan(newMetric!.y);
  expect(newMetric!.y).toBeLessThan(firstItem!.y);
  const stats = await nav.getByText(/\d+ proposed · \d+ certified/).boundingBox();
  const line = await nav.locator(".nav-foot").boundingBox();
  const signOut = await nav.getByRole("button", { name: "sign out" }).boundingBox();
  const navBox = await nav.boundingBox();
  expect(stats!.y + stats!.height).toBeLessThanOrEqual(line!.y + 1); // the counts sit above the line
  expect(signOut!.y).toBeGreaterThanOrEqual(line!.y); // the person below it
  expect(signOut!.y + signOut!.height).toBeGreaterThan(navBox!.y + navBox!.height - 40);

  // 3. review: open the first (most contested) proposal, with evidence on real data
  await page.getByRole("link", { name: /Review first one/ }).click();
  await expect(page.getByText("Needs your decision")).toBeVisible();
  await expect(page.getByText("Checked by Crema against your data, not by the model")).toBeVisible();
  await expect(page.getByText("Observed in your database")).toBeVisible();
  await expect(page.getByText("Inferred business meaning")).toBeVisible();
  const name = await page.getByLabel("Metric name").inputValue();

  // nothing is consumable before a human decides
  expect((await (await request.get("/api/v1/metrics")).json()).metrics).toEqual([]);

  // 4. certify: blocked without a name, then done
  // a contested metric can't be certified until the reviewer answers the question in words
  const contested = await page.getByText("Only you can decide").count();
  if (contested) {
    await expect(page.getByRole("button", { name: "Answer 1 question to certify" })).toBeDisabled();
    await page.locator(".opt-btn").first().click();
  }
  const certify = page.getByRole("button", { name: /^Certify/ });
  await expect(page.getByText("Signing as E2E Reviewer")).toBeVisible();
  await page.getByRole("button", { name: "Add a note" }).click();
  await page.getByPlaceholder("Note for the audit log (optional)").fill("checked in e2e");
  await certify.click();

  // 5. reuse: the metric view computes live through the public API
  await expect(page.getByText(/^Certified by/)).toBeVisible();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText("computed live through the API")).toBeVisible();
  await page.getByRole("tab", { name: "AI agents" }).click();
  await expect(page.getByText(/\/api\/mcp/).first()).toBeVisible();

  const { metrics } = await (await request.get("/api/v1/metrics")).json();
  expect(metrics).toHaveLength(1);
  expect(metrics[0]).toMatchObject({ name, version: 1, certifiedBy: "E2E Reviewer" });
  // a metric is addressed by its database: /api/v1/metrics/<database>/<key>
  expect(metrics[0].ref).toBe(`${metrics[0].source}/${metrics[0].key}`);
  const values = await (await request.get(`/api/v1/metrics/${metrics[0].ref}/values?grain=month`)).json();
  expect(values).toMatchObject({ trust: "certified", certifiedBy: "E2E Reviewer", source: metrics[0].source });
  expect(values.points.length).toBeGreaterThanOrEqual(12);
  expect(values.points.at(-1).partial).toBe(true);

  // the schema map shows every table and what reads it
  const slug = new URL(page.url()).pathname.split("/")[2]; // /projects/<database>/metrics/<metric>
  expect(new URL(page.url()).pathname).toMatch(/^\/projects\/[^/]+\/metrics\/[^/]+$/);
  await page.goto(`/projects/${slug}/schema`);
  await expect(page.getByRole("button", { name: "accounts table" })).toBeVisible();
  await page.getByRole("button", { name: "subscriptions table" }).click();
  await expect(page.getByRole("heading", { name: "Read by" })).toBeVisible();

  // the SQL editor runs read-only queries and refuses writes
  await page.getByRole("link", { name: "SQL editor" }).click();
  await page.getByLabel("SQL").fill("select status, count(*) as n from public.subscriptions group by 1");
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.getByText(/\d+ rows? · \d+ ms/)).toBeVisible();
  await page.getByLabel("SQL").fill("delete from public.plans");
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.getByText(/must be a single statement: SELECT or WITH/)).toBeVisible();

  await page.screenshot({ path: "e2e/last-run.png" });
  expect(errors).toEqual([]);
});

