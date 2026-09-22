import { useEffect, useState } from 'react';
import { Loader2, Save, Trash2 } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { useChatStore } from '@/stores/chat';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { RoomSummary } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: RoomSummary | null;
}

interface FormState {
  name: string;
  topic: string;
  /** 所属分组 id（null = 未分组） */
  groupId: string | null;
  /** 进提示词的历史条数 */
  contextLines: number;
  /** 历史正文字符预算 */
  contextMaxChars: number;
  /** 拉多少条历史消息当素材 */
  historyMessages: number;
  maxHops: number;
  maxTurnsPerChain: number;
  /** 心跳间隔（分钟，0 = 关掉长任务提示） */
  progressMinutes: number;
}

const num = (raw: unknown, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
};

function fromRoom(room: RoomSummary): FormState {
  const meta = room.meta ?? {};
  return {
    name: room.name,
    topic: room.topic ?? '',
    groupId: room.groupId ?? null,
    contextLines: num(meta.contextLines, 24),
    contextMaxChars: num(meta.contextMaxChars, 6000),
    historyMessages: num(meta.historyMessages, 30),
    maxHops: num(meta.maxHops, 6),
    maxTurnsPerChain: num(meta.maxTurnsPerChain, 12),
    progressMinutes: Math.round(num(meta.progressEveryMs, 120000) / 60000),
  };
}

/**
 * 房间设置：主要是「上下文预算」这三个旋钮。
 * 提示词太长容易把 CLI 的上下文顶爆（模型开始忘事 / 报错），太短又会让 AI 不知道前面聊了什么，
 * 所以做成房间级可调——长讨论的群可以放大，闲聊群可以调小省钱。
 */
