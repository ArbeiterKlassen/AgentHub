import { useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AVATAR_PRESETS, AVATAR_SIZE, compressAvatarToDataUrl, isImageAvatar } from '@/lib/avatar';
import { cn } from '@/lib/utils';

interface AvatarPickerProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function AvatarPicker({ value, onChange, className }: AvatarPickerProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickFile = async (file: File | null | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await compressAvatarToDataUrl(file, AVATAR_SIZE));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-muted text-lg">
          {isImageAvatar(value) ? (
            <img src={value} alt="头像预览" className="h-full w-full object-cover" />
          ) : (
            value || '🙂'
          )}
        </span>
        <div className="space-y-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-1 h-3.5 w-3.5" />
            )}
            {busy ? '处理中…' : '上传本地头像'}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            自动居中裁剪并压缩为 {AVATAR_SIZE}×{AVATAR_SIZE} 像素
          </p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
          hidden
          onChange={(e) => void pickFile(e.target.files?.[0])}
        />
      </div>
      <div className="grid grid-cols-10 gap-1">
        {AVATAR_PRESETS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            title={`使用 ${emoji}`}
            onClick={() => onChange(emoji)}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full border text-base transition-colors',
              value === emoji ? 'border-primary bg-accent' : 'hover:bg-accent/60',
            )}
          >
            {emoji}
          </button>
        ))}
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
