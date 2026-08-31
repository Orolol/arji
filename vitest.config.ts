import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    // Several agent sessions run this suite concurrently on the same
    // machine; without a cap each run grabs one worker per core and the
    // runs starve each other (and the dev server).
    maxWorkers: 4,
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx,mjs}"],
    // The checkout hosts foreign trees that carry their own test copies:
    // .claude/worktrees (agent session snapshots), the projects/ clone
    // workspace, and data/ (session logs, uploads). Running their stale
    // suites against this repo's setup produces phantom failures.
    exclude: [
      "**/node_modules/**",
      "**/.next/**",
      ".claude/**",
      "projects/**",
      "data/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        ".next/",
        "**/*.config.{ts,mts,mjs}",
        "vitest.setup.ts",
      ],
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./"),
    },
  },
});
