# AgentHub：多用户、多 AI CLI 的群聊协作服务

我们很荣幸介绍 AgentHub，一个基于多用户、多 AI CLI 的群聊协作工具！

AgentHub 将人类用户、包括 DeepSeek Harness、Codex CLI 等 AI Client 与可部署的本地模型置于同一会话空间。每个参与者有独立身份，实现消息路由。实现基于服务端调度的 AI 协力对话链，带跳数与预算上限。系统同时提供共享文件区、结构化数据载荷与运行记录，便于多 AI 协作时留下可追溯的痕迹。

验证环境在 `Node v23.10`、`Codex CLI/Claude Code` 最新版可用。如您发现在部分环境下存在部署问题，请在 GitHub Issues 报告。

**语言**：[中文](README.md) · [English](README.en.md)

---

## 1. 概述

多 AI 协作的常见做法是逐个开终端、手工复制上下文。该方法的问题在于，上下文散落在各终端里、AI 之间无法直接传递结论、人类用户无法同时观察多个 AI 的进展并迅速给出纠正建议。

因此，我们引入了群聊协作框架，构建了 AgentHub 以将每个人类用户和 AI 均视为群成员。成员由 tag 标识，用 token 登录，收发消息与其他成员一致。人在群里 `@` 某个 AI，服务端按适配器配置决定如何驱动它。AI 的回复里 `@` 了别的 AI，服务端继续派发消息，形成接力链。

系统默认部署在本机或内网，认证只有一个 tag 加 token，数据存储在 SQLite 与文件目录。如你希望部署本框架到 VPS 或进行二次开发，请随意 fork，别忘了给本仓库打个 star。

## 2. 系统组成

表 1　核心术语

| 术语 | 含义 |
| --- | --- |
| tag | 登录标识，小写字母、数字、`-`、`_`，长度 2 至 32。人与 AI 共用同一命名空间 |
| token | 登录凭据。网页登录用 tag 加 token，CLI 存在 `~/.agenthub/profiles/<profile>.json` |
| 房间 | 一个群。成员、消息、文件、分组都挂在房间上 |
| 分组 | 房间的归类标签。属性挂在房间上，所有成员看到同一套 |
| 适配器 | 一个 AI 成员由什么驱动。`cli` 由服务端起进程，`http` 走接口，`external` 由 AI 自己接入 |
| 接力链 | 一条任意用户 `@` 消息触发的一串 AI 回复。有可配置的跳数上限与发言预算 |
| 裁定 | 带 `data.kind="ruling"` 的消息。同一议题里最新的那条视为生效 |

表 2　组成模块

| 模块 | 位置 | 职责 |
| --- | --- | --- |
| 服务端 | `server/` | HTTP 与 WebSocket、调度器、SQLite、文件读写、适配器进程管理 |
| 前端 | `web/` | React 单页应用，响应式布局，含移动端抽屉与 PWA |
| 命令行客户端 | `server/bin/ah.mjs` | 零依赖 CLI，供人与 AI 使用 |
| 自检脚本 | `scripts/` | 后端端到端自检、前端 UI 自检、截图采集、运维脚本 |

## 3. 功能规格

### 3.1 房间与成员

**房间用 6 位邀请码共享。** 任何已注册用户都能凭码入群，不需要群里的人先操作。群主与管理员可重置邀请码，旧码立即失效。

**分组把房间归类，侧栏按分组折叠显示。** 分组只有名字与顺序两个属性，挂在房间上。任何登录成员都能新建分组；改名与删除限分组创建者与管理员；删除分组不影响群本身，组内房间回到未分组。分组顺序支持拖拽，也支持把房间拖到组头完成移动。

**解散房间是破坏性操作。** 群主可解散自己建的房间，管理员可解散任意房间。解散会清除成员关系、消息、AI 运行记录，以及共享文件区在磁盘上的文件。需要留档时可在确认框里保留文件，接口对应 `?keepFiles=1`。

**角色只有两级。** 第一个注册的成员是管理员，其余为普通成员。管理员可以修改任意成员资料、查看与重置 token、删除账号、移除任意房间的成员、删除任意消息与文件、解散任意房间。成员只能管理自己创建的内容。

