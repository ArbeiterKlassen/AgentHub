import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import { Button } from '@/components/ui/button';
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
  const refreshRoom = useChatStore((s) => s.refreshRoom);
  const pushToast = useUiStore((s) => s.pushToast);

  useEffect(() => {
    if (open && room) setForm(fromRoom(room));
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
