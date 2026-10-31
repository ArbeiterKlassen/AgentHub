#!/usr/bin/env bash
# ah watch 的行为测试：只在「别人说话」时退出，自己发言与系统消息不叫醒它。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

PORT=$(node -e 'const n=require("node:net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')
DATA="$ROOT/data/tmp/watch-test-data"
rm -rf "$DATA"; mkdir -p "$DATA"
AH_PORT=$PORT AH_DATA_DIR="$DATA" AH_HOST=127.0.0.1 node server/dist/index.js >"$DATA/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; rm -rf "$DATA"' EXIT
export AH_SERVER="http://127.0.0.1:$PORT"
AH="node server/bin/ah.mjs"

for _ in $(seq 1 40); do curl -sf "$AH_SERVER/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$AH_SERVER/api/health" >/dev/null 2>&1 || { echo "FAIL 服务没起来"; tail -20 "$DATA/server.log"; exit 1; }
echo "PASS 服务已起 $AH_SERVER"

AH_PROFILE=w $AH register --tag watcher --nickname 值班AI --kind agent --adapter external >/dev/null 2>&1
AH_PROFILE=w $AH room create 值班房间 >/dev/null 2>&1
CODE=$(AH_PROFILE=w $AH room code 值班房间 --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).code))')
AH_PROFILE=t $AH register --tag talker --nickname 说话的AI --kind agent --adapter external >/dev/null 2>&1
AH_PROFILE=t $AH room join --code "$CODE" >/dev/null 2>&1
echo "PASS 两个身份 + 房间（邀请码 $CODE）"

# --- 用例 1：别人说话 → watch 退出并打印 JSON ---
AH_PROFILE=w $AH watch --json >"$DATA/watch1.out" 2>"$DATA/watch1.err" &
W1=$!
sleep 2
AH_PROFILE=t $AH send "watcher 你好，这是新消息" >/dev/null 2>&1
ok=0
for _ in $(seq 1 30); do kill -0 $W1 2>/dev/null || { ok=1; break; }; sleep 0.5; done
[ "$ok" = 1 ] || { echo "FAIL 用例1 watch 没退出"; kill $W1 2>/dev/null; cat "$DATA/watch1.err"; exit 1; }
wait $W1; RC=$?
grep -q '这是新消息' "$DATA/watch1.out" || { echo "FAIL 用例1 输出没有消息"; cat "$DATA/watch1.out"; exit 1; }
grep -q '"count": 1' "$DATA/watch1.out" || { echo "FAIL 用例1 count 不对"; cat "$DATA/watch1.out"; exit 1; }
[ "$RC" = 0 ] || { echo "FAIL 用例1 退出码 $RC"; exit 1; }
echo "PASS 别人说话时 watch 退出（退出码 0，JSON 带消息）"

# --- 用例 2：自己说话、系统消息不叫醒 ---
AH_PROFILE=w $AH watch --json >"$DATA/watch2.out" 2>&1 &
W2=$!
sleep 2
AH_PROFILE=w $AH send "这是值班 AI 自己的发言" >/dev/null 2>&1
sleep 8
if kill -0 $W2 2>/dev/null; then echo "PASS 自己的发言不会叫醒 watch"; else
  echo "FAIL 用例2 被自己的消息叫醒了"; cat "$DATA/watch2.out"; exit 1; fi

# --- 用例 3：--after 之后的新消息能叫醒 ---
LAST=$(AH_PROFILE=w $AH history --limit 1 --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=j.messages||j;console.log(a[a.length-1].id)})')
AH_PROFILE=w $AH watch --json --after "$LAST" >"$DATA/watch3.out" 2>&1 &
W3=$!
sleep 2
AH_PROFILE=t $AH send "after 之后的新消息" >/dev/null 2>&1
ok=0
for _ in $(seq 1 30); do kill -0 $W3 2>/dev/null || { ok=1; break; }; sleep 0.5; done
[ "$ok" = 1 ] || { echo "FAIL 用例3 没退出"; kill $W3 2>/dev/null; exit 1; }
grep -q 'after 之后的新消息' "$DATA/watch3.out" || { echo "FAIL 用例3 内容"; cat "$DATA/watch3.out"; exit 1; }
echo "PASS --after 只等之后的消息"

# --- 用例 4：--mention-only 只在被 @ 时退出 ---
AH_PROFILE=w $AH watch --mention-only --json >"$DATA/watch4.out" 2>&1 &
W4=$!
sleep 2
AH_PROFILE=t $AH send "这句没有提到任何人" >/dev/null 2>&1
sleep 8
if kill -0 $W4 2>/dev/null; then echo "PASS 无关消息不会叫醒 --mention-only"; else
  echo "FAIL 用例4 被无关消息叫醒"; cat "$DATA/watch4.out"; exit 1; fi
AH_PROFILE=t $AH send "@watcher 这条是叫你的" >/dev/null 2>&1
ok=0
for _ in $(seq 1 40); do kill -0 $W4 2>/dev/null || { ok=1; break; }; sleep 0.5; done
[ "$ok" = 1 ] || { echo "FAIL 用例4 被 @ 后没退出"; kill $W4 2>/dev/null; exit 1; }
grep -q '这条是叫你的' "$DATA/watch4.out" || { echo "FAIL 用例4 内容"; cat "$DATA/watch4.out"; exit 1; }
echo "PASS --mention-only 只在被 @ 时退出"

echo "ALL PASS"
