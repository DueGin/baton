# baton 设计（绑定契约）

> 版本 0.1，2026-11-10。这是各模块共同遵守的契约。改动契约（本文件、`packages/protocol`、`packages/server/src/driver/types.ts`）只能由 lead 做；worker 发现契约有问题时，在交付说明里写出来，不要自行修改。
>
> 背景调研：`~/Documents/调研/委派agent客户端/调研与方案草案_2026-11-10.md`。

## 1. 目标

baton 是一个本地 agent 客户端。它和 Paseo 一样，**识别并驱动本机已装的 agent**（Claude Code、Codex、pi，以及任何 ACP agent），不自己实现 agent 循环。它在此基础上加了两样东西：

1. **天然委派**。由 baton 启动的每个 agent 都自动带上委派工具，可以把活派给本机任何已识别的 agent，包括跨厂商。委派关系、任务书、结果、状态和用量都是一等数据。以后的其他协作模式（MA-xx）复用同一个内核。
2. **可观测性**。每个节点的状态、每一轮对话、每次工具调用、每个权限请求都带起止时间记录下来。Web 控制台提供**拓扑图**（节点图）、**时间线**（甘特图）和**节点详情**，全部实时更新，也能回放。

**本期不做**：多用户、远程访问和 relay、移动端、桌面壳、git worktree 隔离（P2）、预算硬停以外的计费、协作模式库（P3）。

## 2. 总体结构

```
packages/
  protocol/   共享类型：记录、事件、REST API、MCP 工具的输入输出（zod）。server 和 web 都依赖它
  providers/  从 Paseo 移植的 provider 层（Apache-2.0，见 NOTICE）：通用 ACP，加上 Claude（Agent SDK）、Codex（app-server）、Pi（RPC）原生接入
  server/     daemon 和 CLI。目录划分：
                driver/      AgentDriver 接口（契约），以及 providers → driver 的适配器
                catalog/     识别本机 agent
                store/       SQLite 事件存储和投影
                kernel/      运行、节点、委派内核
                mcp/         注入给每个节点的 MCP 服务（Streamable HTTP）
                api/         REST + SSE，静态托管 web
                telemetry/   导出 OTLP、JSON、Markdown
                cli/         baton 命令
  web/        控制台：Vite + React 19 + @xyflow/react
```

**运行时**：Node ≥ 22.13（本机是 24），TypeScript 5.9，ESM。server、providers、protocol 用 `tsc` 编译到 `dist/`，开发时用 `tsx`。测试统一用 vitest。存储用 `node:sqlite`。

**默认值**：

| 项 | 默认 |
|---|---|
| 数据目录 | `~/.baton`（可用 `BATON_HOME` 覆盖） |
| 监听地址 | `127.0.0.1:7433` |
| 配置文件 | `~/.baton/config.json` |
| 数据库 | `~/.baton/baton.db` |
| 控制台 token | `~/.baton/token`，权限 0600 |

**不要碰端口 6767**，那是 Paseo daemon 的端口，用户正在用。

## 3. 概念与数据模型

类型的唯一来源是 `packages/protocol/src/records.ts`，这里只讲语义。

| 概念 | 说明 |
|---|---|
| **Agent**（`AgentEntry`） | 识别出来的一种 agent，例如 `claude`、`codex`、`pi`、`gemini`。字段包括 kind（`native` 或 `acp`）、可用状态、版本、模型、模式 |
| **Project**（项目） | 登记过的一个工作目录（realpath，不允许重复）。**所有 Run 都必须属于某个项目**，没有项目就不能开会话。项目可以重命名、归档：归档后从侧栏隐藏，它的 Run 仍然保留、可以查看 |
| **Run** | 一次协作（会话）。在某个项目下，选一个 agent，发出第一条消息，就建了一个 Run 和它的根节点。工作目录默认就是项目路径，也可以指定项目内的某个子目录。一个 Run 可以有多轮对话 |
| **Node** | Run 里的一个 agent 会话实例（一个 provider 会话）。根节点由用户创建，其它节点都由委派产生 |
| **Delegation**（边） | 父节点到子节点的一次委派，带任务书、状态、结果和用量汇总。`kind` 本期只有 `delegate`，以后的协作模式会加新的 kind |
| **Turn** | 节点的一轮执行。`trigger` 记录这一轮由什么触发：`user`（人发消息）、`delegation`（任务书）、`result`（子节点结果送达）、`followup`（父节点追问） |
| **ToolSpan** | 一次工具调用。起止时间取自第一次和最后一次看到这个 callId 的时刻 |
| **Permission** | 一次权限请求和它的处理结果，记录由谁处理（`human` / `policy` / `parent`）和等了多久 |
| **Event** | 只追加的事件日志。所有记录都由事件投影得到，见 §6 |

**节点状态 `NodeStatus`**：

```
starting → running ⇄ idle
              ↘ waiting_permission ↗
idle / running 时如果有未完成的子委派，派生显示为 waiting_children（只用于展示，不落库）
终态：completed（委派已交付结果）| failed | canceled
interrupted：daemon 重启时，正在运行的节点会被标成这个状态，以后可以续跑
```

子节点交付结果后状态是 `completed`。之后如果父节点追问（`send`），它会回到 `running`，委派的轮次（`round`）加一。

## 4. 委派语义

### 4.1 注入方式

- daemon 在 `/mcp/n/<nodeToken>` 上提供 MCP（Streamable HTTP）。
- 每个节点打开会话时，都会注入 `mcpServers.baton = { type: "http", url: "http://127.0.0.1:7433/mcp/n/<nodeToken>" }`。
- token 是 32 字节随机数，和节点一一对应，节点进入终态并关闭后作废。**调用者身份由 token 决定**，agent 自己无法声称是别的节点。
- 同时会追加一段系统提示（`kernel/prompts.ts`），说明有哪些工具、委派结果会自动送达、不要轮询。

