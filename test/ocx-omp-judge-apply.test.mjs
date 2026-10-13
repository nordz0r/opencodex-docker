// End-to-end apply/restore of the omp judge role against a fake loopback hub.
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
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  hub = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocx-judge-'));
  const ompHome = path.join(root, '.omp');
  fs.mkdirSync(path.join(ompHome, 'agent'), { recursive: true });
  const env = {
    PATH: process.env.PATH, HOME: root, USERPROFILE: root,
    OCX_HUB: hub, OCX_API_TOKEN: 'test-token', OCX_NONINTERACTIVE: '1',
    OCX_STATE_HOME: path.join(root, '.ocx-export'), OMP_HOME: ompHome,
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
  return { root, config, run };
}

const judgeOf = (file) => (fs.readFileSync(file, 'utf8').match(/^  judge:\s*(.*)$/m) || [])[1] ?? null;

test('apply --omp-judge writes modelRoles.judge, restore puts the file back', async () => {
  const { config, run } = sandbox();
  const original = 'modelRoles:\n  default: ocx/gpt-6.1-sol\n  judge: codiv/openjev-latest\nenabledProviders: [ocx]\n';
  fs.writeFileSync(config, original);
  let r = await run(['apply', '--client', 'omp', '--omp-judge', 'gpt-6-luna:low']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(judgeOf(config), '"ocx/gpt-6-luna:low"');
  assert.match(fs.readFileSync(config, 'utf8'), /default: ocx\/gpt-6\.1-sol/);
  r = await run(['status', '--client', 'omp']);
  assert.match(r.stdout, /client=omp judge=ocx\/gpt-6-luna:low/);
  r = await run(['restore', '--client', 'omp']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
});

test('apply without --omp-judge keeps an existing judge', async () => {
  const { config, run } = sandbox();
  fs.writeFileSync(config, 'modelRoles:\n  judge: codiv/openjev-latest\n');
  const r = await run(['apply', '--client', 'omp']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(judgeOf(config), 'codiv/openjev-latest');
});

test('OCX_OMP_JUDGE env is used for omp and validated before any write', async () => {
  const { config, run } = sandbox();
  fs.writeFileSync(config, 'theme: dark\n');
  let r = await run(['apply', '--client', 'omp'], { OCX_OMP_JUDGE: 'ocx/missing' });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(config, 'utf8'), 'theme: dark\n');
  r = await run(['apply', '--client', 'omp'], { OCX_OMP_JUDGE: 'auto' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(judgeOf(config), null);
  r = await run(['apply', '--client', 'omp'], { OCX_OMP_JUDGE: 'gpt-6.1-sol' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(judgeOf(config), '"ocx/gpt-6.1-sol"');
});

test('OCX_OMP_JUDGE env is silently ignored for non-omp clients', async () => {
  const { root, config, run } = sandbox();
  fs.writeFileSync(config, 'theme: dark\n');
  const r = await run(['apply', '--client', 'codex'], { OCX_OMP_JUDGE: 'gpt-6-luna:low' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /omp-judge/);
  assert.equal(fs.readFileSync(config, 'utf8'), 'theme: dark\n');
});

test('explicit --omp-judge without --client omp is an error', async () => {
  const { root, run } = sandbox();
  const r = await run(['apply', '--client', 'codex', '--omp-judge', 'gpt-6-luna:low']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--omp-judge requires --client omp/);
  assert.equal(fs.existsSync(path.join(root, '.codex', 'config.toml')), false);
});

test('config.yml created from scratch enables ocx alongside the judge', async () => {
  const { config, run } = sandbox();
  assert.equal(fs.existsSync(config), false);
  const r = await run(['apply', '--client', 'omp', '--omp-judge', 'gpt-6-luna:low']);
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(config, 'utf8');
  assert.match(text, /^enabledProviders: \[ocx\]$/m);
  assert.equal(judgeOf(config), '"ocx/gpt-6-luna:low"');
  const back = await run(['restore', '--client', 'omp']);
  assert.equal(back.status, 0, back.stderr);
  assert.equal(fs.existsSync(config), false);
});
