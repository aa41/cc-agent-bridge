---
name: delegate
description: Delegate coding work from Claude Code to another agent CLI — OpenAI Codex or DeepSeek Harness (dsh) — and get a structured result back to review. Claude plans and reviews; the worker implements in an isolated git worktree; Claude applies the diff only after checking it. Use when the user asks to have Codex or DeepSeek implement, fix, refactor, test or review something ("让 codex 来写", "交给 deepseek", "用 codex 实现", "let codex do it", "delegate to deepseek"), or wants a plan split across agents.
argument-hint: "[codex|deepseek] <task>"
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/bridge.mjs *)
---

# Delegate to Codex / DeepSeek

You (Claude Code) are the planner and reviewer. A worker agent does the implementation. The bridge script starts it headless, isolates its changes in a git worktree, and hands back one compact JSON summary. The worker's diff is the deliverable; its own claims are not evidence.

Bridge command (use exactly this prefix, it is pre-approved):

```
node ${CLAUDE_SKILL_DIR}/scripts/bridge.mjs <command> ...
```

Run each bridge call as its own plain command, from the project directory: no `cd … &&`, no pipes, no redirections, no heredocs in the same command. Otherwise it no longer matches the pre-approved rule and gets blocked. Use `--cwd <dir>` instead of `cd`, and create brief files with the Write tool.

Below and in the script's own hints, `bridge` stands for that full prefix. Every command prints JSON on stdout. `ok:false` comes with `error` and usually a `hint`. Paths in summaries are relative to the project `root`.

## 0. Check the setup (first use in a session)

Run `bridge doctor`. `workers.codex` / `workers.deepseek` say which workers are usable. If the one the user wants is not ready, show the user the `fix` text from the failing check and stop. Do not install anything yourself.

## 1. Plan

- Understand the request and read the relevant code yourself first.
- Split the work into tasks that can each be verified on their own. One task per run. Tasks that may run in parallel must not touch the same files.
- Pick the worker: the one the user named; otherwise Codex for complex or delicate changes, DeepSeek for bulk, mechanical or cost-sensitive work, either for a second opinion (read mode).

## 2. Write the brief

The worker sees nothing of this conversation. Write a self-contained brief to `.cc-agent-bridge/briefs/<slug>.md` in the project, following [references/brief-template.md](references/brief-template.md): goal, context and decisions already made, files involved, constraints, acceptance criteria, exact verification commands. The bridge appends the standing rules (no commits, no nested agents, final JSON report) itself.

## 3. Run

```
bridge run --to codex|deepseek --mode write --brief .cc-agent-bridge/briefs/<slug>.md --background
```

- `--mode read` (default) for reviews, analysis and questions: runs in place, no file changes allowed.
- `--mode write` for implementation: runs in a fresh worktree on branch `bridge/<run_id>`, starting from the current working tree including uncommitted changes. Needs a git repo with at least one commit.
- Optional: `--model <name>` (Codex model, or `deepseek-flash` / `deepseek-v4-pro`), `--effort low|high|max`, `--timeout <s>` (default 1800), `--idle-timeout <s>` (default 600).
- Never use `--mode full` unless the user explicitly asks and confirms they are inside a container/VM.

Use `--background` for anything that may take more than a few minutes, then wait:

```
bridge wait <run_id> --timeout 540
```

Repeat `wait` while it returns `"done": false` (each call stays under the 10-minute tool limit). `bridge status <run_id>` shows progress without blocking. Short read-only questions can run in the foreground without `--background`.

## 4. Review (always, yourself)

The summary has `status`, `report` (the worker's own account), `touched_files`, `diff_stat`, `warnings` and `paths`.

1. If `status` is not `completed`, read `error` and the tail of `paths.log`, decide whether to resume with a correction, rerun or take over.
2. Read the diff: `bridge result <run_id> --diff` (or open `paths.diff`).
3. Run the verification commands yourself inside `workdir`. The worker's `tests` entries are claims, not proof.
4. Check against [references/review-checklist.md](references/review-checklist.md).

## 5. Iterate or apply

- Problems found: write the concrete review findings to a file and run `bridge resume <run_id> --brief <file> [--background]`. The worker continues in the same session and worktree; the diff stays cumulative. Stop after 3 rounds: take over or rerun with a sharper brief.
- Good: `bridge apply <run_id>` copies the changes into the main working tree (uncommitted) and removes the worktree. If it reports that the patch no longer applies, the project changed meanwhile: resume the worker on top of the new state, or apply with `--3way` and resolve conflicts.
- Never commit on the user's behalf unless they ask.

## 6. Report to the user

Say which worker did what, what you verified and how (commands and results), what you changed during review, the rounds used and the token usage from the summary, and anything left open.

## Other commands

- `bridge list` — runs in this project. `bridge cancel <run_id>` — stop a run. `bridge clean [--older-than 7d] [--all]` — remove finished runs and their worktrees.
- `bridge result <run_id> --full` — the complete result JSON.

## Troubleshooting

See [references/troubleshooting.md](references/troubleshooting.md).
