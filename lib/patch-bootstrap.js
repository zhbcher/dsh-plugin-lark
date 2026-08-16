/**
 * feishu-bot-bootstrap 补丁模块（按补丁独立幂等）
 *
 * 修复工具在现行飞书控制台下的问题：
 *  P1 typeIntoField 的 XPath 启发式把「更新说明」误定位为禁用复选框 → 文本域优先、输入框排除禁用
 *  P2 创建版本默认是「正式版」（需发布审批）→ 选择「测试版本」（官方规则：测试版无需发布，自动生效）
 *  P3 「创建或打开应用」后 workspace 就绪检测 30s 超时（网络慢时误报）→ 延长到 60s + 失败落盘页面文本
 *
 * 补丁以幂等方式应用到 npx 缓存中的包；每处带 PATCHED-BY-DSH-PLUGIN 标记，重复应用安全。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 在 npx 缓存中定位 feishu-bot-bootstrap 包目录 */
export function findBootstrapPkg() {
  const npxRoot = join(homedir(), ".npm", "_npx");
  try {
    for (const d of readdirSync(npxRoot)) {
      const pkg = join(npxRoot, d, "node_modules", "feishu-bot-bootstrap");
      if (existsSync(join(pkg, "dist", "flow.js"))) return pkg;
    }
  } catch { /* ignore */ }
  return null;
}

/** 确保包已下载（未缓存时跑 npx --help 触发下载） */
export function ensureBootstrapDownloaded() {
  if (findBootstrapPkg()) return;
  try {
    execFileSync("npx", ["--yes", "feishu-bot-bootstrap", "--help"], { timeout: 180000, stdio: "ignore" });
  } catch { /* ignore */ }
}

// ── P1: typeIntoField 定位候选 ────────────────────────────────────────────
// 统一 XPath：标签后第一个「未禁用的 input 或 textarea」。
//  - 创建应用弹窗「应用名称」→ 名称 input
//  - 创建版本弹窗「更新说明」→ 更新说明 textarea（跳过其前的 disabled 复选框）
// 注：早期补丁用「textarea 优先」会把「应用名称」填进描述框（名称留空导致创建被禁用），已废弃。
const P1_UNIFIED_XPATH = "following::*[self::input or self::textarea][not(@disabled)][1]";
const P1_MARK = P1_UNIFIED_XPATH;
// 原始版（input 优先）与上一版补丁（textarea 优先）都替换为统一 XPath
const P1_OLD_VARIANTS = [
  "        root\n" +
  "            .locator(`xpath=.//*[contains(normalize-space(.), \"${label}\")]/following::input[1]`)\n" +
  "            .first(),\n" +
  "        root\n" +
  "            .locator(`xpath=.//*[contains(normalize-space(.), \"${label}\")]/following::textarea[1]`)\n" +
  "            .first(),",
  "        root\n" +
  "            .locator(`xpath=.//*[contains(normalize-space(.), \"${label}\")]/following::textarea[1]`)\n" +
  "            .first(),\n" +
  "        root\n" +
  "            .locator(`xpath=.//*[contains(normalize-space(.), \"${label}\")]/following::input[1][not(@disabled)]`)\n" +
  "            .first(),",
];
const P1_NEW =
  "        root\n" +
  "            .locator(`xpath=.//*[contains(normalize-space(.), \"${label}\")]/following::*[self::input or self::textarea][not(@disabled)][1]`)\n" +
  "            .first(),";

// ── P2: 创建版本弹窗选择「测试版本」──────────────────────────────────────────
const P2_MARK = "PATCHED-BY-DSH-PLUGIN: 选择「测试版本」类型";
const P2_ANCHOR =
  "    await createVersionButton.click({ timeout: spec.timeouts.actionMs });\n" +
  "    await typeIntoField(page, \"应用版本号\", spec.publish.version, spec.timeouts.actionMs, locale);";
const P2_NEW =
  "    await createVersionButton.click({ timeout: spec.timeouts.actionMs });\n" +
  "    // PATCHED-BY-DSH-PLUGIN: 选择「测试版本」类型 —— 官方规则：测试版无需发布/审批，保存后自动生效\n" +
  "    const testVersionSelectors = [\n" +
  "        page.getByText(\"测试版本\", { exact: true }),\n" +
  "        page.getByText(\"测试版\", { exact: true }),\n" +
  "        page.getByLabel(\"测试版本\"),\n" +
  "        page.getByRole(\"radio\", { name: /测试/ }),\n" +
  "        page.locator('input[type=\"radio\"][value=\"test\"]'),\n" +
  "        page.locator('label:has-text(\"测试版本\") input[type=\"radio\"]'),\n" +
  "    ];\n" +
  "    const testVersion = await findFirstVisible(testVersionSelectors, 5_000).catch(() => null);\n" +
  "    if (testVersion) {\n" +
  "        await testVersion.click({ timeout: 5_000 }).catch(() => { });\n" +
  "    } else {\n" +
  "        try {\n" +
  "            const text = await page.evaluate(() => {\n" +
  "                const dlg = document.querySelector('[role=\"dialog\"], .ud__dialog__wrap');\n" +
  "                return (dlg ?? document.body).innerText;\n" +
  "            });\n" +
  "            await fs.mkdir(spec.output.artifactsDir, { recursive: true });\n" +
  "            await fs.writeFile(spec.output.artifactsDir + '/create-version-dialog.txt', text);\n" +
  "        } catch (e) { /* 诊断文件写失败忽略 */ }\n" +
  "    }\n" +
  "    await typeIntoField(page, \"应用版本号\", spec.publish.version, spec.timeouts.actionMs, locale);";

