import { useEffect, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { Member } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
}

export function AddMemberDialog({ open, onOpenChange, roomId }: Props) {
  const [all, setAll] = useState<Member[]>([]);
  const [query, setQuery] = useState('');
  const [busyTag, setBusyTag] = useState<string | null>(null);
  const members = useChatStore((s) => s.members[roomId] ?? []);
  const addMember = useChatStore((s) => s.addMember);
  const pushToast = useUiStore((s) => s.pushToast);

  useEffect(() => {
    if (!open) return;
    apiClient
      .members()
      .then((res) => setAll(res.members))
      .catch(() => setAll([]));
  }, [open]);

  const inRoom = new Set(members.map((m) => m.tag));
  const candidates = all.filter(
    (m) =>
      !inRoom.has(m.tag) &&
      (!query || m.tag.includes(query.toLowerCase()) || m.nickname.includes(query)),
  );

  const add = async (tag: string) => {
    setBusyTag(tag);
    try {
      await addMember(tag);
      pushToast(`@${tag} 已加入房间`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyTag(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>把成员拉进房间</DialogTitle>
          <DialogDescription>
            这里列出所有已注册的人与 AI。AI 可以是网页里创建的，也可以是命令行注册的。
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索 tag 或昵称"
            className="pl-8"
          />
        </div>

        <div className="thin-scrollbar max-h-72 space-y-1.5 overflow-y-auto">
          {!candidates.length && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              没有可加入的成员了。可以到「AI 成员」页新建一个。
            </p>
          )}
          {candidates.map((member) => (
            <div key={member.tag} className="flex items-center gap-2 rounded-lg border p-2">
              <Avatar member={member} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{member.nickname}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  @{member.tag} · {member.kind === 'agent' ? `AI · ${member.adapterId ?? ''}` : '人类'}
                  {member.triggerMode === 'all' ? ' · 所有消息都参与' : ''}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className={cn(busyTag === member.tag && 'opacity-60')}
                onClick={() => void add(member.tag)}
                disabled={busyTag === member.tag}
              >
                <Plus className="h-3.5 w-3.5" />
                加入
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
