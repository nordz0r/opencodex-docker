// End-to-end OMP configuration, drift protection and restore against a loopback hub.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ocx.mjs');
const catalog = { models: [
  { slug: 'gpt-6-luna', display_name: 'Luna', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
  { slug: 'gpt-6.1-sol', display_name: 'Sol' },
] };
let server;
let hub;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer test-token') { res.writeHead(401).end(); return; }
    if (req.url.startsWith('/v1/catalog')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(catalog)); return; }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: catalog.models.map((m) => ({ id: m.slug })) })); return; }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  hub = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocx-omp-'));
  // omp joins PI_CONFIG_DIR under HOME (even absolute values), so the sandbox
  // passes a RELATIVE dir: HOME=root + PI_CONFIG_DIR=.omp -> root/.omp/agent.
  const ompHome = path.join(root, '.omp');
  fs.mkdirSync(path.join(ompHome, 'agent'), { recursive: true });
  const env = {
    PATH: process.env.PATH, HOME: root, USERPROFILE: root,
    OCX_HUB: hub, OCX_API_TOKEN: 'test-token', OCX_NONINTERACTIVE: '1',
    OCX_STATE_HOME: path.join(root, '.ocx-export'), PI_CONFIG_DIR: '.omp',
    GROK_HOME: path.join(root, '.grok'), CODEX_HOME: path.join(root, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(root, '.claude'), OPENCODEX_HOME: path.join(root, '.opencodex'),
  };
  const config = path.join(ompHome, 'agent', 'config.yml');
  // Async spawn: the fake hub lives in this process, so the event loop must stay free.
  const run = (args, extra = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...extra } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  return { root, config, models: path.join(ompHome, 'agent', 'models.yml'), run };
}

test('apply preserves judge and other roles; restore returns original bytes', async () => {
  const { config, models, run } = sandbox();
  const original = 'modelRoles:\n  default: ocx/gpt-6.1-sol\n  judge: codiv/openjev-latest\nenabledProviders: [other]\n';
  fs.writeFileSync(config, original);
  const applied = await run(['apply', '--client', 'omp']);
  assert.equal(applied.status, 0, applied.stderr);
  const text = fs.readFileSync(config, 'utf8');
  assert.match(text, /judge: codiv\/openjev-latest/);
  assert.match(text, /default: ocx\/gpt-6\.1-sol/);
  assert.match(text, /enabledProviders: \[other, ocx\]/);
  assert.match(fs.readFileSync(models, 'utf8'), /api: openai-responses/);
  const restored = await run(['restore', '--client', 'omp']);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  assert.equal(fs.existsSync(models), false);
});

test('configure saves the OMP API without touching clients and preserves it on hub change', async () => {
  const { root, config, models, run } = sandbox();
  let result = await run(['configure', '--omp-api', 'anthropic-messages']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(config), false);
  assert.equal(fs.existsSync(models), false);
  result = await run(['configure', '--hub', hub]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.ocx-export', 'connection.json'))).ompApi, 'anthropic-messages');
  result = await run(['apply', '--client', 'omp']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(models, 'utf8'), /api: anthropic-messages/);
});

test('noninteractive apply and restore refuse manual drift without losing user edits', async () => {
  const { config, models, run } = sandbox();
  fs.writeFileSync(config, 'enabledProviders: [other]\n');
  const applied = await run(['apply', '--client', 'omp']);
  assert.equal(applied.status, 0, applied.stderr);
  const originalConfig = fs.readFileSync(config, 'utf8');
  const edited = fs.readFileSync(models, 'utf8') + '# manual change\n';
  fs.writeFileSync(models, edited);
  for (const command of ['apply', 'restore']) {
    const result = await run([command, '--client', 'omp']);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(config, 'utf8'), originalConfig);
    assert.equal(fs.readFileSync(models, 'utf8'), edited);
  }
});

test('unreadable explicit key never falls back to a saved key', async () => {
  const { root, config, run } = sandbox();
  const state = path.join(root, '.ocx-export');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'api-key'), 'test-token\n');
  const result = await run(['apply', '--client', 'omp'], {
    OCX_API_TOKEN: '', OCX_API_TOKEN_FILE: path.join(root, 'missing-key'),
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(config), false);
});
