import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, '..', 'skills', 'delegate', 'scripts', 'bridge.mjs');
const FAKE = path.join(HERE, 'fake-bin', 'fake-agent.mjs');
fs.chmodSync(FAKE, 0o755);

const REPORT = { status: 'done', summary: 'implemented', changes: [{ path: 'a.txt', what: 'edit' }], tests: [{ command: 'node --test', passed: true, note: '' }], open_questions: [], next_steps: [] };

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ccab-test-'));
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'original\n');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return dir;
}

function fixture(dir, name, events) {
  const file = path.join(dir, '..', `${path.basename(dir)}-${name}.jsonl`);
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

function codexEvents(report = REPORT) {
  return [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'item.completed', item: { id: 'i0', type: 'error', message: 'deprecated config key ignored' } },
    { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: JSON.stringify(report) } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 5 } },
  ];
}

function dshEvents(report = REPORT) {
  return [
    { type: 'session', sessionId: 'session-1' },
    { type: 'status', phase: 'step_end', usage: { inputTokens: 50, outputTokens: 7, cacheReadTokens: 3 } },
    { type: 'final', sessionId: 'session-1', reason: { kind: 'completed' }, text: `done\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`` },
  ];
}

function bridge(cwd, args, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CC_AGENT_BRIDGE_') && !k.startsWith('FAKE_')));
  const r = spawnSync(process.execPath, [BRIDGE, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...clean, CC_AGENT_BRIDGE_CODEX_BIN: FAKE, CC_AGENT_BRIDGE_DSH_BIN: FAKE, CLAUDECODE: '1', DEEPSEEK_API_KEY: 'sk-test', ...env },
    timeout: 60_000,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function logOf(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('write run in a worktree: diff, isolation, env hygiene, then apply', () => {
  const repo = makeRepo();
  const log = path.join(repo, '..', `${path.basename(repo)}-log.jsonl`);
  const r = bridge(repo, ['run', '--to', 'codex', '--mode', 'write', '--message', 'change a.txt'], {
    FAKE_FIXTURE: fixture(repo, 'ev', codexEvents()),
    FAKE_EDIT: 'a.txt=changed by worker\n;new.txt=hello\n',
    FAKE_LOG: log,
  });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.status, 'completed');
  assert.equal(r.json.session_id, 'thread-1');
  assert.deepEqual(r.json.touched_files.sort(), ['a.txt', 'new.txt']);
  assert.equal(r.json.report.status, 'done');
  assert.equal(r.json.warnings[0], 'deprecated config key ignored');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'original\n', 'main checkout untouched before apply');

  const call = logOf(log)[0];
  assert.match(call.cwd, /\.cc-agent-bridge\/worktrees\//);
  assert.equal(call.depth, '1');
  assert.equal(call.claudecode, null, 'CLAUDECODE is scrubbed');
  assert.equal(call.deepseekKey, null, 'codex never sees the DeepSeek key');
  assert.match(call.stdin, /Rules from cc-agent-bridge/);
  assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /\/\.cc-agent-bridge\//);

  const a = bridge(repo, ['apply', r.json.run_id]);
  assert.equal(a.code, 0, a.stdout);
  assert.equal(a.json.applied, true);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'changed by worker\n');
  assert.equal(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8'), 'hello\n');
  assert.equal(fs.existsSync(path.join(repo, '.cc-agent-bridge', 'worktrees', r.json.run_id)), false);
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout;
  assert.match(status, /a\.txt/);
  assert.doesNotMatch(status, /cc-agent-bridge/);
  assert.equal(bridge(repo, ['apply', r.json.run_id]).code, 3, 'second apply is refused');
});

test('uncommitted work is carried into the worktree but not into the diff', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'user wip\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'user file\n');
  const log = path.join(repo, '..', `${path.basename(repo)}-log.jsonl`);
  const r = bridge(repo, ['run', '--to', 'codex', '--mode', 'write', '--message', 'x'], {
    FAKE_FIXTURE: fixture(repo, 'ev', codexEvents()),
    FAKE_READ: 'untracked.txt',
    FAKE_EDIT: 'b.txt=worker\n',
    FAKE_LOG: log,
  });
  assert.equal(r.json.status, 'completed', r.stdout);
  assert.equal(logOf(log)[0].seen, 'user file\n');
  assert.deepEqual(r.json.touched_files, ['b.txt']);
  assert.equal(bridge(repo, ['apply', r.json.run_id]).json.applied, true);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'user wip\n');
});

test('deepseek read-only run is in place, gets the key, parses the fenced report', () => {
  const repo = makeRepo();
  const log = path.join(repo, '..', `${path.basename(repo)}-log.jsonl`);
  const r = bridge(repo, ['run', '--to', 'deepseek', '--message', 'review', '--model', 'deepseek-v4-pro'], {
    FAKE_FIXTURE: fixture(repo, 'ev', dshEvents()),
    FAKE_LOG: log,
  });
  assert.equal(r.json.status, 'completed', r.stdout);
  assert.equal(r.json.mode, 'read');
  assert.equal(r.json.report.status, 'done');
  assert.equal(r.json.usage.output_tokens, 7);
  const call = logOf(log)[0];
  assert.equal(call.cwd, repo);
  assert.equal(call.deepseekKey, 'sk-test');
  assert.ok(call.argv.includes('read-only') && call.argv.includes('--patch'));
});

test('timeout and stall are detected and the worker is killed', () => {
  const repo = makeRepo();
  const t = bridge(repo, ['run', '--to', 'codex', '--message', 'x', '--timeout', '2'], {
    FAKE_FIXTURE: fixture(repo, 'ev', [{ type: 'thread.started', thread_id: 't' }]),
    FAKE_SLEEP: '30',
  });
  assert.equal(t.json.status, 'timeout', t.stdout);
  assert.equal(t.code, 124);
  const s = bridge(repo, ['run', '--to', 'deepseek', '--message', 'x', '--idle-timeout', '2'], {
    FAKE_FIXTURE: fixture(repo, 'ev2', [{ type: 'session', sessionId: 's' }]),
    FAKE_SLEEP: '30',
  });
  assert.equal(s.json.status, 'stalled', s.stdout);
  assert.equal(s.json.session_id, 's');
});

test('failures carry the stderr tail; nested delegation and full mode are refused', () => {
  const repo = makeRepo();
  const f = bridge(repo, ['run', '--to', 'codex', '--message', 'x'], {
    FAKE_FIXTURE: fixture(repo, 'ev', [{ type: 'turn.failed', error: { message: 'unauthorized' } }]),
    FAKE_STDERR: 'auth error: please login',
    FAKE_EXIT: '1',
  });
  assert.equal(f.json.status, 'failed');
  assert.match(f.json.error, /unauthorized[\s\S]*please login/);

  const nested = bridge(repo, ['run', '--to', 'codex', '--message', 'x'], { CC_AGENT_BRIDGE_DEPTH: '1' });
  assert.equal(nested.code, 3);
  assert.equal(nested.json.status, 'refused');

  const full = bridge(repo, ['run', '--to', 'codex', '--mode', 'full', '--message', 'x']);
  assert.equal(full.json.status, 'refused');
  assert.equal(bridge(repo, ['run', '--to', 'codex', '--mode', 'full', '--i-am-in-a-sandbox', '--message', 'x']).json.status, 'refused');
});

test('background run, wait, resume with the session id, cancel', () => {
  const repo = makeRepo();
  const log = path.join(repo, '..', `${path.basename(repo)}-log.jsonl`);
  const env = { FAKE_FIXTURE: fixture(repo, 'ev', codexEvents()), FAKE_EDIT: 'a.txt=v1\n', FAKE_LOG: log, FAKE_SLEEP: '1' };
  const start = bridge(repo, ['run', '--to', 'codex', '--mode', 'write', '--message', 'x', '--background'], env);
  assert.equal(start.json.status, 'running', start.stdout);
  const id = start.json.run_id;
  const w = bridge(repo, ['wait', id, '--timeout', '30']);
  assert.equal(w.json.done, true, w.stdout);
  assert.equal(w.json.status, 'completed');

  const r2 = bridge(repo, ['resume', id, '--message', 'please also add c.txt'], { ...env, FAKE_EDIT: 'c.txt=v2\n', FAKE_SLEEP: '0' });
  assert.equal(r2.json.status, 'completed', r2.stdout);
  assert.equal(r2.json.rounds, 2);
  assert.deepEqual(r2.json.touched_files.sort(), ['a.txt', 'c.txt'], 'diff is cumulative across rounds');
  const calls = logOf(log);
  assert.deepEqual(calls[1].argv.slice(0, 3), ['exec', 'resume', 'thread-1']);
  assert.match(calls[1].stdin, /Follow-up from the reviewer \(round 2\)/);

  const slow = bridge(repo, ['run', '--to', 'codex', '--message', 'x', '--background'], { ...env, FAKE_SLEEP: '60' });
  for (let i = 0; i < 50 && bridge(repo, ['status', slow.json.run_id]).json.status !== 'running'; i++) spawnSync('sleep', ['0.1']);
  const c = bridge(repo, ['cancel', slow.json.run_id]);
  assert.equal(c.json.status, 'cancelled', c.stdout);
  assert.equal(bridge(repo, ['list']).json.runs.length, 2);
  assert.equal(bridge(repo, ['clean', '--all']).json.removed.length, 2);
});

test('non-git directory: write needs --isolation inplace', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ccab-nogit-'));
  const r = bridge(dir, ['run', '--to', 'codex', '--mode', 'write', '--message', 'x']);
  assert.equal(r.code, 2);
  assert.match(r.json.hint, /--isolation inplace/);
  const ok = bridge(dir, ['run', '--to', 'codex', '--mode', 'write', '--isolation', 'inplace', '--message', 'x'], {
    FAKE_FIXTURE: fixture(dir, 'ev', codexEvents()),
  });
  assert.equal(ok.json.status, 'completed', ok.stdout);
  assert.equal(ok.json.diff_stat, null);
});
