import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import codex from './adapters/codex.mjs';
import dsh from './adapters/dsh.mjs';
import { checkDepth, workerEnv } from './guard.mjs';
import { applyPatch, createWorktree, diffTrees, ensureExcluded, git, hasHead, projectRoot, removeWorktree, snapshotTree } from './git.mjs';
import { composePrompt } from './report.mjs';
import { binVersion, findBin, nodeVersionIn } from './resolve.mjs';
import { killTree, runWorker } from './runner.mjs';
import { activeRuns, findRun, listRuns, loadMeta, reconcile, runPaths, runsDir, saveMeta, updateMeta } from './store.mjs';
import {
  BRIDGE_ENTRY, BRIDGE_VERSION, BridgeError, SKILL_DIR, STATE_DIR_NAME, TERMINAL,
  compareVersions, homeDir, inContainer, isPidAlive, isoNow, newRunId, readJson, run, sleep, truncate, writeJson,
} from './util.mjs';

const ADAPTERS = { codex, dsh };
const TO_ALIASES = { codex: 'codex', deepseek: 'dsh', dsh: 'dsh', 'deepseek-harness': 'dsh' };
const PUBLIC_NAME = { codex: 'codex', dsh: 'deepseek' };
const SCHEMA_PATH = path.join(SKILL_DIR, 'schemas', 'worker-report.schema.json');
const CMD = `node ${BRIDGE_ENTRY}`;
// Hints use the short name; SKILL.md tells Claude the full command prefix.
const B = 'bridge';
const BOOL_FLAGS = new Set(['background', 'force', 'keep-worktree', 'full', 'diff', 'all', 'i-am-in-a-sandbox', '3way', 'help']);
const EXIT = { completed: 0, failed: 1, refused: 3, timeout: 124, stalled: 125, cancelled: 130 };

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      if (BOOL_FLAGS.has(key)) {
        out[key] = true;
        continue;
      }
      if (argv[i + 1] === undefined) throw new BridgeError(`Missing value for --${key}`);
      out[key] = argv[++i];
    } else if (a === '-m') {
      out.message = argv[++i];
    } else {
      out._.push(a);
    }
  }
  return out;
}

function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new BridgeError(`Expected a positive number, got: ${value}`);
  return n;
}

// Never read stdin implicitly: inside an agent's shell it can be a pipe that never closes.
function readBrief(args) {
  let text = '';
  if (args.brief === '-') text = fs.readFileSync(0, 'utf8');
  else if (args.brief) text = fs.readFileSync(path.resolve(args.brief), 'utf8');
  else if (args.message) text = args.message;
  if (!text.trim()) throw new BridgeError('Empty task.', { hint: 'Pass --brief <file> (or --brief - for stdin) or --message "<task>".' });
  return text;
}

function rootFor(args) {
  return projectRoot(path.resolve(args.cwd ?? process.cwd())).root;
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function sumUsage(rounds) {
  const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  for (const r of rounds) for (const k of Object.keys(total)) total[k] += r.usage?.[k] ?? 0;
  return total;
}

function tail(file, n) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text.length > n ? text.slice(-n) : text;
  } catch {
    return '';
  }
}

function nextHint(result) {
  if (result.status !== 'completed') {
    return result.session_id
      ? `Inspect paths.log / paths.events, then retry with: ${B} resume ${result.run_id} --brief <fix.md>`
      : `Inspect paths.log, fix the cause, and start a new run.`;
  }
  if (result.isolation === 'worktree') {
    return `Review: read the diff (${B} result ${result.run_id} --diff), run the checks inside workdir, then ${B} apply ${result.run_id} — or ${B} resume ${result.run_id} --brief <review.md>.`;
  }
  return result.mode === 'read' ? 'Read-only run: use the report.' : 'Changes were made in place: review with git diff.';
}

function rel(root, p) {
  return p && root ? path.relative(root, p) || '.' : p;
}

