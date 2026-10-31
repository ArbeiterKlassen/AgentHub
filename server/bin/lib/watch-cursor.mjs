/**
 * ah watch 起步判据：一条收件箱条目算「早就等着的」还是「刚来的」。
 *
 * 早先的做法是把首次 /api/inbox 返回的条目整批记成基线集合，于是进程起来到
 * 首次请求返回这段窗口（冷启动实测 1.0–1.4 秒，机器忙时更久）里到达的消息，
 * 会被当成开机前就等着的，从此永远叫不醒值守进程。
 *
 * 现在按时间戳判：只有「确实早于本次启动」才算旧。给了 --after 就以那条消息
 * 为界（消息 id 单调递增，比时钟更可靠），没给才用启动时刻。
 *
 * @param {{id:number, createdAt:number}} item
 * @param {{afterId?:number|null, startedAtMs:number}} cursor
 * @returns {boolean} true = 当成旧消息，不该叫醒
 */
export function isOlderThanStart(item, { afterId = null, startedAtMs } = {}) {
  if (afterId !== null && afterId !== undefined) return item.id <= afterId;
  return item.createdAt <= startedAtMs;
}

/** 收件箱返回值 → 扁平条目，watch 的输出与 pending 落盘共用这个形状。 */
export function flattenInboxItem(item) {
  return {
    room: item.room.name,
    id: item.message.id,
    senderTag: item.message.senderTag,
    senderNickname: item.message.senderNickname,
    createdAt: item.message.createdAt,
    text: item.message.text,
  };
}
