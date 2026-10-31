#!/usr/bin/env bash
# ah 的安全护栏：login 覆盖保护、新 profile 服务地址、whoami token 打码、--help 退出码。
# 全程用隔离的 HOME，不碰本机 ~/.agenthub。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

PORT=$(node -e 'const n=require("node:net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')
DATA="$ROOT/data/tmp/guard-test-data"
FAKE_HOME="$ROOT/data/tmp/guard-test-home"
rm -rf "$DATA" "$FAKE_HOME"; mkdir -p "$DATA" "$FAKE_HOME"
AH_PORT=$PORT AH_DATA_DIR="$DATA" AH_HOST=127.0.0.1 node server/dist/index.js >"$DATA/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; rm -rf "$DATA" "$FAKE_HOME"' EXIT

export HOME="$FAKE_HOME"
export USERPROFILE="$FAKE_HOME"
export AH_SERVER="http://127.0.0.1:$PORT"
AH="node server/bin/ah.mjs"
PROFILES="$FAKE_HOME/.agenthub/profiles"

for _ in $(seq 1 40); do curl -sf "$AH_SERVER/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$AH_SERVER/api/health" >/dev/null 2>&1 || { echo "FAIL 服务没起来"; tail -20 "$DATA/server.log"; exit 1; }
echo "PASS 服务已起 $AH_SERVER"

field() { node -e "try{console.log(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[process.argv[2]]))}catch{console.log('')}" "$1" "$2"; }

# --- 准备：default profile 里先有一个身份 ---
$AH register --tag guard-a --nickname 护栏甲 --kind agent --adapter external >/dev/null 2>&1
[ "$(field "$PROFILES/default.json" tag)" = "guard-a" ] || { echo "FAIL 准备阶段没写进 default profile"; exit 1; }
TOKEN_A=$(field "$PROFILES/default.json" token)

# --- 用例 1：换个人登录同名 profile 必须被拦住 ---
OUT=$($AH login --tag guard-b --token deadbeef 2>&1); RC=$?
if [ "$RC" -eq 0 ]; then echo "FAIL 用例1 覆盖没有被拦住"; exit 1; fi
echo "$OUT" | grep -q "覆盖" || { echo "FAIL 用例1 报错没说清覆盖"; echo "$OUT"; exit 1; }
[ "$(field "$PROFILES/default.json" tag)" = "guard-a" ] || { echo "FAIL 用例1 凭据被改写了"; exit 1; }
[ "$(field "$PROFILES/default.json" token)" = "$TOKEN_A" ] || { echo "FAIL 用例1 token 被改写了"; exit 1; }
echo "PASS 同名 profile 换人登录被拦住，凭据未被改写"

# --- 用例 2：--force 才放行，并且不继承前一个人的房间 ---
$AH register --profile b --tag guard-b --nickname 护栏乙 --kind agent --adapter external >/dev/null 2>&1
TOKEN_B=$(field "$PROFILES/b.json" token)
$AH login --tag guard-b --token "$TOKEN_B" --force >/dev/null 2>&1 || { echo "FAIL 用例2 --force 没能放行"; exit 1; }
[ "$(field "$PROFILES/default.json" tag)" = "guard-b" ] || { echo "FAIL 用例2 没换成 guard-b"; exit 1; }
[ "$(field "$PROFILES/default.json" room)" = "null" ] || { echo "FAIL 用例2 仍继承了旧房间「$(field "$PROFILES/default.json" room)」"; exit 1; }
echo "PASS --force 放行，换人登录时旧房间被清掉"

# --- 用例 3：新 profile 不给服务地址就明确报错，不回落 localhost ---
OUT=$(env -u AH_SERVER $AH register --profile fresh --tag fresh-1 --nickname 新人 2>&1); RC=$?
if [ "$RC" -eq 0 ]; then echo "FAIL 用例3 新 profile 缺地址没报错"; exit 1; fi
echo "$OUT" | grep -q "新建" || { echo "FAIL 用例3 报错没解释原因"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q "npm run dev" && { echo "FAIL 用例3 还在提示本地开发那套"; exit 1; }
[ -f "$PROFILES/fresh.json" ] && { echo "FAIL 用例3 报错还写了 profile"; exit 1; }
echo "PASS 新 profile 缺服务地址时明确报错"

# --- 用例 4：whoami 默认打码，--show-token 才全量 ---
OUT=$($AH --profile b whoami 2>&1)
echo "$OUT" | grep -q "…" || { echo "FAIL 用例4 token 没打码"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q "$TOKEN_B" && { echo "FAIL 用例4 仍然打印了完整 token"; exit 1; }
$AH --profile b whoami --show-token 2>&1 | grep -q "$TOKEN_B" || { echo "FAIL 用例4 --show-token 没给全量"; exit 1; }
echo "PASS whoami 默认打码，--show-token 看完整"

# --- 用例 5：子命令 --help 正常退出 ---
$AH login --help >/dev/null 2>&1 || { echo "FAIL 用例5 ah login --help 退出码非 0"; exit 1; }
$AH send --help >/dev/null 2>&1 || { echo "FAIL 用例5 ah send --help 退出码非 0"; exit 1; }
echo "PASS 子命令 --help 退出码 0"

echo "ALL PASS"
