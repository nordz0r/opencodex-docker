#!/usr/bin/env node
// ocx.mjs — OpenCodex Hub client configurator (Node.js >= 18; Linux, macOS, Windows, WSL).
// Points Codex CLI, Claude Code, Claude Desktop, Grok Build and Oh My Pi at a
// remote OpenCodex hub using an existing data-plane key. Downloads the hub model
// catalog; no local OpenCodex binary, proxy or client installer is needed.
// Client changes are journaled; restore refuses to overwrite files edited after apply.
// Part of https://github.com/nordz0r/opencodex-docker (MIT). Run with --help for usage.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const NATIVE_CLIENTS = ['codex', 'claude', 'claude-desktop', 'grok', 'omp'];
const CLIENT_META = {
  codex: { title: 'Codex', blurb: 'CLI / TUI / App' },
  claude: { title: 'Claude Code', blurb: 'gateway + family slots' },
  'claude-desktop': { title: 'Claude Desktop', blurb: 'hub profile' },
  grok: { title: 'Grok Build', blurb: 'hub provider + ocx-*' },
  omp: { title: 'Oh My Pi', blurb: 'hub provider ocx via /v1/responses' },
};
const OMP_PROVIDER = 'ocx';
const OMP_API = 'openai-responses';
const OMP_MAX_TOKENS = 32768;
// OMP models.yml schema only accepts these; catalog may contain 'ultra' etc.
// Fallback hub when neither --hub, OCX_HUB nor <state>/connection.json is set:
// the default loopback publication of the opencodex-docker container.
const DEFAULT_HUB = 'http://127.0.0.1:10100';
// Catalog ids starting with one of these prefixes are shown as "combo" by `models`.
const COMBO_PREFIXES = String(process.env.OCX_COMBO_PREFIXES || 'combo/')
  .split(',').map((s) => s.trim()).filter(Boolean);
const isComboId = (id) => COMBO_PREFIXES.some((p) => String(id).startsWith(p));
const IS_WIN = process.platform === 'win32';
const DESKTOP_PROFILE_NAME = 'opencodex';
const CODEX_CATALOG_FILE = () => path.join(codexHome(), 'opencodex-catalog.json');
const DESKTOP_PROFILE_DIR = () => process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR
  || path.join(process.env.CLAUDE_USER_DATA_DIR || (IS_WIN
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Claude-3p')
    : path.join(process.env.XDG_CONFIG_HOME || homeDir('.config'), 'Claude-3p')), 'configLibrary');
const GROK_BEGIN = '# >>> opencodex managed block — managed by ocx.mjs >>>';
const GROK_END = '# <<< opencodex managed block <<<';
const OMP_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const GROK_REASONING_EFFORTS = ['none', ...OMP_REASONING_EFFORTS];
const GROK_EFFORT_OPTIONS = {
  none: { label: 'None', description: 'No reasoning' },
  minimal: { label: 'Minimal', description: 'Minimal reasoning' },
  low: { label: 'Low', description: 'Quick, fast implementations' },
  medium: { label: 'Medium', description: 'Balanced effort' },
  high: { label: 'High', description: 'Highest quality with extensive reasoning' },
  xhigh: { label: 'XHigh', description: 'Extra high reasoning effort' },
  max: { label: 'Max', description: 'Maximum reasoning effort' },
};

class Fatal extends Error {}

