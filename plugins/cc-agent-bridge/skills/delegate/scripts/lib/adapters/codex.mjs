import fs from 'node:fs';
import { parseReport } from '../report.mjs';

// `codex exec --json` (verified against codex-cli 0.157.1).
// - Item events of type "error" are warnings (deprecated config keys, missing model metadata);
//   only `turn.failed` decides failure.
// - File edits do not reliably produce `file_change` items, so changes always come from git.

const SANDBOX = {
  read: ['-s', 'read-only'],
  write: ['-s', 'workspace-write'],
  full: ['--dangerously-bypass-approvals-and-sandbox'],
};

function common(ctx) {
  const args = ['--json', '--skip-git-repo-check', '-o', ctx.lastMessagePath, '--output-schema', ctx.schemaPath];
  if (ctx.model) args.push('-m', ctx.model);
  if (ctx.effort) args.push('-c', `model_reasoning_effort="${ctx.effort}"`);
  return args;
}

export default {
  name: 'codex',
  bin: 'codex',
  structuredOutput: true,
  installHint: 'npm i -g @openai/codex   (then run `codex` once to sign in, or configure an API key)',

  validate() {},

  buildArgv(ctx) {
    return ['exec', ...common(ctx), '-C', ctx.workdir, ...SANDBOX[ctx.mode], '-'];
  },

  // `exec resume` has no -s/-C: the sandbox goes through -c and the cwd must be the original one.
  resumeArgv(ctx) {
    const sandbox = ctx.mode === 'full'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['-c', `sandbox_mode="${ctx.mode === 'write' ? 'workspace-write' : 'read-only'}"`];
    return ['exec', 'resume', ctx.sessionId, ...common(ctx), ...sandbox, '-'];
  },

  initState() {
    return { sessionId: null, turnCompleted: false, turnFailed: null, fatal: [], warnings: [], lastText: null, commands: 0, usage: {} };
  },

  onEvent(s, ev) {
    switch (ev.type) {
      case 'thread.started':
        s.sessionId = ev.thread_id ?? s.sessionId;
        break;
      case 'turn.completed':
        s.turnCompleted = true;
        for (const [k, v] of Object.entries(ev.usage ?? {})) if (typeof v === 'number') s.usage[k] = (s.usage[k] ?? 0) + v;
        break;
      case 'turn.failed':
        s.turnFailed = ev.error?.message ?? 'turn failed';
        break;
      case 'error':
        s.fatal.push(ev.message ?? 'error');
        break;
      case 'item.completed': {
        const item = ev.item ?? {};
        if (item.type === 'agent_message') s.lastText = item.text ?? s.lastText;
        else if (item.type === 'error' && item.message && !s.warnings.includes(item.message)) s.warnings.push(item.message);
        else if (item.type === 'command_execution') s.commands += 1;
        break;
      }
    }
  },

  outcome(s, exitCode) {
    if (s.turnFailed) return { ok: false, error: s.turnFailed };
    if (exitCode === 0 && s.turnCompleted) return { ok: true, warnings: s.fatal };
    return { ok: false, error: s.fatal.join('; ') || `codex exited with code ${exitCode}` };
  },

  report(s, ctx) {
    let text = s.lastText;
    try {
      text = fs.readFileSync(ctx.lastMessagePath, 'utf8') || text;
    } catch {}
    return parseReport(text);
  },

  usage(s) {
    return {
      input_tokens: s.usage.input_tokens ?? 0,
      cached_input_tokens: s.usage.cached_input_tokens ?? 0,
      output_tokens: (s.usage.output_tokens ?? 0) + (s.usage.reasoning_output_tokens ?? 0),
    };
  },
};
