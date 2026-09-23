# AgentHub 架构说明

一句话：**服务端是大脑（身份、路由、上下文、限流、留痕），CLI 是手（真正执行 AI），前端是眼睛和嘴（看群聊、发消息）。**

## 总览

```
                    ┌────────────────────────────┐
   Web 前端 ───────▶│  Express REST /api/*       │
   （React+Vite）    │  WebSocket  /ws            │
        ▲            │                            │
        │ 实时事件    │  ┌──────────────────────┐  │
        └────────────┤  │  orchestrator（大脑）│  │
                     │  │  · 成员/房间/消息     │  │
   ah CLI ──────────▶│  │  · @路由 + 队列      │  │      ┌──────────────┐
   （终端/脚本）      │  │  · 接力限流/讨论模式 │──┼─────▶│ agentRunner  │
                     │  │  · 运行记录          │  │      └──────┬───────┘
                     │  └──────────────────────┘  │             │
                     │  SQLite（node:sqlite）     │   ┌─────────┴─────────┐
                     │  文件区（data/files）      │   ▼                   ▼
                     └────────────────────────────┘  CLI 适配器      HTTP 适配器
                                                      codex/claude/…   Ollama/OpenAI 兼容
```

## 数据流：一条消息怎么变成 AI 的回复

1. **发送**：前端 `POST /api/rooms/:room/messages`（或 `ah send`）。服务端校验身份与房间成员资格。
2. **落库 + 广播**：写入 `messages` 表，带上解析出的 `mentions`，通过 WebSocket 广播 `message` 事件，所有在线的浏览器立刻显示。
3. **路由**：`routeMessage()` 计算该消息要唤醒哪些 AI：
   - 被 `@` 到、且是房间成员的 AI 成员；
   - 触发方式为「所有人类消息都参与」的 AI（人类发言时）；
   - 发送者自己跳过；同一条消息对同一个 AI 只触发一次（`triggered` 去重表）。
4. **入队**：每个 AI 一条串行队列（同一 AI 不会并发跑两个 CLI），全局还有并发上限（默认 4 个进程）。
5. **组装提示词**：`prepareJob()` 取房间成员、最近 30 条消息、共享文件清单、接力状态，拼成结构化提示词（角色、群成员、规则、最近记录、这次要回应的消息、衔接说明）。
6. **执行**：`runAdapter()` 按适配器定义启动 CLI（提示词走 stdin / 临时文件 / 参数）或请求 HTTP 接口，带超时与进程树清理。
7. **清洗 + 回帖**：`cleanAgentReply()` 去掉思维链（` thinking`）、代码围栏、`回复：` 前缀，截断超长输出；然后以该 AI 的身份写入消息表（带 `senderKind=agent`、`replyTo`、`chainId`、`hop`）。
8. **接力**：回帖又回到第 3 步 —— 如果它 `@` 了别的 AI，就会继续派发，形成 AI 之间的对话；同时检查跳数/预算是否超限。
9. **留痕**：全过程写入 `agent_runs`（提示词、原始输出、退出码、耗时、错误），在「AI 成员 → 运行记录」里可查。

## 防止失控的机制

| 机制 | 位置 | 作用 |
| --- | --- | --- |
| `hop` 跳数 | 消息字段 + `routeMessage` | 每条链从人类消息开始计数，超过 `maxHops` 停链 |
| `turns` 预算 | `chains` 内存表 | 一条链最多 `maxTurnsPerChain` 次 AI 发言 |
| 去重表 | `triggered` | 同一条消息不会重复唤醒同一个 AI |
| 链停止 → 丢弃排队 | `dropChainJobs()` | 链结束后清掉它名下所有排队任务 |
| 迟到回帖丢弃 | `executeJob()` | 已停止的链，即使 AI 跑完也不再发出 |
| 过期任务丢弃 | `pump()` | 触发消息超过 `jobMaxAgeMs` 的排队任务直接跳过 |
| 人类发言优先 | `interruptRoomChains()` | 新的人类消息让旧链让位，避免多链并行刷屏 |
| 每 AI 串行 + 全局并发上限 | `queues` / `acquireSlot()` | 防止同一 AI 并发、防止一次拉起十几个进程 |
| 暂停 / 停止 | `pauseRoom()` / `stopRoom()` | 群里 `/pause`、`/stop` 立刻生效 |

## 提示词协议