export function summarize(result) {
  const r = result.worker_report ?? {};
  const paths = Object.fromEntries(Object.entries(result.paths ?? {}).map(([k, v]) => [k, rel(result.root, v)]));
  return {
    ok: result.status === 'completed',
    run_id: result.run_id,
    to: result.to,
    mode: result.mode,
    status: result.status,
    error: result.error ? truncate(result.error, 800) : undefined,
    session_id: result.session_id,
    rounds: result.rounds,
    report: {
      status: r.status,
      summary: truncate(r.summary ?? '', 1200),
      tests: (r.tests ?? []).slice(0, 10).map((t) => ({ command: truncate(t.command, 160), passed: t.passed })),
      open_questions: (r.open_questions ?? []).slice(0, 5).map((q) => truncate(q, 300)),
    },
    touched_files: (result.touched_files ?? []).slice(0, 40),
    more_files: Math.max(0, (result.touched_files?.length ?? 0) - 40) || undefined,
    diff_stat: result.diff_stat,
    usage: result.usage,
    duration_s: result.duration_s,
    warnings: (result.warnings ?? []).slice(0, 3).map((w) => truncate(w, 160)),
    root: result.root,
    workdir: rel(result.root, result.workdir),
    paths,
    next: nextHint(result),
  };
}

// ---------------------------------------------------------------- run lifecycle

function prepareRound(runDir, n, brief) {
  const meta = loadMeta(runDir);
  const p = runPaths(runDir, n);
  fs.mkdirSync(p.roundDir, { recursive: true });
  const adapter = ADAPTERS[meta.to];
  fs.writeFileSync(p.prompt, composePrompt({ brief, mode: meta.mode, structured: adapter.structuredOutput, round: n }));
  meta.round = n;
  meta.status = 'queued';
  meta.error = null;
  meta.cancel_requested = false;
  meta.queued_at = isoNow();
  saveMeta(runDir, meta);
}

async function launch(runDir, n, background) {
  const meta = loadMeta(runDir);
  if (background) {
    const log = fs.openSync(runPaths(runDir, n).runnerLog, 'a');
    const child = spawn(process.execPath, [BRIDGE_ENTRY, '_exec', runDir, String(n)], {
      detached: true,
      stdio: ['ignore', log, log],
      cwd: meta.root,
      env: process.env,
      windowsHide: true,
    });
    child.unref();
    fs.closeSync(log);
    return {
      exitCode: 0,
      out: {
        ok: true,
        run_id: meta.run_id,
        to: PUBLIC_NAME[meta.to],
        mode: meta.mode,
        status: 'running',
        round: n,
        workdir: meta.workdir,
        next: `${B} wait ${meta.run_id}   (repeat until "done": true)`,
      },
    };
  }
  const result = await execRound(runDir, n);
  return { exitCode: EXIT[result.status] ?? 1, out: summarize(result) };
}

