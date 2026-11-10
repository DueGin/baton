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
| **Run** | 一次协作。用户在控制台选一个 agent 和工作目录，发出第一条消息，就建了一个 Run 和它的根节点。一个 Run 可以有多轮对话 |
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
| `delegate` | 派活。返回 `{delegationId, nodeId}`，**立即返回、不等待**。参数：`agent`、`model?`、`mode?`、`title`、`task`、`context?`、`acceptance?`（验收标准）、`readonly?`、`outputSchema?`（JSON Schema） |
| `wait` | 有界阻塞，等若干委派完成。`timeoutSec` 默认 45，最大 50，因为 Codex 的 MCP 工具默认超时是 60 秒。返回已完成委派的结果，并标记为已送达，避免重复通知 |
| `get_result` | 取完整结果：`result`、最后一条回复全文、产出物、用量 |
| `send` | 给自己的子节点追问或补充。子节点正在运行且支持插话时用 steer，否则开新的一轮 |
| `cancel` | 取消一个委派，**级联取消所有子孙** |
| `status` | 我的委派及其子树的状态摘要 |
| `report_result` | **子节点**交付结果：`{status: success｜partial｜failed, summary, result?, artifacts?}`。调用后应结束这一轮。根节点调用会报错 |

**只能操作自己的直接子委派**：`send`、`cancel`、`get_result`、`wait` 都会校验委派属于调用者，否则报错。

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

## 5. Driver 接口（server 和 providers 之间的边界）

契约文件是 `packages/server/src/driver/types.ts`。内核只依赖这个接口：

- **测试**用 `FakeDriver`，它可以按脚本运行，而且会**真的通过 HTTP 调用 baton 的 MCP 工具**来模拟 agent 委派。
- **生产**用 `PaseoProviderDriver`，在 `server/src/driver/paseo-adapter.ts`，把 `@baton/providers` 的 `AgentClient`/`AgentSession`/`AgentStreamEvent` 翻译成 `DriverEvent`。

`DriverEvent` 和 `TimelineItem` 尽量沿用 Paseo 的形状（`ToolCallDetail`、`AgentUsage`、权限请求和响应），让适配器保持很薄。

## 6. 事件与存储

- **事件信封**：`{ runId, seq, ts, type, ...payload }`，`seq` 在一个 Run 内单调递增。事件类型清单见 `protocol/src/events.ts`。
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
| POST | `/api/runs/:runId/cancel` | 取消整个 Run |
| PATCH | `/api/runs/:runId` | 修改 `title`、`policy.autoApprove` |
| GET | `/api/nodes/:nodeId/items?after=<itemSeq>` | 节点 transcript |
| POST | `/api/nodes/:nodeId/messages` | `{ text }`，人给节点发消息 |
| POST | `/api/nodes/:nodeId/cancel` | 级联取消该节点的子树 |
| POST | `/api/permissions/:requestId` | `PermissionDecision` |
| GET | `/api/delegations/:id` | 完整的委派记录和结果 |
| GET | `/api/runs/:runId/export?format=json｜otlp｜md` | 导出 |
| ALL | `/mcp/n/:nodeToken` | MCP Streamable HTTP，**不走** Bearer 鉴权，凭 token 识别节点 |

## 8. 控制台（web）

左栏是 Run 列表，加一个"新建 Run"按钮。主区是当前 Run，有三个视图标签，右侧是可开关的节点详情抽屉。

1. **拓扑图**（`@xyflow/react` + `@dagrejs/dagre`，自上而下的树形布局）：
   - 节点卡片显示：provider 色标和名称、标题、模型、状态徽章（运行中有呼吸动画）、当前活动（最近一个运行中的工具或"思考中"）、已用时长、token 和费用、子节点数。
   - 边显示：委派标题、状态颜色，运行中有流动动画，完成后显示结果徽章（✓ / 部分 / ✗）。
   - 节点有待处理权限时卡片高亮，可以直接批准或拒绝。
   - 支持缩放、平移、小地图、"跟随最新"开关。
2. **时间线**（自己用 SVG 画）：
   - 每个节点一行，按树缩进。横轴是时间，有实时的"现在"竖线，可以缩放和拖动。
   - 每行叠放这些条带：
     - 节点存活期：浅色底
     - 每一轮：实色，按 trigger 着色
     - 工具调用：细条，按工具类型着色
     - 权限等待：斜纹
     - 等待子节点：虚线
   - 委派发起时，从父行画一条箭头到子行起点；结果送达时，再画一条箭头回父行。
   - 悬停显示详情，点击打开节点详情。
3. **会话**：根节点的对话流和输入框（也可以切换到任意节点）。
4. **节点详情抽屉**：
   - 内容：任务书、结果（含 JSON）、transcript（消息、思考、工具调用的输入输出可折叠）、用量、权限记录。
   - 操作：发消息、取消。

另有 **Agents 页**（识别结果和刷新）和 **设置页**（默认策略、profile 说明）。

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
| P1（本期） | providers 移植（ACP、Claude、Codex、Pi）；识别本机 agent；内核（委派全流程、级联取消、上限、预算）；MCP；事件存储；REST/SSE；CLI；控制台三个视图和详情；JSON/Markdown 导出 |
| P2 | OTLP 实时推送、父 agent 代审权限、worktree 隔离、profile 能力卡、原生 subagent（Claude Task）显示为虚线节点 |
| P3 | 协作模式库（MA-00..MA-09）作为跑在内核上的编排程序 |
