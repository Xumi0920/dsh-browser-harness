# 架构说明

源码用 **TypeScript** 编写，`tsc` 构建到 `dist/` 后由 DSH 加载；运行时零第三方依赖。

DSH Browser Harness 分四层：**DSH 插件层 → 零依赖核心 → CDP → 专用浏览器**，外加一个只在标签组场景使用的 **MV3 扩展桥**。

```
DSH 会话 / Creator 模式
        │  browser_* 工具调用
┌───────▼────────────────────────────────────────────┐
│ lib/  DSH 插件层                                    │
│  index.js   注册 9 个工具 + 内嵌 skill（读 skills/） │
│  tools.js   参数/输出/错误适配                       │
│  manager.js 会话 lane、连接复用、tab 委派            │
│  skill.js   从 skills/browser-harness/SKILL.md 读技能│
└───────┬────────────────────────────────────────────┘
        │
┌───────▼────────────────────────────────────────────┐
│ src/  零依赖核心（Node 22+ 内置能力）                │
│  browser.ts   连接、target 列表、每 target 一个 Page│
│  page.ts      CDP Page 操作、快照、网络、下载/上传  │
│  ax.ts        无障碍树 → 紧凑 refs                  │
│  state.ts     每 lane 的 current tab / owned / group│
│  cdp/          endpoint 发现 + WebSocket 传输        │
│  tabgroups.ts 标签组桥（见下）                      │
└───────┬────────────────────────────────────────────┘
        │ CDP over WebSocket
┌───────▼────────────────────────────────────────────┐
│ 专用 Chromium 浏览器（Chrome/Chromium/Edge/Brave/…） │
│  └─ chrome-extension://<id>/…  标签组 MV3 扩展        │
└────────────────────────────────────────────────────┘
```

## 关键流程

### 1. 连接与 endpoint 发现（`src/cdp/endpoint.ts`）
解析顺序：显式 `ws` → 显式 `cdpUrl` → 环境变量（`BH_WS`/`BH_CDP_URL`/`BH_BROWSER`）→ 浏览器选择器 → registry 默认 / auto。auto 先按配置实例顺序探测，全不通时并行回退其它已知 Chromium 端口与标准 9222/9223。**只探测，不启动/杀死/重配浏览器。**

### 2. 工具调用（`lib/tools.ts` → `lib/manager.ts` → `src/`）
- 每个 DSH 会话一个 lane（`dsh-<session>`），lane 显式传给核心，不存在共享可变指针；
- 一个 target 只保留一个 Page（CDP session），关闭/失联时 detach 释放；
- 快照 ref 单调递增，旧 ref 报 `E_ELEMENT_NOT_FOUND`，不会静默重映射到别的元素；
- 当前标签页、自建标签页、任务标签组 id 持久化在 `~/.dsh/browser-harness/state-<lane>.json`（原子写 + lane 锁）。

### 3. 按任务标签组（`src/tabgroups.ts` + `extension/`）
CDP 没有标签组 API，因此随包带一个极小 MV3 扩展（仅 `tabs` / `tabGroups` 权限，无 content script / host 权限）：

1. 首次使用时通过 CDP `Extensions.loadUnpacked` 把 `extension/` 装进专用浏览器 profile；
2. 打开新标签页会唤醒扩展的 service worker，harness 附着该 worker 会话；
3. 给**刚创建的标签页**临时设置一个 nonce 标题，让 worker 用 `chrome.tabs.query({title})` 精确定位这一页；
4. 调 `chrome.tabs.group` / `chrome.tabGroups.update` 建组或加组，然后恢复原标题。

边界：只操作 harness 自己新建的标签页；工作标签页不动、不入组；空组由 Chrome 自动移除；headless 浏览器没有标签组 → 自动跳过；扩展不可用时 60s 冷却，不影响开标签页。

## 错误模型

所有核心错误是带稳定 `code` 的 `HarnessError`（`src/errors.ts`），工具层统一渲染为 `E_*: message`：`E_NO_BROWSER`、`E_NO_TAB`、`E_ELEMENT_NOT_FOUND`、`E_SELECTOR_TIMEOUT`、`E_DIALOG_OPEN`、`E_POLICY_DENIED`、`E_TIMEOUT` 等。

## 安全边界

- 只关闭 harness 自建标签页（`E_POLICY_DENIED` 兜底）；
- 只允许 `http(s)` / `about:blank` 导航与 attach；`file://`、`data:`、`javascript:`、`chrome://` 一律 `E_POLICY_DENIED`（防止绕过 DSH 文件策略）；`browser_tabs use` 非自建页必须精确 targetId，URL 子串只匹配自建页；
- 截图/PDF 只写 `screenshotDir`（默认 `<stateDir>/screenshots`）：mkdir 前校验最近已存在祖先、拒绝 symlink/junction 路径，realpath 失败即拒绝，并拒绝覆盖已有文件；元素截图使用 ref/selector 的 box-model clip；
- `browser_act fill` 只返回长度/校验状态，不回显输入值；
- Cookie API 默认脱敏；network/status/tabs 的 URL 与响应 headers 对 token 类字段尽力脱敏：参数名归一化（accessToken/access-token/ACCESS_TOKEN…）、`Location`/`Content-Location` 整值隐藏、URL userinfo 清除；
- `browser_status` 端点诊断使用字段白名单（不返回完整 `httpUrl`/`wsUrl`）；连接错误只保留稳定错误码和安全提示，不拼接原始 CDP URL/cause；页面正文/HTML/截图仍可能敏感；
- 状态文件只保存去掉 userinfo/query/fragment 的 URL（POSIX 0600）；
- `browser_extract` 的 `network` / `js` / `console` 只在显式请求时返回；JS 模式可产生副作用，工具标记为非并发；console 文本只做 URL 级尽力脱敏；
- `browser_wait` 是轮询工具；`browser_act` 的 hover/dialog 与 `browser_navigate` 历史导航都走同一 Page，不引入额外后台进程；
- 宽泛 CDP 端口回退（含 9222/9223）只在显式 `browser: "auto"` / `BH_ALLOW_FALLBACK=1` 时启用；
- 全部后台操作，不抢前台；遇登录墙停手问人；
- 标签组扩展权限最小化，只存在于专用浏览器 profile。

## 测试策略

- **单测**（`tests/unit`）：CDP 传输/endpoint/state/AX/工具层/标签组桥，使用 scripted fake transport/websocket，不需要浏览器；
- **集成场景**（`tests/integration`）：真实 headless/headful Chromium + 本地 fixture 站，覆盖 14 条浏览器场景、工具层/CLI/兼容性场景、标签组场景；Linux CI 用 xvfb 跑 headful 标签组；
- 计数与命令见 [README](../README.md) 的测试小节。