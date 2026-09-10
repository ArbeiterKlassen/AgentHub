import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  countMembers,
  findMember,
  findMemberByToken,
  insertMember,
  newId,
  now,
  sha256,
  touchMember,
  type MemberRow,
} from './db.js';

const AVATARS = [
  '🙂', '😄', '😎', '🤓', '🧐', '🤠', '🥳', '😺',
  '🦊', '🐼', '🐳', '🦉', '🐙', '🦄', '🐧', '🐝',
  '🦅', '🐢', '🐺', '🦁', '🐨', '🐯', '🐸', '🐹',
  '🐬', '🦈', '🦖', '🐲', '🦔', '🐿️', '🦩', '🦭',
  '🤖', '🦾', '🧠', '👾', '🛰️', '🚀', '⚡', '🔭',
  '🎯', '🧩', '🛠️', '📚', '📡', '🧪', '💡', '🌿',
];
const COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#10b981', '#06b6d4', '#eab308', '#ef4444'];

export const TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function normalizeTag(raw: string): string {
  return String(raw ?? '').trim().toLowerCase();
}

export function assertTag(tag: string): string {
  const t = normalizeTag(tag);
  if (!TAG_PATTERN.test(t)) {
    throw new HttpError(
      400,
      'tag 只能用小写字母、数字、- 或 _，长度 2-32，且必须以字母或数字开头',
    );
  }
  return t;
}

function pickFrom(list: string[], seed: string): string {
  const hex = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 8);
  return list[parseInt(hex, 16) % list.length];
}

export function createToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export interface RegisterInput {
  tag: string;
  nickname?: string;
  kind?: 'human' | 'agent';
  agentKind?: string;
  adapterId?: string;
  avatar?: string;
  color?: string;
  workdir?: string;
  systemPrompt?: string;
  triggerMode?: 'mentions' | 'all' | 'manual';
  token?: string;
}

export function registerMember(input: RegisterInput): { member: MemberRow; token: string } {
  const tag = assertTag(input.tag);
  if (findMember(tag)) {
    throw new HttpError(409, `tag「${tag}」已被占用`);
  }
  const kind = input.kind === 'agent' ? 'agent' : 'human';
  const token = input.token && input.token.length >= 8 ? input.token : createToken();
  const nickname = (input.nickname ?? tag).trim().slice(0, 32) || tag;
  const row: MemberRow = {
    tag,
    nickname,
    kind,
    agent_kind: kind === 'agent' ? (input.agentKind ?? input.adapterId ?? 'custom') : null,
    adapter_id: kind === 'agent' ? (input.adapterId ?? 'mock') : null,
    avatar: input.avatar || pickFrom(AVATARS, tag),
    color: input.color || pickFrom(COLORS, `${tag}-color`),
    token_hash: sha256(token),
    token_secret: token,
    role: countMembers() === 0 ? 'admin' : 'member',
    trigger_mode: input.triggerMode ?? (kind === 'agent' ? 'mentions' : 'all'),
    workdir: input.workdir ?? null,
    system_prompt: input.systemPrompt ?? null,
    meta: '{}',
    created_at: now(),
    last_seen_at: null,
  };
  insertMember(row);
  return { member: row, token };
}

export function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const alt = req.headers['x-auth-token'];
  if (typeof alt === 'string' && alt.trim()) return alt.trim();
  const q = req.query.token;
  if (typeof q === 'string' && q.trim()) return q.trim();
  return null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      member?: MemberRow;
    }
  }
}

export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (token) {
    const member = findMemberByToken(token);
    if (member) {
      req.member = member;
      touchMember(member.tag);
    }
  }
  next();
}

export function requireAuth(req: Request): MemberRow {
  if (!req.member) {
    throw new HttpError(401, '未登录：请在请求头带上 Authorization: Bearer <token>');
  }
  return req.member;
}

export function requireAdmin(req: Request): MemberRow {
  const member = requireAuth(req);
  if (member.role !== 'admin') {
    throw new HttpError(403, '只有管理员可以执行该操作');
  }
  return member;
}

export function publicMember(member: MemberRow): Record<string, unknown> {
  return {
    tag: member.tag,
    nickname: member.nickname,
    kind: member.kind,
    agentKind: member.agent_kind,
    adapterId: member.adapter_id,
    avatar: member.avatar,
    color: member.color,
    role: member.role,
    triggerMode: member.trigger_mode,
    workdir: member.workdir,
    systemPrompt: member.system_prompt,
    createdAt: member.created_at,
    lastSeenAt: member.last_seen_at,
  };
}

export function newRunId(): string {
  return newId('run');
}
