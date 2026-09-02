#!/usr/bin/env bash
# Resolve the current stable OpenCodex version from the npm dist-tag `latest`.
# Prints exactly one line: the version (e.g. 2.40.0).
# Preview/prerelease dist-tags are deliberately ignored.
set -euo pipefail

registry_entry="$(curl -fsSL "https://registry.npmjs.org/@bitkyc08%2Fopencodex/latest")"
version="$(printf '%s' "${registry_entry}" | node -e "
  let raw='';process.stdin.on('data',c=>raw+=c).on('end',()=>{
    const p=JSON.parse(raw);
    if (typeof p.version !== 'string' || p.version.includes('-')) { process.exit(1); }
    process.stdout.write(p.version);
  });
")"

if [ -z "${version}" ]; then
  echo "failed to resolve stable version from npm dist-tag latest" >&2
  exit 1
fi

echo "${version}"