export async function execRound(runDir, n) {
  let meta = updateMeta(runDir, { status: 'running', runner_pid: process.pid, round_started_at: isoNow() });
  const adapter = ADAPTERS[meta.to];
  const p = runPaths(runDir, n);
  const ctx = {
    mode: meta.mode,
    workdir: meta.workdir,
    model: meta.model,
    effort: meta.effort,
    sessionId: meta.session_id,
    schemaPath: SCHEMA_PATH,
    lastMessagePath: p.lastMessage,
    modelPatchFile: p.modelPatch,
  };
  ctx.modelPatchPath = adapter.prepare?.(ctx) ?? null;
  const argv = n === 1 ? adapter.buildArgv(ctx) : adapter.resumeArgv(ctx);
  const env = workerEnv(adapter.name, meta.depth, path.dirname(meta.bin));
  if (!meta.worker_version) meta = updateMeta(runDir, { worker_version: binVersion(meta.bin, env) });
  writeJson(path.join(p.roundDir, 'argv.json'), [meta.bin, ...argv]);

  const startedAt = isoNow();
  const state = adapter.initState();
  const outcome = await runWorker({
    bin: meta.bin,
    argv,
    cwd: meta.workdir,
    env,
    input: fs.readFileSync(p.prompt, 'utf8'),
    eventsFile: p.events,
    stderrFile: p.stderr,
    timeoutS: meta.timeout_s,
    idleTimeoutS: meta.idle_timeout_s,
    adapter,
    state,
    onSpawn: (pid) => updateMeta(runDir, { worker_pid: pid }),
  });

  meta = loadMeta(runDir);
  const verdict = adapter.outcome(state, outcome.exitCode);
  const warnings = [...state.warnings];
  let status;
  let error = null;
  if (meta.cancel_requested) {
    status = 'cancelled';
    error = 'cancelled by user';
  } else if (outcome.spawnError) {
    status = 'failed';
    error = `could not start ${meta.bin}: ${outcome.spawnError.message}`;
  } else if (outcome.killedFor) {
    status = outcome.killedFor;
    error = outcome.killedFor === 'timeout' ? `exceeded --timeout ${meta.timeout_s}s` : `no output for ${meta.idle_timeout_s}s (--idle-timeout)`;
  } else if (verdict.ok) {
    status = 'completed';
    warnings.push(...(verdict.warnings ?? []));
  } else {
    status = 'failed';
    error = verdict.error;
  }
  if (status !== 'completed' && status !== 'cancelled') {
    const errTail = tail(p.stderr, 1200);
    if (errTail) error = `${error} | stderr tail: ${errTail}`;
  }

  const { parsed, report } = adapter.report(state, ctx);
  if (!parsed && status === 'completed') warnings.push('worker report was not valid JSON; report.summary holds the raw final message');

  let diff = null;
  if (meta.base_tree) {
    try {
      diff = diffTrees(meta.root, meta.base_tree, snapshotTree(meta.worktree ?? meta.root), p.diff);
    } catch (e) {
      warnings.push(`could not compute diff: ${e.message}`);
    }
  }

  const roundRecord = {
    n,
    status,
    exit_code: outcome.exitCode,
    signal: outcome.signal,
    started_at: startedAt,
    ended_at: isoNow(),
    duration_s: round1(outcome.durationMs / 1000),
    usage: adapter.usage(state),
  };
  const rounds = [...(meta.rounds ?? []).filter((r) => r.n !== n), roundRecord];
  const sessionId = state.sessionId ?? meta.session_id;

  const result = {
    schema: 'cc-agent-bridge.result.v1',
    bridge_version: BRIDGE_VERSION,
    run_id: meta.run_id,
    to: PUBLIC_NAME[meta.to],
    worker_version: meta.worker_version,
    model: meta.model ?? null,
    mode: meta.mode,
    isolation: meta.isolation,
    status,
    error,
    exit_code: outcome.exitCode,
    session_id: sessionId,
    root: meta.root,
    workdir: meta.workdir,
    branch: meta.branch,
    worker_report: report,
    touched_files: diff?.files ?? [],
    diff_stat: diff?.stat ?? null,
    usage: sumUsage(rounds),
    duration_s: round1(rounds.reduce((a, r) => a + r.duration_s, 0)),
    rounds: rounds.length,
    warnings,
    paths: {
      result: p.result,
      diff: diff ? p.diff : null,
      events: p.events,
      log: p.stderr,
      prompt: p.prompt,
    },
    created_at: meta.created_at,
    finished_at: isoNow(),
  };
  writeJson(p.result, result);
  updateMeta(runDir, { status, error, session_id: sessionId, rounds, worker_pid: null, finished_at: result.finished_at });
  return result;
}

// ---------------------------------------------------------------- commands

