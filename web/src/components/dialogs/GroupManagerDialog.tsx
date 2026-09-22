import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, FolderPlus, Loader2, Trash2 } from 'lucide-react';
import { useChatStore } from '@/stores/chat';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/**
 * 分组管理：新建 / 改名 / 上移下移 / 删除。
 * 分组是**房间级属性**（所有人看到同一套），所以改名和删除限「分组创建者或管理员」。
 * 删除分组不会删房间——里面的群会回到「未分组」。
 */
export function GroupManagerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const groups = useChatStore((s) => s.groups);
  const rooms = useChatStore((s) => s.rooms);
  const createGroup = useChatStore((s) => s.createGroup);
  const renameGroup = useChatStore((s) => s.renameGroup);
  const deleteGroup = useChatStore((s) => s.deleteGroup);
  const moveGroup = useChatStore((s) => s.moveGroup);
  const me = useSessionStore((s) => s.member);
  const pushToast = useUiStore((s) => s.pushToast);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setDraftNames(Object.fromEntries(groups.map((g) => [g.id, g.name])));
  }, [open, groups]);

  const canManage = (createdBy: string | null) => Boolean(me && (me.role === 'admin' || createdBy === me.tag));
  const roomCount = (groupId: string) => rooms.filter((r) => r.groupId === groupId).length;

  const run = async (key: string, fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(key);
    try {
      await fn();
      if (okMsg) pushToast(okMsg, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>群聊分组</DialogTitle>
          <DialogDescription>
            把群聊分堆（像文件夹），侧栏会按分组折叠显示。分组是所有人共享的；删除分组不会删群，里面的群会回到「未分组」。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Input
            value={name}
            placeholder="新分组名，例如「项目 A」"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) {
                void run('create', () => createGroup(name.trim()), `已创建分组「${name.trim()}」`).then(() => setName(''));
              }
            }}
          />
          <Button
            disabled={!name.trim() || busy === 'create'}
            onClick={() =>
              void run('create', () => createGroup(name.trim()), `已创建分组「${name.trim()}」`).then(() => setName(''))
            }
          >
            {busy === 'create' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="mr-1 h-3.5 w-3.5" />}
            新建
          </Button>
        </div>

        <div className="thin-scrollbar max-h-[50vh] space-y-1.5 overflow-y-auto">
          {!groups.length && (
            <p className="py-4 text-center text-sm text-muted-foreground">还没有分组。上面输入名字就能建一个。</p>
          )}
          {groups.map((group, index) => {
            const manage = canManage(group.createdBy);
            const draft = draftNames[group.id] ?? group.name;
            return (
              <div key={group.id} className="flex items-center gap-1.5 rounded-lg border bg-card p-2">
                <Input
                  className="h-8 flex-1"
                  value={draft}
                  disabled={!manage}
                  onChange={(e) => setDraftNames((prev) => ({ ...prev, [group.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && draft.trim() && draft.trim() !== group.name) {
                      void run(`rename:${group.id}`, () => renameGroup(group.id, draft.trim()), '分组已改名');
                    }
                  }}
                />
                <span className="shrink-0 text-[11px] text-muted-foreground">{roomCount(group.id)} 个群</span>
                {manage ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="上移"
                      disabled={index === 0 || busy === `sort:${group.id}`}
                      onClick={() => {
                        const prev = groups[index - 1];
                        void run(`sort:${group.id}`, async () => {
                          await moveGroup(group.id, prev.sort);
                          await moveGroup(prev.id, group.sort);
                        }, '');
                      }}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="下移"
                      disabled={index === groups.length - 1 || busy === `sort:${group.id}`}
                      onClick={() => {
                        const next = groups[index + 1];
                        void run(`sort:${group.id}`, async () => {
                          await moveGroup(group.id, next.sort);
                          await moveGroup(next.id, group.sort);
                        }, '');
                      }}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      title="删除分组（群不会删，会回到未分组）"
                      disabled={busy === `del:${group.id}`}
                      onClick={() => {
                        const count = roomCount(group.id);
                        if (!window.confirm(`删除分组「${group.name}」？${count ? `里面的 ${count} 个群会回到「未分组」。` : ''}群本身不会被删。`)) return;
                        void run(`del:${group.id}`, () => deleteGroup(group.id), `分组「${group.name}」已删除`);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : (
                  <span className="shrink-0 text-[11px] text-muted-foreground">@{(group.createdBy ?? '').slice(0, 12)} 建的</span>
                )}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
