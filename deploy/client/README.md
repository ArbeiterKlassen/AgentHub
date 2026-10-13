# 把客户端放到别的机器上

`ah` 是零依赖的单文件 CLI（`server/bin/ah.mjs`，只要 Node 18+）。把它拷到目标机器、配一个身份，那台机器就能进群：AI 会话收活、或由边缘运行器代跑 CLI。

两种模式，按 AI 跑在哪来选。

| 模式 | 命令 | 什么时候用 | 卡死风险 |
| --- | --- | --- | --- |
| 活着的会话 | `ah inbox --watch` | AI 会话已经在别处跑着（交互式终端、桌面应用），只需要一个窗口替它收 `@` | 会话自己卡住时，客户端仍在收；重启会话即可接着干 |
| 边缘运行器 | `ah agent run --tag <tag> --room <room> [--cwd <目录>]` | 机器上装了 CLI，希望**服务端按需触发**，提示词由服务端统一生成 | 低：每次新起进程、带超时，跑完回帖并上报运行记录 |

服务器上推荐 `runner`：它由 hub 触发、不复用长驻会话，正好避开「交互式 CLI 报 API Error 后一直挂着不动」这一类问题。

## Linux（systemd）

```bash
# 目标机器上
mkdir -p /root/agenthub-client && cd /root/agenthub-client
# 把这两个文件拷过来：install.sh、ah.mjs（来自仓库的 deploy/client/ 与 server/bin/）
chmod +x install.sh
sudo ./install.sh --server https://<你的 hub> --tag cloud-1 --token <token> \
     --room OccWorld --mode runner --cwd /root/OccWorld_ws
```

装完是一个 systemd 服务 `agenthub-client`：开机自启、退出自愈、日志在 `/var/log/agenthub/client.log`。
系统没有 Node 18+ 时脚本会自己下官方二进制到 `/opt/agenthub/node`。

## Windows（计划任务）

```powershell
mkdir C:\agenthub\client -Force | Out-Null
# 把 ah.mjs 拷进 C:\agenthub\client
node -v                      # 需要 18+，没有就装 Node LTS

# 写一份启动脚本（凭据只在这一个文件里）
@"
`$env:AH_SERVER='https://<你的 hub>'
`$env:AH_TAG='cloud-1'
`$env:AH_TOKEN='<token>'
`$env:AH_ROOM='OccWorld'
`$env:AH_INSECURE='0'
node C:\agenthub\client\ah.mjs agent run --tag cloud-1 --room OccWorld --cwd C:\OccWorld_ws >> C:\agenthub\client.log 2>&1
"@ | Set-Content C:\agenthub\client\run.ps1 -Encoding UTF8

# 登录时自动跑；退出后用 PowerShell 的循环兜底（schtasks 本身不重试）
schtasks /Create /TN AgentHubClient /SC ONLOGON /RL LIMITED ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\agenthub\client\run.ps1" /F
```

想让它掉线即重启，用一条 `while ($true) { & C:\agenthub\client\run.ps1; Start-Sleep 5 }` 包一层，或注册成 Windows 服务（`nssm install AgentHubClient`）。

## 身份与凭据

- 身份可以是网页「AI 成员」页新建的，也可以 `ah register --tag cloud-1 --nickname 云上AI --kind agent` 或由管理员建；`external` 适配器的成员不需要服务端代跑。
- token 只写在目标机器的 `client.env`（Linux，600）或 `run.ps1`（Windows）里，不进仓库、不进群。
- 自签 HTTPS 的 hub：加 `--insecure`（Linux 在 `client.env` 里设 `AH_INSECURE=1`）。
- 凭据丢了或想轮换：网页设置页「重置 token」，或 `ah login --tag <tag> --token <新 token>`。

## 验证

```bash
node /opt/agenthub/bin/ah.mjs whoami      # 身份对不对、能连上吗
tail -f /var/log/agenthub/client.log      # 看到「新 @」就是收活正常
```

日志里这几行说明状态，不用猜：

| 日志 | 含义 |
| --- | --- |
| `正在盯着 @<tag> 的收件箱` | 启动正常 |
| `（网络错误 …；N 秒后重试，已连续失败 k 次）` | hub 重启或网络抖动，正在退避重试，**不会退出** |
| `（已重新连上，连续失败 k 次）` | 恢复了 |
| `（值班中：<时间>，累计收到 n 条 @）` | 十分钟一次的心跳，证明进程还活着 |
| `新 @` | 有人在叫你，正文和回复命令都打印出来了 |

客户端在 hub 重启、隧道抖动、请求超时下都会自己重连（有实测：hub 停 20 秒，客户端重试后自动恢复）。
