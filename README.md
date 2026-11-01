# dsh-browser-harness

**简体中文** | [English](README.en.md)

[![ci](https://github.com/Xumi0920/dsh-browser-harness/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Xumi0920/dsh-browser-harness/actions/workflows/ci.yml)

**DeepSeek Harness（DSH）原生浏览器工具。** 零依赖 CDP 内核 + 7 个 `browser_*` 工具，直连**专用、已登录**的 Chromium 内核浏览器，提供 e1/e2 引用快照，并按任务给自建标签页分组。

## 工具

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

- **运行时零依赖**：构建产物只用 Node 内置的 `fetch` / `WebSocket`，不下载浏览器；源码为 **TypeScript**，`tsc` 构建到 `dist/`，插件入口仅用宿主提供的 `@deepseek-ai/dsh-tools` peer。
- **真实登录态**：接自己起好的专用 Chromium 实例，登录一次长期有效；不碰日常浏览器。
- **文本优先**：无障碍树 + ref 比“截图喂视觉模型”更准更省，截图只是补充。
- **按任务标签组**：插件自建的标签页自动按 DSH 会话分组，工作标签页不受影响；headless 自动跳过。
- **可验证**：102 单测（fake CDP）+ 27 集成场景（真实 headless/headful Chromium）= 129 条，CI 覆盖三平台。

## 环境要求

| 要求 | 说明 |
|---|---|
| DSH | `>=0.2.1-rc.5`（不设上限） |
| Node | `>=22` |
| 浏览器 | 任一 Chromium 内核 + remote debugging（默认 9331，见 [配置](docs/configuration.md)） |
| 平台 | Windows / Linux 已验证；macOS 未实测 |

## 安装

插件发布于 **GitHub Packages**：`@xumi0920/dsh-browser-harness`（npmjs 同名包是别人的项目）。三种方式任选，详见 **[docs/install.md](docs/install.md)**：

1. **插件页（推荐）**：DSH Web → 插件页 → 添加插件 → 安装第三方插件，支持 npm 包名 / Git 仓库 / 本地目录；或在「发现」标签页安装市场条目。
2. **一句话交给 DSH**（创造模式会话）：`把 @xumi0920/dsh-browser-harness 安装到当前 profile`。
3. **手动安装（GitHub Packages）**：

```powershell
npm config set "@xumi0920:registry" "https://npm.pkg.github.com"
npm config set "//npm.pkg.github.com/:_authToken" "<YOUR_GITHUB_TOKEN>"
& "$env:LOCALAPPDATA\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd" `
  plugin --profile desktop add "@xumi0920/dsh-browser-harness"
```

> GitHub Packages 需要 read:packages token；本地目录安装前先 `npm install && npm run build`；CLI 改 profile 前先退出 DSH。**热插拔**：`application: applied` 已生效，`restart-required` 才需重启（替换已安装包通常需要重启加载新的 JS 模块，原因见返回的 `restartReason`）。

## 快速开始

安装生效后，先启动专用 Chromium 浏览器（默认 9331），然后在**任意 DSH 会话**里让模型调用（所有预设可用，创造模式只影响 `plugin_manager` 安装）：

```
browser_status → browser_navigate {url} → browser_snapshot → browser_act {action:"click", ref}
browser_extract {mode:"text" | "html" | "js" | "network"}
```

首调 `connected:false`？确认专用浏览器已启动且 `http://127.0.0.1:9331/json/version` 可访问（见 [docs/configuration.md](docs/configuration.md)）。

## 适用场景

| 场景 | 建议 |
|---|---|
| 登录态页面、点击/填表、上传下载、多标签、截图 | 用本插件 |
| 公开页面纯读取 | 优先 `web_fetch`（更快，不占浏览器） |
| headless 环境 | 标签组自动跳过；其它工具正常 |
| 日常浏览器 | 不要指向它；使用专用 profile 实例 |

## 文档

| 文档 | 内容 |
|---|---|
| [安装与验证](docs/install.md) | 插件页 / 一句话 / GitHub Packages / 本地 / Linux / 卸载 / 升级 / FAQ |
| [配置](docs/configuration.md) | 浏览器发现、端口约定、registry、profile patch 配置键 |
| [按任务标签组](docs/tab-groups.md) | 行为边界、配置、排查、实现方式 |
| [使用](docs/usage.md) | DSH 工作流、独立库、CLI |
| [架构](docs/architecture.md) | 分层、关键流程、错误模型、安全边界 |
| [扩展与语言](docs/extending.md) | 原生 JS/TS 插件、热插拔/HMR、MCP 接 Python 等 |
| [仓库结构](docs/README.md) | 目录约定、维护与发布流程 |

## 扩展与语言

- **原生插件**：Node 22+ ESM 包（JS/TS，TS 需构建），bundle patch 注册，HMR 协调热插拔。
- **其它语言**：写 MCP server（stdio / Streamable HTTP，Python / Go / Rust / Node 均可），profile 里加 `@deepseek-ai/dsh-mcp-client`，工具以 `mcp__<serverName>__<tool>` 暴露。
- **技能**：Markdown（`SKILL.md`）；**UI 插件**：JS/TS。细节见 [docs/extending.md](docs/extending.md)。

## 测试与 CI

```sh
npm install                 # 开发依赖（TypeScript），运行时零依赖
npm run test:all            # 构建 + 102 单测 + 27 集成场景 = 129 条
```

CI：单测跑 ubuntu / windows / macOS（另有 Node 24 任务）；集成场景跑 ubuntu + xvfb（门禁 27 条，S15/S16 必须实跑）。

## 安全边界

- 只关闭本 harness 创建的标签页；`force` 关闭需要用户明确同意。
- Cookie 默认脱敏，不主动读取或打印 token；`browser_status` / `browser_tabs` 会原样返回含 token 的 URL，不要外发。
- 只在显式请求时返回页面内容；不要把 `cdpUrl` 指向日常浏览器。
- 全部后台操作，不抢前台；遇到登录墙停手问人。

## 许可

MIT © 2026 Xumi0920 · 当前版本 **v0.4.4** · 更新日志见 [Releases](https://github.com/Xumi0920/dsh-browser-harness/releases)