async function cmdRun(args) {
  const depth = checkDepth();
  const to = TO_ALIASES[String(args.to ?? '').toLowerCase()];
  if (!to) throw new BridgeError('--to must be "codex" or "deepseek".');
  const adapter = ADAPTERS[to];

  const mode = args.mode ?? 'read';
  if (!['read', 'write', 'full'].includes(mode)) throw new BridgeError('--mode must be read, write or full.');
  if (mode === 'full') {
    if (!args['i-am-in-a-sandbox']) {
      throw new BridgeError('--mode full disables the worker sandbox and is off by default.', {
        status: 'refused',
        exitCode: 3,
        hint: 'Only use it inside a container/VM, together with --i-am-in-a-sandbox.',
      });
    }
    if (!inContainer()) {
      throw new BridgeError('--mode full is only allowed inside a container or VM, and none was detected.', { status: 'refused', exitCode: 3 });
    }
  }

  const brief = readBrief(args);
  const cwd = path.resolve(args.cwd ?? process.cwd());
  const { root, isGit } = projectRoot(cwd);
  const isolation = args.isolation ?? (mode === 'read' ? 'inplace' : 'worktree');
  if (!['worktree', 'inplace'].includes(isolation)) throw new BridgeError('--isolation must be worktree or inplace.');
  if (isolation === 'worktree') {
    if (!isGit) {
      throw new BridgeError('Worktree isolation needs a git repository.', {
        hint: 'Run `git init && git add -A && git commit -m init`, or pass --isolation inplace (no diff tracking).',
      });
    }
    if (!hasHead(root)) throw new BridgeError('Worktree isolation needs at least one commit.', { hint: 'Commit once, or pass --isolation inplace.' });
  }

  const model = args.model ?? null;
  const effort = args.effort ?? null;
  adapter.validate({ model, effort });

  const active = activeRuns(root);
  const maxParallel = num(process.env.CC_AGENT_BRIDGE_MAX_PARALLEL, 3);
  if (active.length >= maxParallel) {
    throw new BridgeError(`${active.length} runs are already active (max ${maxParallel}).`, {
      status: 'refused',
      exitCode: 3,
      hint: `Wait for one: ${B} list`,
    });
  }
  if (mode !== 'read' && isolation === 'inplace' && active.some((m) => m.mode !== 'read' && m.isolation === 'inplace')) {
    throw new BridgeError('Another in-place write run is active in this project.', { status: 'refused', exitCode: 3 });
  }

  const bin = findBin(adapter.bin);
  if (!bin) throw new BridgeError(`${adapter.bin} was not found.`, { hint: adapter.installHint });

  const runId = newRunId(PUBLIC_NAME[to]);
  const runDir = path.join(runsDir(root), runId);
  fs.mkdirSync(runDir, { recursive: true });
  if (isGit) ensureExcluded(root);
  const baseTree = isGit ? snapshotTree(root) : null;

  let rel = path.relative(root, cwd);
  if (rel.startsWith(STATE_DIR_NAME)) rel = '';
  let workdir = cwd;
  let worktree = null;
  let branch = null;
  if (isolation === 'worktree') {
    ({ workdir: worktree, branch } = createWorktree(root, runId, baseTree));
    workdir = path.join(worktree, rel);
    fs.mkdirSync(workdir, { recursive: true });
  }

  fs.writeFileSync(runPaths(runDir, 1).brief, brief);
  saveMeta(runDir, {
    schema: 'cc-agent-bridge.meta.v1',
    bridge_version: BRIDGE_VERSION,
    run_id: runId,
    to,
    mode,
    isolation,
    root,
    cwd,
    workdir,
    worktree,
    branch,
    base_tree: baseTree,
    model,
    effort,
    timeout_s: num(args.timeout, 1800),
    idle_timeout_s: num(args['idle-timeout'], 600),
    depth,
    bin: bin.path,
    worker_version: null,
    status: 'queued',
    session_id: null,
    round: 0,
    rounds: [],
    applied: false,
    created_at: isoNow(),
  });
  prepareRound(runDir, 1, brief);
  return launch(runDir, 1, Boolean(args.background));
}

