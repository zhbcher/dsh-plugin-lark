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
import { execFile, spawn, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { patchBootstrap } from "./patch-bootstrap.js";

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
// 扫码新建机器人（feishu-bot-bootstrap）相关
const BOOTSTRAP_DIR = join(STATE_DIR, "bootstrap");
const BOT_NAME = process.env.LARK_BOT_NAME ?? "DeepSeek Harness 助手";
const BOT_DESC = process.env.LARK_BOT_DESC ?? "由 DeepSeek Harness 飞书接入插件自动创建";

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

// ── 扫码新建机器人（feishu-bot-bootstrap 封装）────────────────────────────
// 状态：{ child, qrAscii, logBuf, eventsPath, done, exitCode, result, error, bound }
let botCreate = null;

/** 递归终止进程树（macOS 无 /proc，用 pgrep -P 逐层找子进程；SIGKILL 强杀，避免工具捕获 SIGTERM 后挂起） */
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    const out = execFileSync("/usr/bin/pgrep", ["-P", String(pid)], { timeout: 5000 });
    for (const line of String(out).split("\n")) {
      const child = Number(line.trim());
      if (child > 0 && child !== pid) killTree(child);
    }
  } catch { /* 无子进程 */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ }
}

/** 解析 events.jsonl：返回 { resultPath, qrPayload, steps }（steps 按 stepId 去重保序） */
function parseEvents(eventsPath) {
  const out = { resultPath: null, qrPayload: null, steps: [] };
  try {
    if (!existsSync(eventsPath)) return out;
    const seen = new Map();
    for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.event === "result" && ev.resultPath) out.resultPath = ev.resultPath;
      if (ev.event === "qr" && ev.payload) out.qrPayload = ev.payload;
      if (ev.event === "step" && ev.stepId && ev.title) {
        seen.set(ev.stepId, { stepId: ev.stepId, title: ev.title, status: ev.status ?? "running" });
      }
    }
    out.steps = [...seen.values()];
  } catch { /* ignore */ }
  return out;
}

/** 用新应用的凭证重绑 lark-cli（secret 经 stdin 传入，不出现在 API/日志） */
function bindApp(appId, appSecret) {
  return new Promise((resolve) => {
    // 必须带 --app-secret-stdin，否则 lark-cli 会要求交互输入密钥、
    // 在无终端环境下直接报错 "requires a terminal for interactive mode"
    const child = spawn(LARK_CLI, ["config", "init", "--app-id", appId, "--app-secret-stdin", "--brand", "feishu"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => resolve({ ok: false, error: e.message }));
    child.on("close", (code) => {
      resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim() || `退出码 ${code}` });
    });
    child.stdin.write(appSecret + "\n");
    child.stdin.end();
  });
}

