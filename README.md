# dsh-browser-harness

**简体中文** | [English](README.en.md)

[![ci](https://github.com/Xumi0920/dsh-browser-harness/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Xumi0920/dsh-browser-harness/actions/workflows/ci.yml)
[![codeql](https://github.com/Xumi0920/dsh-browser-harness/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/Xumi0920/dsh-browser-harness/actions/workflows/codeql.yml)
[![version](https://img.shields.io/github/package-json/v/Xumi0920/dsh-browser-harness?label=version)](https://github.com/Xumi0920/dsh-browser-harness/releases)
[![license](https://img.shields.io/github/license/Xumi0920/dsh-browser-harness?label=license)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933)](package.json)
[![typescript](https://img.shields.io/badge/typescript-7.0.2-3178C6)](https://www.typescriptlang.org/)
[![chromium](https://img.shields.io/badge/chromium-any-4285F4)](docs/configuration.md)

**DeepSeek Harness（DSH）原生浏览器工具。** 零依赖 CDP 内核 + 13 个 `browser_*` 工具，直连**专用、已登录**的 Chromium 内核浏览器，提供 e1/e2 引用快照，并按任务给自建标签页分组。

## 工具

```
browser_status      端点 / 浏览器版本 / 标签页 / 当前标签页
browser_wait        出现/消失、URL/文本变化、response、network_idle、delay
browser_navigate    打开 URL，或 back / forward / reload
browser_snapshot    紧凑引用（e1…）；frameId、offset/limit 完整分页、checked/selected/expanded
browser_act         click / hover / highlight / drag / type / fill / selectOption / check / uncheck / press / scroll / dialog；可选 expectUrl/expectText/expectSelector 断言
browser_extract     text / html / JS / network / console / frames
browser_screenshot  整页或元素级 PNG 路径
browser_pdf         页面 PDF 路径
browser_diagnose    截图 + console + 网络失败 + 活动请求诊断包
browser_upload      文件输入上传，路径限制在 uploadDir
browser_download    触发并等待下载，文件落在 downloadDir
browser_task        status / pause / resume / close / start，任务生命周期
browser_tabs        list / use / new / close
```

## 亮点

- **运行时零依赖 + 全量 TypeScript**：构建产物只用 Node 内置的 `fetch` / `WebSocket`，不下载浏览器；源码、测试、脚本、扩展全部是 **TypeScript**，分别由 `tsc` 编译到 `dist/`、`dist-tests/`、`dist-scripts/`、`extension/sw.js`；插件入口仅用宿主提供的 `@deepseek-ai/dsh-tools` peer。
- **真实登录态**：接自己起好的专用 Chromium 实例，登录一次长期有效；不碰日常浏览器。
- **文本优先**：无障碍树 + ref 比“截图喂视觉模型”更准更省，截图只是补充。
- **按任务标签组**：插件自建的标签页自动按 DSH 会话分组，工作标签页不受影响；headless 自动跳过。
- **操作可靠性**：快照按页串行、attach 并发去重；click 默认做遮挡/命中检查（`E_CLICK_INTERCEPTED`）；`load` 等 `complete`；首次导航前开启网络抓取；网络空闲基于活动请求集合与最后活动时间。
- **自动失败诊断**：页面工具失败时自动写入 `<stateDir>/diagnostics/<lane>/`，含脱敏 URL、截图、console/network 尾部、task/lock/context 摘要；错误信息附诊断路径，不记录输入值。
- **只读模式**：`readOnly: true` 时工具层阻止 click/fill/type、JS、上传/下载、tabs new/close 和 task 变更；导航/快照/提取/截图仍可用于检查页面。
- **任务生命周期与标签页锁**：每个 DSH session 是一个 Task；页面操作持有 target 独占 lease，跨任务冲突返回 `E_TAB_LOCKED`/`E_LOCK_TIMEOUT`；支持 `browser_task` 的 status/pause/resume/close。v1.8 起 lease 默认写入 `<stateDir>/locks`，跨 manager 进程通过文件租约/心跳互斥；可选 `isolation: "context"` 为每个任务隔离 cookie/storage（不共享登录态）。
- **可验证**：198 单测（fake CDP）+ 64 集成场景（真实 headless/headful Chromium）= 262 条，CI 覆盖三平台。
- **收紧的边界**：`browser_tabs use` 只接受 page + http(s)/about:blank；非自建 tab 需显式 `{borrow:true}`，其他 Task 自建 tab 返回 `E_TAB_OWNER_CONFLICT`；截图/PDF 限定 `screenshotDir` 且不覆盖；上传限定 `uploadDir`、下载限定 `downloadDir` 并拒绝 symlink 逃逸；fill 不回显输入值；JS 模式标非并发；工具输出对 token 类 URL/headers 尽力脱敏；宽泛端口回退改为显式 `auto`；标签组不再临时改写页面标题。

## 环境要求

| 要求 | 说明 |
|---|---|
| DSH | `>=0.2.1-rc.5`（不设上限） |
| Node | `>=22` |
| 浏览器 | 任一 Chromium 内核 + remote debugging（默认 9331，见 [配置](docs/configuration.md)） |
| 平台 | Windows / Linux 已验证；macOS 单测 CI 通过，真实 Chromium 端到端未实测 |

## 安装

插件发布于 **GitHub Packages**：`@xumi0920/dsh-browser-harness`（npmjs 同名包是别人的项目）。三种方式任选，详见 **[docs/install.md](docs/install.md)**：

1. **插件页（推荐）**：DSH Web → 插件页 → 添加插件 → 安装第三方插件，支持 npm 包名 / Git 仓库 / 本地目录；或在「发现」标签页安装市场条目。
2. **一句话交给 DSH**（创造模式会话）：`把 @xumi0920/dsh-browser-harness 安装到当前 profile`。
3. **手动安装（GitHub Packages，classic PAT）**：

```powershell
npm config set "@xumi0920:registry" "https://npm.pkg.github.com"
npm config set "//npm.pkg.github.com/:_authToken" "<YOUR_GITHUB_TOKEN>"
& "$env:LOCALAPPDATA\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd" `
  plugin --profile desktop add "@xumi0920/dsh-browser-harness"
```

> GitHub Packages npm registry **只支持 classic PAT**（scope `read:packages`），不支持 fine-grained token。手动 `npm config set` 会把 token 持久化到 `~/.npmrc`：建议优先用一键脚本（临时配置，装完即删）；手动安装后请执行 `npm config delete "//npm.pkg.github.com/:_authToken"` 并撤销该 token。本地目录安装前先 `npm install && npm run build`；CLI 改 profile 前先退出 DSH。**热插拔**：`application: applied` 已生效，`restart-required` 才需重启（替换已安装包通常需要重启加载新的 JS 模块，原因见返回的 `restartReason`）。

## 快速开始

安装生效后，先启动专用 Chromium 浏览器（默认 9331），然后在**任意 DSH 会话**里让模型调用（所有预设可用，创造模式只影响 `plugin_manager` 安装）：

```
browser_status → browser_navigate {url} → browser_snapshot → browser_act {action:"click", ref}
browser_extract {mode:"text" | "html" | "js" | "network" | "console" | "frames"}
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
| [安全策略](SECURITY.md) | 漏洞私密报告、支持版本、数据处理说明 |

## 扩展与语言

- **原生插件**：Node 22+ ESM 包（JS/TS，TS 需构建），bundle patch 注册，HMR 协调热插拔。
- **其它语言**：写 MCP server（stdio / Streamable HTTP，Python / Go / Rust / Node 均可），profile 里加 `@deepseek-ai/dsh-mcp-client`，工具以 `mcp__<serverName>__<tool>` 暴露。
- **技能**：Markdown（`SKILL.md`）；**UI 插件**：JS/TS。细节见 [docs/extending.md](docs/extending.md)。

## 测试与 CI

```sh
npm install                 # 开发依赖（TypeScript），运行时零依赖
npm run test:all            # 构建 + 198 单测 + 64 集成场景 = 262 条
```

CI：单测跑 ubuntu / windows / macOS（另有 Node 24 任务）；集成场景跑 ubuntu + xvfb（门禁 64 条，S15/S16 必须实跑）。测试与脚本同样由 `tsc` 编译（`dist-tests/` / `dist-scripts/`），与运行时源码共用 NodeNext 配置。

## 安全边界

- 只关闭本 harness 创建的标签页；`force` 关闭需要用户明确同意。
- `browser_tabs use` 只接受 **page** target + `http(s)`/`about:blank`；非自建页必须精确 `targetId`，URL 子串只匹配自建页；`file:`/`chrome:`/扩展 worker 会被拒绝。
- 截图只写 `screenshotDir`（默认 `<stateDir>/screenshots`），拒绝目录外路径、symlink 逃逸和覆盖已有文件。
- `browser_act fill` 只返回 `{ok, length, verified}`，不回显输入；JS 模式可修改页面状态，已标非并发。
- Cookie 默认脱敏；network URL/headers、status/tabs URL 对 token 类字段尽力脱敏：查询参数名按驼峰/下划线/连字符归一化匹配，`Location` / `Content-Location` 整值脱敏。页面正文、HTML、截图仍可能含敏感数据，不要把工具输出当完整 DLP。
- `browser_status` 的端点诊断不返回完整 CDP URL；连接错误只保留稳定错误码和安全提示。
- 状态文件只保存去掉 query/fragment 与 userinfo 的 URL；宽泛 CDP 端口回退需显式 `browser: "auto"` / `BH_ALLOW_FALLBACK=1`。
- 不要把 `cdpUrl` 指向日常浏览器；全部后台操作，不抢前台；遇到登录墙停手问人。

## 许可

MIT © 2026 Xumi0920 · 当前版本 **v1.9.5** · 全量 TypeScript（源码/测试/脚本/扩展）· 更新日志见 [Releases](https://github.com/Xumi0920/dsh-browser-harness/releases)