import { useEffect, useMemo, useRef, useState } from 'react';
import { AtSign, Loader2, Paperclip, Send, Users } from 'lucide-react';
import { useChatStore } from '@/stores/chat';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Avatar } from '@/components/Avatar';
import { DiscussDialog } from '@/components/dialogs/DiscussDialog';
import { cn } from '@/lib/utils';
import { ALL_MENTION_ALIASES } from '@/lib/format';
import { log } from '@/lib/logger';
import type { Member } from '@/lib/types';

const COMMANDS = [
  { cmd: '/help', desc: '查看可用命令' },
  { cmd: '/discuss ', desc: '发起多 AI 讨论，如 /discuss 架构评审 @codex-1 @claude-1 --rounds 2' },
  { cmd: '/speak @', desc: '让某个 AI 主动发言' },
  { cmd: '/pause', desc: '暂停本房间 AI 自动接力' },
  { cmd: '/resume', desc: '恢复自动接力' },
  { cmd: '/stop', desc: '清空排队任务并暂停' },
  { cmd: '/who', desc: '查看房间成员' },
];

interface ComposerProps {
  roomId: string;
  members: Member[];
  replyTo: { id: number; text: string; senderNickname: string } | null;
  onClearReply: () => void;
}

/** @ 候选：房间成员 + 一条「全体成员」群发项 */
interface MentionItem {
  key: string;
  tag: string;
  nickname: string;
  kindLabel: string;
  member: Member | null;
}

