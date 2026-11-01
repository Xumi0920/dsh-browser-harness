# 文档与仓库结构

## 文档索引

| 文档 | 内容 |
|---|---|
| [install.md](install.md) | 安装 / 验证 / 卸载 / 升级 / FAQ |
| [configuration.md](configuration.md) | 浏览器发现、端口约定、registry、profile patch 配置键 |
| [tab-groups.md](tab-groups.md) | 按任务标签组：行为边界、配置、排查、实现方式 |
| [usage.md](usage.md) | DSH 工作流、独立库、CLI |
| [architecture.md](architecture.md) | 分层架构、关键流程、错误模型、安全边界、测试策略 |
| [README.md](README.md) | 本文件：仓库结构与维护约定 |

## 目录

本仓库按「运行时资产 / DSH 插件层 / 零依赖核心 / 测试与开发工具 / 文档」分层。

| 目录 | 职责 | 随包发布 |
|---|---|---|
| `src/` | 零依赖核心：CDP 传输、endpoint 发现、Page、AX 快照、state、标签组桥 | ✅ |
| `lib/` | DSH 插件层：工具定义、skill 注册、`BrowserManager` | ✅ |
| `bin/` | 独立 CLI（`bh doctor/open/snapshot/close/groups …`） | ✅ |
| `extension/` | 标签组用的 MV3 扩展（仅 `tabs`/`tabGroups` 权限） | ✅ |
| `skills/browser-harness/` | 运行时技能正文（**单一来源**，`lib/skill.js` 直接读取） | ✅ |
| `locale/` | DSH 插件展示元数据（en/zh） | ✅ |
| `docs/` | 本目录：安装/配置/标签组/使用/架构/结构约定 | ✅ |
| `tests/fixtures/` | 集成测试用的本地 fixture 站 | ❌ |
| `tests/unit/helpers/` | 单测替身（FakeTransport / FakeWebSocket） | ❌ |
| `tests/integration/helpers/` | 真机测试辅助（任意 Chromium 启动器） | ❌ |
| `scripts/` | 冒烟（`verify.mjs`）与 GitHub Packages 一键安装脚本 | ❌ |

`package.json` 的 `files` 字段就是发布白名单：运行时资产 + `docs/` + README/LICENSE，测试与脚本不进包。

## 单一来源

- 技能正文：只维护 `skills/browser-harness/SKILL.md`（不保留根目录副本）。
- README：`README.md`（中文，默认）与 `README.en.md`（英文镜像），改一处要同步另一处。
- 文档按主题拆分：安装 → `docs/install.md`；配置 → `docs/configuration.md`；标签组 → `docs/tab-groups.md`；使用 → `docs/usage.md`；架构 → `docs/architecture.md`。
- 标签组标题/颜色逻辑：`src/tabgroups.mjs`；扩展侧代码只在 `extension/`。

## 维护约定

- 改代码后跑 `npm run test:all`（当前 90 单测 + 27 集成场景 = 117 条）。
- CI：单测跑 ubuntu/windows；集成场景跑 ubuntu（xvfb 提供 display，覆盖 headful 标签组）。
- 版本与发布：GitHub Release 触发 `.github/workflows/publish.yml`，发布到 GitHub Packages（`@xumi0920/dsh-browser-harness`）；版本号需与 tag 一致。
- 提交信息用 conventional commits（`feat:` / `fix:` / `docs:` / `test:` / `chore:`）。
- 新增浏览器相关能力时，优先扩展 `src/`；插件层只做 DSH 适配。

## 下一步规划

- 标签组：颜色模板再增强；扩展「卸载/重装」命令（当前 `bh groups --retry` 只清冷却并重试）；headless 支持取决于 Chrome 是否开放标签组。
- 测试：浏览器启动失败的 CI 降级路径；headful CLI `groups` 的分组断言；扩展 worker 中途被杀后的恢复。
- 文档：architecture.md 补时序图；install.md 增 macOS 实测步骤。
- 发布：npm 可选发布评估（npmjs 名称冲突仍在，GitHub Packages 已发布）。