export function RoomSettingsDialog({ open, onOpenChange, room }: Props) {
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDissolve, setConfirmDissolve] = useState(false);
  const [keepFiles, setKeepFiles] = useState(false);
  const [dissolving, setDissolving] = useState(false);
  const refreshRoom = useChatStore((s) => s.refreshRoom);
  const dissolveRoom = useChatStore((s) => s.dissolveRoom);
  const me = useSessionStore((s) => s.member);
  const groups = useChatStore((s) => s.groups);
  const pushToast = useUiStore((s) => s.pushToast);

  useEffect(() => {
    if (open && room) {
      setForm(fromRoom(room));
      setConfirmDissolve(false);
      setKeepFiles(false);
    }
  }, [open, room]);

  if (!open || !room || !form) return null;

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const save = async () => {
    setSaving(true);
    try {
      await apiClient.patchRoom(room.id, {
        name: form.name.trim() || room.name,
        topic: form.topic,
        groupId: form.groupId,
        meta: {
          contextLines: num(form.contextLines, 24),
          contextMaxChars: num(form.contextMaxChars, 6000),
          historyMessages: num(form.historyMessages, 30),
          maxHops: num(form.maxHops, 6),
          maxTurnsPerChain: num(form.maxTurnsPerChain, 12),
          progressEveryMs: Math.max(0, Math.round(form.progressMinutes)) * 60000,
        },
      });
      await refreshRoom(room.id);
      pushToast('房间设置已保存（下一次 AI 调用就按新预算走）', 'success');
      onOpenChange(false);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  /** 只有群主与管理员能解散（与后端一致：后端还会再校验一次） */
  const canDissolve = Boolean(me && (me.role === 'admin' || room.createdBy === me.tag));

  const dissolve = async () => {
    setDissolving(true);
    try {
      const res = await dissolveRoom(room.id, { keepFiles });
      pushToast(`房间「${res.name}」已解散：${res.hint}`, 'success');
      onOpenChange(false);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setDissolving(false);
    }
  };

  const row = (
    label: string,
    key: keyof FormState,
    hint: string,
    opts: { min?: number; max?: number; step?: number } = {},
  ) => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        className="h-8"
        min={opts.min}
        max={opts.max}
        step={opts.step}
        value={String(form[key])}
        onChange={(e) => setField(key, Number(e.target.value) as FormState[typeof key])}
      />
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <button type="button" className="absolute inset-0" aria-label="关闭" onClick={() => onOpenChange(false)} />
      <div className="thin-scrollbar relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border bg-background p-4 shadow-xl">
        <h3 className="text-base font-semibold">房间设置</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">改的是这个房间里所有 AI 共用的参数。</p>

        <div className="mt-3 space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">群名</Label>
            <Input className="h-8" value={form.name} onChange={(e) => setField('name', e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">群主题</Label>
            <Input
              className="h-8"
              value={form.topic}
              placeholder="一句话说明这个群在做什么"
              onChange={(e) => setField('topic', e.target.value)}
            />
          </div>
          {/* Radix Select 不接受空字符串作为 value，所以用 __none__ 代表「未分组」 */}
          <div className="space-y-1">
            <Label className="text-xs">所属分组</Label>
            <Select
              value={form.groupId ?? '__none__'}
              onValueChange={(value) => setField('groupId', value === '__none__' ? null : value)}
            >
              <SelectTrigger className="h-8">
                <SelectValue placeholder="未分组" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">未分组</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">分组是所有人共享的；要新建分组去侧栏的文件夹图标。</p>
          </div>

          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="text-xs font-medium">上下文预算</div>
            <div className="mt-2 space-y-3">
              {row('进提示词的历史条数', 'contextLines', '默认 24 条。太长会把 CLI 的上下文顶爆，太短 AI 会忘事。', {
                min: 1,
                max: 200,
              })}
              {row(
                '历史正文字符预算',
                'contextMaxChars',
                '默认 6000 字符。超出就从最旧的消息开始丢，并在提示词里说明「更早的 N 条已省略」。',
                { min: 500, max: 200000, step: 500 },
              )}
              {row('拉取历史消息条数', 'historyMessages', '默认 30 条（再按上面的预算截取）。', {
                min: 1,
                max: 200,
              })}
            </div>
          </div>

          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="text-xs font-medium">接力与心跳</div>
            <div className="mt-2 grid grid-cols-2 gap-3">
              {row('最大接力跳数', 'maxHops', '默认 6 跳。', { min: 1, max: 50 })}
              {row('单链发言上限', 'maxTurnsPerChain', '默认 12 条。', { min: 1, max: 100 })}
              {row('长任务心跳间隔（分钟）', 'progressMinutes', '默认 2 分钟；0 = 不发进度提示。', {
                min: 0,
                max: 120,
              })}
            </div>
          </div>
        </div>

        {/* 解散房间：群主可解散自己建的房间，管理员可解散任意房间 */}
        <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
            解散房间
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            群主可以解散自己建的房间，管理员可以解散任意房间。解散会一并清除这个房间的
            <b>成员关系、{room.messageCount} 条聊天记录、AI 运行记录</b>，
            共享文件区在磁盘上的文件默认也会删掉，<b>不可恢复</b>。
          </p>
          {!canDissolve ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              你不是这个房间的创建者（@{room.createdBy ?? '-'}），所以不能解散它。
            </p>
          ) : !confirmDissolve ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-2 text-destructive"
              onClick={() => setConfirmDissolve(true)}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              解散这个房间…
            </Button>
          ) : (
            <div className="mt-2 space-y-2 rounded border border-destructive/40 bg-background p-2">
              <label className="flex items-start gap-2 text-[11px]">
                <input
                  type="checkbox"
                  className="mt-0.5 h-3.5 w-3.5 accent-primary"
                  checked={keepFiles}
                  onChange={(e) => setKeepFiles(e.target.checked)}
                />
                <span>
                  保留磁盘上的共享文件（只删房间与聊天记录）
                  <br />
                  <span className="text-muted-foreground">勾上后文件会留在 data/files/&lt;房间&gt;/ 里，方便你自己留档。</span>
                </span>
              </label>
              <div className="flex items-center gap-2">
                <Button variant="destructive" size="sm" disabled={dissolving} onClick={() => void dissolve()}>
                  {dissolving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
                  确认解散「{room.name}」
                </Button>
                <Button variant="ghost" size="sm" disabled={dissolving} onClick={() => setConfirmDissolve(false)}>
                  算了
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}
