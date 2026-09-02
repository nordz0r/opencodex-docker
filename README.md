# Operator-owned Docker image for OpenCodex (Remote Hub)

Verifiable, reproducible container packaging of
[OpenCodex](https://github.com/lidge-jun/opencodex) — the universal provider
proxy for OpenAI Codex, Claude Code, Claude Desktop & Grok Build.

**This repository contains packaging and CI only.** It is not a fork: every
image is built from the exact, signature-verified upstream git tag, and the
build refuses to run if `package.json` version or the commit hash do not
match. OpenCodex upstream publishes no official image; this follows the
[official Remote Hub Deployment recipe](https://opencodex.me/guides/remote-hub/).

## Published images

`docker run ghcr.io/nordz0r/opencodex:2.40.0` — exact tags are immutable and
built from a verified upstream release.

| Tag pattern | Example | Meaning |
|---|---|---|
| `X.Y.Z` / `vX.Y.Z` | `2.40.0`, `v2.40.0` | immutable, matches upstream release |
| `X.Y`, `X`, `latest` | `2.40`, `2`, `latest` | moving convenience tags |

Production deployments should pin the full digest:
`ghcr.io/nordz0r/opencodex@sha256:<digest>`.

Every release ships an SLSA-style
[artifact attestation](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
and an SPDX SBOM. Verify:

```bash
gh attestation verify \
  oci://ghcr.io/nordz0r/opencodex:2.40.0 \
  -R nordz0r/opencodex-docker
```

## What the image guarantees

- **Non-root** (`USER bun`), read-only-rootfs compatible; only
  `/home/bun/.opencodex` (state volume) and `/tmp` are writable.
- **Multi-arch**: `linux/amd64` and `linux/arm64` from the pinned
  `oven/bun:1.4.0@sha256:<digest>` base.
- **Version provenance in OCI labels**: upstream version, exact commit, source
  URL, license.
- **No credentials inside**: no `auth.json`, no tokens, no `.env`; the data
  admission token is read at runtime from `OCX_API_TOKEN_FILE`.
- **Only port `10100` exposed** (data plane). The management listener `10101`
  is not published — bind it to loopback inside your own network namespace if
  you need it.

## Quick start (docker compose)

```bash
# 1. Generate a data-admission token (NOT a provider credential)
export OCX_API_TOKEN=$(openssl rand -hex 32)
mkdir -p secrets && printf '%s' "$OCX_API_TOKEN" > secrets/ocx_api_token

# 2. First-run init on the named volume (before the normal start)
docker compose run --rm hub bun run src/cli/index.ts config set runtimeRole hub
docker compose run --rm hub bun run src/cli/index.ts config set hostname 0.0.0.0

# 3. Start
docker compose up -d

# 4. Prove readiness (healthz alone is NOT acceptance)
curl -fsS http://127.0.0.1:10100/healthz
curl -fsS http://127.0.0.1:10100/readyz
```

See [`compose.yaml`](compose.yaml) for the full definition — read-only rootfs,
tmpfs `/tmp`, named state volume, and the token mounted as a Docker secret.

## Upstream verification chain

`check-upstream.yml` runs daily:

1. Resolves the stable version from the npm dist-tag `latest` of
   `@bitkyc08/opencodex` (preview tags ignored).
2. Confirms the signed upstream git tag `vX.Y.Z` exists and that
   `package.json` in that tag declares the same version.
3. Skips if this registry already has an image with that exact tag
   (idempotent; no duplicate releases).
4. Otherwise triggers `build.yml` with the version and immutable commit SHA.

Inside the Dockerfile the build *re-verifies* both facts before
`bun install`, so a mismatch fails the build rather than shipping.

## Security policy

See [SECURITY.md](SECURITY.md). Never put tokens in build args, env, image
layers, or command lines. Never mount the Docker socket, host home, Codex
home, SSH agent, or provider key files into the container.

## License

MIT, same as upstream. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
