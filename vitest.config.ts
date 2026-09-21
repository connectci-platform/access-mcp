import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    coverage: {
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "dist/", "**/*.d.ts", "**/*.config.*", "**/index.ts"],
    },
  },
  resolve: {
    alias: {
      // Subpaths first — alias matching is order-sensitive, and the bare entry
      // below would otherwise shadow the more specific "@access-mcp/shared/..."
      // entries. Points at testkit source so vitest resolves it the same way
      // it resolves the bare import (src, not dist), independent of
      // package.json "exports".
      "@access-mcp/shared/testkit/filters-applied": resolve(
        __dirname,
        "./packages/shared/src/filters-applied-conformance"
      ),
      "@access-mcp/shared/testkit": resolve(
        __dirname,
        "./packages/shared/src/write-contract-testkit"
      ),
      "@access-mcp/shared": resolve(__dirname, "./packages/shared/src"),
    },
  },
});
