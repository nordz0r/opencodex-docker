#!/usr/bin/env bash
set -euo pipefail

OPENCODEX_DIR="${OPENCODEX_HOME:-/home/bun/.opencodex}"
mkdir -p "${OPENCODEX_DIR}"

CONFIG_FILE="${OPENCODEX_DIR}/config.json"

# In container environments, default to hub role and 0.0.0.0 bind address
# so published container ports work out of the box.
if [ ! -f "${CONFIG_FILE}" ]; then
  bun run src/cli/index.ts config set runtimeRole hub >/dev/null 2>&1 || true
  bun run src/cli/index.ts config set hostname 0.0.0.0 >/dev/null 2>&1 || true
fi

exec "$@"
