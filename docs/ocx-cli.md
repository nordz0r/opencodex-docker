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
export OCX_HUB=https://ocx.example.com                 # origin хаба, без пути
mkdir -p ~/.ocx-export && chmod 700 ~/.ocx-export
printf '%s' '<ключ>' > ~/.ocx-export/api-key && chmod 600 ~/.ocx-export/api-key
```

Адрес хаба берётся по порядку: `--hub <url>`, `OCX_HUB`, поле `"hub"` в
`$OCX_STATE_HOME/connection.json`, иначе `http://127.0.0.1:10100` (локальная публикация контейнера
по умолчанию). Удалённый хаб — только по **HTTPS**; обычный HTTP разрешён лишь для `localhost`,
`127.0.0.1` и `[::1]`. Если HTTPS пока нет, поднимите SSH-туннель и используйте loopback-адрес:

```bash
ssh -N -L 10100:127.0.0.1:10100 user@hub-host &
export OCX_HUB=http://127.0.0.1:10100
```

Ключ берётся по порядку: `OCX_API_TOKEN`, файл `OCX_API_TOKEN_FILE` (по умолчанию
`~/.ocx-export/api-key`), затем `$OPENCODEX_HOME/service-api-token` (по умолчанию
`~/.opencodex/service-api-token`). Файл надёжнее переменной окружения.

## Команды

| Команда | Что делает |
|---|---|
| `node ocx.mjs` | В терминале — интерактивный выбор (пробел отмечает, `a` — все, стрелки/мышь, enter). Без TTY — то же, что `status`. |
| `node ocx.mjs status [--client <id> ...]` | Только чтение: адрес хаба, какие клиенты установлены, какими управляет ocx, какие файлы есть. |
| `node ocx.mjs models` | Каталог хаба (`GET /v1/catalog`): id, контекстное окно, тип (native / routed / combo), название. |
| `node ocx.mjs apply --client <id> [...]` | Скачивает каталог и прописывает настройки хаба в выбранные клиенты. |
| `node ocx.mjs restore --client <id> [...]` | Возвращает файлы, сохранённые перед первым `apply` для этих клиентов. |
| `node ocx.mjs help` / `--help` / `-h` | Справка. |

ID клиентов: `codex`, `claude` (синоним `claude-code`), `claude-desktop`, `grok`, `omp`.
Общая опция: `--hub <url>`.

## Что меняет `apply`

| Клиент | Файлы (по умолчанию) | Примечания |
|---|---|---|
| `codex` | `~/.codex/config.toml`, `~/.codex/opencodex-catalog.json` | Ставит `model_provider = "opencodex"`, секцию `[model_providers.opencodex]` с `base_url = <хаб>/v1`, `wire_api = "responses"`, `env_key = "OPENCODEX_API_AUTH_TOKEN"` и скачанный каталог моделей. Ключ **не** записывается: перед запуском `codex` экспортируйте `OPENCODEX_API_AUTH_TOKEN`. |
| `claude` | `~/.claude/settings.json`, `~/.claude/cache/gateway-models.json` | `env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_AUTH_TOKEN`, обнаружение моделей через шлюз, слоты opus/sonnet/fable/haiku и список `/model` по назначениям хаба; включает `disableClaudeAiConnectors`. Убирает старый хук `claude-env.sh` из `~/.bashrc`. |
| `claude-desktop` | `Claude-3p/configLibrary/<id>.json` и `_meta.json` (`%LOCALAPPDATA%` в Windows, `~/.config` в остальных) | Создаёт или обновляет профиль шлюза `opencodex` и выбирает его. Не переключает, если сейчас выбран чужой профиль. |
| `grok` | `~/.grok/config.toml` | Заменяет блок между метками `# >>> opencodex managed block` на провайдера хаба и по записи `ocx-<модель>` на каждую модель каталога (модели Claude исключаются). |
| `omp` | `~/.omp/agent/models.yml`, `~/.omp/agent/config.yml` | Добавляет провайдера `ocx` (`openai-responses`) с моделями каталога и включает его. |

Правила безопасности:

- В конфигах Claude, Claude Desktop, Grok и Oh My Pi ключ хранится открытым текстом. Все файлы
  пишутся атомарно с правами `0600`.
- Перед записью оригинал каждого файла сохраняется в журнал `~/.ocx-export/integrations.json`.
- `restore` не перезапишет файл, который вы правили после `apply` («File changed since apply»).
- На время работы занимается каталог-блокировка `~/.ocx-export/mutation.lock`; второй запуск
  завершится ошибкой, а не будет мешать первому.
- Пустой или некорректный каталог хаба прерывает запуск до любых записей.
- В логе `~/.ocx-export/ocx-export.log` токены и ключи маскируются.

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `OCX_HUB` | — | origin хаба |
| `OCX_API_TOKEN` | — | ключ доступа (лучше файл) |
| `OCX_API_TOKEN_FILE` | `~/.ocx-export/api-key` | файл с ключом |
| `OCX_STATE_HOME` | `~/.ocx-export` | журнал, блокировка, необязательный `connection.json` |
| `OCX_LOG_FILE` | `~/.ocx-export/ocx-export.log` | файл лога |
| `OCX_NONINTERACTIVE=1` | — | никогда не открывать интерактивный выбор (CI, скрипты) |
| `OCX_ASSUME_TTY=1` | — | всегда открывать интерактивный выбор |
| `OCX_COMBO_PREFIXES` | `combo/` | префиксы id через запятую, которые `models` показывает как `combo` |
| `NO_COLOR` | — | отключить цвета |
| `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `OMP_HOME`, `OPENCODEX_HOME` | `~/.codex`, `~/.claude`, `~/.grok`, `~/.omp`, `~/.opencodex` | каталоги клиентов |
| `OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR`, `CLAUDE_USER_DATA_DIR` | см. таблицу выше | где лежат профили Claude Desktop |

## Примеры

```bash
# Что будет затронуто?
node ocx.mjs status

# Codex и Claude Code на удалённый хаб
OCX_HUB=https://ocx.example.com node ocx.mjs apply --client codex --client claude
export OPENCODEX_API_AUTH_TOKEN="$(cat ~/.ocx-export/api-key)"   # для Codex
codex

# Модели на хабе поменялись — просто выполните apply ещё раз
node ocx.mjs apply --client claude

# Откат
node ocx.mjs restore --client codex --client claude

# На самом хосте хаба (контейнер опубликован на 127.0.0.1:10100)
OCX_API_TOKEN_FILE=./secrets/ocx_api_token node bin/ocx.mjs models
```

## Решение проблем

| Сообщение | Что значит и что делать |
|---|---|
| `Missing hub admission key` | Ключ не найден: задайте `OCX_API_TOKEN_FILE` или создайте `~/.ocx-export/api-key`. |
| `Use HTTPS for a remote hub` | Нужен HTTPS-адрес или SSH-туннель на `http://127.0.0.1:10100`. |
| `Hub /v1/catalog: HTTP 401/403` | Неверный ключ или хаб за фронтендом с привязкой к loopback (см. основной README). |
| `Hub catalog is empty` | На хабе ещё не настроены провайдеры. |
| `Another mutation or interrupted run holds …/mutation.lock` | Убедитесь, что другой запуск ocx не идёт, и удалите каталог. |
| `File changed since apply; refusing to overwrite` | Вы правили управляемый файл после `apply`. Верните правку или осознанно удалите запись из журнала. |
| `Claude Desktop currently selects a foreign profile` | Сначала выберите в Claude Desktop профиль `opencodex` (или никакой). |

Подписи интерактивного меню пока на русском; неинтерактивные команды выводят текст на английском.
