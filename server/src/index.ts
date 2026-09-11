import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { HOST, PORT, WEB_DIST, DATA_DIR, ensureDirs, lanAddresses, REPO_ROOT } from './env.js';
import { buildApiRouter, serveWeb } from './api.js';
import { authMiddleware, extractToken } from './auth.js';
import { findMemberByToken, getDb, listRooms, listRoomMemberTags, isRoomMember } from './db.js';
import { broadcast, subscribe, unsubscribe, type HubEvent } from './hub.js';
import { loadAdapters } from './adapters.js';

ensureDirs();

// 上次进程被杀掉时，正在跑的 agent_runs 会永远停在 running（子进程随父进程退出，没人再收尾）。
// 启动时统一标记为「中断」，否则界面上会一直显示"思考中/队列里还有任务"。
const staleRuns = getDb()
  .prepare(
    `UPDATE agent_runs
        SET status = 'interrupted',
            error = COALESCE(error, '服务重启导致中断（进程随服务退出）'),
            finished_at = COALESCE(finished_at, ?)
      WHERE status = 'running'`,
  )
  .run(Date.now());
if (Number(staleRuns.changes) > 0) {
  console.log(`  ├─ 已把上次遗留的 ${staleRuns.changes} 条运行记录标记为「中断」`);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => {
  // 本地工具：允许任意来源直连（Vite 开发服务器、CLI、其它脚本）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Auth-Token, X-File-Name');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});
app.use(authMiddleware);
app.use('/api', buildApiRouter());

const server = http.createServer(app);
serveWeb(app, WEB_DIST);

const wss = new WebSocketServer({ noServer: true });

interface SocketState {
  subId: number;
  tag: string;
  alive: boolean;
}

const clients = new Map<WebSocket, SocketState>();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const token = url.searchParams.get('token') ?? '';
  const member = token ? findMemberByToken(token) : undefined;
  if (!member) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const requestedRooms = (url.searchParams.get('rooms') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const rooms = requestedRooms.length
      ? requestedRooms
      : listRooms()
          .filter((room) => isRoomMember(room.id, member.tag) || member.role === 'admin')
          .map((room) => room.id);

    const subId = subscribe(
      (event: HubEvent) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
      },
      {
        tag: member.tag,
        // 这里必须传「显式请求的房间」而不是上面的快照 rooms：
        // 一旦 sub.rooms 非空，hub.broadcast 会走静态匹配、filter 失效，
        // 导致「连接之后才创建/加入的房间」收不到实时消息（只能刷新重连）。
        rooms: requestedRooms,
        // 未显式指定房间时按成员资格动态过滤，这样连接后新建的房间也能实时收到
        filter: (roomId) => isRoomMember(roomId, member.tag) || member.role === 'admin',
      },
    );
    clients.set(ws, { subId, tag: member.tag, alive: true });
    ws.send(
      JSON.stringify({
        type: 'hello',
        data: {
          member: { tag: member.tag, nickname: member.nickname, role: member.role },
          rooms,
          serverTime: Date.now(),
        },
        ts: Date.now(),
      }),
    );

    ws.on('message', (raw) => {
      let payload: { type?: string; roomId?: string } = {};
      try {
        payload = JSON.parse(String(raw)) as { type?: string; roomId?: string };
      } catch {
        return;
      }
      if (payload.type === 'watch' && payload.roomId) {
        const state = clients.get(ws);
        if (state && (isRoomMember(payload.roomId, state.tag) || member.role === 'admin')) {
          broadcast({ type: 'system', data: { note: 'client watching' }, ts: Date.now() });
        }
      }
      if (payload.type === 'ping') {
        ws.send(JSON.stringify({ type: 'system', data: { pong: true }, ts: Date.now() }));
      }
    });

    ws.on('pong', () => {
      const state = clients.get(ws);
      if (state) state.alive = true;
    });

    ws.on('close', () => {
      const state = clients.get(ws);
      if (state) unsubscribe(state.subId);
      clients.delete(ws);
    });
  });
});

setInterval(() => {
  for (const [ws, state] of clients) {
    if (!state.alive) {
      ws.terminate();
      unsubscribe(state.subId);
      clients.delete(ws);
      continue;
    }
    state.alive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30_000).unref();

server.listen(PORT, HOST, () => {
  const adapters = loadAdapters().filter((a) => !a.disabled);
  const lans = lanAddresses();
  console.log('');
  console.log('  AgentHub 服务已启动');
  console.log(`  ├─ 本机地址   http://127.0.0.1:${PORT}`);
  if (lans.length) {
    const first = lans[0];
    console.log(`  ├─ 手机访问   http://${first.address}:${PORT}   （${first.iface}）`);
    for (const extra of lans.slice(1, 4)) {
      console.log(`  │             http://${extra.address}:${PORT}   （${extra.iface}）`);
    }
  } else {
    console.log('  ├─ 手机访问   未发现局域网地址（可能只有回环网卡）');
  }
  console.log(`  ├─ WebSocket  ws://127.0.0.1:${PORT}/ws?token=<你的 token>`);
  console.log(`  ├─ 数据目录   ${DATA_DIR}`);
  console.log(`  ├─ 适配器     ${adapters.map((a) => a.id).join(', ')}`);
  const hasWeb = (() => {
    try {
      return fs.existsSync(WEB_DIST);
    } catch {
      return false;
    }
  })();
  console.log(`  └─ 前端       ${hasWeb ? '已由本服务托管（访问上面的地址即可）' : '未构建：开发时用 npm run dev:web'}`);
  console.log('');
  console.log('  常用 CLI：');
  console.log('    node server/bin/ah.mjs register --tag alice --nickname Alice');
  console.log('    node server/bin/ah.mjs send "大家好，@codex-1 帮忙看下这个方案" --room general');
  console.log(`    node server/bin/ah.mjs history --room general --limit 20`);
  console.log('');
  console.log(`  仓库根目录：${REPO_ROOT}`);
  console.log('');
});
