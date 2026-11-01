# dsh-browser-harness

**简体中文** | [English](README.en.md)

**DeepSeek Harness（DSH）原生浏览器工具。** 零依赖 CDP 内核，把 7 个 `browser_*` 工具挂到 DSH 上，直连一个**专用、已登录**的 Chromium 内核真实浏览器，提供带引用编号（e1、e2…）的紧凑无障碍树快照，并按任务给自建标签页分组。

```
browser_status      端点 / 浏览器版本 / 标签页 / 当前标签页
browser_navigate    打开 URL，返回页面信息 + 快照
browser_snapshot    紧凑引用（e1…），含角色、名称、视口中心坐标
browser_act         click / type / fill / press / scroll
browser_extract     text / html / JS / network
browser_screenshot  PNG 路径
browser_tabs        list / use / new / close
```

## 亮点

- **运行时零依赖**：构建产物只用 Node 22+ 内置能力（`fetch`、`WebSocket`、`node:test`），不下载浏览器；**源码是 TypeScript**，`tsc` 构建到 `dist/`，开发依赖仅 `typescript` + `@types/node`，插件入口仅用宿主提供的 `@deepseek-ai/dsh-tools` peer。
- **真实登录态**：连自己起好的专用 Chromium 实例（Chrome / Chromium / Edge / Brave / Vivaldi / Opera / Arc 都可以），登录一次长期有效。
- **文本优先**：无障碍树 + ref 比“截图喂视觉模型”更准更省；截图只是可选补充。
- **按任务标签组**：插件自建的标签页自动按 DSH 会话分组，工作标签页不受影响；headless 自动跳过。
- **可验证**：100 个单测（fake CDP 替身，无需浏览器）+ 27 个集成场景（真实 headless / headful Chromium）= 127 条。

## 安装

插件发布在 **GitHub Packages**：`@xumi0920/dsh-browser-harness`（npmjs.org 上的同名包属于其他项目）；需要 **DSH 0.2.1-rc.5 + Node 22**。任选一种方式：

**方式一（推荐，图形界面）：DSH Web 插件页**

打开 DSH Web 的**插件页**（左侧/设置里的「插件」入口；会话菜单里的「浏览更多插件」也能进入），在「已安装」标签页点 **添加插件** → **安装第三方插件**，支持 **npm 包名 / Git 仓库 / 本地目录**；官方市场条目在 **发现** 标签页搜索并安装。

**方式二：一句话交给 DSH 安装**（创造模式会话；`plugin_manager` 是创造模式专用工具，每次操作需要 danger-full-access 或当次批准）：

> 把 `@xumi0920/dsh-browser-harness` 安装到当前 DSH profile。

> GitHub Packages 来源**需要先完成「方式三」里的两条 npm config**（read:packages token）；不想配 token 的话，把包名换成你本机 clone 的绝对路径即可：`把 <本机 clone 路径> 安装到当前 profile`（本地目录需先 `npm install && npm run build`，源码是 TypeScript）。

**方式三：手动安装（GitHub Packages / CLI）**

```powershell
npm config set "@xumi0920:registry" "https://npm.pkg.github.com"
npm config set "//npm.pkg.github.com/:_authToken" "<YOUR_GITHUB_TOKEN>"
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "@xumi0920/dsh-browser-harness"
```

> CLI 直接改 profile 时请先退出 DeepSeek Harness，装完重启。本地目录安装、Linux / macOS、一键脚本（token 只写临时 npm 配置）、验证与卸载见 **[docs/install.md](docs/install.md)**。

**热插拔**：安装结果的 `application` 为 `applied` 时已经热生效，不必重启；为 `restart-required` 时才重启（`restartReason` 会解释原因：`no-hmr` / `package-moved` / `host-module` / `unmanaged-plugin` / `module-comparison`）。**替换已安装的包**（升级、换目录、本地 link 改代码）通常需要重启才能加载新的 JS 模块；图形界面会直接提示「请重启 DSH 使更改生效。{原因}」。

