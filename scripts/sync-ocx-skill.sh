#!/usr/bin/env bash
# Synchronize the vendored OpenCodex skill from upstream without clobbering
# local edits. Upstream defaults to main; pass a SHA/tag via the env override
# when a reproducible snapshot is required.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_REPO_URL="${OCX_UPSTREAM_REPO_URL:-https://github.com/lidge-jun/opencodex.git}"
UPSTREAM_REVISION="${OCX_UPSTREAM_SKILL_REVISION:-main}"
SKILL_REL="skills/ocx"
MODE="${1:-sync}"
if [ "$#" -gt 1 ] || { [ "$MODE" != sync ] && [ "$MODE" != check ] && [ "$MODE" != --check ]; }; then
  echo "Usage: $0 [--check|check]" >&2
  exit 2
fi
if [ "$MODE" = "--check" ]; then MODE=check; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --quiet "$UPSTREAM_REPO_URL" "$tmp/upstream"
UPSTREAM_COMMIT="$(git -C "$tmp/upstream" rev-parse --verify "$UPSTREAM_REVISION^{commit}")"
git -C "$tmp/upstream" checkout --quiet --detach "$UPSTREAM_COMMIT"
test -d "$tmp/upstream/$SKILL_REL"
test -f "$tmp/upstream/LICENSE"

python3 - "$ROOT" "$tmp/upstream" "$UPSTREAM_COMMIT" "$SKILL_REL" "$MODE" <<'PYEOF'
import difflib
from pathlib import Path, PurePosixPath
import subprocess
import sys

root = Path(sys.argv[1])
upstream = Path(sys.argv[2])
revision = sys.argv[3]
skill_rel = sys.argv[4]
mode = sys.argv[5]
local = root / skill_rel
source = upstream / skill_rel
stamp = local / ".upstream-revision"
extension = PurePosixPath("references/container-hub.md")
skill_file = PurePosixPath("SKILL.md")
marker = "| [Remote hub](references/05_remote_hub.md) | hub/client roles, when pairing is and is not needed, key rotation, disconnection |"
row = "| [Container hub](references/container-hub.md) | Docker/Kubernetes container packaging additions for this image (extension; upstream updates must not overwrite it) |"

def files(directory):
    result = {}
    for path in directory.rglob("*"):
        if path.is_symlink():
            raise SystemExit(f"Refusing symlink in skill tree: {path}")
        if path.is_file():
            rel = PurePosixPath(path.relative_to(directory).as_posix())
            if ".." in rel.parts or rel.is_absolute():
                raise SystemExit(f"Unsafe upstream path: {rel}")
            result[rel] = path.read_bytes()
    return result

def normalized_skill(data):
    text = data.decode("utf-8")
    text = "\n".join(line for line in text.split("\n") if line != row)
    return text.encode("utf-8")

def with_extension_reference(data):
    text = data.decode("utf-8")
    if "references/container-hub.md" in text:
        return text.encode("utf-8")
    if marker not in text:
        raise SystemExit("Cannot safely add container-hub reference: upstream reference table marker changed")
    return text.replace(marker, marker + "\n" + row, 1).encode("utf-8")

upstream_files = files(source)
upstream_files.pop(extension, None)
upstream_files[PurePosixPath("LICENSE")] = (upstream / "LICENSE").read_bytes()
if skill_file not in upstream_files:
    raise SystemExit("Upstream skill tree is missing SKILL.md")
upstream_files[skill_file] = with_extension_reference(upstream_files[skill_file])

def previous_upstream_files(base_revision):
    subprocess.run(["git", "-C", str(upstream), "cat-file", "-e", f"{base_revision}^{{commit}}"], check=True, stdout=subprocess.DEVNULL)
    names = subprocess.check_output(
        ["git", "-C", str(upstream), "ls-tree", "-r", "--name-only", "-z", base_revision, "--", skill_rel]
    ).split(b"\0")
    result = {}
    for raw in filter(None, names):
        repo_path = raw.decode("utf-8")
        rel = PurePosixPath(repo_path.removeprefix(skill_rel + "/"))
        if rel != extension:
            result[rel] = subprocess.check_output(["git", "-C", str(upstream), "show", f"{base_revision}:{repo_path}"])
    result[PurePosixPath("LICENSE")] = subprocess.check_output(["git", "-C", str(upstream), "show", f"{base_revision}:LICENSE"])
    return result
