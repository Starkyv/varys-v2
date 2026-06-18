#!/usr/bin/env bash
#
# Build + ship a code change to the varys namespace on AKS.
#
#   deploy/deploy.sh            # build + roll out everything (app image + web image)
#   deploy/deploy.sh app        # only the API + worker (the shared "app" image)
#   deploy/deploy.sh web        # only the web SPA
#
# Tag = current git short SHA (so the running image is traceable to exact code),
# with "-dirty" appended if you have uncommitted changes — commit first for a clean tag.
#
# Overridable via env, e.g.:  ACR=myreg NS=varys TAG=v2 deploy/deploy.sh app
#
# NOTE: this uses `kubectl set image`, which updates the LIVE deployments. That means
# the cluster drifts from the `:v1` tag written in deploy/k8s/*.yaml. To keep git in
# sync, bump the tag in those files and commit periodically (or re-`kubectl apply`).
set -euo pipefail

ACR="${ACR:-dgvarysacr}"
NS="${NS:-varys}"
REGISTRY="${ACR}.azurecr.io"
TARGET="${1:-all}"

# Run from the repo root regardless of where the script is invoked.
cd "$(dirname "$0")/.."

# Tag from git: short SHA, plus "-dirty" if the working tree has uncommitted changes.
TAG="${TAG:-$(git rev-parse --short HEAD)$(git diff --quiet || echo '-dirty')}"

command -v az >/dev/null      || { echo "✗ 'az' (Azure CLI) not found"; exit 1; }
command -v kubectl >/dev/null || { echo "✗ 'kubectl' not found"; exit 1; }

build_app() {
  echo "▶ Building ${REGISTRY}/varys-app:${TAG}"
  az acr build -r "$ACR" -t "varys-app:${TAG}" -f deploy/Dockerfile.app .
}
build_web() {
  echo "▶ Building ${REGISTRY}/varys-web:${TAG}"
  az acr build -r "$ACR" -t "varys-web:${TAG}" -f deploy/Dockerfile.web .
}

roll_app() {
  echo "▶ Rolling out api + worker → ${TAG}"
  kubectl -n "$NS" set image deployment/varys-api    "api=${REGISTRY}/varys-app:${TAG}"
  kubectl -n "$NS" set image deployment/varys-worker "worker=${REGISTRY}/varys-app:${TAG}"
  kubectl -n "$NS" rollout status deployment/varys-api    --timeout=300s
  kubectl -n "$NS" rollout status deployment/varys-worker --timeout=300s
}
roll_web() {
  echo "▶ Rolling out web → ${TAG}"
  kubectl -n "$NS" set image deployment/varys-web "web=${REGISTRY}/varys-web:${TAG}"
  kubectl -n "$NS" rollout status deployment/varys-web --timeout=300s
}

case "$TARGET" in
  app) build_app; roll_app ;;
  web) build_web; roll_web ;;
  all) build_app; build_web; roll_app; roll_web ;;
  *)   echo "usage: $0 [app|web|all]"; exit 1 ;;
esac

echo "✓ Deployed '${TARGET}' at tag ${TAG} to namespace ${NS}"
