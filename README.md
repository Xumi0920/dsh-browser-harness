# dsh-browser-harness

**简体中文** | [English](README.en.md)

**DeepSeek Harness（DSH）原生浏览器工具。** 零依赖 CDP 内核，把 `browser_*` 工具挂到 DSH 上，直连一个**专用、已登录**的真实 Chrome，并提供带引用编号（e1、e2…）的紧凑无障碍树快照。

```
browser_status      端点 / Chrome 版本 / 标签页 / 当前标签页
browser_navigate    打开 URL，返回页面信息 + 快照
browser_snapshot    紧凑引用（e1…），含角色、名称、视口中心坐标
browser_act         click / type / fill / press / scroll
browser_extract     text / html / JS / network
browser_screenshot  PNG 路径
browser_tabs        list / use / new / close
```

## 为什么不用 Playwright

- **零依赖**：只用 Node 22+ 内置能力（`fetch`、`WebSocket`、`node:test`），不下载浏览器、不需要构建；插件入口仅使用宿主提供的 `@deepseek-ai/dsh-tools` peer。
- **真实登录态**：连用户自己起好的专用 Chrome 实例（默认 `chrome`，端口 9331），登录一次长期有效。
- **文本优先**：无障碍树 + ref 比“截图喂视觉模型”更准更省；截图只是可选补充。
- **场景测试**：74 个单测 + 24 个端到端场景（14 条浏览器场景 + 10 条工具层/CLI 场景，共 98 条；登录、异步渲染、多标签、iframe、Shadow DOM、下载、上传、对话框、表单校验、选择器超时、标签页被关恢复、截图、网络捕获、Cookie），全部跑在真实 headless Chrome + 本地 fixture 站上。

## 环境要求

- DSH `0.2.1-rc.5`（`engines.dsh`）
- Node.js >= 22
- 一个已开启 remote debugging 的**专用** Chrome
- 平台：优先在 Windows 上验证；macOS / Linux 未实测
- 默认 registry 端口：`chrome` = 9331、`edge` = 9332（默认禁用）、`chrome-beta` = 9333；registry 文件在 `~/.dsh/browser-cdp/registry.json`

## 安装（DSH 0.2.1-rc.5）

本插件**未发布到 npm**；npm 上的同名包属于其他项目，与本插件无关。请从本地 clone 目录安装，或直接从 GitHub 仓库安装。

示例路径 `C:\path\to\dsh-browser-harness` 只是占位符，必须换成你本机 clone 的绝对路径（早期文档曾误写成作者本机的绝对路径，已废弃）。

```powershell
# 1) 克隆仓库到本机任意目录（把占位路径换成本机绝对路径）：
git clone https://github.com/Xumi0920/dsh-browser-harness.git C:\path\to\dsh-browser-harness

# 2) 在 DSH 创造模式 / 插件管理器中安装本地目录：
#    target 是 JSON 字符串，路径里的反斜杠需写成两份（JSON 转义）；
#    真实路径是 C:\path\to\dsh-browser-harness，请换成本机 clone 的绝对路径。
#    plugin_manager { action: "install_bundle", target: "C:\\path\\to\\dsh-browser-harness" }

# 3) 或用 CLI（装完重启 DSH）：
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "C:\path\to\dsh-browser-harness"
```

> `plugin_manager` 的每次操作需要 danger-full-access 沙箱或当次批准；其 `target` 支持 npm 包名、git 地址、tarball 和本地绝对目录。

插件是 DSH bundle（`dsh.bundle.patch` → `cordis.patch.yml`），安装后在 profile 级注册 `browser_*` 工具，并内嵌 `browser-harness` 技能。更细的安装、验证与卸载步骤见 [install.md](install.md)。

## 配置目标浏览器

默认读取 `~/.dsh/browser-cdp/registry.json`，附着到默认专用实例（`chrome`，端口 9331）。要改配置，请在 profile patch（`~/.dsh/profiles/desktop/cordis.patch.yml`）里做 **id 定向覆盖**：

