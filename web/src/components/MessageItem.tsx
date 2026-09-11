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
    return (
      <div className="my-2 flex justify-center px-4">
        <div
          className={cn(
            'flex max-w-2xl items-start gap-2 rounded-full border px-3 py-1.5 text-xs text-muted-foreground',
            level === 'warn' && 'border-amber-500/40 text-amber-600 dark:text-amber-400',
            level === 'error' && 'border-destructive/40 text-destructive',
          )}
        >
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="whitespace-pre-wrap break-words">{message.text}</span>
        </div>
      </div>
    );
  }

  const attachments = message.files
    .map((id) => files.find((f) => f.id === id))
    .filter((f): f is SharedFile => Boolean(f));

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
            <span className="rounded bg-muted px-1 text-[10px]" title="在本次讨论里的接力跳数">
              接力 {message.hop}
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
          <MentionText text={message.text} onMention={(tag) => insertToComposer(`@${tag} `)} />
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

        {/* 触屏没有 hover：小屏常显操作条，桌面端才做悬停显示 */}
        <div
          className={cn(
            'flex items-center gap-0.5 transition-opacity md:opacity-0 md:group-hover:opacity-100',
            isOwn && 'flex-row-reverse',
          )}
        >
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={() => void doCopy()}>
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            复制
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={() => onReply(message)}>
            <CornerUpLeft className="h-3 w-3" />
            引用
          </Button>
          {!isOwn && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              onClick={() => insertToComposer(`@${message.senderTag} `)}
            >
              <AtSign className="h-3 w-3" />
              回复 TA
            </Button>
          )}
          {(isOwn || me?.role === 'admin') && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-destructive"
              onClick={() => {
                pushToast('已删除该消息', 'info');
                onDelete(message);
              }}
            >
              <Trash2 className="h-3 w-3" />
              删除
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
