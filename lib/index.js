/**
 * dsh-plugin-lark — 飞书接入插件（薄架构）服务端
 *
 * 职责（刻意保持"薄"）：
 *  1. 扫码授权：驱动 lark-cli 设备流（auth login --no-wait → auth qrcode → 后台轮询 --device-code）
 *  2. 监听器管理：启停/状态/日志，业务收发仍由独立 lark_bridge.py 网关进程完成
 *  3. 状态与配置查询（lark-cli config show / auth status）
 *
 * 不包含：消息收发、headless 执行——这些在 lark-bridge 进程里，保证 DSH 升级时本插件几乎无耦合。
 */
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const name = "lark-connector";
const inject = ["webServer"];

// ── 常量（可用环境变量覆盖）───────────────────────────────────────────────
const HOME = homedir();
const STATE_DIR = process.env.LARK_CONNECTOR_STATE ?? join(HOME, ".dsh", "lark-connector");
const BRIDGE_DIR = process.env.LARK_BRIDGE_DIR ?? "/Users/zhoubo/GP/lark-bridge";
const BRIDGE_LOG = join(BRIDGE_DIR, "lark_bridge.log");
const AUTH_STATE_FILE = join(STATE_DIR, "auth-state.json");
const LARK_CLI = resolveLarkCli();

function resolveLarkCli() {
  if (process.env.LARK_CLI_BIN) return process.env.LARK_CLI_BIN;
  const guess = join(HOME, ".hermes", "node", "bin", "lark-cli");
  return existsSync(guess) ? guess : "lark-cli";
}

// ── 小工具 ────────────────────────────────────────────────────────────────
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** 执行 lark-cli 短命令（≤60s）。返回 {ok, stdout, stderr, code}。cwd 可选。 */
async function runLark(args, timeoutMs = 60000, cwd) {
  try {
    const { stdout, stderr } = await execFileP(LARK_CLI, args, { timeout: timeoutMs, ...(cwd ? { cwd } : {}) });
    return { ok: true, stdout: String(stdout).trim(), stderr: String(stderr).trim(), code: 0 };
  } catch (e) {
    return {
      ok: false,
      stdout: String(e.stdout ?? "").trim(),
      stderr: String(e.stderr ?? "").trim(),
      code: typeof e.code === "number" ? e.code : 1,
      message: e.message ?? String(e),
    };
  }
}

/** 读文件前 N 字节做安全 tail。 */
function tailFile(path, lines = 100) {
  try {
    const buf = readFileSync(path);
    const text = buf.toString("utf8");
    const parts = text.split(/\r?\n/);
    return parts.slice(Math.max(0, parts.length - lines)).join("\n");
  } catch {
    return "";
  }
}

/** 监听器是否在运行（pid 文件 / pgrep / launchd 三路探测）。 */
async function listenerStatus() {
  const result = { running: false, pid: null, launchd: false, bridgeDir: BRIDGE_DIR, workDir: null };
  try {
    const pidFile = join(BRIDGE_DIR, "lark_bridge.pid");
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); result.pid = pid; result.running = true; } catch { /* 已退出 */ }
      }
    }
  } catch { /* ignore */ }
  try {
    const { stdout } = await execFileP("/usr/bin/pgrep", ["-f", "lark_bridge\\.py"], { timeout: 5000 });
    if (String(stdout).trim()) {
      result.running = true;
      result.pid = Number(String(stdout).trim().split("\n")[0]) || result.pid;
    }
  } catch { /* 未找到 = 未运行 */ }
  try {
    const { stdout } = await execFileP("/bin/launchctl", ["list"], { timeout: 5000 });
    result.launchd = String(stdout).includes("com.dsh.lark-bridge");
  } catch { /* ignore */ }
  return result;
}

/** 读取 lark-cli 配置与应用/授权状态。 */
async function larkStatus() {
  const cfg = await runLark(["config", "show"]);
  let config = {};
  try { config = cfg.ok ? JSON.parse(cfg.stdout) : { error: cfg.stderr || cfg.message }; } catch { config = { raw: cfg.stdout }; }
  const auth = await runLark(["auth", "status"]);
  let authInfo = {};
  try { authInfo = auth.ok ? JSON.parse(auth.stdout) : {}; } catch { authInfo = {}; }
  return { config, auth: authInfo };
}

