# cc-agent-bridge：Claude Code 跨 Agent 委派插件开发计划

> 状态：调研完成、范围已确认、待开发　|　日期：2026-11-19
> 开发机：Claude Code 2.1.328、Codex CLI 0.157.1、Node 24.22.3（nvm 默认）、DeepSeek Harness 0.2.2-rc.5（Key 位于 `~/.dsh/.env`）

## 进度（2026-11-19）

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0 Spike | ✅ | 见 §6 P0 结果 |
| P1 插件骨架 + Codex | ✅ | `plugins/cc-agent-bridge/`；`claude plugin validate` 通过（插件与市场清单） |
| P2 DeepSeek Harness | ✅ | dsh 适配器、模型 patch、JSON 块解析与降级 |
| P3 健壮性 | ✅ 大部分 | 后台/wait/status/list/cancel/clean、resume（累计 diff）、超时/停滞、并发与轮数上限、深度防护、环境清理、17 个测试（假 CLI 回放真实事件流）全绿。未做：停滞检测的 CPU 维度 |
| P4 README + 跨机器 | 🟡 | README（仓库首页 + 插件）完成；临时 HOME 中模拟"添加市场 → 安装 → doctor"通过。已提交并关联 `aa41/cc-agent-bridge`。待做：推送、另一台真实 Mac 按 README 验收 |

**真实端到端验证**

| 场景 | 结果 |
|---|---|
| bridge → 真实 Codex（write + worktree） | ✅ 38s，`--output-schema` 报告合规，非致命告警正确归入 warnings；apply 后主工作区测试 3/3 |
| bridge → 真实 dsh（write + worktree） | ✅ 14s，fenced JSON 报告解析成功；apply 后测试 3/3 |
| `claude -p --plugin-dir`：一句中文需求 → Claude 自主 doctor/写 brief/后台委派 Codex/wait/读 diff/worktree 内跑测试/apply/复测 | ✅ 18 轮、$0.19，测试 4/4；并主动指出测试未覆盖的边界 |

**闭环测试中发现并已处理**：`-p` 默认 Manual 模式下 Skill 工具本身需授权（README 已写明 `--allowedTools "Skill(cc-agent-bridge:delegate)"`）；Claude 把 bridge 命令与 `cd &&`/heredoc/管道拼接会导致预授权规则不匹配（SKILL.md 已要求单独执行、用 `--cwd`）；doctor 曾把可选 worker 的缺失当成整体失败（已修）。

## 0. 目标与范围

**Claude Code 作为调用方**：负责规划、写任务包、审查与合入；把实现工作委派给其他 agent，结果结构化地回到 Claude Code。以 **Claude Code 插件**形式发布，任何机器都能通过插件市场一条命令安装。

| 调用方 | 被调方 | 典型场景 |
|---|---|---|
| Claude Code | **Codex**（`codex exec`） | Claude 出详细开发计划 → Codex 实现 → Claude 审查 diff、跑测试、要求返工 → 合入 |
| Claude Code | **DeepSeek Harness**（`dsh headless`） | 同上；低成本实现、批量任务、第二意见 |

### 已确认的决策

| # | 决策 |
|---|---|
| D1 | DeepSeek **只走官方 DeepSeek Harness（`dsh`）** |
| D2 | `full`（完全放开权限）模式默认禁用，仅在容器/VM 等外部隔离环境中通过显式参数开启 |
| D3 | 名称：`cc-agent-bridge` |
| D4 | Codex 作为调用方移出本期范围（见 §9） |
| D5 | **做成可分发到其他机器的插件**；开发和测试期间**不在本机安装**（只用 `--plugin-dir` 临时加载） |
| D6 | Node 可升级 → **dsh 走官方 npm 包**（Node ≥24.9）；**bridge 脚本用 Node 编写**（目标机器装 Codex/dsh 本就需要 Node，不再额外依赖 Python） |
| D11 | **一期只保证 macOS**：Linux/Windows 移出一期范围（不做 Docker/Linux 验证、不做 Windows 适配） |
| D10 | **不做正式发布流程**（无 tag、无 Release 包、无 CI 发布）：仓库推到 GitHub、写好 README，用户按 README 用插件市场命令自然安装 |

