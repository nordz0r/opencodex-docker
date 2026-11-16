#!/usr/bin/env bash
# Offline regression: default sync follows the latest stable vX.Y.Z tag,
# not the development branch and not pre-release tags.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/sync-ocx-skill.sh"
CHECK="$ROOT/scripts/check-ocx-skill.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git_init_user() {
  git -C "$1" config user.name "ocx-skill-test"
  git -C "$1" config user.email "ocx-skill-test@example.invalid"
}

write_skill() {
  local dest="$1" body="$2"
  mkdir -p "$dest/skills/ocx/references"
  printf '%s\n' "MIT test license" > "$dest/LICENSE"
  printf '%s\n' "$body" > "$dest/skills/ocx/SKILL.md"
  # Marker row the real script looks up before inserting the container-hub extension.
  cat >> "$dest/skills/ocx/SKILL.md" <<'MARK'

| [Remote hub](references/05_remote_hub.md) | hub/client roles, when pairing is and is not needed, key rotation, disconnection |
MARK
  printf '%s\n' "remote hub notes" > "$dest/skills/ocx/references/05_remote_hub.md"
}

seed_pkg() {
  local work="$1" pkg="$2" stamp_sha="$3"
  mkdir -p "$pkg/scripts" "$pkg/skills/ocx"
  cp "$SCRIPT" "$pkg/scripts/sync-ocx-skill.sh"
  cp "$CHECK" "$pkg/scripts/check-ocx-skill.sh"
  chmod +x "$pkg/scripts/sync-ocx-skill.sh" "$pkg/scripts/check-ocx-skill.sh"
  git -C "$work" checkout --quiet "$stamp_sha"
  cp -a "$work/skills/ocx/." "$pkg/skills/ocx/"
  cp "$work/LICENSE" "$pkg/skills/ocx/LICENSE"
  printf '%s\n' "container hub extension" > "$pkg/skills/ocx/references/container-hub.md"
  printf '%s\n' "$stamp_sha" > "$pkg/skills/ocx/.upstream-revision"
  python3 - "$pkg/skills/ocx/SKILL.md" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
marker = "| [Remote hub](references/05_remote_hub.md) | hub/client roles, when pairing is and is not needed, key rotation, disconnection |"
row = "| [Container hub](references/container-hub.md) | Docker/Kubernetes container packaging additions for this image (extension; upstream updates must not overwrite it) |"
text = path.read_text()
if row not in text:
    path.write_text(text.replace(marker, marker + "\n" + row, 1))
PY
}

# --- Repo with no release tags must fail clearly. ---
empty="$tmp/empty.git"
git init --bare --initial-branch=dev "$empty" >/dev/null
empty_work="$tmp/empty-work"
git clone --quiet "$empty" "$empty_work"
git_init_user "$empty_work"
write_skill "$empty_work" "untagged skill"
git -C "$empty_work" add LICENSE skills/ocx
git -C "$empty_work" commit --quiet -m "untagged"
git -C "$empty_work" push --quiet origin dev
if OCX_UPSTREAM_REPO_URL="$empty" bash "$SCRIPT" --check 2>"$tmp/notags.err"; then
  echo "expected failure when upstream has no stable release tags" >&2
  exit 1
fi
if ! grep -q "No stable upstream release tags matching vX.Y.Z" "$tmp/notags.err"; then
  echo "missing clear error for absent release tags:" >&2
  cat "$tmp/notags.err" >&2
  exit 1
fi

# --- Repo whose default branch is dev, with mixed tags. ---
# v2.10.0 is the highest stable tag. v2.9.9 is tagged later (newer date,
# older version). A later dev commit is tagged only as a pre-release.
upstream="$tmp/upstream.git"
git init --bare --initial-branch=dev "$upstream" >/dev/null
work="$tmp/upstream-work"
git clone --quiet "$upstream" "$work"
git_init_user "$work"

write_skill "$work" "skill body v2.9.9"
git -C "$work" add LICENSE skills/ocx
git -C "$work" commit --quiet -m "skill 2.9.9"
v299_sha="$(git -C "$work" rev-parse HEAD)"

write_skill "$work" "skill body v2.10.0"
git -C "$work" add skills/ocx/SKILL.md
git -C "$work" commit --quiet -m "skill 2.10.0"
v210_sha="$(git -C "$work" rev-parse HEAD)"
git -C "$work" tag v2.10.0
# Tag the older version after the newer one so date order would pick v2.9.9.
git -C "$work" tag v2.9.9 "$v299_sha"

write_skill "$work" "skill body dev"
git -C "$work" add skills/ocx/SKILL.md
git -C "$work" commit --quiet -m "skill on dev"
git -C "$work" tag v3.0.0-rc.1
git -C "$work" tag v2.10.1-beta.1
git -C "$work" push --quiet origin dev
git -C "$work" push --quiet origin --tags

pkg="$tmp/pkg"
seed_pkg "$work" "$pkg" "$v299_sha"

# Explicit missing ref still fails clearly.
if OCX_UPSTREAM_REPO_URL="$upstream" OCX_UPSTREAM_SKILL_REVISION=main \
    bash "$pkg/scripts/sync-ocx-skill.sh" --check 2>"$tmp/main.err"; then
  echo "expected failure when revision is the missing branch main" >&2
  exit 1
fi
if ! grep -q "Upstream revision 'main' is not a commit" "$tmp/main.err"; then
  echo "missing clear error for absent main:" >&2
  cat "$tmp/main.err" >&2
  exit 1
fi

# Default: pick v2.10.0 by version sort, ignore later v2.9.9 tag date,
# ignore pre-releases and the dev branch tip.
OCX_UPSTREAM_REPO_URL="$upstream" bash "$pkg/scripts/sync-ocx-skill.sh" | tee "$tmp/sync.out"
grep -q "Using upstream revision v2.10.0 (${v210_sha})" "$tmp/sync.out"
grep -q "Synchronized skills/ocx from upstream" "$tmp/sync.out"
test -f "$pkg/skills/ocx/references/container-hub.md"
grep -q "skill body v2.10.0" "$pkg/skills/ocx/SKILL.md"
grep -q "Container hub" "$pkg/skills/ocx/SKILL.md"
if grep -q "skill body dev" "$pkg/skills/ocx/SKILL.md"; then
  echo "sync followed the development branch instead of the latest stable tag" >&2
  exit 1
fi
new_stamp="$(tr -d '[:space:]' < "$pkg/skills/ocx/.upstream-revision")"
test "$new_stamp" = "$v210_sha"

OCX_UPSTREAM_REPO_URL="$upstream" bash "$pkg/scripts/check-ocx-skill.sh" | tee "$tmp/check.out"
grep -q "ocx skill matches upstream-owned files" "$tmp/check.out"

# Manual override still wins.
override_pkg="$tmp/pkg-override"
seed_pkg "$work" "$override_pkg" "$v299_sha"
OCX_UPSTREAM_REPO_URL="$upstream" OCX_UPSTREAM_SKILL_REVISION=v2.9.9 \
  bash "$override_pkg/scripts/sync-ocx-skill.sh" --check | tee "$tmp/override.out"
grep -q "Using upstream revision v2.9.9 (${v299_sha})" "$tmp/override.out"
grep -q "ocx skill matches upstream-owned files" "$tmp/override.out"

echo "OK: sync follows the latest stable vX.Y.Z tag, not dev or pre-releases"
