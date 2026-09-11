#!/usr/bin/env node
/**
 * 局域网连通性体检：一条命令告诉你「手机为什么连不上」。
 *
 *   node scripts/check-lan.mjs            # 默认查 8787
 *   node scripts/check-lan.mjs --port 8899
 *
 * 检查项：服务是否在监听、Windows 防火墙有没有放行、网络位置是公用还是专用、
 * 本机有哪些可用的局域网地址，最后直接给出修复命令。
 */
import os from 'node:os';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const PORT = Number(flag('port', process.env.AH_PORT ?? 8787));

const ok = (t) => `\u001b[32m✔\u001b[0m ${t}`;
const bad = (t) => `\u001b[31m✘\u001b[0m ${t}`;
const warn = (t) => `\u001b[33m!\u001b[0m ${t}`;
const dim = (t) => `\u001b[2m${t}\u001b[0m`;

function ps(command) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    }).trim();
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
  }
}

console.log(`\n=== AgentHub 局域网体检（端口 ${PORT}）===\n`);
const problems = [];

/* 1. 监听状态 */
const listen = ps(`(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty LocalAddress)`);
if (!listen || listen.startsWith('ERROR') || !listen.trim()) {
  console.log(bad(`端口 ${PORT} 没有任何进程在监听 —— 服务没起来`));
  problems.push('服务没启动：先双击桌面 AgentHub 图标（或 node scripts/serve-forever.mjs）');
} else if (listen.trim() === '127.0.0.1') {
  console.log(warn(`只监听了回环 127.0.0.1 —— 局域网设备连不进来`));
  problems.push('把监听地址改成 0.0.0.0：设置环境变量 AH_HOST=0.0.0.0 后重启服务');
} else {
  console.log(ok(`服务在监听 ${listen.trim()}:${PORT}（局域网可达的绑定）`));
}

/* 2. 本机 HTTP 自测 */
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(3000) });
  console.log(res.ok ? ok('本机 /api/health 正常') : bad(`本机 /api/health 返回 ${res.status}`));
} catch (err) {
  console.log(bad(`本机 /api/health 请求失败：${err instanceof Error ? err.message : String(err)}`));
  problems.push('服务虽在监听但接口不通，看 logs/server.err.log');
}

/* 3. 防火墙 */
const fw = ps(
  `$r = Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'AgentHub' -or ($_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' -and $_.Action -eq 'Allow') }; ` +
    `$hit = $r | Where-Object { $_.DisplayName -match 'AgentHub' }; ` +
    `if ($hit) { ($hit | Select-Object -First 1 -ExpandProperty DisplayName) } else { 'NONE' }`,
);
if (fw.includes('AgentHub')) {
  console.log(ok(`防火墙已放行：${fw.split('\n')[0].trim()}`));
} else {
  console.log(bad('Windows 防火墙没有 AgentHub 的入站放行规则 —— 手机连接会被静默丢弃'));
  problems.push(
    '以管理员身份运行：pwsh -File scripts\\fix-lan-access.ps1   （会加放行规则并把当前网络改成「专用」）',
  );
}

/* 4. 网络位置 */
const profiles = ps(
  `Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -eq 'Internet' } | ForEach-Object { "$($_.InterfaceAlias)|$($_.NetworkCategory)" }`,
);
if (profiles && !profiles.startsWith('ERROR')) {
  for (const line of profiles.split(/\r?\n/).filter(Boolean)) {
    const [iface, category] = line.split('|');
    if (category === 'Public') {
      console.log(bad(`网络位置：${iface} 是「公用网络」(Public) —— 默认拒绝入站`));
      problems.push('把网络位置改成专用：管理员 PowerShell 里跑 Set-NetConnectionProfile -InterfaceAlias "' + iface + '" -NetworkCategory Private');
    } else {
      console.log(ok(`网络位置：${iface} 是「${category}」`));
    }
  }
}

/* 5. 可用地址 */
console.log('\n本机可用的访问地址：');
const virtualHint = /vmware|virtualbox|hyper-?v|vethernet|tailscale|zerotier|docker|wsl|bluetooth|蓝牙/i;
const urls = [];
for (const [iface, list] of Object.entries(os.networkInterfaces())) {
  for (const net of list ?? []) {
    if (net.family !== 'IPv4' || net.internal) continue;
    if (net.address.startsWith('169.254.')) continue;
    urls.push({ iface, address: net.address, virtual: virtualHint.test(iface) });
  }
}
urls.sort((a, b) => Number(a.virtual) - Number(b.virtual));
for (const u of urls) {
  const label = u.virtual ? dim('（虚拟网卡，手机连不上）') : '\u001b[32m← 手机用这个\u001b[0m';
  console.log(`  http://${u.address}:${PORT}   ${dim(`（${u.iface}）`)} ${label}`);
}
if (!urls.some((u) => !u.virtual)) {
  console.log(bad('  没有找到真实网卡的地址（只有虚拟网卡）—— 确认电脑连上 WiFi / 网线'));
}

/* 6. 结论 */
console.log('');
if (!problems.length) {
  console.log('\u001b[32m一切正常：手机连同一个 WiFi，打开上面标了「手机用这个」的地址即可。\u001b[0m');
  console.log(dim('  手机打不开时再看两点：① 手机是不是连的同一个 WiFi（不是 5G 流量/访客网络）；'));
  console.log(dim('  ② 浏览器是不是把 http 强制升级成了 https（Chrome 的「始终使用安全连接」）—— 那就用 HTTPS 方案：start-agenthub.bat --https'));
} else {
  console.log('\u001b[33m发现 ' + problems.length + ' 个问题：\u001b[0m');
  problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
}
console.log('');
