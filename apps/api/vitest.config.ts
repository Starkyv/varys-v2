import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.spec.ts", "src/**/*.spec.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Testcontainers spins up real Postgres; keep files serial to avoid contention.
    fileParallelism: false,
  },
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
});
