#!/usr/bin/env bash
set -euo pipefail

OPENCODEX_DIR="${OPENCODEX_HOME:-/home/bun/.opencodex}"
mkdir -p "${OPENCODEX_DIR}"

CONFIG_FILE="${OPENCODEX_DIR}/config.json"

# In container environments, default to hub role and 0.0.0.0 bind address
# so published container ports work out of the box.
if [ ! -f "${CONFIG_FILE}" ]; then
  bun -e "
    try {
      const { getDefaultConfig, saveConfig } = require('./src/config.ts');
      const cfg = getDefaultConfig();
      cfg.runtimeRole = 'hub';
      cfg.hostname = '0.0.0.0';
      saveConfig(cfg);
    } catch (e) {
      console.error('Failed to initialize default config:', e);
    }
  " >/dev/null 2>&1 || true
fi

exec "$@"
