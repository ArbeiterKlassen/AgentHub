import type { SharedFile } from './types';

/** 可直接内联预览的图片扩展名（svg 除外：避免任何脚本化风险，仍按普通文件下载） */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

/**
 * 是否按图片预览。mime 优先，扩展名兜底：
 * 浏览器上传时常给出空 mime 或 application/octet-stream。
 */
export function isImageFile(file: Pick<SharedFile, 'name' | 'mime'>): boolean {
  if (file.mime && /^image\//i.test(file.mime)) return !/svg/i.test(file.mime);
  return IMAGE_EXT.test(file.name ?? '');
}
