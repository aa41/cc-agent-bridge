import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

// SIGINT first so the worker can end its turn cleanly, then escalate; always the whole process
// group, because workers start their own children (test runners, dev servers).
export function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  const send = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {}
  };
  send('SIGINT');
  setTimeout(() => send('SIGTERM'), 5000).unref();
  setTimeout(() => send('SIGKILL'), 10000).unref();
}

export function runWorker({ bin, argv, cwd, env, input, eventsFile, stderrFile, timeoutS, idleTimeoutS, adapter, state, onSpawn }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const events = fs.createWriteStream(eventsFile, { flags: 'a' });
    const errLog = fs.createWriteStream(stderrFile, { flags: 'a' });
    let lastActivity = Date.now();
    let killedFor = null;
    let spawnError = null;
    let pending = '';

    const handleLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        state.nonJsonLines = (state.nonJsonLines ?? 0) + 1;
        return;
      }
      adapter.onEvent(state, ev);
    };

    let child;
    try {
      child = spawn(bin, argv, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !IS_WIN,
        windowsHide: true,
        shell: IS_WIN && /\.(cmd|bat)$/i.test(bin),
      });
    } catch (e) {
      resolve({ exitCode: null, signal: null, killedFor: null, spawnError: e, durationMs: 0 });
      return;
    }
    onSpawn?.(child.pid);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      lastActivity = Date.now();
      events.write(chunk);
      pending += chunk;
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        handleLine(pending.slice(0, i));
        pending = pending.slice(i + 1);
      }
    });
    child.stderr.on('data', (chunk) => {
      lastActivity = Date.now();
      errLog.write(chunk);
    });
    child.on('error', (e) => {
      spawnError = e;
      // Spawn failures (ENOENT, EACCES) may never emit 'close'.
      if (child.pid === undefined) {
        clearTimeout(hardTimer);
        clearInterval(idleTimer);
        events.end();
        errLog.end();
        resolve({ exitCode: null, signal: null, killedFor: null, spawnError: e, durationMs: Date.now() - started });
      }
    });
    // Always hand the prompt over stdin and close it: an open, never-closing stdin makes
    // `codex exec` wait forever for more input.
    child.stdin.on('error', () => {});
    child.stdin.end(input);

    const terminate = (reason) => {
      if (killedFor) return;
      killedFor = reason;
      killTree(child.pid);
    };
    const hardTimer = setTimeout(() => terminate('timeout'), timeoutS * 1000);
    const idleTimer = setInterval(() => {
      if (Date.now() - lastActivity > idleTimeoutS * 1000) terminate('stalled');
    }, Math.min(5000, idleTimeoutS * 1000));

    child.on('close', (exitCode, signal) => {
      clearTimeout(hardTimer);
      clearInterval(idleTimer);
      if (pending) handleLine(pending);
      let closed = 0;
      const done = () => {
        if (++closed === 2) resolve({ exitCode, signal, killedFor, spawnError, durationMs: Date.now() - started });
      };
      events.end(done);
      errLog.end(done);
    });
  });
}
