import { useState } from 'react';
import { Download, ExternalLink, ImageOff, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { downloadUrl } from '@/lib/api';
import { formatSize } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { SharedFile } from '@/lib/types';

interface ImageAttachmentProps {
  file: SharedFile;
  server: string;
  token: string;
  /** 缩略图尺寸类，默认消息流的大图 */
  thumbClassName?: string;
  /** 缩略图下方显示文件名与体积 */
  showLabel?: boolean;
  className?: string;
}

/**
 * 聊天/文件区里的图片：内联缩略图，点击开大图预览（可下载或新标签打开）。
 * 图片走 token 鉴权 URL，服务端 inline 返回，不需要额外接口。
 */
export function ImageAttachment({
  file,
  server,
  token,
  thumbClassName = 'max-h-[260px] max-w-[320px]',
  showLabel = true,
  className,
}: ImageAttachmentProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const src = downloadUrl(server, file.id, token, false);
  const saveUrl = downloadUrl(server, file.id, token, true);

  const thumb = (
    <span className="relative flex items-center justify-center">
      {state !== 'ready' && (
        <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          {state === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageOff className="h-4 w-4" />}
        </span>
      )}
      <img
        src={src}
        alt={file.name}
        loading="lazy"
        draggable={false}
        onLoad={() => setState('ready')}
        onError={() => setState('error')}
        className={cn(
          'rounded-lg border bg-muted/40 object-contain transition-opacity',
          thumbClassName,
          state === 'ready' ? 'opacity-100' : 'opacity-0',
        )}
      />
    </span>
  );

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {state === 'error' ? (
        <a
          href={saveUrl}
          download={file.name}
          className="flex items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-xs hover:bg-accent"
        >
          <ImageOff className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="max-w-[180px] truncate font-medium">{file.name}</span>
          <span className="text-muted-foreground">预览失败，点击下载</span>
        </a>
      ) : (
        <button
          type="button"
          title="点击查看大图"
          onClick={() => setOpen(true)}
          className="block max-w-full cursor-zoom-in rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {thumb}
        </button>
      )}

      {showLabel && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="max-w-[200px] truncate">{file.name}</span>
          <span>{formatSize(file.size)}</span>
          <a href={saveUrl} download={file.name} className="hover:text-foreground" title="下载原图">
            <Download className="h-3 w-3" />
          </a>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[94vw] border-0 bg-transparent p-0 shadow-none">
          <DialogTitle className="sr-only">{file.name}</DialogTitle>
          <div className="flex flex-col items-center gap-2">
            <img
              src={src}
              alt={file.name}
              className="max-h-[82vh] max-w-[92vw] rounded-lg object-contain shadow-2xl"
              draggable={false}
            />
            <div className="flex items-center gap-3 rounded-full bg-background/95 px-3 py-1.5 text-xs shadow-lg">
              <span className="max-w-[40vw] truncate font-medium">{file.name}</span>
              <span className="text-muted-foreground">{formatSize(file.size)}</span>
              <a
                href={src}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 hover:text-foreground"
                title="在新标签打开"
              >
                <ExternalLink className="h-3 w-3" />
                打开
              </a>
              <a href={saveUrl} download={file.name} className="flex items-center gap-1 hover:text-foreground" title="下载">
                <Download className="h-3 w-3" />
                下载
              </a>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
