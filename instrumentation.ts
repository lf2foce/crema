// Runs once when the web server starts. While Crema has no admin, issue a one-time setup link and
// print it (core/setupCode.ts). Never blocks startup: a database that isn't ready is just logged.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { database } = await import("./core/db");
    const { issueSetupCode, setupBanner } = await import("./core/setupCode");
    const { APP_URL, setupPolicy } = await import("./lib/auth");
    if (setupPolicy().fixedToken) return; // CREMA_SETUP_TOKEN is the way in
    const db = database();
    await db.ready;
    const code = await issueSetupCode(db.pool);
    if (code) console.log(setupBanner(APP_URL, code));
  } catch (e) {
    console.error("[Crema] Could not issue a setup link:", (e as Error).message);
  }
}
