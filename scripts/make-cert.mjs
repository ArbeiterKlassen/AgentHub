#!/usr/bin/env node
/**
 * 生成自签 HTTPS 证书（给内网 / 手机访问用）。
 *
 *   node scripts/make-cert.mjs                 # 生成 data/tls/cert.pem + key.pem（含本机所有局域网 IP）
 *   node scripts/make-cert.mjs --days 3650     # 自定义有效期
 *   node scripts/make-cert.mjs --dns a.com,b.com   # 额外把域名写进 SAN（内网穿透的域名填这里）
 *   node scripts/make-cert.mjs --force         # 已存在也重新生成
 *
 * 证书带 subjectAltName（localhost / 127.0.0.1 / 每个局域网 IP），所以用 IP 直接访问也不会报「域名不匹配」。
 * 手机第一次打开会提示「不安全」——点继续即可；想让警告消失，把 data/tls/cert.pem 装到手机
 * 的「受信任凭据 / 描述文件」里（它是自签根证书，basicConstraints=CA:TRUE）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.AH_DATA_DIR ?? path.join(REPO, 'data');
const TLS_DIR = path.join(DATA_DIR, 'tls');
const CERT = path.join(TLS_DIR, 'cert.pem');
const KEY = path.join(TLS_DIR, 'key.pem');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const DAYS = Number(flag('days', 1095));
const FORCE = Boolean(flag('force', false));
const EXTRA_DNS = String(flag('dns', process.env.AH_TLS_DNS ?? ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function findOpenssl() {
  const candidates = [
    process.env.OPENSSL,
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
    'openssl',
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['version'], { stdio: 'pipe', windowsHide: true });
      return bin;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) out.push(net.address);
    }
  }
  return out;
}

if (!FORCE && fs.existsSync(CERT) && fs.existsSync(KEY)) {
  console.log(`证书已存在（想重造就加 --force）：\n  ${CERT}\n  ${KEY}`);
  process.exit(0);
}

const openssl = findOpenssl();
if (!openssl) {
  console.error('找不到 openssl。装 Git for Windows 即可（自带 openssl），或设置 OPENSSL 环境变量指向 openssl.exe。');
  process.exit(1);
}

fs.mkdirSync(TLS_DIR, { recursive: true });
const dnsNames = [...new Set(['localhost', ...EXTRA_DNS])];
const sans = [...dnsNames.map((d) => `DNS:${d}`), 'IP:127.0.0.1', ...lanIps().map((ip) => `IP:${ip}`)].join(',');
console.log(`使用 ${openssl}\nSAN: ${sans}`);

const res = spawnSync(
  openssl,
  [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-days', String(DAYS),
    '-keyout', KEY,
    '-out', CERT,
    '-subj', '/CN=AgentHub',
    '-addext', `subjectAltName=${sans}`,
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
  ],
  { stdio: 'pipe', windowsHide: true },
);

if (res.status !== 0) {
  console.error('生成失败：');
  console.error(String(res.stderr ?? ''));
  process.exit(1);
}

console.log(`已生成（有效期 ${DAYS} 天）：\n  ${CERT}\n  ${KEY}`);
console.log('\n用法：把这两个路径设成环境变量后启动服务，或直接用 start-agenthub.bat --https');
console.log(`  AH_TLS_CERT=${CERT}`);
console.log(`  AH_TLS_KEY=${KEY}`);
