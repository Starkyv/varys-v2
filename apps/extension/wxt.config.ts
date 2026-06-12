import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Varys Recorder",
    description: "Record visual-regression tests for Varys.",
    permissions: ["tabs", "activeTab", "scripting"],
    host_permissions: ["<all_urls>"],
  },
});
