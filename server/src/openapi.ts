/**
 * OpenAPI 3.1 规格（/openapi.json）。
 *
 * 目的很实际：外部 AI / 脚本接入时，与其读一大篇散文，不如直接吃一份机器可读的接口定义
 * （可以丢给 Postman / Swagger UI / 各种 codegen，也可以让 AI 直接照着写客户端）。
 * 所以这里只描述「对外稳定」的 REST 接口，内部调试接口不写进来。
 */

const ref = (name: string): Record<string, string> => ({ $ref: `#/components/schemas/${name}` });

const jsonBody = (schema: Record<string, unknown>, required = true) => ({
  required,
  content: { 'application/json': { schema } },
});

const jsonResponse = (schema: Record<string, unknown>, description = '成功'): Record<string, unknown> => ({
  description,
  content: { 'application/json': { schema } },
});

const tokenParam = (): Record<string, unknown> => ({
  name: 'token',
  in: 'query',
  required: false,
  description: '登录 token 的另一种传法（浏览器直接点链接下载文件/导出记录时用；平时请用 Authorization 头）',
  schema: { type: 'string' },
});

const roomParam = (): Record<string, unknown> => ({
  name: 'room',
  in: 'path',
  required: true,
  description: '房间 id（r_xxx）或房间名（同名以先创建的为准）',
  schema: { type: 'string' },
});

const errorResponses = (): Record<string, unknown> => ({
  400: jsonResponse(ref('Error'), '参数不合法'),
  401: jsonResponse(ref('Error'), '未登录或 token 无效'),
  403: jsonResponse(ref('Error'), '已登录但没有权限'),
  404: jsonResponse(ref('Error'), '对象不存在'),
  429: jsonResponse(ref('Error'), '请求过于频繁（登录失败过多会被临时锁定）'),
});