// ── 授权轮询（后台单例，避免并发阻塞命令）────────────────────────────────
function createAuthPoller(ctx) {
  let poll = null; // { child, settled, result }
  return {
    /** 用新 device_code 启动后台轮询；如已有轮询则先终止。 */
    start(deviceCode) {
      if (poll?.child && !poll.settled) {
        try { poll.child.kill("SIGTERM"); } catch { /* ignore */ }
      }
      const child = spawn(LARK_CLI, ["auth", "login", "--device-code", deviceCode, "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "", err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      const myPoll = { child, settled: false, result: null };
      poll = myPoll;
      child.on("close", (code) => {
        // 闭包引用 myPoll，避免 cancel() 将模块级 poll 置空后此处空指针
        myPoll.settled = true;
        myPoll.result = { code, out: out.trim(), err: err.trim() };
        ctx.logger.info(`lark auth poll finished: rc=${code}`);
      });
      ctx.logger.info("lark auth poll started (waiting for scan)");
      return poll;
    },
    status() {
      if (!poll) return { phase: "idle" };
      if (!poll.settled) return { phase: "pending" };
      return { phase: "done", ok: poll.result.code === 0, result: poll.result };
    },
    cancel() {
      if (poll?.child && !poll.settled) { try { poll.child.kill("SIGTERM"); } catch { /* ignore */ } }
      poll = null;
    },
  };
}

// ── 插件主体 ──────────────────────────────────────────────────────────────
function apply(ctx) {
  mkdirSync(STATE_DIR, { recursive: true });
  const poller = createAuthPoller(ctx);

  const handle = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/^\/api\/lark/, "") || "/";
    const method = req.method ?? "GET";
    try {
      // 二维码图片
      if (method === "GET" && path === "/auth/qr.png") {
        const qr = join(STATE_DIR, "qr.png");
        if (!existsSync(qr)) return json(res, 404, { ok: false, error: "qr not ready" });
        const body = readFileSync(qr);
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(body);
        return;
      }

      // 统一状态
      if (method === "GET" && path === "/status") {
        const [lark, listener] = await Promise.all([larkStatus(), listenerStatus()]);
        json(res, 200, {
          ok: true,
          auth: {
            appId: lark.config.appId ?? null,
            brand: lark.config.brand ?? null,
            defaultAs: lark.auth.defaultAs ?? null,
            bot: lark.auth.identities?.bot ?? null,
            user: lark.auth.identities?.user ?? null,
            users: lark.config.users ?? null,
          },
          poll: poller.status(),
          listener,
          workDir: process.env.DSH_WORK_DIR ?? "/Users/zhoubo/deepseek",
        });
        return;
      }

      // 发起扫码授权：拿 device_code + verification_url，生成二维码
      if (method === "POST" && path === "/auth/start") {
        poller.cancel();
        const r = await runLark(["auth", "login", "--no-wait", "--json", "--domain", "all"], 30000);
        if (!r.ok) return json(res, 500, { ok: false, error: r.stderr || r.message });
        let parsed;
        try { parsed = JSON.parse(r.stdout); } catch {
          return json(res, 500, { ok: false, error: "无法解析 lark-cli 输出" });
        }
        const { device_code: deviceCode, verification_url: verificationUrl, expires_in: expiresIn } = parsed;
        if (!deviceCode || !verificationUrl) {
          return json(res, 500, { ok: false, error: "lark-cli 未返回设备码", raw: r.stdout.slice(0, 300) });
        }
        // 生成二维码 PNG（lark-cli 要求相对路径，cwd 指向状态目录）
        const qr = await runLark(["auth", "qrcode", verificationUrl, "-o", "qr.png"], 30000, STATE_DIR);
        if (!qr.ok || !existsSync(join(STATE_DIR, "qr.png"))) {
          return json(res, 500, { ok: false, error: "二维码生成失败: " + (qr.stderr || qr.message) });
        }
        // 落盘状态（含 device_code，便于调试；敏感但不落盘则重启即失效）
        try {
          const fs = await import("node:fs");
          fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify({ deviceCode, verificationUrl, expiresIn, at: Date.now() }, null, 2));
        } catch { /* ignore */ }
        poller.start(deviceCode);
        json(res, 200, {
          ok: true,
          qrUrl: "/api/lark/auth/qr.png",
          deviceCode,
          expiresIn,
          verificationUrl,
        });
        return;
      }

      // 授权轮询状态（前端轮询此接口，不阻塞）
      if (method === "GET" && path === "/auth/status") {
        json(res, 200, { ok: true, ...poller.status() });
        return;
      }

      // 取消授权
      if (method === "POST" && path === "/auth/cancel") {
        poller.cancel();
        json(res, 200, { ok: true, phase: "idle" });
        return;
      }

      // 监听器：启动 / 停止（转发给 manage_lark_bridge.sh）
      if (method === "POST" && (path === "/listener/start" || path === "/listener/stop")) {
        const action = path.endsWith("/start") ? "start" : "stop";
        const script = join(BRIDGE_DIR, "manage_lark_bridge.sh");
        if (!existsSync(script)) return json(res, 500, { ok: false, error: `找不到 ${script}` });
        const { stdout, stderr } = await execFileP("/bin/bash", [script, action], {
          cwd: BRIDGE_DIR, timeout: 30000,
        }).catch((e) => ({ stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e.message) }));
        json(res, 200, { ok: true, action, output: (stdout + stderr).trim() });
        return;
      }

      // 监听器日志（tail）
      if (method === "GET" && path === "/listener/logs") {
        const lines = Math.min(500, Math.max(10, Number(url.searchParams.get("lines")) || 100));
        json(res, 200, { ok: true, log: tailFile(BRIDGE_LOG, lines) });
        return;
      }

      // lark-cli 配置（含掩码）
      if (method === "GET" && path === "/config") {
        const r = await runLark(["config", "show"]);
        let cfg = {};
        try { cfg = r.ok ? JSON.parse(r.stdout) : { error: r.stderr || r.message }; } catch { cfg = { raw: r.stdout }; }
        json(res, 200, { ok: true, config: cfg });
        return;
      }

      json(res, 404, { ok: false, error: `unknown route ${method} ${path}` });
    } catch (e) {
      ctx.logger.warn(`lark-connector: ${e instanceof Error ? e.message : String(e)}`);
      json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  ctx.webServer.register({ kind: "prefix", path: "/api/lark", handler: handle });
  ctx.logger.info(`lark-connector: 飞书接入路由已注册 (/api/lark/*), 状态目录 ${STATE_DIR}`);
}

export { apply, inject, name };
