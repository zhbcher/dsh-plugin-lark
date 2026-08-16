/**
 * dsh-plugin-lark 后端自测 harness（不启动 DSH Web）
 * 用假 ctx 捕获 webServer 路由 → 挂到本地 http 服务器 → 实测各 API
 */
import http from "node:http";
import { apply } from "../lib/index.js";

const routes = [];
const ctx = {
  webServer: {
    register(route) {
      routes.push(route);
      console.log(`[harness] 捕获路由: ${route.kind} ${route.path}`);
    },
  },
  logger: {
    info: (...a) => console.log("[harness:info]", ...a),
    warn: (...a) => console.log("[harness:warn]", ...a),
    error: (...a) => console.log("[harness:error]", ...a),
  },
  effect: (fn) => fn(), // 测试用：立即执行注册，忽略清理逻辑
};

apply(ctx);

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  const route = routes.find((r) => r.kind === "prefix" && pathname.startsWith(r.path));
  if (!route) {
    res.writeHead(404); res.end("not found"); return;
  }
  await route.handler(req, res);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log(`[harness] 测试服务器: ${base}\n`);

async function call(method, path) {
  const r = await fetch(base + path, { method, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  const ct = r.headers.get("content-type") || "";
  let body = text;
  if (ct.includes("json")) { try { body = JSON.parse(text); } catch { /* keep text */ } }
  console.log(`--- ${method} ${path} → ${r.status} ${ct.includes("json") ? "" : `(${ct})`}`);
  if (typeof body === "string") console.log(body.slice(0, 200));
  else console.log(JSON.stringify(body, null, 1).slice(0, 900));
  return { status: r.status, body };
}

// 1. 状态
await call("GET", "/api/lark/status");
// 2. 配置
await call("GET", "/api/lark/config");
// 3. 扫码新建机器人：启动 → 轮询（等待 PNG 二维码）→ 验证图片 → 取消
console.log("[harness] === 新建机器人流程（真实启动 bootstrap，最多 60 秒轮询后取消）===");
await call("POST", "/api/lark/bot/create");
let qrUrlFound = null;
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  const st = await call("GET", "/api/lark/bot/create/status");
  if (st.body?.qrUrl) { qrUrlFound = st.body.qrUrl; break; }
  if (st.body?.steps?.length) console.log(`[harness] 步骤: ${st.body.steps.map((s) => s.title).join(" → ")}`);
  if (st.body?.error) { console.log(`[harness] ⚠️ 流程报错: ${st.body.error}`); break; }
}
if (qrUrlFound) {
  const img = await call("GET", qrUrlFound);
  console.log(`[harness] ✅ PNG 二维码已生成并可访问（HTTP ${img.status}）`);
} else {
  console.log("[harness] ⚠️ 未捕获到二维码（可能浏览器启动慢或流程异常）");
}
await call("POST", "/api/lark/bot/create/cancel");
console.log(qrUrlFound ? "[harness] ✅ 二维码流程验证通过" : "[harness] ⚠️ 二维码流程未通过");

// 4. 发起扫码授权（真实调用 lark-cli，生成二维码 + 后台轮询）
const start = await call("POST", "/api/lark/auth/start");
// 5. 二维码图片
await call("GET", "/api/lark/auth/qr.png");
// 6. 授权轮询状态（应为 pending）
await call("GET", "/api/lark/auth/status");
// 7. 监听器日志（现有网关日志）
await call("GET", "/api/lark/listener/logs?lines=20");
// 8. 取消授权（清理后台轮询）
await call("POST", "/api/lark/auth/cancel");
// 9. 未知路由
await call("GET", "/api/lark/nope");

server.close();
console.log("\n[harness] 自测完成");
// 立即退出，避免 keep-alive 连接让 server.close 挂起
process.exit(0);