function die(message) {
  flog(`error: ${message}`);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  throw new Fatal(message);
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

const homeDir = (...seg) => path.join(os.homedir(), ...seg);
const grokHome = () => process.env.GROK_HOME || homeDir('.grok');
const windowsUserHome = () => {
  const winProfile = process.env.USERPROFILE;
  if (winProfile && /^[A-Za-z]:[\\/]/.test(winProfile)) return winProfile.replace(/\\/g, '/');
  if (process.env.WSL_USERPROFILE) return process.env.WSL_USERPROFILE;
  // Tests set a non-Windows USERPROFILE; do not guess a host profile.
  if (winProfile) return null;
  const wslHome = os.homedir();
  const m = String(wslHome).match(/^\/mnt\/([a-z])\/Users\/([^/]+)/i);
  if (m) return `/mnt/${m[1]}/Users/${m[2]}`;
  const usersRoot = '/mnt/c/Users';
  try {
    const skip = new Set(['Public', 'Default', 'All Users', 'Default User']);
    const scored = fs.readdirSync(usersRoot).flatMap((name) => {
      if (skip.has(name) || name.startsWith('.')) return [];
      const home = path.join(usersRoot, name);
      const score = ['.opencodex', '.grok', '.codex', '.claude']
        .filter((dir) => isDir(path.join(home, dir))).length;
      return score ? [{ home, score }] : [];
    }).sort((a, b) => b.score - a.score);
    if (!scored.length) return null;
    if (scored.length === 1 || scored[0].score > scored[1].score) return scored[0].home;
  } catch { /* not WSL / no C: */ }
  return null;
};
const windowsGrokHome = () => {
  const winHome = windowsUserHome();
  return winHome ? path.join(winHome, '.grok') : null;
};
const grokHomes = () => {
  const homes = [];
  const seen = new Set();
  const add = (p) => {
    if (!p) return;
    const key = path.resolve(p);
    if (seen.has(key) || !isDir(p)) return;
    seen.add(key);
    homes.push(p);
  };
  add(grokHome());
  add(windowsGrokHome());
  return homes;
};
const codexHome = () => process.env.CODEX_HOME || homeDir('.codex');
const opencodexHome = () => process.env.OPENCODEX_HOME || homeDir('.opencodex');
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || homeDir('.claude');
const windowsClaudeHome = () => {
  const winHome = windowsUserHome();
  return winHome ? path.join(winHome, '.claude') : null;
};
const claudeHomes = () => {
  const homes = [];
  const seen = new Set();
  const add = (p) => {
    if (!p) return;
    const key = path.resolve(p);
    if (seen.has(key) || !isDir(p)) return;
    seen.add(key);
    homes.push(p);
  };
  add(claudeHome());
  if (!process.env.CLAUDE_CONFIG_DIR) add(windowsClaudeHome());
  return homes.length ? homes : [claudeHome()];
};
const ompHome = () => process.env.OMP_HOME || homeDir('.omp');
const windowsOmpHome = () => {
  const winHome = windowsUserHome();
  return winHome ? path.join(winHome, '.omp') : null;
};
const collectHomes = (...candidates) => {
  const homes = [];
  const seen = new Set();
  for (const p of candidates) {
    if (!p) continue;
    const key = path.resolve(p);
    if (seen.has(key) || !isDir(p)) continue;
    seen.add(key);
    homes.push(p);
  }
  return homes;
};
const ompHomes = () => collectHomes(ompHome(), windowsOmpHome());
const ompHomesForWrite = () => {
  const homes = ompHomes();
  if (homes.length) return homes;
  if (findOnPath('omp')) return [ompHome()];
  return [];
};
const ompAgentDir = (home) => path.join(home, 'agent');

// ---------------- file log ----------------

function logFilePath() {
  return process.env.OCX_LOG_FILE || path.join(os.homedir(), '.ocx-export', 'ocx-export.log');
}

function redact(text) {
  return String(text)
    .replace(/ocx_pair_[A-Za-z0-9_-]{43}/g, 'ocx_pair_[redacted]')
    .replace(/("(?:token|apiKey|api_key|secret|password|authorization|pairingCode|serviceKey)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"');
}

function flog(message) {
  try {
    const file = logFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const st = fs.statSync(file);
      if (st.size > 1024 * 1024) fs.writeFileSync(file, fs.readFileSync(file).slice(-256 * 1024));
    } catch { /* first write */ }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${redact(message)}\n`);
  } catch { /* logging must never break the run */ }
}

// ---------------- console output ----------------

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (open, close) => (useColor ? (s) => open + s + close : (s) => String(s));
const ui = {
  dim: wrap('\x1b[2m', '\x1b[22m'),
  bold: wrap('\x1b[1m', '\x1b[22m'),
  cyan: wrap('\x1b[36m', '\x1b[39m'),
  green: wrap('\x1b[32m', '\x1b[39m'),
  yellow: wrap('\x1b[33m', '\x1b[39m'),
  magenta: wrap('\x1b[35m', '\x1b[39m'),
  inverse: wrap('\x1b[7m', '\x1b[27m'),
  reset: wrap('\x1b[0m', ''),
};
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const visLen = (s) => [...stripAnsi(s)].length;
const padVis = (s, n) => {
  const extra = n - visLen(s);
  return extra > 0 ? `${s}${' '.repeat(extra)}` : s;
};
const termWidth = () => {
  const cols = Number(process.stdout.columns) || 80;
  return Math.max(58, Math.min(82, cols));
};

const write = (line) => process.stdout.write(`${line}\n`);
const info = (line) => { write(line); flog(line); };
const logOk = (line) => write(`${useColor ? '\x1b[32m✓\x1b[39m ' : '✓ '}${line}`);
const warn = (line) => { process.stderr.write(`${line}\n`); flog(`warn: ${line}`); };

// ---------------- hub connection and reversible file updates ----------------

const stateHome = () => process.env.OCX_STATE_HOME || homeDir('.ocx-export');
const connectionPath = () => path.join(stateHome(), 'connection.json');
const keyFilePath = () => process.env.OCX_API_TOKEN_FILE || path.join(stateHome(), 'api-key');
const readApiKey = () => {
  const fromEnv = String(process.env.OCX_API_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  for (const file of [keyFilePath(), path.join(opencodexHome(), 'service-api-token')]) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch { /* try the next explicit token source */ }
  }
  return '';
};
const catalogPathForCodex = () => CODEX_CATALOG_FILE();
const journalPath = () => path.join(stateHome(), 'integrations.json');
let activeWrites = null;
let activeClient = null;

function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    die(`Cannot read valid JSON: ${file}`);
  }
}

function fileSnapshot(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) die(`Refusing non-regular file: ${file}`);
    return { data: fs.readFileSync(file).toString('base64'), mode: stat.mode & 0o777 };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function sameSnapshot(a, b) {
  return a === null || b === null ? a === b : a.data === b.data && a.mode === b.mode;
}

function putSnapshot(file, snapshot) {
  if (snapshot === null) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, Buffer.from(snapshot.data, 'base64'), { flag: 'wx', mode: snapshot.mode });
    fs.chmodSync(tmp, snapshot.mode);
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

function writePrivateJson(file, value) {
  putSnapshot(file, { data: Buffer.from(JSON.stringify(value, null, 2) + '\n').toString('base64'), mode: 0o600 });
}

function stageFile(file, content) {
  const target = path.resolve(file);
  const after = content === null ? null : { data: Buffer.from(content).toString('base64'), mode: 0o600 };
  if (!activeWrites) {
    fileSnapshot(target);
    putSnapshot(target, after);
    return;
  }
  const existing = activeWrites.get(target);
  if (existing && existing.client !== activeClient) die(`Clients share a managed file: ${target}`);
  activeWrites.set(target, { client: activeClient, after });
}

function loadJournal() {
  const journal = readJsonFile(journalPath(), { version: 1, files: {} });
  if (journal?.version !== 1 || !journal.files || typeof journal.files !== 'object' || Array.isArray(journal.files)) {
    die('Invalid integration journal; refusing changes');
  }
  return journal;
}

function assertJournalCurrent(file, entry) {
  const current = fileSnapshot(file);
  if (!sameSnapshot(current, entry.after) && !(Object.hasOwn(entry, 'previous') && sameSnapshot(current, entry.previous))) {
    die(`File changed since apply; refusing to overwrite: ${file}`);
  }
  return current;
}

async function withStateLock(action) {
  fs.mkdirSync(stateHome(), { recursive: true, mode: 0o700 });
  const lock = path.join(stateHome(), 'mutation.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (err) {
    if (err.code === 'EEXIST') die(`Another mutation or interrupted run holds ${lock}; verify no configurator is running before removing it`);
    throw err;
  }
  try { return await action(); }
  finally { fs.rmdirSync(lock); }
}

function commitWrites(journal) {
  const original = structuredClone(journal);
  const current = new Map();
  for (const [file, change] of activeWrites) {
    const entry = journal.files[file];
    if (entry && entry.client !== change.client) die(`File belongs to another client: ${file}`);
    const before = entry ? assertJournalCurrent(file, entry) : fileSnapshot(file);
    current.set(file, before);
    journal.files[file] = { client: change.client, before: entry ? entry.before : before, after: change.after, previous: before };
  }
  // Persist both acceptable states before touching client files, so an interrupted
  // commit can still be restored without guessing which writes completed.
  writePrivateJson(journalPath(), journal);
  const changed = [];
  try {
    for (const [file, change] of activeWrites) {
      if (!sameSnapshot(fileSnapshot(file), current.get(file))) die(`File changed during apply: ${file}`);
      putSnapshot(file, change.after);
      changed.push(file);
    }
    for (const file of activeWrites.keys()) delete journal.files[file].previous;
    writePrivateJson(journalPath(), journal);
  } catch (err) {
    for (const file of changed.reverse()) putSnapshot(file, current.get(file));
    writePrivateJson(journalPath(), original);
    throw err;
  }
}

function restoreClients(clients) {
  const journal = loadJournal();
  const targets = Object.entries(journal.files).filter(([, entry]) => clients.includes(entry.client));
  const snapshots = targets.map(([file, entry]) => [file, entry, assertJournalCurrent(file, entry)]);
  for (const [file, entry, current] of snapshots) {
    entry.previous = current;
    entry.after = entry.before;
  }
  writePrivateJson(journalPath(), journal);
  try {
    for (const [file, entry] of snapshots) putSnapshot(file, entry.before);
    for (const [file] of snapshots) delete journal.files[file];
    writePrivateJson(journalPath(), journal);
  } catch (err) {
    for (const [file, , current] of snapshots) putSnapshot(file, current);
    writePrivateJson(journalPath(), loadJournal());
    throw err;
  }
  for (const client of clients) {
    const count = snapshots.filter(([, entry]) => entry.client === client).length;
    info(count ? `restored ${client}: ${count} files` : `${client}: no saved baseline; no files changed`);
  }
}

function resolveHub(opts = {}) {
  return validateHub(opts.hub || process.env.OCX_HUB || readJsonFile(connectionPath())?.hub || DEFAULT_HUB);
}

function validateHub(hub) {
  let url;
  try { url = new URL(hub); } catch { die('Invalid hub URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    die('Hub URL must be an HTTP(S) origin without credentials, path, query or fragment');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    die('Use HTTPS for a remote hub; HTTP is allowed only on loopback');
  }
  return url.origin;
}

function connectionFromConfig() {
  const connection = readJsonFile(connectionPath());
  if (!connection || typeof connection.hub !== 'string') return null;
  return { state: 'connected', serverUrl: validateHub(connection.hub), selectedClients: connection.selectedClients || NATIVE_CLIENTS, source: 'connection.json' };
}

function readServiceToken() { return readApiKey(); }
function readAdmissionToken() { return readApiKey(); }

async function readHubCatalog(hub, token = readApiKey()) {
  const data = await hubJson(hub, '/v1/catalog', token);
  const models = catalogModelsFromData(data);
  if (!models.length) die('Hub catalog is empty; refusing to write client configuration');
  return { data, models };
}


async function writeClaudeDesktopHubProfile(hub, token, snapshot) {
  if (!Array.isArray(snapshot?.models) || snapshot.models.length === 0 || snapshot.models.length > 256) {
    die('Hub returned an empty or oversized Claude Desktop model snapshot');
  }
  const names = new Set();
  for (const row of snapshot.models) {
    if (!row || !/^claude-[a-z0-9-]+$/.test(row.name || '') || names.has(row.name)
      || typeof row.labelOverride !== 'string' || row.labelOverride.length > 80 || /[\[\]]/.test(row.labelOverride)
      || !['opus', 'fable', 'sonnet', 'haiku'].includes(row.anthropicFamilyTier)
      || (row.supports1m !== undefined && row.supports1m !== true)
      || (row.prefer1m !== undefined && row.prefer1m !== true)) die('Hub returned an invalid Claude Desktop model snapshot');
    names.add(row.name);
  }
  const dir = DESKTOP_PROFILE_DIR();
  const metaPath = path.join(dir, '_meta.json');
  const meta = readJsonFile(metaPath, { entries: [] });
  if (!Array.isArray(meta.entries) || meta.entries.length >= 256 && !meta.entries.some((e) => e?.name === DESKTOP_PROFILE_NAME)) {
    die('Claude Desktop metadata is invalid or full');
  }
  const applied = meta.entries.find((e) => e?.id === meta.appliedId);
  if (applied && applied.name !== DESKTOP_PROFILE_NAME && applied.name !== 'opencodex-standard') {
    die('Claude Desktop currently selects a foreign profile; refusing to change its selection');
  }
  const current = meta.entries.find((e) => e?.id === meta.appliedId && e?.name === DESKTOP_PROFILE_NAME)
    || meta.entries.find((e) => e?.name === DESKTOP_PROFILE_NAME);
  if (current && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(current.id || '')) die('Unsafe Claude Desktop profile id');
  const id = current?.id || crypto.randomUUID();
  const profilePath = path.join(dir, `${id}.json`);
  const oldProfile = readJsonFile(profilePath, {});
  if (!oldProfile || typeof oldProfile !== 'object' || Array.isArray(oldProfile)) die('Invalid Claude Desktop profile JSON');
  const managed = new Set(['inferenceProvider', 'inferenceCredentialKind', 'inferenceGatewayBaseUrl', 'inferenceGatewayApiKey', 'modelDiscoveryEnabled', 'inferenceModels']);
  const profile = Object.fromEntries(Object.entries(oldProfile).filter(([key]) => !managed.has(key)));
  Object.assign(profile, { inferenceProvider: 'gateway', inferenceCredentialKind: 'static', inferenceGatewayBaseUrl: hub,
    inferenceGatewayApiKey: token, modelDiscoveryEnabled: false, inferenceModels: snapshot.models });
  stageFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  const entries = current
    ? meta.entries.map((e) => e === current ? { ...e, id, name: DESKTOP_PROFILE_NAME } : e)
    : [...meta.entries, { id, name: DESKTOP_PROFILE_NAME }];
  stageFile(metaPath, `${JSON.stringify({ ...meta, appliedId: id, entries }, null, 2)}\n`);
}

function connectionState() { return { code: 0, connection: connectionFromConfig() }; }



async function catalogGrokModelsFromHub(hub, token) {
  return (await readHubCatalog(hub, token)).models;
}

async function hubJson(hub, endpoint, token) {
  if (!token) die('Missing hub admission key: set OCX_API_TOKEN or create a connection key file');
  const res = await fetch(`${validateHub(hub)}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}`, 'x-opencodex-api-key': token, 'anthropic-version': '2023-06-01', Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) die(`Hub ${endpoint}: HTTP ${res.status}`);
  try { return await res.json(); } catch { die(`Hub ${endpoint}: invalid JSON`); }
}

// ---------------- claude settings.json env block ----------------

const CLAUDE_ENV_MARKER = '_ocx_export_managed';
const CLAUDE_LEGACY_ENV_MARKER = '__ managed by ocx-export \u2014 do not edit manually __';
const CLAUDE_BASHRC_HOOK = '# opencodex claude-env hook';
const CLAUDE_TIER_FAMILIES = ['opus', 'sonnet', 'fable', 'haiku'];
const CLAUDE_TIER_ENV = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};
const CLAUDE_MANAGED_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
];

function readClaudeSettings(home = claudeHome()) {
  const file = path.join(home, 'settings.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeClaudeSettings(obj, home = claudeHome()) {
  stageFile(path.join(home, 'settings.json'), `${JSON.stringify(obj, null, 2)}\n`);
}


function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function claudeNormLabel(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s*[·•]\s*(fast|1m)\b/gi, '')
    .replace(/[^a-z0-9]+/g, '');
}

function isVariantCliId(id) {
  return /--fast$/.test(id) || /\[1m\]$/i.test(id);
}

function pickCliIdForDesktop(cliModels, desktopRow) {
  const name = typeof desktopRow.name === 'string' ? desktopRow.name : '';
  if (name) {
    const exact = cliModels.find((m) => m.id === name && !isVariantCliId(m.id));
    if (exact) return exact.id;
  }
  const want = claudeNormLabel(desktopRow.labelOverride);
  if (!want) return null;
  const hits = cliModels.filter((m) => !isVariantCliId(m.id) && claudeNormLabel(m.display_name) === want);
  if (!hits.length) return null;
  hits.sort((a, b) => a.id.length - b.id.length);
  return hits[0].id;
}

function claudeTierSlotsFromHub(cliModels, desktopSnapshot) {
  const slots = {};
  const missing = [];
  const rows = Array.isArray(desktopSnapshot?.models) ? desktopSnapshot.models : [];
  for (const family of CLAUDE_TIER_FAMILIES) {
    const row = rows.find((m) => m && m.isFamilyDefault === true && m.anthropicFamilyTier === family);
    if (!row) continue;
    const alias = typeof row.name === 'string' && /^claude-[a-z0-9]/i.test(row.name) ? row.name : null;
    const id = alias || pickCliIdForDesktop(cliModels, row);
    if (id) slots[family] = id;
    else missing.push(`${family}=${row.labelOverride || row.name || '?'}`);
  }
  return { slots, missing, remappedPinned: [] };
}

async function claudeFetchHubCatalog(hub, token = readApiKey()) {
  if (!token) return { error: 'hub key missing' };
  const origin = new URL(validateHub(hub)).origin;
  const headers = { 'anthropic-version': '2023-06-01', 'x-opencodex-api-key': token, Accept: 'application/json' };
  try {
    const [cliRes, deskRes] = await Promise.all([
      fetch(`${origin}/v1/models?limit=1000&ids=cli`, { headers, redirect: 'error', signal: AbortSignal.timeout(5_000) }),
      fetch(`${origin}/v1/models?ids=desktop&format=desktop-config`, { headers, redirect: 'error', signal: AbortSignal.timeout(5_000) }),
    ]);
    if (!cliRes.ok) return { error: `cli catalog HTTP ${cliRes.status}` };
    const cliBody = await cliRes.json();
    if (!Array.isArray(cliBody.data)) return { error: 'cli catalog invalid' };
    const cliModels = cliBody.data.filter((m) => m && typeof m.id === 'string' && m.id)
      .map((m) => ({ id: m.id, display_name: typeof m.display_name === 'string' ? m.display_name : '' }));
    let desktop = { models: [] };
    if (deskRes.ok) {
      const body = await deskRes.json();
      if (body?.version === 1 && Array.isArray(body.models)) desktop = body;
    }
    return { origin, token, cliModels, desktop };
  } catch { return { error: 'catalog request failed' }; }
}

// The hub assignments expose models as real Claude snapshot aliases
// (claude-opus-4-8-YYYYMMDD, claude-opus-5, …). Only those ids are known to
// Claude Code's own model catalog; raw claude-ocx-* gateway ids trigger the
// "isn't described by this version's model catalog" warning and a forced 200k
// context assumption. Match CLI rows to desktop rows by normalized label.
function buildClaudeAliasIndex(desktopSnapshot) {
  const rows = Array.isArray(desktopSnapshot?.models) ? desktopSnapshot.models : [];
  const aliasByNorm = new Map();
  for (const row of rows) {
    if (!row || typeof row.name !== 'string' || !/^claude-[a-z0-9]/i.test(row.name)) continue;
    const norm = claudeNormLabel(row.labelOverride);
    if (norm && !aliasByNorm.has(norm)) aliasByNorm.set(norm, row.name);
  }
  return aliasByNorm;
}

// Map a hub CLI catalog row (claude-ocx-* id + display name) to its alias,
// re-attaching the [1m] / --fast variant suffix. The hub serves those
// suffixed alias ids (verified against /v1/messages).
function claudeAliasForCliModel(cliModel, aliasByNorm) {
  if (!cliModel || typeof cliModel.id !== 'string' || !cliModel.id) return null;
  const base = cliModel.id.replace(/\[1m\]$/i, '').replace(/--fast$/i, '');
  const alias = aliasByNorm.get(claudeNormLabel(cliModel.display_name));
  if (!alias) return null;
  return `${alias}${cliModel.id.slice(base.length)}`;
}

// Fallback for pinned ids that are no longer in the CLI catalog: rebuild the
// display-name shape ("model (provider)") from the claude-ocx-<provider>--<model> id.
function claudeAliasForPinnedId(pinned, cliModels, aliasByNorm) {
  const viaCatalog = claudeAliasForCliModel((cliModels || []).find((m) => m && m.id === pinned), aliasByNorm);
  if (viaCatalog) return viaCatalog;
  const suffixed = /\[1m\]$|--fast$/i.test(pinned);
  const base = suffixed ? pinned.replace(/\[1m\]$/i, '').replace(/--fast$/i, '') : pinned;
  const parsed = /^claude-ocx\d*-(.+?)--(.+)$/.exec(base);
  if (!parsed) return null;
  const alias = aliasByNorm.get(claudeNormLabel(`${parsed[2]} (${parsed[1]})`));
  return alias ? `${alias}${pinned.slice(base.length)}` : null;
}

function buildClaudePickerOptions(desktopSnapshot) {
  const rows = Array.isArray(desktopSnapshot?.models) ? desktopSnapshot.models : [];
  const options = [];
  for (const row of rows) {
    if (!row || typeof row.name !== 'string' || !/^claude-[a-z0-9]/i.test(row.name)) continue;
    const label = row.labelOverride || row.name;
    options.push({ model: row.name, label });
    if (row.supports1m) options.push({ model: `${row.name}[1m]`, label: `${label} · 1M` });
  }
  return options;
}

function writeClaudeGatewayCache(origin, cliModels, desktopSnapshot) {
  const aliasByNorm = buildClaudeAliasIndex(desktopSnapshot);
  const models = cliModels.map((m) => {
    const alias = claudeAliasForCliModel(m, aliasByNorm);
    const id = alias || m.id;
    return m.display_name ? { id, display_name: m.display_name } : { id };
  });
  const remapped = models.filter((m, i) => m.id !== cliModels[i].id).length;
  const written = [];
  for (const home of claudeHomes()) {
    const cacheDir = path.join(home, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, 'gateway-models.json');
    stageFile(cachePath, JSON.stringify({ baseUrl: origin, fetchedAt: Date.now(), models }));
    written.push(cachePath);
  }
  return { count: models.length, remapped, cachePath: written[0], cachePaths: written };
}


function writeClaudeManagedEnv(origin, token, slots, desktopSnapshot) {
  const extra = {};
  for (const family of CLAUDE_TIER_FAMILIES) {
    if (slots[family]) extra[CLAUDE_TIER_ENV[family]] = slots[family];
  }
  if (slots.haiku) extra.ANTHROPIC_SMALL_FAST_MODEL = slots.haiku;

  // Curated /model lineup from the hub assignments: alias ids Claude Code's
  // catalog knows, so pinned rows never fall into the unknown-model 200k path.
  const pickerOptions = buildClaudePickerOptions(desktopSnapshot);

  const envShPath = path.join(opencodexHome(), 'claude-env.sh');
  stageFile(envShPath, null);
  const bashrcPath = homeDir('.bashrc');
  try {
    const bashrc = fs.readFileSync(bashrcPath, 'utf8');
    const cleaned = bashrc.replace(/\n?# opencodex claude-env hook\n\[.*claude-env\.sh.*\n?/g, '\n');
    if (cleaned !== bashrc) stageFile(bashrcPath, cleaned);
  } catch { /* absent bashrc */ }

  for (const home of claudeHomes()) {
    const settings = readClaudeSettings(home);
    const env = settings.env || {};
    env.ANTHROPIC_BASE_URL = origin;
    env.ANTHROPIC_AUTH_TOKEN = token;
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1';
    for (const key of CLAUDE_MANAGED_ENV_KEYS) {
      if (key === 'ANTHROPIC_BASE_URL' || key === 'ANTHROPIC_AUTH_TOKEN' || key === 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY') continue;
      if (extra[key]) env[key] = extra[key];
      else delete env[key];
    }
    delete env[CLAUDE_LEGACY_ENV_MARKER];
    settings.env = env;
    if (pickerOptions.length) {
      settings.modelPicker = { options: pickerOptions, replaceBuiltInOptions: true };
    }
    // Mark claude.ai connectors as intentionally disabled: the gateway env
    // below takes precedence over any claude.ai login, and without this the
    settings.disableClaudeAiConnectors = true;
    settings[CLAUDE_ENV_MARKER] = true;
    writeClaudeSettings(settings, home);
  }
}

async function claudeSettingsEnvApply(hub, token = readApiKey()) {
  const catalog = await claudeFetchHubCatalog(hub, token);
  if (catalog.error) die(`Claude hub catalog: ${catalog.error}`);
  const { slots, missing, remappedPinned } = claudeTierSlotsFromHub(catalog.cliModels, catalog.desktop);
  writeClaudeManagedEnv(catalog.origin, catalog.token, slots, catalog.desktop);
  const cache = writeClaudeGatewayCache(catalog.origin, catalog.cliModels, catalog.desktop);
  return { origin: catalog.origin, slots, missing, remappedPinned, cache, pickerCount: buildClaudePickerOptions(catalog.desktop).length };
}

// ---------------- grok hub config (~/.grok/config.toml) ----------------

const tomlString = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const grokAlias = (id) => `ocx-${String(id).replace(/[^A-Za-z0-9_-]/g, '-')}`;

function grokHubPresent(configPath, hub) {
  if (!fs.existsSync(configPath)) return false;
  let text = '';
  try { text = fs.readFileSync(configPath, 'utf8'); } catch { return false; }
  if (text.includes(GROK_BEGIN)) return true;
  return text.includes('[model_providers.opencodex]') && text.includes(hub);
}

function stripGrokHubTables(text) {
  const kept = [];
  let skip = false;
  let marked = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    const t = line.trimStart();
    if (t.startsWith('# >>> opencodex managed block')) { marked = true; skip = true; continue; }
    if (marked && t.startsWith('# <<< opencodex managed block')) { marked = false; skip = false; continue; }
    if (marked) continue;
    if (/^\[model_providers\.opencodex/.test(line) || /^\[auth_provider\.opencodex/.test(line) || /^\[\[?model\.ocx-/.test(line)) {
      skip = true;
      continue;
    }
    if (skip && /^\[/.test(line)) skip = false;
    if (skip) continue;
    kept.push(line);
  }
  return `${kept.join('\n').replace(/\n+$/, '')}\n`;
}

function sanitizeGrokReasoningEfforts(levels) {
  const seen = new Set();
  const out = [];
  const descriptions = {};
  const allowed = new Set(GROK_REASONING_EFFORTS);
  for (const level of Array.isArray(levels) ? levels : []) {
    const effort = typeof level === 'string' ? level : level && level.effort;
    if (!effort || !allowed.has(effort) || seen.has(effort)) continue;
    seen.add(effort);
    out.push(effort);
    const desc = typeof level === 'object' && level && typeof level.description === 'string' ? level.description.trim() : '';
    if (desc) descriptions[effort] = desc;
  }
  return { efforts: out, descriptions };
}

function grokDefaultReasoningEffort(efforts, configuredDefault) {
  if (!efforts.length) return undefined;
  if (configuredDefault && efforts.includes(configuredDefault)) return configuredDefault;
  if (efforts.includes('medium')) return 'medium';
  if (efforts.includes('high')) return 'high';
  return efforts[0];
}

function catalogSummary(catalogPath = path.join(codexHome(), 'opencodex-catalog.json')) {
  const models = catalogGrokModels(catalogPath);
  const combos = models.filter((m) => isComboId(m.id));
  return {
    count: models.length,
    combos: combos.map((m) => m.id),
    ids: models.map((m) => m.id),
    names: Object.fromEntries(models.map((m) => [m.id, m.name])),
  };
}

function readRootTomlKey(file, key) {
  if (!fs.existsSync(file)) return null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(new RegExp(`^${key}\\s*=\\s*"(.*)"\\s*$`, 'm'));
    return m ? m[1] : null;
  } catch { return null; }
}

function ompInputModalities(row) {
  const mods = Array.isArray(row?.input_modalities) ? row.input_modalities.map(String) : [];
  const input = [];
  if (mods.includes('text') || !mods.length) input.push('text');
  if (mods.includes('image') || row?.supports_image_detail_original) input.push('image');
  return input;
}

// Catalog under-reports usable context for some models; hub accepts up to these limits.
const OMP_CONTEXT_OVERRIDES = {
  'xai/grok-4.7': 500000,
};

function ompContextWindow(row) {
  const id = String(row?.slug ?? row?.id ?? '');
  if (OMP_CONTEXT_OVERRIDES[id] != null) return OMP_CONTEXT_OVERRIDES[id];
  return row?.context_window != null ? Number(row.context_window) : null;
}

function catalogModelsFromData(data) {
  const rows = Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : [];
  const byAlias = new Map();
  for (const row of rows) {
    if (!row || (row.visibility ?? 'list') === 'hide') continue;
    const id = String(row.slug ?? row.id ?? '');
    if (!id) continue;
    const { efforts, descriptions } = sanitizeGrokReasoningEfforts(row.supported_reasoning_levels);
    const summary = typeof row.default_reasoning_summary === 'string' ? row.default_reasoning_summary : '';
    byAlias.set(grokAlias(id), {
      id,
      name: typeof row.display_name === 'string' && row.display_name ? row.display_name : `OCX ${id}`,
      context: (() => { const cw = ompContextWindow(row); return cw != null ? String(cw) : null; })(),
      contextWindow: ompContextWindow(row),
      input: ompInputModalities(row),
      reasoningEfforts: efforts,
      reasoningDescriptions: descriptions,
      defaultReasoningEffort: grokDefaultReasoningEffort(efforts, row.default_reasoning_level),
      reasoningSummary: ['none', 'auto', 'concise', 'detailed'].includes(summary) ? summary : null,
    });
  }
  return [...byAlias.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function catalogGrokModels(catalogPath) {
  try {
    return catalogModelsFromData(JSON.parse(fs.readFileSync(catalogPath, 'utf8')));
  } catch {
    return [];
  }
}

async function fetchHubCatalog(hub, token) {
  if (!token) throw new Error('missing token');
  const origin = new URL(hub).origin;
  const res = await fetch(`${origin}/v1/catalog`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-opencodex-api-key': token,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
  }
  return res.json();
}

async function loadOmpCatalog(hub, token) {
  let data;
  try {
    data = await fetchHubCatalog(hub, token);
  } catch (err) {
    die(`omp: hub catalog fetch failed: ${err instanceof Error ? err.message : err}`);
  }
  const models = catalogModelsFromData(data);
  if (!models.length) die('omp: hub catalog is empty');
  return { models, source: 'http' };
}

function grokPreferredDefault(models, currentDefault) {
  if (typeof currentDefault === 'string' && currentDefault.startsWith('ocx-')) {
    if (models.some((m) => grokAlias(m.id) === currentDefault)) return currentDefault;
  }
  const prefer = ['xai/grok-4.6', 'xai/grok-4.5', 'gpt-5.6-sol'];
  for (const id of prefer) {
    if (models.some((m) => m.id === id)) return grokAlias(id);
  }
  return models.length ? grokAlias(models[0].id) : null;
}

function readTomlTableKey(text, table, key) {
  let inTable = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    if (/^\[/.test(line)) {
      inTable = line.trim() === `[${table}]`;
      continue;
    }
    if (!inTable) continue;
    const m = line.match(new RegExp(`^${key}\\s*=\\s*(.*)$`));
    if (!m) continue;
    const v = m[1].trim();
    const q = v.match(/^"(.*)"$/);
    return q ? q[1] : v;
  }
  return null;
}

function upsertTomlTableKeys(text, table, updates, removeKeys = []) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
  const remove = new Set(removeKeys);
  const pending = { ...updates };
  const out = [];
  let inTable = false;
  let tableSeen = false;
  let inserted = false;
  const flush = () => {
    if (inserted) return;
    for (const [key, value] of Object.entries(pending)) {
      if (value !== undefined && value !== null) out.push(`${key} = ${value}`);
    }
    inserted = true;
  };
  for (const line of lines) {
    if (/^\[/.test(line)) {
      if (inTable) flush();
      inTable = line.trim() === `[${table}]`;
      if (inTable) tableSeen = true;
      out.push(line);
      continue;
    }
    if (inTable) {
      const m = line.match(/^([A-Za-z0-9_]+)\s*=/);
      if (m) {
        const key = m[1];
        if (remove.has(key)) continue;
        if (Object.hasOwn(pending, key)) {
          out.push(`${key} = ${pending[key]}`);
          delete pending[key];
          continue;
        }
      }
    }
    out.push(line);
  }
  if (inTable) flush();
  if (!tableSeen) {
    const extras = Object.entries(pending)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k} = ${v}`);
    if (extras.length) out.push('', `[${table}]`, ...extras);
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

function pinGrokToOcxModels(text, models) {
  const currentDefault = readTomlTableKey(text, 'models', 'default');
  const nextDefault = grokPreferredDefault(models, currentDefault);
  const updates = { allowed_models: '["ocx-*"]' };
  if (nextDefault) updates.default = tomlString(nextDefault);
  const defModel = models.find((m) => grokAlias(m.id) === nextDefault);
  const ladder = defModel?.reasoningEfforts || [];
  const currentEffort = readTomlTableKey(text, 'models', 'default_reasoning_effort');
  if (ladder.length) {
    if (currentEffort && ladder.includes(currentEffort)) {
      updates.default_reasoning_effort = tomlString(currentEffort);
    } else if (defModel.defaultReasoningEffort) {
      updates.default_reasoning_effort = tomlString(defModel.defaultReasoningEffort);
    }
  }
  return upsertTomlTableKeys(text, 'models', updates);
}

function unpinGrokOcxOnly(text) {
  const allowed = readTomlTableKey(text, 'models', 'allowed_models');
  if (allowed && !/ocx-\*/.test(String(allowed))) return text;
  return upsertTomlTableKeys(text, 'models', {}, ['allowed_models']);
}

function buildGrokHubBlock(hub, token, models) {
  if (!token) die('Missing hub admission key: set OCX_API_TOKEN or OCX_API_TOKEN_FILE');
  const lines = [
    GROK_BEGIN,
    '',
    '[model_providers.opencodex]',
    `base_url = ${tomlString(`${hub.replace(/\/+$/, '')}/v1`)}`,
    'api_backend = "responses"',
    `api_key = ${tomlString(token)}`,
    'extra_headers = { "x-opencodex-grok" = "1" }',
  ];
  for (const model of models) {
    const alias = grokAlias(model.id);
    lines.push(
      '',
      `[model.${alias}]`,
      `model = ${tomlString(model.id)}`,
      'model_provider = "opencodex"',
      `name = ${tomlString(model.name || `OCX ${model.id}`)}`,
    );
    if (model.context) lines.push(`context_window = ${model.context}`);
    if (model.reasoningSummary) lines.push(`reasoning_summary = ${tomlString(model.reasoningSummary)}`);
    if (model.defaultReasoningEffort) {
      lines.push(
        'supports_reasoning_effort = true',
        `reasoning_effort = ${tomlString(model.defaultReasoningEffort)}`,
      );
      for (const effort of model.reasoningEfforts || []) {
        const option = GROK_EFFORT_OPTIONS[effort];
        const description = (model.reasoningDescriptions && model.reasoningDescriptions[effort]) || option.description;
        lines.push(
          '',
          `[[model.${alias}.reasoning_efforts]]`,
          `id = ${tomlString(effort)}`,
          `value = ${tomlString(effort)}`,
          `label = ${tomlString(option.label)}`,
          `description = ${tomlString(description)}`,
          `default = ${effort === model.defaultReasoningEffort}`,
        );
      }
    }
  }
  lines.push('', GROK_END);
  return `${lines.join('\n')}\n`;
}

function grokTokenFileForHome(gHome) {
  const winHome = windowsUserHome();
  if (winHome && path.resolve(gHome) === path.resolve(path.join(winHome, '.grok'))) {
    const winToken = path.join(winHome, '.opencodex', 'service-api-token');
    if (fs.existsSync(winToken)) return winToken;
  }
  return path.join(opencodexHome(), 'service-api-token');
}

function readGrokAdmissionToken(tokenFile) {
  try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return ''; }
}

function writeGrokHubConfig(hub, token, catalog) {
  const homes = grokHomesForWrite();
  if (!homes.length) die(`Grok Build not installed; expected ${grokHome()}`);
  const results = [];
  for (const home of homes) {
    const configPath = path.join(home, 'config.toml');
    const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const cleaned = pinGrokToOcxModels(stripGrokHubTables(original), catalog);
    stageFile(configPath, `${cleaned.replace(/\n+$/, '')}\n\n${buildGrokHubBlock(hub, token, catalog)}`);
    results.push({ count: catalog.length, configPath });
  }
  return results;
}

function restoreGrokHubConfig() {
  const restored = [];
  for (const home of grokHomes()) {
    const configPath = path.join(home, 'config.toml');
    if (!fs.existsSync(configPath)) continue;
    const text = fs.readFileSync(configPath, 'utf8');
    const next = unpinGrokOcxOnly(stripGrokHubTables(text));
    stageFile(configPath, next);
    restored.push(configPath);
  }
  return restored;
}

function yamlUnquote(value) {
  const t = String(value || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

function splitYamlLines(text) {
  return String(text || '').split('\n').map((l) => l.replace(/\r$/, ''));
}

function yamlContentIndent(line) {
  const trimmed = String(line).trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const m = String(line).match(/^( *)/);
  return m ? m[1].length : 0;
}

function yamlKeyAt(line, indent) {
  if (yamlContentIndent(line) !== indent) return null;
  const m = String(line).slice(indent).match(/^([A-Za-z0-9_-]+)\s*:/);
  return m ? m[1] : null;
}

function findYamlChildRange(lines, parentKey, childKey, parentIndent = 0) {
  const childIndent = parentIndent + 2;
  let parentStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (yamlKeyAt(lines[i], parentIndent) === parentKey) {
      parentStart = i;
      break;
    }
  }
  if (parentStart < 0) {
    return { parentStart: -1, parentEnd: -1, childStart: -1, childEnd: -1, childIndent };
  }
  let parentEnd = lines.length;
  for (let i = parentStart + 1; i < lines.length; i += 1) {
    const ind = yamlContentIndent(lines[i]);
    if (ind !== null && ind <= parentIndent) {
      parentEnd = i;
      break;
    }
  }
  let childStart = -1;
  for (let i = parentStart + 1; i < parentEnd; i += 1) {
    if (yamlKeyAt(lines[i], childIndent) === childKey) {
      childStart = i;
      break;
    }
  }
  if (childStart < 0) {
    return { parentStart, parentEnd, childStart: -1, childEnd: -1, childIndent };
  }
  let childEnd = parentEnd;
  for (let i = childStart + 1; i < parentEnd; i += 1) {
    const ind = yamlContentIndent(lines[i]);
    if (ind !== null && ind <= childIndent) {
      childEnd = i;
      break;
    }
  }
  return { parentStart, parentEnd, childStart, childEnd, childIndent };
}

function yamlParentInline(line, parentKey) {
  const m = String(line).match(new RegExp(`^${parentKey}\\s*:\\s*(.*)$`));
  if (!m) return '';
  return m[1].replace(/\s+#.*$/, '').trim();
}

function upsertYamlMapChild(text, parentKey, childKey, childBlock) {
  const lines = splitYamlLines(text);
  if (lines.length === 1 && lines[0] === '') lines.pop();
  const blockLines = String(childBlock).replace(/\n+$/, '').split('\n');
  const range = findYamlChildRange(lines, parentKey, childKey, 0);
  if (range.parentStart < 0) {
    const out = lines.slice();
    while (out.length && out[out.length - 1] === '') out.pop();
    if (out.length) out.push('');
    out.push(`${parentKey}:`, ...blockLines);
    return `${out.join('\n')}\n`;
  }
  const inline = yamlParentInline(lines[range.parentStart], parentKey);
  if (inline && inline !== '{}' && inline !== '~' && inline !== 'null') {
    throw new Error(`${parentKey} is not a block mapping; refusing to edit`);
  }
  const next = lines.slice();
  if (inline === '{}' || inline === '~' || inline === 'null') next[range.parentStart] = `${parentKey}:`;
  if (range.childStart >= 0) {
    next.splice(range.childStart, range.childEnd - range.childStart, ...blockLines);
  } else {
    next.splice(range.parentEnd, 0, ...blockLines);
  }
  return `${next.join('\n').replace(/\n+$/, '')}\n`;
}

function yamlMapHasChild(lines, parentStart, parentEnd, childIndent) {
  for (let i = parentStart + 1; i < parentEnd; i += 1) {
    if (yamlKeyAt(lines[i], childIndent)) return true;
  }
  return false;
}

function removeYamlMapChild(text, parentKey, childKey) {
  const raw = String(text || '');
  const lines = splitYamlLines(raw);
  const range = findYamlChildRange(lines, parentKey, childKey, 0);
  if (range.childStart < 0) return raw.endsWith('\n') || !raw ? raw : `${raw}\n`;
  const next = lines.slice();
  next.splice(range.childStart, range.childEnd - range.childStart);
  const after = findYamlChildRange(next, parentKey, childKey, 0);
  if (after.parentStart >= 0 && !yamlMapHasChild(next, after.parentStart, after.parentEnd, after.childIndent)) {
    next[after.parentStart] = `${parentKey}: {}`;
    let i = after.parentStart + 1;
    while (i < next.length && next[i].trim() === '') next.splice(i, 1);
  }
  return `${next.join('\n').replace(/\n+$/, '')}\n`;
}

function parseYamlFlowSeq(inline) {
  const start = inline.indexOf('[');
  const end = inline.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  return inline.slice(start + 1, end).split(',').map((s) => yamlUnquote(s.trim())).filter((s) => s.length > 0);
}

function findRootYamlSeq(lines, key) {
  const keyRe = new RegExp(`^${key}:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(keyRe);
    if (!m) continue;
    const inline = m[1].replace(/\s+#.*$/, '').trim();
    if (inline.startsWith('[')) return { index: i, style: 'flow', inline, end: i + 1 };
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const ind = yamlContentIndent(lines[j]);
      if (ind === null) continue;
      if (ind === 0) {
        end = j;
        break;
      }
    }
    return { index: i, style: 'block', inline, end };
  }
  return null;
}

function yamlSeqAddItem(text, key, item) {
  const raw = String(text || '');
  const lines = splitYamlLines(raw);
  const seq = findRootYamlSeq(lines, key);
  if (!seq) return raw.endsWith('\n') || !raw ? raw : `${raw}\n`;
  if (seq.style === 'flow') {
    const items = parseYamlFlowSeq(seq.inline);
    if (items.includes(item)) return raw.endsWith('\n') || !raw ? raw : `${raw}\n`;
    items.push(item);
    lines[seq.index] = `${key}: [${items.join(', ')}]`;
    return `${lines.join('\n').replace(/\n+$/, '')}\n`;
  }
  const existing = [];
  for (let j = seq.index + 1; j < seq.end; j += 1) {
    const im = lines[j].match(/^  - \s*(.*)$/);
    if (!im) continue;
    existing.push(yamlUnquote(im[1].replace(/\s+#.*$/, '')));
  }
  if (existing.includes(item)) return raw.endsWith('\n') || !raw ? raw : `${raw}\n`;
  lines.splice(seq.end, 0, `  - ${item}`);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function yamlSeqRemoveItem(text, key, item) {
  const raw = String(text || '');
  const lines = splitYamlLines(raw);
  const seq = findRootYamlSeq(lines, key);
  if (!seq) return raw.endsWith('\n') || !raw ? raw : `${raw}\n`;
  if (seq.style === 'flow') {
    const items = parseYamlFlowSeq(seq.inline).filter((v) => v !== item);
    if (items.length === parseYamlFlowSeq(seq.inline).length) {
      return raw.endsWith('\n') || !raw ? raw : `${raw}\n`;
    }
    lines[seq.index] = `${key}: [${items.join(', ')}]`;
    return `${lines.join('\n').replace(/\n+$/, '')}\n`;
  }
  const next = lines.slice();
  let removed = false;
  for (let j = seq.end - 1; j > seq.index; j -= 1) {
    const im = next[j].match(/^  - \s*(.*)$/);
    if (!im) continue;
    if (yamlUnquote(im[1].replace(/\s+#.*$/, '')) !== item) continue;
    next.splice(j, 1);
    removed = true;
  }
  if (!removed) return raw.endsWith('\n') || !raw ? raw : `${raw}\n`;
  return `${next.join('\n').replace(/\n+$/, '')}\n`;
}

function yamlQuote(value) {
  return JSON.stringify(String(value));
}

function ompEffortsFromModel(model) {
  const allowed = new Set(OMP_REASONING_EFFORTS);
  return (model.reasoningEfforts || []).filter((effort) => allowed.has(effort));
}

function ompApiKeyYamlValue(token) {
  const tokenFile = path.join(opencodexHome(), 'service-api-token');
  try {
    if (fs.existsSync(tokenFile) && fs.readFileSync(tokenFile, 'utf8').trim() === token) {
      return IS_WIN ? `!cmd /c type "${tokenFile}"` : `!cat ${shellQuote(tokenFile)}`;
    }
  } catch { /* literal token */ }
  return token;
}

function buildOmpOcxProviderBlock(hub, token, models) {
  if (!token) die('Missing hub admission key: set OCX_API_TOKEN or create a connection key file');
  const lines = [
    `  ${OMP_PROVIDER}:`,
    `    baseUrl: ${yamlQuote(hubV1(hub))}`,
    `    apiKey: ${yamlQuote(ompApiKeyYamlValue(token))}`,
    `    api: openai-responses`,
    '    auth: apiKey',
    '    models:',
  ];
  for (const model of models) {
    const efforts = ompEffortsFromModel(model);
    const input = (model.input && model.input.length) ? model.input : ['text'];
    lines.push(`      - id: ${yamlQuote(model.id)}`);
    lines.push(`        name: ${yamlQuote(model.name || `OCX ${model.id}`)}`);
    if (efforts.length) lines.push('        reasoning: true');
    lines.push(`        input: [${input.join(', ')}]`);
    if (model.contextWindow) lines.push(`        contextWindow: ${model.contextWindow}`);
    lines.push(`        maxTokens: ${OMP_MAX_TOKENS}`);
    if (efforts.length) {
      // Model defaults outrank global auto in OMP; leave effort selection to judge.
      lines.push('        thinking:');
      lines.push('          mode: effort');
      lines.push(`          efforts: [${efforts.join(', ')}]`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// OMP `judge` model role (modelRoles.judge in agent/config.yml): the model that
// answers yes/no/choice/score questions for auto-thinking effort, `find` ranking,
// eval judge()/judge_batch(), /stats frustration etc. Unset → OMP falls back to
// typesafe/jev-latest → @tiny → @smol → @default. Apply never touches an
// existing judge unless --omp-judge / OCX_OMP_JUDGE is given.
const OMP_JUDGE_RESET = new Set(['auto', 'default', 'none', 'off']);

function resolveOmpJudge(value, models) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (OMP_JUDGE_RESET.has(raw.toLowerCase())) return { reset: true, selector: null };
  if (/[\s"'#]/.test(raw)) die(`omp judge: invalid model selector: ${raw}`);
  const ids = new Set((models || []).map((m) => m.id));
  const split = (sel) => {
    const m = sel.match(/^(.*?)(:(?:minimal|low|medium|high|xhigh|max|off))?$/);
    return { id: m[1], effort: m[2] || '' };
  };
  if (raw.startsWith(`${OMP_PROVIDER}/`)) {
    const { id } = split(raw.slice(OMP_PROVIDER.length + 1));
    if (!ids.has(id)) die(`omp judge: ${id} is not in the hub catalog (node ocx.mjs models)`);
    return { reset: false, selector: raw, viaHub: true };
  }
  const { id, effort } = split(raw);
  if (ids.has(id)) return { reset: false, selector: `${OMP_PROVIDER}/${id}${effort}`, viaHub: true };
  // Foreign provider selector (e.g. codiv/openjev-latest, typesafe/jev-latest): pass through.
  if (!raw.includes('/')) die(`omp judge: ${raw} is neither a hub catalog id nor a provider/model selector`);
  return { reset: false, selector: raw, viaHub: false };
}

function applyOmpJudge(configText, judge) {
  if (!judge) return configText;
  if (judge.reset) return removeYamlMapChild(configText, 'modelRoles', 'judge');
  return upsertYamlMapChild(configText, 'modelRoles', 'judge', `  judge: ${yamlQuote(judge.selector)}`);
}

function ompJudgeFromConfig(configText) {
  const lines = splitYamlLines(configText);
  const range = findYamlChildRange(lines, 'modelRoles', 'judge', 0);
  if (range.childStart < 0) return null;
  const m = lines[range.childStart].match(/^\s*judge\s*:\s*(.*)$/);
  const v = m ? yamlUnquote(m[1].replace(/\s+#.*$/, '').trim()) : '';
  return v || null;
}

function ompHubPresent(modelsPath, hub) {
  if (!fs.existsSync(modelsPath)) return false;
  let text = '';
  try { text = fs.readFileSync(modelsPath, 'utf8'); } catch { return false; }
  const origin = String(hub).replace(/\/+$/, '');
  return new RegExp(`^  ${OMP_PROVIDER}:\\s*$`, 'm').test(text) && text.includes(origin);
}




// ---------------- codex hub config (~/.codex/config.toml) ----------------

const CODEX_PROVIDER_TABLE = 'model_providers.opencodex';

function codexConfigPath() {
  return path.join(codexHome(), 'config.toml');
}

function hubV1(hub) {
  return `${String(hub).replace(/\/+$/, '')}/v1`;
}

function isLoopbackCodexOverride(value) {
  const raw = String(value || '').trim().replace(/^"|"$/g, '');
  if (!raw) return false;
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return /127\.0\.0\.1|localhost|\[::1\]/i.test(raw);
  }
}

function stripRootTomlKeys(text, keys, { onlyIf } = {}) {
  const drop = new Set(keys);
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (i < rootEnd) {
      const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m && drop.has(m[1]) && (!onlyIf || onlyIf(m[1], m[2].trim()))) {
        if (out.length && /^# Auto-injected by opencodex/.test(out[out.length - 1])) out.pop();
        continue;
      }
    }
    out.push(line);
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

function setRootTomlAssignment(text, key, assignment) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const re = new RegExp(`^${key}\\s*=`);
  for (let i = 0; i < rootEnd; i += 1) {
    if (re.test(lines[i])) {
      lines[i] = assignment;
      return `${lines.join('\n').replace(/\n+$/, '')}\n`;
    }
  }
  let insertAt = firstTable === -1 ? lines.length : firstTable;
  while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt -= 1;
  lines.splice(insertAt, 0, assignment);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function codexHubPresent(configPath, hub) {
  if (!fs.existsSync(configPath)) return false;
  let text = '';
  try { text = fs.readFileSync(configPath, 'utf8'); } catch { return false; }
  const provider = readRootTomlKey(configPath, 'model_provider');
  if (provider && provider !== 'opencodex') return false;
  const origin = String(hub).replace(/\/+$/, '');
  const base = readTomlTableKey(text, CODEX_PROVIDER_TABLE, 'base_url');
  const auth = readTomlTableKey(text, CODEX_PROVIDER_TABLE, 'requires_openai_auth');
  const rootBase = readRootTomlKey(configPath, 'openai_base_url');
  const loopbackLeft = isLoopbackCodexOverride(rootBase);
  return Boolean(base && String(base).includes(origin) && auth === 'false' && !loopbackLeft);
}

async function writeCodexCatalog(hub, token) {
  const { data } = await readHubCatalog(hub, token);
  if (!Array.isArray(data?.models) || data.models.length === 0) die('Hub returned an invalid Codex catalog');
  return data;
}

function writeCodexHubConfig(hub, catalog) {
  const configPath = codexConfigPath();
  let text = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  text = stripRootTomlKeys(text, ['openai_base_url', 'experimental_realtime_ws_base_url'], {
    onlyIf: (_key, value) => isLoopbackCodexOverride(value),
  });
  text = setRootTomlAssignment(text, 'model_provider', 'model_provider = "opencodex"');
  text = setRootTomlAssignment(text, 'model_catalog_json', `model_catalog_json = ${tomlString(catalogPathForCodex())}`);
  text = upsertTomlTableKeys(text, CODEX_PROVIDER_TABLE, {
    name: tomlString('OpenCodex Proxy'), base_url: tomlString(hubV1(hub)), wire_api: tomlString('responses'),
    requires_openai_auth: 'true', env_key: tomlString('OPENCODEX_API_AUTH_TOKEN'),
  });
  stageFile(configPath, text);
  return { configPath, baseUrl: hubV1(hub) };
}

function warnCodexLaunchToken() {
  if (process.env.OPENCODEX_API_AUTH_TOKEN) return;
  if (!readServiceToken()) {
    warn('codex: service-api-token missing; provide a data-plane key before configuring Codex');
    return;
  }
  warn('codex: OPENCODEX_API_AUTH_TOKEN is unset here; export it from ~/.opencodex/service-api-token before launching Codex');
}

// ---------------- client detection ----------------

function findOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = IS_WIN ? [name, `${name}.cmd`, `${name}.exe`, `${name}.bat`] : [name];
  for (const dir of dirs) {
    for (const cand of candidates) {
      try {
        if (fs.statSync(path.join(dir, cand)).isFile()) return cand;
      } catch { /* keep scanning */ }
    }
  }
  return null;
}

function clientInstalled(client) {
  switch (client) {
    case 'codex': return Boolean(findOnPath('codex')) || isDir(codexHome());
    case 'claude': return Boolean(findOnPath('claude')) || isDir(claudeHome());
    case 'claude-desktop':
      // No reliable executable/config probe outside Windows; same trade-off as ocx-export.sh.
      return IS_WIN ? (Boolean(findOnPath('Claude.exe')) || isDir(path.join(process.env.APPDATA || '', 'Claude'))) : false;
    case 'grok': return Boolean(findOnPath('grok')) || isDir(grokHome());
    case 'omp': return Boolean(findOnPath('omp')) || isDir(ompHome());
    default: return false;
  }
}

// ---------------- commands ----------------


function writeOmpStatusLine(opts, hub) {
  if (opts.client.length && !opts.client.includes('omp')) return;
  const homes = ompHomes();
  const file = path.join(ompAgentDir(homes[0] || ompHome()), 'models.yml');
  const present = homes.some((home) => ompHubPresent(path.join(ompAgentDir(home), 'models.yml'), hub));
  write(`client=omp state=${present ? 'current' : 'absent'} path=${file}`);
}

function managedClientActive(client) {
  return Object.values(loadJournal().files).some((entry) => entry.client === client);
}

function cmdStatus(opts) {
  const hub = resolveHub(opts);
  const connection = connectionFromConfig();
  write(`connection: ${connection ? 'configured' : 'not configured'}`);
  write(`hub: ${connection?.serverUrl || hub}`);
  for (const client of NATIVE_CLIENTS) {
    if (opts.client.length && !opts.client.includes(client)) continue;
    const files = client === 'codex' ? [codexConfigPath()]
      : client === 'claude' ? claudeHomes().map((home) => path.join(home, 'settings.json'))
        : client === 'claude-desktop' ? [path.join(DESKTOP_PROFILE_DIR(), '_meta.json')]
          : client === 'grok' ? grokHomes().map((home) => path.join(home, 'config.toml'))
            : ompHomes().map((home) => path.join(ompAgentDir(home), 'models.yml'));
    write(`client=${client} installed=${clientInstalled(client)} state=${managedClientActive(client) ? 'current' : 'absent'} files=${files.filter((file) => fs.existsSync(file)).join(',') || 'none'}`);
    if (client === 'omp') {
      const cfg = ompHomes().map((home) => path.join(ompAgentDir(home), 'config.yml')).find((file) => fs.existsSync(file));
      const judge = cfg ? ompJudgeFromConfig(fs.readFileSync(cfg, 'utf8')) : null;
      write(`client=omp judge=${judge || 'unset (OMP default chain)'}`);
    }
  }
  write('catalog: fetched from the hub on demand (node ocx.mjs models)');
}



async function cmdToggle(opts, enabled) {
  if (!opts.client.length) die('apply/restore require at least one --client');
  const unique = [...new Set(opts.client)];
  if (!unique.every((client) => NATIVE_CLIENTS.includes(client))) die('Unsupported client');
  await withStateLock(async () => {
    if (!enabled) {
      restoreClients(unique);
      return;
    }
    const hub = resolveHub(opts);
    const token = readApiKey();
    if (!token) die('Missing hub admission key: set OCX_API_TOKEN or create a connection key file');
    if (opts.ompJudge != null && !unique.includes('omp')) die('--omp-judge requires --client omp');
    // OCX_OMP_JUDGE from the environment only applies when omp is selected; ignore it otherwise.
    const ompJudgeArg = unique.includes('omp') ? (opts.ompJudge ?? process.env.OCX_OMP_JUDGE ?? null) : null;
    const common = unique.some((client) => ['codex', 'grok', 'omp'].includes(client)) ? await readHubCatalog(hub, token) : null;
    const ompJudge = ompJudgeArg ? resolveOmpJudge(ompJudgeArg, common.models) : null;
    const codexCatalog = unique.includes('codex') ? await writeCodexCatalog(hub, token, opts.clientVersion) : null;
    let desktopSnapshot = null;
    if (unique.includes('claude-desktop')) {
      desktopSnapshot = await hubJson(hub, '/v1/models?ids=desktop&format=desktop-config', token);
      if (desktopSnapshot?.version !== 1) die('Hub returned an unsupported Claude Desktop snapshot');
    }
    if (unique.includes('claude')) {
      const catalog = await claudeFetchHubCatalog(hub, token);
      if (catalog.error) die(`Claude catalog: ${catalog.error}`);
    }
    const journal = loadJournal();
    activeWrites = new Map();
    try {
      for (const client of unique) {
        activeClient = client;
        if (client === 'claude') {
          const applied = await claudeSettingsEnvApply(hub, token);
          logOk(`claude: hub settings applied; ${applied.cache.count} models`);
        } else if (client === 'codex') {
          stageFile(catalogPathForCodex(), `${JSON.stringify(codexCatalog, null, 2)}\n`);
          writeCodexHubConfig(hub, codexCatalog);
        } else if (client === 'claude-desktop') {
          writeClaudeDesktopHubProfile(hub, token, desktopSnapshot);
        } else if (client === 'grok') {
          writeGrokHubConfig(hub, token, common.models.filter((m) => !m.id.startsWith('claude-')));
        } else if (client === 'omp') {
          const homes = ompHomesForWrite();
          if (!homes.length) die(`Oh My Pi not installed; expected ${ompHome()} or omp on PATH`);
          for (const home of homes) {
            const dir = ompAgentDir(home);
            const modelFile = path.join(dir, 'models.yml');
            const before = fs.existsSync(modelFile) ? fs.readFileSync(modelFile, 'utf8') : '';
            stageFile(modelFile, upsertYamlMapChild(before, 'providers', OMP_PROVIDER, buildOmpOcxProviderBlock(hub, token, common.models)));
            const configFile = path.join(dir, 'config.yml');
            const judge = ompJudge;
            if (fs.existsSync(configFile) || (judge && !judge.reset)) {
              const old = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
              let next = yamlSeqRemoveItem(yamlSeqAddItem(old, 'enabledProviders', OMP_PROVIDER), 'disabledProviders', OMP_PROVIDER);
              next = applyOmpJudge(next, judge);
              if (next !== old) stageFile(configFile, next);
              if (judge) logOk(`omp: judge ${judge.reset ? 'reset to OMP defaults' : `= ${judge.selector}`} (${configFile})`);
            }
          }
        }
      }
      for (const [file, change] of activeWrites) {
        const prior = journal.files[file];
        const before = prior ? assertJournalCurrent(file, prior) : fileSnapshot(file);
        change.before = prior ? prior.before : before;
      }
      commitWrites(journal);
    } finally {
      activeWrites = null;
      activeClient = null;
    }
  });
  info(`${enabled ? 'applied' : 'restored'} clients: ${unique.join(', ')}`);
}



// ---------------- interactive TUI ----------------

const realTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);

function isInteractive() {
  if (process.env.OCX_NONINTERACTIVE) return false;
  if (process.env.OCX_ASSUME_TTY === '1') return true;
  return realTty;
}

function shortModelId(id) {
  return String(id || '')
    .replace(/^claude-ocx-native--/, '')
    .replace(/^claude-ocx-/, '')
    .replace(/^ocx-/, '');
}

function clientDetail(id) {
  if (id === 'codex') {
    return readRootTomlKey(path.join(codexHome(), 'config.toml'), 'model') || CLIENT_META.codex.blurb;
  }
  if (id === 'claude') {
    const env = readClaudeSettings().env || {};
    const opus = env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    const haiku = env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_SMALL_FAST_MODEL;
    const bits = [];
    if (opus) bits.push(`opus ${shortModelId(opus)}`);
    if (haiku) bits.push(`haiku ${shortModelId(haiku)}`);
    return bits.length ? bits.join(' · ') : CLIENT_META.claude.blurb;
  }
  if (id === 'grok') {
    const homes = grokHomes();
    if (!homes.length) return CLIENT_META.grok.blurb;
    let text = '';
    try { text = fs.readFileSync(path.join(homes[0], 'config.toml'), 'utf8'); } catch { return CLIENT_META.grok.blurb; }
    const def = readTomlTableKey(text, 'models', 'default') || CLIENT_META.grok.blurb;
    return text.includes(GROK_BEGIN) ? def : `${def} · без fence`;
  }
  if (id === 'omp') {
    const homes = ompHomes();
    if (!homes.length) return CLIENT_META.omp.blurb;
    const modelsPath = path.join(ompAgentDir(homes[0]), 'models.yml');
    if (!fs.existsSync(modelsPath)) return CLIENT_META.omp.blurb;
    const text = fs.readFileSync(modelsPath, 'utf8');
    const range = findYamlChildRange(splitYamlLines(text), 'providers', OMP_PROVIDER, 0);
    if (range.childStart < 0) return CLIENT_META.omp.blurb;
    const slice = splitYamlLines(text).slice(range.childStart, range.childEnd).join('\n');
    const n = [...slice.matchAll(/^\s+- id:\s+\S+/gm)].length;
    return n ? `${n} models` : CLIENT_META.omp.blurb;
  }
  return CLIENT_META[id]?.blurb || '';
}

function gatherClients(opts) {
  const connection = connectionFromConfig();
  const connected = Boolean(connection);
  const items = [];
  for (const id of NATIVE_CLIENTS) {
    const installed = clientInstalled(id);
    let note = 'не найден';
    let kind = 'missing';
    if (installed) {
      const active = managedClientActive(id);
      if (id === 'omp' && connected) {
        const hub = resolveHub(opts);
        const present = ompHomes().some((home) => ompHubPresent(path.join(ompAgentDir(home), 'models.yml'), hub));
        note = present ? 'desired=on' : 'desired=off';
        kind = present ? 'on' : 'off';
      } else {
        note = active ? 'desired=on' : 'desired=off';
        kind = active ? 'on' : 'off';
      }
    }
    items.push({ id, installed, note, kind, title: CLIENT_META[id].title, detail: installed ? clientDetail(id) : CLIENT_META[id].blurb });
  }
  return { items, connection: connected ? 'connected' : 'not configured', hub: resolveHub(opts), catalog: { count: 0, combos: [] } };
}

// Parses keypresses, SGR 1006 mouse events and the \x1b[6n cursor report
// out of a byte stream (latin1 keeps escape parsing byte-safe).
function parseEvents(buf) {
  const events = [];
  let i = 0;
  while (i < buf.length) {
    const ch = buf[i];
    if (ch === '\x1b') {
      if (buf.startsWith('\x1b[<', i)) {
        const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(buf.slice(i));
        if (m) {
          events.push({ type: 'mouse', btn: Number(m[1]), x: Number(m[2]), y: Number(m[3]), press: m[4] === 'M' });
          i += m[0].length;
          continue;
        }
        i += 1; continue;
      }
      if (buf.startsWith('\x1b[', i)) {
        const m = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(buf.slice(i));
        if (m) {
          const params = m[1].split(';');
          switch (m[2]) {
            case 'A': events.push({ type: 'up' }); break;
            case 'B': events.push({ type: 'down' }); break;
            case 'R': events.push({ type: 'cursor', row: Number(params[0] || 1) }); break;
            default: break;
          }
          i += m[0].length;
          continue;
        }
        i += 1; continue;
      }
      events.push({ type: 'esc' });
      i += 1; continue;
    }
    if (ch === '\r' || ch === '\n') { events.push({ type: 'enter' }); i += 1; continue; }
    if (ch === ' ') { events.push({ type: 'space' }); i += 1; continue; }
    if (ch === '\x03') { events.push({ type: 'interrupt' }); i += 1; continue; }
    if (/[a-zA-Z]/.test(ch)) { events.push({ type: 'key', key: ch.toLowerCase() }); i += 1; continue; }
    i += 1;
  }
  return events;
}

function boxChars() {
  return useColor
    ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
    : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };
}

function boxTop(width, title) {
  const c = boxChars();
  const label = ` ${title} `;
  const inner = width - 2;
  const fill = Math.max(0, inner - visLen(label));
  return ui.cyan(c.tl + c.h) + ui.bold(label) + ui.cyan(c.h.repeat(Math.max(0, fill - 1)) + c.tr);
}

function boxRow(width, content, { invert = false } = {}) {
  const c = boxChars();
  const inner = width - 2;
  const body = padVis(content, inner);
  return ui.cyan(c.v) + (invert ? ui.inverse(body) : body) + ui.cyan(c.v);
}

function boxBottom(width, hint) {
  const c = boxChars();
  const inner = width - 2;
  const label = hint ? ` ${hint} ` : '';
  const fill = Math.max(0, inner - visLen(label));
  return ui.dim(c.bl + (label ? `${c.h}${label}${c.h.repeat(Math.max(0, fill - 1))}` : c.h.repeat(inner)) + c.br);
}

function statusBadge(kind) {
  if (kind === 'on') return ui.green('ON ');
  if (kind === 'off') return ui.yellow('OFF');
  if (kind === 'hub') return ui.cyan('HUB');
  if (kind === 'local') return ui.cyan('LOC');
  return ui.dim(' — ');
}

function connBadge(state) {
  if (state === 'connected') return ui.green('connected');
  if (state === 'unavailable') return ui.yellow('unavailable');
  return ui.yellow(String(state || 'unknown'));
}

function interactiveMenu(gathered, opts) {
  return new Promise((resolve) => {
    const screen = new Screen(process.stdout);
    const items = gathered.items;
    const enabledIdx = [];
    items.forEach((it, i) => { if (it.installed) enabledIdx.push(i); });
    const checked = new Set();
    let focus = enabledIdx.length ? enabledIdx[0] : -1;
    let phase = 'checkbox';
    let actFocus = 0;
    let msg = '';
    let chosen = [];
    let finished = false;
    let lastRow = null;      // absolute terminal row of the last frame line
    let frameLen = 0;
    let mouseOn = false;
    const wantMouse = realTty;
    let probeTimer = null;
    const actions = [
      { id: 'apply', label: 'Применить настройки Hub', mark: '✓' },
      { id: 'restore', label: 'Восстановить исходные настройки', mark: '↩' },
      { id: 'cancel', label: 'Отмена', mark: '✕' },
    ];
    const layout = { item0: 0, action0: 0, buttons: -1 };

    function checkboxFrame() {
      const width = termWidth();
      const cat = gathered.catalog || { count: 0, combos: [] };
      const comboBit = cat.combos.length ? ` · combos ${cat.combos.join(', ')}` : '';
      const lines = [
        boxTop(width, 'OCX  клиенты'),
        boxRow(width, `  hub   ${gathered.hub}`),
        boxRow(width, `  ${connBadge(gathered.connection)}  ·  catalog ${cat.count} visible${comboBit}`),
        boxRow(width, ''),
      ];
      layout.item0 = lines.length;
      items.forEach((it, i) => {
        const cursor = i === focus ? '❯ ' : '  ';
        const mark = it.installed
          ? (checked.has(i) ? ui.green('●') : ui.dim('○'))
          : ui.dim('·');
        const title = padVis(it.title, 16);
        const body = ` ${cursor}${mark} ${title} ${statusBadge(it.kind)}  ${ui.dim(it.detail)}`;
        lines.push(boxRow(width, body, { invert: i === focus }));
      });
      lines.push(boxRow(width, ''));
      lines.push(boxRow(width, `  ${msg ? ui.yellow(msg) : ui.dim(`отмечено ${checked.size} из ${enabledIdx.length}`)}`));
      lines.push(boxRow(width, ''));
      const btn1 = '[  Далее ⏎  ]';
      const btn2 = '[  Отмена q  ]';
      const gap = '   ';
      const btnLine = `  ${ui.cyan(btn1)}${gap}${ui.dim(btn2)}`;
      layout.buttons = lines.length;
      const prefixVis = 1 + 2; // border + two spaces
      hotspots = [
        { x0: prefixVis + 1, x1: prefixVis + visLen(btn1), action: 'enter' },
        { x0: prefixVis + visLen(btn1) + gap.length + 1, x1: prefixVis + visLen(btn1) + gap.length + visLen(btn2), action: 'cancel' },
      ];
      lines.push(boxRow(width, btnLine));
      lines.push(boxBottom(width, 'space отметить · a все · ↑↓ · мышь'));
      return lines;
    }
    function actionFrame() {
      const width = termWidth();
      const lines = [
        boxTop(width, 'OCX  действие'),
        boxRow(width, `  клиенты  ${chosen.join(', ')}`),
        boxRow(width, ''),
      ];
      layout.action0 = lines.length;
      actions.forEach((a, i) => {
        const cursor = i === actFocus ? '❯ ' : '  ';
        const mark = a.id === 'apply' ? ui.green(a.mark) : a.id === 'restore' ? ui.yellow(a.mark) : ui.dim(a.mark);
        lines.push(boxRow(width, ` ${cursor}${mark}  ${a.label}`, { invert: i === actFocus }));
      });
      lines.push(boxRow(width, ''));
      lines.push(boxBottom(width, '↑↓ выбрать · enter · q назад'));
      return lines;
    }

    let hotspots = [];

    function render() {
      const frame = phase === 'checkbox' ? checkboxFrame() : actionFrame();
      frameLen = frame.length;
      screen.render(frame);
    }

    function move(delta) {
      const list = phase === 'checkbox' ? enabledIdx : actions.map((_, i) => i);
      if (!list.length) return;
      let pos = list.indexOf(phase === 'checkbox' ? focus : actFocus);
      if (pos === -1) pos = 0;
      pos = (pos + delta + list.length) % list.length;
      if (phase === 'checkbox') focus = enabledIdx[pos];
      else actFocus = pos;
    }

    function toggleItem(i) {
      if (!items[i].installed) {
        msg = `${items[i].id}: не установлен на этой машине`;
        return;
      }
      msg = '';
      if (checked.has(i)) checked.delete(i);
      else checked.add(i);
    }

    function finish(value) {
      if (finished) return;
      finished = true;
      if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
      if (mouseOn) process.stdout.write('\x1b[?1006l\x1b[?1000l');
      try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* ignore */ }
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      screen.clear();
      process.stdout.write('\n');
      resolve(value);
    }

    function activate(actionId) {
      if (actionId === 'cancel') { phase = 'checkbox'; msg = ''; return; }
      finish({ action: actionId, chosen });
    }
    function handle(evt) {
      if (evt.type === 'cursor') {
        if (wantMouse && !mouseOn && probeTimer) {
          clearTimeout(probeTimer);
          probeTimer = null;
          lastRow = evt.row;
          process.stdout.write('\x1b[?1000h\x1b[?1006h');
          mouseOn = true;
        }
        return;
      }
      if (evt.type === 'mouse') {
        if (!mouseOn || !evt.press) return;
        if (evt.btn === 64) { move(-1); return; }
        if (evt.btn === 65) { move(1); return; }
        if (evt.btn !== 0) return;
        const idx = frameLen - 1 - (lastRow - evt.y);
        if (phase === 'checkbox') {
          if (idx >= layout.item0 && idx < layout.item0 + items.length) {
            toggleItem(idx - layout.item0);
          } else if (idx === layout.buttons) {
            const hit = hotspots.find((h) => evt.x >= h.x0 && evt.x <= h.x1);
            if (hit?.action === 'cancel') finish({ action: 'cancel' });
            else if (hit?.action === 'enter') handle({ type: 'enter' });
          }
        } else if (idx >= layout.action0 && idx < layout.action0 + actions.length) {
          actFocus = idx - layout.action0;
          activate(actions[actFocus].id);
        }
        return;
      }
      switch (evt.type) {
        case 'interrupt': finish({ action: 'cancel', interrupted: true }); return;
        case 'up': move(-1); break;
        case 'down': move(1); break;
        case 'esc':
        case 'key':
          if ((evt.type === 'esc' || evt.key === 'q')) {
            if (phase === 'action') { phase = 'checkbox'; msg = ''; }
            else finish({ action: 'cancel' });
          } else if (evt.key === 'j') move(1);
          else if (evt.key === 'k') move(-1);
          else if (evt.key === 'a' && phase === 'checkbox') {
            const all = enabledIdx.every((i) => checked.has(i));
            enabledIdx.forEach((i) => (all ? checked.delete(i) : checked.add(i)));
            msg = '';
          }
          break;
        case 'space':
          if (phase === 'checkbox' && focus >= 0) toggleItem(focus);
          break;
        case 'enter':
          if (phase === 'checkbox') {
            if (!checked.size) { msg = 'отметьте хотя бы одного клиента'; break; }
            chosen = enabledIdx.filter((i) => checked.has(i)).map((i) => items[i].id);
            phase = 'action';
            actFocus = 0;
            msg = '';
          } else {
            activate(actions[actFocus].id);
          }
          break;
        default: break;
      }
    }

    const onData = (buf) => {
      for (const evt of parseEvents(buf.toString('latin1'))) {
        if (finished) return;
        handle(evt);
      }
      if (!finished && frameLen) render();
    };

    process.stdout.write('\n');
    try { if (process.stdin.isTTY) process.stdin.setRawMode(true); } catch { /* ignore */ }
    process.stdin.resume();
    process.stdin.on('data', onData);
    render();
    if (wantMouse) {
      probeTimer = setTimeout(() => { probeTimer = null; }, 350);
      process.stdout.write('\x1b[6n'); // cursor report locates the frame for mouse hit-testing
    }
  });
}

async function runInteractiveMenu(opts) {
  const gathered = gatherClients(opts);
  if (!gathered.items.some((it) => it.installed)) {
    write('No supported AI agent CLIs (codex, claude, claude-desktop, grok) were detected on this machine.');
    cmdStatus(opts);
    return;
  }
  const result = await interactiveMenu(gathered, opts);
  if (result.action === 'cancel') {
    write(result.interrupted ? 'Interrupted; no changes made.' : 'Cancelled; no changes made.');
    if (result.interrupted) process.exitCode = 130;
    return;
  }
  opts.client = result.chosen;
  write(result.action === 'apply'
    ? `Applying OCX integration for: ${result.chosen.join(', ')}`
    : `Restoring native configuration for: ${result.chosen.join(', ')}`);
  await cmdToggle(opts, result.action === 'apply');
  write(`log: ${logFilePath()}`);
}

// ---------------- CLI ----------------

function mapClient(client) {
  if (client === 'claude-code' || client === 'claude') return 'claude';
  if (NATIVE_CLIENTS.includes(client)) return client;
  die(`invalid client: ${client}`);
  return null;
}

async function cmdModels(opts = {}) {
  const token = readAdmissionToken();
  if (!token) die('Missing hub admission key: set OCX_API_TOKEN or create a connection key file');
  const hub = resolveHub(opts);
  const loaded = await loadOmpCatalog(hub, token);
  const rows = loaded.models;
  write(`catalog: ${rows.length} visible (GET /v1/catalog)`);
  const combos = rows.filter((m) => isComboId(m.id));
  if (combos.length) write(`combos: ${combos.map((m) => m.id).join(', ')}`);
  const idW = Math.min(52, Math.max(18, ...rows.map((m) => m.id.length)));
  for (const m of rows) {
    const kind = isComboId(m.id) ? 'combo' : (m.id.includes('/') ? 'routed' : 'native');
    write(`${padVis(m.id, idW)}  ${String(m.context || '-').padStart(8)}  ${kind.padEnd(6)}  ${m.name}`);
  }
}

function parseArgs(argv) {
  const opts = {
    command: 'status',
    hub: null,
    client: [],
  };
  let commandSeen = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!commandSeen && ['status', 'apply', 'restore', 'help', 'models'].includes(arg)) {
      opts.command = arg;
      commandSeen = true;
      i += 1;
      continue;
    }
    const value = () => {
      if (i + 1 >= argv.length) die(`missing value for ${arg}`);
      i += 1;
      return argv[i];
    };
    switch (arg) {
      case '--help': case '-h': opts.command = 'help'; break;
      case '--hub': opts.hub = value(); break;
      case '--client': opts.client.push(mapClient(value())); break;
      case '--omp-judge': opts.ompJudge = value(); break;
      default:
        if (arg.startsWith('-')) die(`unknown option: ${arg}`);
        else die(`unexpected argument: ${arg}`);
    }
    i += 1;
  }
  return opts;
}

function usage() {
  write(`ocx.mjs — point AI coding clients at an OpenCodex hub

Usage:
  node ocx.mjs                     interactive client picker in a TTY; read-only status otherwise
  node ocx.mjs status  [--client <id> ...]   show hub, detected clients and managed state
  node ocx.mjs models                        list the hub model catalog (GET /v1/catalog)
  node ocx.mjs apply   --client <id> [--client <id> ...]   write hub settings into client configs
  node ocx.mjs restore --client <id> [--client <id> ...]   put back the files saved before apply
  node ocx.mjs help | --help | -h

Options:
  --hub <url>       hub origin, e.g. https://ocx.example.com (HTTP only on loopback)
  --client <id>     codex | claude (alias claude-code) | claude-desktop | grok | omp
  --omp-judge <m>   apply --client omp: set OMP modelRoles.judge. Hub id (gpt-6-luna:low → ocx/gpt-6-luna:low),
                    ocx/<id>, a foreign provider/model (codiv/openjev-latest), or auto to unset.
                    Without it an existing judge is left untouched.

Hub URL resolution: --hub, then OCX_HUB, then <state>/connection.json {"hub": "..."},
then ${DEFAULT_HUB}.

Key (data-plane admission token, NOT a provider key) resolution:
  OCX_API_TOKEN, then the file OCX_API_TOKEN_FILE (default <state>/api-key),
  then $OPENCODEX_HOME/service-api-token (default ~/.opencodex/service-api-token).

Environment:
  OCX_HUB                 hub origin
  OCX_API_TOKEN           data-plane key (prefer a file)
  OCX_API_TOKEN_FILE      file with the data-plane key
  OCX_STATE_HOME          state dir: journal, lock, connection.json (default ~/.ocx-export)
  OCX_LOG_FILE            log file (default ~/.ocx-export/ocx-export.log; secrets redacted)
  OCX_NONINTERACTIVE=1    never open the interactive picker (CI)
  OCX_ASSUME_TTY=1        force the interactive picker
  OCX_OMP_JUDGE           same as --omp-judge
  OCX_COMBO_PREFIXES      comma-separated id prefixes shown as "combo" (default combo/)
  NO_COLOR                disable colors
  Client homes: CODEX_HOME, CLAUDE_CONFIG_DIR, GROK_HOME, OMP_HOME, OPENCODEX_HOME,
  OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR, CLAUDE_USER_DATA_DIR

Examples:
  export OCX_HUB=https://ocx.example.com
  printf '%s' "<key>" > ~/.ocx-export/api-key && chmod 600 ~/.ocx-export/api-key
  node ocx.mjs models
  node ocx.mjs apply --client codex --client claude
  node ocx.mjs restore --client claude

Docs: https://github.com/nordz0r/opencodex-docker/blob/main/docs/ocx-cli.en.md`);
}

async function main() {
  flog(`=== ocx.mjs argv=[${process.argv.slice(2).join(' ')}] platform=${process.platform}`);
  const noArgs = process.argv.length <= 2;
  const opts = parseArgs(process.argv.slice(2));
  switch (opts.command) {
    case 'help': usage(); return;
    case 'status':
      if (noArgs && isInteractive()) { void runInteractiveMenu(opts); return; }
      cmdStatus(opts);
      return;
    case 'models': await cmdModels(opts); return;
    case 'apply': await cmdToggle(opts, true); return;
    case 'restore': await cmdToggle(opts, false); return;
    default: die(`unknown command: ${opts.command}`);
  }
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    try {
      return import.meta.url === pathToFileURL(path.resolve(entry)).href;
    } catch {
      return false;
    }
  }
}

if (isMainModule()) {
  try {
    main().catch((e) => {
      if (!(e instanceof Fatal)) {
        process.stderr.write(`unexpected error: ${e && e.stack ? e.stack : e}\n`);
        process.exitCode = 1;
      }
    });
  } catch (e) {
    if (!(e instanceof Fatal)) {
      process.stderr.write(`unexpected error: ${e && e.stack ? e.stack : e}\n`);
      process.exitCode = 1;
    }
  }
}

export {
  upsertYamlMapChild,
  removeYamlMapChild,
  yamlSeqAddItem,
  yamlSeqRemoveItem,
  buildOmpOcxProviderBlock,
  ompHubPresent,
  resolveOmpJudge,
  applyOmpJudge,
  ompJudgeFromConfig,
  catalogModelsFromData,
  loadOmpCatalog,
};
