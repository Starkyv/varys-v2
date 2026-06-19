#!/usr/bin/env bash
#
# Single deploy path: build the changed image(s) in ACR, then roll them out with Helm.
#
#   deploy/deploy.sh            # build + deploy both images
#   deploy/deploy.sh app        # only API + worker (changed apps/api, apps/worker, packages/*)
#   deploy/deploy.sh web        # only the web SPA (+ the bundled recorder extension)
#
# Image tag = current git short SHA (+ "-dirty" if you have uncommitted changes — commit
# first for a clean tag). api+worker use the "app" image, web uses the "web" image, tracked
# as separate chart values (image.appTag / image.webTag). Whichever you DON'T rebuild this
# run keeps the tag that's currently running (read from the cluster), so a `web` deploy
# never disturbs the app and vice-versa.
#
# First run adopts the resources you previously `kubectl apply`'d (via --take-ownership);
# it's a no-op on later runs.
#
# Override via env, e.g.:  ACR=myreg NS=varys RELEASE=varys TAG=v2 deploy/deploy.sh app
set -euo pipefail

ACR="${ACR:-dgvarysacr}"
NS="${NS:-varys}"
RELEASE="${RELEASE:-varys}"
REGISTRY="${ACR}.azurecr.io"
TARGET="${1:-all}"

# Run from the repo root regardless of where the script is invoked.
cd "$(dirname "$0")/.."
CHART="${CHART:-deploy/helm/varys}"
TAG="${TAG:-$(git rev-parse --short HEAD)$(git diff --quiet || echo '-dirty')}"

for c in az kubectl helm; do
  command -v "$c" >/dev/null || { echo "✗ '$c' not found in PATH"; exit 1; }
done

build_app() { echo "▶ Building ${REGISTRY}/varys-app:${TAG}"; az acr build -r "$ACR" -t "varys-app:${TAG}" -f deploy/Dockerfile.app .; }
build_web() { echo "▶ Building ${REGISTRY}/varys-web:${TAG}"; az acr build -r "$ACR" -t "varys-web:${TAG}" -f deploy/Dockerfile.web .; }

# Tag currently running in the cluster for a deployment (empty if not deployed yet).
cur_tag() { kubectl -n "$NS" get deploy "$1" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null | sed 's/.*://'; }

# Start from what's live (fall back to the chart default so a fresh install still works),
# then override only the image(s) we rebuild this run.
APP_TAG="$(cur_tag varys-api)"; APP_TAG="${APP_TAG:-v1}"
WEB_TAG="$(cur_tag varys-web)"; WEB_TAG="${WEB_TAG:-v1}"

case "$TARGET" in
  app) build_app; APP_TAG="$TAG" ;;
  web) build_web; WEB_TAG="$TAG" ;;
  all) build_app; build_web; APP_TAG="$TAG"; WEB_TAG="$TAG" ;;
  *)   echo "usage: $0 [app|web|all]"; exit 1 ;;
esac

echo "▶ helm upgrade '${RELEASE}'  (appTag=${APP_TAG}  webTag=${WEB_TAG})"
helm upgrade --install "$RELEASE" "$CHART" -n "$NS" \
  --take-ownership \
  --set image.appTag="${APP_TAG}" \
  --set image.webTag="${WEB_TAG}" \
  --wait --timeout 8m

echo "✓ Deployed '${TARGET}' — appTag=${APP_TAG}, webTag=${WEB_TAG} (release ${RELEASE}, ns ${NS})"
