import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BRIDGE_VERSION = '0.1.0';
export const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL_DIR = path.dirname(SCRIPTS_DIR);
export const BRIDGE_ENTRY = path.join(SCRIPTS_DIR, 'bridge.mjs');
export const STATE_DIR_NAME = '.cc-agent-bridge';
export const TERMINAL = new Set(['completed', 'failed', 'timeout', 'stalled', 'cancelled', 'refused']);

export class BridgeError extends Error {
  constructor(message, { status = 'failed', exitCode = 2, hint } = {}) {
    super(message);
    this.status = status;
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Atomic write so a concurrent reader (wait/status) never sees a half-written file.
export function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, ...opts });
  return {
    code: r.status ?? (r.error ? 127 : 1),
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error,
  };
}

export function truncate(s, n) {
  if (typeof s !== 'string') return s;
  return s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s;
}

export function newRunId(to) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${to}-${Math.random().toString(16).slice(2, 6)}`;
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function isoNow() {
  return new Date().toISOString();
}

export function homeDir() {
  return os.homedir();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function readStdinIfPiped() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function inContainer() {
  if (process.env.CC_AGENT_BRIDGE_ASSUME_CONTAINER === '1') return true;
  if (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv') || process.env.container) return true;
  try {
    return /docker|containerd|kubepods|lxc/.test(fs.readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}
