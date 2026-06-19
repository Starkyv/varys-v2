# Deploying Varys to AKS

Deployed with **Helm** into the `varys` namespace, with **Azure Postgres** (DB) and
**Azure Blob** (artifacts) as managed dependencies. The Helm chart in
[`helm/varys/`](helm/varys/README.md) is the single source of truth for the cluster
resources; [`deploy.sh`](deploy.sh) is the one command that builds + ships a change.

## Topology

| Workload | Image | Notes |
|---|---|---|
| `varys-api` | `varys-app` | NestJS API. Applies the schema on boot, serves `/artifacts` + auth. Launches Chromium for live authoring. `replicas: 1` (in-memory authoring sessions). |
| `varys-worker` | `varys-app` (same image, diff command) | Pulls run jobs off pg-boss, replays them in Chromium. Scalable. No Service. |
| `varys-web` | `varys-web` | Vite SPA (+ bundled recorder extension) served by nginx. |
| Ingress | — | API path prefixes → `varys-api`; everything else → `varys-web`. TLS via cert-manager. |

Both `api` and `worker` run the TypeScript workspace via `tsx` (same runtime as
`pnpm dev`) — there's no `node dist` build, because the workspace packages export
`src/*.ts` directly.

## Prerequisites (one-time)

1. **Azure Postgres** — allow-list `PGCRYPTO` in the server's `azure.extensions`
   parameter (else the boot-time schema apply crashes). The app user needs CREATE on its
   database (for the schema + the pg-boss `pgboss` schema).
   ```sh
   az postgres flexible-server parameter set -g <rg> -s <server> \
     --name azure.extensions --value PGCRYPTO
   ```
2. **Azure Blob** — create the container; mint a **long-lived** SAS (or stored access
   policy) with `r/a/c/w/d` permissions. Short-lived SAS tokens silently break uploads
   when they expire.
3. **AKS — ingress controller** (`nginx` IngressClass; the chart uses it).
4. **AKS — cert-manager** with a `letsencrypt-prod` ClusterIssuer. If your cluster
   doesn't have one yet, create it (cluster-scoped, shared — not part of the chart):
   ```yaml
   apiVersion: cert-manager.io/v1
   kind: ClusterIssuer
   metadata: { name: letsencrypt-prod }
   spec:
     acme:
       server: https://acme-v02.api.letsencrypt.org/directory
       email: mothil@datagenie.ai
       privateKeySecretRef: { name: letsencrypt-prod }
       solvers:
         - http01: { ingress: { ingressClassName: nginx } }
   ```
5. **ACR attached to AKS** so image pulls need no imagePullSecret:
   ```sh
   az aks update -n datagenie-aks-cluster -g <rg> --attach-acr <acr-name>
   ```

## 1. Create the Secret (out of band — never in git)

The chart references this Secret but does not manage it, so real secrets never live in
values/git:
```sh
kubectl -n varys create secret generic varys-secrets \
  --from-literal=DATABASE_URL='postgres://<appuser>:<pwd>@<host>:5432/<db>?sslmode=require' \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  --from-literal=AZURE_STORAGE_SAS_TOKEN='<sas-query-string>' \
  --from-literal=GOOGLE_CLIENT_ID='<client-id>' \
  --from-literal=GOOGLE_CLIENT_SECRET='<client-secret>'
```

## 2. Configure

Non-secret config lives in the chart's [`values.yaml`](helm/varys/values.yaml) — set
`domain` (drives `BETTER_AUTH_URL` + the Ingress host), `image.registry`, and the
`AZURE_STORAGE_*` values. The defaults are already wired for `varys.datagenie.ai`.

## 3. Deploy

One command builds the image(s) in ACR and `helm upgrade`s the release:
```sh
deploy/deploy.sh          # build + deploy both images
deploy/deploy.sh app      # only API + worker
deploy/deploy.sh web      # only the web SPA (+ bundled extension)
```
It tags images with the git SHA, keeps the tag of whatever it doesn't rebuild, and waits
for the rollout. See [`helm/varys/README.md`](helm/varys/README.md) for driving Helm
directly, overrides, and rollback (`helm rollback varys -n varys`).

> First run adopts the resources you previously `kubectl apply`'d, via `--take-ownership`
> in `deploy.sh` — a no-op on later runs.

## 4. Google OAuth

In the Google Cloud OAuth client, add (keep the localhost entries for dev):
- **Authorized redirect URI:** `https://<your-domain>/api/auth/callback/google`
- **Authorized JavaScript origin:** `https://<your-domain>`

## Notes / gotchas

- **HTTPS is required** — the session cookie is `SameSite=None; Secure`; browsers drop it
  on plain HTTP. The Ingress TLS block handles this.
- **Chromium in-cluster** — needs `--no-sandbox,--disable-dev-shm-usage` (set in the chart
  as `config.VARYS_BROWSER_ARGS`) and a memory-backed `/dev/shm` (mounted in the api/worker
  pods). Both are already wired.
- **Scaling the API > 1** — auth sessions are in Postgres so most routes are fine, but
  live-authoring sessions are in-memory. Enable Ingress sticky sessions
  (`nginx.ingress.kubernetes.io/affinity: cookie`) before raising `api.replicas`.
- **Image size** — the `app` image installs the full workspace (incl. docs/extension deps)
  + Chromium. A `turbo prune --docker` slim build is a future optimization.
