#!/usr/bin/env bash
# AgentHub 客户端一键安装（Linux + systemd）
#
#   sudo ./install.sh --server https://hub.example.com \
#        --tag cloud-1 --token <token> --room OccWorld [--mode watch|runner]
#
# 两种模式：
#   watch   活着的会话：盯着「谁 @ 了我」，把消息打印到日志，由会话自己回帖
#   runner  边缘运行器：被 @ 时向服务端要提示词，本地跑 CLI，自动回帖并上报运行记录
#           （推荐跑在服务器上：每次都新起进程 + 带超时，不会像交互式会话那样卡死）
#
# 装完是一个 systemd 服务：agenthub-client，开机自启、退出自动重启、日志进 /var/log/agenthub。
set -euo pipefail

APP_DIR=/opt/agenthub
CONF_DIR=/etc/agenthub
LOG_DIR=/var/log/agenthub
UNIT=/etc/systemd/system/agenthub-client.service
NODE_MIN_MAJOR=18

SERVER=""; TAG=""; TOKEN=""; ROOM=""; MODE=watch; INTERVAL=10; CWD=""; NODE_BIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2;;
    --tag) TAG="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --room) ROOM="$2"; shift 2;;
    --mode) MODE="$2"; shift 2;;
    --interval) INTERVAL="$2"; shift 2;;
    --cwd) CWD="$2"; shift 2;;
    --node) NODE_BIN="$2"; shift 2;;
    -h|--help) sed -n '2,14p' "$0"; exit 0;;
    *) echo "未知参数：$1" >&2; exit 2;;
  esac
done

[ "$(id -u)" = "0" ] || { echo "需要 root（用 sudo 跑）" >&2; exit 1; }
[ -n "$SERVER" ] && [ -n "$TAG" ] && [ -n "$TOKEN" ] || { echo "缺少 --server / --tag / --token" >&2; exit 2; }
[ "$MODE" = "watch" ] || [ "$MODE" = "runner" ] || { echo "--mode 只能是 watch 或 runner" >&2; exit 2; }
[ "$MODE" = "runner" ] && [ -z "$ROOM" ] && { echo "runner 模式需要 --room" >&2; exit 2; }

AH_SRC="$(cd "$(dirname "$0")" && pwd)/ah.mjs"
[ -f "$AH_SRC" ] || { echo "找不到 $AH_SRC（把它和本脚本放同一个目录）" >&2; exit 1; }

# ---------- Node：优先用系统自带的，不够新就自己下一份到 /opt/agenthub/node ----------
node_ok() { "$1" -e "process.exit(Number(process.versions.node.split('.')[0]) >= $NODE_MIN_MAJOR ? 0 : 1)" >/dev/null 2>&1; }

if [ -n "$NODE_BIN" ]; then
  node_ok "$NODE_BIN" || { echo "$NODE_BIN 版本过低（需要 Node $NODE_MIN_MAJOR+）" >&2; exit 1; }
elif command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
else
  echo "系统没有合适的 Node（需要 $NODE_MIN_MAJOR+），正在下载官方二进制到 $APP_DIR/node …"
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64;;
    aarch64|arm64) ARCH=arm64;;
    *) echo "未知架构 $(uname -m)，请手动装 Node 后用 --node 指定" >&2; exit 1;;
  esac
  mkdir -p "$APP_DIR"
  TARBALL="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -o "node-v22\.[0-9.]*-linux-$ARCH\.tar\.xz" | head -1)"
  [ -n "$TARBALL" ] || { echo "下载失败：拿不到 Node 下载链接，请手动安装" >&2; exit 1; }
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$TARBALL" -o "/tmp/$TARBALL"
  tar -xJf "/tmp/$TARBALL" -C "$APP_DIR"
  rm -rf "$APP_DIR/node"
  mv "$APP_DIR/${TARBALL%.tar.xz}" "$APP_DIR/node"
  rm -f "/tmp/$TARBALL"
  NODE_BIN="$APP_DIR/node/bin/node"
fi
echo "使用 Node：$("$NODE_BIN" -v)（$NODE_BIN）"

# ---------- 落地文件 ----------
mkdir -p "$APP_DIR/bin" "$CONF_DIR" "$LOG_DIR"
install -m 0644 "$AH_SRC" "$APP_DIR/bin/ah.mjs"

# 凭据只落在这一个文件里，权限 600（root 可读）。要改成不落盘：把下面几行注释掉，
# 改用 systemd 的 EnvironmentFile 指向别处，或手工 export 后前台运行。
umask 077
cat > "$CONF_DIR/client.env" <<EOF
AH_SERVER=$SERVER
AH_TAG=$TAG
AH_TOKEN=$TOKEN
AH_ROOM=$ROOM
AH_INSECURE=${AH_INSECURE:-0}
EOF
chmod 600 "$CONF_DIR/client.env"

if [ "$MODE" = "watch" ]; then
  ARGS="inbox --watch --interval $INTERVAL"
else
  ARGS="agent run --tag $TAG --room $ROOM${CWD:+ --cwd $CWD}"
fi

cat > "$UNIT" <<EOF
[Unit]
Description=AgentHub client ($MODE)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$CONF_DIR/client.env
ExecStart=$NODE_BIN $APP_DIR/bin/ah.mjs $ARGS
WorkingDirectory=$APP_DIR
# 客户端自己会重试，这里再加一层兜底：进程真退了就 5 秒后拉起来
Restart=always
RestartSec=5
StandardOutput=append:$LOG_DIR/client.log
StandardError=append:$LOG_DIR/client.err.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now agenthub-client
sleep 2
systemctl --no-pager --lines=12 status agenthub-client || true

cat <<EOF

装好了。
  状态：systemctl status agenthub-client
  日志：tail -f $LOG_DIR/client.log
  改参数：编辑 $CONF_DIR/client.env 后 systemctl restart agenthub-client
  卸载：systemctl disable --now agenthub-client && rm -rf $APP_DIR $CONF_DIR $UNIT
EOF
