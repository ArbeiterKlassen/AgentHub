#!/usr/bin/env node
/**
 * ah watch 起步判据的单元测试。
 *
 * 为什么单独测这个：这条逻辑的 bug 是「进程已启动、首次 /api/inbox 还没返回」
 * 那一两秒里到达的消息被永久忽略，从外部用黑盒只能碰运气复现。所以判据被提到
 * server/bin/lib/watch-cursor.mjs，这里直接钉死边界。
 */
import { isOlderThanStart, flattenInboxItem } from '../server/bin/lib/watch-cursor.mjs';

let failed = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `（拿到 ${actual}，期望 ${expected}）`}`);
};

const startedAtMs = 1_700_000_000_000;

// 启动前就在等的消息 → 当成旧消息，不叫醒（否则一开机就被历史 @ 叫醒）
check(
  '启动前 1 毫秒的消息算旧的',
  isOlderThanStart({ id: 10, createdAt: startedAtMs - 1 }, { startedAtMs }),
  true,
);

// 启动后到达的消息 → 必须叫醒。这正是旧实现吞掉的那条。
check(
  '启动后 1 毫秒的消息算新的（旧实现会吞掉）',
  isOlderThanStart({ id: 11, createdAt: startedAtMs + 1 }, { startedAtMs }),
  false,
);

// 首次快照里就带着的新消息，仍然算新（窗口期到达的典型情形）
check(
  '首次快照里含有的新消息算新的',
  isOlderThanStart({ id: 12, createdAt: startedAtMs + 850 }, { startedAtMs }),
  false,
);

// 给了 --after 就以消息 id 为界，比时钟可靠（跨机时钟偏差也不怕）
check(
  '--after 边界上的消息算旧的',
  isOlderThanStart({ id: 20, createdAt: startedAtMs + 5000 }, { afterId: 20, startedAtMs }),
  true,
);
check(
  '--after 之后的消息算新的',
  isOlderThanStart({ id: 21, createdAt: startedAtMs - 5000 }, { afterId: 20, startedAtMs }),
  false,
);

// 水位线：与时钟无关。本机时钟快于服务器时，新消息的 createdAt 会小于启动时刻，
// 但 id 比水位大，所以仍然要算新 —— 否则就是静默吞消息。
check(
  '水位线之后的消息算新的（本机时钟偏快）',
  isOlderThanStart(
    { id: 31, createdAt: startedAtMs - 60_000 },
    { startedAtMs, maxIdAtStart: 30 },
  ),
  false,
);
check(
  '水位线之内、且早于启动的消息算旧的',
  isOlderThanStart(
    { id: 30, createdAt: startedAtMs - 1000 },
    { startedAtMs, maxIdAtStart: 30 },
  ),
  true,
);

const flat = flattenInboxItem({
  room: { name: '值班房间' },
  message: {
    id: 7,
    senderTag: 'talker',
    senderNickname: '说话的AI',
    createdAt: 123,
    text: '正文',
    extra: '不该带出来',
  },
});
check('扁平条目字段齐全', Object.keys(flat).sort().join(','), 'createdAt,id,room,senderNickname,senderTag,text');

if (failed) {
  console.error(`\n${failed} 项不通过`);
  process.exit(1);
}
console.log('\nALL PASS');
