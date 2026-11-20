import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeError, STATE_DIR_NAME, run } from './util.mjs';

export function git(cwd, args, opts = {}) {
  return run('git', args, { cwd, ...opts });
}

function gitOrThrow(cwd, args, opts) {
  const r = git(cwd, args, opts);
  if (r.code !== 0) throw new BridgeError(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

// The main checkout's root, also when `dir` is inside one of our worktrees, so that
// `bridge apply` works from wherever the reviewer happens to be.
export function projectRoot(dir) {
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.code === 0) {
    const commonDir = common.stdout.trim();
    if (path.basename(commonDir) === '.git') return { root: path.dirname(commonDir), isGit: true };
    const top = git(dir, ['rev-parse', '--show-toplevel']);
    if (top.code === 0) return { root: top.stdout.trim(), isGit: true };
  }
  return { root: fs.realpathSync(dir), isGit: false };
}

export function hasHead(root) {
  return git(root, ['rev-parse', '--verify', '-q', 'HEAD']).code === 0;
}

export function ensureExcluded(root) {
  const rel = git(root, ['rev-parse', '--git-path', 'info/exclude']).stdout.trim();
  if (!rel) return;
  const file = path.resolve(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const line = `/${STATE_DIR_NAME}/`;
  if (!current.split(/\r?\n/).includes(line)) {
    fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
  }
}

// Tree object of the working directory as it is right now (tracked + untracked, honoring
// .gitignore), built in a throwaway index so the user's staging area is never touched.
export function snapshotTree(dir) {
  const index = path.join(os.tmpdir(), `ccab-index-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    if (hasHead(dir)) gitOrThrow(dir, ['read-tree', 'HEAD'], { env });
    gitOrThrow(dir, ['add', '-A', '--', '.'], { env });
    return gitOrThrow(dir, ['write-tree'], { env }).trim();
  } finally {
    fs.rmSync(index, { force: true });
  }
}

export function headTree(root) {
  return gitOrThrow(root, ['rev-parse', 'HEAD^{tree}']).trim();
}

export function createWorktree(root, runId, baseTree) {
  const workdir = path.join(root, STATE_DIR_NAME, 'worktrees', runId);
  const branch = `bridge/${runId}`;
  gitOrThrow(root, ['worktree', 'add', '-q', '-b', branch, workdir, 'HEAD']);
  // Carry the user's uncommitted work into the worktree so the worker starts from what the
  // user actually sees, not from the last commit.
  if (baseTree !== headTree(root)) gitOrThrow(workdir, ['read-tree', '-u', '--reset', baseTree]);
  return { workdir, branch };
}

export function removeWorktree(root, workdir, branch) {
  if (workdir && fs.existsSync(workdir)) git(root, ['worktree', 'remove', '--force', workdir]);
  git(root, ['worktree', 'prune']);
  if (branch) git(root, ['branch', '-D', branch]);
}

export function diffTrees(root, fromTree, toTree, patchFile) {
  const patch = gitOrThrow(root, ['diff', '--binary', fromTree, toTree]);
  fs.writeFileSync(patchFile, patch);
  const files = gitOrThrow(root, ['diff', '--name-only', fromTree, toTree]).split('\n').filter(Boolean);
  const statLines = gitOrThrow(root, ['diff', '--stat', fromTree, toTree]).trim().split('\n');
  return { files, stat: files.length ? statLines[statLines.length - 1].trim() : 'no changes', bytes: patch.length };
}

export function applyPatch(root, patchFile) {
  const check = git(root, ['apply', '--check', patchFile]);
  if (check.code === 0) {
    const r = git(root, ['apply', patchFile]);
    return { ok: r.code === 0, method: 'apply', detail: r.stderr.trim() };
  }
  const three = git(root, ['apply', '--3way', patchFile]);
  return {
    ok: three.code === 0,
    method: '3way',
    detail: (three.stderr || check.stderr).trim(),
    conflicts: three.code !== 0,
  };
}
