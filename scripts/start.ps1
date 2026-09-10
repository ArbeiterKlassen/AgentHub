#!/usr/bin/env pwsh
<#
  一键启动 AgentHub：后端（tsx 直跑 TypeScript）+ 前端（Vite 开发服务器）

  用法：
    pwsh scripts/start.ps1              # 后端 8787 + 前端 5173
    pwsh scripts/start.ps1 -Prod        # 只跑后端（需要先 npm run build，单端口访问 8787）
    pwsh scripts/start.ps1 -Port 9000 -WebPort 5174
#>
param(
  [int]$Port = 8787,
  [int]$WebPort = 5173,
  [switch]$Prod
)

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Test-Path (Join-Path $root 'server\node_modules'))) {
  Write-Host '正在安装后端依赖…' -ForegroundColor Cyan
  npm --prefix (Join-Path $root 'server') install
}
if (-not $Prod -and -not (Test-Path (Join-Path $root 'web\node_modules'))) {
  Write-Host '正在安装前端依赖…' -ForegroundColor Cyan
  npm --prefix (Join-Path $root 'web') install
}

$env:AH_PORT = "$Port"

if ($Prod) {
  Write-Host '构建前端…' -ForegroundColor Cyan
  npm --prefix (Join-Path $root 'web') run build
  Write-Host '构建后端…' -ForegroundColor Cyan
  npm --prefix (Join-Path $root 'server') run build
  Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' `
    -WorkingDirectory (Join-Path $root 'server') -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'server.out.log') `
    -RedirectStandardError (Join-Path $logDir 'server.err.log')
  Start-Sleep -Seconds 3
  Write-Host "AgentHub 已启动：http://127.0.0.1:$Port （前端与后端同端口）" -ForegroundColor Green
  exit 0
}

Start-Process -FilePath 'cmd.exe' `
  -ArgumentList '/c', "npx tsx src/index.ts > `"$logDir\server.out.log`" 2> `"$logDir\server.err.log`"" `
  -WorkingDirectory (Join-Path $root 'server') -WindowStyle Hidden
Start-Process -FilePath 'cmd.exe' `
  -ArgumentList '/c', "npx vite --port $WebPort --strictPort > `"$logDir\web.out.log`" 2> `"$logDir\web.err.log`"" `
  -WorkingDirectory (Join-Path $root 'web') -WindowStyle Hidden

Start-Sleep -Seconds 6
Write-Host ''
Write-Host '  AgentHub 已启动' -ForegroundColor Green
Write-Host "  ├─ 网页界面   http://localhost:$WebPort"
Write-Host "  ├─ 后端 API   http://127.0.0.1:$Port"
Write-Host "  └─ 日志目录   $logDir"
Write-Host ''
Write-Host '  首次使用：打开网页注册一个身份，然后在「AI 成员」页新增 AI 成员。' -ForegroundColor DarkGray
Write-Host '  命令行自检：node scripts/e2e-test.mjs' -ForegroundColor DarkGray
