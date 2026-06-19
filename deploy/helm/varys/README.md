# Varys Helm chart

Deploys the Varys API, worker, and web SPA into a Kubernetes namespace. This chart is the
single source of truth for the cluster resources; `deploy/deploy.sh` builds + ships a
change through it.

## What's in it
- `varys-api` Deployment + Service (port 4000)
- `varys-worker` Deployment (no Service)
- `varys-web` Deployment + Service (port 80 → 8080)
- `varys-config` ConfigMap
- `varys` Ingress (TLS via cert-manager; API prefixes → api, everything else → web)

The **Secret** (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `AZURE_STORAGE_SAS_TOKEN`,
`GOOGLE_*`) is intentionally NOT in the chart — create it out of band so secrets never
land in values/git (see below). The cert-manager `ClusterIssuer` is also assumed to
already exist (cluster-scoped, shared).

## Prerequisites
- `kubectl` pointed at the cluster, namespace `varys` exists.
- Images pushed to ACR (`deploy/deploy.sh` or `az acr build`).
- The `varys-secrets` Secret created:
  ```sh
  kubectl -n varys create secret generic varys-secrets \
    --from-literal=DATABASE_URL='postgres://<user>:<pwd>@<host>:5432/<db>?sslmode=require' \
    --from-literal=BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
    --from-literal=AZURE_STORAGE_SAS_TOKEN='<sas>' \
    --from-literal=GOOGLE_CLIENT_ID='<id>' \
    --from-literal=GOOGLE_CLIENT_SECRET='<secret>'
  ```

## Deploying (use the script)
`deploy/deploy.sh` is the single deploy path — it builds the image(s) in ACR and runs the
`helm upgrade` for you:
```sh
deploy/deploy.sh          # build + deploy both images
deploy/deploy.sh app      # only API + worker
deploy/deploy.sh web      # only the web SPA
```

## Driving Helm directly (if you skip the script)
```sh
# preview the rendered YAML (no cluster changes)
helm template varys deploy/helm/varys -n varys

# install or upgrade. Tags are split: api+worker use appTag, web uses webTag.
helm upgrade --install varys deploy/helm/varys -n varys \
  --set image.appTag=<tag> --set image.webTag=<tag>
```

## Common overrides
```sh
--set image.appTag=$(git rev-parse --short HEAD)   # api+worker build
--set image.webTag=$(git rev-parse --short HEAD)   # web build
--set domain=varys-staging.datagenie.ai            # different host
--set api.replicas=2                               # scale (see note below)
-f my-values.yaml                                  # bundle overrides in a file
```

## Rollback / inspect / remove
```sh
helm history varys -n varys        # release revisions
helm rollback varys -n varys       # roll back to the previous revision
helm list -n varys                 # installed releases
helm uninstall varys -n varys      # remove everything in the chart
```

## Notes
- **`api.replicas` stays 1** unless you add Ingress sticky sessions — live-authoring
  sessions are held in memory on one pod (auth sessions are in Postgres, so other routes
  are fine).
- **First-run adoption**: if resources from a previous non-Helm `kubectl apply` still
  exist, Helm won't manage them unless it takes ownership. `deploy/deploy.sh` passes
  `--take-ownership` (Helm ≥3.17) so the first run adopts them with no downtime; it's a
  no-op afterward.