// ── P3: workspace 就绪检测延长 + 失败落盘页面文本 ──────────────────────────
const P3_MARK = "PATCHED-BY-DSH-PLUGIN: 延长等待时间";
const P3_OLD =
  "async function waitForAppWorkspaceReady(page, timeoutMs) {\n" +
  "    const ready = await findFirstVisible(APP_WORKSPACE_LABELS.map((label) => page.getByText(label, { exact: true })), timeoutMs);\n" +
  "    if (!ready) {\n" +
  "        throw new Error(\"App workspace did not finish loading.\");\n" +
  "    }\n" +
  "}";
const P3_NEW =
  "async function waitForAppWorkspaceReady(page, spec, timeoutMs) {\n" +
  "    // PATCHED-BY-DSH-PLUGIN: 延长等待时间 + 失败时把页面文本写入 artifacts 便于诊断\n" +
  "    const ready = await findFirstVisible(APP_WORKSPACE_LABELS.map((label) => page.getByText(label, { exact: true })), Math.max(timeoutMs, 60_000)).catch(() => null);\n" +
  "    if (ready) return;\n" +
  "    try {\n" +
  "        const text = await page.evaluate(() => document.body.innerText);\n" +
  "        await fs.mkdir(spec.output.artifactsDir, { recursive: true });\n" +
  "        await fs.writeFile(spec.output.artifactsDir + '/workspace-fail.txt', String(text).slice(0, 20000));\n" +
  "    } catch (e) { /* 诊断文件写失败忽略 */ }\n" +
  "    throw new Error(\"App workspace did not finish loading.\");\n" +
  "}";
const P3_CALL_OLD = "await waitForAppWorkspaceReady(page, spec.timeouts.actionMs);";
const P3_CALL_NEW = "await waitForAppWorkspaceReady(page, spec, spec.timeouts.actionMs);";

/** 对 dist/flow.js 应用全部补丁（各自幂等）。返回 { ok, applied: string[], error? } */
export function patchBootstrap() {
  ensureBootstrapDownloaded();
  const pkg = findBootstrapPkg();
  if (!pkg) return { ok: false, error: "找不到 feishu-bot-bootstrap 包（npx 缓存）" };
  const flowPath = join(pkg, "dist", "flow.js");
  let src;
  try {
    src = readFileSync(flowPath, "utf8");
  } catch (e) {
    return { ok: false, error: `读取失败: ${e.message}` };
  }

  const applied = [];
  const failures = [];

  const apply = (mark, oldText, newText, id) => {
    if (src.includes(mark)) return; // 已应用
    if (!src.includes(oldText)) {
      failures.push(`${id}: 源码结构与预期不符`);
      return;
    }
    src = src.replace(oldText, newText);
    applied.push(id);
  };

  // P1：统一 XPath（兼容原始版与上一版补丁两种现状）
  if (!src.includes(P1_MARK)) {
    const variant = P1_OLD_VARIANTS.find((v) => src.includes(v));
    if (!variant) {
      failures.push("P1: 源码结构与预期不符");
    } else {
      src = src.replace(variant, P1_NEW);
      applied.push("P1");
    }
  }
  apply(P2_MARK, P2_ANCHOR, P2_NEW, "P2");
  // P3 需要两处替换：函数体 + 两处调用点
  if (!src.includes(P3_MARK)) {
    if (!src.includes(P3_OLD)) {
      failures.push("P3: 函数体与预期不符");
    } else {
      src = src.replace(P3_OLD, P3_NEW);
      if (src.includes(P3_CALL_OLD)) src = src.split(P3_CALL_OLD).join(P3_CALL_NEW);
      applied.push("P3");
    }
  }

  if (applied.length === 0 && failures.length === 0) {
    return { ok: true, patched: false, path: flowPath, applied: [] };
  }
  if (failures.length > 0) {
    return { ok: false, error: failures.join("; ") };
  }
  try {
    writeFileSync(flowPath, src);
    return { ok: true, patched: true, path: flowPath, applied };
  } catch (e) {
    return { ok: false, error: `写入失败: ${e.message}` };
  }
}
