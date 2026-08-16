#!/usr/bin/env python3
"""
飞书 ↔ DeepSeek Harness 双向网关守护脚本

流程:
  飞书用户发消息 → lark-cli event consume im.message.receive_v1 (NDJSON 流)
    → 提取任务文本 → dsh --profile headless "<任务>" 执行
    → 结果通过 lark-cli im +messages-reply 回复给用户

用法:
  python3 lark_bridge.py                # 前台运行（调试）
  python3 lark_bridge.py --daemon       # 后台运行（nohup）
  python3 lark_bridge.py --test "你好"   # 自测：直接调用 headless 并打印结果（不依赖飞书）
"""
import argparse
import json
import logging
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

# ── 配置 ──────────────────────────────────────────────────────────────────────
LOG_FILE = Path(__file__).parent / "lark_bridge.log"
# 单实例锁文件（与 manage_lark_bridge.sh 共用）
PID_FILE = Path(__file__).parent / "lark_bridge.pid"
# dsh headless 任务的会话工作目录（Agent 的 cwd / workspace，所有任务文件都落在这里）。
# 默认 = 当前工作区域 /Users/zhoubo/deepseek；可用环境变量 DSH_WORK_DIR 覆盖。
WORK_DIR = Path(os.environ.get("DSH_WORK_DIR", "~")).expanduser().resolve()  # 通用默认：用户主目录；可设 DSH_WORK_DIR
DSH_BIN = Path(os.environ.get("DSH_BIN", "dsh"))  # 通用默认：从 PATH 解析 dsh；可设 DSH_BIN 指定绝对路径
HEADLESS_TIMEOUT_S = int(os.environ.get("HEADLESS_TIMEOUT_S", "900"))  # 任务超时15分钟
MAX_TASK_LEN = 4000  # 任务文本长度上限（防止误发大段内容）
# 网关使用的飞书应用配置目录（lark-cli config 位置）。
# 默认 None = 用 lark-cli 当前默认配置（config init 完成后即默认）。
# 若使用独立配置（如 HERMES_HOME 或自定义 app profile），在此指定。
LARK_HOME = os.environ.get("LARK_CLI_HOME") or None
if LARK_HOME:
    os.environ["HERMES_HOME"] = LARK_HOME  # lark-cli 通过 HERMES_HOME 发现配置

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_FILE), logging.StreamHandler()],
)
log = logging.getLogger("lark_bridge")


def run_headless(task: str) -> str:
    """调用 dsh --profile headless 执行任务，返回最终回复文本。

    子进程 cwd 显式设为 WORK_DIR（否则会继承网关启动目录），
    这样 headless Agent 的会话工作目录就是用户指定的工作区域。
    """
    cmd = ["node", str(DSH_BIN), "--profile", "headless", task]
    log.info("dsh headless 执行中 (cwd=%s): %s...", WORK_DIR, task[:80])
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=HEADLESS_TIMEOUT_S,
            cwd=WORK_DIR,
        )
        out = (proc.stdout or "").strip()
        if proc.returncode != 0:
            err = (proc.stderr or "").strip()[-500:]
            log.error("headless 退出码 %s: %s", proc.returncode, err)
            return f"⚠️ Harness 执行失败（退出码 {proc.returncode}）：\n{err}"
        if not out:
            return "⚠️ Harness 没有返回内容。"
        return out
    except subprocess.TimeoutExpired:
        log.error("headless 超时（%ss）", HEADLESS_TIMEOUT_S)
        return f"⚠️ 任务执行超时（>{HEADLESS_TIMEOUT_S}秒），已放弃。请简化任务或重试。"
    except FileNotFoundError as e:
        log.error("找不到 dsh: %s", e)
        return f"⚠️ 网关内部错误：找不到 dsh（{e}）"