### 4.2 工具

所有工具都对所有节点开放。输入输出的 schema 在 `protocol/src/mcp-tools.ts`。

| 工具 | 作用 |
|---|---|
| `list_agents` | 列出可用的 agent：模型、模式、说明（profile notes）、当前负载 |
| `delegate` | 派活。返回 `{delegationId, nodeId}`，**立即返回、不等待**。参数：`role`（按团队角色）或 `agent`、`model?`、`mode?`、`title`、`task`、`context?`、`acceptance?`（验收标准）、`readonly?`、`outputSchema?`（JSON Schema） |
| `wait` | 有界阻塞，等若干委派完成。`timeoutSec` 默认 45，最大 50，因为 Codex 的 MCP 工具默认超时是 60 秒。返回已完成委派的结果，并标记为已送达，避免重复通知 |
| `get_result` | 取完整结果：`result`、最后一条回复全文、产出物、用量 |
| `send` | 给自己的子节点追问或补充。子节点正在运行且支持插话时用 steer，否则开新的一轮 |
| `cancel` | 取消一个委派，**级联取消所有子孙** |
| `status` | 我的委派及其子树的状态摘要 |
| `report_result` | **子节点**交付结果：`{status: success｜partial｜failed, summary, result?, artifacts?}`。调用后应结束这一轮。根节点调用会报错 |
| `ask_human` | 向人提问（判断、缺失信息、有风险的取舍）；答案以 `<baton-answer>` 送达，见 §4.6 |
| `form_team` | **仅主导者**（dynamic）：按需求组建团队——角色、由哪个 agent/模型担任、职责、理由。可多次调用追加角色 |
| `get_team` | 查看团队：角色、担任者、职责、各自的委派 |
| `replace_member` | **仅主导者**：给某个角色换人；默认把旧成员未完成的委派连同进展摘要改派给新成员 |
| `reassign` | 把自己的某个委派改派给另一个角色或 agent：停掉当前 delegate，新 delegate 拿到同一份任务书加上前任的进展摘要 |

**只能操作自己的直接子委派**：`send`、`cancel`、`get_result`、`wait`、`reassign` 都会校验委派属于调用者，否则报错。`form_team`、`replace_member` 只有根节点能调用。

### 4.3 生命周期

1. **校验**：父节点调用 `delegate` 后，内核依次检查：
   - 深度：子节点深度 ≤ `maxDepth`，默认 3，根节点深度为 0
   - 父节点的活跃子委派数 ≤ `maxActiveChildren`，默认 6
   - 全局活跃节点数 ≤ `maxActiveNodes`，默认 12
   - Run 的预算没超
   - agent 可用

   任何一项不满足就返回工具错误，说明原因。
2. **建子节点**：内核创建 Node 和 Delegation（状态 `queued`），打开 provider 会话（注入 MCP 和系统提示），用任务书模板拼出第一条 prompt，开始第一轮。委派状态随之变为 `running`。
3. **子节点结束一轮时**：
   - 调用过 `report_result`：用它报告的结果。
   - 没调用：用最后一条 assistant 回复当 `summary`，并标记 `reported: false`。
   - 有 `outputSchema` 时，校验 `result`。不符合就给子节点发一条纠正 prompt，最多 2 次，仍失败则委派 `failed`。
   - 这一轮失败（`turn_failed`）：委派 `failed`，附上错误信息。
4. **送达**：
   - 结果先排进父节点的待送达队列，去抖 1500ms 后合并成一条 `<baton-results>` 消息。
   - 父节点空闲：开一轮新的（trigger=`result`）。
   - 父节点在运行且支持插话：steer 进去。
   - 父节点在运行但不支持插话：等这一轮结束再开新的一轮。
   - 每条结果内联最多 8000 字符，超出部分注明"用 `get_result` 取全文"。
   - 通过 `wait` 拿到的结果不再重复送达。
5. **取消**：`cancel` 或人工取消时，对子树做深度优先：先中断所有子孙（interrupt 后 close），标为 `canceled`，最后处理本节点。
6. **权限**：
   - 子节点的权限请求会出现在控制台，由人处理。
   - Run 级开关 `autoApprove`：开启后，内核按策略自动批准，记为 `by: policy`。
   - 由父 agent 代为审批的功能放到 P2（工具 `respond_permission`）。
7. **只读委派**：`readonly: true` 时，优先选该 provider 的只读或计划模式（Claude 用 `plan`，Codex 选只读沙箱的模式），并在任务书里写明"不准改文件"。
8. **结束**：子节点交付后保持会话，以便追问。Run 结束或空闲超时（默认 30 分钟）后再 close。

### 4.4 根节点和人工介入

- 根节点和普通节点一样有全部工具，只是不能调用 `report_result`。
- 人可以在控制台给**任意节点**发消息（trigger=`user`）、取消任意子树、处理权限请求。

### 4.5 团队与协作方式

每个 Run 有一种协作方式（`RunPolicy.mode`），建 Run 时选：

| 方式 | 根节点的角色 | 团队从哪来 | 委派对象 |
|---|---|---|---|
| `dynamic` 动态组队（默认） | 主导者 | 主导者读完需求后用 `form_team` 组建，之后可追加、换人 | 优先按角色；也可直接指定 agent，这时自动加一个临时成员（`addedBy: agent`） |
| `preset` 预设团队 | 预设里的 lead | 来自 `TeamPreset`，建 Run 时整队带入（`addedBy: preset`） | 只能按预设里的角色 |
| `solo` 单独完成 | 独自干活 | 无 | 不能委派。baton MCP 只注入 `ask_human` 一个工具（§4.6） |

