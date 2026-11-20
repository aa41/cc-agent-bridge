import path from 'node:path';
import { BridgeError } from './util.mjs';

export const DEPTH_VAR = 'CC_AGENT_BRIDGE_DEPTH';

// A worker must never delegate again: the bridge exports DEPTH_VAR to every worker it starts.
export function checkDepth(env = process.env) {
  const depth = Number.parseInt(env[DEPTH_VAR] ?? '0', 10) || 0;
  const max = Number.parseInt(env.CC_AGENT_BRIDGE_MAX_DEPTH ?? '1', 10);
  if (depth >= max) {
    throw new BridgeError(
      `Refusing to delegate: this process is already a delegated worker (depth ${depth}, max ${max}).`,
      { status: 'refused', exitCode: 3 },
    );
  }
  return depth;
}

// Claude Code session plumbing (CLAUDECODE, CLAUDE_CODE_*, messaging tokens) must not leak into
// workers, and each worker only gets its own provider's credentials.
const DROP_PREFIXES = ['CLAUDE_', 'ANTHROPIC_', 'CC_AGENT_BRIDGE_'];
const DROP_EXACT = new Set(['CLAUDECODE']);
const FOREIGN_SECRETS = {
  codex: ['DEEPSEEK_'],
  dsh: ['OPENAI_', 'CODEX_'],
};

export function workerEnv(worker, depth, binDir) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (DROP_EXACT.has(key) || DROP_PREFIXES.some((p) => key.startsWith(p))) continue;
    if ((FOREIGN_SECRETS[worker] ?? []).some((p) => key.startsWith(p))) continue;
    env[key] = value;
  }
  env[DEPTH_VAR] = String(depth + 1);
  // Put the worker's own bin dir first so its `#!/usr/bin/env node` shebang picks the Node it was
  // installed with (e.g. dsh under nvm's Node 24 while PATH still points at an older Node).
  if (binDir) env.PATH = [binDir, env.PATH].filter(Boolean).join(path.delimiter);
  return env;
}
