<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/banner-light.svg">
    <img alt="nordz0r/opencodex-docker — OpenCodex in Docker" src=".github/assets/banner-light.svg" width="100%">
  </picture>
</p>

<p align="right"><b>English</b> · <a href="README.md">Русский</a></p>

# OpenCodex Docker image — prebuilt container for the OpenCodex LLM proxy (Codex CLI & Claude Code)

**Run [OpenCodex](https://github.com/lidge-jun/opencodex) in Docker in one command:** a prebuilt,
multi-arch (`linux/amd64`, `linux/arm64`) image of the universal LLM provider proxy for
OpenAI Codex CLI, Claude Code, Claude Desktop & Grok Build — rebuilt automatically from every
upstream release and published to GHCR and Docker Hub.

[![Docker Pulls](https://img.shields.io/docker/pulls/nordz0r/opencodex?logo=docker)](https://hub.docker.com/r/nordz0r/opencodex)
[![Docker Image Version](https://img.shields.io/docker/v/nordz0r/opencodex?sort=semver&logo=docker)](https://hub.docker.com/r/nordz0r/opencodex/tags)
[![Image Size](https://img.shields.io/docker/image-size/nordz0r/opencodex/latest)](https://hub.docker.com/r/nordz0r/opencodex)
[![GitHub Release](https://img.shields.io/github/v/release/nordz0r/opencodex-docker?logo=github)](https://github.com/nordz0r/opencodex-docker/releases)
[![Build](https://github.com/nordz0r/opencodex-docker/actions/workflows/build.yml/badge.svg)](https://github.com/nordz0r/opencodex-docker/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

OpenCodex upstream ships a Dockerfile you build yourself but publishes **no official prebuilt
image**. This repository fills that gap: `docker pull` a ready-to-run OpenCodex container instead
of cloning and building. It follows the
[official Remote Hub Deployment recipe](https://opencodex.me/guides/remote-hub/).

- 🐳 **Prebuilt OpenCodex image** on `ghcr.io/nordz0r/opencodex` and `docker.io/nordz0r/opencodex`
- 🔁 **Always current** — upstream releases are detected automatically and rebuilt from the exact,
  verified upstream git tag (no fork, no patched code)
- 🔒 **Hardened** — non-root, read-only rootfs, `cap_drop: ALL`, no credentials in the image
- 🧾 **Verifiable** — SPDX SBOM + GitHub artifact attestation for every release
- 🧰 **Batteries included** — `codex`, `claude`, `grok` and `omp` CLIs embedded
- 🔌 **[`ocx` CLI](docs/ocx-cli.en.md)** — one command to point Codex, Claude Code, Claude Desktop,
  Grok Build and Oh My Pi at your hub
- 🧭 **[`jev-auto` combo](docs/jev-combo.en.md)** — one model for clients; Jev (TypeSafe System One)
  picks the target and effort for every step

**Contents:** [Quick start](#quick-start) · [Configuration](#configuration) ·
[Connecting clients](#connecting-clients) · [ocx CLI](#ocx-cli) · [Upgrade](#upgrade) ·
[Troubleshooting](#troubleshooting) · [Image tags](#image-tags) ·
[What the image guarantees](#what-the-image-guarantees) · [Security](#security-policy) · [License](#license)

## Quick start

All you need is Docker (with the Compose plugin for the Compose path). The hub listens on
`127.0.0.1:10100` by default.

### 1. Create the data-plane key

The key admits clients to the hub (`/v1/*`). It is **not** a provider key — provider and OAuth
credentials stay inside the hub's state volume.

```bash
mkdir -p secrets
openssl rand -hex 32 > secrets/ocx_api_token
chmod 600 secrets/ocx_api_token
```

### 2a. Docker Compose (recommended)

```bash
git clone https://github.com/nordz0r/opencodex-docker.git && cd opencodex-docker
# create secrets/ocx_api_token here as in step 1
docker compose up -d
curl -fsS http://127.0.0.1:10100/healthz && curl -fsS http://127.0.0.1:10100/readyz
```

`compose.yaml` uses the moving `latest` tag. For production, set `image:` to an exact tag or digest,
e.g. `ghcr.io/nordz0r/opencodex:2.83.0` or
`ghcr.io/nordz0r/opencodex@sha256:21114343d57ee084f96b303cef9b5887445a5533f3fff6190dbf9a94d18a0d15`
(v2.83.0). The digest of every release is on the
[Releases page](https://github.com/nordz0r/opencodex-docker/releases).

### 2b. docker run

```bash
docker run -d --name opencodex --restart unless-stopped \
  --init --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m,mode=1777 \
  -p 127.0.0.1:10100:10100 \
  -e NODE_ENV=production -e OCX_SERVICE=1 \
  -e OPENCODEX_HOME=/home/bun/.opencodex -e CODEX_HOME=/home/bun/.codex \
  -e OCX_API_TOKEN_FILE=/run/secrets/ocx_api_token \
  -v opencodex_ocx-state:/home/bun/.opencodex \
  -v opencodex_codex-state:/home/bun/.codex \
  -v "$PWD/secrets/ocx_api_token:/run/secrets/ocx_api_token:ro" \
  ghcr.io/nordz0r/opencodex:2.83.0      # or :latest, or @sha256:<digest>

curl -fsS http://127.0.0.1:10100/healthz && curl -fsS http://127.0.0.1:10100/readyz
```

The container runs as UID 1000 (`bun`), so the key file must be readable by it — see
[Troubleshooting](#troubleshooting). The same image is on Docker Hub as `nordz0r/opencodex:<tag>`.

### 3. Add providers

Providers, OAuth logins and routing are configured with the OpenCodex CLI inside the container
(it shares the state volume) or through the dashboard behind your own HTTPS frontend:

```bash
docker compose exec hub bun run src/cli/index.ts --help
docker compose exec hub bun run src/cli/index.ts status
```

See the upstream [Remote Hub guide](https://opencodex.me/guides/remote-hub/) and
[docs](https://opencodex.me/) for provider setup.

### 4. Check that a client is admitted

```bash
curl -fsS -H "Authorization: Bearer $(cat secrets/ocx_api_token)" http://127.0.0.1:10100/v1/models
```

`/healthz` only proves the process is alive; acceptance also needs `/readyz`, an authenticated
`/v1/catalog` or `/v1/models`, and one real routed response.

## Configuration

| Setting | Where | Default | Meaning |
|---|---|---|---|
| `OPENCODEX_BIND_ADDRESS` | shell / `.env` for Compose | `127.0.0.1` | host address the port is published on (LAN/Tailscale IP or `0.0.0.0` to expose) |
| `OPENCODEX_PORT` | shell / `.env` for Compose | `10100` | host port; the container always listens on `10100` |
| `secrets/ocx_api_token` | file | — | data-plane key, mounted read-only at `/run/secrets/ocx_api_token` |
| `OCX_API_TOKEN_FILE` | container env | `/run/secrets/ocx_api_token` | where the hub reads the key |
| `OPENCODEX_HOME` | container env | `/home/bun/.opencodex` | OpenCodex config, provider credentials, usage (volume `ocx-state`) |
| `CODEX_HOME` | container env | `/home/bun/.codex` | Codex state and `opencodex-catalog.json` (volume `codex-state`) |

Volumes in `compose.yaml`: `ocx-state`, `codex-state`, plus operator extras `claude-state`
(`/home/bun/.claude`) and `grok-state` (`/home/bun/.grok`) that persist the embedded CLIs' state.
On first start an empty `ocx-state` is seeded with the upstream hub config (`runtimeRole=hub`,
`hostname=0.0.0.0`); an existing `config.json` is never overwritten.

Exposing the hub to other machines: set `OPENCODEX_BIND_ADDRESS` and put an authenticated HTTPS or
tailnet frontend (Caddy, nginx, Tailscale Serve) in front. Clients and `ocx` send the key in plain
HTTP otherwise, and `ocx` refuses non-loopback HTTP. Never publish the management port `10101`.

## Connecting clients

| What | Value |
|---|---|
| OpenAI-compatible base URL | `http://127.0.0.1:10100/v1` (or `https://<your-hub>/v1`) |
| Anthropic base URL (Claude Code) | `http://127.0.0.1:10100` (no `/v1`) |
| Key | contents of `secrets/ocx_api_token` |
| Auth header | `Authorization: Bearer <key>` or `x-opencodex-api-key: <key>` |
| Endpoints | `POST /v1/responses`, `POST /v1/chat/completions`, `POST /v1/messages`, `GET /v1/models`, `GET /v1/catalog` |
| Model ids | whatever `GET /v1/models` returns for your providers |

The fastest way is the [`ocx` CLI](#ocx-cli): `node bin/ocx.mjs apply --client codex --client claude`.
Manual configs:

### Codex CLI

`~/.codex/config.toml` (this is what `ocx apply --client codex` writes, minus the downloaded
model catalog):

```toml
model_provider = "opencodex"

[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENCODEX_API_AUTH_TOKEN"
```

```bash
export OPENCODEX_API_AUTH_TOKEN="$(cat /path/to/secrets/ocx_api_token)"
codex
```

### Claude Code

`~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:10100",
    "ANTHROPIC_AUTH_TOKEN": "<key>",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

Or for one shell: `ANTHROPIC_BASE_URL=http://127.0.0.1:10100 ANTHROPIC_AUTH_TOKEN=<key> claude`.
`ocx apply --client claude` additionally maps the opus/sonnet/haiku slots and the `/model` picker to
the hub's assignments.

### OpenAI-compatible clients (SDKs, Open WebUI, Continue, Cursor, …)

```bash
curl -s http://127.0.0.1:10100/v1/chat/completions \
  -H "Authorization: Bearer $(cat secrets/ocx_api_token)" \
  -H "Content-Type: application/json" \
  -d '{"model":"<model-id>","messages":[{"role":"user","content":"Hello"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:10100/v1", api_key=open("secrets/ocx_api_token").read().strip())
print(client.chat.completions.create(model="<model-id>", messages=[{"role": "user", "content": "Hello"}]).choices[0].message.content)
```

In GUI clients choose "OpenAI-compatible", set the base URL and paste the key as the API key.

## ocx CLI

[`bin/ocx.mjs`](bin/ocx.mjs) is a single-file, dependency-free Node.js (≥ 18) script that configures
Codex CLI, Claude Code, Claude Desktop, Grok Build and Oh My Pi on **your workstation** to use the
hub. Every change is journaled and can be undone with `restore`.

```bash
curl -fsSLo ocx.mjs https://raw.githubusercontent.com/nordz0r/opencodex-docker/main/bin/ocx.mjs
export OCX_HUB=https://ocx.example.com          # or http://127.0.0.1:10100 on the hub host
export OCX_API_TOKEN_FILE=~/secrets/ocx_api_token
node ocx.mjs models                              # list the hub catalog
node ocx.mjs apply --client codex --client claude
node ocx.mjs restore --client claude             # undo
node ocx.mjs apply --client omp --omp-judge gpt-6-luna:low   # omp + judge model (modelRoles.judge)
```

For `omp` you can set the `judge` role — the model that answers short evaluation questions
(auto effort selection, `find` ranking, eval `judge()`). Without `--omp-judge` an existing
setting is left alone; `--omp-judge auto` restores omp's default chain. Details:
[docs/ocx-cli.en.md](docs/ocx-cli.en.md#omp-judge-model).

Full guide: [docs/ocx-cli.en.md](docs/ocx-cli.en.md).

One model, `jev-auto`, that picks the target and effort for every step via Jev (TypeSafe
System One): [docs/jev-combo.en.md](docs/jev-combo.en.md).

## Upgrade

```bash
docker compose pull && docker compose up -d     # Compose with :latest
# pinned: edit image: to the new tag/digest, then
docker compose up -d
```

For `docker run`: `docker pull` the new tag, `docker rm -f opencodex`, run the same command with the
new tag — the named volumes keep config, credentials and usage. Do not re-create the key.

- Exact tags (`2.83.0`) never change; `latest`, `2`, `2.83` move with each release.
- Rollback: start the previous tag/digest on the same volumes.
- `docker compose down` keeps volumes; `docker compose down --volumes` **deletes** config,
  OAuth credentials, usage history and Codex state.
- Release notes: [Releases](https://github.com/nordz0r/opencodex-docker/releases) (each links to the
  upstream changelog).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Container keeps restarting or the hub reports a missing/unreadable token | The key file must be readable by UID 1000: `sudo chown 1000:1000 secrets/ocx_api_token && chmod 400 secrets/ocx_api_token` (Compose already mounts it as uid 1000, mode 0440). |
| `/healthz` is 200 but `/readyz` fails | The hub is alive but not ready — check `docker compose logs hub` and the provider setup. |
| `401` / `403` on `/v1/*` | Wrong or missing key; send `Authorization: Bearer <key>` or `x-opencodex-api-key`. |
| `403 origin_rejected` behind a TLS proxy while `/readyz` is 200 | The data listener must not be bound to loopback behind a frontend; keep the image default (`0.0.0.0` in the container). See upstream [Giving the data listener TLS](https://opencodex.me/guides/remote-hub/). |
| Cannot connect from another machine | Default publication is `127.0.0.1`. Set `OPENCODEX_BIND_ADDRESS`, open the firewall, add HTTPS. |
| `ocx`: `Use HTTPS for a remote hub` | `ocx` sends the key only over HTTPS or loopback HTTP. Use an HTTPS frontend or an SSH tunnel: `ssh -L 10100:127.0.0.1:10100 host`. |
| Codex reports `catalog_not_found` | Run `ocx apply --client codex` (writes `opencodex-catalog.json`) or import a catalog into `CODEX_HOME`. |
| Port already in use | `OPENCODEX_PORT=10190 docker compose up -d` |
| Read-only filesystem errors | Only `/home/bun/.opencodex`, `/home/bun/.codex`, `/tmp` (and the Compose extras) are writable by design. |

## Image tags

| Tag pattern | Example | Meaning |
|---|---|---|
| `X.Y.Z` / `vX.Y.Z` | `2.83.0`, `v2.83.0` | immutable, matches the upstream OpenCodex release |
| `X.Y`, `X`, `latest` | `2.83`, `2`, `latest` | moving convenience tags |

Available from both registries: `ghcr.io/nordz0r/opencodex:<tag>` and `nordz0r/opencodex:<tag>`.
Production deployments should pin the full digest: `ghcr.io/nordz0r/opencodex@sha256:<digest>`.

Every release ships an SLSA-style
[artifact attestation](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
and an SPDX SBOM. Verify:

```bash
gh attestation verify oci://ghcr.io/nordz0r/opencodex:2.83.0 -R nordz0r/opencodex-docker
```

## What the image guarantees

- **Non-root** (`USER bun`), read-only-rootfs compatible; only
  `/home/bun/.opencodex`, `/home/bun/.codex` (state volumes) and `/tmp` are writable.
- **Multi-arch**: `linux/amd64` and `linux/arm64` from the pinned
  `oven/bun:1.4.2@sha256:<digest>` base.
- **Embedded CLIs**: `codex`, `claude`, `grok`, `omp` (`@oh-my-pi/pi-coding-agent`).
- **Upstream container contract**: `OCX_SERVICE=1`, separate `CODEX_HOME`,
  compatibility-version gate (`docker/verify-compatibility.ts`), hub seed
  `docker/config.json` (`runtimeRole=hub`, `hostname=0.0.0.0`) copied only
  when the state volume has no `config.json`. Token stays
  `OCX_API_TOKEN_FILE=/run/secrets/ocx_api_token` (not upstream's
  in-volume `service-api-token`).
- **Version provenance in OCI labels**: upstream version, exact commit, source
  URL, license.
- **No credentials inside**: no `auth.json`, no tokens, no `.env`; the data
  admission token is read at runtime from `OCX_API_TOKEN_FILE`.
- **Only port `10100` exposed** (data plane). The management listener `10101`
  is not published — bind it to loopback inside your own network namespace if
  you need it.

## Upstream verification chain

`check-upstream.yml` runs about every 10 minutes (`3,13,23,33,43,53 * * * *`; GitHub may delay):

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
