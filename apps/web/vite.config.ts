import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5200,
    // Same-origin in dev: proxy the API routes to the NestJS server so the SPA
    // can fetch /runs and load /artifacts without CORS (mirrors the prod ingress).
    // NOTE: every top-level API route prefix MUST be listed here. A path that isn't
    // proxied falls through to the SPA and returns index.html — which shows up as
    // "the API returned HTML" for that endpoint. Add new prefixes here.
    proxy: Object.fromEntries(
      ["/api/auth", "/auth-config", "/health", "/dashboard", "/runs", "/suite-runs", "/tests", "/drafts", "/environments", "/folders", "/tags", "/suites", "/artifacts", "/trace-viewer", "/mcp"].map((p) => [
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
