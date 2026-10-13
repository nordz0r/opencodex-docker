import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOmpJudge, applyOmpJudge, ompJudgeFromConfig } from '../bin/ocx.mjs';

const models = [{ id: 'gpt-6-luna' }, { id: 'gpt-6.1-sol' }, { id: 'google-antigravity/gemini-3.8-flash' }];

test('bare hub id gets ocx/ prefix and keeps effort suffix', () => {
  assert.equal(resolveOmpJudge('gpt-6-luna:low', models).selector, 'ocx/gpt-6-luna:low');
  assert.equal(resolveOmpJudge('google-antigravity/gemini-3.8-flash', models).selector, 'ocx/google-antigravity/gemini-3.8-flash');
});

test('ocx/ selector is validated against the catalog', () => {
  assert.equal(resolveOmpJudge('ocx/gpt-6.1-sol:high', models).selector, 'ocx/gpt-6.1-sol:high');
  assert.throws(() => resolveOmpJudge('ocx/missing', models));
});

test('foreign provider selectors pass through, junk is rejected', () => {
  const j = resolveOmpJudge('codiv/openjev-latest', models);
  assert.equal(j.selector, 'codiv/openjev-latest');
  assert.equal(j.viaHub, false);
  assert.throws(() => resolveOmpJudge('nosuchmodel', models));
  assert.throws(() => resolveOmpJudge('a b/c', models));
});

test('empty means untouched, auto means reset', () => {
  assert.equal(resolveOmpJudge('', models), null);
  assert.equal(resolveOmpJudge(null, models), null);
  assert.equal(resolveOmpJudge('auto', models).reset, true);
});

test('apply sets, replaces and removes modelRoles.judge without touching other roles', () => {
  const base = 'modelRoles:\n  default: ocx/gpt-6.1-sol\n  judge: codiv/openjev-latest\ntheme: dark\n';
  const set = applyOmpJudge(base, { selector: 'ocx/gpt-6-luna:low' });
  assert.equal(set, 'modelRoles:\n  default: ocx/gpt-6.1-sol\n  judge: "ocx/gpt-6-luna:low"\ntheme: dark\n');
  assert.equal(ompJudgeFromConfig(set), 'ocx/gpt-6-luna:low');
  const reset = applyOmpJudge(set, { reset: true });
  assert.equal(ompJudgeFromConfig(reset), null);
  assert.match(reset, /default: ocx\/gpt-6\.1-sol/);
  assert.equal(applyOmpJudge(base, null), base);
});

test('apply creates modelRoles when missing', () => {
  const out = applyOmpJudge('theme: dark\n', { selector: 'ocx/gpt-6-luna:low' });
  assert.equal(ompJudgeFromConfig(out), 'ocx/gpt-6-luna:low');
  assert.equal(ompJudgeFromConfig('theme: dark\n'), null);
});

// die() sets process.exitCode for the CLI; expected failures above must not fail the run.
after(() => { process.exitCode = 0; });
