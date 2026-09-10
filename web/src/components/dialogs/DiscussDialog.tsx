import { useState } from 'react';
import { Loader2 } from 'lucide-react';
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
import type { Member } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Member[];
}

export function DiscussDialog({ open, onOpenChange, agents }: Props) {
  const [topic, setTopic] = useState('');
  const [rounds, setRounds] = useState('2');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const discuss = useChatStore((s) => s.discuss);
  const pushToast = useUiStore((s) => s.pushToast);

  const submit = async () => {
    const participants = selected.length ? selected : agents.map((a) => a.tag);
    if (!topic.trim() || !participants.length) return;
    setBusy(true);
    try {
      await discuss(topic.trim(), participants, Number(rounds));
      pushToast('讨论已开始，可以在消息区实时观看', 'success');
      onOpenChange(false);
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
          <DialogTitle>发起多 AI 讨论</DialogTitle>
          <DialogDescription>
            系统会按顺序点名，让每个 AI 依次发言，后发言的 AI 能看到前面的观点。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="topic">讨论主题</Label>
            <Input
              id="topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="例如：共享文件区应该怎么设计权限"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>参与者（默认全部 AI）</Label>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() =>
                  setSelected(selected.length === agents.length ? [] : agents.map((a) => a.tag))
                }
              >
                {selected.length === agents.length && agents.length > 0 ? '清空' : '全选'}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {agents.map((agent) => {
                const checked = selected.includes(agent.tag);
                return (
                  <button
                    key={agent.tag}
                    type="button"
                    onClick={() =>
                      setSelected((prev) => (checked ? prev.filter((t) => t !== agent.tag) : [...prev, agent.tag]))
                    }
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                      checked ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
                    )}
                  >
                    <Avatar member={agent} size="xs" />
                    <span>
                      {agent.nickname} @{agent.tag}
                    </span>
                  </button>
                );
              })}
              {!agents.length && <p className="text-xs text-muted-foreground">房间里还没有 AI 成员</p>}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rounds">轮数（1-6）</Label>
            <Input
              id="rounds"
              type="number"
              min={1}
              max={6}
              value={rounds}
              onChange={(e) => setRounds(e.target.value)}
              className="w-24"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !topic.trim() || !agents.length}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            开始讨论
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
