#!/usr/bin/env bash
# Offline regression: sync must follow origin/HEAD when upstream has no main.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/sync-ocx-skill.sh"
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

# Fake upstream: default branch is dev, main does not exist.
upstream="$tmp/upstream.git"
git init --bare --initial-branch=dev "$upstream" >/dev/null
work="$tmp/upstream-work"
git clone --quiet "$upstream" "$work"
git_init_user "$work"
write_skill "$work" "skill body v1"
git -C "$work" add LICENSE skills/ocx
git -C "$work" commit --quiet -m "initial skill"
base_sha="$(git -C "$work" rev-parse HEAD)"
printf '%s\n' "skill body v2" > "$work/skills/ocx/SKILL.md"
cat >> "$work/skills/ocx/SKILL.md" <<'MARK'

| [Remote hub](references/05_remote_hub.md) | hub/client roles, when pairing is and is not needed, key rotation, disconnection |
MARK
git -C "$work" add skills/ocx/SKILL.md
git -C "$work" commit --quiet -m "update skill"
git -C "$work" push --quiet origin dev

# Packaging checkout vendored at the first upstream commit, plus local extension.
pkg="$tmp/pkg"
mkdir -p "$pkg/scripts" "$pkg/skills/ocx"
cp "$SCRIPT" "$pkg/scripts/sync-ocx-skill.sh"
chmod +x "$pkg/scripts/sync-ocx-skill.sh"
git -C "$work" checkout --quiet "$base_sha"
cp -a "$work/skills/ocx/." "$pkg/skills/ocx/"
cp "$work/LICENSE" "$pkg/skills/ocx/LICENSE"
printf '%s\n' "container hub extension" > "$pkg/skills/ocx/references/container-hub.md"
printf '%s\n' "$base_sha" > "$pkg/skills/ocx/.upstream-revision"
# SKILL.md in the packaging repo already has the extension row added by a prior sync.
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

# Old behaviour: hard-coded main must fail with a clear error on this upstream.
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
if ! grep -q "default branch is dev" "$tmp/main.err"; then
  echo "error should mention the actual default branch:" >&2
  cat "$tmp/main.err" >&2
  exit 1
fi

# New default: no revision override follows origin/HEAD (dev) and applies the update.
OCX_UPSTREAM_REPO_URL="$upstream" bash "$pkg/scripts/sync-ocx-skill.sh" | tee "$tmp/sync.out"
grep -q "Using upstream revision dev" "$tmp/sync.out"
grep -q "Synchronized skills/ocx from upstream" "$tmp/sync.out"
test -f "$pkg/skills/ocx/references/container-hub.md"
grep -q "skill body v2" "$pkg/skills/ocx/SKILL.md"
grep -q "Container hub" "$pkg/skills/ocx/SKILL.md"
new_stamp="$(tr -d '[:space:]' < "$pkg/skills/ocx/.upstream-revision")"
test "$new_stamp" = "$(git -C "$work" rev-parse dev)"

OCX_UPSTREAM_REPO_URL="$upstream" bash "$pkg/scripts/sync-ocx-skill.sh" --check | tee "$tmp/check.out"
grep -q "ocx skill matches upstream-owned files" "$tmp/check.out"

echo "OK: sync follows origin/HEAD when upstream has no main"