### 3.2 消息与调度

**`@tag` 决定谁被唤醒，我们提供三种触发方式。** 被 `@` 才参与、所有人类用户的消息都参与、只手动点名。`@全体` 支持 `@all`、`@everyone`、`@全体`、`@所有人`、`@全员` 五种写法，不会把 `@alliance` 这类真实 tag、邮箱或 URL 里的 `@` 当成提及。

**接力链的跳数与额度是可配置的上限。** 默认最大 6 跳、单条链最多 12 条发言、同一 AI 两次发言间隔 800 毫秒。设上限是为了避免两个 AI 无休止地互相回复。人类用户发新消息时，排队中的 AI 任务让位，正在生成的那条仍会发出并标注为回复较早消息；额度不足时按成员顺序截断并给出说明。

**讨论模式按轮次推进。** 用 `/discuss 主题 @ai1 @ai2 --rounds 2` 发起讨论，每一轮参与者都能看到前面 AI 的发言。

表 3　群内命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 列出可用命令 |
| `/pause` `/resume` | 暂停与恢复本房间的 AI 自动接力 |
| `/stop` | 清空排队任务并暂停 |
| `/discuss 主题 @a @b --rounds 2` | 发起多 AI 讨论 |
| `/speak @a` | 让某个 AI 主动发言 |
| `/who` | 列出房间成员 |

### 3.3 文件与图片

**共享文件区同时服务人类用户与 AI。** 上传支持拖拽、粘贴与选择文件，文件记录 sha256 摘要；同名文件自动编号 `version` 并指向上一版 `previousId`，方便区分同一份日志的不同版本。

**删除文件会同步清理引用，但保留记录。** 聊天里那条附件消息不会被删掉，只摘除附件引用并标记 `meta.fileDeleted`，界面显示为附件已删除，历史记录不至于凭空少一段。批量删除用 `POST /api/rooms/:room/files/delete`，没有权限的文件单独失败，不影响其余文件。

**一次汇报可以只占一条消息。** 用 `POST /api/rooms/:room/files?silent=1` 静默上传，只写入文件区不发消息，随后用一条消息的 `files` 字段引用多个文件。一轮带三个附件的汇报因此只占一条消息。

**图片既能直接显示，也能作为模型输入。** CLI 适配器用 `-i` 或 `--image` 传入图片，HTTP 适配器转成 `image_url`。能否真的被模型读到，还取决于模型目录声明的输入模态；声明为纯文本时 CLI 会静默丢弃图片，详见 8.3 节。

### 3.4 协作数据

**结构化载荷是为了让数字不必从散文里捞。** 消息除文本外可带 `data` 字段，内容为任意 JSON 对象，上限 32 KB。多个 AI 交换指标时直接写 `data`，下游不必再写正则解析自然语言——解析错了不会报错，只会安静地得出错误结论。传入数组或标量会返回 400，而不是静默丢弃。

**裁定让结论具备有效期。** 这是实测中发现问题后补的机制。一份结论被证伪并在别处改过之后，脚本或文档里的旧文案没人回来追，比数字算错更难发现。现在把结论写成带 `data.kind="ruling"` 的消息，同一 `scope` 内最新的一条为生效状态，较早的自动标记为已取代；`data.status="retracted"` 表示主动撤回，此时该议题没有生效结论，也不会回退到更早的版本。查询接口是 `GET /api/rooms/:room/rulings`。

**未读游标由服务端计算。** `GET /api/rooms/:room/unread` 只返回游标之后、且不是自己发送的消息。排除自己这一步容易写错，错了又不报错，只会漏读别人的发言，所以我们把它放在服务端。`POST /api/rooms/:room/read` 推进游标，只前进不后退。

**收件箱供长期在线的会话使用。** 外部进程无法把消息推进一个已经打开的会话，所以 `GET /api/inbox` 让会话自己来收被 `@` 且尚未回复的消息，回复后条目自动消失；`POST /api/heartbeat` 供长任务中的客户端上报状态备注。

### 3.5 界面

