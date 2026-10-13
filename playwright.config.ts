import { defineConfig } from "@playwright/test";

// The full product loop, against the real model and the demo database:
// connect → discover → review → certify → reuse. Uses its own state database, recreated per run.
export default defineConfig({
  testDir: "e2e",
  timeout: 240_000,
  expect: { timeout: 15_000 },
  use: { baseURL: "http://localhost:3210", viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: "dropdb --if-exists crema_e2e && createdb crema_e2e && DATABASE_URL=postgresql://localhost:5432/crema_e2e tsx bin/migrate.ts && next start --port 3210",
    url: "http://localhost:3210/api/state",
    reuseExistingServer: false,
    env: { DATABASE_URL: "postgresql://localhost:5432/crema_e2e", APP_URL: "http://localhost:3210" },
  },
});
