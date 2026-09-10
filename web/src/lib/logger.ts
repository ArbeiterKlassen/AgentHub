/** 统一控制台日志，方便在浏览器里按 [AgentHub] 过滤 */
const PREFIX = '[AgentHub]';

export const log = {
  debug: (...args: unknown[]) => console.debug(PREFIX, ...args),
  info: (...args: unknown[]) => console.info(PREFIX, ...args),
  warn: (...args: unknown[]) => console.warn(PREFIX, ...args),
  error: (...args: unknown[]) => console.error(PREFIX, ...args),
  action: (name: string, detail?: unknown) => console.info(PREFIX, `操作：${name}`, detail ?? ''),
  ws: (...args: unknown[]) => console.info(PREFIX, '[ws]', ...args),
};
