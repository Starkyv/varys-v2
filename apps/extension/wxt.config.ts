import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Varys Recorder",
    description: "Record visual-regression tests for Varys.",
    // No default_popup: clicking the icon toggles the in-page overlay (via the
    // background worker), so the controls stay put when you click the page.
    action: { default_title: "Varys recorder — click to toggle the panel" },
    // `cookies` lets the background read whether a Varys session cookie exists, to show
    // a live signed-in / signed-out marker in the recorder panel.
    permissions: ["tabs", "activeTab", "storage", "scripting", "cookies"],
    host_permissions: ["<all_urls>"],
  },
});