**非目标**：Codex/dsh 作为调用方、远程/跨机 agent 网络（A2A）、GUI。

---

## 1. 调研结论

### 1.1 被调方的无头调用接口

| | Codex CLI 0.157.1（本机实测 + 官方文档） | DeepSeek Harness `dsh`（官方仓库 `docs/cli-help.md`） |
|---|---|---|
| 安装 | `npm i -g @openai/codex`（或 brew） | `npm i -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs @deepseek-ai/dsh`（**Node ≥24.9**；npm ≥11 默认拦截安装脚本，不放行则子进程模块不完整，实测）；备选 `uv tool install deepseek-harness-sdk` |
| 无头命令 | `codex exec` | `dsh headless`（= `dsh --profile headless`） |
| 任务输入 | `codex exec -` 从 stdin 读 | 位置参数，`-` 从 stdin 读 |
| 事件输出 | `--json` → JSONL：`thread.started{thread_id}`、`turn.started`、`item.started/updated/completed`、`turn.completed{usage}`、`turn.failed{error}`、顶层 `error` | `--json` → NDJSON：`session{sessionId}`、`status`、`text`、`thinking`、`tool_call`、`tool_result`、`final{sessionId, reason, answer}`；回合外失败才有 `error`。除 `final` 外字符串截断 8KiB、单行 ≤32KiB |
| item 类型 | `agent_message`、`reasoning`、`command_execution{command, aggregated_output, exit_code, status}`、`file_change{changes[{path, kind}]}`、`mcp_tool_call`、`web_search`、`todo_list`、`error`（**非致命**） | — |
| 最终消息 | `-o/--output-last-message FILE` | `final.text`（实测；文档称 answer） |
| 用量 | `turn.completed.usage`（snake_case） | `status{phase:"step_end"}.usage`：`inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/totalTokens`（实测，按 step 累加） |
| 文件变更事件 | 本版本实测**不发** `file_change`（改文件不可依赖事件） | `tool_call{tool:"edit"/"write"}` |
| Schema 约束 | `--output-schema FILE`（strict：`additionalProperties:false`、字段全 required） | **无**，需提示词约定 + 解析 |
| 续接 | `codex exec resume <thread_id> [PROMPT|-]`；**没有 `-s/-C/--add-dir`**，用 `-c sandbox_mode="workspace-write"`，在原 cwd 下执行 | `--session-id <id>`；**必须同 cwd**，需重传 `--add-dir` 与权限参数 |
| 权限 | `-s read-only`（默认）/`workspace-write`/`danger-full-access`；`--full-auto` **已移除** | `--permission-mode read-only/workspace-write(默认)/danger-full-access`；`--approval-policy never`（headless 必须） |
| 工作目录 | `-C DIR`；`--skip-git-repo-check` | **无 cwd 参数**，以进程 cwd 为工作区 |
| 模型 | `-m MODEL`、`-c model_reasoning_effort=…` | **无 `--model`**；用 `--patch model.yml` 覆盖 `agent-default-model` |
| 退出码 | 0 成功 | 0 完成；1 中止/出错/无助手消息；**失败回合也可能有 `final`**；成功判定 `final.reason.kind=="completed"`（实测 reason 为对象） |
| 鉴权 | 本机登录；自动化可用 `CODEX_API_KEY` | `DEEPSEEK_API_KEY`：启动环境 → `<cwd>/.env` → `$DSH_HOME/.env`（**不读 GUI 保存的 Key**） |

**DeepSeek 模型**：`deepseek-flash`（V4.1-Flash，dsh 默认）、`deepseek-v4-pro`（强）。`deepseek-chat`/`deepseek-reasoner` 已于 2026-07-24 下线。dsh 仍是 developer preview（最新 `0.2.2-rc.5`）。

**结论**：核心走 CLI 子进程 + 原生 JSON 事件流，不依赖 MCP 包装（`codex mcp-server` 已于 0.154 移除；dsh 无 MCP server 模式）。

### 1.2 本机实测

