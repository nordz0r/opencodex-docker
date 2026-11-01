#!/usr/bin/env bash
set -euo pipefail
exec "$(dirname "$0")/sync-ocx-skill.sh" --check "$@"
