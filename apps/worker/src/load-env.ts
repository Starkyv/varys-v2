import { resolve } from "node:path";
import { config } from "dotenv";

/**
 * Load `.env` so the worker shares the same DATABASE_URL / VARYS_STORAGE_DIR as the API
 * (they MUST match — the worker writes the run artifacts the API serves). There's no
 * other loader; the pnpm dev script only provides inline defaults. Values in `.env` win.
 *
 * Imported FIRST in `main.ts`, before anything reads `process.env`. The process runs from
 * the package dir (apps/worker), so the repo-root `.env` is two levels up; a `.env` in the
 * cwd is loaded last.
 */
config({ path: resolve(process.cwd(), "../../.env"), override: true });
config({ override: true });
