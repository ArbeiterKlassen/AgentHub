#Requires -RunAsAdministrator
<#
  让手机 / 别的设备能连上 AgentHub（需要管理员权限）。

  用法（右键「以管理员身份运行 PowerShell」后执行，或在开始菜单搜 PowerShell → 右键以管理员身份运行）：
    pwsh -File D:\multi-modal-ai\agenthub\scripts\fix-lan-access.ps1
    pwsh -File ...\fix-lan-access.ps1 -Port 8787
    pwsh -File ...\fix-lan-access.ps1 -KeepPublic      # 只加防火墙规则，不改网络位置
    pwsh -File ...\fix-lan-access.ps1 -Remove          # 撤销（删规则，不改回网络位置）

  做了两件事：
  1. 给这个端口加一条入站放行规则（TCP，任何网络类型都放行）。
  2. 把当前「公用网络」的连接位置改成「专用网络」——Windows 对公用网络默认拒绝入站，
     这一步不改的话，即使加了规则手机也连不上。

  ⚠️ 安全提醒：放行后，同一个局域网里的其他设备都能访问这个端口（访问仍需要登录 token）。
     在咖啡厅 / 酒店这类不可信 WiFi 下建议先 -Remove 撤掉，或者只在自己家里用。
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$KeepPublic,
  [switch]$Remove
)

$ErrorActionPreference = 'Continue'
$ruleName = "AgentHub (TCP $Port)"

if ($Remove) {
  $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if ($existing) {
    Remove-NetFirewallRule -DisplayName $ruleName
    Write-Host "[已撤销] 删除了防火墙规则「$ruleName」" -ForegroundColor Yellow
  } else {
    Write-Host "[跳过] 没有找到规则「$ruleName」" -ForegroundColor DarkGray
  }
  exit 0
}

Write-Host ""
Write-Host "AgentHub 局域网放行" -ForegroundColor Cyan
Write-Host "  端口：$Port"
Write-Host ""

# 1. 入站规则（先删同名旧规则，避免重复）
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule `
  -DisplayName $ruleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $Port `
  -Profile Any `
  -Description 'AgentHub 人机群聊服务：允许手机/局域网设备访问' | Out-Null
Write-Host "  ✔ 已添加防火墙入站规则（TCP $Port，任何网络类型）" -ForegroundColor Green

# 2. 网络位置改成专用
if (-not $KeepPublic) {
  $publics = Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' -and $_.IPv4Connectivity -eq 'Internet' }
  if ($publics) {
    foreach ($p in $publics) {
      try {
        Set-NetConnectionProfile -InterfaceAlias $p.InterfaceAlias -NetworkCategory Private -ErrorAction Stop
        Write-Host "  ✔ 网络位置：$($p.InterfaceAlias) 已从「公用」改为「专用」" -ForegroundColor Green
      } catch {
        Write-Host "  ✗ 改「$($p.InterfaceAlias)」网络位置失败：$($_.Exception.Message)" -ForegroundColor Red
      }
    }
  } else {
    Write-Host "  · 没有处于「公用」的有网连接，跳过网络位置修改" -ForegroundColor DarkGray
  }
} else {
  Write-Host "  · 按 -KeepPublic 要求，未修改网络位置" -ForegroundColor DarkGray
}

# 3. 打印可用地址
$urls = @()
foreach ($list in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
  if ($list.OperationalStatus -ne 'Up') { continue }
  foreach ($addr in $list.GetIPProperties().UnicastAddresses) {
    $ip = $addr.Address.IPAddressToString
    if ($addr.Address.AddressFamily -ne 'InterNetwork') { continue }
    if ($ip -like '169.254.*' -or $ip -eq '127.0.0.1') { continue }
    $urls += [pscustomobject]@{ IP = $ip; IF = $list.Name }
  }
}

Write-Host ""
Write-Host "手机浏览器打开（同一个 WiFi）：" -ForegroundColor Cyan
if ($urls.Count -eq 0) {
  Write-Host "  没找到局域网地址，确认电脑已连上 WiFi / 网线" -ForegroundColor Yellow
} else {
  foreach ($u in $urls) {
    $hint = if ($u.IF -match 'VMware|VirtualBox|Hyper-V|vEthernet|WSL') { '  ← 虚拟网卡，手机连不上，别用这个' } else { '' }
    Write-Host ("  http://{0}:{1}   （{2}）{3}" -f $u.IP, $Port, $u.IF, $hint) -ForegroundColor Green
  }
}
Write-Host ""
Write-Host "撤销放行：pwsh -File `"$PSCommandPath`" -Remove" -ForegroundColor DarkGray
Write-Host ""
