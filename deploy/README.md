# Deploying Varys to AKS

Targets the `varys` namespace on `datagenie-aks-cluster`, with **Azure Postgres**
(DB) + **Azure Blob** (artifacts) as managed dependencies.

## Topology

| Workload | Image | Notes |
|---|---|---|
| `varys-api` | `varys-app` | NestJS API. Applies the schema on boot, serves `/artifacts` + auth. Launches Chromium for live authoring. `replicas: 1` (in-memory authoring sessions). |
| `varys-worker` | `varys-app` (same image, diff command) | Pulls run jobs off pg-boss, replays them in Chromium. Scalable. No Service. |
| `varys-web` | `varys-web` | Vite SPA served by nginx. |
| Ingress | — | API path prefixes → `varys-api`; everything else → `varys-web`. TLS via cert-manager. |

Both `api` and `worker` run the TypeScript workspace via `tsx` (same runtime as
`pnpm dev`) — there is no `node dist` build, because the workspace packages export
`src/*.ts` directly.

## Prerequisites (one-time)

1. **Azure Postgres** — allow-list `PGCRYPTO` in the server's `azure.extensions`
   parameter (else the boot-time schema apply crashes). The app user needs CREATE
   on its database (for the schema + the pg-boss `pgboss` schema).
2. **Azure Blob** — create the container; mint a **long-lived** SAS (or stored
   access policy) with `r/a/c/w/d` permissions. Short-lived SAS tokens silently
   break uploads when they expire.
3. **AKS** — an ingress controller (ingress-nginx assumed; see `ingress.yaml` for
   AKS alternatives) and **cert-manager** with a `letsencrypt-prod` ClusterIssuer.
4. **ACR attached to AKS** so image pulls need no imagePullSecret:
   `az aks update -n datagenie-aks-cluster -g <rg> --attach-acr <acr-name>`

## 1. Build + push images (ACR)

```sh
# from the repo root
az acr build -r <acr-name> -t varys-app:$(git rev-parse --short HEAD) -f deploy/Dockerfile.app .
az acr build -r <acr-name> -t varys-web:$(git rev-parse --short HEAD) -f deploy/Dockerfile.web .
```

Then set the image refs in `k8s/api.yaml`, `k8s/worker.yaml`, `k8s/web.yaml`
(`<registry>/varys-app:<tag>` etc.).

## 2. Configure

- Edit `k8s/configmap.yaml` — set `BETTER_AUTH_URL` / `BETTER_AUTH_TRUSTED_ORIGINS`
  to `https://<your-domain>`, and the `AZURE_STORAGE_ACCOUNT` / `_CONTAINER`.
- Create the Secret (don't commit it):

```sh
kubectl -n varys create secret generic varys-secrets \
  --from-literal=DATABASE_URL='postgres://<appuser>:<pwd>@<host>:5432/<db>?sslmode=require' \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  --from-literal=AZURE_STORAGE_SAS_TOKEN='<sas-query-string>' \
  --from-literal=GOOGLE_CLIENT_ID='<client-id>' \
  --from-literal=GOOGLE_CLIENT_SECRET='<client-secret>'
```

- Edit `k8s/ingress.yaml` — replace `<your-domain>` (3 places).

## 3. Apply

```sh
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/api.yaml
kubectl apply -f deploy/k8s/worker.yaml
kubectl apply -f deploy/k8s/web.yaml
kubectl apply -f deploy/k8s/ingress.yaml
kubectl -n varys rollout status deploy/varys-api
```

## 4. Google OAuth

In the Google Cloud OAuth client, add (keep the localhost entries for dev):
- **Authorized redirect URI:** `https://<your-domain>/api/auth/callback/google`
- **Authorized JavaScript origin:** `https://<your-domain>`

## Notes / gotchas

- **HTTPS is required** — the session cookie is `SameSite=None; Secure`; browsers
  drop it on plain HTTP. The Ingress TLS block handles this.
- **Chromium in-cluster** — needs `--no-sandbox,--disable-dev-shm-usage` (set in the
  ConfigMap as `VARYS_BROWSER_ARGS`) and a memory-backed `/dev/shm` (mounted in the
  api/worker pods). Both are already wired.
- **Scaling the API > 1** — auth sessions are in Postgres so most routes are fine,
  but live-authoring sessions are in-memory. Enable Ingress sticky sessions
  (`nginx.ingress.kubernetes.io/affinity: cookie`) before raising `replicas`.
- **Image size** — the `app` image installs the full workspace (incl. docs/extension
  deps) + Chromium. A `turbo prune --docker` slim build is a future optimization.