- **成员是"角色槽位"**，不是一个会话：对同一个角色委派三次，会开三个节点，都用这个角色的 agent/模型/模式。节点和委派都记录 `role`、`memberId`。
- **团队是 Run 级的**，所有层级的委派都受它约束（preset 下子节点也只能按角色派）。只有根节点能改名单；人在控制台随时可以加人、换人、移除。
- **换人**（`replace_member` 或人工）：旧成员标 `replaced`，新成员 `replaces` 指回旧成员。`reassignActive` 为真时，旧成员所有未完成的委派逐个改派。
- **改派**（`reassign`、人工改派、换人时的连带改派），步骤如下：
  1. 级联取消旧委派的子树。旧节点标 `replaced`，旧委派标 `replaced` 并记下 `replacedBy`、`replaceReason`。
  2. 生成"前任进展摘要"：旧节点最后一条 assistant 回复（≤2000 字）、它改过的文件列表（来自 edit/write 工具调用）。摘要追加到任务书的 `context`。
  3. 由同一个父节点新建委派，记下 `replaces`，用新成员的配置开节点，立即开始。
  4. 如果改派不是父节点自己发起的（人工或换人连带），给父节点送一条 `<baton-notice>`，告诉它旧 id → 新 id。送达方式和结果送达相同。
- **名单确认**（`RunPolicy.teamApproval`，默认开）：agent 发起的名单变化都先变成一份待确认的提案（`TeamProposal`），不立即生效。包括 `form_team`、`replace_member`、按 agent 直接派活时产生的临时成员。
  - 工具返回 `pending_approval` 和提案 id。提示词要求主导者此时结束本轮，等通知。
  - 提案待定期间，派给提案中角色的委派处于 `queued` 状态，并记下 `blockedByProposal`，批准后自动开工。同一时刻只允许一份待定提案，再提交会报错。
  - 人在控制台可以直接批准、修改后批准，或者驳回并写明理由。
    - 修改后批准时，按人改过的名单生效。被删掉的角色，其排队中的委派会被取消。
    - 驳回时，排队中的委派全部取消。
  - 无论批准还是驳回，都给发起提案的节点送一条 `<baton-notice>`，包含结论、人做的改动和留言。主导者据此继续派活或重新组队。
  - 人自己在控制台做的名单改动立即生效，不走提案。
- **名单变化**都发 `team.updated` 事件（带完整名单和这次的 `TeamChange`），`TeamRecord.changes` 保留历史，时间线据此画标记。
- **预设团队**（`TeamPreset`）存在 SQLite，用 `/api/teams` 增删改查；也可以把某个 Run 当前的名单"另存为预设"。
- **提示词**：
  - 主导者：先组队再派活，团队越小越好。只有简单问题或单个小文件的修改才由它自己做（也就是不组队）。有成员失败、太慢或不合适时，主导者主动换人或改派。
  - 成员：写明它的角色、职责，以及团队里其他人分别负责什么，避免撞文件。

### 4.6 人在回路：收件箱、提问、升级、审批规则

原则：agent 自己能决定的不打扰人。只有需要判断的事才进**跨 Run 的待处理收件箱**，有四类：权限请求、名单提案、agent 的提问、内核升级。

- **提问 `ask_human`**：任何节点都可以调用，参数是 `{question, options?, blocking}`。
  - 工具立即返回 `{questionId, status:"pending"}`，不阻塞 MCP 调用，因为工具调用有超时。`blocking` 为真时，提示词要求节点结束本轮，此时节点卡片显示"等你回答"。
  - 人在收件箱回答后，答案以 `<baton-answer question="<id>">…</baton-answer>` 发给提问的节点，送达方式和结果送达相同：steer、新开一轮或排队。
  - Run 取消或节点进入终态时，未回答的提问标为 `canceled`。
- **停滞升级**：节点处于运行中的一轮里，超过 `stallMinutes` 分钟（默认 10）没有任何 driver 事件，内核就生成一条 `stall` 升级。
  - 非根节点：同时给父节点发 `<baton-notice>`，建议父节点 `send`、`reassign` 或 `cancel`。
  - 同一段停滞只升级一次，收到下一个事件就重置。
  - 人可以把它标为"忽略"；如果要取消，可以在升级卡片上直接取消对应的委派。
- **轮次上限升级**：父节点对同一个委派的 `send` 会让 `round` 超过 `maxRoundsPerDelegation`（默认 3）时，这条消息不发出，暂存进 `round_limit` 升级。
  - 工具返回 `{status:"escalated", escalationId}`，提示词要求父节点结束本轮。
  - 人可以选择：
    - 延长（`extraRounds`，默认 +2），暂存的消息随即发出；
    - 取消这个委派；
    - 忽略（消息作废）。
  - 无论选哪个，都给父节点发 `<baton-notice>`，附上人的留言。
- **审批规则（`PermissionRule`）**：在 `autoApprove` 和人工审批之前，先按确定的规则匹配，不用模型判断。
  - 规则字段：toolName 精确匹配，`*` 表示任意；agentId 可选；pattern 对 shell 命令按前缀匹配、对文件路径按 glob 匹配，路径相对 Run 的 cwd。
  - 优先级：先看 `deny` 规则，再看 `allow`；本 Run 的规则优先于全局规则。命中后记 `resolvedBy:"rule"`，带上 `ruleId`，规则的 `hits` 加一。
  - 人批准时可以勾选"总是"（`remember`），同时生成一条规则。也可以在设置页增删规则。
  - 人拒绝时，发给 agent 的拒绝消息固定为："The human denied this action. Do not retry it; choose a different approach or ask_human."
- **收件箱**：
  - `GET /api/inbox` 返回全部待处理项。`GET /api/inbox/events` 是 SSE，有变化时推送 `changed`。
  - 顶栏和左侧导航的"待处理"数字用的是 `RunSummary.pendingTotal`。
- **通知**：只在两种时候发。
  - 新的待处理项出现时：permission、proposal、blocking question、escalation。
  - Run 完成时：根节点空闲且没有活跃节点。

  daemon 在 macOS 上用 `osascript` 发系统通知，可以用 `config.json` 里的 `notifications.desktop=false` 关掉。控制台在浏览器授权后也会发 Notification。同一个 Run 30 秒内的通知合并成一条。
