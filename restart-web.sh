#!/bin/bash
# 重启 dsh web（用于加载 profile 变更，如 dsh-plugin-lark）
# 用法: bash restart-web.sh
set -e

DSH_BIN="/Users/zhoubo/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/lib/bin.js"
LOG="/tmp/dsh-web.log"
export PATH="/Users/zhoubo/.npm/_npx/1e7f6d9597241db0/node_modules/.bin:/Users/zhoubo/.hermes/node/bin:/Users/zhoubo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

echo "=== 停止旧 Web 进程 ==="
PIDS=$(lsof -tiTCP:3080 -sTCP:LISTEN 2>/dev/null || true)
[ -n "$PIDS" ] && kill $PIDS 2>/dev/null || true
pkill -f "npm exec @deepseek-ai/dsh" 2>/dev/null || true
for i in $(seq 1 30); do
  if ! lsof -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "=== 启动新 Web 进程 ==="
cd /Users/zhoubo
nohup node "$DSH_BIN" web > "$LOG" 2>&1 &
NEW_PID=$!
echo "新 PID: $NEW_PID"

for i in $(seq 1 90); do
  if lsof -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "✅ Web 已监听 127.0.0.1:3080"
    exit 0
  fi
  sleep 1
done
echo "⚠️ 启动超时，日志尾部："
tail -30 "$LOG"
exit 1
