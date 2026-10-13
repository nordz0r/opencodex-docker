// apply/restore --client grok against a fake loopback hub (regression: grokHomesForWrite was undefined).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ocx.mjs');
const catalog = { models: [{ slug: 'gpt-6-luna', display_name: 'Luna', supported_reasoning_levels: [{ effort: 'low' }] }] };
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocx-grok-'));
  const grokHome = path.join(root, '.grok');
  const env = {
    PATH: path.join(root, 'empty-bin'), HOME: root, USERPROFILE: root,
    OCX_HUB: hub, OCX_API_TOKEN: 'test-token', OCX_NONINTERACTIVE: '1',
    OCX_STATE_HOME: path.join(root, '.ocx-export'), GROK_HOME: grokHome,
    OPENCODEX_HOME: path.join(root, '.opencodex'),
  };
  // Async spawn: the fake hub lives in this process, so the event loop must stay free.
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  return { grokHome, config: path.join(grokHome, 'config.toml'), run };
}

test('apply --client grok writes the managed block, restore removes it', async () => {
  const { grokHome, config, run } = sandbox();
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(config, 'theme = "dark"\n');
  const r = await run(['apply', '--client', 'grok']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /ReferenceError/);
  const text = fs.readFileSync(config, 'utf8');
  assert.match(text, /theme = "dark"/);
  assert.match(text, /opencodex/);
  assert.match(text, /gpt-6-luna/);
  const back = await run(['restore', '--client', 'grok']);
  assert.equal(back.status, 0, back.stderr);
  assert.equal(fs.readFileSync(config, 'utf8'), 'theme = "dark"\n');
});

test('apply --client grok without a grok home or binary fails cleanly', async () => {
  const { run } = sandbox();
  const r = await run(['apply', '--client', 'grok']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Grok Build not installed/);
  assert.doesNotMatch(r.stderr, /ReferenceError/);
});