- **成员默认规则**（提示词）：
  - 只改任务书给你的文件；
  - 不运行 `git commit/push/merge/rebase/checkout/reset/stash`，集成由主导者负责；
  - 缺信息时先自己查，查不到再 `ask_human`。
- **团队规模**：`maxTeamSize` 默认 5，超出的 `form_team` 和追加会被拒绝。主导者提示词要求优先复用已有成员。职责要写成路由约定："派给我：…；别派给我：…"。

### 4.7 Run 标题

- 新建 Run 时，先用第一条消息的开头作为临时标题，`titleSource:"prompt"`。
- 如果配置了标题模型（`TitleModelSettings`，任何 OpenAI 兼容的 chat-completions 端点），daemon 在后台用它为这个 Run 起名。
  - 提示词要求：只输出一个标题，不超过 16 个汉字或 6 个英文词，语言与请求一致。
  - 成功后发 `run.updated`，`titleSource:"generated"`。
  - 请求 15 秒超时，最多重试 1 次。
  - 失败时保留临时标题，并记一条 `log` 事件（level warn）。
- 清洗输出：去掉引号、Markdown、代码围栏、`<think>` 段、换行之后的内容、末尾的标点，以及"标题："之类的前缀。网关注入的人设口癖也要去掉：开头出现"爸爸"等称呼加逗号的形式时剥掉。清洗后为空，或长度超过 40 个字符，都视为失败。
- 人改过标题（`PATCH title`）后，`titleSource:"human"`，之后永不自动覆盖。
- `POST /api/runs/:id/title/regenerate` 可以强制重新生成，人改过的标题也会被覆盖。
- 设置存在 `config.json` 的 `titleModel` 字段，文件权限 0600。密钥只写不读，API 永远不返回密钥。也可以改用 `apiKeyEnv` 从环境变量读取。

### 4.9 项目

- **登记**：`POST /api/projects {path, name?}`。
  - 路径会展开 `~`，再取 realpath。必须是已存在的目录。
  - 如果这个路径已经登记过，直接返回已有的项目；归档过的会自动恢复。
  - 名称默认取目录名。如果目录在 git 仓库里，记下 `gitRoot`。
- **建 Run**：`CreateRunRequest.projectId` 必填，项目不存在或已归档就报错。
  - `cwd` 不填时用项目路径。填了的话，realpath 之后必须是项目路径本身或项目内的子目录，否则返回 400。
  - CLI：`baton run --project <id｜路径>`。给的是路径而且还没登记，就自动登记。
- **迁移**：daemon 启动时，没有 `projectId` 的旧 Run 按 cwd 归组：每个不同的 cwd 自动建一个项目（cwd 已不存在也照建，`exists:false`），再给这些 Run 补上 `projectId`。补的时候发 `run.updated` 事件。迁移只做一次，可以重复执行而不出错。
- **项目汇总**（`ProjectSummary`）：Run 数、活跃 Run 数、待处理数、后台进程数、最近一次 Run 的时间、git 分支、目录是否还存在。git 分支用 `git -C <path> branch --show-current` 查，超时 1 秒，结果缓存 10 秒。
- **目录浏览**：`GET /api/fs/dirs?path=…`，给"添加项目"用。只列目录，不读任何文件内容，默认不列隐藏目录。每一项标明是不是 git 仓库、是不是已经登记的项目。和其他 API 一样要 token 鉴权。
- **归档**：`PATCH archived:true`。有活跃 Run 的项目不能归档，返回 409。不提供硬删除。

### 4.8 后台进程登记

agent 常会启动长期运行的进程，比如 `npm run dev`、`nohup … &`、watcher，或者 Claude 的 `run_in_background`。人往往不知道这些进程是哪个会话启的，还一直在跑。daemon 负责发现这些进程，记到对应 Run 和节点名下，在控制台里展示，并允许人停止它们。

**实测事实**（macOS 15）：
- `ps` 读不到其他进程的环境变量，所以没法靠注入环境变量来标记进程。
- Claude 的 Bash 工具会为每次工具调用新建一个进程组。`nohup x &` 产生的进程几毫秒后就被 launchd（ppid=1）收养，但保留着那个已退出的 shell 的 pgid。

**归属规则**（按顺序判断，越靠前越确定）：
1. **`tree`**：扫描时，进程的祖先链能追到某个节点的 agent 进程（`DriverSession.processIds()`）。
2. **`group`**：进程的 pgid 等于这个节点曾经出现过的某个子孙进程的 pid 或 pgid。daemon 把扫描中见过的、属于该节点的 shell 的 pgid 记下来，进程被收养后仍能据此归属。
3. **`inferred`**：前两条都不满足的孤儿进程（ppid=1），同时满足两个条件：
   - 启动时间落在该节点某次 shell 工具调用的窗口内，即 [开始 −1s, 结束 +3s]；
   - 它的 cwd（realpath）在该节点的 cwd 之下。

   如果多个节点都符合，优先选工具命令文本里包含该进程可执行文件名的那个，再不行就选最近开始的那次调用。UI 上标"推断"。

**判定为"后台"**：归属到某个节点、且不是基础设施的进程，满足以下任一条件：
- 在监听 TCP 端口；
- 在启动它的那次 shell 工具调用结束 5 秒后仍然存活；
- 是孤儿（`inferred` / `group`）。

基础设施要排除：agent 进程本身，以及节点在没有任何 shell 工具调用进行时出现的子孙进程，例如会话启动时的 MCP server、language server。

**折叠**：同一族进程只登记最顶层的那一个，子孙列进 `children`，端口汇总。例如 `npm run dev` 下面的 `node vite` 会折叠进 `npm run dev` 这一条。

