#!/usr/bin/env bash
# Fail-closed verification that git tag v<VERSION> @ <COMMIT> is the exact
# source of npm release <VERSION> of @bitkyc08/opencodex.
#
# Usage: verify-upstream-release.sh <version> <commit> [source-dir] [--patch-version]
#
# Normal upstream releases: the tag's package.json declares <version>; the
# check passes on that alone (the guarantee the previous inline checks had).
#
# Upstream sometimes cuts a tag without committing the version bump (v2.100.1,
# v2.100.2: tag package.json said 2.100.0 while npm published 2.100.1/2.100.2).
# For such tags this passes ONLY when the npm tarball of <VERSION> is
# byte-identical to the tag tree for every file except package.json, and
# package.json differs in the version field alone (the tarball's package.json
# must declare <VERSION>). That proves the tag is the code npm published
# without trusting the version string inside the tag.
#
# [source-dir] reads the tag tree from a local checkout instead of downloading
# it from codeload. --patch-version additionally rewrites <version> into
# [source-dir]/package.json after a successful tarball-equivalence check, so
# the built artifact reports the version npm actually published.
set -euo pipefail

VERSION="${1:?usage: verify-upstream-release.sh <version> <commit> [source-dir] [--patch-version]}"
COMMIT="${2:?missing commit sha}"
SRC=""
PATCH=0
for arg in "${@:3}"; do
  case "${arg}" in
    --patch-version) PATCH=1 ;;
    *) SRC="${arg}" ;;
  esac
done
if [ "${PATCH}" = "1" ] && [ -z "${SRC}" ]; then
  echo "--patch-version requires a source-dir" >&2
  exit 2
fi

UPSTREAM_GIT="https://github.com/lidge-jun/opencodex.git"
NPM_TARBALL="https://registry.npmjs.org/@bitkyc08/opencodex/-/opencodex-${VERSION}.tgz"

die() { echo "::error::$*" >&2; exit 1; }

# The tag must exist and resolve to exactly the pinned commit.
tag_sha="$(git ls-remote "${UPSTREAM_GIT}" "refs/tags/v${VERSION}^{}" | awk '{print $1}')"
if [ -z "${tag_sha}" ]; then
  # lightweight tag: ls-remote does not emit a ^{} entry
  tag_sha="$(git ls-remote "${UPSTREAM_GIT}" "refs/tags/v${VERSION}" | awk '{print $1}')"
fi
[ -n "${tag_sha}" ] || die "upstream tag v${VERSION} not found"
[ "${tag_sha}" = "${COMMIT}" ] || die "tag v${VERSION} is ${tag_sha}, expected ${COMMIT}"

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
tag_pkg_tmp="${tmp}/tag-package.json"
# NB: no `curl | node -e 'stdin…'` here — the oven/bun image's node shim does
# not implement flowing stdin into -e, so the JSON is read from a file.
curl -fsSL -o "${tag_pkg_tmp}" "https://raw.githubusercontent.com/lidge-jun/opencodex/v${VERSION}/package.json" \
  || die "cannot read package.json from tag v${VERSION}"
tag_version="$(node -p "require('${tag_pkg_tmp}').version")"

if [ "${tag_version}" = "${VERSION}" ]; then
  echo "verified upstream: v${VERSION} @ ${COMMIT} (tag package.json matches)"
  exit 0
fi

# The tag was cut without committing the version bump: prove the tag tree IS
# the npm release before accepting it.

if [ -n "${SRC}" ]; then
  tree="${SRC}"
else
  curl -fsSL -o "${tmp}/tag.tgz" \
    "https://codeload.github.com/lidge-jun/opencodex/tar.gz/refs/tags/v${VERSION}" \
    || die "cannot download tag v${VERSION} from codeload"
  mkdir -p "${tmp}/tag"
  tar xzf "${tmp}/tag.tgz" -C "${tmp}/tag" --strip-components=1
  tree="${tmp}/tag"
fi
[ -f "${tree}/package.json" ] || die "no package.json in the v${VERSION} tag tree"

curl -fsSL -o "${tmp}/npm.tgz" "${NPM_TARBALL}" || die "npm tarball for ${VERSION} not found"
mkdir -p "${tmp}/npm"
tar xzf "${tmp}/npm.tgz" -C "${tmp}/npm"

npm_version="$(node -p "require('${tmp}/npm/package/package.json').version")"
[ "${npm_version}" = "${VERSION}" ] || die "npm tarball declares ${npm_version}, expected ${VERSION}"

# Every entry the npm tarball ships that the git tag also tracks must be
# byte-identical (package.json is compared structurally below). Entries the
# tarball ships but the tag does not track must be build artifacts — npm
# packages gui/dist and src/generated are generated at publish time, and this
# packaging Dockerfile regenerates both itself, so their absence from the tag
# is expected. Anything else fail-closes.
bad=""
while IFS= read -r rel; do
  [ -n "${rel}" ] || continue
  [ "${rel}" = "package.json" ] && continue
  if [ ! -e "${tree}/${rel}" ]; then
    case "${rel}" in
      gui/dist/*|src/generated/*) continue ;;
      *) bad="${bad} ${rel}(missing from tag)" ;;
    esac
  elif ! cmp -s "${tmp}/npm/package/${rel}" "${tree}/${rel}"; then
    bad="${bad} ${rel}(differs)"
  fi
done < <(tar -tzf "${tmp}/npm.tgz" | awk '$0 !~ /\/$/ {sub(/^package\//, ""); print}')

[ -z "${bad}" ] || die "npm tarball ${VERSION} is not the tag v${VERSION}:${bad}"
# npm stamps package.json with gitHead at publish time; when present it MUST
# equal the pinned commit — independent proof the tarball came from this tag.
githead="$(node -p "require('${tmp}/npm/package/package.json').gitHead || ''")"
[ -z "${githead}" ] || [ "${githead}" = "${COMMIT}" ] \
  || die "npm tarball gitHead is ${githead}, expected ${COMMIT}"

# NB: the JS lives in a file — the oven/bun node shim does not run scripts
# from stdin (`node -`).
cmp_js="${tmp}/compare-package-json.js"
cat > "${cmp_js}" <<'JS'
const fs = require("fs");
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
// canonical form: recursively key-sorted, version and npm's gitHead stamp removed
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) {
      if (k === "version" || k === "gitHead") continue;
      o[k] = canon(v[k]);
    }
    return o;
  }
  return v;
};
const [tagPkg, npmPkg, version] = process.argv.slice(2);
if (JSON.stringify(canon(read(tagPkg))) !== JSON.stringify(canon(read(npmPkg)))) {
  console.error("::error::package.json differs from the npm tarball beyond the version/gitHead fields");
  process.exit(1);
}
if (process.env.PATCH === "1") {
  const pkg = read(tagPkg);
  pkg.version = version;
  fs.writeFileSync(tagPkg, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`patched ${tagPkg} version to ${version} (verified against the npm tarball)`);
}
JS
PATCH="${PATCH}" node "${cmp_js}" "${tree}/package.json" "${tmp}/npm/package/package.json" "${VERSION}"

echo "verified upstream: v${VERSION} @ ${COMMIT} (tag package.json says ${tag_version}; npm ${VERSION} tarball is otherwise byte-identical)"