async function cmdWait(args) {
  const runDir = findRun(rootFor(args), args._[1]);
  const timeoutS = num(args.timeout, 540);
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const meta = reconcile(runDir, loadMeta(runDir));
    if (TERMINAL.has(meta.status)) {
      const result = readJson(runPaths(runDir, meta.round).result);
      if (result) return { exitCode: EXIT[result.status] ?? 1, out: { done: true, ...summarize(result) } };
      return { exitCode: EXIT[meta.status] ?? 1, out: { done: true, ok: false, run_id: meta.run_id, status: meta.status, error: meta.error } };
    }
    if (meta.status === 'queued' && !meta.runner_pid && Date.now() - Date.parse(meta.queued_at) > 60_000) {
      updateMeta(runDir, { status: 'failed', error: `runner never started; see ${runPaths(runDir, meta.round).runnerLog}` });
      continue;
    }
    if (Date.now() >= deadline) {
      return { exitCode: 0, out: { done: false, ...statusOf(runDir, meta), next: `${B} wait ${meta.run_id}` } };
    }
    await sleep(2000);
  }
}

function statusOf(runDir, meta) {
  const p = runPaths(runDir, meta.round || 1);
  let lastActivity = Date.parse(meta.round_started_at ?? meta.created_at);
  let events = 0;
  for (const f of [p.events, p.stderr]) {
    try {
      const st = fs.statSync(f);
      lastActivity = Math.max(lastActivity, st.mtimeMs);
      if (f === p.events) events = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
    } catch {}
  }
  const started = Date.parse(meta.round_started_at ?? meta.created_at);
  return {
    run_id: meta.run_id,
    to: PUBLIC_NAME[meta.to],
    mode: meta.mode,
    status: meta.status,
    round: meta.round,
    elapsed_s: Math.round((Date.now() - started) / 1000),
    idle_s: Math.round((Date.now() - lastActivity) / 1000),
    events,
    session_id: meta.session_id,
    workdir: meta.workdir,
    error: meta.error ?? undefined,
  };
}

async function cmdStatus(args) {
  const runDir = findRun(rootFor(args), args._[1]);
  return { exitCode: 0, out: statusOf(runDir, reconcile(runDir, loadMeta(runDir))) };
}

async function cmdList(args) {
  const root = rootFor(args);
  const limit = num(args.limit, 20);
  const runs = listRuns(root).slice(0, limit).map((m) => ({
    run_id: m.run_id,
    to: PUBLIC_NAME[m.to],
    mode: m.mode,
    status: !TERMINAL.has(m.status) && m.runner_pid && !isPidAlive(m.runner_pid) ? 'failed?' : m.status,
    rounds: m.rounds?.length ?? 0,
    applied: m.applied,
    created_at: m.created_at,
  }));
  return { exitCode: 0, out: { root, runs } };
}

async function cmdResult(args) {
  const runDir = findRun(rootFor(args), args._[1]);
  const meta = loadMeta(runDir);
  const result = readJson(runPaths(runDir, meta.round).result);
  if (!result) throw new BridgeError(`Run ${meta.run_id} has no result yet (status: ${meta.status}).`, { hint: `${B} wait ${meta.run_id}` });
  if (args.diff) {
    const patch = result.paths.diff ? fs.readFileSync(result.paths.diff, 'utf8') : '';
    return { exitCode: 0, raw: patch ? truncate(patch, 200_000) : '(no changes)\n' };
  }
  return { exitCode: 0, out: args.full ? result : summarize(result) };
}

