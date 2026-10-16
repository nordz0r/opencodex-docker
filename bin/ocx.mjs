#!/usr/bin/env node
// Hub-only client configurator for Node.js >= 18, Windows and Linux/WSL.
// Downloads model assignments using an existing data-plane key. No local OCX
// binary, proxy or client installer is needed. Client changes are journaled;
// restore refuses to overwrite files edited after apply.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const NATIVE_CLIENTS = ['codex', 'claude', 'claude-desktop', 'grok', 'omp'];
const CLIENT_META = {
  codex: { title: 'Codex', blurb: 'CLI / TUI / App' },
  claude: { title: 'Claude Code', blurb: 'gateway + family slots' },
  'claude-desktop': { title: 'Claude Desktop', blurb: 'hub profile' },
  grok: { title: 'Grok Build', blurb: 'hub provider + ocx-*' },
  omp: { title: 'Oh My Pi', blurb: 'hub provider ocx; Responses by default' },
};
const OMP_PROVIDER = 'ocx';
const OMP_APIS = ['openai-responses', 'anthropic-messages'];
const DEFAULT_HUB = 'https://ocx.goldfinches.ru';
const IS_WIN = process.platform === 'win32';
const DESKTOP_PROFILE_NAME = 'opencodex';
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
  if (winProfile && /^[A-Za-z]:[\\/]/.test(winProfile)) {
    return IS_WIN ? winProfile : `/mnt/${winProfile[0].toLowerCase()}${winProfile.slice(2).replace(/\\/g, '/')}`;
  }
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
      const score = ['.omp', '.grok', '.codex', '.claude']
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
  if (!process.env.GROK_HOME) add(windowsGrokHome());
  return homes;
};
const grokHomesForWrite = () => {
  const homes = grokHomes();
  return homes.length ? homes : (findOnPath('grok') ? [grokHome()] : []);
};
const codexHome = () => process.env.CODEX_HOME || homeDir('.codex');
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
// omp (oh-my-pi) ignores OMP_HOME. Its config root env is PI_CONFIG_DIR, joined
// UNDER the user's home and then suffixed with `agent` (verified against omp
// 18.11.3: PI_CONFIG_DIR=/x -> $HOME/x/agent, even for absolute /x; empty ->
// ~/.omp/agent). XDG_CONFIG_HOME is ignored by omp.
const piConfigDir = () => String(process.env.PI_CONFIG_DIR || '').trim();
const ompHome = () => {
  const dir = piConfigDir();
  if (!dir) return homeDir('.omp');
  const base = os.homedir();
  return path.isAbsolute(dir) ? path.normalize(path.join(base, dir)) : path.resolve(base, dir);
};
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
const ompHomes = () => collectHomes(ompHome(), piConfigDir() ? null : windowsOmpHome());
const ompHomesForWrite = () => {
  const homes = ompHomes();
  if (homes.length) return homes;
  if (findOnPath('omp')) return [ompHome()];
  return [];
};
const ompAgentDir = (home) => path.join(home, 'agent');

// ---------------- file log ----------------

