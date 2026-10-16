<p align="right"><b>English</b> · <a href="ocx-cli.md">Русский</a></p>

# ocx CLI — connect Codex CLI, Claude Code, Claude Desktop, Grok Build and Oh My Pi to an OpenCodex hub

[`bin/ocx.mjs`](../bin/ocx.mjs) configures AI coding clients on your workstation to use a running
OpenCodex hub (for example the [opencodex-docker](../README.en.md) container). It downloads the hub's
model catalog with your data-plane key and writes the matching settings into each client's own
config files. Every write is journaled, so `restore` puts the original files back.

- Single file, no dependencies, no build step. Needs **Node.js ≥ 18** (built-in `fetch`).
- Linux, macOS, Windows and WSL (on WSL it also updates the Windows-side client homes it finds).
- No local OpenCodex install, proxy or service is required on the workstation.

## Install

```bash
curl -fsSLo ocx.mjs https://raw.githubusercontent.com/nordz0r/opencodex-docker/main/bin/ocx.mjs
node ocx.mjs --help
```

Or from a clone: `node bin/ocx.mjs --help`. On Unix you can also `chmod +x ocx.mjs && ./ocx.mjs`.

## Point it at your hub

You need two things: the hub URL and the data-plane key (the contents of `secrets/ocx_api_token`
on the hub host — **not** a provider key).

```bash
node ocx.mjs configure --hub https://ocx.example.com  # hidden key input in a terminal
# Without a TTY: node ocx.mjs configure --hub https://ocx.example.com --token-stdin < /path/to/key
```

Hub URL is taken from, in order: `--hub <url>`, `OCX_HUB`, `"hub"` in
`$OCX_STATE_HOME/connection.json`, then `https://ocx.goldfinches.ru`.
Remote hubs must be **HTTPS**; plain HTTP is accepted only for `localhost`,
`127.0.0.1` and `[::1]`. No HTTPS yet? Use an SSH tunnel and the loopback URL:

```bash
ssh -N -L 10100:127.0.0.1:10100 user@hub-host &
export OCX_HUB=http://127.0.0.1:10100
```

Key precedence: `OCX_API_TOKEN`, an explicit `OCX_API_TOKEN_FILE`, `$OCX_STATE_HOME/api-key`,
then `~/.opencodex/service-api-token` (also the Windows profile on WSL).
A missing, unreadable or empty explicit key file aborts without falling back to another key.
`configure` saves the key only in its own `api-key` with mode `0600`; it does not change client files.

## Commands

| Command | What it does |
|---|---|
| `node ocx.mjs` | In a terminal: interactive picker (space to toggle, `a` all, arrows/mouse, enter). Without a TTY: same as `status`. |
| `node ocx.mjs status [--client <id> ...]` | Read-only: hub URL, which clients are installed, which are managed by ocx, which files exist. |
| `node ocx.mjs configure [--hub <url>] [--omp-api <api>] [--token-stdin]` | Saves connection and OMP API; hidden key input in a TTY, explicit stdin input otherwise. |
| `node ocx.mjs models` | Lists the hub catalog (`GET /v1/catalog`): id, context window, kind (native / routed / combo), name. |
| `node ocx.mjs apply --client <id> [...]` | Fetches the catalog and writes hub settings into the chosen clients. |
| `node ocx.mjs restore --client <id> [...]` | Restores the files saved before the first `apply` for those clients. |
| `node ocx.mjs help` / `--help` / `-h` | Usage. |

Client ids: `codex`, `claude` (alias `claude-code`), `claude-desktop`, `grok`, `omp`.
Global option: `--hub <url>`. `--omp-api` and `--token-stdin` are configure-only options.

## What `apply` changes

| Client | Files (default locations) | Notes |
|---|---|---|
| `codex` | `~/.codex/config.toml`, `~/.codex/opencodex-catalog.json` | Sets `model_provider = "opencodex"`, `[model_providers.opencodex]` with `base_url = <hub>/v1`, `wire_api = "responses"`, `requires_openai_auth = false`, `env_key = "OCX_API_TOKEN"`, and the model catalog. The key is not written; export `OCX_API_TOKEN` in the environment that launches Codex. |
| `claude` | `~/.claude/settings.json`, `~/.claude/cache/gateway-models.json` | `env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_AUTH_TOKEN`, gateway model discovery, opus/sonnet/fable/haiku slots and the `/model` picker from the hub assignments; sets `disableClaudeAiConnectors`. Removes the legacy `claude-env.sh` hook from `~/.bashrc`. |
| `claude-desktop` | `Claude-3p/configLibrary/<id>.json` and `_meta.json` (`%LOCALAPPDATA%` on Windows, `~/.config` elsewhere) | Creates/updates and selects a gateway profile named `opencodex`. Refuses to switch away from a foreign profile that is currently selected. |
| `grok` | `~/.grok/config.toml` | Replaces a fenced `# >>> opencodex managed block` with the hub provider and one `ocx-<model>` entry per catalog model (Claude models excluded). |
| `omp` | `~/.omp/agent/models.yml`, existing `~/.omp/agent/config.yml` | Adds provider `ocx` with base models from `/v1/models`, enriched by `/v1/catalog`. API defaults to `openai-responses`, optionally `anthropic-messages`. Extends an existing `enabledProviders` list; preserves model roles including judge. |

