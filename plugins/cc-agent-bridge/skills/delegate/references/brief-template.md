# Brief template

The worker starts with no context except this file and the repository. Be specific; vague briefs produce vague diffs.

```markdown
# Task: <one-line goal>

## Goal
What must be true when the task is done, from the user's point of view.

## Context
- Why this change is needed.
- Decisions already made (libraries, patterns, naming) and why — the worker must not revisit them.
- Relevant conventions in this codebase (where similar code lives, how tests are written).

## Files
- `path/to/file.ts` — what to change here
- `path/to/other.ts` — read for reference only
- Do not touch: `path/to/generated/`, lockfiles, CI config (adjust as needed)

## Constraints
- Scope: only what is listed above; no drive-by refactors or formatting of unrelated code.
- No new dependencies unless listed here.
- Keep public APIs backward compatible (or: the breaking change below is intended).

## Acceptance criteria
1. ...
2. ...

## Verification
Run these and report the real results:
- `npm test -- path/to/feature.test.ts`
- `npm run lint`

## Out of scope / questions
- If <ambiguous situation>, stop and report it instead of guessing.
```

For a follow-up round (`bridge resume`), write only the findings: what is wrong, where (file:line), what the expected behaviour is, and which check must pass afterwards.
