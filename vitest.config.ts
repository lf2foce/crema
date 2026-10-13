import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } }, // same as tsconfig paths
  test: { include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false },
});
