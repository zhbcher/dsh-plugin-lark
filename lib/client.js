/**
 * dsh-plugin-lark — 客户端面板 bundle（手写 ModuleLoader 格式，无需官方构建）
 *
 * 在设置 → 插件 区域注册「飞书接入」标签页：
 *   - 状态总览（应用 / 授权 / 监听器 / 工作目录）
 *   - 扫码授权（二维码 + 轮询）
 *   - 监听器启停 + 日志
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-lark",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");

    // ── 小工具 ────────────────────────────────────────────────────────────
    function api(path, opts) {
      return fetch(path, opts).then(function (r) {
        return r.json().catch(function () { return { ok: false, error: "响应解析失败" }; });
      });
    }
    function fmt(obj) {
      try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
    }

    // ── 样式（沿用 DSH CSS 变量）──────────────────────────────────────────
    var s = {
      section: { width: "100%", maxWidth: 760, color: "var(--dsw-alias-label-primary)", flexDirection: "column", gap: 14, display: "flex" },
      card: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 },
      h2: { fontSize: 14, fontWeight: 600, lineHeight: "20px", margin: 0 },
      row: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
      label: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)", lineHeight: "18px", margin: 0 },
      value: { fontSize: 13, lineHeight: "18px", margin: 0 },
      btn: {
        border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)",
        font: "inherit", cursor: "pointer", background: "var(--dsw-alias-bg-layer-1)",
        borderRadius: 8, padding: "6px 14px", fontSize: 13,
      },
      btnPrimary: { border: "none", color: "#fff", background: "var(--dsw-alias-state-business-primary)", cursor: "pointer", font: "inherit", borderRadius: 8, padding: "6px 14px", fontSize: 13 },
      btnDanger: { border: "1px solid var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-state-error-primary)", background: "transparent", cursor: "pointer", font: "inherit", borderRadius: 8, padding: "6px 14px", fontSize: 13 },
      qr: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, width: 220, height: 220, imageRendering: "pixelated" },
      pre: { background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: 10, fontSize: 12, lineHeight: "17px", fontFamily: "var(--ds-font-family-code)", whiteSpace: "pre-wrap", overflow: "auto", maxHeight: 320, margin: 0, color: "var(--dsw-alias-label-secondary)" },
      error: { color: "var(--dsw-alias-state-error-primary)", fontSize: 13, lineHeight: "18px", margin: 0 },
      ok: { color: "var(--dsw-alias-state-success-primary)", fontSize: 13, lineHeight: "18px", margin: 0 },
      hint: { fontSize: 12, lineHeight: "17px", color: "var(--dsw-alias-label-tertiary)", margin: 0 },
      grid: { display: "grid", gridTemplateColumns: "96px minmax(0,1fr)", gap: "6px 10px", fontSize: 13 },
    };
    function gridRow(k, v) {
      return react.createElement(react.Fragment, { key: k },
        react.createElement("dt", { style: s.label }, k),
        react.createElement("dd", { style: { margin: 0, color: "var(--dsw-alias-label-secondary)", overflowWrap: "anywhere" } }, v));
    }

    // ── 主面板 ────────────────────────────────────────────────────────────
    var LarkConnectorPanel = function () {
      var state = react.useState({ loading: true, status: null, error: null });
      var status = state[0], setStatus = state[1];
      var auth = react.useState({ phase: "idle", qrUrl: null, verificationUrl: null, error: null });
      var authState = auth[0], setAuthState = auth[1];
      var logs = react.useState({ text: "", error: null });
      var logState = logs[0], setLogState = logs[1];
      var create = react.useState({ phase: "idle", qrUrl: null, steps: [], logs: "", result: null, error: null });
      var createState = create[0], setCreateState = create[1];
      var bind = react.useState({ appId: "", appSecret: "", busy: false, message: null, error: null });
      var bindState = bind[0], setBindState = bind[1];

      var refresh = react.useCallback(function () {
        setStatus({ loading: true, status: null, error: null });
        api("/api/lark/status").then(function (d) {
          setStatus({ loading: false, status: d, error: d.ok ? null : (d.error || "未知错误") });
        }).catch(function (e) { setStatus({ loading: false, status: null, error: String(e) }); });
      }, []);

      react.useEffect(function () { refresh(); }, [refresh]);

      // 授权轮询：phase==="qr" 时每 2s 查一次
      react.useEffect(function () {
        if (authState.phase !== "qr") return;
        var timer = setInterval(function () {
          api("/api/lark/auth/status").then(function (d) {
            if (d.phase === "done") {
              setAuthState(function (a) { return Object.assign({}, a, { phase: "done", error: d.ok ? null : (d.result?.err || "授权未完成") }); });
              refresh();
              // 授权成功后服务端会自动启动监听器，稍等片刻再刷新一次以显示运行状态
              setTimeout(function () { refresh(); }, 4000);
            } else if (d.phase === "idle") {
              setAuthState(function (a) { return Object.assign({}, a, { phase: "idle" }); });
            }
          }).catch(function () { /* 网络抖动忽略 */ });
        }, 2000);
        return function () { clearInterval(timer); };
      }, [authState.phase, refresh]);

      var startAuth = react.useCallback(function () {
        setAuthState({ phase: "qr", qrUrl: null, verificationUrl: null, error: null });
        api("/api/lark/auth/start", { method: "POST" }).then(function (d) {
          if (!d.ok) { setAuthState({ phase: "idle", qrUrl: null, verificationUrl: null, error: d.error || "启动授权失败" }); return; }
          setAuthState({ phase: "qr", qrUrl: d.qrUrl, verificationUrl: d.verificationUrl, error: null });
        }).catch(function (e) { setAuthState({ phase: "idle", qrUrl: null, verificationUrl: null, error: String(e) }); });
      }, []);

      var cancelAuth = react.useCallback(function () {
        api("/api/lark/auth/cancel", { method: "POST" }).then(function () {
          setAuthState({ phase: "idle", qrUrl: null, verificationUrl: null, error: null });
        });
      }, []);

      var listenerAction = react.useCallback(function (action) {
        api("/api/lark/listener/" + action, { method: "POST" }).then(function (d) {
          setStatus(function (prev) { return Object.assign({}, prev, { lastAction: action + " → " + (d.output || "") }); });
          refresh();
        }).catch(function (e) { setStatus({ loading: false, status: null, error: String(e) }); });
      }, [refresh]);

      var startCreate = react.useCallback(function () {
        setCreateState({ phase: "running", qrUrl: null, steps: [], logs: "", result: null, error: null });
        api("/api/lark/bot/create", { method: "POST" }).then(function (d) {
          if (!d.ok && d.message) {
            setCreateState({ phase: "idle", qrUrl: null, steps: [], logs: "", result: null, error: d.message });
          }
        }).catch(function (e) {
          setCreateState({ phase: "idle", qrUrl: null, steps: [], logs: "", result: null, error: String(e) });
        });
      }, []);

      var cancelCreate = react.useCallback(function () {
        api("/api/lark/bot/create/cancel", { method: "POST" }).then(function () {
          setCreateState({ phase: "idle", qrUrl: null, steps: [], logs: "", result: null, error: null });
        });
      }, []);

      var doBind = react.useCallback(function () {
        setBindState(function (b) { return Object.assign({}, b, { busy: true, message: null, error: null }); });
        api("/api/lark/config/bind", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ appId: bindState.appId.trim(), appSecret: bindState.appSecret.trim() }),
        }).then(function (d) {
          setBindState(function (b) {
            return Object.assign({}, b, {
              busy: false,
              message: d.ok ? "绑定成功 ✓ 应用已切换，可扫码授权" : null,
              error: d.ok ? null : (d.error || "绑定失败"),
              appId: d.ok ? "" : b.appId,
              appSecret: d.ok ? "" : b.appSecret,
            });
          });
          refresh();
        }).catch(function (e) {
          setBindState(function (b) { return Object.assign({}, b, { busy: false, error: String(e) }); });
        });
      }, [bindState.appId, bindState.appSecret, refresh]);

      // 新建机器人轮询：phase==="running" 时每 2s 拉取二维码/进度/结果
      react.useEffect(function () {
        if (createState.phase !== "running") return;
        var timer = setInterval(function () {
          api("/api/lark/bot/create/status").then(function (d) {
            if (!d.ok) return;
            setCreateState(function (c) {
              var next = Object.assign({}, c, { qrUrl: d.qrUrl || c.qrUrl, steps: d.steps || c.steps, logs: d.logs || c.logs });
              if (d.phase === "done") {
                next.phase = "done";
                next.error = d.error || null;
                if (d.result) next.result = d.result;
                else if (!next.error) next.error = "创建未完成，请重试";
              }
              return next;
            });
          }).catch(function () { /* 网络抖动忽略 */ });
        }, 2000);
        return function () { clearInterval(timer); };
      }, [createState.phase]);

      // 新机器人创建成功后，自动衔接扫码授权（针对新应用）
      react.useEffect(function () {
        if (createState.phase === "done" && createState.result && !createState.error) {
          startAuth();
        }
      }, [createState.phase, createState.result, createState.error, startAuth]);

      var loadLogs = react.useCallback(function () {
        api("/api/lark/listener/logs?lines=100").then(function (d) {
          setLogState({ text: d.ok ? d.log : "", error: d.ok ? null : (d.error || "读取日志失败") });
        }).catch(function (e) { setLogState({ text: "", error: String(e) }); });
      }, []);

      var st = status.status;
      var userReady = st?.auth?.user?.status === "ready";
      var botReady = st?.auth?.bot?.status === "ready";
      var listenerRunning = st?.listener?.running;

      return react.createElement("div", { style: s.section },
        // 标题
        react.createElement("h2", { style: s.h2 }, "飞书接入"),

        // 状态卡
        react.createElement("div", { style: s.card },
          react.createElement("h3", { style: s.h2 }, "状态总览"),
          status.loading ? react.createElement("p", { style: s.label }, "加载中…") :
          status.error ? react.createElement("p", { style: s.error }, "加载失败：" + status.error) :
          react.createElement("dl", { style: s.grid },
            gridRow("应用 AppID", st.auth.appId || "—"),
            gridRow("机器人 (bot)", botReady ? "就绪 ✓" : "未就绪"),
            gridRow("用户授权 (user)", userReady ? "已授权 ✓" : "未授权（请扫码连接）"),
            gridRow("监听器", (listenerRunning ? "运行中" : "未运行") + (st.listener.pid ? " (PID " + st.listener.pid + ")" : "") + (st.listener.launchd ? " [launchd]" : "")),
            gridRow("任务工作目录", st.workDir || "—")),
          status.lastAction ? react.createElement("p", { style: s.hint }, status.lastAction) : null,
          react.createElement("div", { style: s.row },
            react.createElement("button", { style: s.btn, onClick: refresh }, "刷新状态"))),

        // 授权卡
        react.createElement("div", { style: s.card },
          react.createElement("h3", { style: s.h2 }, "扫码连接飞书"),
          authState.phase === "idle" ?
            react.createElement("div", { style: s.row },
              react.createElement("button", { style: s.btnPrimary, onClick: startAuth }, "扫码连接"),
              authState.error ? react.createElement("p", { style: s.error }, authState.error) : null) :
          authState.phase === "qr" ?
            react.createElement("div", { style: s.row },
              authState.qrUrl ?
                react.createElement("img", { style: s.qr, src: authState.qrUrl, alt: "飞书扫码授权" }) :
                react.createElement("p", { style: s.label }, "正在生成二维码…"),
              react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
                react.createElement("p", { style: s.label }, "用手机飞书扫一扫，完成授权"),
                authState.verificationUrl ?
                  react.createElement("a", { style: { fontSize: 12, color: "var(--dsw-alias-state-business-primary)", overflowWrap: "anywhere" }, href: authState.verificationUrl, target: "_blank", rel: "noreferrer" }, authState.verificationUrl) : null,
                react.createElement("p", { style: s.hint }, "等待扫码…（每 2 秒自动检测，无需手动刷新）"),
                react.createElement("button", { style: s.btnDanger, onClick: cancelAuth }, "取消"))) :
          react.createElement("div", { style: s.row },
            authState.error ?
              react.createElement("p", { style: s.error }, "授权失败：" + authState.error) :
              react.createElement("p", { style: s.ok }, "授权成功 ✓ 监听器已自动启动，飞书已连接"),
            react.createElement("button", { style: s.btn, onClick: refresh }, "刷新状态"))),

        // 新建机器人卡
        react.createElement("div", { style: s.card },
          react.createElement("h3", { style: s.h2 }, "新建飞书机器人"),
          react.createElement("p", { style: s.label },
            "自动完成：创建应用 → 开启机器人 → 配置权限 → 订阅消息事件 → 发布版本。扫一次码，约 30-60 秒新机器人即可用。"),
          createState.phase === "idle" ?
            react.createElement("div", { style: s.row },
              react.createElement("button", { style: s.btnPrimary, onClick: startCreate }, "新建机器人"),
              createState.error ? react.createElement("p", { style: s.error }, createState.error) : null) :
          createState.phase === "running" ?
            react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
              createState.qrUrl ?
                react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" } },
                  react.createElement("img", { style: s.qr, src: createState.qrUrl, alt: "飞书开放平台登录二维码" }),
                  react.createElement("p", { style: s.hint }, "用手机飞书「扫一扫」登录开放平台，之后的创建、权限、订阅全部自动完成（约 30-60 秒）")) :
                react.createElement("p", { style: s.label }, "正在启动浏览器并生成登录二维码…"),
              createState.steps && createState.steps.length > 0 ?
                react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
                  createState.steps.map(function (st, i) {
                    var done = st.status === "succeeded" || st.status === "completed";
                    var running = st.status === "running" || st.status === "active";
                    return react.createElement("p", { key: i, style: Object.assign({}, s.hint, { color: done ? "var(--dsw-alias-state-success-primary)" : running ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-label-tertiary)" }) },
                      (done ? "✓ " : running ? "… " : "· ") + st.title);
                  })) : null,
              react.createElement("button", { style: s.btnDanger, onClick: cancelCreate }, "取消")) :
          react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
            createState.error ?
              react.createElement("p", { style: s.error }, "创建失败：" + createState.error) :
              react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                react.createElement("p", { style: s.ok }, "新机器人已创建 ✓"),
                react.createElement("p", { style: s.label }, (createState.result?.appName || "") + " · AppID " + (createState.result?.appId || "")),
                react.createElement("p", { style: s.hint }, "已写入配置，正在自动进入下方扫码授权…"),
                react.createElement("p", { style: s.ok },
                  "✅ 已创建「测试版本」（免发布免审批，自动生效）。可直接点下方「启动监听」开始使用。"))),
          createState.logs && createState.phase !== "idle" ?
            react.createElement("details", { style: { marginTop: 2 } },
              react.createElement("summary", { style: s.hint }, "查看过程日志"),
              react.createElement("pre", { style: Object.assign({}, s.pre, { maxHeight: 180 }) }, createState.logs)) : null),

        // 手动绑定凭证卡（兜底）
        react.createElement("div", { style: s.card },
          react.createElement("h3", { style: s.h2 }, "手动绑定凭证（兜底）"),
          react.createElement("p", { style: s.label },
            "自动流程失败时使用：在开放平台「凭证与基础信息」复制 App ID / App Secret 粘贴到这里。"),
          react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
            react.createElement("input", {
              style: Object.assign({}, s.pre, { width: "100%", boxSizing: "border-box", height: 34 }),
              placeholder: "App ID（cli_ 开头）",
              value: bindState.appId,
              onChange: function (e) { setBindState(function (b) { return Object.assign({}, b, { appId: e.target.value }); }); },
            }),
            react.createElement("input", {
              style: Object.assign({}, s.pre, { width: "100%", boxSizing: "border-box", height: 34 }),
              placeholder: "App Secret",
              type: "password",
              value: bindState.appSecret,
              onChange: function (e) { setBindState(function (b) { return Object.assign({}, b, { appSecret: e.target.value }); }); },
            }),
            react.createElement("div", { style: s.row },
              react.createElement("button", { style: s.btnPrimary, disabled: bindState.busy, onClick: doBind },
                bindState.busy ? "绑定中…" : "绑定"),
              bindState.message ? react.createElement("p", { style: s.ok }, bindState.message) : null,
              bindState.error ? react.createElement("p", { style: s.error }, bindState.error) : null))),

        // 监听器卡
        react.createElement("div", { style: s.card },
          react.createElement("h3", { style: s.h2 }, "飞书消息监听器"),
          react.createElement("p", { style: s.label },
            "负责接收飞书消息并转给 DeepSeek Harness 执行（独立网关进程 lark_bridge.py，与插件解耦）。"),
          react.createElement("div", { style: s.row },
            react.createElement("button", { style: s.btnPrimary, onClick: function () { listenerAction("start"); } }, "启动监听"),
            react.createElement("button", { style: s.btn, onClick: function () { listenerAction("stop"); } }, "停止监听"),
            react.createElement("button", { style: s.btn, onClick: loadLogs }, "查看日志"))),

        // 日志卡
        logState.text || logState.error ?
          react.createElement("div", { style: s.card },
            react.createElement("h3", { style: s.h2 }, "网关日志"),
            logState.error ? react.createElement("p", { style: s.error }, logState.error) :
              react.createElement("pre", { style: s.pre }, logState.text)) : null);
    };

    // ── 插件协议 ──────────────────────────────────────────────────────────
    var NS = "settings.larkConnector";
    var inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("settings.plugins.tab", function () {
        return ctx.slots.register({
          name: "settings.plugins.tab",
          id: "lark-connector",
          order: 20,
          label: function () { return "飞书接入"; },
          locale: NS,
          inject: function () { return {}; },
        }, LarkConnectorPanel);
      });
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