async function cmdResume(args) {
  const depth = checkDepth();
  const runDir = findRun(rootFor(args), args._[1]);
  const meta = reconcile(runDir, loadMeta(runDir));
  if (!TERMINAL.has(meta.status)) throw new BridgeError(`Run ${meta.run_id} is still ${meta.status}.`, { status: 'refused', exitCode: 3, hint: `${B} wait ${meta.run_id}` });
  if (!meta.session_id) throw new BridgeError('The worker never reported a session id, so it cannot be resumed.', { hint: 'Start a new run instead.' });
  if (meta.applied) throw new BridgeError('This run was already applied.', { hint: 'Start a new run for further changes.' });
  if (meta.worktree && !fs.existsSync(meta.worktree)) throw new BridgeError(`Worktree ${meta.worktree} no longer exists.`);
  const maxRounds = num(process.env.CC_AGENT_BRIDGE_MAX_ROUNDS, 4);
  if ((meta.rounds?.length ?? 0) >= maxRounds) {
    throw new BridgeError(`Run already had ${meta.rounds.length} rounds (max ${maxRounds}).`, {
      status: 'refused',
      exitCode: 3,
      hint: 'Take over the remaining work yourself or start a fresh run with a sharper brief.',
    });
  }
  if (depth !== meta.depth) throw new BridgeError('Resume must come from the same delegation depth as the original run.', { status: 'refused', exitCode: 3 });
  const brief = readBrief(args);
  const n = (meta.round || 1) + 1;
  prepareRound(runDir, n, brief);
  return launch(runDir, n, Boolean(args.background));
}

async function cmdApply(args) {
  const runDir = findRun(rootFor(args), args._[1]);
  const meta = loadMeta(runDir);
  if (meta.status !== 'completed' && !args.force) {
    throw new BridgeError(`Run status is ${meta.status}; refusing to apply.`, { status: 'refused', exitCode: 3, hint: 'Pass --force to apply anyway.' });
  }
  if (meta.applied) throw new BridgeError('Already applied.', { status: 'refused', exitCode: 3 });
  if (meta.isolation !== 'worktree') return { exitCode: 0, out: { ok: true, applied: false, note: 'In-place run: changes are already in the working tree.' } };
  const p = runPaths(runDir, meta.round);
  const result = readJson(p.result) ?? {};
  if (!fs.existsSync(p.diff) || fs.statSync(p.diff).size === 0) {
    return { exitCode: 0, out: { ok: true, applied: false, note: 'The worker made no changes.' } };
  }
  const check = git(meta.root, ['apply', '--check', p.diff]);
  let applied;
  if (check.code === 0) applied = applyPatch(meta.root, p.diff);
  else if (args['3way']) applied = applyPatch(meta.root, p.diff);
  else {
    return {
      exitCode: 1,
      out: {
        ok: false,
        applied: false,
        error: `Patch does not apply cleanly to the current working tree: ${truncate(check.stderr.trim(), 600)}`,
        hint: `The project changed since the run started. Retry with --3way (may leave conflict markers), or resume the worker on top of the new state.`,
      },
    };
  }
  if (!applied.ok) return { exitCode: 1, out: { ok: false, applied: false, method: applied.method, error: truncate(applied.detail, 800) } };
  updateMeta(runDir, { applied: true, applied_at: isoNow() });
  let worktreeRemoved = false;
  if (!args['keep-worktree']) {
    removeWorktree(meta.root, meta.worktree, meta.branch);
    worktreeRemoved = true;
  }
  return {
    exitCode: 0,
    out: { ok: true, applied: true, method: applied.method, files: result.touched_files ?? [], diff_stat: result.diff_stat, worktree_removed: worktreeRemoved, note: 'Changes are in the working tree, uncommitted.' },
  };
}

