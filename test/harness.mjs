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
  const r = await fetch(base + path, { method });
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
// 3. 发起扫码授权（真实调用 lark-cli，生成二维码 + 后台轮询）
const start = await call("POST", "/api/lark/auth/start");
// 4. 二维码图片
await call("GET", "/api/lark/auth/qr.png");
// 5. 授权轮询状态（应为 pending）
await call("GET", "/api/lark/auth/status");
// 6. 监听器日志（现有网关日志）
await call("GET", "/api/lark/listener/logs?lines=20");
// 7. 取消授权（清理后台轮询）
await call("POST", "/api/lark/auth/cancel");
// 8. 未知路由
await call("GET", "/api/lark/nope");

server.close();
console.log("\n[harness] 自测完成");
