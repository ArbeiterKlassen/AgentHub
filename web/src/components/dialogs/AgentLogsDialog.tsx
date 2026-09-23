import { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { formatDateTime, formatDuration } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { RunRecord } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentTag: string | null;
}

export function AgentLogsDialog({ open, onOpenChange, agentTag }: Props) {
  const { t } = useI18n();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    if (!agentTag) return;
    setLoading(true);
    try {
      const res = await apiClient.runs(agentTag, 30);
      setRuns(res.runs);
    } catch {
      setRuns([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agentTag]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('dialog.logs.title', { tag: agentTag ?? '' })}</DialogTitle>
          <DialogDescription>{t('dialog.logs.subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {t('common.refresh')}
          </Button>
          <span className="text-xs text-muted-foreground">{t('dialog.logs.count', { n: runs.length })}</span>
        </div>

        <div className="thin-scrollbar max-h-[60vh] space-y-2 overflow-y-auto">
          {!runs.length && !loading && (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('dialog.logs.empty')}</p>
          )}
          {runs.map((run) => (
            <div key={run.id} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    run.status === 'ok' ? 'secondary' : run.status === 'error' ? 'destructive' : 'outline'
                  }
                  className={cn(run.status === 'ok' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400')}
                >
                  {run.status}
                </Badge>
                <span className="text-xs text-muted-foreground">{formatDateTime(run.createdAt)}</span>
                <span className="text-xs text-muted-foreground">
                  {t('dialog.logs.adapter', { id: run.adapterId ?? '-' })}
                </span>
                {run.durationMs ? (
                  <span className="text-xs text-muted-foreground">
                    {t('dialog.logs.duration', { d: formatDuration(run.durationMs) })}
                  </span>
                ) : null}
                {run.tokensTotal ? (
                  <span className="text-xs text-muted-foreground" title={t('dialog.logs.tokensTitle')}>
                    {run.tokensTotal.toLocaleString()} tokens
                    {run.costUsd ? ` · $${run.costUsd.toFixed(4)}` : ''}
                  </span>
                ) : null}
                {run.triggerMsg ? (
                  <span className="text-xs text-muted-foreground">{t('dialog.logs.trigger', { n: run.triggerMsg })}</span>
                ) : (
                  <span className="text-xs text-muted-foreground">{t('dialog.logs.spontaneous')}</span>
                )}
                {run.hop ? (
                  <span className="text-xs text-muted-foreground">{t('dialog.logs.hop', { n: run.hop })}</span>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-6 text-xs"
                  onClick={() => setExpanded(expanded === run.id ? null : run.id)}
                >
                  {expanded === run.id ? t('dialog.logs.collapse') : t('dialog.logs.expand')}
                </Button>
              </div>
              {run.error && <p className="mt-2 text-xs text-destructive">{run.error}</p>}
              {expanded === run.id && (
                <div className="mt-2 space-y-2">
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">{t('dialog.logs.prompt')}</p>
                    <pre className="thin-scrollbar max-h-56 overflow-auto rounded border bg-muted/50 p-2 text-[11px] leading-relaxed">
                      {run.prompt || t('dialog.logs.notRecorded')}
                    </pre>
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">{t('dialog.logs.output')}</p>
                    <pre className="thin-scrollbar max-h-40 overflow-auto rounded border bg-muted/50 p-2 text-[11px]">
                      {run.output || t('dialog.logs.notRecorded')}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
