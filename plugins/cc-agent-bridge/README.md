# cc-agent-bridge

让 Claude Code 把编码任务委派给 **OpenAI Codex** 或 **DeepSeek Harness（dsh）**，再把结构化结果拿回来审查。

```
你 ──需求──▶ Claude Code（规划 · 写任务包 · 审查 · 合入）
                 │  bridge run --to codex|deepseek
                 ▼
            Codex / DeepSeek Harness（在独立 git worktree 里实现、跑测试）
                 │  result.json + diff.patch
                 ▼
            Claude Code 读 diff、亲自跑测试 → 通过则 apply，不通过则 resume 返工
```

- **隔离**：写任务在 `bridge/<run_id>` 分支的独立 worktree 中进行，从当前工作区状态（含未提交改动）开始；主工作区在 apply 之前不会被改动。
- **结构化结果**：状态、worker 自述报告、改动文件（取自 git，而非 worker 自述）、diff、token 用量。
- **可续接**：审查不通过时 `resume`，worker 在同一会话、同一 worktree 中继续，diff 累计。
- **长任务**：后台运行 + 分段等待，不受 Claude Code 单次命令 10 分钟上限影响。
- **安全**：worker 不提交代码、不能再委派（深度限制）、默认带沙箱；每个 worker 只拿到自己的密钥。

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Claude Code | 已测 2.1.328 | 插件宿主 |
| Node.js | ≥ 24.9 | dsh 要求；只用 Codex 时 ≥ 20 即可 |
| git | ≥ 2.20 | 写任务需要项目是 git 仓库且至少有一次提交 |
| Codex CLI | 已测 0.157.1（≥ 0.154） | 可选，委派给 Codex 时需要 |
| DeepSeek Harness | 已测 0.2.2-rc.5 | 可选，委派给 DeepSeek 时需要；目前为官方预览版 |

**一期（v0.1）只支持 macOS。** Linux 理论上可用但未验证；Windows 不支持。

## 安装

### 1. Node.js 24（使用 DeepSeek 时必需）

```bash
nvm install 24 --reinstall-packages-from=current
nvm alias default 24
```

> `--reinstall-packages-from` 会把旧版本的全局包（如 codex）迁移过来。若迁移因本地包（ETARGET）中断，请逐个重装。

### 2. Codex（可选）

```bash
npm i -g @openai/codex
codex   # 首次运行完成登录，或在 ~/.codex/config.toml 中配置 API Key
```

### 3. DeepSeek Harness（可选）

```bash
npm i -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs @deepseek-ai/dsh
```

> npm 11 默认拦截安装脚本，必须带 `--allow-scripts`，否则 dsh 执行命令所需的原生模块不完整。

配置 API Key（在 [platform.deepseek.com](https://platform.deepseek.com) 创建）。dsh 无头模式只从环境变量、项目 `.env`、`~/.dsh/.env` 读取 Key，**不读图形界面里保存的 Key**：

```bash
mkdir -p ~/.dsh
printf 'DEEPSEEK_API_KEY=%s\n' '<你的 Key>' > ~/.dsh/.env
chmod 600 ~/.dsh/.env
```

### 4. 安装插件

```bash
claude plugin marketplace add aa41/cc-agent-bridge
claude plugin install cc-agent-bridge@mxc-skills
```

重启 Claude Code 会话后生效。在会话中说"检查一下 cc-agent-bridge 的环境"，Claude 会运行 `doctor`，并列出缺失项和修复命令。

## 使用

直接用自然语言说，Claude 会自动选用本插件：

- "用 codex 实现 `src/cart.ts` 的折扣计算，要求测试全部通过，你来审查"
- "把这个计划拆成任务，重构部分交给 codex，补测试部分交给 deepseek"
- "让 deepseek 只读地审查一下 `auth/` 目录，给第二意见"

也可以显式调用：`/cc-agent-bridge:delegate codex 实现……`

Claude 的固定流程：检查环境 → 读代码、拆任务 → 写自包含任务包 → 委派 → 等待 → 读 diff、亲自跑测试 → 通过则合入（不提交），不通过则带审查意见返工（最多 3 轮）→ 汇报谁做了什么、验证结果、用量。

### 在 `claude -p` / 脚本中使用

无头模式默认拒绝未授权工具，需要放行 Skill 工具：

```bash
claude -p "用 codex 实现 X，测试通过后合入" \
  --allowedTools "Skill(cc-agent-bridge:delegate)" "Bash(npm test*)" \
  --permission-mode acceptEdits
```

## bridge 命令参考

Claude 会自动调用这些命令，一般不需要手动执行。脚本位于 `skills/delegate/scripts/bridge.mjs`。

| 命令 | 作用 |
|---|---|
| `doctor` | 检查依赖、版本、Key、git 状态，给出修复命令 |
| `run --to codex\|deepseek --brief <file> [--mode read\|write] [--background]` | 启动委派。`read`（默认）在原地只读运行；`write` 在 worktree 中运行 |
| `wait <id> [--timeout 540]` | 等待完成；返回 `done:false` 时重复调用 |
| `status <id>` / `list` | 进度、本项目的运行记录 |
| `result <id> [--diff \| --full]` | 摘要 / 完整 diff / 完整 JSON |
| `resume <id> --brief <file>` | 带审查意见在同一会话中返工 |
| `apply <id> [--3way]` | 把改动合入主工作区（不提交），并删除 worktree |
| `cancel <id>` / `clean [--older-than 7d] [--all]` | 取消运行 / 清理已结束的运行 |

常用参数：`--model`（Codex 模型名，或 `deepseek-flash` / `deepseek-v4-pro`）、`--effort low|high|max`、`--timeout`（默认 1800 秒）、`--idle-timeout`（默认 600 秒无输出判定为卡住）。

可用环境变量：`CC_AGENT_BRIDGE_CODEX_BIN` / `CC_AGENT_BRIDGE_DSH_BIN`（指定可执行文件路径）、`CC_AGENT_BRIDGE_MAX_PARALLEL`（默认 3）、`CC_AGENT_BRIDGE_MAX_ROUNDS`（默认 4）。

## 运行文件

都在项目内的 `.cc-agent-bridge/` 下，已通过 `.git/info/exclude` 忽略，不会进入提交：

- `briefs/`：Claude 写的任务包
- `runs/<id>/`：提示词、原始事件流、worker 日志、`diff.patch`、`result.json`
- `worktrees/<id>/`：worker 的工作副本（apply 后删除）

## 安全说明

- worker 被要求不提交、不推送、不调用其他 agent；能否合入由 Claude 审查后决定。
- 嵌套委派被禁止：worker 内再次调用 bridge 会被拒绝。
- Claude Code 的会话变量不会传给 worker；Codex 拿不到 DeepSeek Key，dsh 拿不到 OpenAI/Codex 变量。
- `--mode full`（关闭 worker 沙箱）默认禁用，只能在检测到容器/VM 时配合 `--i-am-in-a-sandbox` 使用。

## 更新与卸载

```bash
claude plugin marketplace update mxc-skills && claude plugin update cc-agent-bridge
claude plugin uninstall cc-agent-bridge
```

## 排障

见 [skills/delegate/references/troubleshooting.md](skills/delegate/references/troubleshooting.md)。

## 开发

在仓库根目录：

```bash
node --test plugins/cc-agent-bridge/tests/*.test.mjs   # 单元 + 端到端（用假 CLI 回放真实事件流）
claude --plugin-dir ./plugins/cc-agent-bridge          # 仅当前会话加载，不安装
claude plugin validate plugins/cc-agent-bridge
```