**扫描**：
- 用 `ps -axo pid=,ppid=,pgid=,lstart=,command=`、`lsof -nP -iTCP -sTCP:LISTEN -Fpn`，候选进程的 cwd 用 `lsof -a -d cwd -p … -Fpn` 查。
- 频率：有活跃回合时每 3 秒一次；每次 shell 工具调用结束后 2 秒补扫一次；其他时候每 20 秒一次。
- 每个后台进程用 `pid + 启动时间` 作为 id，防止 pid 被复用后认错进程。进程消失，或同一 pid 的启动时间变了，就记为 `exited`。已退出的记录保留 24 小时。
- 记录落库，daemon 重启后继续跟踪。
- 支持 macOS 和 Linux；Windows 不支持，直接返回空列表。

**停止**（`POST /api/background/:id/stop`）：只允许停止已登记的进程。
- 如果它的 pgid 只包含这一族进程，并且不是 daemon 或 agent 的进程组，就对整个组发 `kill(-pgid, SIGTERM)`；否则从最深处开始，逐个对子树里的 pid 发 SIGTERM。
- 等待 `graceMs`（默认 5 秒）后，对仍存活的发 SIGKILL。
- 过程中状态为 `stopping`，结束后为 `exited`，并记 `stoppedBy:"human"`。

**其他行为**：
- `dismiss`：把记录从列表里隐藏，仍然继续跟踪。
- 取消 Run 时可以选择一并停止后台进程（`CancelRunRequest.stopBackground`，默认否）。
- Run 完成的通知里会附上"仍有 N 个后台进程在运行"。
- 节点系统提示里加一句："启动长期运行的进程后，在回复里告诉人它是什么、端口和怎么停止。"

## 5. Driver 接口（server 和 providers 之间的边界）

契约文件是 `packages/server/src/driver/types.ts`。内核只依赖这个接口：

- **测试**用 `FakeDriver`，它可以按脚本运行，而且会**真的通过 HTTP 调用 baton 的 MCP 工具**来模拟 agent 委派。
- **生产**用 `PaseoProviderDriver`，在 `server/src/driver/paseo-adapter.ts`，把 `@baton/providers` 的 `AgentClient`/`AgentSession`/`AgentStreamEvent` 翻译成 `DriverEvent`。

`DriverEvent` 和 `TimelineItem` 尽量沿用 Paseo 的形状（`ToolCallDetail`、`AgentUsage`、权限请求和响应），让适配器保持很薄。

## 6. 事件与存储

- **事件信封**：`{ runId, seq, ts, type, ...payload }`，`seq` 在一个 Run 内单调递增。事件类型清单见 `protocol/src/events.ts`。
- **清空字段**：JSON 里的 `undefined` 会被丢掉，浅 patch 删不掉可选字段。需要清空字段时（例如追问后清掉旧 result），改发对应的 `*.created` 事件整条覆盖，`applyEvent` 对它按 upsert 处理。
- **写入**：一个事件 = 一个 SQLite 事务，同时完成两件事：①追加到 `events` 表；②更新投影表（`runs`、`nodes`、`delegations`、`turns`、`tool_spans`、`permissions`、`items`）。
- **assistant 文本**：provider 发来的是增量或"不断增长的整条消息"。内核把它们合并进同一条 item，并按约 100ms 一次合并发出 `item.delta` 事件，避免事件爆炸。
- **快照**：`GET /api/runs/:id` 从投影表读出 `RunSnapshot`，其中带 `lastSeq`。客户端之后用 SSE 从 `lastSeq` 续订。
- **重启恢复**：
  - `running`、`starting`、`waiting_permission` 的节点标为 `interrupted`，`queued` 和 `running` 的委派标为 `interrupted`。
  - 被打断的节点在下一次收到消息时，用存下的 `persistence` 句柄续跑。

## 7. API

