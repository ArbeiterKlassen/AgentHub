import { cn } from '@/lib/utils';
import { isImageAvatar } from '@/lib/avatar';
import type { Member } from '@/lib/types';

interface AvatarProps {
  member?: Pick<Member, 'nickname' | 'avatar' | 'color' | 'kind'> | null;
  tag?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  showPresence?: boolean;
  online?: boolean;
  className?: string;
}

const SIZES = {
  xs: 'h-4 w-4 text-[10px]',
  sm: 'h-7 w-7 text-sm',
  md: 'h-9 w-9 text-base',
  lg: 'h-11 w-11 text-lg',
};

export function Avatar({ member, tag, size = 'md', showPresence, online, className }: AvatarProps) {
  const avatar = member?.avatar ?? '';
  const label = avatar || (member?.nickname ?? tag ?? '?').slice(0, 2);
  const isImage = isImageAvatar(avatar);
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <span
        className={cn(
          'inline-flex items-center justify-center overflow-hidden rounded-full font-medium text-white shadow-sm',
          SIZES[size],
        )}
        style={{ backgroundColor: member?.color ?? '#64748b' }}
        title={`${member?.nickname ?? tag ?? ''}${tag ? ` @${tag}` : ''}`}
      >
        {isImage ? <img src={avatar} alt="" className="h-full w-full object-cover" draggable={false} /> : label}
      </span>
      {showPresence && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background',
            online ? 'bg-emerald-500' : 'bg-muted-foreground/40',
          )}
        />
      )}
    </span>
  );
}
