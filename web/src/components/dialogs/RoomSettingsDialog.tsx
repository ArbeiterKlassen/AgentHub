import { useEffect, useState } from 'react';
import { Loader2, Save, Trash2 } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { useChatStore } from '@/stores/chat';
import { useSessionStore } from '@/stores/session';
import { useI18n } from '@/lib/i18n';
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
  const { t } = useI18n();
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
      pushToast(t('dialog.roomSettings.saved'), 'success');
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
      pushToast(t('dialog.roomSettings.dissolved', { name: res.name, hint: res.hint }), 'success');
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
      <button type="button" className="absolute inset-0" aria-label={t('common.close')} onClick={() => onOpenChange(false)} />
      <div className="thin-scrollbar relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border bg-background p-4 shadow-xl">
        <h3 className="text-base font-semibold">{t('dialog.roomSettings.title')}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('dialog.roomSettings.subtitle')}</p>

        <div className="mt-3 space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">{t('dialog.roomSettings.name')}</Label>
            <Input className="h-8" value={form.name} onChange={(e) => setField('name', e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('dialog.roomSettings.topic')}</Label>
            <Input
              className="h-8"
              value={form.topic}
              placeholder={t('dialog.roomSettings.topicPlaceholder')}
              onChange={(e) => setField('topic', e.target.value)}
            />
          </div>
          {/* Radix Select 不接受空字符串作为 value，所以用 __none__ 代表「未分组」 */}
          <div className="space-y-1">
            <Label className="text-xs">{t('dialog.roomSettings.group')}</Label>
            <Select
              value={form.groupId ?? '__none__'}
              onValueChange={(value) => setField('groupId', value === '__none__' ? null : value)}
            >
              <SelectTrigger className="h-8">
                <SelectValue placeholder={t('rooms.ungrouped')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t('rooms.ungrouped')}</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t('dialog.roomSettings.groupHint')}</p>
          </div>

          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="text-xs font-medium">{t('dialog.roomSettings.contextSection')}</div>
            <div className="mt-2 space-y-3">
              {row(t('dialog.roomSettings.contextLines'), 'contextLines', t('dialog.roomSettings.contextLinesHint'), {
                min: 1,
                max: 200,
              })}
              {row(
                t('dialog.roomSettings.contextChars'),
                'contextMaxChars',
                t('dialog.roomSettings.contextCharsHint'),
                { min: 500, max: 200000, step: 500 },
              )}
              {row(t('dialog.roomSettings.historyMessages'), 'historyMessages', t('dialog.roomSettings.historyMessagesHint'), {
                min: 1,
                max: 200,
              })}
            </div>
          </div>

          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="text-xs font-medium">{t('dialog.roomSettings.relaySection')}</div>
            <div className="mt-2 grid grid-cols-2 gap-3">
              {row(t('dialog.roomSettings.maxHops'), 'maxHops', t('dialog.roomSettings.maxHopsHint'), { min: 1, max: 50 })}
              {row(
                t('dialog.roomSettings.maxTurns'),
                'maxTurnsPerChain',
                t('dialog.roomSettings.maxTurnsHint'),
                { min: 1, max: 100 },
              )}
              {row(t('dialog.roomSettings.progress'), 'progressMinutes', t('dialog.roomSettings.progressHint'), {
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
            {t('dialog.roomSettings.dissolve')}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t('dialog.roomSettings.dissolveHint', { n: room.messageCount })}
          </p>
          {!canDissolve ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {t('dialog.roomSettings.notOwner', { tag: room.createdBy ?? '-' })}
            </p>
          ) : !confirmDissolve ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-2 text-destructive"
              onClick={() => setConfirmDissolve(true)}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              {t('dialog.roomSettings.dissolveButton')}
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
                  {t('dialog.roomSettings.keepFiles')}
                  <br />
                  <span className="text-muted-foreground">{t('dialog.roomSettings.keepFilesHint')}</span>
                </span>
              </label>
              <div className="flex items-center gap-2">
                <Button variant="destructive" size="sm" disabled={dissolving} onClick={() => void dissolve()}>
                  {dissolving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
                  {t('dialog.roomSettings.confirmDissolve', { name: room.name })}
                </Button>
                <Button variant="ghost" size="sm" disabled={dissolving} onClick={() => setConfirmDissolve(false)}>
                  {t('dialog.roomSettings.cancelShort')}
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
