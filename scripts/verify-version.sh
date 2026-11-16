#!/usr/bin/env bash
# Fail-closed version verification of the upstream checkout inside the Docker build.
# Called by the Dockerfile after cloning the exact upstream tag.
set -euo pipefail

VERSION="${UPSTREAM_VERSION:?UPSTREAM_VERSION must be set}"
COMMIT="${UPSTREAM_COMMIT:?UPSTREAM_COMMIT must be set}"
SRC="${1:-/tmp/opencodex-src}"

cd "${SRC}"

actual_version="$(node -p "require('./package.json').version")"
if [ "${actual_version}" != "${VERSION}" ]; then
  echo "FATAL: package.json version ${actual_version} != expected ${VERSION}" >&2
  exit 1
fi

actual_commit="$(git rev-parse HEAD)"
if [ "${actual_commit}" != "${COMMIT}" ]; then
  echo "FATAL: git HEAD ${actual_commit} != expected ${COMMIT}" >&2
  exit 1
fi

echo "verified upstream: v${VERSION} @ ${COMMIT}"
