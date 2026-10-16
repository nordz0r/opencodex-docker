<p align="right"><a href="ocx-cli.en.md">English</a> · <b>Русский</b></p>

# CLI ocx — подключение Codex CLI, Claude Code, Claude Desktop, Grok Build и Oh My Pi к хабу OpenCodex

[`bin/ocx.mjs`](../bin/ocx.mjs) настраивает AI-клиенты на вашей рабочей машине на работу через
запущенный хаб OpenCodex (например, контейнер [opencodex-docker](../README.md)). Скрипт скачивает
каталог моделей хаба по вашему ключу доступа и прописывает нужные настройки в собственные конфиги
каждого клиента. Все записи журналируются, поэтому `restore` возвращает исходные файлы.

- Один файл, без зависимостей и сборки. Нужен **Node.js ≥ 18** (встроенный `fetch`).
- Linux, macOS, Windows и WSL (в WSL заодно обновляет найденные каталоги клиентов на стороне Windows).
- На рабочей машине не нужны ни OpenCodex, ни локальный прокси, ни служба.

## Установка

```bash
curl -fsSLo ocx.mjs https://raw.githubusercontent.com/nordz0r/opencodex-docker/main/bin/ocx.mjs
node ocx.mjs --help
```

Или из клона: `node bin/ocx.mjs --help`. В Unix можно `chmod +x ocx.mjs && ./ocx.mjs`.

## Указываем хаб

Нужны две вещи: адрес хаба и ключ доступа (содержимое `secrets/ocx_api_token` на хосте хаба, это
**не** ключ провайдера).

```bash
node ocx.mjs configure --hub https://ocx.example.com  # ввод ключа скрыт в терминале
# Без TTY: node ocx.mjs configure --hub https://ocx.example.com --token-stdin < /path/to/key
```

Адрес хаба берётся по порядку: `--hub <url>`, `OCX_HUB`, поле `"hub"` в
`$OCX_STATE_HOME/connection.json`, иначе `https://ocx.goldfinches.ru`.
Удалённый хаб — только по **HTTPS**; обычный HTTP разрешён лишь для `localhost`,
`127.0.0.1` и `[::1]`. Если HTTPS пока нет, поднимите SSH-туннель и используйте loopback-адрес:

```bash
ssh -N -L 10100:127.0.0.1:10100 user@hub-host &
export OCX_HUB=http://127.0.0.1:10100
```

Ключ берётся по порядку: `OCX_API_TOKEN`, явно заданный файл `OCX_API_TOKEN_FILE`,
`$OCX_STATE_HOME/api-key`, затем `~/.opencodex/service-api-token` (в WSL также Windows-профиль).
Если явно заданный файл отсутствует, недоступен или пуст, запуск прекращается без подстановки другого ключа.
`configure` сохраняет ключ только в собственный `api-key` с правами `0600`; конфиги клиентов не меняет.

## Команды

| Команда | Что делает |
|---|---|
| `node ocx.mjs` | В терминале — интерактивный выбор (пробел отмечает, `a` — все, стрелки/мышь, enter). Без TTY — то же, что `status`. |
| `node ocx.mjs status [--client <id> ...]` | Только чтение: адрес хаба, какие клиенты установлены, какими управляет ocx, какие файлы есть. |
| `node ocx.mjs configure [--hub <url>] [--omp-api <api>] [--token-stdin]` | Сохраняет подключение и API OMP; вводит ключ скрыто в TTY либо читает stdin с явным флагом. |
| `node ocx.mjs models` | Каталог хаба (`GET /v1/catalog`): id, контекстное окно, тип (native / routed / combo), название. |
| `node ocx.mjs apply --client <id> [...]` | Скачивает каталог и прописывает настройки хаба в выбранные клиенты. |
| `node ocx.mjs restore --client <id> [...]` | Возвращает файлы, сохранённые перед первым `apply` для этих клиентов. |
| `node ocx.mjs help` / `--help` / `-h` | Справка. |

ID клиентов: `codex`, `claude` (синоним `claude-code`), `claude-desktop`, `grok`, `omp`.
Общая опция: `--hub <url>`. `--omp-api` и `--token-stdin` доступны только для `configure`.

## Что меняет `apply`

| Клиент | Файлы (по умолчанию) | Примечания |
|---|---|---|
| `codex` | `~/.codex/config.toml`, `~/.codex/opencodex-catalog.json` | Ставит `model_provider = "opencodex"`, `[model_providers.opencodex]` с `base_url = <хаб>/v1`, `wire_api = "responses"`, `requires_openai_auth = false`, `env_key = "OCX_API_TOKEN"` и каталог моделей. Сам ключ не записывается: экспортируйте `OCX_API_TOKEN` в окружении запуска Codex. |
| `claude` | `~/.claude/settings.json`, `~/.claude/cache/gateway-models.json` | `env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_AUTH_TOKEN`, обнаружение моделей через шлюз, слоты opus/sonnet/fable/haiku и список `/model` по назначениям хаба; включает `disableClaudeAiConnectors`. Убирает старый хук `claude-env.sh` из `~/.bashrc`. |
| `claude-desktop` | `Claude-3p/configLibrary/<id>.json` и `_meta.json` (`%LOCALAPPDATA%` в Windows, `~/.config` в остальных) | Создаёт или обновляет профиль шлюза `opencodex` и выбирает его. Не переключает, если сейчас выбран чужой профиль. |
| `grok` | `~/.grok/config.toml` | Заменяет блок между метками `# >>> opencodex managed block` на провайдера хаба и по записи `ocx-<модель>` на каждую модель каталога (модели Claude исключаются). |
| `omp` | `~/.omp/agent/models.yml`, существующий `~/.omp/agent/config.yml` | Добавляет провайдера `ocx` с базовыми моделями из `/v1/models`, обогащёнными `/v1/catalog`. API по умолчанию `openai-responses`, опционально `anthropic-messages`. Существующий список `enabledProviders` дополняется; роли моделей, включая judge, сохраняются. |

