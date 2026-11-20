import fs from 'node:fs';
import path from 'node:path';
import { BridgeError, STATE_DIR_NAME, TERMINAL, isPidAlive, isoNow, readJson, writeJson } from './util.mjs';

export function runsDir(root) {
  return path.join(root, STATE_DIR_NAME, 'runs');
}

export function runPaths(runDir, round) {
  const roundDir = path.join(runDir, 'rounds', String(round));
  return {
    runDir,
    meta: path.join(runDir, 'meta.json'),
    result: path.join(runDir, 'result.json'),
    diff: path.join(runDir, 'diff.patch'),
    brief: path.join(runDir, 'brief.md'),
    runnerLog: path.join(runDir, 'runner.log'),
    roundDir,
    prompt: path.join(roundDir, 'prompt.md'),
    events: path.join(roundDir, 'events.jsonl'),
    stderr: path.join(roundDir, 'stderr.log'),
    lastMessage: path.join(roundDir, 'last-message.txt'),
    modelPatch: path.join(roundDir, 'model.yml'),
  };
}

export function loadMeta(runDir) {
  const meta = readJson(path.join(runDir, 'meta.json'));
  if (!meta) throw new BridgeError(`No run metadata in ${runDir}`);
  return meta;
}

export function saveMeta(runDir, meta) {
  meta.updated_at = isoNow();
  writeJson(path.join(runDir, 'meta.json'), meta);
}

export function updateMeta(runDir, patch) {
  const meta = { ...loadMeta(runDir), ...patch };
  saveMeta(runDir, meta);
  return meta;
}

export function findRun(root, runId) {
  if (!runId) throw new BridgeError('Missing run id.', { hint: 'Use `bridge list` to see runs.' });
  const dir = path.join(runsDir(root), runId);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) {
    throw new BridgeError(`Run ${runId} not found under ${runsDir(root)}.`, {
      hint: 'Run the command from the project directory, or pass --cwd <project>.',
    });
  }
  return dir;
}

export function listRuns(root) {
  const dir = runsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((id) => readJson(path.join(dir, id, 'meta.json')))
    .filter(Boolean)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

// A run whose runner process died without finishing (machine sleep, kill -9) would otherwise
// look "running" forever.
export function reconcile(runDir, meta) {
  if (!TERMINAL.has(meta.status) && meta.runner_pid && !isPidAlive(meta.runner_pid)) {
    const grace = Date.now() - Date.parse(meta.updated_at ?? meta.created_at) > 5000;
    if (grace) {
      meta.status = 'failed';
      meta.error = 'runner process exited without recording a result';
      saveMeta(runDir, meta);
    }
  }
  return meta;
}

export function activeRuns(root) {
  return listRuns(root).filter((m) => !TERMINAL.has(m.status) && isPidAlive(m.runner_pid));
}