```yaml
- id: browser-harness
  name: dsh-browser-harness
  config:
    browser: chrome-beta      # 或 chrome
    # cdpUrl: http://127.0.0.1:9333
    # ws: ws://127.0.0.1:9333/devtools/browser/<id>
    maxSnapshotNodes: 250
    # stateDir: ~/.dsh/browser-harness
    # downloadDir: ~/.dsh/browser-harness/downloads
    # dialogPolicy: auto-dismiss
```

> 注意：**不要**在 profile patch 里再写 `- insert:` 插一行，否则会重复注册；`insert` 是插件包自身 `cordis.patch.yml` 的注册方式。配置项：`browser` 选目标实例；`cdpUrl` / `ws` 直连端点（二选一）；`maxSnapshotNodes` 默认 250（`browser_snapshot` 上限 400）；`stateDir` / `downloadDir` 控制运行状态与下载目录；`dialogPolicy` 默认 `auto-dismiss`。

本插件只**探测**已运行浏览器，绝不启动、杀死或重配用户的浏览器。需要自启时手动起一个专用实例：

```powershell
chrome.exe --remote-debugging-port=9331 "--user-data-dir=$env:USERPROFILE\.dsh\browser-cdp\profiles\chrome"
```

## 独立库 / CLI（不装 DSH 也能用）

```js
import { connect } from "./src/index.mjs";
const bh = await connect({ browser: "chrome" });
const page = await bh.newTab("https://example.com");
console.log(await page.info(), (await page.snapshot()).nodes.length);
await page.click({ selector: "a" });
await page.screenshot({ path: "shot.png" });
await bh.close();
```

```sh
node bin/bh.mjs doctor
node bin/bh.mjs open https://example.com
node bin/bh.mjs snapshot
node bin/bh.mjs close
```

CLI 子命令：`doctor`、`tabs`、`open <url>`、`info`、`snapshot`、`text [selector]`、`js <expr>`、`shot [path]`、`close`（关闭 CLI 当前标签页；默认只关 harness 自建页，`--force` 才强关）。`node scripts/verify.mjs [--browser chrome]` 可对 live 专用 Chrome 冒烟。

## 测试

需从源码 checkout 运行。打包（`npm pack`）产物只含运行时，不含 `tests/`、`scripts/`、`fixtures/`；本插件未发布到 npm，请从源码或本地目录安装。

```sh
npm test                    # 单测（无浏览器）
npm run test:integration    # 24 个场景（临时 headless Chrome）
npm run test:all            # 单测 + 场景（共 98 条）
node scripts/verify.mjs     # 对 live 专用 Chrome 冒烟
```

集成测试自起临时 profile 的 Chrome，不碰用户浏览器；找不到 Chrome 时自动跳过。

## 安全边界

- 只关闭本 harness 创建的标签页；`browser_tabs` 默认不关闭用户标签页（如用 `force` 强制关闭，必须得到用户明确同意）。
- Cookie API 默认脱敏；harness 不主动读取或打印 cookie/token。注意 `browser_status` / `browser_tabs` 会原样返回页面 URL（URL 里可能带 token 等敏感参数），不要把这些输出外发。
- `browser_extract` 的 `network` / `js` 模式只在你显式请求时返回页面本身暴露的内容（`network` 返回当前标签页自连接以来最近的请求事件，最多 100 条，`includeBody` 会较慢；响应头可能含 `Set-Cookie`）；`browser_tabs {action:"use"}` 可把会话附着到既有标签页，之后 `browser_act` 会在其上操作。请显式使用，且不要把 `cdpUrl` 指向日常 Chrome。
- 全部后台操作，不抢前台。
- 遇到登录墙停手问人。

## 状态

v0.1.2：当前版本。包含 `browser_extract` 的 network 捕获修复（工具层启用并跨调用保留）、ref 严格校验（旧 ref 报错而不是重映射）、Page/CDP session 复用与释放、`browser_tabs` 的 `owned` 标记、快照截断标志、`bh close`，以及本轮小清理（死代码/未用导入、CLI 状态目录与库默认一致、`js` 输出 200k 上限、包图标与发布元数据）。通过 `engines.dsh` 精确绑定 DSH `0.2.1-rc.5`。下载/上传/Cookie 能力在内核库中但未作为工具暴露。更新日志见 [Releases](https://github.com/Xumi0920/dsh-browser-harness/releases)。

MIT © 2026 Xumi0920