if mode == "check":
    drift = False
    local_files = files(local) if local.is_dir() else {}
    for rel, expected in sorted(upstream_files.items()):
        actual = local_files.get(rel)
        if actual != expected:
            drift = True
            print(f"DRIFT: {skill_rel}/{rel}")
            if actual is not None:
                print("".join(difflib.unified_diff(
                    expected.decode("utf-8", "replace").splitlines(True),
                    actual.decode("utf-8", "replace").splitlines(True),
                    fromfile=f"upstream/{rel}", tofile=f"local/{rel}")), end="")
    if not stamp.is_file():
        drift = True
        print(f"MISSING: {skill_rel}/.upstream-revision")
    else:
        try:
            base_files = previous_upstream_files(stamp.read_text().strip())
        except (subprocess.CalledProcessError, UnicodeDecodeError):
            drift = True
            print(f"INVALID: cannot load previous upstream revision in {skill_rel}/.upstream-revision")
        else:
            for rel in base_files.keys() - upstream_files.keys():
                if rel in local_files:
                    drift = True
                    print(f"REMOVED UPSTREAM FILE STILL PRESENT: {skill_rel}/{rel}")
    if drift:
        raise SystemExit(f"ocx skill differs from upstream {revision}; run scripts/sync-ocx-skill.sh to review/apply safe changes")
    print(f"ocx skill matches upstream-owned files at {revision}; revision stamp unchanged when content is identical")
    raise SystemExit(0)

if not stamp.is_file():
    raise SystemExit("Missing .upstream-revision; refusing update without a known merge base")
base_revision = stamp.read_text().strip()
try:
    base_files = previous_upstream_files(base_revision)
except (subprocess.CalledProcessError, UnicodeDecodeError):
    raise SystemExit(f"Cannot read previous upstream revision {base_revision}; refusing unsafe update")
if skill_file not in base_files:
    raise SystemExit(f"Previous upstream revision {base_revision} lacks SKILL.md")

local_files = files(local)
removed_upstream = base_files.keys() - upstream_files.keys()
content_changes = any(local_files.get(rel) != data for rel, data in upstream_files.items())
content_changes = content_changes or any(rel in local_files for rel in removed_upstream)
if not content_changes:
    print(f"Upstream-owned files are unchanged at {revision}; keeping .upstream-revision at {base_revision}")
    raise SystemExit(0)

conflicts = []
for rel, base_data in base_files.items():
    current = local_files.get(rel)
    if rel == PurePosixPath("LICENSE") and current is None:
        continue
    comparable = normalized_skill(current) if rel == skill_file and current is not None else current
    if comparable != base_data:
        conflicts.append(f"locally changed or missing upstream-owned file: {skill_rel}/{rel}")
for rel in upstream_files:
    if rel not in base_files and rel in local_files:
        conflicts.append(f"new upstream path collides with local file: {skill_rel}/{rel}")
if conflicts:
    print("Refusing to overwrite local content:", file=sys.stderr)
    for conflict in conflicts:
        print(f"  - {conflict}", file=sys.stderr)
    print("Resolve these changes manually, then update .upstream-revision only after review.", file=sys.stderr)
    raise SystemExit(1)

for rel in base_files.keys() - upstream_files.keys():
    (local / Path(rel.as_posix())).unlink()
for rel, data in upstream_files.items():
    dest = local / Path(rel.as_posix())
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
stamp.write_text(revision + "\n")
print(f"Synchronized {skill_rel} from upstream {revision}")
print(f"Preserved local extension: {skill_rel}/{extension}")
PYEOF