| 测试 | 结果 |
|---|---|
| Claude Code 内调用 `codex exec --json` | ✅ 正常。出现 `item.type="error"` 的**非致命**告警（废弃配置项、模型元数据缺失），解析器只把 `turn.failed` 与顶层 `error` 当失败 |
| Claude Code 内嵌套 `claude -p` | ✅ 正常（确认 Claude 侧嵌套环境变量不阻断子进程） |
| dsh | 未安装，P0 实测 |

### 1.3 Claude Code 插件与 Skill 能力（本机 CLI 核实）

| 能力 | 用途 |
|---|---|
| `claude plugin marketplace add <github/url/path>` + `claude plugin install <plugin>@<marketplace>` | 其他机器的安装方式 |
| `claude plugin update` | 升级 |
| `claude --plugin-dir <dir|zip>` / `--plugin-url <zip>` | **仅当前会话加载**，开发测试不污染本机 |
| `claude plugin validate [--profile]` | 校验清单、skill 结构（CI 中跑） |
| `claude plugin tag` | 生成 `cc-agent-bridge--v<版本>` 发版标签，校验 plugin.json 与市场条目一致 |
| `claude plugin eval` | 跑插件评测用例（evals/） |
| `claude plugin configure` | 插件选项与**密钥**（可存 `DEEPSEEK_API_KEY`，P0 验证注入方式） |
| skill `allowed-tools` + `${CLAUDE_SKILL_DIR}` | 脚本免审批运行，路径与安装位置无关 |

⚠️ `claude plugin init` 会把脚手架写到 `~/.claude/skills/`（即本机安装），**不用它**，手动在仓库内建结构。

### 1.4 Claude Code 作为调用方的约束

- **Bash 工具单次上限 10 分钟** → 必须后台运行 + 分段等待（`bridge wait --timeout 540`）。
- **上下文保护**：Codex 的 stderr、dsh 的 `thinking` 事件可达数 MB → 一律落盘，stdout 只回 ≤2KB 摘要。
- Claude Code 子进程带 `CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_SESSION_ID` 等 → 启动 worker 前清理。
- Claude Code 若开了沙箱网络白名单，需放行 OpenAI / DeepSeek 域名（`doctor` 检测并提示）。

### 1.5 关键坑

1. **stdin 挂死**：stdin 为不关闭的管道时 `codex exec` 卡在 "Reading additional input from stdin" → 显式喂 stdin。
2. **PATH / nvm**：子进程找不到 nvm 装的 `codex`（PAL clink #442/#455/#458）→ 运行时多路径解析 + 缓存，允许环境变量覆盖。
3. **非致命 error 事件**（实测）→ 归入 `warnings`。
4. **Codex resume 不接受 `-s/-C`** → `-c sandbox_mode=…` + `cwd=原 worktree`。
5. **dsh 无 cwd 参数、续接必须同 cwd** → 子进程 `cwd=worktree`。
6. **dsh 失败回合也可能输出 `final`** → 退出码 + `final.reason` 双判定。
7. **dsh headless `approval-policy=ask` 行为未文档化** → 强制 `never` + 停滞检测。
8. **dsh 不读 GUI 保存的 Key** → 由 bridge 显式注入。
9. **杀进程要杀整棵进程树**（POSIX 进程组 / Windows `taskkill /T`）。
10. **nvm 切换 Node 大版本后全局包消失**：升级到 Node 24 时要 `nvm install 24 --reinstall-packages-from=22`，否则 `codex` 等命令丢失。实测还有两处：若有本地 tgz 安装的全局包（如 `api-worker`），整批迁移会因 ETARGET 中止，需逐个重装；npm 11 默认拦截安装脚本，含原生模块的包（node-pty、keytar、sharp…）需 `--allow-scripts` 重装。
11. **dsh workspace-write 允许写临时目录**（与 Codex 一致），工作区外其他路径被拒绝且**不挂起**（实测，write 工具与 bash 均被拦）。
12. Claude Code 运行 skill 命令时**没有** `CLAUDE_PLUGIN_ROOT`（实测为空），脚本定位只用 `${CLAUDE_SKILL_DIR}`。

