import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5200,
    // Same-origin in dev: proxy the API routes to the NestJS server so the SPA
    // can fetch /runs and load /artifacts without CORS (mirrors the prod ingress).
    proxy: Object.fromEntries(
      ["/runs", "/suite-runs", "/tests", "/environments", "/folders", "/tags", "/suites", "/artifacts"].map((p) => [
        p,
        { target: "http://localhost:4000", changeOrigin: true },
      ]),
    ),
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
