/** 头像工具：预设 emoji + 本地图片居中裁剪压缩为 100×100 的 data URL。 */
import { t } from '@/lib/i18n';

export const AVATAR_SIZE = 100;

export const AVATAR_PRESETS = [
  '🙂', '😄', '😎', '🤓', '🧐', '🤠', '🥳', '😺',
  '🦊', '🐼', '🐳', '🦉', '🐙', '🦄', '🐧', '🐝',
  '🦅', '🐢', '🐺', '🦁', '🐨', '🐯', '🐸', '🐹',
  '🐬', '🦈', '🦖', '🐲', '🦔', '🐿️', '🦩', '🦭',
  '🤖', '🦾', '🧠', '👾', '🛰️', '🚀', '⚡', '🔭',
  '🎯', '🧩', '🛠️', '📚', '📡', '🧪', '💡', '🌿',
];

const IMAGE_DATA_URL = /^data:image\//i;

export function isImageAvatar(avatar: string | null | undefined): boolean {
  return typeof avatar === 'string' && IMAGE_DATA_URL.test(avatar);
}

/** 居中裁剪的正方形窗口（导出以便单测：横图裁左右、竖图裁上下、方图不裁）。 */
export function squareCrop(width: number, height: number): { side: number; sx: number; sy: number } {
  const side = Math.min(width, height);
  return { side, sx: (width - side) / 2, sy: (height - side) / 2 };
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(t('avatar.err.decodeFailed')));
    };
    img.src = url;
  });
}

/** 居中裁剪为正方形并缩放压缩，优先 WebP，退化时用 PNG。 */
export async function compressAvatarToDataUrl(file: File, size = AVATAR_SIZE): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error(t('avatar.err.notImage'));
  if (file.size > 10 * 1024 * 1024) throw new Error(t('avatar.err.tooLarge'));

  const img = await loadImage(file);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) throw new Error(t('avatar.err.badSize'));

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(t('avatar.err.noCanvas'));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const { side, sx, sy } = squareCrop(width, height);
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);

  const webp = canvas.toDataURL('image/webp', 0.9);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}
