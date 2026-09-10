import { log } from './logger';
import type { RealtimeEvent } from './types';
import { wsUrl } from './utils';

export interface RealtimeHandlers {
  onEvent: (event: RealtimeEvent) => void;
  onStateChange?: (state: 'connecting' | 'open' | 'closed') => void;
}

/** 带自动重连与心跳的 WebSocket 客户端；断线时指数退避 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;

  constructor(
    private server: string,
    private token: string,
    private rooms: string[],
    private handlers: RealtimeHandlers,
  ) {}

  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    this.handlers.onStateChange?.('connecting');
    const url = wsUrl(this.server, this.token, this.rooms);
    log.ws('连接中', url.replace(this.token, '***'));
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      log.ws('创建连接失败', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.handlers.onStateChange?.('open');
      log.ws('已连接');
      this.pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 25_000);
    };

    ws.onmessage = (event) => {
      try {
        this.handlers.onEvent(JSON.parse(event.data) as RealtimeEvent);
      } catch (err) {
        log.ws('解析消息失败', err);
      }
    };

    ws.onclose = () => {
      this.handlers.onStateChange?.('closed');
      if (this.pingTimer) window.clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.scheduleReconnect();
    };

    ws.onerror = () => log.ws('连接错误');
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.attempt += 1;
    const delay = Math.min(1000 * 2 ** (this.attempt - 1), 15_000);
    log.ws(`将在 ${delay}ms 后重连（第 ${this.attempt} 次）`);
    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
  }

  close(): void {
    this.closed = true;
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
