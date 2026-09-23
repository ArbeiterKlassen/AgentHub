import { useState } from 'react';
import {
  AtSign,
  Bot,
  Check,
  Copy,
  CornerUpLeft,
  Download,
  FileText,
  Info,
  Reply,
  Trash2,
} from 'lucide-react';
import type { ChatMessage, Member, SharedFile } from '@/lib/types';
import { Avatar } from '@/components/Avatar';
import { ImageAttachment } from '@/components/ImageAttachment';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn, copyText } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { localizedSystemText } from '@/lib/messageText';
import { isImageFile } from '@/lib/fileKind';
import { formatSize, formatTime, isAllMentionToken, splitMentions } from '@/lib/format';
import { downloadUrl } from '@/lib/api';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import { log } from '@/lib/logger';

interface MessageItemProps {
  message: ChatMessage;
  members: Member[];
  files: SharedFile[];
  replyTo?: ChatMessage | null;
  onReply: (message: ChatMessage) => void;
  onDelete: (message: ChatMessage) => void;
}

function MentionText({ text, onMention }: { text: string; onMention: (tag: string) => void }) {
  return (
    <>
      {splitMentions(text).map((part, index) =>
        part.type === 'mention' ? (
          <button
            key={index}
            type="button"
            className={cn('mention-chip hover:underline', isAllMentionToken(part.value) && 'mention-chip-all')}
            onClick={() => onMention(part.value.slice(1))}
          >
            {part.value}
          </button>
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </>
  );
}

export function MessageItem({ message, members, files, replyTo, onReply, onDelete }: MessageItemProps) {
  const { t } = useI18n();
  const me = useSessionStore((s) => s.member);
  const server = useSessionStore((s) => s.server);
  const token = useSessionStore((s) => s.token);
  const insertToComposer = useUiStore((s) => s.insertToComposer);
  const pushToast = useUiStore((s) => s.pushToast);
  const [copied, setCopied] = useState(false);

  const sender = members.find((m) => m.tag === message.senderTag);
  const isOwn = message.senderTag === me?.tag;
  const isSystem = message.senderKind === 'system' || message.type === 'system';

  if (isSystem) {
    const level = String(message.meta?.level ?? 'info');
    // 系统消息按服务端给的模板 key 本地化，认不出就退回原文（见 lib/messageText.ts）
    const localized = localizedSystemText(message);
    /**
     * 单行系统消息用胶囊形（rounded-full）好看，多行的就必须换成普通圆角：
     * border-radius:9999px 会被浏览器夹到「高度的一半」，于是 /help、/who 这种多行消息
     * 会变成左右两个巨大半圆弧，文字压到弧线上（看起来像个畸形的蛋）。
     */
    const multiline = message.text.includes('\n');
    return (
      <div className="my-2 flex justify-center px-4">
        <div
          className={cn(
            'flex max-w-2xl items-start gap-2 border px-3 text-xs text-muted-foreground',
            multiline ? 'rounded-2xl py-2 leading-relaxed' : 'rounded-full py-1.5',
            level === 'warn' && 'border-amber-500/40 text-amber-600 dark:text-amber-400',
            level === 'error' && 'border-destructive/40 text-destructive',
          )}
        >
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="whitespace-pre-wrap break-words">{localized ?? message.text}</span>
        </div>
      </div>
    );
  }

  const attachments = message.files
    .map((id) => files.find((f) => f.id === id))
    .filter((f): f is SharedFile => Boolean(f));

  /** 文件被删掉后聊天里不再有可点的附件，给这条消息补一个「文件已删除」的说明 */
  const deletedFiles = (message.meta?.fileDeleted as string[] | undefined) ?? [];
  /**
   * 服务端生成的文件消息（type=file）也带模板 key，例如「📎 上传了文件 X」。
   * 它走的是普通消息分支，所以这里同样按语言渲染；认不出 key 就显示原文。
   */
  const displayText = localizedSystemText(message) ?? message.text;
  /** 结构化载荷：机器之间交换数据用（有内容才显示那块折叠区） */
  const hasData = Boolean(message.data && Object.keys(message.data).length);
  const isRuling = String(message.data?.kind ?? '') === 'ruling';
  const rulingStatus = String(message.data?.status ?? 'active');

  const doCopy = async () => {
    await copyText(message.text);
    setCopied(true);
    log.action('复制消息', message.id);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={cn('group flex gap-6 px-4 py-1.5', isOwn ? 'flex-row-reverse' : 'flex-row')}>
      <Avatar member={sender ?? { nickname: message.senderNickname, avatar: '', color: '#64748b', kind: 'human' }} />

      <div className={cn('flex min-w-0 max-w-[86%] flex-col gap-1 md:max-w-[76%]', isOwn ? 'items-end' : 'items-start')}>
        <div className={cn('flex items-center gap-1.5 text-[11px] text-muted-foreground', isOwn && 'flex-row-reverse')}>
          <span className="font-medium text-foreground/80">{message.senderNickname}</span>
          <span>@{message.senderTag}</span>
          {sender?.kind === 'agent' && (
            <Badge variant="secondary" className="h-4 gap-0.5 px-1 text-[10px]">
              <Bot className="h-2.5 w-2.5" />
              {sender.adapterId ?? 'AI'}
            </Badge>
          )}
          {message.hop > 0 && (
          <span className="rounded bg-muted px-1 text-[10px]" title={t('message.hopTitle')}>
            {t('message.hop', { n: message.hop })}
            </span>
          )}
          {Boolean(message.meta?.lateReply) && (
            <span
              className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-400"
              title={t('message.lateReplyTitle')}
            >
              {t('message.lateReply')}
            </span>
          )}
          <span>{formatTime(message.createdAt)}</span>
        </div>

        {replyTo && (
          <div
            className={cn(
              'flex max-w-full items-center gap-1 truncate rounded border-l-2 border-primary/50 bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground',
            )}
          >
            <Reply className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {replyTo.senderNickname}：{replyTo.text.slice(0, 60)}
            </span>
          </div>
        )}

        <div
          className={cn(
            'animate-bubble-in whitespace-pre-wrap break-words px-3.5 py-2 text-sm leading-relaxed shadow-sm',
            isOwn
              ? 'bubble-own bg-primary text-primary-foreground'
              : 'bubble-other border bg-card text-card-foreground',
          )}
        >
            <MentionText text={displayText} onMention={(tag) => insertToComposer(`@${tag} `)} />
        </div>

        {attachments.length > 0 && (
          <div className={cn('flex flex-wrap items-start gap-2', isOwn && 'justify-end')}>
            {attachments.map((file) =>
              isImageFile(file) ? (
                <ImageAttachment
                  key={file.id}
                  file={file}
                  server={server}
                  token={token}
                  className={cn(isOwn && 'items-end text-right')}
                />
              ) : (
                <a
                  key={file.id}
                  href={downloadUrl(server, file.id, token)}
                  className="flex items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-xs transition-colors hover:bg-accent"
                  download={file.name}
                >
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="max-w-[180px] truncate font-medium">{file.name}</span>
                  <span className="text-muted-foreground">{formatSize(file.size)}</span>
                  <Download className="h-3.5 w-3.5 text-muted-foreground" />
                </a>
              ),
            )}
          </div>
        )}

        {deletedFiles.length > 0 && (
          <div className={cn('flex items-center gap-1 text-[11px] text-muted-foreground', isOwn && 'justify-end')}>
            <Trash2 className="h-3 w-3" />
            {t('message.filesDeleted', { n: deletedFiles.length })}
          </div>
        )}

        {/* 结构化载荷：机器之间交换数字表用的，人点开才看 */}
        {hasData && (
          <details className={cn('rounded-lg border bg-muted/30 px-2 py-1 text-[11px]', isOwn && 'text-right')}>
            <summary className="cursor-pointer select-none text-muted-foreground">
              <span className="font-mono">{'{ }'}</span> {t('message.structuredData')}
              {isRuling && (
                <span
                  className={cn(
                    'ml-1.5 rounded px-1 py-0.5 text-[10px]',
                    rulingStatus === 'active'
                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                      : 'bg-muted text-muted-foreground line-through',
                  )}
                >
                  {t('message.ruling')} · {rulingStatus === 'active' ? t('message.rulingActive') : t('message.rulingSuperseded')}
                </span>
              )}
            </summary>
            <pre className="thin-scrollbar mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-words text-left font-mono text-[10px] leading-relaxed text-muted-foreground">
              {JSON.stringify(message.data, null, 2)}
            </pre>
          </details>
        )}

        {/* 触屏没有 hover：小屏常显操作条，桌面端才做悬停显示 */}
        <div
          className={cn(
            'flex items-center gap-0.5 transition-opacity md:opacity-0 md:group-hover:opacity-100',
            isOwn && 'flex-row-reverse',
          )}
        >
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={() => void doCopy()}>
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {t('message.copy')}
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={() => onReply(message)}>
            <CornerUpLeft className="h-3 w-3" />
              {t('message.quote')}
          </Button>
          {!isOwn && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              onClick={() => insertToComposer(`@${message.senderTag} `)}
            >
              <AtSign className="h-3 w-3" />
              {t('message.replyTo')}
            </Button>
          )}
          {(isOwn || me?.role === 'admin') && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-destructive"
              onClick={() => {
              pushToast(t('message.deleted'), 'info');
                onDelete(message);
              }}
            >
              <Trash2 className="h-3 w-3" />
              {t('common.delete')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