async function cmdCancel(args) {
  const runDir = findRun(rootFor(args), args._[1]);
  let meta = loadMeta(runDir);
  if (TERMINAL.has(meta.status)) return { exitCode: 0, out: { ok: true, run_id: meta.run_id, status: meta.status, note: 'Run already finished.' } };
  meta = updateMeta(runDir, { cancel_requested: true });
  if (meta.worker_pid && isPidAlive(meta.worker_pid)) {
    killTree(meta.worker_pid);
    for (let i = 0; i < 20 && isPidAlive(meta.worker_pid); i++) await sleep(500);
    if (isPidAlive(meta.worker_pid)) {
      try {
        process.kill(-meta.worker_pid, 'SIGKILL');
      } catch {}
    }
  } else if (meta.runner_pid && isPidAlive(meta.runner_pid)) {
    try {
      process.kill(meta.runner_pid, 'SIGTERM');
    } catch {}
  }
  for (let i = 0; i < 30; i++) {
    meta = loadMeta(runDir);
    if (TERMINAL.has(meta.status)) break;
    if (!isPidAlive(meta.runner_pid)) {
      meta = updateMeta(runDir, { status: 'cancelled', error: 'cancelled by user' });
      break;
    }
    await sleep(500);
  }
  return { exitCode: 0, out: { ok: true, run_id: meta.run_id, status: meta.status } };
}

function parseAge(s) {
  const m = String(s).match(/^(\d+)([dh])$/);
  if (!m) throw new BridgeError('--older-than must look like 7d or 12h.');
  return Number(m[1]) * (m[2] === 'd' ? 86_400_000 : 3_600_000);
}

async function cmdClean(args) {
  const root = rootFor(args);
  const maxAge = parseAge(args['older-than'] ?? '7d');
  const removed = [];
  for (const meta of listRuns(root)) {
    if (!TERMINAL.has(meta.status) && isPidAlive(meta.runner_pid)) continue;
    const old = Date.now() - Date.parse(meta.updated_at ?? meta.created_at) > maxAge;
    if (!(args.all || old || meta.applied)) continue;
    if (meta.worktree) removeWorktree(root, meta.worktree, meta.branch);
    fs.rmSync(path.join(runsDir(root), meta.run_id), { recursive: true, force: true });
    removed.push(meta.run_id);
  }
  return { exitCode: 0, out: { ok: true, removed } };
}

function hasDeepseekKey(cwd) {
  if (process.env.DEEPSEEK_API_KEY) return 'environment variable';
  const files = [path.join(process.env.DSH_HOME ?? path.join(homeDir(), '.dsh'), '.env'), path.join(cwd, '.env')];
  for (const f of files) {
    try {
      if (/^\s*DEEPSEEK_API_KEY\s*=\s*\S/m.test(fs.readFileSync(f, 'utf8'))) return f;
    } catch {}
  }
  return null;
}

async function cmdDoctor(args) {
  const cwd = path.resolve(args.cwd ?? process.cwd());
  const checks = [];
  const add = (name, ok, detail, fix, level = 'error') => checks.push({ name, ok, level, detail, ...(ok ? {} : { fix }) });

  add('node', compareVersions(process.versions.node, '20.0.0') >= 0, `v${process.versions.node}`, 'Install Node.js >= 20 (>= 24.9 if you use DeepSeek Harness).');
  const g = run('git', ['--version']);
  add('git', g.code === 0, g.stdout.trim() || 'not found', 'Install git (>= 2.20).');
  if (g.code === 0) {
    const { root, isGit } = projectRoot(cwd);
    add('project', isGit && hasHead(root), isGit ? `${root}${hasHead(root) ? '' : ' (no commits yet)'}` : `${cwd} is not a git repository`,
      'Write tasks run in a git worktree: `git init && git add -A && git commit -m init`, or use --isolation inplace.', 'warn');
  }

  const workers = {};
  const cx = findBin('codex');
  if (cx) {
    const v = binVersion(cx.path, workerEnv('codex', 0, path.dirname(cx.path)));
    add('codex', Boolean(v), `${cx.path} (${v ?? 'version check failed'})`, 'Reinstall: npm i -g @openai/codex', 'warn');
    workers.codex = Boolean(v);
  } else {
    add('codex', false, 'not found', codex.installHint, 'warn');
    workers.codex = false;
  }

  const ds = findBin('dsh');
  if (ds) {
    const env = workerEnv('dsh', 0, path.dirname(ds.path));
    const nodeV = nodeVersionIn(path.dirname(ds.path), env);
    const nodeOk = nodeV && compareVersions(nodeV, '24.9.0') >= 0;
    const v = binVersion(ds.path, env);
    add('dsh', Boolean(v) && nodeOk, `${ds.path} (${v ?? 'version check failed'}, node v${nodeV ?? '?'})`,
      nodeOk ? dsh.installHint : 'dsh needs Node >= 24.9: nvm install 24 --reinstall-packages-from=current, then reinstall dsh.', 'warn');
    const key = hasDeepseekKey(cwd);
    add('deepseek_api_key', Boolean(key), key ? `found in ${key}` : 'not found',
      "mkdir -p ~/.dsh && printf 'DEEPSEEK_API_KEY=%s\\n' '<your key>' > ~/.dsh/.env && chmod 600 ~/.dsh/.env", 'warn');
    workers.deepseek = Boolean(v) && nodeOk && Boolean(key);
  } else {
    add('dsh', false, 'not found', dsh.installHint, 'warn');
    workers.deepseek = false;
  }

  const depth = Number.parseInt(process.env.CC_AGENT_BRIDGE_DEPTH ?? '0', 10) || 0;
  add('depth', depth === 0, `CC_AGENT_BRIDGE_DEPTH=${depth}`, 'This shell belongs to a delegated worker; delegation is disabled here.', 'warn');

  // Each worker is optional; the setup is usable as soon as one of them is ready.
  const ok = checks.filter((c) => c.level === 'error').every((c) => c.ok) && (workers.codex || workers.deepseek);
  return { exitCode: ok ? 0 : 1, out: { ok, bridge_version: BRIDGE_VERSION, workers, checks } };
}

