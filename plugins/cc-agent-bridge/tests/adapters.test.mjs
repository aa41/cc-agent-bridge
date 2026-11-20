import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import codex from '../skills/delegate/scripts/lib/adapters/codex.mjs';
import dsh from '../skills/delegate/scripts/lib/adapters/dsh.mjs';
import { composePrompt, parseReport } from '../skills/delegate/scripts/lib/report.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function replay(adapter, name) {
  const state = adapter.initState();
  for (const line of fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter(Boolean)) {
    adapter.onEvent(state, JSON.parse(line));
  }
  return state;
}

test('codex: real write run parses session, usage and non-fatal warnings', () => {
  const s = replay(codex, 'codex-write-success.jsonl');
  assert.equal(s.sessionId, '01a1f457-3af5-7740-8a9f-5a8928b170d7');
  assert.equal(s.turnCompleted, true);
  assert.equal(s.warnings.length, 2, 'duplicate config warnings are collapsed');
  assert.deepEqual(codex.outcome(s, 0), { ok: true, warnings: [] });
  assert.equal(codex.usage(s).input_tokens, 65386);
});

test('codex: resumed run keeps the same thread id', () => {
  const s = replay(codex, 'codex-resume-success.jsonl');
  assert.equal(s.sessionId, '01a1f457-3af5-7740-8a9f-5a8928b170d7');
  assert.equal(codex.outcome(s, 0).ok, true);
});

test('codex: turn.failed and non-zero exits are failures', () => {
  const s = codex.initState();
  codex.onEvent(s, { type: 'thread.started', thread_id: 't' });
  codex.onEvent(s, { type: 'turn.failed', error: { message: 'quota exceeded' } });
  assert.deepEqual(codex.outcome(s, 1), { ok: false, error: 'quota exceeded' });
  assert.equal(codex.outcome(codex.initState(), 1).ok, false);
});

test('codex: argv for first run and resume', () => {
  const ctx = { mode: 'write', workdir: '/w', lastMessagePath: '/l', schemaPath: '/s', sessionId: 'abc', model: 'm1', effort: 'high' };
  const first = codex.buildArgv(ctx);
  assert.deepEqual(first.slice(0, 2), ['exec', '--json']);
  assert.ok(first.includes('-C') && first.includes('workspace-write'));
  assert.equal(first.at(-1), '-');
  const resume = codex.resumeArgv(ctx);
  assert.deepEqual(resume.slice(0, 3), ['exec', 'resume', 'abc']);
  assert.ok(!resume.includes('-C') && !resume.includes('-s'), 'exec resume accepts neither -C nor -s');
  assert.ok(resume.includes('sandbox_mode="workspace-write"'));
});

test('dsh: real write run parses session, usage and the json report block', () => {
  const s = replay(dsh, 'dsh-write-success.jsonl');
  assert.equal(s.sessionId, 'session-7952ef2c-dcf1-42e3-8d5b-ebbd1a36b495');
  assert.equal(dsh.outcome(s, 0).ok, true);
  assert.ok(dsh.usage(s).output_tokens > 0);
  const { parsed, report } = dsh.report(s);
  assert.equal(parsed, true);
  assert.equal(report.status, 'done');
  assert.equal(report.tests[0].passed, true);
});

test('dsh: wrong-cwd resume error is a failure with the message', () => {
  const s = replay(dsh, 'dsh-resume-wrong-cwd.jsonl');
  const out = dsh.outcome(s, 1);
  assert.equal(out.ok, false);
  assert.match(out.error, /was recorded in/);
});

test('dsh: final with non-completed reason is a failure even on exit 0', () => {
  const s = dsh.initState();
  dsh.onEvent(s, { type: 'final', sessionId: 'x', reason: { kind: 'aborted' }, text: '' });
  assert.equal(dsh.outcome(s, 0).ok, false);
});

test('dsh: model patch and argv', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'ccab-'));
  const ctx = { mode: 'read', model: 'deepseek-v4-pro', effort: 'xhigh', modelPatchFile: path.join(dir, 'm.yml'), sessionId: 's1' };
  ctx.modelPatchPath = dsh.prepare(ctx);
  assert.match(fs.readFileSync(ctx.modelPatchPath, 'utf8'), /model: deepseek-v4-pro, reasoningEffort: max/);
  const argv = dsh.buildArgv(ctx);
  assert.deepEqual(argv.slice(0, 4), ['--profile', 'headless', '--patch', ctx.modelPatchPath]);
  assert.ok(argv.includes('read-only') && argv.includes('never'));
  assert.deepEqual(dsh.resumeArgv(ctx).slice(-3), ['--session-id', 's1', '-']);
  assert.throws(() => dsh.validate({ model: 'x; rm -rf /' }));
  assert.equal(dsh.prepare({}), null);
});

test('parseReport: plain json, fenced block, garbage', () => {
  assert.equal(parseReport('{"status":"done","summary":"ok","changes":[],"tests":[],"open_questions":[],"next_steps":[]}').report.status, 'done');
  const fenced = parseReport('did things\n```json\n{"status":"blocked","summary":"need key"}\n```');
  assert.equal(fenced.parsed, true);
  assert.equal(fenced.report.status, 'blocked');
  assert.deepEqual(fenced.report.tests, []);
  const bad = parseReport('no json here');
  assert.equal(bad.parsed, false);
  assert.equal(bad.report.status, 'unknown');
  assert.equal(parseReport('').parsed, false);
});

test('composePrompt: read-only rule and follow-up framing', () => {
  const p1 = composePrompt({ brief: 'Do X', mode: 'read', structured: false, round: 1 });
  assert.match(p1, /READ-ONLY/);
  assert.match(p1, /fenced ```json block/);
  const p2 = composePrompt({ brief: 'Fix Y', mode: 'write', structured: true, round: 2 });
  assert.match(p2, /round 2/);
  assert.doesNotMatch(p2, /READ-ONLY/);
});
