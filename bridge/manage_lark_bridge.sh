#!/bin/bash
# 飞书 ↔ DeepSeek Harness 网关启动/停止脚本
# 用法: ./manage_lark_bridge.sh {start|stop|status|logs}
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/lark_bridge.pid"

case "${1:-status}" in
  start)
    if pgrep -f "lark_bridge\.py" >/dev/null 2>&1; then
      echo "已有网关实例在运行（含 launchd 托管），拒绝重复启动以免飞书重复回复"
      exit 1
    fi
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "网关已在运行 (PID $(cat "$PID_FILE"))"
      exit 0
    fi
    cd "$DIR"
    nohup python3 lark_bridge.py > lark_bridge.out.log 2>&1 &
    echo $! > "$PID_FILE"
    sleep 2
    echo "网关已启动 (PID $(cat "$PID_FILE"))"
    echo "日志: $DIR/lark_bridge.log"
    ;;
  stop)
    if [ -f "$PID_FILE" ]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null && echo "网关已停止" || echo "进程不存在"
      rm -f "$PID_FILE"
    else
      echo "网关未运行"
    fi
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "网关运行中 (PID $(cat "$PID_FILE"))"
    else
      echo "网关未运行"
    fi
    ;;
  logs)
    tail -f "$DIR/lark_bridge.log"
    ;;
  *)
    echo "用法: $0 {start|stop|status|logs}"
    ;;
esac
