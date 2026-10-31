#!/usr/bin/env bash
# ah 客户端自检：起一个隔离实例（临时端口 + 临时数据目录），验正文来源的三条路
# （文件 / 管道 / 位置参数）、附件语义、缺文件报错，跑完整目录清掉，不碰真实房间。
#
#   bash scripts/cli-selftest.sh
#
# 端口动态挑：8787 与一些 1xxxx 段常被 DSH 或历史实例占着，写死必踩 EADDRINUSE。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

PORT=$(node -e '
const net = require("node:net");
const srv = net.createServer();
srv.listen(0, "127.0.0.1", () => { console.log(srv.address().port); srv.close(); });
')
DATA="$ROOT/data/tmp/cli-selftest-data"
PROFILE=cli-selftest
URL="http://127.0.0.1:$PORT"
AH="node server/bin/ah.mjs"

command -v node >/dev/null 2>&1 || { echo "FAIL 找不到 node"; exit 1; }
[ -f server/dist/index.js ] || { echo "FAIL 没有 server/dist/index.js，先 npm run build"; exit 1; }

rm -rf "$DATA"; mkdir -p "$DATA"
AH_PORT=$PORT AH_DATA_DIR="$DATA" AH_HOST=127.0.0.1 node server/dist/index.js >"$DATA/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; wait $SRV 2>/dev/null' EXIT

for _ in $(seq 1 40); do
  curl -sf "$URL/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "$URL/api/health" >/dev/null 2>&1 || { echo "FAIL 服务没起来"; tail -20 "$DATA/server.log"; exit 1; }
echo "PASS 服务已起 $URL"

export AH_SERVER="$URL" AH_PROFILE="$PROFILE"

# 1) 注册（agent 身份；房间要先建，register --room 只认已存在的房间）
$AH register --tag selftest --nickname 自检机器人 --kind agent --adapter external >/dev/null 2>&1 \
  || { echo "FAIL 注册"; exit 1; }
$AH room create 自检房间 >/dev/null 2>&1 || { echo "FAIL 建房间"; exit 1; }
echo "PASS 注册 + 建房间"

# 2) 中文正文走 --body-file（模拟 Windows 场景：命令里只有一个纯 ASCII 路径）
cat >"$DATA/msg.md" <<'EOF'
# 第三轮对照

中文正文测一下：量化器换成 EMA，配对差 1.76×。

- 行内反引号 `kv_keys += define_gate * a_key[i](emb)`
- 全角标点：「引号」、顿号、（括号）

@selftest 记得回我。
EOF
$AH send --body-file "$DATA/msg.md" >/dev/null 2>&1 || { echo "FAIL --body-file 发送"; exit 1; }
echo "PASS --body-file 发送"

# 3) 管道走 --stdin
printf '第二段：走管道的中文正文，%s\n' '含百分号与"引号"' | $AH send --stdin >/dev/null 2>&1 \
  || { echo "FAIL --stdin 发送"; exit 1; }
echo "PASS --stdin 发送"

# 4) 回读校验：字节要和文件一致（去 BOM、统一换行、收首尾空行之后）
node - "$DATA/msg.md" "$URL" <<'NODE'
const fs = require('node:fs');
const [file, url] = process.argv.slice(2);
const want = fs.readFileSync(file, 'utf8')
  .replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  .replace(/^\n+/, '').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
(async () => {
  const prof = JSON.parse(fs.readFileSync(
    process.env.USERPROFILE + '/.agenthub/profiles/cli-selftest.json', 'utf8'));
  const res = await fetch(`${url}/api/rooms/${encodeURIComponent('自检房间')}/messages?limit=10`, {
    headers: { Authorization: `Bearer ${prof.token}` },
  });
  const data = await res.json();
  const mine = data.messages.filter((m) => m.senderTag === 'selftest');
  const first = mine.find((m) => m.text.includes('第三轮对照'));
  if (!first) { console.log('FAIL 没找到第一条消息'); process.exit(1); }
  const got = first.text.replace(/\s*@selftest\s*$/, '');
  if (got !== want) {
    console.log('FAIL 正文不一致');
    console.log('--- want ---\n' + JSON.stringify(want));
    console.log('--- got  ---\n' + JSON.stringify(got));
    process.exit(1);
  }
  console.log('PASS 中文正文往返字节一致（' + Buffer.byteLength(want, 'utf8') + ' 字节）');
  const second = mine.find((m) => m.text.includes('走管道'));
  if (!second) { console.log('FAIL 没找到管道消息'); process.exit(1); }
  if (!second.text.includes('百分号')) { console.log('FAIL 管道消息内容截断'); process.exit(1); }
  console.log('PASS 管道消息入库：' + JSON.stringify(second.text));
})();
NODE
RC=$?
[ "$RC" -ne 0 ] && exit "$RC"

# 5) --file 仍然是附件，不读正文
printf 'PNGDATA' >"$DATA/a.png"
OUT=$($AH send --body-file "$DATA/msg.md" --file "$DATA/a.png" 2>&1)
echo "$OUT" | grep -q '已发送' || { echo "FAIL --file 附件发送：$OUT"; exit 1; }
echo "PASS --file 仍是附件（正文来自 --body-file）"

# 6) 缺文件要报错而不是发空消息
$AH send --body-file "$DATA/nope.md" >/dev/null 2>&1 && { echo "FAIL 缺文件竟然成功了"; exit 1; }
echo "PASS 缺文件时报错"

# 7) 老写法不能退化：纯 ASCII 位置参数与 --text
$AH send "plain ascii positional" >/dev/null 2>&1 || { echo "FAIL 位置参数"; exit 1; }
$AH send --text "via text flag" >/dev/null 2>&1 || { echo "FAIL --text"; exit 1; }
echo "PASS 位置参数与 --text 仍然可用"

# 8) 正文与结构化载荷可以同时给
$AH send --body-file "$DATA/msg.md" --data '{"metric":"mIoU","v7":2.13}' >/dev/null 2>&1 \
  || { echo "FAIL --body-file + --data"; exit 1; }
echo "PASS --body-file 与 --data 共存"

kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
rm -rf "$DATA" "$USERPROFILE/.agenthub/profiles/$PROFILE.json"
echo "ALL PASS"
