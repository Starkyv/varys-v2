# Shared image for the API and the worker.
#
# Both run the TypeScript workspace directly via `tsx` (the SAME runtime as
# `pnpm dev` — the workspace packages resolve their `main: src/index.ts`, so a
# tsc/`node dist` build is intentionally NOT used here), and both launch headless
# Chromium (the worker replays runs; the API drives the live-authoring preview),
# so the image bundles the Chromium browser + its OS libraries.
#
# The two Deployments differ only in working dir + command (apps/api vs
# apps/worker) — see deploy/k8s/.
FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Pin the browser cache location so the build-time install and the runtime agree.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# pnpm via corepack (version pinned by the root package.json "packageManager").
RUN corepack enable

# Full workspace install (incl. dev deps — `tsx` and the TS sources ARE the runtime).
# Copy the whole repo so every workspace package is present for tsx to resolve.
COPY . .
RUN pnpm install --frozen-lockfile

# Install the Chromium build matching the repo's Playwright + its apt dependencies.
RUN pnpm --filter @varys/runner exec playwright install --with-deps chromium

# Run unprivileged. Chromium is launched with --no-sandbox (set via VARYS_BROWSER_ARGS
# in the k8s ConfigMap), which is why a non-root user is safe here.
RUN useradd -m -u 10001 varys && chown -R varys:varys /app /ms-playwright
# Numeric USER so Kubernetes' runAsNonRoot check can verify it without a manifest override.
USER 10001

ENV NODE_ENV=production

# Overridden per-Deployment (workingDir + command) in k8s. This default runs the API.
WORKDIR /app/apps/api
CMD ["/app/node_modules/.bin/tsx", "src/main.ts"]