## 快速开始

安装生效后（`applied` 或重启完成），先启动专用 Chromium 浏览器（端口/启动命令见 [docs/configuration.md](docs/configuration.md)；默认 9331）。之后在**任意 DSH 会话**里让模型直接调用即可（所有预设都能用，不限于创造模式；创造模式只影响用 `plugin_manager` 安装这一步）：

```
browser_status → browser_navigate {url} → browser_snapshot → browser_act {action:"click", ref}
browser_extract {mode:"text" | "html" | "js" | "network"}
```

独立库与 CLI（不装 DSH 也能用）示例见 [docs/usage.md](docs/usage.md)；专用浏览器怎么起、端口和配置见 [docs/configuration.md](docs/configuration.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [安装与验证](docs/install.md) | 插件页 / 一句话交给 DSH / GitHub Packages / 本地 / Linux / 卸载 / 升级 / FAQ |
| [配置](docs/configuration.md) | 浏览器发现、端口约定、registry、profile patch 配置键 |
| [按任务标签组](docs/tab-groups.md) | 行为边界、配置、排查、实现方式 |
| [使用](docs/usage.md) | DSH 工作流、独立库、CLI |
| [架构](docs/architecture.md) | 分层、关键流程、错误模型、安全边界 |
| [扩展与语言](docs/extending.md) | 插件语言、热插拔/HMR、用 MCP 接入 Python 等其它语言 |
| [仓库结构](docs/README.md) | 目录约定、维护与发布流程 |

## 扩展与语言

- **原生插件**：Node 22+ 的 ESM 包（JS/TS；TS 需先构建），通过 bundle patch 注册，热插拔由 DSH 的 HMR 协调。
- **其它语言**：写一个 MCP server（stdio 或 Streamable HTTP，Python / Go / Rust / Node 均可），在 profile 里加 `@deepseek-ai/dsh-mcp-client` 条目，工具会以 `mcp__<serverName>__<tool>` 暴露。
- **技能**：Markdown（`SKILL.md`），不需要写代码；**UI 插件**：JS/TS（DSH Web Client）。
- 为什么插件是 JS/TS：它是宿主运行时（Node 22 / V8）加载的模块语言，模型本身并不"运行 JS"；TS/零构建 JS 对 Agent 编写插件最省事。Python 的数据/ML 生态走 MCP 更合适。细节见 [docs/extending.md](docs/extending.md)。

## 测试

```sh
npm install                 # 开发依赖（TypeScript 构建），运行时零依赖
npm test                    # 构建 + 100 单测（无浏览器）
npm run test:integration    # 构建 + 27 个集成场景
npm run test:all            # 构建 + 单测 + 场景（共 127 条）
```

CI：单测跑 ubuntu / windows / macOS（含 Node 24 任务）；集成场景跑 ubuntu（xvfb，含 headful 标签组）。

## 安全边界

- 只关闭本 harness 创建的标签页；`force` 关闭需要用户明确同意。
- Cookie 默认脱敏，不主动读取或打印 token；`browser_status` / `browser_tabs` 会原样返回含 token 的 URL，不要外发。
- 只在显式请求时返回页面内容；不要把 `cdpUrl` 指向日常浏览器。
- 全部后台操作，不抢前台；遇到登录墙停手问人。

## 状态

v0.4.2：完成全量 `strict`（含 `noImplicitAny`）；测试卫生（临时目录自动清理、S16 轮询断言、T06 修正）；CI 增加 macOS 与 Node 24 矩阵、actions 升级 v7 并接入 Dependabot；state 文件 0600 权限；`bin` 路径规范化消除 publish 自动修正告警。从 v0.4.0 起源码为 TypeScript、`tsc` 构建到 `dist/`，运行时仍零依赖。更新日志见 [Releases](https://github.com/Xumi0920/dsh-browser-harness/releases)。

MIT © 2026 Xumi0920
