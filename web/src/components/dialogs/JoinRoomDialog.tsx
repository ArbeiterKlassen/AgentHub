import { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import { Button } from '@/components/ui/button';
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
import { log } from '@/lib/logger';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 用邀请码加入群聊：新注册用户没有房间时，这里是他进群的入口 */
export function JoinRoomDialog({ open, onOpenChange }: Props) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const joinRoomByCode = useChatStore((s) => s.joinRoomByCode);
  const pushToast = useUiStore((s) => s.pushToast);

  const submit = async () => {
    const value = code.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const { room, alreadyMember } = await joinRoomByCode(value);
      log.action('用邀请码加入群聊', room.name);
      pushToast(
        alreadyMember ? `你已经在「${room.name}」里了，已为你打开` : `已加入「${room.name}」`,
        'success',
      );
      onOpenChange(false);
      setCode('');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushToast(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setError(null);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>用邀请码加入群聊</DialogTitle>
          <DialogDescription>
            群成员可以在右侧「成员 / 文件 / AI」面板顶部看到本群的邀请码，复制发给你即可。
            大小写、空格、短横线都不影响。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="join-code">邀请码</Label>
          <Input
            id="join-code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            placeholder="例如 K7M3P9"
            className="text-center font-mono text-lg tracking-[0.3em]"
            autoFocus
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !code.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            加入群聊
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