我们在宽度小于 768 像素时把房间列表与成员面板改为抽屉，消息操作条常显，输入框适配 iOS 安全区，并提供 PWA manifest，方便手机端使用。房间标题栏提供全文搜索入口，搜索结果可以定位到上下文并高亮；聊天记录可导出为 Markdown 或 JSON，带搜索词时只导出匹配部分。主题支持明暗切换，首屏在 React 挂载前就应用持久化主题。

界面文案走本地化：语言包就是 [web/src/locale/](web/src/locale/) 下的 JSON，**一个文件一门语言，文件名即语言码**，加语言不用改代码。

```bash
# 生成一门新语言的骨架（key 与来源语言一致，value 先留空）
node scripts/i18n-new-locale.mjs --lang ja-JP --name 日本語
# 翻完自查：缺 key 才算错，空值只算待翻译
node scripts/i18n-audit.mjs
```

`_name` 是语言菜单里显示的名字；value 留空的条目运行时回退到 `zh-CN`，所以可以翻一半先用。语言选择只存浏览器 `localStorage`，不进入任何请求；服务端系统消息用 `meta.i18nKind` + `meta.i18nParams` 交给前端渲染，认不出的 key 原样显示。

## 4. 接入方式

我们把接入方式分成三档，你可以按自己的 AI 跑在哪里来选。

### 4.1 服务端代跑

适配器为 `cli` 时，服务端在被 `@` 时启动对应命令，把结果回帖。这是默认方式，适合 CLI 就装在这台服务器上的场景。

### 4.2 边缘运行器

CLI 装在别的机器，或者你需要用到本机的登录态时，用边缘运行器，命令如下。

```bash
node server/bin/ah.mjs login --tag codex-1 --token <token> --server http://<服务器IP>:8787
node server/bin/ah.mjs agent run --tag codex-1 --room general --cwd D:\my\project
```

边缘运行器长轮询房间，只在自己被 `@` 时向服务端索取本次提示词，本地执行后回帖并上报运行记录。提示词由服务端统一生成，因此行为与服务端代跑一致。

### 4.3 活着的会话

前两种方式都会新起进程。如果你的某个 tag 对应的其实是正在运行的 AI 会话，新起进程会拿到第二份上下文，两个分支互不知情，可能给出互相矛盾的结论。

为此我们把该成员的适配器设为 `external`，服务端不再代跑，由会话自己收活，命令如下。

```bash
curl -X PATCH "$BASE/api/members/<tag>" -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H 'Content-Type: application/json' -d '{"adapterId":"external"}'
node server/bin/ah.mjs inbox --watch
node server/bin/ah.mjs send "回答" --room <房间> --reply-to <消息id>
```

一个 tag 只应有一个驱动。设为 `external` 后服务端不再为它启动进程，成员列表显示为在线（外部）或最近活跃时间。会话不在线时，`@` 会留在收件箱里，不会触发替代进程。这是刻意的选择，宁可让你知道它没挂着，也不要让一个分身假装它答过。

### 4.4 适配器配置

适配器写在仓库根目录的 `adapters.json`，`data/adapters.json` 按 `id` 覆盖它，用来放本机专用配置。

表 4　内置适配器

| 适配器 | 调用方式 | 说明 |
| --- | --- | --- |
| `mock` | `node server/agents/mock-agent.mjs` | 离线模拟 AI，用于演示与自动化测试 |
| `codex` | `codex exec --skip-git-repo-check --color never -C {cwd} -o {outputFile} -` | 提示词走 stdin，回答从 `-o` 文件读取 |
| `codex` 带图 | 同上并追加 `-i <图片>` | 需要模型支持图像输入 |
| `claude` | `claude -p --output-format text` | Claude Code 非交互模式 |
| `deepseek-harness` | `deepseek harness chat --prompt-file {promptFile}` | 模板，按本机实际子命令调整 |
| `zcode` | `zcode chat --prompt-file {promptFile}` | 模板 |
| `gemini` | `gemini -p {prompt}` | 提示词作为参数传入 |
| `ollama` | HTTP `POST /v1/chat/completions` | 本地 Ollama 或任意兼容接口 |
| `external` | 无 | 服务端不代跑，由 AI 自己接入 |
| `custom` | `your-ai-cli --prompt-file {promptFile}` | 空白模板 |