Safety rules:

- The key is stored in plaintext in the Claude, Claude Desktop, Grok and Oh My Pi configs. All
  files are written with mode `0600`, atomically.
- Before writing, the original of each file is saved in the journal `~/.ocx-export/integrations.json`.
- `restore` refuses to overwrite a file you edited after `apply` ("File changed since apply").
- `apply` shows manual changes against the journal and asks for confirmation in a TTY;
  without an interactive terminal, it refuses to overwrite them.
- A run holds the lock directory `~/.ocx-export/mutation.lock`; a second run fails instead of racing.
- An empty or invalid hub catalog aborts the run before anything is written.
- The log `~/.ocx-export/ocx-export.log` redacts tokens and keys.

## OMP API and model roles

```bash
node ocx.mjs configure --omp-api anthropic-messages
node ocx.mjs apply --client omp
node ocx.mjs configure --omp-api openai-responses
```

`configure` without `--omp-api` preserves the saved API. Claude aliases and pinned effort/fast
variants are excluded from OMP; reasoning capabilities come from the hub.

This version removes `--omp-judge` and `OCX_OMP_JUDGE`. Configure `modelRoles.judge` in omp
itself; `apply` preserves it along with the other model roles.


## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OCX_HUB` | `https://ocx.goldfinches.ru` without a saved connection | hub origin |
| `OCX_API_TOKEN` | — | data-plane key (prefer a file) |
| `OCX_API_TOKEN_FILE` | — | explicit key file; read failures forbid fallback |
| `OCX_STATE_HOME` | `~/.ocx-export` | journal, lock, optional `connection.json` |
| `OCX_LOG_FILE` | `$OCX_STATE_HOME/ocx-export.log` | log file |
| `OCX_NONINTERACTIVE=1` | — | never open the picker (CI, scripts) |
| `OCX_ASSUME_TTY=1` | — | force the picker |
| `NO_COLOR` | — | disable colors |
| `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `OMP_HOME` | `~/.codex`, `~/.claude`, `~/.grok`, `~/.omp` | client homes |
| `OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR`, `CLAUDE_USER_DATA_DIR` | see table above | Claude Desktop profile location |

## Examples

```bash
# What would be affected?
node ocx.mjs status

# Codex + Claude Code against a remote hub
OCX_HUB=https://ocx.example.com node ocx.mjs apply --client codex --client claude
export OCX_API_TOKEN="$(cat ~/.ocx-export/api-key)"   # for Codex
codex

# Refresh after models changed on the hub: just apply again
node ocx.mjs apply --client claude

# Undo
node ocx.mjs restore --client codex --client claude

# On the hub host itself (container published on 127.0.0.1:10100)
OCX_HUB=http://127.0.0.1:10100 OCX_API_TOKEN_FILE=./secrets/ocx_api_token node bin/ocx.mjs models
```

## Troubleshooting

| Message | Meaning / fix |
|---|---|
| `No hub API key found` | Run `configure` with hidden key input or set `OCX_API_TOKEN_FILE`. |
| `Use HTTPS for a remote hub` | Use an HTTPS origin or an SSH tunnel to `http://127.0.0.1:10100`. |
| `Hub /v1/catalog: HTTP 401/403` | Wrong key, or hub behind a frontend with loopback bind (see main README). |
| `Hub catalog is empty` | No providers configured on the hub yet. |
| `Another mutation or interrupted run holds …/mutation.lock` | Make sure no other ocx run is active, then remove the directory. |
| `File changed since apply; refusing to overwrite` | `restore` protects manual edits. Review and confirm them for a repeated `apply` in a TTY; without a TTY, apply aborts. |
| `Claude Desktop currently selects a foreign profile` | Select the `opencodex` profile (or none) in Claude Desktop first. |

The interactive picker's labels are currently in Russian; all non-interactive commands print English.