def handle_message(msg: dict) -> None:
    """处理一条收到的飞书消息。"""
    event_id = msg.get("event_id", "")
    message_id = msg.get("message_id") or msg.get("message", {}).get("message_id")
    content = msg.get("content") or ""
    chat_type = msg.get("chat_type", "")
    # 发送者 open_id（顶层字段；兼容嵌套结构）
    sender_id = msg.get("sender_id") or msg.get("sender", {}).get("id", "")
    chat_id = msg.get("chat_id", "")
    log.info("事件详情 event=%s sender_id=%s chat_id=%s chat_type=%s msg=%s",
             event_id, sender_id, chat_id, chat_type, message_id)
    sender = msg.get("sender", {}).get("id", "") if isinstance(msg.get("sender"), dict) else ""

    if not content or not str(content).strip():
        log.info("跳过空消息 %s", event_id)
        return
    task = str(content).strip()
    if len(task) > MAX_TASK_LEN:
        task = task[:MAX_TASK_LEN]
        log.warning("任务过长，已截断到 %s 字符", MAX_TASK_LEN)

    log.info("收到任务 (chat=%s sender=%s msg=%s): %s", chat_type, sender, message_id, task[:80])

    if not message_id:
        log.warning("消息缺少 message_id，跳过回复: %s", event_id)
        return

    # 执行任务
    reply = run_headless(task)

    # 回复飞书
    cmd = [
        "lark-cli", "im", "+messages-reply",
        "--as", "bot",
        "--message-id", str(message_id),
        "--text", reply,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        log.info("回复发送: rc=%s %s", r.returncode, (r.stdout or r.stderr or "")[:200])
        if r.returncode != 0:
            log.error("回复失败: %s", (r.stderr or "")[:300])
    except Exception as e:
        log.error("回复异常: %s", e)


def consume_loop() -> None:
    """启动 lark-cli event consume 子进程，逐条处理 NDJSON 事件。

    注意：consume 将 stdin EOF 视为退出信号（为 AI 子进程调用设计），
    后台运行时必须保持 stdin 打开（stdin=PIPE），否则会立即退出。
    """
    cmd = ["lark-cli", "event", "consume", "im.message.receive_v1", "--as", "bot"]
    log.info("启动事件监听: %s", " ".join(cmd))
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, bufsize=1,
    )

    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            log.debug("非JSON行: %s", line[:120])
            continue
        try:
            handle_message(msg)
        except Exception as e:
            log.error("处理消息异常: %s", e)

    # 子进程退出后等待重启
    log.warning("事件监听子进程退出 rc=%s，5秒后重启", proc.poll())
    proc.wait()
    time.sleep(5)


def _pid_alive(pid: int) -> bool:
    """判断 pid 是否存活（0 号信号探测）。"""
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def acquire_singleton() -> bool:
    """单实例保护：若已有存活网关实例则返回 False。

    双实例会导致同一条飞书消息被回复两次，这里通过 pid 锁文件阻止重复启动。
    """
    if PID_FILE.exists():
        try:
            old_pid = int(PID_FILE.read_text().strip())
        except (ValueError, OSError):
            old_pid = -1
        if old_pid > 0 and old_pid != os.getpid() and _pid_alive(old_pid):
            return False
    try:
        PID_FILE.write_text(str(os.getpid()))
    except OSError as e:
        log.warning("写入 pid 文件失败: %s", e)
    return True


def main():
    ap = argparse.ArgumentParser(description="飞书 ↔ Harness 网关")
    ap.add_argument("--daemon", action="store_true", help="后台运行")
    ap.add_argument("--test", metavar="TASK", help="自测：直接跑 headless 不依赖飞书")
    args = ap.parse_args()

    if args.test:
        print(run_headless(args.test))
        return

    if args.daemon:
        # 用 nohup 重新拉起自己（前台模式）；子进程会走下面的单实例保护
        cmd = ["nohup", sys.executable, str(Path(__file__).resolve()),
               ">", str(LOG_FILE), "2>&1", "&"]
        subprocess.run(" ".join(cmd), shell=True)
        print(f"网关已后台启动，日志: {LOG_FILE}")
        return

    # 单实例保护：防止 launchd 与手动启动并存导致重复回复
    if not acquire_singleton():
        log.error("检测到已有网关实例在运行（pid 文件 %s），本实例退出，避免重复回复", PID_FILE)
        return  # 正常退出码，配合 KeepAlive SuccessfulExit=false 不会触发重启循环

    log.info("=== 飞书↔Harness 网关启动 ===")
    log.info("任务工作目录: %s", WORK_DIR)
    # 循环监听（崩溃自动重启）
    while True:
        try:
            consume_loop()
        except KeyboardInterrupt:
            log.info("手动停止")
            sys.exit(0)
        except Exception as e:
            log.error("监听循环异常: %s", e)
            time.sleep(5)


if __name__ == "__main__":
    main()