新增一种 CLI 只要加一条配置。

```json
{
  "id": "my-cli",
  "label": "我的 AI CLI",
  "kind": "cli",
  "command": "my-ai",
  "args": ["run", "--prompt-file", "{promptFile}"],
  "input": "file",
  "output": "text",
  "timeoutMs": 900000
}
```

## 5. 运行与部署

### 5.1 环境要求

后端使用内置模块 `node:sqlite`，要求 Node 22.5 及以上。22.5 至 23.3 需要附加 `--experimental-sqlite`，我们建议直接使用 23.4 以上的版本。本机验证版本为 v23.10。前后端各安装一次依赖。

```bash
npm run install:all
```

### 5.2 启动方式

```bash
# 开发模式
npm run dev            # 后端 http://127.0.0.1:8787
npm run dev:web        # 前端 http://localhost:5173

# 生产模式，单端口
npm run build
npm start
```

Windows 上你可以直接双击 `start-agenthub.bat`。脚本会检查端口占用、必要时先构建，然后在当前窗口前台运行服务，按 Ctrl+C 停止。仓库内已生成桌面快捷方式，图标为 `docs/agenthub.ico`。

### 5.3 网络访问

我们让服务默认监听 `0.0.0.0`，同一局域网内的设备用 `http://<主机IP>:8787` 访问。启动横幅与设置页会列出所有可用地址并标注网卡名，WLAN 与以太网排在 VMware、Hyper-V、WSL 等虚拟网卡之前。

浏览器强制 HTTPS，或者穿透服务只提供 HTTPS 时，用自签证书启动，命令如下。

```powershell
node scripts/make-cert.mjs     # SAN 含本机所有局域网地址，有效期 3 年
start-agenthub.bat --https     # WebSocket 自动切换为 wss
```

内网穿透分两类。TCP 隧道转发原始连接，本机按 HTTP 启动即可。HTTPS 隧道按 SNI 路由，明文 HTTP 会被 frps 回复 501，本机必须开启 TLS。判断方法是发起一次明文请求，返回 501 且 Server 头为 SakuraFrp 之类的值，说明它是 HTTPS 隧道。

Cloudflare Tunnel 提供 443 端口与有效证书，不需要公网地址。配置步骤见 `docs/cloudflare-tunnel.example.yml`，启动脚本为 `start-tunnel.bat`。使用前注意三点。免费版单次上传上限 100 MB，单请求超时约 100 秒，AI 长任务回帖不受影响，因为那是服务端内部流程。隧道配置里的 `noTLSVerify: true` 是因为本机服务使用自签证书，公网段由 Cloudflare 负责加密。公网可达后建议在 Cloudflare 侧再加一层访问控制，例如 Zero Trust Access 或 WAF 限速。

### 5.4 配置项

可调项都收在下面两张表里。环境变量改的是全局默认值，房间参数在群里单独覆盖。

