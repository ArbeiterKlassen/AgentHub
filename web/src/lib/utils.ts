import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function wsUrl(server: string, token: string, rooms: string[]): string {
  const base = server.replace(/^http/, 'ws').replace(/\/+$/, '');
  const params = new URLSearchParams({ token });
  if (rooms.length) params.set('rooms', rooms.join(','));
  return `${base}/ws?${params.toString()}`;
}

export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve) => {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    resolve();
  });
}
