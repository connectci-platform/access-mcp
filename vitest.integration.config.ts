import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config";

// Spread rather than mergeConfig: mergeConfig concatenates include/exclude,
// which would keep the base suite and its integration exclude.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ["**/*.integration.test.ts"],
    exclude: ["node_modules", "dist", ".worktrees"],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