### 1.6 借鉴的现有项目

| 项目 | 借鉴点 |
|---|---|
| openai/codex-plugin-cc（官方 Claude→Codex 插件） | **插件形态分发**；后台 job + `status/result/cancel`；默认只读；Stop hook review gate |
| amElnagdy/delegate-skills | Node 零依赖 relay；自包含 brief；`result.json` 契约；diff 才是交付物、worker 不 commit |
| cexll/myclaude codeagent-wrapper | stdin 传任务；`--worktree`；DAG 并行；退出码 124/127/130 |
| PAL MCP `clink` | 每个 CLI 一个适配器 + 专用解析器；1800s 默认超时；每流 10MB 上限 |

---

## 2. 分发与安装设计（D5）

### 2.1 发布渠道

| 渠道 | 命令（在目标机器上） | 用途 |
|---|---|---|
| **插件市场（GitHub 公开仓库）** | `claude plugin marketplace add aa41/cc-agent-bridge` → `claude plugin install cc-agent-bridge@mxc-skills` | 安装；`claude plugin marketplace update` + `claude plugin update` 拉取最新 |
| 本地目录 | `claude --plugin-dir ./plugins/cc-agent-bridge` | 开发、调试 |

`mxc-skills` 仓库本身就是一个插件市场，以后其他 skill 也可以按同样方式发布。

### 2.2 目标机器依赖与平台支持

| 依赖 | 要求 | 检查/提示 |
|---|---|---|
| Claude Code | ≥ 2.1.3xx（以 P0 实测的最低可用版本为准；开发基准 2.1.328） | README 写明 |
| Node.js | ≥ 24.9（dsh 要求；bridge 脚本本身 ≥20 即可） | `doctor` |
| git | ≥ 2.20（worktree） | `doctor` |
| Codex CLI | ≥ 0.154（开发基准 0.157.1） | `doctor`，未装则仅禁用 codex worker |
| dsh | ≥ 0.2.2（预览版，锁定已测版本） | `doctor`，未装则仅禁用 deepseek worker |

- **平台**：一期只支持 macOS（D11）。代码按 POSIX 编写，Linux 后续再验证；Windows 不在范围内。
- **不自动安装依赖**：`doctor` 按平台输出安装命令（npm / brew / nvm），由用户执行。缺一个 worker 不影响另一个。

### 2.3 机器无关性要求

- 仓库中**不出现任何本机绝对路径**；脚本通过 `${CLAUDE_SKILL_DIR}` 定位自身。
- 二进制解析顺序：环境变量覆盖（`CC_AGENT_BRIDGE_CODEX_BIN` / `CC_AGENT_BRIDGE_DSH_BIN`）→ PATH → 常见位置（npm 全局前缀、nvm 当前版本、Homebrew、`~/.local/bin`）；结果缓存在用户缓存目录（macOS/Linux：`~/.cache/cc-agent-bridge/`，Windows：`%LOCALAPPDATA%\cc-agent-bridge\`）。
- **配置优先级**：命令行参数 > 环境变量 > 项目配置 `.cc-agent-bridge/config.json` > 内置默认。
- **密钥**：`DEEPSEEK_API_KEY` 首选放在 `~/.dsh/.env` 由 dsh 自己读取（bridge 不经手）；也支持环境变量或插件密钥选项，此时**只注入 dsh 子进程**。任何情况下都不写入运行日志。Codex 使用目标机器自身登录状态。

### 2.4 版本管理（D10：不做正式发布）

- `plugin.json` 维护版本号，改动时递增（插件市场靠版本号判断是否有更新）。
- 推送前本地跑 `claude plugin validate` 与单测。
- README 维护**兼容性矩阵**（已测试的 Claude Code / Codex / dsh / Node 版本）。

### 2.5 干净环境验证（不碰本机配置）

- **macOS**：临时 `HOME` 目录（`HOME=$(mktemp -d)`）中执行安装流程，验证不依赖开发机已有配置；最终在一台真实的第二台机器上验收一次。

---

## 3. 架构

```
 Claude Code（规划 / 审查 / 合入）
   │  插件 skill：SKILL.md → 写 brief.md → node ${CLAUDE_SKILL_DIR}/scripts/bridge.mjs …
   ▼
 bridge.mjs（Node 标准库，零依赖，单入口）
   ├─ guard      递归防护、环境清理
   ├─ resolve    二进制定位与缓存、平台差异
   ├─ isolation  git worktree 创建 / diff / apply / 清理
   ├─ runner     进程树管理、超时、停滞检测、后台化、并发锁
   ├─ adapters/  codex.mjs  dsh.mjs   （buildArgv / parseEvents / resumeArgv）
   └─ store      .cc-agent-bridge/runs/<run_id>/
   ▼
 worker 子进程：cwd=worktree，stdin=brief，stdout(JSON 事件)→events.jsonl，stderr→stderr.log
   ▼
 result.json（cc-agent-bridge.result.v1）+ diff.patch → stdout 只打印 ≤2KB 摘要