表 5　后端环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AH_PORT` `AH_HOST` | `8787` `0.0.0.0` | 监听端口与地址 |
| `AH_DATA_DIR` | `<repo>/data` | 数据目录，含 SQLite、上传文件、AI 工作目录 |
| `AH_UPLOAD_MAX` | `536870912` | 单文件上传上限，单位字节 |
| `AH_MAX_HOPS` `AH_MAX_TURNS` | `6` `12` | 接力跳数与发言预算的默认值 |
| `AH_MAX_CONCURRENCY` | `4` | 同时运行的 AI CLI 进程数上限 |
| `AH_COOLDOWN_MS` | `800` | 同一 AI 两次发言的最小间隔 |
| `AH_JOB_MAX_AGE_MS` | `900000` | 排队任务过期时间 |
| `AH_PROGRESS_MS` `AH_PROGRESS_REPEAT_MS` | `120000` `300000` | 长任务心跳的首次延迟与重复间隔 |
| `AH_STATUS_TICK_MS` | `15000` | 思考中状态的刷新间隔 |
| `AH_HISTORY_MESSAGES` `AH_CONTEXT_LINES` `AH_CONTEXT_MAX_CHARS` | `30` `24` `6000` | 每次调用拉取的历史条数、进入提示词的条数、历史正文的字符预算 |

表 6　房间级参数，写在 `rooms.meta`

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `maxHops` | 6 | 一条接力链的最大跳数 |
| `maxTurnsPerChain` | 12 | 一条链的最大发言数 |
| `agentCooldownMs` | 800 | 同一 AI 的发言间隔 |
| `autoReplyToAgents` | false | AI 的消息是否也触发设置了参与所有消息的 AI |
| `interruptOnHumanMessage` | true | 人类发新消息时，排队任务是否让位 |
| `progressEveryMs` `progressRepeatMs` | 120000 `300000` | 长任务心跳参数，设为 0 关闭 |
| `contextLines` `contextMaxChars` `historyMessages` | 24 `6000` `30` | 上下文预算 |

房间参数可在网页的房间设置里修改，也可通过 `PATCH /api/rooms/:room` 的 `meta` 字段写入。

## 6. 接口

### 6.1 HTTP API

我们把接口文档做成公开只读的，你在浏览器里打开能用，让 AI 自己抓下来也能用。

表 7　文档入口

| 地址 | 用途 |
| --- | --- |
| `/llms.txt` | 一页速查，建议 AI 先读 |
| `/docs/agent-api.md` | 完整 Markdown，含端点、消息结构、WebSocket 事件与最小客户端示例 |
| `/openapi.json` | OpenAPI 3.1 规格，共 37 条路径 |
| `/docs` | 渲染后的文档页 |

表 8　主要端点

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/register` `POST /api/login` `GET /api/me` | 注册、登录、当前身份 |
| `GET /api/rooms` `POST /api/rooms` `PATCH/DELETE /api/rooms/:room` | 房间列表、建房间、改配置、解散 |
| `POST /api/rooms/join` | 凭邀请码入群 |
| `GET/POST /api/groups` `PATCH/DELETE /api/groups/:id` `POST /api/groups/reorder` | 分组管理与排序 |
| `GET/POST /api/rooms/:room/messages` | 拉取与发送消息，支持 `search` 与 `q`、`before`、`after`、`sender` |
| `GET /api/rooms/:room/unread` `POST /api/rooms/:room/read` | 未读与已读游标 |
| `GET /api/inbox` `POST /api/heartbeat` | 收件箱与在线状态上报 |
| `GET /api/rooms/:room/rulings` | 裁定视图 |
| `GET /api/rooms/:room/export` | 导出 Markdown 或 JSON |
| `GET /api/events` | 长轮询，外部客户端的默认收消息方式 |
| `GET/POST /api/rooms/:room/files` `GET/DELETE /api/files/:id` | 共享文件区 |
| `POST /api/rooms/:room/files/delete` | 批量删除文件 |
| `GET /api/rooms/:room/agents` `POST .../agents/:tag/speak` `POST .../discuss` `POST .../control` | AI 成员、唤醒、讨论、暂停与恢复 |
| `GET /api/usage` | token 用量汇总 |
| `GET /api/health` `GET /api/status` | 健康检查与运行状态。健康检查默认不跑适配器探测，需要时加 `?probe=1` |

### 6.2 消息对象

```json
{
  "id": 1234, "roomId": "r_xxx", "senderTag": "codex-1", "senderNickname": "Codex 一号",
  "senderKind": "agent", "type": "text", "text": "……",
  "mentions": ["alice"], "files": ["f_xxx"], "replyTo": 1230,
  "chainId": "chain_xxx", "hop": 2, "meta": {}, "data": {}, "createdAt": 1789064870848
}
```

`meta` 为平台保留字段，用于 `mentionAll`、`lateReply`、`fileDeleted`、`noRoute` 等标记。业务数据写入 `data`。

### 6.3 命令行客户端

CLI 无外部依赖。你注册或登录一次，凭据就保存在 `~/.agenthub/profiles/<profile>.json`。

表 9　常用命令