function logFilePath() {
  return process.env.OCX_LOG_FILE || path.join(stateHome(), 'ocx-export.log');
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

// ---------------- hub connection and reversible file updates ----------------

const stateHome = () => process.env.OCX_STATE_HOME || homeDir('.ocx-export');
const connectionPath = () => path.join(stateHome(), 'connection.json');
const keyFilePath = () => path.join(stateHome(), 'api-key');
const readTrimmedFile = (file) => {
  try { return fs.readFileSync(file, 'utf8').trim(); }
  catch { return ''; }
};
const opencodexTokenFiles = () => {
  const files = [];
  const seen = new Set();
  const add = (home) => {
    if (!home) return;
    const file = path.resolve(home, '.opencodex', 'service-api-token');
    const key = IS_WIN ? file.toLowerCase() : file;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };
  add(os.homedir());
  add(windowsUserHome());
  return files;
};
const resolveApiKey = () => {
  const fromEnv = String(process.env.OCX_API_TOKEN || '').trim();
  if (fromEnv) return { token: fromEnv, source: 'OCX_API_TOKEN (environment)' };
  const explicit = String(process.env.OCX_API_TOKEN_FILE || '').trim();
  if (explicit) {
    let raw;
    try { raw = fs.readFileSync(explicit, 'utf8'); }
    catch { die(`Cannot read OCX_API_TOKEN_FILE (${explicit}); it is missing or unreadable. Other key files are not used.`); }
    const token = raw.trim();
    if (!token) die(`OCX_API_TOKEN_FILE (${explicit}) is empty. Other key files are not used.`);
    return { token, source: `OCX_API_TOKEN_FILE (${explicit})` };
  }
  const own = readTrimmedFile(keyFilePath());
  if (own) return { token: own, source: keyFilePath() };
  for (const file of opencodexTokenFiles()) {
    const token = readTrimmedFile(file);
    if (token) return { token, source: file };
  }
  return { token: '', source: 'none' };
};
const readApiKey = () => resolveApiKey().token;
function missingApiKey() {
  die([
    'No hub API key found.',
    'Supply a token without passing it as an argument (the token is never printed):',
    '  node ocx.mjs configure                  hidden TTY input',
    '  node ocx.mjs configure --token-stdin     non-TTY; pipe or redirect the token',
    '  or set OCX_API_TOKEN / OCX_API_TOKEN_FILE',
    'An existing ~/.opencodex/service-api-token (or the Windows equivalent) is used automatically when present.',
  ].join('\n'));
}
const tokenFileForCodexLaunch = () => {
  const explicit = String(process.env.OCX_API_TOKEN_FILE || '').trim();
  if (explicit) return path.resolve(explicit);
  const own = path.resolve(keyFilePath());
  if (readTrimmedFile(own)) return own;
  for (const file of opencodexTokenFiles()) {
    if (readTrimmedFile(file)) return file;
  }
  return own;
};
const catalogPathForCodex = () => path.join(codexHome(), 'opencodex-catalog.json');
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

function sameSnapshot(a, b, platform = process.platform) {
  if (a === null || b === null) return a === b;
  if (a.data !== b.data) return false;
  return platform === 'win32' || a.mode === b.mode;
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

// The two states a journal entry accepts: what ocx.mjs last wrote (`after`) and
// the state a half-finished commit may have left behind (`previous`). Anything
// else is a manual or concurrent edit. Returns true when confirmation is needed.
function journalDrift(snapshot, entry) {
  if (sameSnapshot(snapshot, entry.after)) return false;
  if (Object.hasOwn(entry, 'previous') && sameSnapshot(snapshot, entry.previous)) return false;
  return true;
}

function assertJournalCurrent(file, entry) {
  const current = fileSnapshot(file);
  if (journalDrift(current, entry)) die(`File changed since apply; refusing to overwrite: ${file}`);
  return current;
}

const snapshotText = (snapshot) => (snapshot ? Buffer.from(snapshot.data, 'base64').toString('utf8') : '');

// Line diff of the manual edits apply is about to overwrite. Bounded so a fully
// rewritten file cannot flood the terminal; falls back to a prefix/suffix diff
// when the LCS table would be too large.
function compactDiff(beforeText, afterText, limit = 60) {
  const a = String(beforeText).split('\n');
  const b = String(afterText).split('\n');
  const out = [];
  if (a.length * b.length > 4_000_000) {
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
    for (const line of a.slice(head, a.length - tail)) out.push(`- ${line}`);
    for (const line of b.slice(head, b.length - tail)) out.push(`+ ${line}`);
  } else {
    const width = b.length + 1;
    const table = new Int32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        table[i * width + j] = a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i += 1; j += 1; continue; }
      if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { out.push(`- ${a[i]}`); i += 1; }
      else { out.push(`+ ${b[j]}`); j += 1; }
    }
    for (; i < a.length; i += 1) out.push(`- ${a[i]}`);
    for (; j < b.length; j += 1) out.push(`+ ${b[j]}`);
  }
  const changed = out.length;
  return { lines: changed > limit ? [...out.slice(0, limit), `… ${changed - limit} more changed line(s)`] : out, changed };
}

