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

- **零依赖**：只用 Node 22+ 内置能力（`fetch`、`WebSocket`、`node:test`），不下载浏览器、不需要构建；插件入口仅用宿主提供的 `@deepseek-ai/dsh-tools` peer。
- **真实登录态**：连自己起好的专用 Chromium 实例（Chrome / Chromium / Edge / Brave / Vivaldi / Opera / Arc 都可以），登录一次长期有效。
- **文本优先**：无障碍树 + ref 比“截图喂视觉模型”更准更省；截图只是可选补充。
- **按任务标签组**：插件自建的标签页自动按 DSH 会话分组，工作标签页不受影响；headless 自动跳过。
- **可验证**：90 个单测 + 27 个集成场景 = 117 条，全部跑在真实 headless / headful Chromium 上。

## 安装

插件发布在 **GitHub Packages**：`@xumi0920/dsh-browser-harness`（npmjs.org 上的同名包属于其他项目）。

```powershell
npm config set @xumi0920:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "<YOUR_GITHUB_TOKEN>"
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "@xumi0920/dsh-browser-harness"
```

本地目录安装、Linux / macOS、一键脚本、验证与卸载见 **[docs/install.md](docs/install.md)**。

## 快速开始

在 DSH（创造模式）里让模型直接调用：

```
browser_status → browser_navigate {url} → browser_snapshot → browser_act {action:"click", ref}
browser_extract {mode:"text" | "html" | "js" | "network"}
```

独立库与 CLI（不装 DSH 也能用）示例见 [docs/usage.md](docs/usage.md)；专用浏览器怎么起、端口和配置见 [docs/configuration.md](docs/configuration.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [安装与验证](docs/install.md) | GitHub Packages / 本地 / Linux / 卸载 / 升级 / FAQ |
| [配置](docs/configuration.md) | 浏览器发现、端口约定、registry、profile patch 配置键 |
| [按任务标签组](docs/tab-groups.md) | 行为边界、配置、排查、实现方式 |
| [使用](docs/usage.md) | DSH 工作流、独立库、CLI |
| [架构](docs/architecture.md) | 分层、关键流程、错误模型、安全边界 |
| [仓库结构](docs/README.md) | 目录约定、维护与发布流程 |

## 测试

```sh
npm test                    # 单测（无浏览器）
npm run test:integration    # 27 个集成场景
npm run test:all            # 单测 + 场景（共 117 条）
```

CI：单测跑 ubuntu / windows；集成场景跑 ubuntu（xvfb，含 headful 标签组）。

## 安全边界

- 只关闭本 harness 创建的标签页；`force` 关闭需要用户明确同意。
- Cookie 默认脱敏，不主动读取或打印 token；`browser_status` / `browser_tabs` 会原样返回含 token 的 URL，不要外发。
- 只在显式请求时返回页面内容；不要把 `cdpUrl` 指向日常浏览器。
- 全部后台操作，不抢前台；遇到登录墙停手问人。

## 状态

v0.3.2：文档重构（README 精简，安装/配置/标签组/使用/架构拆到 `docs/`），功能与 v0.3.1 一致。更新日志见 [Releases](https://github.com/Xumi0920/dsh-browser-harness/releases)。

MIT © 2026 Xumi0920