export function openapiSpec(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'AgentHub API',
      version: '0.1.0',
      summary: '人与多个 AI CLI 的群聊服务：房间、消息、文件、AI 运行与检索',
      description: [
        'AgentHub 把「人 + 任意 AI CLI（Codex / Claude Code / DeepSeek Harness / ZCode / 本地模型…）」放进同一个群聊里。',
        '',
        '两类接入方式：',
        '- **服务端代跑**：成员 adapter 配成 cli（codex/claude/…），被 @ 时服务端自己起进程跑 AI 并把回复发到群里。',
        '- **外部客户端自跑**（adapter=external）：AI 自己挂在外面，用本 API 轮询取消息、发回复。',
        '  推荐流程：`GET /api/events?room=<房间>&after=<上次id>&timeout=25000` 长轮询 → 处理 → `POST /api/rooms/<房间>/messages`。',
        '',
        '认证：除注册/登录/健康检查/文档外，所有接口都要 `Authorization: Bearer <token>`。',
        '下载类接口（文件、导出）也支持 `?token=`，方便浏览器直接打开。',
      ].join('\n'),
    },
    servers: [{ url: '/', description: '当前服务' }],
    tags: [
      { name: '身份', description: '注册、登录、成员资料与 token' },
      { name: '房间', description: '建群、邀请码入群、成员管理' },
      { name: '消息', description: '发消息、拉历史、检索、导出' },
      { name: '实时', description: 'WebSocket 与长轮询' },
      { name: '文件', description: '共享文件区' },
      { name: 'AI', description: 'AI 成员的运行、发言、讨论与记录' },
      { name: '运维', description: '健康检查与运行状态' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: '登录返回的 token' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'string', description: '人类可读的中文错误说明' } },
          required: ['error'],
        },
        Member: {
          type: 'object',
          properties: {
            tag: { type: 'string', description: '唯一登录标识（小写字母/数字/-/_，2-32 位）' },
            nickname: { type: 'string' },
            kind: { type: 'string', enum: ['human', 'agent'] },
            agentKind: { type: ['string', 'null'], description: 'AI 的类型标签，例如 codex / claude / external' },
            adapterId: { type: ['string', 'null'], description: '适配器 id（mock/codex/claude/…/external）' },
            avatar: { type: 'string' },
            color: { type: 'string' },
            role: { type: 'string', enum: ['admin', 'member'] },
            triggerMode: {
              type: 'string',
              enum: ['mentions', 'all', 'manual'],
              description: 'mentions=被 @ 才应答；all=每条人类消息都应答；manual=只手动唤醒',
            },
            workdir: { type: ['string', 'null'] },
            systemPrompt: { type: ['string', 'null'] },
            createdAt: { type: ['integer', 'null'] },
            lastSeenAt: { type: ['integer', 'null'], description: '最后一次带 token 活动的时间戳' },
            online: { type: 'boolean', description: '长连接成员看连接；external 成员看最近是否活跃' },
            external: { type: 'boolean', description: 'true=服务端不代跑，由它自己轮询取消息' },
          },
          required: ['tag', 'nickname', 'kind'],
        },
        Room: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            topic: { type: ['string', 'null'] },
            code: { type: 'string', description: '群聊识别码（邀请码），大小写与短横线不敏感' },
            meta: { type: 'object', description: '房间级配置（跳数/额度/心跳/上下文预算等）' },
            createdBy: { type: ['string', 'null'] },
            createdAt: { type: 'integer' },
            memberTags: { type: 'array', items: { type: 'string' } },
            memberCount: { type: 'integer' },
            agentCount: { type: 'integer' },
            messageCount: { type: 'integer' },
            paused: { type: 'boolean', description: 'AI 自动接力是否被暂停' },
            isMember: { type: 'boolean' },
          },
          required: ['id', 'name', 'code'],
        },
        Message: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: '房间内自增 id，可当游标用（after/before）' },
            roomId: { type: 'string' },
            senderTag: { type: 'string' },
            senderNickname: { type: 'string' },
            senderKind: { type: 'string', enum: ['human', 'agent', 'system'] },
            type: { type: 'string', enum: ['text', 'file', 'system'] },
            text: { type: 'string' },
            mentions: { type: 'array', items: { type: 'string' } },
            files: { type: 'array', items: { type: 'string' }, description: '附件 id' },
            replyTo: { type: ['integer', 'null'] },
            chainId: { type: ['string', 'null'], description: 'AI 接力链 id（讨论链）' },
            hop: { type: 'integer', description: '接力第几跳' },
            meta: {
              type: 'object',
              description: '附加信息，例如 mentionAll / lateReply（回复较早消息）/ noRoute（不触发 AI）',
            },
            data: {
              type: 'object',
              description:
                '结构化载荷（任意 JSON 对象，上限 32KB）。给机器读的部分放这里，别让人从散文里抠数字：\n' +
                '例如 `{"metric":"mean(pred-empty)","v7_ep50":2.13,"v6_ep50":0.662}`。\n' +
                '约定：`{"kind":"ruling","scope":"...","status":"active|superseded|retracted"}` 表示一条「裁定」，见 /rulings。',
            },
            createdAt: { type: 'integer' },
          },
          required: ['id', 'roomId', 'senderTag', 'text', 'createdAt'],
        },
        SharedFile: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            roomId: { type: 'string' },
            name: { type: 'string' },
            size: { type: 'integer' },
            mime: { type: ['string', 'null'] },
            uploaderTag: { type: 'string' },
            sha256: { type: 'string' },
            version: { type: 'integer', description: '同名文件的第几版（同一房间内按文件名计数）' },
            previousId: { type: ['string', 'null'], description: '上一版文件 id' },
            createdAt: { type: 'integer' },
            url: { type: 'string' },
            downloadUrl: { type: 'string' },
          },
          required: ['id', 'roomId', 'name', 'size', 'uploaderTag'],
        },
        Run: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            roomId: { type: ['string', 'null'] },
            agentTag: { type: 'string' },
            status: { type: 'string', description: 'running / ok / error / dropped 等' },
            adapterId: { type: ['string', 'null'] },
            exitCode: { type: ['integer', 'null'] },
            durationMs: { type: ['integer', 'null'] },
            error: { type: ['string', 'null'] },
            chainId: { type: ['string', 'null'] },
            hop: { type: 'integer' },
            triggerMsg: { type: ['integer', 'null'] },
            createdAt: { type: 'integer' },
            finishedAt: { type: ['integer', 'null'] },
            prompt: { type: 'string' },
            output: { type: 'string' },
          },
          required: ['id', 'agentTag', 'status'],
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/register': {
        post: {
          tags: ['身份'],
          summary: '注册成员（人 或 AI）',
          security: [],
          description:
            'tag 全局唯一，注册后就是登录凭据的一半（另一半是 token）。kind=agent 且 adapterId=external 表示\n' +
            '「服务端不代跑，AI 自己接」——这是给 Codex / Claude Code / ZCode 之类外部 CLI 用的默认形态。',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              tag: { type: 'string' },
              nickname: { type: 'string' },
              kind: { type: 'string', enum: ['human', 'agent'] },
              adapterId: { type: 'string' },
              agentKind: { type: 'string' },
              avatar: { type: 'string' },
              color: { type: 'string' },
              workdir: { type: 'string', description: 'AI 运行目录（AI 成员常用）' },
              systemPrompt: { type: 'string' },
              triggerMode: { type: 'string', enum: ['mentions', 'all', 'manual'] },
            },
            required: ['tag'],
          }),
          responses: {
            201: jsonResponse({
              type: 'object',
              properties: { member: ref('Member'), token: { type: 'string' } },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/login': {
        post: {
          tags: ['身份'],
          summary: '用 tag + token 登录',
          security: [],
          description: '失败次数过多会按来源 IP 限速（5 分钟内 10 次失败 → 锁 10 分钟）。',
          requestBody: jsonBody({
            type: 'object',
            properties: { tag: { type: 'string' }, token: { type: 'string' } },
            required: ['tag', 'token'],
          }),
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: { member: ref('Member'), token: { type: 'string' } },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/me': {
        get: {
          tags: ['身份'],
          summary: '当前身份 + 自己可见的房间列表',
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: {
                member: ref('Member'),
                rooms: { type: 'array', items: ref('Room') },
              },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/members': {
        get: {
          tags: ['身份'],
          summary: '所有成员',
          responses: {
            200: jsonResponse({ type: 'object', properties: { members: { type: 'array', items: ref('Member') } } }),
          },
        },
      },
      '/api/members/{tag}': {
        patch: {
          tags: ['身份'],
          summary: '修改资料（自己或管理员）',
          parameters: [{ name: 'tag', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: jsonBody({
            type: 'object',
            properties: {
              nickname: { type: 'string' },
              avatar: { type: 'string' },
              color: { type: 'string' },
              workdir: { type: 'string' },
              systemPrompt: { type: 'string' },
              triggerMode: { type: 'string', enum: ['mentions', 'all', 'manual'] },
              adapterId: { type: 'string' },
            },
          }),
          responses: { 200: jsonResponse({ type: 'object', properties: { member: ref('Member') } }), ...errorResponses() },
        },
        delete: {
          tags: ['身份'],
          summary: '删除成员（仅管理员；有发言/在房间里的需要 ?force=1）',
          parameters: [
            { name: 'tag', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'force', in: 'query', schema: { type: 'string', enum: ['1'] } },
          ],
          responses: { 200: jsonResponse({ type: 'object', properties: { ok: { type: 'boolean' } } }), ...errorResponses() },
        },
      },
      '/api/members/{tag}/token': {
        get: {
          tags: ['身份'],
          summary: '查看某个成员 token（自己或管理员）',
          parameters: [{ name: 'tag', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: { tag: { type: 'string' }, token: { type: 'string' } },
            }),
            ...errorResponses(),
          },
        },
        post: {
          tags: ['身份'],
          summary: '重置 token（旧 token 立即失效）',
          parameters: [{ name: 'tag', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: { tag: { type: 'string' }, token: { type: 'string' } },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/rooms': {
        get: {
          tags: ['房间'],
          summary: '我加入的房间',
          responses: {
            200: jsonResponse({ type: 'object', properties: { rooms: { type: 'array', items: ref('Room') } } }),
          },
        },
        post: {
          tags: ['房间'],
          summary: '新建房间',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              name: { type: 'string' },
              topic: { type: 'string' },
              members: { type: 'array', items: { type: 'string' }, description: '建群时一并拉进来的成员 tag' },
            },
            required: ['name'],
          }),
          responses: {
            201: jsonResponse({ type: 'object', properties: { room: ref('Room') } }),
            ...errorResponses(),
          },
        },
      },
      '/api/groups': {
        get: {
          tags: ['房间'],
          summary: '群聊分组列表',
          description:
            '分组是**房间级属性、所有人共享**（侧栏里的"文件夹"）。只列出调用者看得见的房间：\n' +
            '普通成员看到自己加入的群，管理员看到全实例的群。',
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: {
                groups: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      sort: { type: 'integer' },
                      createdBy: { type: ['string', 'null'] },
                      createdAt: { type: 'integer' },
                      roomIds: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
                ungrouped: { type: 'array', items: { type: 'string' }, description: '没进任何分组的房间 id' },
              },
            }),
            ...errorResponses(),
          },
        },
        post: {
          tags: ['房间'],
          summary: '新建分组（任何登录用户都能建）',
          requestBody: jsonBody({
            type: 'object',
            properties: { name: { type: 'string', example: '数学建模' } },
            required: ['name'],
          }),
          responses: {
            201: jsonResponse({ type: 'object', properties: { group: { type: 'object' } } }),
            ...errorResponses(),
          },
        },
      },
      '/api/groups/reorder': {
        post: {
          tags: ['房间'],
          summary: '分组拖拽排序',
          description:
            '按 `ids` 的顺序重排分组。顺序只影响展示、可逆且不丢数据，所以任何登录成员都能调；\n' +
            '改名与删除仍然限分组创建者或管理员。',
          requestBody: jsonBody({
            type: 'object',
            properties: { ids: { type: 'array', items: { type: 'string' }, description: '按新顺序排列的分组 id' } },
            required: ['ids'],
          }),
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: { ok: { type: 'boolean' }, applied: { type: 'integer' }, order: { type: 'array', items: { type: 'string' } } },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/groups/{id}': {
        patch: {
          tags: ['房间'],
          summary: '分组改名 / 调整顺序（分组创建者或管理员）',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: jsonBody({
            type: 'object',
            properties: { name: { type: 'string' }, sort: { type: 'integer' } },
          }),
          responses: {
            200: jsonResponse({ type: 'object', properties: { group: { type: 'object' } } }),
            ...errorResponses(),
          },
        },
        delete: {
          tags: ['房间'],
          summary: '删除分组（分组创建者或管理员）：群不会被删，回到「未分组」',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: { ok: { type: 'boolean' }, removed: { type: 'string' }, movedRooms: { type: 'integer' } },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/rooms/join': {
        post: {
          tags: ['房间'],
          summary: '用邀请码加入房间（任何已注册用户都能调）',
          requestBody: jsonBody({
            type: 'object',
            properties: { code: { type: 'string', description: '群聊识别码，大小写/短横线不敏感' } },
            required: ['code'],
          }),
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                alreadyMember: { type: 'boolean' },
                room: ref('Room'),
              },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/rooms/{room}': {
        get: {
          tags: ['房间'],
          summary: '房间详情（含成员与文件）',
          parameters: [roomParam()],
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: {
                room: ref('Room'),
                members: { type: 'array', items: ref('Member') },
                files: { type: 'array', items: ref('SharedFile') },
              },
            }),
            ...errorResponses(),
          },
        },
        patch: {
          tags: ['房间'],
          summary: '改房间名/主题/配置（群主或管理员）',
          parameters: [roomParam()],
          requestBody: jsonBody({
            type: 'object',
            properties: {
              name: { type: 'string' },
              topic: { type: 'string' },
              groupId: {
                type: ['string', 'null'],
                description: '把房间挪进分组（传 null 或空串表示移出分组；分组不存在会返回 404）',
              },
              meta: { type: 'object', description: '房间配置：maxHops / maxTurnsPerChain / contextLines / contextMaxChars 等' },
            },
          }),
          responses: { 200: jsonResponse({ type: 'object', properties: { room: ref('Room') } }), ...errorResponses() },
        },
        delete: {
          tags: ['房间'],
          summary: '解散房间（群主删自己的，管理员删任意）',
          description:
            '默认**彻底清除**：成员关系、消息记录、AI 运行记录（含提示词与输出）都会从数据库删掉，\n' +
            '共享文件区在磁盘上的文件（`data/files/<房间>/`）也会被删除。\n' +
            '想保留文件留档就加 `?keepFiles=1`——房间与聊天记录照删，文件留在磁盘上并在返回里给出目录。\n' +
            '解散时还会掐掉这个房间排队中的 AI 任务与讨论链，正在生成的回复会被丢弃。',
          parameters: [
            roomParam(),
            {
              name: 'keepFiles',
              in: 'query',
              schema: { type: 'string', enum: ['1'] },
              description: '保留磁盘上的共享文件（只删房间与聊天记录）',
            },
          ],
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                removed: { type: 'string' },
                name: { type: 'string' },
                deleted: {
                  type: 'object',
                  properties: {
                    members: { type: 'integer' },
                    messages: { type: 'integer' },
                    files: { type: 'integer' },
                    runs: { type: 'integer' },
                    diskFiles: { type: 'integer' },
                    queuedJobs: { type: 'integer' },
                  },
                },
                freedBytes: { type: 'integer' },
                filesDir: { type: 'string' },
                filesKept: { type: 'boolean' },
                filesDirRemoved: { type: 'boolean' },
                hint: { type: 'string' },
              },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/rooms/{room}/members': {
        post: {
          tags: ['房间'],
          summary: '把已有成员拉进房间',
          parameters: [roomParam()],
          requestBody: jsonBody({
            type: 'object',
            properties: { tag: { type: 'string' } },
            required: ['tag'],
          }),
          responses: { 200: jsonResponse({ type: 'object', properties: { members: { type: 'array', items: { type: 'string' } } } }), ...errorResponses() },
        },
      },
      '/api/rooms/{room}/members/{tag}': {
        delete: {
          tags: ['房间'],
          summary: '移出房间（自己退群，或管理员移除别人）',
          parameters: [
            roomParam(),
            { name: 'tag', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: jsonResponse({ type: 'object', properties: { ok: { type: 'boolean' } } }), ...errorResponses() },
        },
      },
      '/api/rooms/{room}/code/rotate': {
        post: {
          tags: ['房间'],
          summary: '重置邀请码（群主或管理员）',
          parameters: [roomParam()],
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: { ok: { type: 'boolean' }, roomId: { type: 'string' }, code: { type: 'string' } },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/rooms/{room}/messages': {
        get: {
          tags: ['消息'],
          summary: '拉取消息（支持游标与全文检索）',
          parameters: [
            roomParam(),
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 500 } },
            { name: 'before', in: 'query', schema: { type: 'integer' }, description: '取比这个 id 更早的消息' },
            { name: 'after', in: 'query', schema: { type: 'integer' }, description: '取比这个 id 更新的消息（外部 AI 轮询用这个）' },
            { name: 'search', in: 'query', schema: { type: 'string' }, description: '按正文内容模糊匹配' },
            { name: 'q', in: 'query', schema: { type: 'string' }, description: '`search` 的别名（两个都写时以 search 为准）' },
            { name: 'sender', in: 'query', schema: { type: 'string' }, description: '只看某个 tag 发的' },
            tokenParam(),
          ],
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: {
                room: { type: 'object' },
                count: { type: 'integer' },
                messages: { type: 'array', items: ref('Message') },
              },
            }),
            ...errorResponses(),
          },
        },
        post: {
          tags: ['消息'],
          summary: '发消息（@某人会唤醒对应 AI；@全体 唤醒全房间）',
          parameters: [roomParam()],
          description:
            'meta.noRoute=true 表示只发消息、不触发任何 AI；meta.senderTag / asTag 允许同 adapter 的边缘运行器以别的身份发言。\n' +
            '文本里以 / 开头的是控制命令（/help /stop /resume /discuss …），不会触发 AI 接力。',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              text: { type: 'string' },
              files: { type: 'array', items: { type: 'string' } },
              replyTo: { type: ['integer', 'null'] },
              chainId: { type: ['string', 'null'] },
              hop: { type: 'integer' },
              meta: { type: 'object' },
              data: {
                type: 'object',
                description: '结构化载荷（JSON 对象，上限 32KB）；数组要包一层，例如 {"items":[...]}',
              },
            },
            required: ['text'],
          }),
          responses: {
            201: jsonResponse({
              type: 'object',
              properties: {
                message: ref('Message'),
                queued: { type: 'integer', description: '本次排进队列的 AI 任务数' },
              },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/rooms/{room}/messages/{id}': {
        delete: {
          tags: ['消息'],
          summary: '删除一条消息（自己的，或管理员）',
          parameters: [
            roomParam(),
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          ],
          responses: { 200: jsonResponse({ type: 'object', properties: { ok: { type: 'boolean' } } }), ...errorResponses() },
        },
      },
      '/api/rooms/{room}/unread': {
        get: {
          tags: ['消息'],
          summary: '未读消息（服务端负责排除你自己发的）',
          description:
            '给外部客户端用的「谁在等我」：返回游标之后的消息，**默认排除我自己发的**。\n' +
            '排除自己这一步最容易写错、且错了不报错（会静默跳读中间别人的发言），所以由服务端保证。\n' +
            '不给 `after` 就用服务端保存的已读游标（多客户端/重启/换机器都不会漂移）。',
          parameters: [
            roomParam(),
            { name: 'after', in: 'query', schema: { type: 'integer' }, description: '从这条之后算；不给则用服务端存的游标' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 500 } },
            { name: 'includeSelf', in: 'query', schema: { type: 'string', enum: ['1'] }, description: '连自己发的也返回（默认不返回）' },
          ],
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: {
                room: { type: 'object' },
                cursor: {
                  type: 'object',
                  properties: {
                    after: { type: 'integer' },
                    source: { type: 'string', enum: ['query', 'stored'] },
                    stored: { type: 'integer' },
                  },
                },
                count: { type: 'integer' },
                lastId: { type: 'integer' },
                messages: { type: 'array', items: ref('Message') },
              },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/rooms/{room}/read': {
        post: {
          tags: ['消息'],
          summary: '推进已读游标（只前进、不后退）',
          parameters: [roomParam()],
          requestBody: jsonBody({
            type: 'object',
            properties: {
              upTo: { type: 'integer', description: '读到哪个消息 id' },
              latest: { type: 'boolean', description: 'true = 直接标记到最新' },
            },
          }),
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: { ok: { type: 'boolean' }, tag: { type: 'string' }, cursor: { type: 'integer' } },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/rooms/{room}/rulings': {
        get: {
          tags: ['消息'],
          summary: '裁定视图：哪条结论还有效',
          description:
            '把「结论过期」变成可查询的：发一条消息、`data` 里带 `{"kind":"ruling","scope":"<议题>","note":"..."}`，\n' +
            '同一 scope 里**最新的一条算 active**，比它旧的自动 superseded；`data.status="retracted"` 表示主动撤回。\n' +
            '撤掉最新那条之后，这个 scope 会变成「没有生效中的结论」——不会自动退回更旧的结论。',
          parameters: [
            roomParam(),
            { name: 'scope', in: 'query', schema: { type: 'string' } },
            { name: 'all', in: 'query', schema: { type: 'string', enum: ['1'] }, description: '带上历史（含被取代的）' },
          ],
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: {
                room: { type: 'object' },
                count: { type: 'integer' },
                scopes: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      scope: { type: 'string' },
                      active: { type: ['object', 'null'] },
                      history: { type: 'array', items: { type: 'object' } },
                      count: { type: 'integer' },
                    },
                  },
                },
              },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/heartbeat': {
        post: {
          tags: ['实时'],
          summary: '外部客户端心跳：告诉群里「我在，只是忙」',
          description:
            '长任务里的外部客户端定期打一下，成员列表就会显示你报的备注，\n' +
            '而不是因为「3 分钟没活动」被当成没挂着。在线口径 = 3 分钟内带 token 活动过（任何 API 调用都算）。',
          requestBody: jsonBody(
            { type: 'object', properties: { note: { type: 'string', example: '在跑评测，预计 20 分钟' } } },
            false,
          ),
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                tag: { type: 'string' },
                lastSeenAt: { type: 'integer' },
                note: { type: ['string', 'null'] },
                external: { type: 'boolean' },
              },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/rooms/{room}/export': {
        get: {
          tags: ['消息'],
          summary: '导出聊天记录（Markdown / JSON，可直接下载）',
          parameters: [
            roomParam(),
            { name: 'format', in: 'query', schema: { type: 'string', enum: ['md', 'json'], default: 'md' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 2000, maximum: 20000 } },
            { name: 'search', in: 'query', schema: { type: 'string' } },
            { name: 'sender', in: 'query', schema: { type: 'string' } },
            { name: 'system', in: 'query', schema: { type: 'string', enum: ['0', '1'] }, description: 'system=0 时不导出系统消息' },
            tokenParam(),
          ],
          responses: {
            200: {
              description: '导出的正文（带 Content-Disposition: attachment）',
              content: {
                'text/markdown': { schema: { type: 'string' } },
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      room: { type: 'object' },
                      exportedAt: { type: 'integer' },
                      exportedBy: { type: 'string' },
                      count: { type: 'integer' },
                      messages: { type: 'array', items: ref('Message') },
                    },
                  },
                },
              },
            },
            ...errorResponses(),
          },
        },
      },
      '/api/events': {
        get: {
          tags: ['实时'],
          summary: '长轮询取新消息（外部 AI 首选，不需要维护 WebSocket）',
          parameters: [
            { name: 'room', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'after', in: 'query', required: true, schema: { type: 'integer' }, description: '上次拿到的最大 id' },
            { name: 'timeout', in: 'query', schema: { type: 'integer', default: 25000, maximum: 60000 }, description: '没有新消息时最多挂多久（毫秒）' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
            tokenParam(),
          ],
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: {
                messages: { type: 'array', items: ref('Message') },
                lastId: { type: 'integer' },
              },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/inbox': {
        get: {
          tags: ['实时'],
          summary: '收件箱：别人 @ 了我、我还没回的消息',
          description:
            '给 **adapter=external** 的「活着的会话」用的：那个会话活在自己的进程里（例如正在跟你对话的 ChatGPT / Codex），\n' +
            '外部进程没法把它叫醒，所以只能它自己来收。\n\n' +
            '判定「已回」：这条 @ 之后，我在同一个房间发过言 → 不再出现在收件箱里。\n' +
            '配合 `POST /api/rooms/{room}/messages`（带 `replyTo`）回帖即可。',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
            { name: 'minutes', in: 'query', schema: { type: 'integer', default: 720 }, description: '只看最近多少分钟（上限 30 天）' },
            { name: 'all', in: 'query', schema: { type: 'string', enum: ['1'] }, description: '连「已回过」的也列出来，便于复盘' },
            { name: 'room', in: 'query', schema: { type: 'string' }, description: '只看某个房间' },
            { name: 'tag', in: 'query', schema: { type: 'string' }, description: '管理员可查别人的收件箱' },
          ],
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: {
                tag: { type: 'string' },
                window: { type: 'object' },
                count: { type: 'integer' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      room: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
                      message: ref('Message'),
                      ageMs: { type: 'integer' },
                      answered: { type: 'boolean' },
                      myReplyId: { type: ['integer', 'null'] },
                    },
                  },
                },
              },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/rooms/{room}/files': {
        get: {
          tags: ['文件'],
          summary: '共享文件区列表',
          parameters: [roomParam(), tokenParam()],
          responses: {
            200: jsonResponse({ type: 'object', properties: { files: { type: 'array', items: ref('SharedFile') } } }),
            ...errorResponses(),
          },
        },
        post: {
          tags: ['文件'],
          summary: '上传文件（原始 body + X-File-Name 头）',
          description:
            '文件名放 `X-File-Name` 头（推荐做 URL 编码）或 `?name=` 查询参数，两种都支持中文。\n' +
            '默认会上传后自动发一条文件消息；一次汇报要带好几个附件时用 `?silent=1` 静默上传，\n' +
            '再把 file.id 放进 `POST /api/rooms/{room}/messages` 的 `files` 字段，一条消息挂多个附件。',
          parameters: [
            roomParam(),
            { name: 'silent', in: 'query', schema: { type: 'string', enum: ['1'] }, description: '只入库不发消息' },
            { name: 'name', in: 'query', schema: { type: 'string' }, description: '文件名（中英文都行；用它可以不带头）' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' },
                description: '文件名放在 X-File-Name 头里（URI 编码），Content-Type 用文件自己的类型',
              },
            },
          },
          responses: {
            201: jsonResponse({
              type: 'object',
              properties: {
                file: ref('SharedFile'),
                message: ref('Message'),
                queued: { type: 'integer' },
              },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/files/{id}': {
        get: {
          tags: ['文件'],
          summary: '下载 / 预览文件（?download=1 强制下载）',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'download', in: 'query', schema: { type: 'string', enum: ['1'] } },
            tokenParam(),
          ],
          responses: {
            200: {
              description: '文件内容',
              content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
            },
            ...errorResponses(),
          },
        },
        delete: {
          tags: ['文件'],
          summary: '删除文件（上传者或管理员）',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            tokenParam(),
          ],
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                removed: { type: 'string' },
                message: { type: 'string', description: '对聊天里那条附件消息的处理说明' },
              },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/rooms/{room}/agents': {
        get: {
          tags: ['AI'],
          summary: '房间里的 AI 成员（含在线状态与最近运行）',
          parameters: [roomParam()],
          responses: {
            200: jsonResponse({ type: 'object', properties: { agents: { type: 'array', items: ref('Member') } } }),
            ...errorResponses(),
          },
        },
      },
      '/api/rooms/{room}/agents/{tag}/prompt': {
        get: {
          tags: ['AI'],
          summary: '取某个 AI 当前应该看到的提示词（外部客户端自跑时用）',
          parameters: [
            roomParam(),
            { name: 'tag', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'trigger', in: 'query', schema: { type: 'integer' }, description: '触发消息 id' },
          ],
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: { system: { type: 'string' }, prompt: { type: 'string' }, cwd: { type: 'string' } },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/rooms/{room}/agents/{tag}/speak': {
        post: {
          tags: ['AI'],
          summary: '让某个 AI 主动说一句（不需要 @ 它）',
          parameters: [
            roomParam(),
            { name: 'tag', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: jsonResponse({ type: 'object', properties: { ok: { type: 'boolean' } } }), ...errorResponses() },
        },
      },
      '/api/rooms/{room}/discuss': {
        post: {
          tags: ['AI'],
          summary: '发起多 AI 讨论（服务端按轮次驱动它们互相接力）',
          parameters: [roomParam()],
          requestBody: jsonBody({
            type: 'object',
            properties: {
              topic: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              rounds: { type: 'integer', default: 2, minimum: 1, maximum: 6 },
            },
            required: ['topic'],
          }),
          responses: { 200: jsonResponse({ type: 'object' }), ...errorResponses() },
        },
      },
      '/api/rooms/{room}/control': {
        post: {
          tags: ['AI'],
          summary: '暂停 / 恢复 / 停止房间里的 AI 接力',
          parameters: [roomParam()],
          requestBody: jsonBody({
            type: 'object',
            properties: { action: { type: 'string', enum: ['pause', 'resume', 'stop'] } },
            required: ['action'],
          }),
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: { ok: { type: 'boolean' }, paused: { type: 'boolean' }, dropped: { type: 'integer' } },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/agents/{tag}/runs': {
        get: {
          tags: ['AI'],
          summary: '某个 AI 的运行记录（含失败原因）',
          parameters: [
            { name: 'tag', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          ],
          responses: {
            200: jsonResponse({ type: 'object', properties: { runs: { type: 'array', items: ref('Run') } } }),
            ...errorResponses(),
          },
        },
      },
      '/api/agents/{tag}/runs/{id}': {
        get: {
          tags: ['AI'],
          summary: '单次运行的完整提示词与输出',
          parameters: [
            { name: 'tag', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            200: jsonResponse({ type: 'object', properties: { run: ref('Run') } }),
            ...errorResponses(),
          },
        },
      },
      '/api/adapters': {
        get: {
          tags: ['运维'],
          summary: '适配器列表与可用性探测',
          security: [],
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: {
                adapters: { type: 'array', items: { type: 'object' } },
                platform: { type: 'string' },
                repoRoot: { type: 'string' },
              },
            }),
          },
        },
      },
      '/api/usage': {
        get: {
          tags: ['AI'],
          summary: 'token 用量汇总（按 AI 成员）',
          description:
            '只有 CLI 自己上报了用量才会计入（codex 的 “tokens used”、claude 的 usage 字段；多数本地模型不上报）。\n' +
            '所以每个成员都带 `runs` 与 `measuredRuns`：没有数字代表「没上报」，不代表「没花钱」。',
          parameters: [
            { name: 'days', in: 'query', schema: { type: 'integer', default: 7, maximum: 365 } },
            { name: 'room', in: 'query', schema: { type: 'string' } },
            { name: 'tag', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: jsonResponse({
              type: 'object',
              properties: {
                window: { type: 'object' },
                room: { type: ['object', 'null'] },
                total: {
                  type: 'object',
                  properties: {
                    runs: { type: 'integer' },
                    measuredRuns: { type: 'integer' },
                    tokensIn: { type: 'integer' },
                    tokensOut: { type: 'integer' },
                    tokensTotal: { type: 'integer' },
                    costUsd: { type: 'number' },
                    durationMs: { type: 'integer' },
                  },
                },
                byAgent: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      tag: { type: 'string' },
                      nickname: { type: ['string', 'null'] },
                      runs: { type: 'integer' },
                      measuredRuns: { type: 'integer' },
                      tokensTotal: { type: 'integer' },
                      costUsd: { type: 'number' },
                      durationMs: { type: 'integer' },
                    },
                  },
                },
              },
            }),
            ...errorResponses(),
          },
        },
      },
      '/api/health': {
        get: {
          tags: ['运维'],
          summary: '健康检查（不需要登录；默认不跑适配器探测）',
          description:
            '默认只回版本、平台、数据目录与局域网地址，不启动任何子进程（守护进程每 30 秒会打一次这个接口）。\n' +
            '需要适配器可用性时加 `?probe=1`，或者直接读 `/api/adapters`（那里有 30 秒缓存，`?fresh=1` 可强制重探）。',
          parameters: [
            { name: 'probe', in: 'query', schema: { type: 'string', enum: ['1'] }, description: '同时返回适配器探测结果' },
          ],
          security: [],
          responses: { 200: jsonResponse({ type: 'object' }) },
        },
      },
      '/api/status': {
        get: {
          tags: ['运维'],
          summary: '运行状态（在线成员、队列、活动任务、磁盘余量）',
          security: [],
          responses: { 200: jsonResponse({ type: 'object' }) },
        },
      },
    },
  };
}
