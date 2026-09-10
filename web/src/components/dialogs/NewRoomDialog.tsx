import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/Avatar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { log } from '@/lib/logger';
import type { Member } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewRoomDialog({ open, onOpenChange }: Props) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [allMembers, setAllMembers] = useState<Member[]>([]);
  const [busy, setBusy] = useState(false);
  const createRoom = useChatStore((s) => s.createRoom);
  const pushToast = useUiStore((s) => s.pushToast);

  useEffect(() => {
    if (!open) return;
    apiClient
      .members()
      .then((res) => setAllMembers(res.members))
      .catch(() => setAllMembers([]));
  }, [open]);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const room = await createRoom({ name: name.trim(), topic: topic.trim(), members: selected });
      log.action('创建房间', room.name);
      pushToast(`房间「${room.name}」已创建`, 'success');
      onOpenChange(false);
      setName('');
      setTopic('');
      setSelected([]);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建群聊房间</DialogTitle>
          <DialogDescription>创建后把 AI 成员拉进来，就可以 @ 它们干活了。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="room-name">房间名</Label>
            <Input
              id="room-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：产品设计评审"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="room-topic">主题（可选）</Label>
            <Input
              id="room-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="这个群聊要讨论什么"
            />
          </div>
          <div className="space-y-1.5">
            <Label>初始成员</Label>
            <div className="thin-scrollbar max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
              {!allMembers.length && <p className="p-2 text-xs text-muted-foreground">还没有任何成员</p>}
              {allMembers.map((member) => {
                const checked = selected.includes(member.tag);
                return (
                  <button
                    key={member.tag}
                    type="button"
                    onClick={() =>
                      setSelected((prev) =>
                        checked ? prev.filter((t) => t !== member.tag) : [...prev, member.tag],
                      )
                    }
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
                      checked ? 'bg-accent' : 'hover:bg-accent/50',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-4 w-4 items-center justify-center rounded border text-[10px]',
                        checked ? 'bg-primary text-primary-foreground' : 'border-input',
                      )}
                    >
                      {checked ? '✓' : ''}
                    </span>
                    <Avatar member={member} size="xs" />
                    <span>{member.nickname}</span>
                    <span className="text-xs text-muted-foreground">@{member.tag}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {member.kind === 'agent' ? `AI · ${member.adapterId ?? ''}` : '人类'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !name.trim()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
