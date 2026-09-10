import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { useUiStore } from '@/stores/ui';
import { cn } from '@/lib/utils';

export function Toasts() {
  const { toasts, dismissToast } = useUiStore();
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            'pointer-events-auto flex animate-page-in items-start gap-2 rounded-lg border bg-card p-3 text-sm shadow-lg',
            toast.kind === 'error' && 'border-destructive/40',
            toast.kind === 'success' && 'border-emerald-500/40',
          )}
        >
          {toast.kind === 'error' ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          ) : toast.kind === 'success' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          ) : (
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="flex-1 break-words">{toast.text}</span>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => dismissToast(toast.id)}
            aria-label="关闭提示"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
