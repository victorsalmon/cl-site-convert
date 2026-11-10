import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // A suite that collects nothing is a broken suite, not a passing one.
    passWithNoTests: false,
  },
});