```

### 3.1 仓库结构（mxc-skills 即插件市场）

```
mxc-skills/
├── .claude-plugin/
│   └── marketplace.json                 # 市场清单：name=mxc-skills，列出 cc-agent-bridge
├── plugins/
│   └── cc-agent-bridge/
│       ├── .claude-plugin/plugin.json   # name、version、description、选项/密钥声明
│       ├── README.md                    # 安装、依赖、兼容性矩阵、用法、排障
│       ├── skills/
│       │   └── delegate/                # 调用名 /cc-agent-bridge:delegate
│       │       ├── SKILL.md
│       │       ├── scripts/
│       │       │   ├── bridge.mjs
│       │       │   └── lib/{cli,guard,resolve,runner,isolation,store,render,pricing}.mjs
│       │       │       └── adapters/{base,codex,dsh}.mjs
│       │       ├── schemas/{worker-report,result.v1}.schema.json
│       │       ├── templates/dsh-model.yml
│       │       └── references/{brief-template,review-checklist,adapters,troubleshooting}.md
│       ├── commands/                    # P5：/cc-agent-bridge:codex、/cc-agent-bridge:deepseek
│       └── tests/
│           ├── fake-bin/{codex,dsh}.mjs # 回放 fixture 的假 CLI（跨平台）
│           ├── fixtures/*.jsonl         # P0 录制的真实事件流（已入库）
│           └── *.test.mjs               # node --test
├── README.md                            # 仓库首页：安装命令、依赖、用法
└── docs/cc-agent-bridge-plan.md
```

脚本放在 skill 目录内，`${CLAUDE_SKILL_DIR}/scripts/bridge.mjs` 在任何安装位置都成立。SKILL.md 中：`allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/bridge.mjs *)`。

插件只被 Claude Code 加载，Codex 与 dsh 读不到它，从源头减少 worker 递归委派。

### 3.2 命令设计

```bash
bridge doctor                                  # 依赖/版本/鉴权/git/沙箱网络检查，按平台给出修复命令
bridge run --to codex|deepseek \
    --brief .cc-agent-bridge/briefs/x.md \     # 或 stdin
    [--mode read|write]                        # 默认 read；write 需显式
    [--isolation worktree|inplace]             # write 默认 worktree
    [--cwd DIR] [--model M] [--effort E]
    [--timeout 1800] [--idle-timeout 300] [--max-tokens N]
    [--background]                             # 立即返回 run_id
    # full：--mode full 必须同时带 --i-am-in-a-sandbox，检测到非容器环境时拒绝（D2）
bridge wait   <run_id> [--timeout 540]
bridge status <run_id> | bridge list
bridge result <run_id> [--diff] [--full]
bridge resume <run_id> --brief fix.md
bridge apply  <run_id> [--strategy merge|patch]
bridge cancel <run_id> | bridge clean [--older-than 7d]
```

（`bridge` 即 `node ${CLAUDE_SKILL_DIR}/scripts/bridge.mjs`）

### 3.3 数据契约

**运行目录** `<项目>/.cc-agent-bridge/runs/<run_id>/`（自动写入 `.git/info/exclude`）：`brief.md`、`meta.json`（脱敏 argv、pid、深度、cwd）、`events.jsonl`、`stderr.log`、`worker-report.json`、`diff.patch`、`result.json`。worktree 位于 `.cc-agent-bridge/worktrees/<run_id>`，分支 `bridge/<run_id>`。

**`result.json`（cc-agent-bridge.result.v1）**

```json
{
  "schema": "cc-agent-bridge.result.v1",
  "bridge_version": "0.1.0",
  "run_id": "20261119-153012-codex-a1b2",
  "to": "codex", "worker_version": "codex-cli 0.157.1", "model": "…",
  "status": "completed | failed | timeout | stalled | cancelled | refused",
  "exit_code": 0,
  "session_id": "01a1f424-…",
  "cwd": "/…/.cc-agent-bridge/worktrees/<run_id>", "branch": "bridge/<run_id>",
  "worker_report": { "status": "done|partial|blocked", "summary": "…",
                     "changes": [{"path":"…","what":"…"}],
                     "tests": [{"command":"…","passed":true,"note":""}],
                     "open_questions": [], "next_steps": [] },
  "touched_files": ["…"],
  "diff_stat": "3 files changed, +120 -8",
  "usage": { "input_tokens": 0, "output_tokens": 0, "est_cost_usd": 0.0 },
  "duration_s": 312, "rounds": 1,
  "warnings": [],
  "paths": { "log": "…/stderr.log", "events": "…", "diff": "…/diff.patch" }
}
```

- `touched_files` / `diff_stat` 来自 git，**不信任 worker 自述**。
- `worker_report`：Codex 通过 `--output-schema` 强制；dsh 由提示词要求最终输出 ```json 代码块，解析失败则降级为 `summary=final.answer` 并记 warning。

**brief 模板**：目标 / 背景与已有决策 / 涉及文件 / 约束（禁止 commit、禁止调用其他 agent、可改范围）/ 验收标准 / 必跑测试命令 / 输出要求。brief 必须**自包含**。

---

## 4. 适配器参数映射

| | codex | dsh |
|---|---|---|
| 公共 | `exec --json --skip-git-repo-check -C <cwd> -o <run>/last.txt --output-schema <schema> [-m M] [-c model_reasoning_effort=E] -`，stdin=brief | `headless --json --approval-policy never [--patch <run>/model.yml] -`，**进程 cwd=worktree**，stdin=brief，env 注入 `DEEPSEEK_API_KEY` |
| read | `-s read-only` | `--permission-mode read-only` |
| write | `-s workspace-write` | `--permission-mode workspace-write` |
| full（D2，默认禁用） | `--dangerously-bypass-approvals-and-sandbox` | `--permission-mode danger-full-access` |
| resume | `exec resume <thread_id> --json -o … -c sandbox_mode="workspace-write" -`（cwd=原 worktree） | `headless --json --session-id <sid> --approval-policy never --permission-mode <同前> -`（cwd=原 worktree） |
| 会话 ID | `thread.started.thread_id`（resume 时同 ID 再发一次） | `session.sessionId` / `final.sessionId` |
| 成功判定 | 有 `turn.completed`，无 `turn.failed`、无顶层 `error` | exit 0 且 `final.reason.kind=="completed"` |
| 用量 | `turn.completed.usage` | `status(step_end).usage` 逐步累加 |
| 模型 | `-m` | patch：`- id: agent-default-model / config: {provider: deepseek-official, model: <M>, reasoningEffort: <E>}` |

---

## 5. Claude Code 侧工作流（写进 SKILL.md）

1. **规划**：理解需求、读代码、定方案，拆成可独立验收的小任务；判断交给谁（复杂实现 → Codex；量大/成本敏感 → DeepSeek）。
2. **写 brief**：按模板写到 `.cc-agent-bridge/briefs/<slug>.md`。
3. **委派**：`bridge run --to codex --mode write --brief … --background` → `run_id`。
4. **等待**：循环 `bridge wait <run_id> --timeout 540`。
5. **审查**（Claude 亲自做）：读 `result.json` → 看 `diff.patch` → 在 worktree 里亲自跑测试/lint → 按 `review-checklist.md` 检查。
6. **返工**：`bridge resume <run_id> --brief fix.md`，**最多 3 轮**；仍失败则 Claude 接手或换 worker。
7. **合入**：`bridge apply <run_id>` → 向用户汇报（改了什么、谁做的、测试结果、轮数、用量）。

并行：互不重叠的任务各用一个 worktree，**最多 3 个并发写任务**；同一 worktree 加锁。

### 5.1 安全与防递归

- 插件只在 Claude Code 中加载，worker 读不到。
- `CC_AGENT_BRIDGE_DEPTH`：bridge 启动时若已 ≥1 则返回 `status=refused`。
- brief 固定约束段：禁止 `git commit/push`、禁止调用其他 agent CLI。
- worker 环境清理：移除 `CLAUDECODE`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_SESSION_ID`；Key 只传给对应 worker，不交叉泄露。
- 日志脱敏；`full` 模式见 D2。

---

## 6. 开发阶段

**开发期约束（D5）**：所有测试通过 `claude --plugin-dir ./plugins/cc-agent-bridge` 在临时样例仓库中加载，不执行 `claude plugin install`，不写入 `~/.claude/skills` 或 `~/.claude/plugins`。

### P0　技术验证 Spike — 结果（2026-11-19）

| ID | 验证项 | 结果 |
|---|---|---|
| S1 | Node 24 + dsh 安装 + `dsh headless --json` 冒烟 | ✅ 3s 返回 `session`→`status`→`text`→`final`，exit 0。安装踩坑见 §1.5-10 |
| S2 | dsh workspace-write + `approval-policy never`：改文件、跑测试、越界写 | ✅ 13s 完成实现并 `node --test` 通过，按约定输出 ```json 块；越界写**被拒绝不挂起** |
| S3 | dsh `--patch` 切 `deepseek-v4-pro`、`--session-id` 续接、用量 | ✅ 模型切换生效（`--dump-config` 亦确认）；续接保留上下文；错误 cwd 续接返回明确 `error` 事件；用量在 `step_end` |
| S4 | `codex exec resume <id> -c sandbox_mode="workspace-write"` 于 worktree | ✅ 续接后继续改 2 个文件、测试通过；未发 `file_change` 事件 |
| S5 | 插件骨架 `--plugin-dir` 加载 | ✅ skill 识别为 `cc-agent-bridge:delegate`；`${CLAUDE_SKILL_DIR}` 展开；`allowed-tools` 在 `-p` 默认 Manual 模式下免审批（0 denials）；`claude plugin validate` 通过 |
| S6 | 插件密钥选项 | ❎ 不采用：`userConfig` 的 `sensitive` 值只以 `CLAUDE_PLUGIN_OPTION_<KEY>` 注入 hook 进程、以 `${user_config.KEY}` 注入 MCP 配置，**skill 运行的 Bash 拿不到**。维持 D9（`~/.dsh/.env`）。marketplace.json 中插件 `source` 用相对路径 `./plugins/cc-agent-bridge` |
| S7 | 后台 + 分段 wait 跑长任务 | 并入 P3 实现与测试 |
| S8 | fixture 录制 | ✅ 7 份真实事件流已入库（脱敏）；超时/鉴权失败样本在 P3 故障注入时补录 |

### P1　MVP：插件骨架 + Claude Code → Codex（2 天）

- 仓库结构、`marketplace.json`、`plugin.json`、README 骨架；`claude plugin validate` 通过。
- `bridge.mjs`：`run`（前台）、`result`、`doctor`；resolve；store；codex 适配器；worker-report schema。
- runner：进程树、stdin、stderr 落盘、硬超时、退出码 124/127/130。
- isolation：worktree、diff/diffstat、`apply`、`.git/info/exclude`。
- guard：深度检查、环境清理。
- SKILL.md v1、brief 模板、review checklist。
- **验收**：样例仓库中经 `--plugin-dir` 加载，Claude 委派 Codex 实现带测试的小功能并审查 apply；result.json 完整；非致命 error 不误判。

### P2　Claude Code → DeepSeek Harness（1–1.5 天）

- dsh 适配器：NDJSON 解析、`final.reason` 判定、cwd 约束、模型 patch、JSON 代码块解析与降级、Key 注入。
- `doctor`：dsh 存在与版本、Node 版本、Key 可见性。
- **验收**：同一 brief 交给 dsh 产出 diff + 合规 result.json；缺 Key / 未装 dsh / Node 过低时给出明确修复命令。

### P3　健壮性（2 天）

- 后台模式全套：`--background`、`wait`、`status`、`list`、`cancel`；停滞检测。
- `resume` 双适配器；返工上限；并发上限与 worktree 锁；token 上限；`clean`。
- 测试：fake-bin 回放单测（`node --test`）；e2e（两种 worker × read/write、resume、并行 2 任务）；故障注入（超时、停滞、鉴权失败、schema 解析失败、递归拒绝）。
- **验收**：测试全绿；连续 10 个真实任务无挂死、无孤儿进程、无上下文溢出。

### P4　README 与跨机器验证（1 天）

- 仓库 README：一键安装命令、依赖与安装命令（含 Node 升级、npm `--allow-scripts`、Key 配置）、兼容性矩阵、用法示例、排障。
- 干净环境验证：临时 HOME（macOS），完整走"添加市场 → 安装 → doctor → 委派一次"；推到 GitHub 后再在一台真实的其他机器上按 README 走一遍。
- **验收**：在一台从未配置过的机器上，仅凭 README 完成安装并成功委派 Codex 与 dsh 各一次。

### P5　可选扩展

- 快捷命令 `/cc-agent-bridge:codex`、`/cc-agent-bridge:deepseek` + Stop hook review gate。
- DAG 并行；多 worker 对比择优。

**总工期估计**：P0 已完成；P1–P4 约 6 个工作日。

---

## 7. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| dsh 为 developer preview，参数/事件格式可能变 | DeepSeek 适配器失效 | 适配器隔离；fixture 契约测试；兼容性矩阵锁定已测版本，`doctor` 对未测版本告警 |
| 目标机器环境差异（PATH、nvm、Node 版本、无 git） | 安装后不可用 | 多路径解析 + 覆盖变量；`doctor` 给修复命令；临时 HOME + 第二台 Mac 验证 |
| 插件密钥注入方式不符合预期 | Key 配置体验差 | S6 验证；退化为环境变量 / dsh 自身 `.env` |
| Codex/Claude Code 升级改格式或插件规范 | 解析或加载失败 | 宽容解析；CI 中 validate；升级后重录 fixture |
| worker 自述与事实不符 | 错误代码被合入 | touched_files 来自 git；Claude 亲自跑测试 |
| 成本失控 | 账单 | 返工 ≤3、并发 ≤3、token 上限、result 记录用量 |

---

## 8. 已定事项（补充）

| # | 决策 |
|---|---|
| D7 | 发布到作者本人的**公开** GitHub 仓库（`aa41/cc-agent-bridge`，已确认）；目标机器安装命令：`claude plugin marketplace add aa41/cc-agent-bridge` → `claude plugin install cc-agent-bridge@mxc-skills` |
| D8 | 插件内 skill 名 `delegate`，调用为 `/cc-agent-bridge:delegate` |
| D9 | `DEEPSEEK_API_KEY` 为 dsh headless 必需。推荐存于 `~/.dsh/.env`（权限 600），由 dsh 自行读取，bridge 不经手 Key；环境变量与插件密钥选项作为备选。README 写明获取与配置方式 |

开发机前置：`gh` 未登录，推送前需 `gh auth login`（或使用已有 SSH key）。

---

## 9. 已移出范围：Codex 作为调用方

按 D4 本期不做。留档：本机实测在 Codex `workspace-write` 沙箱内执行 `claude` 报 `operation not permitted`（exit 127），开启 network_access 无效（测试在 Claude Code 沙箱内嵌套启动 Codex，未在直接启动的 Codex 中复测）。可行方向：Codex rules `prefix_rule(... decision="allow")`、单次提权审批、MCP 薄壳。`codex mcp-server` 已移除；Codex skill 路径为 `.agents/skills` / `~/.agents/skills`。
