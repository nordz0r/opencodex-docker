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
export OCX_HUB=https://ocx.example.com                 # hub origin, no path
mkdir -p ~/.ocx-export && chmod 700 ~/.ocx-export
printf '%s' '<key>' > ~/.ocx-export/api-key && chmod 600 ~/.ocx-export/api-key
```

Hub URL is taken from, in order: `--hub <url>`, `OCX_HUB`, `"hub"` in
`$OCX_STATE_HOME/connection.json`, then `http://127.0.0.1:10100` (the container's default local
publication). Remote hubs must be **HTTPS**; plain HTTP is accepted only for `localhost`,
`127.0.0.1` and `[::1]`. No HTTPS yet? Use an SSH tunnel and the loopback URL:

```bash
ssh -N -L 10100:127.0.0.1:10100 user@hub-host &
export OCX_HUB=http://127.0.0.1:10100
```

The key is taken from, in order: `OCX_API_TOKEN`, the file `OCX_API_TOKEN_FILE`
(default `~/.ocx-export/api-key`), then `$OPENCODEX_HOME/service-api-token`
(default `~/.opencodex/service-api-token`). Prefer a file over the environment variable.

## Commands

| Command | What it does |
|---|---|
| `node ocx.mjs` | In a terminal: interactive picker (space to toggle, `a` all, arrows/mouse, enter). Without a TTY: same as `status`. |
| `node ocx.mjs status [--client <id> ...]` | Read-only: hub URL, which clients are installed, which are managed by ocx, which files exist. |
| `node ocx.mjs models` | Lists the hub catalog (`GET /v1/catalog`): id, context window, kind (native / routed / combo), name. |
| `node ocx.mjs apply --client <id> [...]` | Fetches the catalog and writes hub settings into the chosen clients. |
| `node ocx.mjs restore --client <id> [...]` | Restores the files saved before the first `apply` for those clients. |
| `node ocx.mjs help` / `--help` / `-h` | Usage. |

Client ids: `codex`, `claude` (alias `claude-code`), `claude-desktop`, `grok`, `omp`.
Global option: `--hub <url>`. For `omp`: `--omp-judge <model>` (see below).

## What `apply` changes

| Client | Files (default locations) | Notes |
|---|---|---|
| `codex` | `~/.codex/config.toml`, `~/.codex/opencodex-catalog.json` | Sets `model_provider = "opencodex"`, `[model_providers.opencodex]` with `base_url = <hub>/v1`, `wire_api = "responses"`, `env_key = "OPENCODEX_API_AUTH_TOKEN"`, and the downloaded model catalog. The key is **not** written; export `OPENCODEX_API_AUTH_TOKEN` before running `codex`. |
| `claude` | `~/.claude/settings.json`, `~/.claude/cache/gateway-models.json` | `env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_AUTH_TOKEN`, gateway model discovery, opus/sonnet/fable/haiku slots and the `/model` picker from the hub assignments; sets `disableClaudeAiConnectors`. Removes the legacy `claude-env.sh` hook from `~/.bashrc`. |
| `claude-desktop` | `Claude-3p/configLibrary/<id>.json` and `_meta.json` (`%LOCALAPPDATA%` on Windows, `~/.config` elsewhere) | Creates/updates and selects a gateway profile named `opencodex`. Refuses to switch away from a foreign profile that is currently selected. |
| `grok` | `~/.grok/config.toml` | Replaces a fenced `# >>> opencodex managed block` with the hub provider and one `ocx-<model>` entry per catalog model (Claude models excluded). |
| `omp` | `~/.omp/agent/models.yml`, `~/.omp/agent/config.yml` | Adds provider `ocx` (`openai-responses`) with the catalog models and enables it. With `--omp-judge` also writes `modelRoles.judge` to `config.yml`. |

Safety rules:

- The key is stored in plaintext in the Claude, Claude Desktop, Grok and Oh My Pi configs. All
  files are written with mode `0600`, atomically.
- Before writing, the original of each file is saved in the journal `~/.ocx-export/integrations.json`.
- `restore` refuses to overwrite a file you edited after `apply` ("File changed since apply").
- A run holds the lock directory `~/.ocx-export/mutation.lock`; a second run fails instead of racing.
- An empty or invalid hub catalog aborts the run before anything is written.
- The log `~/.ocx-export/ocx-export.log` redacts tokens and keys.

