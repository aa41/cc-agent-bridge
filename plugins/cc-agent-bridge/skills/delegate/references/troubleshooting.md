# Troubleshooting

Start with `bridge doctor`; every failing check carries a `fix`.

| Symptom | Cause | Fix |
|---|---|---|
| `codex was not found` / `dsh was not found` | Not installed, or installed under a Node version the bridge cannot see | Install it; or set `CC_AGENT_BRIDGE_CODEX_BIN` / `CC_AGENT_BRIDGE_DSH_BIN` to the absolute path |
| dsh check fails with `node v22…` | dsh needs Node >= 24.9 | `nvm install 24 --reinstall-packages-from=current`, then reinstall dsh |
| dsh runs but tool calls fail | npm >= 11 skipped dsh's install scripts | `npm i -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs @deepseek-ai/dsh` |
| `deepseek_api_key not found` | dsh headless only reads the key from the environment, `<project>/.env` or `~/.dsh/.env` (not from the GUI) | `mkdir -p ~/.dsh && printf 'DEEPSEEK_API_KEY=%s\n' '<key>' > ~/.dsh/.env && chmod 600 ~/.dsh/.env` |
| Codex `status: failed` with auth errors in `error` | Codex not signed in / no API key | Run `codex` once interactively to sign in, or configure its API key |
| `warnings` mention unrecognized config / model metadata | Harmless Codex notices about `~/.codex/config.toml` | Clean up the Codex config if you like; the run is unaffected |
| `status: stalled` | No output for `--idle-timeout` seconds (often a long build/test that prints nothing) | Raise `--idle-timeout`, or tell the worker to run quieter/faster checks |
| `status: timeout` | Exceeded `--timeout` | Split the task, or raise `--timeout`; `resume` continues from where it stopped |
| `Worktree isolation needs a git repository` | Write mode isolates work in a git worktree | `git init && git add -A && git commit -m init`, or `--isolation inplace` (no diff tracking, edits land directly) |
| `apply`: patch does not apply cleanly | The main working tree changed after the run started | `resume` the worker on the new state, or `apply --3way` and resolve conflicts |
| `Refusing to delegate: … depth 1` | The bridge was called from inside a worker | Intended: workers must not delegate further |
| Run stuck in `running` after a reboot | Runner process died | `bridge status` marks it failed; `bridge clean` removes it |
| Network errors from the worker inside Claude Code's sandbox | Sandbox network allowlist blocks the worker's API host | Allow `api.openai.com` / `chatgpt.com` (Codex) or `api.deepseek.com` (dsh) in Claude Code's sandbox settings |

Runtime files live in `<project>/.cc-agent-bridge/` (git-ignored through `.git/info/exclude`): `runs/<id>/` holds the prompt, raw events, worker stderr, the diff and `result.json`; `worktrees/<id>/` holds the worker's checkout.
