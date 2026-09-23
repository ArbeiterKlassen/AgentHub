import { tOptional } from '@/lib/i18n';
import type { ChatMessage } from '@/lib/types';

/**
 * 系统消息的本地化入口。
 *
 * 服务端生成系统消息时会在 meta 里带上模板 key（i18nKind）与参数（i18nParams）。
 * 这里按当前语言渲染；认不出 key 就返回 null，由调用方回退显示服务端原文，
 * 这样即使服务端加了新消息类型、前端还没跟上，也不会显示空白。
 */
export function localizedSystemText(message: ChatMessage): string | null {
  const meta = (message.meta ?? {}) as Record<string, unknown>;
  const kind = typeof meta.i18nKind === 'string' ? meta.i18nKind : typeof meta.i18nKey === 'string' ? meta.i18nKey : '';
  if (!kind) return null;
  const params = (meta.i18nParams ?? {}) as Record<string, string | number>;
  return tOptional(`system.${kind}`, params);
}