// Interactive yes/no. Returns null when no terminal is available — piped input,
// CI, or an explicit OCX_NONINTERACTIVE run — which callers must treat as
// "cannot confirm", never as consent.
function promptContinue(question) {
  if (process.env.OCX_NONINTERACTIVE) return Promise.resolve(null);
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    // The interactive menu leaves stdin cooked before it calls apply, but never
    // assume it: drop raw mode for the prompt and put it back afterwards.
    const wasRaw = Boolean(process.stdin.isRaw);
    if (wasRaw) { try { process.stdin.setRawMode(false); } catch { /* ignore */ } }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      if (wasRaw) { try { process.stdin.setRawMode(true); } catch { /* ignore */ } }
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function confirmOverwrite(conflicts, current) {
  write(`manual changes detected in ${conflicts.length} managed file(s):`);
  for (const conflict of conflicts) {
    const { lines, changed } = compactDiff(snapshotText(conflict.written), snapshotText(conflict.snapshot));
    write('');
    write(`  ${conflict.file}  (${changed} changed line(s))`);
    for (const line of lines) write(`    ${redact(line).replace(/(apiKey\s*[:=]\s*).*/i, '$1[redacted]')}`);
  }
  write('');
  const answer = await promptContinue('Overwrite these files and continue? [y/N] ');
  if (answer === null) {
    die(`Manual changes present and no interactive confirmation available; refusing to overwrite: ${conflicts.map((c) => c.file).join(', ')}`);
  }
  if (!answer) die('Aborted at the overwrite prompt; no changes made');
  for (const conflict of conflicts) current.set(conflict.file, conflict.snapshot);
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

async function commitWrites(journal) {
  const original = structuredClone(journal);
  const current = new Map();
  const conflicts = [];
  for (const [file, change] of activeWrites) {
    const entry = journal.files[file];
    if (entry && entry.client !== change.client) die(`File belongs to another client: ${file}`);
    const snapshot = fileSnapshot(file);
    // Manual edits are shown and confirmed before anything is written; a declined
    // prompt leaves the journal untouched, so the next run re-offers the same diff.
    if (entry && journalDrift(snapshot, entry)) conflicts.push({ file, snapshot, written: entry.after });
    else current.set(file, snapshot);
  }
  if (conflicts.length) await confirmOverwrite(conflicts, current);
  for (const [file, change] of activeWrites) {
    const entry = journal.files[file];
    const before = current.get(file);
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

function resolveConnection(opts = {}) {
  const saved = readJsonFile(connectionPath(), {});
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) die('Invalid saved connection');
  return {
    saved,
    hub: validateHub(opts.hub || process.env.OCX_HUB || saved.hub || DEFAULT_HUB),
    ompApi: saved.ompApi === undefined ? 'openai-responses' : saved.ompApi,
  };
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

function validateOmpApi(api) {
  if (!OMP_APIS.includes(api)) die('Invalid OMP API; use configure --omp-api openai-responses|anthropic-messages');
  return api;
}


async function readHubCatalog(context) {
  const data = await context.request('/v1/catalog');
  const models = catalogModelsFromData(data);
  if (!models.length) die('Hub catalog is empty; refusing to write client configuration');
  return { data, models };
}


function writeClaudeDesktopHubProfile(hub, token, snapshot) {
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





function requestContext(opts = {}) {
  const resolved = resolveConnection(opts);
  const { token, source } = resolveApiKey();
  if (!token) missingApiKey();
  const requests = new Map();
  return {
    ...resolved, token, source,
    // `anthropic: false` drops the anthropic-version header. Sending it to a bare
    // `/v1/models` makes the hub answer with the Anthropic-shaped Claude pool
    // (28 claude rows, no capabilities, no native GPT models) instead of the
    // OpenAI-compatible listing — a header-driven shape switch, not an error.
    request(endpoint, { anthropic = true } = {}) {
      const key = `${anthropic ? 'a' : 'o'}:${endpoint}`;
      if (!requests.has(key)) requests.set(key, hubJson(resolved.hub, endpoint, token, source, anthropic));
      return requests.get(key);
    },
  };
}

async function hubJson(hub, endpoint, token, source, anthropic = true) {
  const headers = { Authorization: `Bearer ${token}`, 'x-opencodex-api-key': token, Accept: 'application/json' };
  if (anthropic) headers['anthropic-version'] = '2023-06-01';
  let res;
  try {
    res = await fetch(`${hub}${endpoint}`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    die(`Hub ${endpoint}: request failed (network, redirect, or 15s timeout)`);
  }
  if (!res.ok) {
    const detail = res.status === 401 ? 'Hub rejected the selected API key.'
      : res.status === 403 ? 'The selected API key has no access to this endpoint.' : 'Hub request failed.';
    die(`Hub ${endpoint}: HTTP ${res.status} — ${detail}\n  hub: ${hub}\n  key source: ${source} (value hidden)\n  ${res.status === 401 ? 'Check this key or update it with node ocx.mjs configure; lower-priority keys are not tried automatically.' : 'Check the Hub and selected key.'}`);
  }
  try { return await res.json(); } catch { die(`Hub ${endpoint}: invalid JSON`); }
}

// ---------------- claude settings.json env block ----------------

const CLAUDE_ENV_MARKER = '_ocx_export_managed';
const CLAUDE_LEGACY_ENV_MARKER = '__ managed by ocx-export \u2014 do not edit manually __';
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

async function claudeFetchHubCatalog(context) {
  const [cliBody, desktop] = await Promise.all([
    context.request('/v1/models?limit=1000&ids=cli'),
    context.request('/v1/models?ids=desktop&format=desktop-config'),
  ]);
  if (!Array.isArray(cliBody?.data)) die('Hub returned an invalid Claude CLI catalog');
  if (desktop?.version !== 1 || !Array.isArray(desktop.models)) die('Hub returned an unsupported Claude Desktop snapshot');
  const cliModels = cliBody.data.filter((m) => m && typeof m.id === 'string' && m.id)
    .map((m) => ({ id: m.id, display_name: typeof m.display_name === 'string' ? m.display_name : '' }));
  return { origin: context.hub, token: context.token, cliModels, desktop };
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

function claudeSettingsEnvApply(catalog) {
  const { slots, missing, remappedPinned } = claudeTierSlotsFromHub(catalog.cliModels, catalog.desktop);
  writeClaudeManagedEnv(catalog.origin, catalog.token, slots, catalog.desktop);
  const cache = writeClaudeGatewayCache(catalog.origin, catalog.cliModels, catalog.desktop);
  return { origin: catalog.origin, slots, missing, remappedPinned, cache, pickerCount: buildClaudePickerOptions(catalog.desktop).length };
}

// ---------------- grok hub config (~/.grok/config.toml) ----------------

const tomlString = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const grokAlias = (id) => `ocx-${String(id).replace(/[^A-Za-z0-9_-]/g, '-')}`;


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

function catalogReasoningEfforts(levels) {
  if (!Array.isArray(levels)) return { efforts: null, descriptions: {} };
  const seen = new Set();
  const out = [];
  const descriptions = {};
  for (const level of Array.isArray(levels) ? levels : []) {
    const effort = typeof level === 'string' ? level : level && level.effort;
    if (typeof effort !== 'string' || !effort || seen.has(effort)) continue;
    seen.add(effort);
    out.push(effort);
    const desc = typeof level === 'object' && level && typeof level.description === 'string' ? level.description.trim() : '';
    if (desc) descriptions[effort] = desc;
  }
  return { efforts: out, descriptions };
}



function readRootTomlKey(file, key) {
  if (!fs.existsSync(file)) return null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(new RegExp(`^${key}\\s*=\\s*"(.*)"\\s*$`, 'm'));
    return m ? m[1] : null;
  } catch { return null; }
}

function catalogInputModalities(row) {
  return Array.isArray(row.input_modalities)
    ? [...new Set(row.input_modalities.filter((value) => typeof value === 'string'))]
    : null;
}

function catalogTokenLimit(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function catalogIsCombo(row, id) {
  return row?.owned_by === 'combo' || id.startsWith('gldf-') || id.startsWith('combo/');
}

function catalogModelsFromData(data) {
  const rows = Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : [];
  const byAlias = new Map();
  for (const row of rows) {
    if (!row || (row.visibility ?? 'list') === 'hide') continue;
    const id = String(row.slug ?? row.id ?? '');
    if (!id) continue;
    const { efforts, descriptions } = catalogReasoningEfforts(row.supported_reasoning_levels);
    const summary = typeof row.default_reasoning_summary === 'string' ? row.default_reasoning_summary : '';
    byAlias.set(grokAlias(id), {
      id,
      name: typeof row.display_name === 'string' && row.display_name ? row.display_name : `OCX ${id}`,
      context: catalogTokenLimit(row.context_window)?.toString() ?? null,
      contextWindow: catalogTokenLimit(row.context_window),
      maxTokens: null,
      input: catalogInputModalities(row),
      reasoning: null,
      reasoningEfforts: efforts,
      reasoningDescriptions: descriptions,
      defaultReasoningEffort: typeof row.default_reasoning_level === 'string' ? row.default_reasoning_level : null,
      reasoningSummary: ['none', 'auto', 'concise', 'detailed'].includes(summary) ? summary : null,
      combo: catalogIsCombo(row, id),
    });
  }
  return [...byAlias.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}




// Per-effort aliases (`gpt-6.1-sol--high`): OMP picks effort per turn through
// the `judge` role, so a pinned-effort duplicate only adds picker noise.
const OMP_VARIANT_ID = /--(?:fast|minimal|low|medium|high|xhigh|max|ultra)$/;

// `claude-*` rows are Claude client aliases (family slots and gateway picker ids)
// owned by settings.json and the gateway model cache, not OMP providers. They leak
// in when the hub is queried with the anthropic-version header; grok filters the
// same prefix rather than trusting the listing.
const OMP_EXCLUDED_PREFIX = ['claude-'];

// The two endpoints disagree on routing separators for the same upstream model
// (`kilo/kilo-auto/free` vs `kilo/kilo-auto-free`), so dedupe on a separator-free
// key and keep the catalog slug, which is what the hub's own catalog advertises.
const ompModelKey = (id) => String(id).toLowerCase().replace(/\//g, '-');

function ompEffortList(values) {
  const allowed = new Set(OMP_REASONING_EFFORTS);
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || !allowed.has(value) || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

function ompDisplayName(row, fallback) {
  return typeof row?.display_name === 'string' && row.display_name ? row.display_name : fallback;
}

// OMP is fed from /v1/models — the gateway's own capability surface (real context
// window, output cap, reasoning tiers, `reasoning_effort` default) — plus catalog
// rows the Codex picker hides but the hub still routes (`gpt-6-sol`, `gpt-5.6-sol`,
// `gpt-5.6-luna`). /v1/catalog is Codex-shaped: it caps the gpt-5.6/6.x family at
// 272k while the gateway serves the full window, so it contributes ids, display
// names, and limits only for models /v1/models does not list at all.
function ompModelsFromHub(modelsData, catalogData) {
  const catalogRows = Array.isArray(catalogData?.models) ? catalogData.models : [];
  const catalogByKey = new Map();
  for (const row of catalogRows) {
    const slug = typeof row?.slug === 'string' ? row.slug : '';
    if (slug && !catalogByKey.has(ompModelKey(slug))) catalogByKey.set(ompModelKey(slug), row);
  }
  const byKey = new Map();
  for (const row of Array.isArray(modelsData?.data) ? modelsData.data : []) {
    const id = typeof row?.id === 'string' ? row.id : '';
    if (!id || OMP_VARIANT_ID.test(id) || OMP_EXCLUDED_PREFIX.some((prefix) => id.startsWith(prefix))) continue;
    const caps = row.capabilities && typeof row.capabilities === 'object' ? row.capabilities : {};
    const catalogRow = catalogByKey.get(ompModelKey(id));
    const effortRows = Array.isArray(row.reasoning_efforts) ? row.reasoning_efforts : [];
    const efforts = ompEffortList(effortRows.map((entry) => entry?.value));
    const flagged = effortRows.find((entry) => entry?.default === true)?.value;
    const preferred = typeof flagged === 'string' ? flagged : (typeof row.reasoning_effort === 'string' ? row.reasoning_effort : '');
    byKey.set(ompModelKey(id), {
      id: typeof catalogRow?.slug === 'string' && catalogRow.slug ? catalogRow.slug : id,
      name: ompDisplayName(catalogRow, id),
      contextWindow: catalogTokenLimit(caps.context_length) ?? catalogTokenLimit(catalogRow?.context_window),
      maxTokens: catalogTokenLimit(caps.max_output_tokens),
      input: catalogInputModalities(caps),
      reasoning: typeof caps.supports_reasoning === 'boolean' ? caps.supports_reasoning : null,
      reasoningEfforts: efforts,
      defaultReasoningEffort: efforts.includes(preferred) ? preferred : (efforts[0] ?? null),
    });
  }
  for (const row of catalogRows) {
    const slug = typeof row?.slug === 'string' ? row.slug : '';
    if (!slug || OMP_EXCLUDED_PREFIX.some((prefix) => slug.startsWith(prefix)) || byKey.has(ompModelKey(slug))) continue;
    const { efforts } = catalogReasoningEfforts(row.supported_reasoning_levels);
    const list = ompEffortList(efforts);
    const preferred = typeof row.default_reasoning_level === 'string' ? row.default_reasoning_level : '';
    byKey.set(ompModelKey(slug), {
      id: slug,
      name: ompDisplayName(row, slug),
      contextWindow: catalogTokenLimit(row.context_window),
      maxTokens: null,
      input: catalogInputModalities(row),
      reasoning: list.length ? true : null,
      reasoningEfforts: list,
      defaultReasoningEffort: list.includes(preferred) ? preferred : (list[0] ?? null),
    });
  }
  return [...byKey.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
  const ladder = defModel?.reasoning === false ? [] : (defModel?.reasoningEfforts || []).filter((effort) => GROK_REASONING_EFFORTS.includes(effort));
  const currentEffort = readTomlTableKey(text, 'models', 'default_reasoning_effort');
  const hubDefault = defModel?.defaultReasoningEffort;
  const removeKeys = [];
  if (currentEffort && ladder.includes(currentEffort)) {
    updates.default_reasoning_effort = tomlString(currentEffort);
  } else if (hubDefault && ladder.includes(hubDefault)) {
    updates.default_reasoning_effort = tomlString(hubDefault);
  } else {
    removeKeys.push('default_reasoning_effort');
  }
  return upsertTomlTableKeys(text, 'models', updates, removeKeys);
}


function buildGrokHubBlock(hub, token, models) {
  if (!token) missingApiKey();
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
    const efforts = model.reasoning === false ? [] : (model.reasoningEfforts || []).filter((effort) => GROK_REASONING_EFFORTS.includes(effort));
    if (efforts.length) {
      lines.push('supports_reasoning_effort = true');
      if (efforts.includes(model.defaultReasoningEffort)) {
        lines.push(`reasoning_effort = ${tomlString(model.defaultReasoningEffort)}`);
      }
      for (const effort of efforts) {
        const option = GROK_EFFORT_OPTIONS[effort];
        const description = (model.reasoningDescriptions && model.reasoningDescriptions[effort]) || option.description;
        lines.push(
          '',
          `[[model.${alias}.reasoning_efforts]]`,
          `id = ${tomlString(effort)}`,
          `value = ${tomlString(effort)}`,
          `label = ${tomlString(option.label)}`,
          `description = ${tomlString(description)}`,
        );
        if (efforts.includes(model.defaultReasoningEffort)) lines.push(`default = ${effort === model.defaultReasoningEffort}`);
      }
    }
  }
  lines.push('', GROK_END);
  return `${lines.join('\n')}\n`;
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


function buildOmpOcxProviderBlock(hub, token, models, api) {
  if (!token) missingApiKey();
  validateOmpApi(api);
  const lines = [
    `  ${OMP_PROVIDER}:`,
    `    baseUrl: ${yamlQuote(hubV1(hub))}`,
    `    apiKey: ${yamlQuote(token)}`,
    `    api: ${api}`,
    '    auth: apiKey',
    '    models:',
  ];
  for (const model of models) {
    const efforts = model.reasoning === false ? [] : ompEffortsFromModel(model);
    const input = model.input?.filter((modality) => ['text', 'image'].includes(modality));
    lines.push(`      - id: ${yamlQuote(model.id)}`);
    lines.push(`        name: ${yamlQuote(model.name || `OCX ${model.id}`)}`);
    if (model.reasoning !== null && model.reasoning !== undefined) lines.push(`        reasoning: ${model.reasoning}`);
    if (input) lines.push(`        input: [${input.join(', ')}]`);
    if (model.contextWindow !== null && model.contextWindow !== undefined) lines.push(`        contextWindow: ${model.contextWindow}`);
    if (model.maxTokens !== null && model.maxTokens !== undefined) lines.push(`        maxTokens: ${model.maxTokens}`);
    if (efforts.length) {
      const def = efforts.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : null;
      lines.push('        thinking:');
      lines.push('          mode: effort');
      lines.push(`          efforts: [${efforts.join(', ')}]`);
      if (def) lines.push(`          defaultLevel: ${def}`);
    }
  }
  return `${lines.join('\n')}\n`;
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



function writeCodexHubConfig(hub) {
  const configPath = codexConfigPath();
  let text = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  text = stripRootTomlKeys(text, ['openai_base_url', 'experimental_realtime_ws_base_url'], {
    onlyIf: (_key, value) => isLoopbackCodexOverride(value),
  });
  text = setRootTomlAssignment(text, 'model_provider', 'model_provider = "opencodex"');
  text = setRootTomlAssignment(text, 'model_catalog_json', `model_catalog_json = ${tomlString(catalogPathForCodex())}`);
  text = upsertTomlTableKeys(text, CODEX_PROVIDER_TABLE, {
    name: tomlString('OpenCodex Proxy'), base_url: tomlString(hubV1(hub)), wire_api: tomlString('responses'),
    requires_openai_auth: 'false', env_key: tomlString('OCX_API_TOKEN'),
  });
  stageFile(configPath, text);
  return { configPath, baseUrl: hubV1(hub) };
}

function warnCodexLaunchToken() {
  info('codex: env_key=OCX_API_TOKEN; the variable must be set in the environment that launches Codex.');
  if (String(process.env.OCX_API_TOKEN || '').trim()) return;
  const file = tokenFileForCodexLaunch();
  const command = IS_WIN
    ? `$env:OCX_API_TOKEN = (Get-Content -Raw -LiteralPath '${file.replace(/'/g, "''")}').Trim()`
    : `export OCX_API_TOKEN="$(cat -- ${shellQuote(file)})"`;
  info(`codex: load the key without printing it, then launch Codex in the same shell:\n  ${command}`);
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

async function readTokenInput(fromStdin) {
  if (fromStdin) {
    if (process.stdin.isTTY) die('--token-stdin requires piped or redirected input; use configure for a hidden prompt');
    let token = '';
    for await (const chunk of process.stdin) {
      token += chunk.toString('utf8');
      if (token.length > 16_384) die('API key input is too long');
    }
    return token.trim();
  }
  return new Promise((resolve) => {
    let token = '';
    let finished = false;
    const wasRaw = Boolean(process.stdin.isRaw);
    const finish = (value) => {
      if (finished) return;
      finished = true;
      process.stdin.removeListener('keypress', onKey);
      process.stdin.removeListener('end', onEnd);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stderr.write('\n');
      resolve(value);
    };
    const onKey = (text, key = {}) => {
      if (finished) return;
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) return finish(null);
      if (key.name === 'return' || key.name === 'enter') return finish(token.trim());
      if (key.name === 'backspace') token = token.slice(0, -1);
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) {
        token += text;
        if (token.length > 16_384) finish(null);
      }
    };
    const onEnd = () => finish(null);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', onKey);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
    process.stderr.write('Hub API key (hidden; Enter keeps the saved key): ');
  });
}

async function cmdConfigure(opts) {
  await withStateLock(async () => {
    const { hub, saved, ompApi } = resolveConnection(opts);
    const selectedApi = validateOmpApi(opts.ompApi === undefined ? ompApi : opts.ompApi);
    let token;
    if (opts.tokenStdin || process.stdin.isTTY) {
      token = await readTokenInput(opts.tokenStdin);
      if (token === null) die('Configuration cancelled; no changes made');
      if (opts.tokenStdin && !token) die('API key input is empty; no changes made');
      if (/[\x00-\x1f\x7f]/.test(token)) die('API key must be a single line without control characters');
    }
    const connection = { ...saved, hub, ompApi: selectedApi };
    const beforeConnection = fileSnapshot(connectionPath());
    const beforeKey = token ? fileSnapshot(keyFilePath()) : null;
    try {
      if (token) putSnapshot(keyFilePath(), { data: Buffer.from(`${token}\n`).toString('base64'), mode: 0o600 });
      writePrivateJson(connectionPath(), connection);
    } catch (err) {
      if (token) putSnapshot(keyFilePath(), beforeKey);
      putSnapshot(connectionPath(), beforeConnection);
      throw err;
    }
    info(`configured hub: ${hub}`);
    info(`omp-api: ${selectedApi}`);
    info(token ? 'API key saved privately; client files unchanged.' : 'API key unchanged; client files unchanged.');
  });
}



function managedClientActive(client) {
  return Object.values(loadJournal().files).some((entry) => entry.client === client);
}

function cmdStatus(opts) {
  const { hub, saved, ompApi } = resolveConnection(opts);
  write(`connection: ${saved.hub ? 'configured' : 'not configured'}`);
  write(`hub: ${hub}`);
  write(`omp-api: ${OMP_APIS.includes(ompApi) ? ompApi : 'invalid saved API; use configure --omp-api openai-responses|anthropic-messages'}`);
  for (const client of NATIVE_CLIENTS) {
    if (opts.client.length && !opts.client.includes(client)) continue;
    const files = client === 'codex' ? [codexConfigPath()]
      : client === 'claude' ? claudeHomes().map((home) => path.join(home, 'settings.json'))
        : client === 'claude-desktop' ? [path.join(DESKTOP_PROFILE_DIR(), '_meta.json')]
          : client === 'grok' ? grokHomes().map((home) => path.join(home, 'config.toml'))
            : ompHomes().map((home) => path.join(ompAgentDir(home), 'models.yml'));
    write(`client=${client} installed=${clientInstalled(client)} state=${managedClientActive(client) ? 'current' : 'absent'} files=${files.filter((file) => fs.existsSync(file)).join(',') || 'none'}`);
  }
  write('catalog: загружается по запросу из Hub (node ocx.mjs models)');
}

function printApplyReport(hub, source, files, clients, modelCounts) {
  info(`OCX configuration  |  applied`);
  info(`  Hub          ${hub}`);
  info(`  Key source   ${source} (value hidden)`);
  for (const client of clients) {
    const changes = files.filter((item) => item.client === client);
    info(`  ${CLIENT_META[client].title}  |  ${changes.length ? `${changes.length} file(s)` : 'no files changed'}${modelCounts[client] === undefined ? '' : `  |  ${modelCounts[client]} models`}`);
    for (const { file, state } of changes) info(`    ${state.padEnd(7)} ${file}`);
  }
  info(`  Log          ${logFilePath()}`);
}



async function cmdToggle(opts, enabled) {
  if (!opts.client.length) die('apply/restore require at least one --client');
  const unique = [...new Set(opts.client)];
  if (!unique.every((client) => NATIVE_CLIENTS.includes(client))) die('Unsupported client');
  let report;
  await withStateLock(async () => {
    if (!enabled) {
      restoreClients(unique);
      return;
    }
    const context = requestContext(opts);
    const { hub, token, ompApi } = context;
    info(`OCX configuration  |  checking Hub ${hub}`);
    info(`  Key source   ${context.source} (value hidden)`);
    if (unique.includes('omp')) validateOmpApi(ompApi);
    const common = unique.some((client) => ['codex', 'grok', 'omp'].includes(client)) ? await readHubCatalog(context) : null;
    if (unique.includes('codex') && (!Array.isArray(common.data?.models) || !common.data.models.length)) {
      die('Hub returned an invalid Codex catalog');
    }
    const claudeCatalog = unique.includes('claude') ? await claudeFetchHubCatalog(context) : null;
    const desktopSnapshot = unique.includes('claude-desktop')
      ? await context.request('/v1/models?ids=desktop&format=desktop-config') : null;
    if (desktopSnapshot && desktopSnapshot.version !== 1) die('Hub returned an unsupported Claude Desktop snapshot');
    const modelCounts = {};
    if (common) {
      if (unique.includes('codex')) modelCounts.codex = common.models.length;
      if (unique.includes('grok')) modelCounts.grok = common.models.filter((m) => !m.id.startsWith('claude-')).length;
    }
    if (claudeCatalog) modelCounts.claude = claudeCatalog.cliModels.length;
    if (desktopSnapshot) modelCounts['claude-desktop'] = desktopSnapshot.models.length;
    const journal = loadJournal();
    activeWrites = new Map();
    try {
      for (const client of unique) {
        activeClient = client;
        if (client === 'claude') {
          claudeSettingsEnvApply(claudeCatalog);
        } else if (client === 'codex') {
          stageFile(catalogPathForCodex(), `${JSON.stringify(common.data, null, 2)}\n`);
          writeCodexHubConfig(hub);
        } else if (client === 'claude-desktop') {
          writeClaudeDesktopHubProfile(hub, token, desktopSnapshot);
        } else if (client === 'grok') {
          writeGrokHubConfig(hub, token, common.models.filter((m) => !m.id.startsWith('claude-')));
        } else if (client === 'omp') {
          const homes = ompHomesForWrite();
          if (!homes.length) die(`Oh My Pi not installed; expected ${ompHome()} or omp on PATH`);
          const ompModels = ompModelsFromHub(await context.request('/v1/models', { anthropic: false }), common.data);
          if (!ompModels.length) die('Hub returned no usable models; refusing to write OMP configuration');
          modelCounts.omp = ompModels.length;
          for (const home of homes) {
            const dir = ompAgentDir(home);
            const modelFile = path.join(dir, 'models.yml');
            const before = fs.existsSync(modelFile) ? fs.readFileSync(modelFile, 'utf8') : '';
            stageFile(modelFile, upsertYamlMapChild(before, 'providers', OMP_PROVIDER, buildOmpOcxProviderBlock(hub, token, ompModels, ompApi)));
            const configFile = path.join(dir, 'config.yml');
            if (fs.existsSync(configFile)) {
              const old = fs.readFileSync(configFile, 'utf8');
              const next = yamlSeqRemoveItem(yamlSeqAddItem(old, 'enabledProviders', OMP_PROVIDER), 'disabledProviders', OMP_PROVIDER);
              if (next !== old) stageFile(configFile, next);
            }
          }
        }
      }
      const files = [...activeWrites].map(([file, change]) => ({
        file, client: change.client,
        state: !fs.existsSync(file) ? 'created' : sameSnapshot(fileSnapshot(file), change.after) ? 'same' : 'updated',
      }));
      await commitWrites(journal);
      report = { hub, source: context.source, files, modelCounts };
    } finally {
      activeWrites = null;
      activeClient = null;
    }
  });
  if (enabled) {
    printApplyReport(report.hub, report.source, report.files, unique, report.modelCounts);
    if (unique.includes('codex')) warnCodexLaunchToken();
  }
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
  const { hub, saved } = resolveConnection(opts);
  const connected = Boolean(saved.hub);
  const items = [];
  for (const id of NATIVE_CLIENTS) {
    const installed = clientInstalled(id);
    let note = 'не найден';
    let kind = 'missing';
    if (installed) {
      const active = managedClientActive(id);
      if (id === 'omp' && connected) {
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
  return { items, connection: connected ? 'connected' : 'not configured', hub, catalog: { count: 0, combos: [] } };
}

class Screen {
  constructor(stream) { this.stream = stream; this.lines = 0; }

  clear() {
    if (!this.lines) return;
    const s = this.stream;
    s.write(`\x1b[${this.lines - 1}A`);
    for (let i = 0; i < this.lines; i++) s.write(`\x1b[2K${i < this.lines - 1 ? '\x1b[1B' : ''}`);
    s.write('\x1b[1G');
    this.lines = 0;
  }

  render(frameLines) {
    this.clear();
    this.stream.write(frameLines.join('\n'));
    this.lines = frameLines.length;
  }
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
    write('No supported AI clients (codex, claude, claude-desktop, grok, omp) were detected on this machine.');
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
  die('Invalid client; choose codex, claude, claude-code, claude-desktop, grok, or omp');
  return null;
}

async function cmdModels(opts = {}) {
  const { models: rows } = await readHubCatalog(requestContext(opts));
  write(`catalog: ${rows.length} visible (GET /v1/catalog)`);
  write('legend: - unknown; [] explicit empty');
  const combos = rows.filter((m) => m.combo);
  if (combos.length) write(`combos: ${combos.map((m) => m.id).join(', ')}`);
  const list = (values) => values === null ? '-' : values.length ? values.join(',') : '[]';
  const reasoningCell = (value) => value === true ? 'true' : value === false ? 'false' : '-';
  const table = [['MODEL', 'CONTEXT', 'OUTPUT', 'INPUT', 'EFFORTS', 'DEFAULT', 'REASONING', 'KIND', 'NAME']];
  for (const m of rows) {
    const kind = m.combo ? 'combo' : (m.id.includes('/') ? 'routed' : 'native');
    table.push([
      m.id,
      String(m.contextWindow ?? '-'),
      String(m.maxTokens ?? '-'),
      list(m.input),
      list(m.reasoningEfforts),
      m.defaultReasoningEffort ?? '-',
      reasoningCell(m.reasoning),
      kind,
      m.name,
    ]);
  }
  const widths = table[0].map((_, index) => Math.max(...table.map((row) => visLen(row[index]))));
  for (const row of table) write(row.map((value, index) => index === row.length - 1 ? value : padVis(value, widths[index])).join('  '));
}

function parseArgs(argv) {
  const opts = {
    command: 'status',
    client: [],
  };
  let commandSeen = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!commandSeen && ['status', 'apply', 'restore', 'help', 'models', 'configure'].includes(arg)) {
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
      case '--omp-api': opts.ompApi = value(); break;
      case '--token-stdin': opts.tokenStdin = true; break;
      default:
        die('Unknown option or argument; run help. API keys are accepted only via hidden input, stdin, or environment.');
    }
    i += 1;
  }
  if (opts.command !== 'configure' && (opts.ompApi !== undefined || opts.tokenStdin)) {
    die('--omp-api and --token-stdin are configure-only options');
  }
  if (opts.command === 'configure' && opts.client.length) die('configure saves connection settings only; use apply --client separately');
  return opts;
}

function usage() {
  write(`Usage:
  node ocx.mjs             interactive Hub configurator in a TTY; read-only status otherwise
  node ocx.mjs configure [--hub URL] [--omp-api openai-responses|anthropic-messages] [--token-stdin]
  node ocx.mjs status [--hub URL] [--client codex|claude-code|claude|claude-desktop|grok|omp]
  node ocx.mjs models [--hub URL]
  node ocx.mjs apply --client <id> [--client <id> ...] [--hub URL]
  node ocx.mjs restore --client <id> [--client <id> ...]

configure uses hidden key input in a TTY; redirected keys require --token-stdin.
Without key input, the saved key is unchanged. Keys are never accepted as arguments.
OMP defaults to openai-responses; configure without --omp-api preserves the saved choice.
Use configure --omp-api anthropic-messages to select the Messages API explicitly.
Codex requires OCX_API_TOKEN in its launch environment (env_key); no OpenCodex binary is needed.
restore uses the existing byte-and-mode journal, without a key or network access.
apply shows manual changes against the journal and asks before continuing (CLI and menu).
Without an interactive terminal, manual changes abort apply; restore remains strict.
OMP imports base models and reasoning capabilities from /v1/models, enriched by /v1/catalog.
Claude client aliases and pinned --effort/--fast variants are excluded; judge settings are preserved.

Precedence:
  Hub: --hub > OCX_HUB > saved connection > https://ocx.goldfinches.ru
  Key: OCX_API_TOKEN > OCX_API_TOKEN_FILE > own state/api-key > ~/.opencodex/service-api-token
A missing, unreadable, or empty OCX_API_TOKEN_FILE is an error; other key files are not tried.
Otherwise a readable nonempty ~/.opencodex/service-api-token (or the Windows equivalent) is used
automatically: current-process home, then the Windows profile home on WSL/Linux; duplicate paths skipped.
configure saves the entered key only in own state/api-key and does not rewrite the OpenCodex token file.

Env:
  OCX_STATE_HOME=<path>   own connection, key and journal (default ~/.ocx-export)
  OCX_LOG_FILE=<path>     process log (default <state>/ocx-export.log)
  OCX_NONINTERACTIVE=1    force read-only status for bare invocation (CI)`);
}

async function main() {
  flog(`=== ocx.mjs platform=${process.platform}`);
  const noArgs = process.argv.length <= 2;
  const opts = parseArgs(process.argv.slice(2));
  switch (opts.command) {
    case 'help': usage(); return;
    case 'configure': await cmdConfigure(opts); return;
    case 'status':
      if (noArgs && isInteractive()) { await runInteractiveMenu(opts); return; }
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
  yamlSeqAddItem,
  yamlSeqRemoveItem,
  buildOmpOcxProviderBlock,
  ompModelsFromHub,
  ompHubPresent,
  catalogModelsFromData,
  sameSnapshot,
};