## omp judge model

In omp the `judge` role (`modelRoles.judge` in `~/.omp/agent/config.yml`) is the model that answers
short yes/no, choice and score questions: auto effort selection, `find` ranking, eval `judge()` /
`judge_batch()`, premature-stop detection, the `/stats` Frustration page. When unset, omp uses
`typesafe/jev-latest`, then `@tiny`, `@smol`, `@default`.

```bash
node ocx.mjs apply --client omp --omp-judge gpt-6-luna:low        # → ocx/gpt-6-luna:low (hub model)
node ocx.mjs apply --client omp --omp-judge codiv/openjev-latest  # native judge from your own provider
node ocx.mjs apply --client omp --omp-judge auto                  # unset, omp default chain
node ocx.mjs status --client omp                                  # shows the current judge
```

- A hub catalog id (optionally with `:low` etc.) gets the `ocx/` prefix and is checked against the catalog.
- A foreign `provider/model` (e.g. `codiv/openjev-latest` with `api: typesafe`) is written as is;
  configure that provider in `models.yml` yourself.
- Without `--omp-judge` / `OCX_OMP_JUDGE` an existing judge is never touched. The file is journaled,
  so `restore --client omp` puts it back.
- For a hub judge pick a fast, cheap model at low effort: calls are many and short.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OCX_HUB` | — | hub origin |
| `OCX_API_TOKEN` | — | data-plane key (prefer a file) |
| `OCX_API_TOKEN_FILE` | `~/.ocx-export/api-key` | file with the key |
| `OCX_STATE_HOME` | `~/.ocx-export` | journal, lock, optional `connection.json` |
| `OCX_LOG_FILE` | `~/.ocx-export/ocx-export.log` | log file |
| `OCX_NONINTERACTIVE=1` | — | never open the picker (CI, scripts) |
| `OCX_ASSUME_TTY=1` | — | force the picker |
| `OCX_OMP_JUDGE` | — | same as `--omp-judge` |
| `OCX_COMBO_PREFIXES` | `combo/` | comma-separated id prefixes shown as `combo` by `models` |
| `NO_COLOR` | — | disable colors |
| `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `OMP_HOME`, `OPENCODEX_HOME` | `~/.codex`, `~/.claude`, `~/.grok`, `~/.omp`, `~/.opencodex` | client homes |
| `OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR`, `CLAUDE_USER_DATA_DIR` | see table above | Claude Desktop profile location |

## Examples

```bash
# What would be affected?
node ocx.mjs status

# Codex + Claude Code against a remote hub
OCX_HUB=https://ocx.example.com node ocx.mjs apply --client codex --client claude
export OPENCODEX_API_AUTH_TOKEN="$(cat ~/.ocx-export/api-key)"   # for Codex
codex

# Refresh after models changed on the hub: just apply again
node ocx.mjs apply --client claude

# Undo
node ocx.mjs restore --client codex --client claude

# On the hub host itself (container published on 127.0.0.1:10100)
OCX_API_TOKEN_FILE=./secrets/ocx_api_token node bin/ocx.mjs models
```

## Troubleshooting

| Message | Meaning / fix |
|---|---|
| `Missing hub admission key` | No key found: set `OCX_API_TOKEN_FILE` or create `~/.ocx-export/api-key`. |
| `Use HTTPS for a remote hub` | Use an HTTPS origin or an SSH tunnel to `http://127.0.0.1:10100`. |
| `Hub /v1/catalog: HTTP 401/403` | Wrong key, or hub behind a frontend with loopback bind (see main README). |
| `Hub catalog is empty` | No providers configured on the hub yet. |
| `Another mutation or interrupted run holds …/mutation.lock` | Make sure no other ocx run is active, then remove the directory. |
| `File changed since apply; refusing to overwrite` | You edited a managed file after `apply`. Revert your edit or remove that entry from the journal deliberately. |
| `Claude Desktop currently selects a foreign profile` | Select the `opencodex` profile (or none) in Claude Desktop first. |

The interactive picker's labels are currently in Russian; all non-interactive commands print English.