Правила безопасности:

- В конфигах Claude, Claude Desktop, Grok и Oh My Pi ключ хранится открытым текстом. Все файлы
  пишутся атомарно с правами `0600`.
- Перед записью оригинал каждого файла сохраняется в журнал `~/.ocx-export/integrations.json`.
- `restore` не перезапишет файл, который вы правили после `apply` («File changed since apply»).
- `apply` показывает ручные изменения относительно журнала и запрашивает подтверждение в TTY;
  без интерактивного терминала отказывается перезаписывать их.
- На время работы занимается каталог-блокировка `~/.ocx-export/mutation.lock`; второй запуск
  завершится ошибкой, а не будет мешать первому.
- Пустой или некорректный каталог хаба прерывает запуск до любых записей.
- В логе `~/.ocx-export/ocx-export.log` токены и ключи маскируются.

## API и роли моделей omp

```bash
node ocx.mjs configure --omp-api anthropic-messages
node ocx.mjs apply --client omp
node ocx.mjs configure --omp-api openai-responses
```

`configure` без `--omp-api` сохраняет предыдущий выбор. Псевдонимы Claude и варианты с
закреплёнными effort/fast в OMP не импортируются; reasoning-возможности берутся из данных хаба.

В этой версии удалены `--omp-judge` и `OCX_OMP_JUDGE`: роль `modelRoles.judge` настраивается
средствами самого omp. `apply` сохраняет её, как и остальные роли моделей.


## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `OCX_HUB` | `https://ocx.goldfinches.ru` без сохранённого подключения | origin хаба |
| `OCX_API_TOKEN` | — | ключ доступа (лучше файл) |
| `OCX_API_TOKEN_FILE` | — | явный файл ключа; ошибка чтения запрещает fallback |
| `OCX_STATE_HOME` | `~/.ocx-export` | журнал, блокировка, необязательный `connection.json` |
| `OCX_LOG_FILE` | `$OCX_STATE_HOME/ocx-export.log` | файл лога |
| `OCX_NONINTERACTIVE=1` | — | никогда не открывать интерактивный выбор (CI, скрипты) |
| `OCX_ASSUME_TTY=1` | — | всегда открывать интерактивный выбор |
| `NO_COLOR` | — | отключить цвета |
| `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `OMP_HOME` | `~/.codex`, `~/.claude`, `~/.grok`, `~/.omp` | каталоги клиентов |
| `OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR`, `CLAUDE_USER_DATA_DIR` | см. таблицу выше | где лежат профили Claude Desktop |

## Примеры

```bash
# Что будет затронуто?
node ocx.mjs status

# Codex и Claude Code на удалённый хаб
OCX_HUB=https://ocx.example.com node ocx.mjs apply --client codex --client claude
export OCX_API_TOKEN="$(cat ~/.ocx-export/api-key)"   # для Codex
codex

# Модели на хабе поменялись — просто выполните apply ещё раз
node ocx.mjs apply --client claude

# Откат
node ocx.mjs restore --client codex --client claude

# На самом хосте хаба (контейнер опубликован на 127.0.0.1:10100)
OCX_HUB=http://127.0.0.1:10100 OCX_API_TOKEN_FILE=./secrets/ocx_api_token node bin/ocx.mjs models
```

## Решение проблем

| Сообщение | Что значит и что делать |
|---|---|
| `No hub API key found` | Выполните `configure` со скрытым вводом ключа или задайте `OCX_API_TOKEN_FILE`. |
| `Use HTTPS for a remote hub` | Нужен HTTPS-адрес или SSH-туннель на `http://127.0.0.1:10100`. |
| `Hub /v1/catalog: HTTP 401/403` | Неверный ключ или хаб за фронтендом с привязкой к loopback (см. основной README). |
| `Hub catalog is empty` | На хабе ещё не настроены провайдеры. |
| `Another mutation or interrupted run holds …/mutation.lock` | Убедитесь, что другой запуск ocx не идёт, и удалите каталог. |
| `File changed since apply; refusing to overwrite` | `restore` защищает ручные изменения. Для повторного `apply` просмотрите и подтвердите их в TTY; без TTY запуск прервётся. |
| `Claude Desktop currently selects a foreign profile` | Сначала выберите в Claude Desktop профиль `opencodex` (или никакой). |

Подписи интерактивного меню пока на русском; неинтерактивные команды выводят текст на английском.
