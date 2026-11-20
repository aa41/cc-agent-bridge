import { truncate } from './util.mjs';

const REPORT_STATUSES = new Set(['done', 'partial', 'blocked']);

const RULES = ({ mode, structured }) => `
---
## Rules from cc-agent-bridge (mandatory)

You are a worker agent. Claude Code delegated this task to you and will review your work afterwards.

- Work only inside the current working directory.
${mode === 'read' ? '- This is a READ-ONLY task: do not create, modify or delete any file.\n' : ''}- Do not run \`git commit\`, \`git push\`, \`git reset\`, \`git checkout\`/\`git switch\`, or create branches. Leave every change uncommitted; the reviewer applies it.
- Do not start other AI agent CLIs (claude, codex, dsh, gemini, opencode, …) and do not delegate.
- Run the verification commands named in the task if there are any, and report their real outcome. Never claim a test passed without running it.
- If you are blocked or something is ambiguous, stop and say so in the report instead of guessing.

## Final report
${
  structured
    ? 'Your final message must be the JSON report required by the output schema.'
    : 'End your final message with exactly one fenced ```json block (nothing after it) containing the report.'
}
Report fields: "status" ("done" | "partial" | "blocked"), "summary" (what you did and why, concise), "changes" ([{"path","what"}]), "tests" ([{"command","passed","note"}]), "open_questions" ([string]), "next_steps" ([string]).
`;

export function composePrompt({ brief, mode, structured, round }) {
  const head = round > 1
    ? `# Follow-up from the reviewer (round ${round})\n\nContinue the same task in this working directory. Your previous changes are still present.\n\n`
    : '';
  const tail = round > 1 ? '\nThe report must describe the cumulative state of the work, not only this round.\n' : '';
  return `${head}${brief.trim()}\n${RULES({ mode, structured })}${tail}`;
}

function extractJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const blocks = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n?```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(blocks[i][1]);
    } catch {}
  }
  return null;
}

function strList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

export function parseReport(text) {
  if (!text || !text.trim()) {
    return { parsed: false, report: emptyReport('Worker produced no final message.') };
  }
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { parsed: false, report: emptyReport(truncate(text.trim(), 4000)) };
  }
  return {
    parsed: true,
    report: {
      status: REPORT_STATUSES.has(obj.status) ? obj.status : 'partial',
      summary: typeof obj.summary === 'string' ? obj.summary : '',
      changes: Array.isArray(obj.changes)
        ? obj.changes.filter((c) => c && typeof c.path === 'string').map((c) => ({ path: c.path, what: String(c.what ?? '') }))
        : [],
      tests: Array.isArray(obj.tests)
        ? obj.tests
            .filter((t) => t && typeof t.command === 'string')
            .map((t) => ({ command: t.command, passed: t.passed === true, note: String(t.note ?? '') }))
        : [],
      open_questions: strList(obj.open_questions),
      next_steps: strList(obj.next_steps),
    },
  };
}

function emptyReport(summary) {
  return { status: 'unknown', summary, changes: [], tests: [], open_questions: [], next_steps: [] };
}