export function Composer({ roomId, members, replyTo, onClearReply }: ComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [discussOpen, setDiscussOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const me = useSessionStore((s) => s.member);
  const send = useChatStore((s) => s.send);
  const upload = useChatStore((s) => s.upload);
  const pushToast = useUiStore((s) => s.pushToast);
  const draftInsert = useUiStore((s) => s.draftInsert);

  const agents = useMemo(() => members.filter((m) => m.kind === 'agent'), [members]);

  /** @ 提及候选：当前光标前最后一段 @xxx */
  const mentionQuery = useMemo(() => {
    const match = /@([a-z0-9_\-\u4e00-\u9fa5]*)$/i.exec(text);
    return match ? match[1].toLowerCase() : null;
  }, [text]);

  const candidates = useMemo<MentionItem[]>(() => {
    if (mentionQuery === null) return [];
    const items: MentionItem[] = [];
    const hasOtherAgent = members.some((m) => m.kind === 'agent' && m.tag !== me?.tag);
    const allHit =
      !mentionQuery ||
      ALL_MENTION_ALIASES.some((alias) => alias.startsWith(mentionQuery) || mentionQuery.startsWith(alias));
    if (hasOtherAgent && allHit) {
      items.push({
        key: '__all__',
        tag: 'all',
        nickname: '全体成员',
        kindLabel: `群发 · 一次唤醒 ${members.filter((m) => m.kind === 'agent' && m.tag !== me?.tag).length} 个 AI`,
        member: null,
      });
    }
    for (const m of members) {
      if (m.tag === me?.tag) continue;
      if (!mentionQuery || m.tag.includes(mentionQuery) || m.nickname.toLowerCase().includes(mentionQuery)) {
        items.push({
          key: m.tag,
          tag: m.tag,
          nickname: m.nickname,
          kindLabel: m.kind === 'agent' ? `AI · ${m.adapterId ?? ''}` : '人类',
          member: m,
        });
      }
    }
    return items;
  }, [mentionQuery, members, me?.tag]);

  const commandQuery = text.startsWith('/') && !text.includes(' ') ? text : null;
  const commandMatches = useMemo(
    () => (commandQuery ? COMMANDS.filter((c) => c.cmd.startsWith(commandQuery)) : []),
    [commandQuery],
  );

  useEffect(() => {
    setPickerOpen(candidates.length > 0);
    setPickerIndex(0);
  }, [candidates.length, mentionQuery]);

  // 消息里的「@TA」「引用」等按钮会把文本插进输入框
  useEffect(() => {
    if (!draftInsert) return;
    setText((prev) => (prev.endsWith(' ') || prev === '' ? prev + draftInsert.text : `${prev} ${draftInsert.text}`));
    textareaRef.current?.focus();
  }, [draftInsert]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const applyMention = (item: MentionItem) => {
    setText((prev) => prev.replace(/@([a-z0-9_\-\u4e00-\u9fa5]*)$/i, `@${item.tag} `));
    setPickerOpen(false);
    textareaRef.current?.focus();
  };

  const submit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await send(value, [], replyTo?.id ?? null);
      setText('');
      onClearReply();
      log.action('发送消息', { roomId, length: value.length });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen && candidates.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setPickerIndex((i) => (i + 1) % candidates.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setPickerIndex((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        applyMention(candidates[pickerIndex]);
        return;
      }
      if (event.key === 'Escape') {
        setPickerOpen(false);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const onPickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files).slice(0, 5)) {
      try {
        await upload(file);
        pushToast(`已上传 ${file.name}`, 'success');
      } catch (err) {
        pushToast(err instanceof Error ? err.message : String(err), 'error');
      }
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="shrink-0 border-t bg-background/95 px-4 py-3">
      <div className="mx-auto max-w-4xl">
        {replyTo && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
            <span className="font-medium">引用 {replyTo.senderNickname}</span>
            <span className="truncate">{replyTo.text.slice(0, 80)}</span>
            <button type="button" className="ml-auto hover:text-foreground" onClick={onClearReply}>
              取消
            </button>
          </div>
        )}

        <div className="relative">
          {(pickerOpen && candidates.length > 0) || commandMatches.length > 0 ? (
            <div className="absolute bottom-full left-0 mb-2 max-h-64 w-80 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg">
              {commandMatches.length > 0
                ? commandMatches.map((item) => (
                    <button
                      key={item.cmd}
                      type="button"
                      className="flex w-full flex-col items-start rounded px-2 py-1.5 text-left hover:bg-accent"
                      onClick={() => {
                        setText(item.cmd);
                        textareaRef.current?.focus();
                      }}
                    >
                      <span className="font-mono text-xs">{item.cmd}</span>
                      <span className="text-[11px] text-muted-foreground">{item.desc}</span>
                    </button>
                  ))
                : candidates.map((item, index) => (
                    <button
                      key={item.key}
                      type="button"
                      onMouseEnter={() => setPickerIndex(index)}
                      onClick={() => applyMention(item)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left',
                        index === pickerIndex ? 'bg-accent' : 'hover:bg-accent/60',
                      )}
                    >
                      {item.member ? (
                        <Avatar member={item.member} size="xs" />
                      ) : (
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                          全
                        </span>
                      )}
                      <span className="text-sm font-medium">{item.nickname}</span>
                      <span className="text-xs text-muted-foreground">@{item.tag}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground">{item.kindLabel}</span>
                    </button>
                  ))}
            </div>
          ) : null}

          <div className="flex items-end gap-2 rounded-xl border bg-card p-2 shadow-sm focus-within:ring-1 focus-within:ring-ring">
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => void onPickFiles(e.target.files)} />
            <Button
              variant="ghost"
              size="icon"
              title="上传文件到共享文件区"
              onClick={() => fileRef.current?.click()}
              disabled={sending}
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <Textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
                if (files.length) {
                  e.preventDefault();
                  void onPickFiles(e.clipboardData.files);
                }
              }}
              placeholder="发消息…  用 @ 唤醒某个 AI，@all 唤醒全体 AI，Enter 发送 / Shift+Enter 换行"
              className="min-h-[38px] resize-none border-0 bg-transparent py-2 shadow-none focus-visible:ring-0"
              rows={1}
            />
            <Button
              variant="ghost"
              size="icon"
              title="发起多 AI 讨论"
              onClick={() => setDiscussOpen(true)}
              disabled={!agents.length}
              className="hidden sm:inline-flex"
            >
              <Users className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="插入 @提及"
              onClick={() => {
                setText((prev) => `${prev}@`);
                textareaRef.current?.focus();
              }}
            >
              <AtSign className="h-4 w-4" />
            </Button>
            <Button onClick={() => void submit()} disabled={sending || !text.trim()} size="icon" title="发送（Enter）">
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <div className="mt-1.5 flex items-center gap-3 px-1 text-[11px] text-muted-foreground">
          <span>
            已连接 {agents.length} 个 AI：{agents.map((a) => `@${a.tag}`).join(' ') || '（还没有 AI 成员）'}
          </span>
          <span className="ml-auto hidden sm:inline">
            /discuss 发起讨论 · /pause 暂停接力 · @all 群发全体 AI · 拖拽文件到窗口即可共享
          </span>
        </div>
      </div>

      <DiscussDialog open={discussOpen} onOpenChange={setDiscussOpen} agents={agents} />
    </div>
  );
}
