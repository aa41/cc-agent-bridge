import fs from 'node:fs';
import path from 'node:path';
import { BridgeError, compareVersions, homeDir, run } from './util.mjs';

const OVERRIDE_ENV = {
  codex: 'CC_AGENT_BRIDGE_CODEX_BIN',
  dsh: 'CC_AGENT_BRIDGE_DSH_BIN',
};

function isExecutable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function searchDirs() {
  const home = homeDir();
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  // Subprocesses often get a thinner PATH than the user's shell (nvm, volta, Homebrew), so also
  // look in the usual global-install locations, newest nvm Node first.
  const nvmRoot = path.join(process.env.NVM_DIR ?? path.join(home, '.nvm'), 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvmRoot).sort((a, b) => compareVersions(b, a));
    for (const v of versions) dirs.push(path.join(nvmRoot, v, 'bin'));
  } catch {}
  dirs.push(
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
  );
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  return [...new Set(dirs)];
}

export function findBin(name) {
  const override = process.env[OVERRIDE_ENV[name]];
  if (override) {
    if (isExecutable(override)) return { path: override, source: OVERRIDE_ENV[name] };
    throw new BridgeError(`${OVERRIDE_ENV[name]} points to a missing or non-executable file: ${override}`);
  }
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  const pathDirs = new Set((process.env.PATH ?? '').split(path.delimiter));
  for (const dir of searchDirs()) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) return { path: candidate, source: pathDirs.has(dir) ? 'PATH' : 'fallback' };
    }
  }
  return null;
}

export function binVersion(bin, env) {
  const r = run(bin, ['--version'], { env, timeout: 30_000 });
  const text = `${r.stdout}\n${r.stderr}`;
  const m = text.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
  return r.code === 0 && m ? m[1] : null;
}

export function nodeVersionIn(binDir, env) {
  const local = path.join(binDir, process.platform === 'win32' ? 'node.exe' : 'node');
  const r = run(fs.existsSync(local) ? local : 'node', ['--version'], { env, timeout: 15_000 });
  return r.code === 0 ? r.stdout.trim().replace(/^v/, '') : null;
}