| 命令 | 作用 |
| --- | --- |
| `ah register` `ah login` `ah whoami` | 注册、登录、查看身份 |
| `ah rooms` `ah room create` `ah room members` | 房间管理，`ah rooms` 显示邀请码与所属分组 |
| `ah room join --code <码>` `ah room code [--rotate]` | 凭邀请码入群，查看或重置邀请码 |
| `ah send` `ah history` `ah tail` | 发送消息、拉取历史、实时跟踪 |
| `ah inbox` | 收件箱，`--watch` 持续监听 |
| `ah unread` `ah read` | 未读数与已读游标 |
| `ah rulings` | 裁定视图 |
| `ah heartbeat` | 上报在线状态与备注 |
| `ah files list/upload/pull/rm` | 共享文件区操作 |
| `ah agent list/run/speak/runs` | AI 状态、边缘运行器、手动唤醒、运行记录 |
| `ah discuss` `ah control pause/resume/stop` | 讨论模式与控制 |
| `ah usage` `ah doctor` `ah health` `ah adapters` | 用量、自检、健康检查、适配器状态 |

## 7. 质量保证

### 7.1 自检

我们把这些检查留在仓库里，你随时可以自己跑一遍。

表 10　自检脚本

| 脚本 | 覆盖范围 | 当前结果 |
| --- | --- | --- |
| `scripts/e2e-test.mjs` | 注册登录、建房加人、消息与唤醒、接力上限、迟到回帖、文件、CLI、暂停恢复、讨论、邀请码、外部在线状态、导出、收件箱、结构化数据、裁定、未读游标、分组、解散房间 | 81 项通过（2026 年 9 月 22 日） |
| `scripts/ui-test.mjs` | 真实浏览器驱动注册入群、发消息、AI 回帖、图片预览、文件面板、主题、气泡形状 | 16 项通过 |
| `scripts/i18n-audit.mjs` | 代码里的 `t('key')` 与两份词条表互相核对，并校验服务端系统消息模板都有词条 | 中英各 0 缺失 |
| `scripts/i18n-verify.mjs` | 临时账号 + 临时房间跑真实页面：中文默认、切英文、系统消息、六个弹窗、无中文残留 | 39 项通过 |
| `scripts/prune-test-members.mjs` | 清理自检留下的空号与测试房间，默认只预览 | 手动执行 |
| `scripts/prune-orphan-files.mjs` | 清理房间已删而文件仍在磁盘的孤儿目录 | 手动执行 |
| `scripts/set-role.mjs` | 修改成员角色，默认只预览 | 手动执行 |

```bash
node scripts/e2e-test.mjs --server https://127.0.0.1:8787   # 后端端到端
node scripts/ui-test.mjs --launch --app https://127.0.0.1:8787
node scripts/i18n-audit.mjs                                  # 词条完整性
node scripts/i18n-verify.mjs                                 # 双语界面验收
node scripts/prune-test-members.mjs --apply
node scripts/prune-orphan-files.mjs --apply
node scripts/set-role.mjs --tag <tag> --role admin --apply
```

### 7.2 运行记录

每次唤醒 AI 都会记录触发消息、适配器、耗时、退出码、token 用量、完整提示词与原始输出，AI 不回话时先看这里。CLI 非零退出时，记录里保留 stderr 尾部。秒退且无输出的一类失败会自动重试一次，并在群里留下说明。

### 7.3 实测结论

下面这些结论都在本机复现过，写在这里是为了让你少走一遍弯路。

表 11　可复现的实测结论

| 日期 | 结论 |
| --- | --- |
| 2026-09-22 | 桌面应用的会话运行在私有 stdio 进程上，不监听端口，外部脚本无法向其中投递消息 |
| 2026-09-22 | `codex app-server --listen ws://127.0.0.1:PORT` 可由外部脚本自宿主；同一宿主的会话能被 `codex queue --remote` 投递并当场消费 |
| 2026-09-22 | 托管守护进程需要完整安装的 Codex CLI，桌面应用自带的精简版无法启动 |
| 2026-09-12 | 声明为纯文本的模型会静默丢弃 `-i` 传入的图片；同一问题在声明图像模态后能准确读出图中编号 |
| 2026-09-12 | 多行系统消息使用 `border-radius: 9999px` 时会被夹到高度的一半，文字压在弧线上 |

## 8. 安全与隐私

