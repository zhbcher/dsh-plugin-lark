# dsh-plugin-lark — DeepSeek Harness 飞书接入插件（薄架构）

在 DSH Web 界面（设置 → 插件 →「飞书接入」标签页）提供**扫码授权 + 监听器管理**，
不再需要手动敲 lark-cli 命令。

## 架构（薄插件设计）

```
DSH Web 面板（本插件前端）
   │ fetch /api/lark/*
   ▼
本插件服务端（跑在 dsh web 进程内）
   │ 驱动 lark-cli（auth login --no-wait → auth qrcode → --device-code 轮询）
   │ 启停/状态/日志 转发
   ▼
lark_bridge.py（独立网关进程，业务收发全在这）
   │ lark-cli event consume → dsh headless → 回复
   ▼
飞书
```

- 插件只做「授权 + 面板 + 进程管理」，**不做消息收发**，与 DSH 核心解耦 → 升级影响最小
- 消息收发逻辑仍在 `/Users/zhoubo/GP/lark-bridge/lark_bridge.py`，可独立运行/排障

## 文件

| 文件 | 说明 |
|---|---|
| `package.json` | 插件包声明；`dsh.client` 声明前端 bundle |
| `lib/index.js` | 服务端 Cordis 插件：`/api/lark/*` 路由 |
| `lib/client.js` | 前端面板（手写 ModuleLoader bundle 格式） |
| `test/harness.mjs` | 后端自测（mock ctx，不启动 Web） |

## API（服务端，前缀 `/api/lark`）

| 方法/路径 | 说明 |
|---|---|
| `GET /status` | 应用/授权/监听器/工作目录 总状态 |
| `POST /auth/start` | 发起扫码授权，生成二维码（后台自动轮询） |
| `GET /auth/qr.png` | 二维码图片 |
| `GET /auth/status` | 授权轮询状态（idle/pending/done） |
| `POST /auth/cancel` | 取消授权 |
| `POST /listener/start\|stop` | 启停 lark-bridge 网关 |
| `GET /listener/logs?lines=N` | 网关日志 tail |
| `GET /config` | lark-cli 配置（掩码） |

## 装配（已完成的步骤，重启后生效）

1. 源码在 `~/deepseek/dsh-plugin-lark`（= 当前工作区域，便于维护）
2. 软链到 profile：`~/.dsh/profiles/web/node_modules/dsh-plugin-lark → ~/deepseek/dsh-plugin-lark`
3. `~/.dsh/profiles/web/cordis.patch.yml` 增加条目：
   ```yaml
   - insert:
       - id: lark-connector
         name: 'dsh-plugin-lark'
   ```
4. **重启 dsh web**：`dsh web`（或在原终端 Ctrl+C 后重新运行），刷新浏览器
   —— profile 位于 `~/.dsh`，升级 DSH 本体（npx 缓存）不会丢失本插件

## 环境变量（可选覆盖）

| 变量 | 默认 | 说明 |
|---|---|---|
| `LARK_CLI_BIN` | `~/.hermes/node/bin/lark-cli` | lark-cli 路径 |
| `LARK_CONNECTOR_STATE` | `~/.dsh/lark-connector` | 状态目录（二维码等） |
| `LARK_BRIDGE_DIR` | `/Users/zhoubo/GP/lark-bridge` | 网关目录 |

## 自测

```bash
node test/harness.mjs   # 不启动 Web，实测全部 API（会真实调用 lark-cli）
```

## 排障

- 面板不出现 → 确认重启了 dsh web、浏览器刷新（插件集变更需重启生效）
- 二维码不显示 → `GET /api/lark/auth/start` 返回是否 200；看 `~/.dsh/lark-connector/qr.png`
- 授权后仍「未授权」→ 检查 `lark-cli auth status`，user identity 是否 ready
- 消息不回复 → 看「监听器」是否运行中；`GET /api/lark/listener/logs`
