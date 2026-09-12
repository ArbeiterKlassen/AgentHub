import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { FILES_DIR, UPLOAD_MAX_BYTES } from './env.js';
import {
  deleteFile,
  getFile,
  insertFile,
  listFiles,
  newId,
  now,
  type FileRow,
} from './db.js';
import { HttpError } from './auth.js';
import { broadcast } from './hub.js';

const MIME_GUESS: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.py': 'text/x-python',
  '.ts': 'text/plain',
  '.js': 'text/plain',
  '.log': 'text/plain',
};

export function safeName(raw: string): string {
  const base = path.basename(decodeURIComponent(raw || 'file')).replace(/[\\/:*?"<>|]/g, '_');
  const trimmed = base.replace(/^\.+/, '').slice(0, 120);
  return trimmed || 'file';
}

export function publicFile(row: FileRow, origin = ''): Record<string, unknown> {
  return {
    id: row.id,
    roomId: row.room_id,
    name: row.name,
    size: row.size,
    mime: row.mime,
    uploaderTag: row.uploader_tag,
    sha256: row.sha256,
    createdAt: row.created_at,
    url: `${origin}/api/files/${row.id}`,
    downloadUrl: `${origin}/api/files/${row.id}?download=1`,
  };
}

export function listRoomFiles(roomId: string, origin = ''): Record<string, unknown>[] {
  return listFiles(roomId).map((row) => publicFile(row, origin));
}

/** 原始字节流上传：浏览器直接 PUT File 对象，CLI 直接管道文件，无需 multipart */
export async function handleUpload(req: Request, roomId: string, uploaderTag: string): Promise<FileRow> {
  const headerName = req.headers['x-file-name'];
  const rawName =
    typeof headerName === 'string' && headerName.trim()
      ? headerName.trim()
      : typeof req.query.name === 'string'
        ? req.query.name
        : '';
  if (!rawName) {
    throw new HttpError(400, '缺少文件名：请带上请求头 x-file-name（URL 编码）');
  }
  const name = safeName(rawName);
  const id = newId('f');
  const dir = path.join(FILES_DIR, roomId);
  fs.mkdirSync(dir, { recursive: true });
  const stored = path.join(dir, `${id}__${name}`);
  const hash = crypto.createHash('sha256');
  let size = 0;

  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(stored);
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > UPLOAD_MAX_BYTES) {
        req.destroy();
        out.destroy();
        try {
          fs.rmSync(stored, { force: true });
        } catch {
          /* ignore */
        }
        reject(new HttpError(413, `文件超过上限 ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)}MB`));
        return;
      }
      hash.update(chunk);
    });
    req.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => resolve());
    req.pipe(out);
  });

  if (size === 0) {
    fs.rmSync(stored, { force: true });
    throw new HttpError(400, '上传内容为空');
  }

  const mime =
    (typeof req.headers['content-type'] === 'string' && req.headers['content-type']) ||
    MIME_GUESS[path.extname(name).toLowerCase()] ||
    'application/octet-stream';

  const row: FileRow = {
    id,
    room_id: roomId,
    name,
    size,
    mime,
    uploader_tag: uploaderTag,
    sha256: hash.digest('hex'),
    stored_path: stored,
    created_at: now(),
  };
  insertFile(row);
  broadcast({ type: 'file.add', roomId, data: publicFile(row), ts: Date.now() });
  return row;
}

export function handleDownload(req: Request, res: Response, id: string): void {
  const row = getFile(id);
  if (!row) throw new HttpError(404, '文件不存在');
  if (!fs.existsSync(row.stored_path)) throw new HttpError(410, '文件已从磁盘删除');
  const download = req.query.download === '1' || req.query.download === 'true';
  const stat = fs.statSync(row.stored_path);
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader(
    'Content-Disposition',
    `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
  );
  fs.createReadStream(row.stored_path).pipe(res);
}

/**
 * 解散房间时把共享文件从磁盘上真正删掉。
 * 只删数据库行的话，`data/files/<房间>/` 会一直躺在磁盘上（README 以前就写着"要手工清理"）。
 * 做法是：先按数据库记录逐个删文件，再整个删掉这个房间的目录（兜住"行已删但文件还在"的残留）；
 * 两条路径都做越界校验，确保只在 data/files 里面动手。
 */
export function purgeRoomFiles(roomId: string): {
  files: number;
  bytes: number;
  dir: string;
  dirRemoved: boolean;
} {
  const root = path.resolve(FILES_DIR) + path.sep;
  const inside = (target: string): boolean => path.resolve(target).startsWith(root);
  let files = 0;
  let bytes = 0;

  for (const row of listFiles(roomId)) {
    try {
      if (!fs.existsSync(row.stored_path)) continue;
      if (!inside(row.stored_path)) {
        console.warn(`[files] 跳过越界路径（不属于数据目录）：${row.stored_path}`);
        continue;
      }
      bytes += fs.statSync(row.stored_path).size;
      fs.rmSync(row.stored_path, { force: true });
      files += 1;
    } catch (err) {
      console.warn(`[files] 删文件失败（继续删房）：${row.stored_path}`, err);
    }
  }

  const dir = path.join(FILES_DIR, roomId);
  let dirRemoved = false;
  try {
    if (inside(path.join(dir, 'x')) && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      dirRemoved = true;
    }
  } catch (err) {
    console.warn(`[files] 删房间目录失败：${dir}`, err);
  }

  return { files, bytes, dir, dirRemoved };
}

export function removeFile(id: string): FileRow {
  const row = getFile(id);
  if (!row) throw new HttpError(404, '文件不存在');
  fs.rmSync(row.stored_path, { force: true });
  deleteFile(id);
  broadcast({ type: 'file.remove', roomId: row.room_id, data: { id }, ts: Date.now() });
  return row;
}

export function readFileAsText(id: string, maxBytes = 200_000): string {
  const row = getFile(id);
  if (!row) throw new HttpError(404, '文件不存在');
  const stat = fs.statSync(row.stored_path);
  if (stat.size > maxBytes) throw new HttpError(413, '文件过大，无法直接作为文本读取');
  return fs.readFileSync(row.stored_path, 'utf8');
}