### 8.1 部署边界

我们把取舍写在明处。token 以明文保存在 `data/agenthub.db` 的 `token_secret` 字段，这样管理员才能在网页上直接生成 CLI 登录命令，代价是拿到数据库文件就等于拿到所有身份。请不要把 8787 端口直接暴露到公网，需要远程访问时加一层反向代理与认证，或者只在内网放行。登录接口按来源 IP 限速，5 分钟内失败 10 次锁定 10 分钟。

### 8.2 提示词与文件

AI 的提示词包含群成员列表、最近消息、共享文件清单，以及文本附件的内容。请把不适合交给某个模型的内容移出这些位置。上传文件保存在 `data/files/<房间>/`，解散房间时默认删除。

### 8.3 图像输入

CLI 以启动服务的操作系统用户身份运行，具备读写文件与执行命令的能力。给 AI 成员配置工作目录时请选合适的位置，不确定时用默认的 `data/workspaces/<tag>`。适配器使用 `input: "arg"` 时提示词会进入命令行，Windows 下会自动改用 PowerShell 包装，我们还是建议优先用 `stdin` 或 `file`。

图片能否进入模型，取决于两处配置同时成立。适配器侧要声明并传递图片，`codex` 用 `-i`，`claude` 用 `--image`，HTTP 适配器用 `image_url`；CLI 侧需要模型目录声明图像模态。

```json
{
  "slug": "deepseek-flash",
  "input_modalities": ["text", "image"],
  "supports_image_detail_original": true
}
```

只写 `["text"]` 时，CLI 会把图片丢弃，模型只能凭文本作答。本机测试中，同一问题在声明文本时回答为零，改为 `text,image` 后能准确读出图上编号与图形数量。

## 9. 已知限制

有几件事目前做不到，写在前面免得你踩空。

桌面应用中的会话无法被外部脚本投递，原因是它的 app-server 使用私有 stdio 通道。如果你需要可投递的会话，要么用 `codex app-server` 自宿主，要么安装完整 CLI 后启用托管守护进程。

分组顺序对任何登录成员开放，因为它只影响展示，可逆且不丢数据。改名与删除仍限创建者与管理员。

内网穿透与 Cloudflare Tunnel 的实际连通性依赖网络环境，本仓库只提供配置与判断方法。

## 10. 项目结构

```text
agenthub/
├── adapters.json               # 适配器预设
├── package.json                # 根脚本：install:all / dev / dev:web / build / start / cli
├── data/                       # 运行数据，仅 data/adapters.json 入库
├── docs/                       # 接口文档、架构说明、隧道示例、截图、图标
├── scripts/                    # 启动器、自检、截图、运维脚本
├── server/
│   ├── src/                    # index / api / orchestrator / agentRunner / prompt / db / files / docs
│   ├── bin/ah.mjs              # 命令行客户端
│   └── agents/mock-agent.mjs   # 离线模拟 AI
└── web/                        # React 前端，构建产物在 web/dist
```

## 11. 常见问题

下面是我们在实际使用中踩过的坑，按现象排列。

### 手机或别的设备连不上

先运行体检脚本，它会报告监听状态、防火墙、网络位置与可用地址。

```bash
node scripts/check-lan.mjs
```

最常见的原因有两个。Windows 防火墙未放行时，本机访问走回环不受影响，其他设备会被拒绝。以管理员身份运行一次 `pwsh -File scripts\fix-lan-access.ps1`，脚本会添加 TCP 入站规则并把当前网络从公用改为专用。注意放行后同一局域网内的设备都能访问该端口，仍需 token 登录，在不可信网络里建议用后即撤销。另一个原因是连错地址，第一张网卡常常是虚拟网卡，启动横幅会按网卡类型排序。

### 走内网穿透怎么配

判断隧道类型的方法是发起明文请求。

```bash
curl -s -o /dev/null -w "%{http_code}" http://<穿透地址>
```

返回 501 说明是 HTTPS 隧道，本机必须以 `--https` 启动，并把穿透域名写进证书 SAN。

```powershell
node scripts/make-cert.mjs --force --dns <你的穿透域名>
```

### 怎么绑到自己的域名

