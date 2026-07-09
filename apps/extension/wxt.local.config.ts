import { defineConfig } from "wxt";
import base from "./wxt.config";

// Local-only build of the recorder: distinct name + output dir so it loads as a SEPARATE
// unpacked extension (its own Chrome ID) alongside the hosted one. Point it at the local
// API with `WXT_API_BASE=http://localhost:4000 npx wxt build -c wxt.local.config.ts`.
// Output lands in `.output/local/chrome-mv3` (under the gitignored `.output/`).
export default defineConfig({
  ...base,
  outDir: ".output/local",
  manifest: {
    ...base.manifest,
    name: "Varys Recorder (LOCAL)",
  },
});
