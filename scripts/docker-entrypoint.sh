#!/usr/bin/env bash
set -euo pipefail

OPENCODEX_DIR="${OPENCODEX_HOME:-/home/bun/.opencodex}"
CODEX_DIR="${CODEX_HOME:-/home/bun/.codex}"
mkdir -p "${OPENCODEX_DIR}" "${CODEX_DIR}"

CONFIG_FILE="${OPENCODEX_DIR}/config.json"
SEED_FILE="/home/bun/app/docker/config.json"

# Fresh volume: seed the upstream hub config (runtimeRole=hub, 0.0.0.0).
# A populated PVC/named volume already has operator config — leave it alone.
if [ ! -f "${CONFIG_FILE}" ]; then
  if [ -f "${SEED_FILE}" ]; then
    cp -a "${SEED_FILE}" "${CONFIG_FILE}"
  else
    echo "opencodex: missing hub seed ${SEED_FILE}; cannot initialize ${CONFIG_FILE}" >&2
    exit 1
  fi
fi

exec "$@"