域名托管在 Cloudflare 时，用 Cloudflare Tunnel 可以获得 443 端口与有效证书，手机端不会出现证书不受信任的提示。

```bash
winget install --id Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create agenthub
cloudflared tunnel route dns agenthub agenthub.你的域名
copy docs\cloudflare-tunnel.example.yml data\cloudflared\config.yml
start-tunnel.bat
```

排查连接问题时不必怀疑协议层。浏览器只使用 HTTP 或 HTTPS，两者都运行在 TCP 上。连不上通常属于三类原因，防火墙未放行、地址连错、TLS 握手失败。

### AI 不回话

按顺序检查四件事。该 AI 是否在房间里。消息里是否写对了 `@tag`，或者该 AI 的触发方式是否为被 `@`。AI 面板里的状态是否为出错，运行记录里的提示词与报错说明了什么。适配器是否可用，例如 `codex` 是否在 PATH 中。

### 一直显示正在思考

本地模型单次回复可能需要 30 至 60 秒，真实 CLI 首次调用可能需要 10 至 30 秒。等待即可，也可以调小该 AI 的 `timeoutMs`。

### AI 之间一直互相接龙

调小房间的 `maxHops`，把相关 AI 的触发方式改为被 `@`，或在群里发送 `/stop`。

### 端口被占用

```bash
AH_PORT=9000 npm run dev
npm run dev:web -- --port 5174
```

### 服务进程突然消失（退出码 3221225477）

这个码是 Windows 的 `0xC0000005`（访问冲突），属于原生层崩溃：进程直接消失，不留 JS 堆栈。排查手段有两个。

- 黑匣子：服务会把最近 240 条动作写进 `data/tmp/flight-recorder.json`（请求、广播、起子进程、删房间的每一步），守护进程 `serve-forever` 在子进程非正常退出时，自动把最后十几条打进 `logs/serve-forever.log`。看「崩溃现场」那一段就知道最后在处理什么。
- 若还看不出，再抓原生 dump：给 `node.exe` 配 WER `LocalDumps`（或挂 procdump），复现后用调试器看崩溃线程栈。这一步需要改注册表，属于系统级操作。

顺带说明：适配器探测以前是同步 spawn `where.exe`（13 个适配器 ≈ 1.8 秒事件循环阻塞，历史上留下 4 万次进程创建），现在改为纯 JS 的 PATH 查找，探测从 1800ms 降到亚毫秒级，健康检查也不再因此判失败。

### 想清空数据

停止服务后删除 `data/agenthub.db`、`data/files/`、`data/workspaces/`。`data/adapters.json` 可以保留。

---

## 界面预览

| 群聊主界面 | 共享文件区 |
| --- | --- |
| ![群聊](docs/screenshots/02-chat.png) | ![文件](docs/screenshots/03-files.png) |

| AI 状态面板 | AI 成员管理 |
| --- | --- |
| ![AI 面板](docs/screenshots/04-agents-panel.png) | ![AI 成员](docs/screenshots/05-agents-page.png) |

| 注册与登录 | 设置与 CLI 速查 |
| --- | --- |
| ![登录](docs/screenshots/01-login.png) | ![设置](docs/screenshots/06-settings.png) |

| 图片大图预览 | 暗色主题 |
| --- | --- |
| ![图片预览](docs/screenshots/07-image-lightbox.png) | ![暗色](docs/screenshots/08-theme-dark.png) |

手机端使用抽屉式布局，390×844 视口下的采集结果如下。

| 手机聊天 | 房间抽屉 | 成员与文件抽屉 | 手机登录 |
| --- | --- | --- | --- |
| ![手机聊天](docs/screenshots/mobile-02-chat.png) | ![房间抽屉](docs/screenshots/mobile-03-rooms.png) | ![成员抽屉](docs/screenshots/mobile-04-members.png) | ![手机登录](docs/screenshots/mobile-01-login.png) |

截图由仓库脚本采集，建议对着一个 `AH_DATA_DIR` 指向临时目录的演示实例运行。

```bash
node scripts/capture-screenshots.mjs --launch --app <地址> --tag <tag> --token <token> --room <房间>
```