async function cmdExec(args) {
  const [, runDir, n] = args._;
  try {
    await execRound(runDir, Number(n));
  } catch (e) {
    updateMeta(runDir, { status: 'failed', error: `runner crashed: ${e.stack ?? e.message}` });
    throw e;
  }
  return { exitCode: 0, out: null };
}

const HELP = `cc-agent-bridge ${BRIDGE_VERSION} — delegate tasks from Claude Code to Codex or DeepSeek Harness

  ${CMD} doctor
  ${CMD} run --to codex|deepseek (--brief <file|-> | --message "<task>")
        [--mode read|write] [--isolation worktree|inplace] [--cwd <dir>]
        [--model <m>] [--effort <e>] [--timeout 1800] [--idle-timeout 600] [--background]
  ${CMD} wait <run_id> [--timeout 540]
  ${CMD} status <run_id> | list [--limit 20]
  ${CMD} result <run_id> [--full | --diff]
  ${CMD} resume <run_id> (--brief <file|-> | --message "<text>") [--background]
  ${CMD} apply <run_id> [--3way] [--keep-worktree] [--force]
  ${CMD} cancel <run_id> | clean [--older-than 7d] [--all]
`;

const COMMANDS = {
  run: cmdRun,
  wait: cmdWait,
  status: cmdStatus,
  list: cmdList,
  result: cmdResult,
  resume: cmdResume,
  apply: cmdApply,
  cancel: cmdCancel,
  clean: cmdClean,
  doctor: cmdDoctor,
  _exec: cmdExec,
};

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
    const cmd = args._[0];
    if (!cmd || args.help || cmd === 'help') {
      process.stdout.write(HELP);
      return 0;
    }
    const fn = COMMANDS[cmd];
    if (!fn) throw new BridgeError(`Unknown command: ${cmd}`, { hint: `${B} help` });
    const { exitCode, out, raw } = await fn(args);
    if (raw !== undefined) process.stdout.write(raw);
    else if (out) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return exitCode;
  } catch (e) {
    const known = e instanceof BridgeError;
    process.stdout.write(
      `${JSON.stringify({ ok: false, status: known ? e.status : 'failed', error: known ? e.message : String(e.stack ?? e), hint: known ? e.hint : undefined }, null, 2)}\n`,
    );
    return known ? e.exitCode : 1;
  }
}