- **鉴权**：所有 `/api/*` 都要带 `Authorization: Bearer <token>`。SSE 请求不方便带 header 时，可以用 `?token=`。
- **防 DNS 重绑定和 CSRF**：校验 `Host` 为 `127.0.0.1:<port>` 或 `localhost:<port>`，校验 `Origin`（存在时必须同源），只接受 JSON 请求体。
- **启动输出**：`baton serve` 会打印 `http://127.0.0.1:7433/#token=...`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/agents` | `AgentEntry[]`（带缓存） |
| POST | `/api/agents/refresh` | 重新探测 |
| GET | `/api/runs` | `RunSummary[]` |
| POST | `/api/runs` | `CreateRunRequest` → `RunSnapshot` |
| GET | `/api/runs/:runId` | `RunSnapshot` |
| GET | `/api/runs/:runId/events?after=<seq>` | SSE（也支持 `Last-Event-ID`）。非 SSE 请求返回 JSON 数组 |
| POST | `/api/runs/:runId/cancel` | 取消整个 Run，可带 `CancelRunRequest.stopBackground` |
| PATCH | `/api/runs/:runId` | 修改 `title`（记为 `titleSource:"human"`）、`policy` |
| POST | `/api/runs/:runId/title/regenerate` | 用标题模型重新生成标题（§4.7） |
| GET/PUT | `/api/settings` | `SettingsResponse` / `UpdateSettingsRequest`（标题模型等） |
| POST | `/api/settings/title-model/test` | `TestTitleModelRequest` → `TestTitleModelResponse` |
| GET | `/api/nodes/:nodeId/items?after=<itemSeq>` | 节点 transcript |
| POST | `/api/nodes/:nodeId/messages/:itemSeq/deliver` | `DeliverMessageRequest`：排队消息改为引导，或者立即发送（中断当前回合） |
| DELETE | `/api/nodes/:nodeId/messages/:itemSeq` | 撤回仍在排队的消息 |
| PUT | `/api/nodes/:nodeId/queue` | `ReorderQueueRequest`：调整排队消息的顺序 |
| POST | `/api/nodes/:nodeId/messages` | `{ text }`，人给节点发消息 |
| POST | `/api/nodes/:nodeId/cancel` | 级联取消该节点的子树 |
| POST | `/api/permissions/:requestId` | `PermissionDecision`（可带 `remember` 生成规则） |
| GET | `/api/inbox` · `/api/inbox/events` | 跨 Run 待处理项 · 变化推送（SSE） |
| POST | `/api/questions/:id/answer` | `AnswerQuestionRequest` |
| POST | `/api/escalations/:id/resolve` | `ResolveEscalationRequest` |
| GET/POST | `/api/permission-rules` | 列出 / 新建审批规则 |
| GET | `/api/projects?archived=1` | `ProjectSummary[]`（默认不含已归档的） |
| POST | `/api/projects` | `CreateProjectRequest` → `ProjectRecord`（路径已登记时返回已有项目） |
| GET/PATCH | `/api/projects/:id` | 项目汇总 / `PatchProjectRequest`（改名、归档） |
| GET | `/api/runs?projectId=…` | 只看某个项目的 Run |
| GET | `/api/fs/dirs?path=…` | `ListDirsResponse`，目录浏览 |
| GET | `/api/background?status=running｜all` | 跨 Run 的后台进程（默认只返回运行中、未隐藏的） |
| POST | `/api/background/:id/stop` | `StopBackgroundRequest` |
| POST | `/api/background/:id/dismiss` | `DismissBackgroundRequest` |
| DELETE | `/api/permission-rules/:id` | 删除规则 |
| GET | `/api/delegations/:id` | 完整的委派记录和结果 |
| POST | `/api/delegations/:id/reassign` | `ReassignRequest`，人工改派 |
| POST | `/api/runs/:runId/team/members` | `AddMemberRequest`，人工加成员 |
| POST | `/api/runs/:runId/team/members/:memberId/replace` | `ReplaceMemberRequest`，人工换人 |
| DELETE | `/api/runs/:runId/team/members/:memberId` | 移除成员（未完成的委派不受影响） |
| POST | `/api/runs/:runId/team/proposals/:proposalId/approve` | `ApproveTeamProposalRequest`，批准（可带修改） |
| POST | `/api/runs/:runId/team/proposals/:proposalId/reject` | `RejectTeamProposalRequest`，驳回并说明理由 |
| POST | `/api/runs/:runId/team/save-preset` | `SaveTeamPresetRequest`，当前名单另存为预设 |
| GET/POST | `/api/teams` | 列出 / 新建预设团队（`TeamPresetInput`） |
| PUT/DELETE | `/api/teams/:id` | 修改 / 删除预设团队 |
| GET | `/api/runs/:runId/export?format=json｜otlp｜md` | 导出 |
| ALL | `/mcp/n/:nodeToken` | MCP Streamable HTTP，**不走** Bearer 鉴权，凭 token 识别节点 |

## 8. 控制台（web）

左栏是 Run 列表，加一个"新建 Run"按钮。主区是当前 Run，有三个视图标签，右侧是可开关的节点详情抽屉。

1. **拓扑图**（`@xyflow/react` + `@dagrejs/dagre`，自上而下的树形布局）：
   - 节点卡片显示：provider 色标和名称、标题、模型、状态徽章（运行中有呼吸动画）、当前活动（最近一个运行中的工具或"思考中"）、已用时长、token 和费用、子节点数。
   - 边显示：委派标题、状态颜色，运行中有流动动画，完成后显示结果徽章（✓ / 部分 / ✗）。
   - 节点有待处理权限时卡片高亮，可以直接批准或拒绝。
   - 支持缩放、平移、小地图、"跟随最新"开关。
2. **时间线**（自己用 SVG 画）：时间轴只统计这个会话自己的工作时间，不跟随现实时钟。
   - **只看这个会话**：时间轴的起点是 Run 的第一个事件，终点是最后一个事件。Run 还在运行时，终点是正在进行的回合的最新时刻。没有"现在"竖线，也不会随着现实时间推移自动拉长。
   - **折叠空闲**（默认开启）：把所有节点的回合区间取并集，得到"工作区间"。任何节点都没有活跃回合的空档超过 60 秒，就折叠成一段固定宽度（约 28px）的断轴标记，带锯齿，标注"空闲 2h 13m"。悬停可以看到起止的现实时间。
     - 折叠后，时间轴刻度显示**会话工作时间**，例如 0:00、5:00、12:30，即从开始累计的工作时长。悬停任何元素时，同时显示工作时间和现实时间。
     - 可以切换成"真实时间"模式：不折叠，刻度显示现实时钟。
   - **统计条**（时间线上方）：
     - 工作时长：工作区间的总长；
     - 跨度：从第一个事件到最后一个事件的现实时长；
     - 折叠了几段空闲；
     - 并行度：工作时长内平均同时活跃的节点数；
     - 每个节点的工作时长和占比，悬停在行标签上时显示。
   - 每个节点一行，按树缩进。可以缩放和拖动，"跟随最新"会把视图停在最新活动处。
   - 每行叠放这些条带：
     - 节点存活期：浅色底
     - 每一轮：实色，按 trigger 着色
     - 工具调用：细条，按工具类型着色
     - 权限等待：斜纹
     - 等待子节点：虚线
   - 委派发起时，从父行画一条箭头到子行起点；结果送达时，再画一条箭头回父行。悬停显示详情，点击打开节点详情。
3. **会话**：可以看根节点，也可以切换到任意节点。体验要求如下：
   - **发送即可见**：点发送后，消息立刻以"发送中"出现在对话里（乐观更新），服务端返回后显示投递方式：
     - 已开始新一轮；
     - 已插入当前回合（steer）；
     - 排队中：当前回合结束后送达。排队的消息也会立即落库成 `user_message`，标 `delivery:"queued"`；送达时同一行改成 `"turn"`。
   - **发送模式**（节点忙、有正在运行的回合时才有区别；节点空闲时一律直接开新的一轮）：
     - **默认排队**，可以连续排多条。
       - 排队中的消息不显示在对话流里，而是集中放在输入框上方的**排队区**（可折叠），按 `queuePosition` 从上到下排列。
       - 排队区标题写明："当前回合结束后，这 N 条消息会按顺序合并发送"。
       - 送达时，每条消息在合并后的提示里按顺序出现，各自的行都改成 `turn`。
     - **调整顺序**：可以拖动手柄，也可以用每条上的上移/下移图标（键盘可操作）。调整后调用 `PUT /api/nodes/:id/queue {order}`；如果服务端返回 409，说明队列已经变了，重新拉取。
     - **操作按钮全部用图标**，带 tooltip 和 aria-label，放在对应消息上：排队卡片的右侧，或者对话流里消息气泡的右上角。
       - 排队卡片上的图标：拖动手柄、上移、下移、**引导发送**（插入当前回合）、撤回。
       - 引导成功后，消息离开排队区，进入对话流，位置在当前回合的末尾，气泡上带"已插入当前回合"的状态图标。这时气泡上才出现**立即发送**图标（中断当前回合，用这条消息开新的一轮）。
       - 如果 provider 不支持引导，就提示"该 agent 不支持引导"，消息留在排队区，卡片上直接出现立即发送图标。
     - **状态图标**，替代原来的文字徽标：
       - 排队：时钟
       - 已引导：转向箭头
       - 已中断并立即发送：闪电
       - 已送达：对勾
       - 已撤回：撤回箭头，卡片随即从排队区移除
     - **对话流里的位置**：从排队送达的消息，显示在它开启的那一轮最前面，也就是带同样 `turnId` 的第一条记录之前，而不是按发送时的 itemSeq 排。
     - 被中断的回合状态记为 `canceled`，原因是"interrupted by human message"。这个回合**不触发**委派结果的采集，节点的子委派也不受影响。
     - API：
       - `SendMessageRequest.mode`：queue / steer / interrupt。
       - `POST …/messages/:itemSeq/deliver`：升级发送方式。
       - `DELETE …/messages/:itemSeq`：撤回。
       - `PUT …/queue`：调整顺序。
   - **实时状态条**：节点有活跃回合时，对话底部常驻一条状态条，带动画和本轮计时，并按最新事件显示当前阶段：
     - 刚开始，还没有任何事件："已发送，等待响应…"
     - 推理文本流入中："思考中"，实时显示最后 1–2 行推理，点击展开全文
     - 有工具正在执行："正在执行 shell: npm test · 12s"
     - 回复文本流入中："正在回复…"，正文末尾显示光标
     - 等待人："等待授权""等你回答"，附处理入口
     - 等待子节点："等待 N 个子任务"，可以点到对应节点
     - 超过 30 秒没有新事件时，附注"已 45s 无新输出"，告诉人 agent 还活着但很安静

     节点切换下拉框和节点卡片上也要显示同样的运行中标记。
   - **思考过程（reasoning）的显示**：由浏览器偏好控制，存在 localStorage，设置页可以改，会话工具栏也有快捷切换。三档：
     - 折叠（**默认**）
     - 展开
     - 生成时展开、结束后折叠

     人手动点开或收起某一块，就以人的操作为准，在本页会话内记住。状态条里那一两行推理预览不受这个设置影响。
   - **后台进程入口**：输入框左上角有一个小标签"后台 N"，N 是本 Run 正在运行、未隐藏的后台进程数，为 0 时不显示。有监听端口的进程时，标签高亮。点开是一个列表，每一条包括：
     - 状态点、命令（等宽字体，悬停看全文）
     - 端口，可点击打开 `http://localhost:端口`
     - 由谁启动：agent 头像、节点标题和角色；归属是推断出来的，就加"推断"标记
     - 运行时长、pid、cwd（可复制）
     - 操作：停止（需二次确认）、复制命令、"不是本会话启动的"（隐藏）

     列表底部可以展开"已退出 N 个"。左侧 Run 列表和 Run 详情侧栏也显示后台进程数。
   - **Markdown**：完整支持 GFM，包括标题、列表（含嵌套和任务列表）、表格、引用、删除线、链接、行内代码和代码块。
     - 代码块：语法高亮、语言标签、复制按钮。
     - 安全：不渲染原始 HTML；链接只允许 http、https、mailto，并在新窗口打开。
     - 流式中途 Markdown 没写完（比如代码围栏未闭合）时，也要能正常显示。
     - 所有展示 agent 文本的地方都用同一个渲染器：消息、推理、任务书、结果卡片、详情抽屉、提问、通知、计划。
   - **Mermaid**：` ```mermaid ` 代码块渲染成图。
     - mermaid 按需懒加载，打成单独的 chunk。配置 `securityLevel:"strict"`，主题跟随明暗模式。
     - 渲染出的 SVG 再用 DOMPurify 清洗一遍后插入。这是唯一允许插入 HTML 的地方。
     - 流式中（围栏未闭合，或者所在消息还在更新）先显示源码，标注"图表生成中"，停止更新约 500ms 后再渲染。
     - 语法错误时显示源码和错误信息。
     - 图上提供"源码/图"切换和全屏查看。

4. **节点详情抽屉**：
   - 内容：任务书、结果（含 JSON）、transcript（消息、思考、工具调用的输入输出可折叠）、用量、权限记录。
   - 操作：发消息、取消。

5. **名单确认**：有待定提案时，顶栏"待处理"计数会算上它，拓扑图上方出现醒目的确认卡片，团队标签上有红点。确认卡片里：
   - 能看到主导者的理由，以及每个角色的 agent、模型、职责。
   - 可以就地改 agent、模型、职责，删除或增加角色。
   - 操作有"批准""修改后批准""驳回（写理由）"。
6. **团队面板**（Run 视图里的第四个标签"团队"，拓扑图顶部也有简版名单条）：
   - 名单：角色、担任者（agent + 模型）、职责、谁加的、理由、当前委派数和状态。
   - 操作：加成员、换人（可选"同时改派未完成的任务"）、移除、另存为预设。
   - 变更历史：组队、加人、换人、移除，带时间和理由。
7. **拓扑图和时间线中的团队信息**：
   - 节点卡片显示角色标签。
   - 被替换的节点置灰，标"已替换"，用虚线连到接手的节点。
   - 节点卡片和详情抽屉里有"改派"按钮。
   - 时间线根节点那一行标出团队变更。

8. **待处理收件箱**：左侧导航最上方是"待处理"，带数字。按 Run 分组，每类有对应的卡片：
   - 权限卡：允许一次 / 总是允许（可改作用域和 pattern）/ 拒绝；
   - 名单提案卡：可以就地处理，也可以跳到 Run；
   - 提问卡：有选项按钮和自由回答；
   - 升级卡：延长 / 取消 / 忽略，可带留言。

   节点卡片上的"等你回答"和"停滞"都有醒目标记。设置页可以管理审批规则，也可以开关浏览器通知。

10. **右侧详情侧栏**（Run 详情和节点详情共用）：
   - 拖动左边缘可以调宽度，最小 280px，最大 720px，同时不超过视口宽度的 60%。双击恢复默认的 320px。
   - 键盘可以操作：分隔条用 `role="separator"`，方向键调宽度。
   - 宽度存在 localStorage，Run 详情和节点详情共用这一个宽度。
   - 宽屏时侧栏挤压主内容，拓扑图和时间线随之重新适配；窄屏时侧栏浮在内容上方。

11. **项目**：
    - 左侧栏按项目分组：每个项目是一个可折叠的分组头，显示名称、git 分支、活跃数和待处理数，下面是它的 Run 列表。
    - 分组头上有"＋"，在该项目下开新会话；还有菜单：重命名、复制路径、归档。底部有"已归档项目"入口。
    - 当前项目是最近选中的那个，存在 localStorage，"新建 Run"默认用它。
    - 一个项目都没有时，主区显示空状态：先添加一个项目（工作目录）才能开会话。
    - **添加项目**弹窗：可以手动输入路径，也可以用目录浏览器选择。目录浏览器显示 git 仓库标记和"已是项目"标记，有面包屑和返回上级，从 home 开始浏览。
    - **新建 Run** 弹窗：用项目选择器（必选，默认当前项目）代替原来的工作目录输入框；"高级"里可以填项目内的子目录。会按项目记住上次选的 agent、模型和模式。
    - RunBar 和 Run 详情里显示所属项目，点击可以切换到这个项目。

9. **左侧导航栏**：
   - 可以隐藏：点按钮或按 ⌘/Ctrl+B，收起成 48px 宽的图标条，只留新建、待处理（带数字）、Agents、团队、设置和展开按钮。
   - 可以调宽度：拖动右边缘，最小 200px、最大 440px，双击恢复默认 260px。
   - 收起状态和宽度都存在 localStorage。窄屏（≤900px）默认收起，展开时浮在内容上方。
   - 标题旁有"重命名"和"重新生成标题"，标题来源由生成模型生成时，标一个小图标。
   - 设置页有"标题模型"一节：启用开关、Base URL、模型、API Key（只写）或环境变量名，以及"测试"按钮，测试时显示生成的标题和耗时。

另有以下页面：
- **Agents 页**：识别结果和刷新。
- **团队页**：管理预设团队，可以新建、编辑、删除；编辑时设置 lead 和成员表，每一行是角色、agent、模型、模式、职责。
- **设置页**：默认策略。

新建 Run 的弹窗里，"协作方式"三选一：
- 动态组队：可以预先放几个成员。
- 预设团队：选一个预设，根节点自动用预设的 lead。
- 单独完成。

**实时更新的方式**：先取快照，再订阅 SSE。本地 store 做事件归约，所有视图从同一个 store 派生。断线重连时从 `lastSeq` 续订。

## 9. 可观测性导出

- **OTLP**（JSON over HTTP）：
  - 一个 Run 对应一个 trace，一个 Node 是一个 span（`invoke_agent`），它的父 span 是父节点的 span。
  - Turn 是子 span，ToolSpan 是 Turn 的子 span（`execute_tool`）。
  - 属性按 OTel GenAI 语义约定填写：`gen_ai.system`、`gen_ai.request.model`、`gen_ai.usage.input_tokens` 等。
  - 配置 `telemetry.otlpEndpoint` 后实时推送，也可以按需导出文件。
- **JSON**：快照加完整事件流，可以离线回放。
- **Markdown**：可读的报告，包括委派树、每个节点的任务书和结果、用量表。

## 10. 安全

- 只监听 127.0.0.1，控制台用 token 鉴权，并做 Origin/Host 校验。
- MCP 端点凭节点 token 访问。
- 移植的 provider 代码会拉起本机 agent 进程，并且可能处在无人值守模式。默认不开 `autoApprove`。
- 委派工具不是安全边界：子 agent 有 shell 时，可以绕过 baton 直接调用别的 CLI，这部分 baton 观测不到。

## 11. 分期

| 阶段 | 内容 |
|---|---|
| P1（本期） | providers 移植（ACP、Claude、Codex、Pi）；识别本机 agent；内核（委派全流程、级联取消、上限；超预算时拒绝新的委派和追问，不自动取消）；MCP；事件存储；REST/SSE；CLI；控制台三个视图和详情；JSON/Markdown 导出 |
| P2 | OTLP 实时推送、父 agent 代审权限、worktree 隔离、profile 能力卡、原生 subagent（Claude Task）显示为虚线节点 |
| P3 | 协作模式库（MA-00..MA-09）作为跑在内核上的编排程序 |