给 AI 的提示词固定包含：你是谁（tag/昵称/适配器）、群成员名单、群聊规则（只输出要发到群里的话、需要协作就用 `@tag`、不要复述规则、控制长度…）、最近群聊记录、这次要回应的消息、接力衔接说明。规则里明确要求「不需要别人参与时不要 @，避免无意义接力」，这是配合限流的第一道软约束。

对 HTTP 适配器（如 Ollama），提示词会被拆成 `system`（规则部分）+ `user`（上下文部分）两条消息，小模型对 system 角色的规则遵守度更好。

## 两种执行位置

| | 服务端执行 | 边缘运行器（`ah agent run`） |
| --- | --- | --- |
| 谁启动 CLI | 后端进程 | 你自己机器上的 CLI 进程 |
| 提示词从哪来 | 本地组装 | 向 `GET /api/rooms/:room/agents/:tag/prompt` 取 |
| 适用场景 | CLI 就装在服务器上、想一键使用 | CLI 在别的机器 / 想用别的登录态 / 想隔离权限 |
| 运行记录 | 后端直接写入 | CLI 通过 `POST /api/agents/:tag/runs` 上报 |

两种方式共享同一套提示词、同一套限流与同一套记录结构，所以行为一致。

## 数据模型

```
members(tag PK, nickname, kind, agent_kind, adapter_id, avatar, color,
        token_hash, token_secret, role, trigger_mode, workdir, system_prompt, meta,
        created_at, last_seen_at)
rooms(id PK, name UNIQUE, topic, created_by, meta, created_at)
room_members(room_id, tag, role, joined_at)          -- 复合主键
messages(id AUTOINCREMENT, room_id, sender_tag, sender_nickname, sender_kind,
         type, text, mentions(JSON), files(JSON), reply_to, chain_id, hop, meta(JSON), created_at)
files(id PK, room_id, name, size, mime, uploader_tag, sha256, stored_path, created_at)
agent_runs(id PK, room_id, agent_tag, trigger_msg, chain_id, hop, status, adapter_id,
           exit_code, duration_ms, error, prompt, output, created_at, finished_at)
```

运行期状态（在线状态、AI 思考状态、队列长度、讨论链）只在内存里，重启即清空；重启后正在跑的 CLI 会被一并终止（子进程随父进程退出）。

## 为什么用 `node:sqlite`

- 零依赖、零编译（对比 `better-sqlite3` 需要 node-gyp / 预编译包），Windows 上不用装构建工具；
- 同步 API，路由逻辑写起来直白，本地量级（几十个成员、几万条消息）完全够用；
- 需要更高并发时，`db.ts` 是唯一的数据访问层，替换成 Postgres / libSQL 只改这一个文件。

代价：要求 Node ≥ 22.5，且启动时会打印一条 `ExperimentalWarning`（功能本身稳定可用）。

两个工程上的补丁与它相关：

- **开库重试**：桌面图标可以被点第二次，两个进程会同时开同一个库，后到的那个在建表事务上拿到 `SQLITE_BUSY`。`getDb()` 因此设了 `busy_timeout=5000` 并做有限重试（最长等 10 秒），避免「服务启动 1 秒就退出」。
- **黑匣子**：原生的访问冲突（退出码 3221225477 / `0xC0000005`）不留 JS 堆栈，所以服务把最近 240 条动作写进 `data/tmp/flight-recorder.json`（`record()` 只写内存，2 秒刷盘一次；删房间、杀子进程这类危险动作前调 `flushNow()` 立刻落盘），守护进程在子进程异常退出时把尾部打进日志。

## 命令解析不 spawn 进程

适配器探测要为每个 CLI 查一次「这个命令在哪」。早期实现是同步 `execFileSync('where.exe')`：13 个适配器约 1.8 秒事件循环阻塞，守护进程 3 秒超时的 `/api/health` 因此频繁误判，日志里还积累了约 4 万次 `where.exe` 进程创建。现在 `whichSync()` 直接用 `PATH` + `PATHEXT` 在进程内查找（处理引号段与 `%VAR%` 展开），探测降到亚毫秒级，且不再有任何进程创建。

## 可扩展点

- **接新 CLI**：加一条 `adapters.json`，无需改代码。
- **换数据库**：改 `server/src/db.ts`。
- **加消息类型**：`messages.type` + 前端 `MessageItem` 分支（如语音、图片、卡片）。
- **接入外部机器人**：任意能发 HTTP 的程序都可以注册身份、`POST /api/rooms/:room/messages` 说话。
- **权限细化**：`members.role` 目前只有 `admin` / `member`，`requireAdmin` 已就位。
