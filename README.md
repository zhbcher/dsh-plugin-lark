# dsh-plugin-lark — DeepSeek Harness 飞书接入插件（薄架构）

在 DSH Web 界面（设置 → 插件 →「飞书接入」标签页）提供**扫码新建机器人 + 扫码授权 + 监听器管理**，
不再需要手动敲 lark-cli 命令，也不用去开放平台手动配置。

## 两大能力

1. **新建飞书机器人（推荐）**：面板点「新建机器人」→ 手机扫码登录开放平台 →
   工具自动完成 创建应用 → 开机器人能力 → 导入权限 → 订阅消息事件 → 发布版本 →
   约 30-60 秒拿到新机器人凭证并自动写入 lark-cli → **自动启动监听器** → 直接可用（一次扫码即连接）。
   底层用 [feishu-bot-bootstrap](https://www.npmjs.com/package/feishu-bot-bootstrap)（headless + events-jsonl 事件流）。
2. **用户身份授权（可选）**：需要以个人身份访问日历/文档/邮件等资源时再扫码授权（lark-cli 设备流）。

## 安装（npm）

```bash
npm install -g dsh-plugin-lark   # 或按 dsh 插件方式
dsh plugin --profile web add dsh-plugin-lark
```

依赖：`lark-cli`（PATH 中可用）、`dsh`、Chrome/Edge（扫码新建机器人用）、飞书开放平台账号。

环境变量（均可覆盖，默认已通用化）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `LARK_BRIDGE_DIR` | `~/.dsh/lark-bridge` | 网关目录（内含 `lark_bridge.py` + `manage_lark_bridge.sh`，随包自带） |
| `DSH_WORK_DIR` | `~` | 任务工作目录（网关侧） |
| `LARK_CLI_BIN` | `lark-cli`(PATH) | lark-cli 路径 |
| `LARK_BOT_NAME` | `DeepSeek Harness 助手` | 新建机器人的应用名 |

---
## 架构（薄插件设计）

```
DSH Web 面板（本插件前端）
   │ fetch /api/lark/*
   ▼
本插件服务端（跑在 dsh web 进程内）
   │ ① feishu-bot-bootstrap（扫码新建机器人，进度/二维码来自 events.jsonl）
   │ ② lark-cli 设备流（auth login --no-wait → auth qrcode → --device-code 轮询）
   │ ③ 启停/状态/日志 转发
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
| `POST /bot/create` | 启动「扫码新建机器人」（feishu-bot-bootstrap headless） |
| `GET /bot/create/status` | 新建流程状态（二维码 URL、步骤进度、结果、错误） |
| `GET /bot/create/qr.png` | 新建流程的登录二维码（PNG） |
| `POST /bot/create/cancel` | 取消新建流程 |
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
| `LARK_CONNECTOR_STATE` | `~/.dsh/lark-connector` | 状态目录（二维码、bootstrap 运行目录） |
| `LARK_BRIDGE_DIR` | `/Users/zhoubo/GP/lark-bridge` | 网关目录 |
| `LARK_BOT_NAME` | `DeepSeek Harness 助手` | 新建机器人的应用名 |

## 自测

```bash
node test/harness.mjs   # 不启动 Web，实测全部 API（会真实启动 bootstrap 生成二维码后取消）
```

## 排障

- 面板不出现 → 确认重启了 dsh web、浏览器刷新（插件集变更需重启生效）
- 新建机器人卡在"正在启动浏览器" → 需本机有 Chrome/Edge；首次运行 npx 会下载依赖，耐心等
- 二维码不显示 → `GET /api/lark/bot/create/status` 看 `qrUrl`；`~/.dsh/lark-connector/bootstrap-qr.png`
- 新建成功后消息不回复 → 新机器人接管需**重启监听器**（面板「停止监听」再「启动监听」），
  因为运行中的旧监听还连着旧应用
- 授权后仍「未授权」→ 检查 `lark-cli auth status`，user identity 是否 ready
- 消息不回复 → 看「监听器」是否运行中；`GET /api/lark/listener/logs`
- ⚠️ 不要同时跑两个 `lark-cli config init`——会互相占配置锁导致命令卡住