function startBotCreate(ctx) {
  if (botCreate?.child && !botCreate.done) {
    return { started: false, message: "已有新建流程在运行" };
  }
  // 每次运行使用独立目录 + 唯一应用名 + 全新浏览器 profile，
  // 隔离上次失败运行残留的状态（重复同名应用、残留弹窗/页面）
  const ts = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}`;
  const runName = `${BOT_NAME} (${stamp})`;
  const runDir = join(BOOTSTRAP_DIR, `run-${stamp}`);
  try { mkdirSync(runDir, { recursive: true }); } catch { /* ignore */ }
  const eventsPath = join(runDir, "events.jsonl");
  try { rmSync(eventsPath, { force: true }); } catch { /* ignore */ }
  try { rmSync(join(STATE_DIR, "bootstrap-qr.png"), { force: true }); } catch { /* ignore */ }

  // 对 feishu-bot-bootstrap 应用补丁（幂等）：修复「更新说明」定位 + 创建版本选「测试版本」
  const patched = patchBootstrap();
  if (!patched.ok) {
    ctx.logger.warn(`lark-connector: bootstrap 补丁失败: ${patched.error}`);
  } else {
    ctx.logger.info(`lark-connector: bootstrap 补丁${patched.patched ? "已应用" : "已存在"} (${patched.path})`);
  }

  const args = [
    "--yes", "feishu-bot-bootstrap",
    "--headless", "--lang", "zh",
    "--app-name", runName,
    "--app-description", BOT_DESC,
    "--output-dir", runDir,
    "--user-data-dir", join(runDir, "profile"),
    "--events-jsonl", eventsPath,
  ];
  // 补丁后发布步骤自动创建「测试版本」（免发布免审批，保存即生效）。
  // 应急：LARK_BOT_SKIP_PUBLISH=true 可跳过发布步骤。
  if (process.env.LARK_BOT_SKIP_PUBLISH === "true") args.push("--no-publish");
  ctx.logger.info(`lark-connector: 启动扫码新建机器人: npx ${args.join(" ")}`);
  const child = spawn("npx", args, { stdio: ["ignore", "pipe", "pipe"] });

  const logBuf = [];
  const pushLog = (s) => { logBuf.push(s); if (logBuf.length > 300) logBuf.shift(); };
  child.stdout.on("data", (d) => pushLog(String(d)));
  child.stderr.on("data", (d) => pushLog(String(d)));

  botCreate = {
    child, logBuf, eventsPath, done: false, exitCode: null,
    result: null, error: null, bound: null,
    qrPayload: null, qrReady: false, qrRegenerating: false,
  };

  child.on("close", async (code) => {
    botCreate.exitCode = code;
    botCreate.done = true;
    try {
      const { resultPath, qrPayload } = parseEvents(eventsPath);
      if (code === 0 && resultPath && existsSync(resultPath)) {
        const rj = JSON.parse(readFileSync(resultPath, "utf8"));
        if (rj.status === "succeeded" && rj.credentials?.appId && rj.credentials?.appSecret) {
          botCreate.result = {
            appId: rj.credentials.appId,
            appSecret: rj.credentials.appSecret, // 仅内存使用，绝不返回给前端
            appName: rj.app?.name ?? BOT_NAME,
          };
          botCreate.bound = await bindApp(rj.credentials.appId, rj.credentials.appSecret);
        } else {
          botCreate.error = rj.error?.message ?? "创建未成功（status=" + rj.status + "）";
        }
      } else {
        botCreate.error = `bootstrap 退出码 ${code}`;
      }
    } catch (e) {
      botCreate.error = "解析创建结果失败: " + (e.message ?? String(e));
    }
    ctx.logger.info(`lark-connector: 新建机器人流程结束 code=${code} ${botCreate.error ? "error=" + botCreate.error : ""}`);
  });

  return { started: true };
}

/** 懒同步：发现新的 qr payload 时用 lark-cli 生成 PNG 二维码 */
async function syncBotCreateQr() {
  if (!botCreate || botCreate.done || botCreate.qrRegenerating) return;
  const { qrPayload } = parseEvents(botCreate.eventsPath);
  if (!qrPayload || qrPayload === botCreate.qrPayload) return;
  botCreate.qrRegenerating = true;
  try {
    const r = await runLark(["auth", "qrcode", qrPayload, "-o", "bootstrap-qr.png"], 20000, STATE_DIR);
    botCreate.qrReady = r.ok && existsSync(join(STATE_DIR, "bootstrap-qr.png"));
    botCreate.qrPayload = qrPayload;
  } catch { /* ignore */ } finally {
    botCreate.qrRegenerating = false;
  }
}

async function botCreateStatus() {
  if (!botCreate) return { running: false, phase: "idle" };
  await syncBotCreateQr();
  const ev = parseEvents(botCreate.eventsPath);
  const base = {
    running: !botCreate.done,
    phase: botCreate.done ? "done" : "running",
    qrUrl: botCreate.qrReady ? "/api/lark/bot/create/qr.png" : null,
    steps: ev.steps,
    logs: botCreate.logBuf.slice(-40).join(""),
    error: botCreate.error ?? null,
    bound: botCreate.bound ?? null,
    exitCode: botCreate.exitCode,
  };
  if (botCreate.result) {
    base.result = {
      appId: botCreate.result.appId.slice(0, 12) + "…", // 掩码
      appName: botCreate.result.appName,
    };
  }
  return base;
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

      // 手动绑定凭证（兜底：自动流程失败时粘贴控制台的 AppID/AppSecret）
      if (method === "POST" && path === "/config/bind") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const appId = String(body.appId ?? "").trim();
        const appSecret = String(body.appSecret ?? "").trim();
        if (!/^cli_[a-zA-Z0-9]+$/.test(appId) || appSecret.length < 8) {
          return json(res, 400, { ok: false, error: "AppID 或 AppSecret 格式不正确" });
        }
        const bound = await bindApp(appId, appSecret);
        json(res, 200, { ok: bound.ok, ...(bound.error ? { error: bound.error } : { appId: appId.slice(0, 12) + "…" }) });
        return;
      }

      // 扫码新建机器人（feishu-bot-bootstrap）
      if (method === "POST" && path === "/bot/create") {
        const r = startBotCreate(ctx);
        json(res, 200, { ok: r.started, ...(r.message ? { message: r.message } : {}) });
        return;
      }
      if (method === "GET" && path === "/bot/create/status") {
        json(res, 200, { ok: true, ...(await botCreateStatus()) });
        return;
      }
      if (method === "GET" && path === "/bot/create/qr.png") {
        const qr = join(STATE_DIR, "bootstrap-qr.png");
        if (!existsSync(qr)) return json(res, 404, { ok: false, error: "qr not ready" });
        const body = readFileSync(qr);
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(body);
        return;
      }
      if (method === "POST" && path === "/bot/create/cancel") {
        if (botCreate?.child && !botCreate.done) {
          killTree(botCreate.child.pid); // npx 包装进程 + bootstrap 子进程树一并终止
          json(res, 200, { ok: true, message: "已发送取消" });
        } else {
          json(res, 200, { ok: true, message: "当前没有进行中的创建流程" });
        }
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

  // 插件卸载/Web 退出时终止进行中的 bootstrap 子进程，避免孤儿进程
  ctx.effect(() => () => {
    if (botCreate?.child && !botCreate.done) {
      try { killTree(botCreate.child.pid); } catch { /* ignore */ }
    }
  }, "lark-connector: bot-create cleanup");
}

export { apply, inject, name };
