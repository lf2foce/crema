import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Match Next's development precedence; exported environment always wins.
// Containers have no local env files (excluded from the image).
export function loadLocalEnv(root = process.cwd(), mode = process.env.NODE_ENV || "development") {
  for (const file of [`.env.${mode}.local`, ...(mode === "test" ? [] : [".env.local"]), `.env.${mode}`, ".env"]) {
    const path = resolve(root, file);
    if (existsSync(path)) process.loadEnvFile(path);
  }
}
