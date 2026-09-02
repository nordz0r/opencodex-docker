#!/usr/bin/env bash
# Ephemeral container smoke test: start the image exactly as production would
# (non-root, read-only rootfs, persistent state volume, no credentials) and
# prove /healthz, /readyz and negative authentication rejection.
#
# Usage: scripts/smoke-test.sh <image-ref>
# Requires: docker (or podman-compatible CLI), curl.
set -euo pipefail

IMAGE="${1:?usage: smoke-test.sh <image-ref>}"
CTR="opencodex-smoke-$$"
STATE_VOL="opencodex-smoke-state-$$"

cleanup() {
  docker rm -f "${CTR}" >/dev/null 2>&1 || true
  docker volume rm -f "${STATE_VOL}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[smoke] starting ${IMAGE}"
# No token file is mounted: the negative-auth assertion depends on it being absent.
docker run -d --name "${CTR}" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -v "${STATE_VOL}:/home/bun/.opencodex" \
  -p 127.0.0.1:0:10100 \
  "${IMAGE}" >/dev/null

port="$(docker port "${CTR}" 10100/tcp | head -1 | grep -oE '[0-9]+$')"
if [ -z "${port}" ]; then
  echo "[smoke] FATAL: could not resolve published port" >&2
  exit 1
fi
base="http://127.0.0.1:${port}"

wait_healthz() {
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "${base}/healthz" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

echo "[smoke] waiting for /healthz on ${base}"
wait_healthz || { echo "[smoke] FATAL: /healthz never became ready" >&2; docker logs "${CTR}" >&2 || true; exit 1; }
echo "[smoke] PASS /healthz"

echo "[smoke] checking /readyz"
code="$(curl -sS -o /dev/null -w '%{http_code}' "${base}/readyz")"
if [ "${code}" != "200" ]; then
  echo "[smoke] FATAL: /readyz returned ${code} (expected 200)" >&2
  docker logs "${CTR}" >&2 || true
  exit 1
fi
echo "[smoke] PASS /readyz"

echo "[smoke] checking negative auth: /v1/catalog without credentials must be rejected"
code="$(curl -sS -o /dev/null -w '%{http_code}' "${base}/v1/catalog")"
if [ "${code}" = "200" ]; then
  echo "[smoke] FATAL: /v1/catalog answered 200 anonymously — authentication is not enforced" >&2
  exit 1
fi
echo "[smoke] PASS anonymous /v1/catalog rejected with HTTP ${code}"

echo "[smoke] checking non-root runtime user"
uid="$(docker exec "${CTR}" id -u)"
if [ "${uid}" = "0" ]; then
  echo "[smoke] FATAL: container runs as root" >&2
  exit 1
fi
echo "[smoke] PASS non-root uid=${uid}"

echo "[smoke] checking installed version label matches package.json"
label_version="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "${IMAGE_OR_DUMMY:-${IMAGE}}" 2>/dev/null || true)"
if [ -n "${label_version}" ]; then
  pkg_version="$(docker exec "${CTR}" sh -c 'cd /home/bun/app && bun -e "console.log(require(\"./package.json\").version)")' 2>/dev/null || true)"
  if [ -n "${pkg_version}" ] && [ "${pkg_version}" != "${label_version}" ]; then
    echo "[smoke] FATAL: image label version ${label_version} != package.json ${pkg_version}" >&2
    exit 1
  fi
  echo "[smoke] PASS version label ${label_version}"
fi

echo "[smoke] ALL CHECKS PASSED for ${IMAGE}"
