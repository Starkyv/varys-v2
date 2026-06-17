import { resolve } from "node:path";
import { config } from "dotenv";

/**
 * Load environment variables from a `.env` file so the documented vars (DATABASE_URL,
 * VARYS_AUTH_METHODS, GOOGLE_CLIENT_ID/SECRET, VARYS_AUTH_ALLOWED_DOMAINS, …) actually
 * take effect. There is no other loader — the pnpm dev scripts only provide inline
 * defaults — so without this a `.env` file is silently ignored. Values present in `.env`
 * win (`override: true`); vars not in `.env` keep their dev-script / shell value.
 *
 * MUST be imported FIRST in `main.ts`, before any module that reads `process.env` at load
 * time (e.g. `./auth/auth`, whose `authMethods` is computed at import).
 *
 * The dev/start process runs from the package dir (apps/api), so the repo-root `.env` is
 * two levels up. A `.env` in the cwd is loaded last (so it, or the root file when cwd is
 * the repo root, wins) — covering both how the API is launched.
 */
config({ path: resolve(process.cwd(), "../../.env"), override: true });
config({ override: true });
