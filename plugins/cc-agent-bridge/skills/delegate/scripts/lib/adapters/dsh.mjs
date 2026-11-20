import fs from 'node:fs';
import { parseReport } from '../report.mjs';
import { BridgeError } from '../util.mjs';

// DeepSeek Harness headless profile (verified against dsh 0.2.2-rc.5).
// - No --cwd: the process cwd is the workspace, and --session-id only resumes from that same cwd.
// - No --model: the model comes from a config patch that replaces `agent-default-model`.
// - The answer is `final.text`; success is `final.reason.kind === "completed"` plus exit 0.
// - Usage is reported per step on `status` events with phase "step_end".

const PERMISSION = { read: 'read-only', write: 'workspace-write', full: 'danger-full-access' };
const EFFORT = { off: 'off', none: 'off', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' };
const SAFE_VALUE = /^[A-Za-z0-9._:/-]+$/;

function base(ctx) {
  const args = ['--profile', 'headless'];
  if (ctx.modelPatchPath) args.push('--patch', ctx.modelPatchPath);
  args.push('--json', '--permission-mode', PERMISSION[ctx.mode], '--approval-policy', 'never');
  return args;
}

export default {
  name: 'dsh',
  bin: 'dsh',
  structuredOutput: false,
  installHint:
    'Requires Node >= 24.9. npm i -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs @deepseek-ai/dsh',

  validate(ctx) {
    if (ctx.model && !SAFE_VALUE.test(ctx.model)) throw new BridgeError(`Invalid model name: ${ctx.model}`);
    if (ctx.effort && !EFFORT[ctx.effort]) {
      throw new BridgeError(`Invalid effort for dsh: ${ctx.effort} (use off, low, high or max)`);
    }
  },

  // Writes the model override patch when needed; returns its path or null.
  prepare(ctx) {
    if (!ctx.model && !ctx.effort) return null;
    const config = [`provider: deepseek-official`, `model: ${ctx.model ?? 'deepseek-flash'}`];
    if (ctx.effort) config.push(`reasoningEffort: ${EFFORT[ctx.effort]}`);
    fs.writeFileSync(ctx.modelPatchFile, `- id: agent-default-model\n  config: { ${config.join(', ')} }\n`);
    return ctx.modelPatchFile;
  },

  buildArgv(ctx) {
    return [...base(ctx), '-'];
  },

  resumeArgv(ctx) {
    return [...base(ctx), '--session-id', ctx.sessionId, '-'];
  },

  initState() {
    return { sessionId: null, final: null, fatal: [], warnings: [], lastText: null, toolCalls: 0, usage: {} };
  },

  onEvent(s, ev) {
    switch (ev.type) {
      case 'session':
        s.sessionId = ev.sessionId ?? s.sessionId;
        break;
      case 'status':
        if (ev.phase === 'step_end' && ev.usage) {
          for (const [k, v] of Object.entries(ev.usage)) if (typeof v === 'number') s.usage[k] = (s.usage[k] ?? 0) + v;
        }
        break;
      case 'text':
        if (ev.text) s.lastText = ev.text;
        break;
      case 'tool_call':
        s.toolCalls += 1;
        break;
      case 'final':
        s.final = ev;
        s.sessionId = ev.sessionId ?? s.sessionId;
        break;
      case 'error':
        s.fatal.push(ev.message ?? 'error');
        break;
    }
  },

  outcome(s, exitCode) {
    const kind = s.final?.reason?.kind;
    if (exitCode === 0 && kind === 'completed') return { ok: true };
    const why = s.fatal.join('; ') || (kind ? `final reason: ${kind}` : `dsh exited with code ${exitCode}`);
    return { ok: false, error: why };
  },

  report(s) {
    return parseReport(s.final?.text ?? s.lastText);
  },

  usage(s) {
    return {
      input_tokens: (s.usage.inputTokens ?? 0) + (s.usage.cacheReadTokens ?? 0),
      cached_input_tokens: s.usage.cacheReadTokens ?? 0,
      output_tokens: s.usage.outputTokens ?? 0,
    };
  },
};
