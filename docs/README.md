# 仓库结构与维护约定

本仓库按「运行时资产 / DSH 插件层 / 零依赖核心 / 测试与开发工具 / 文档」分层；架构细节见 [architecture.md](architecture.md)。

## 目录

| 目录 | 职责 | 随包发布 |
|---|---|---|
| `src/` | 零依赖核心：CDP 传输、endpoint 发现、Page、AX 快照、state、标签组桥 | ✅ |
| `lib/` | DSH 插件层：工具定义（`tools.js`）、skill 注册、`BrowserManager` | ✅ |
| `bin/` | 独立 CLI（`bh doctor/open/snapshot/close/groups …`） | ✅ |
| `extension/` | 标签组用的 MV3 扩展（仅 `tabs`/`tabGroups` 权限），运行时经 CDP 装入专用浏览器 | ✅ |
| `skills/browser-harness/` | 运行时技能正文（**单一来源**，`lib/skill.js` 直接读取） | ✅ |
| `locale/` | DSH 插件展示元数据（en/zh） | ✅ |
| `docs/` | 安装/验证（install.md）、架构（architecture.md）与本文档 | ✅ |
| `tests/fixtures/` | 集成测试用的本地 fixture 站 | ❌ |
| `tests/unit/helpers/` | 单测替身（FakeTransport / FakeWebSocket） | ❌ |
| `tests/integration/helpers/` | 真机测试辅助（任意 Chromium 启动器） | ❌ |
| `scripts/` | 冒烟（`verify.mjs`）与 GitHub Packages 一键安装（`install-github-packages.ps1/.sh`） | ❌ |

`package.json` 的 `files` 字段就是发布白名单：运行时资产 + `docs/` + README/LICENSE，测试与脚本不进包。

## 单一来源

- 技能正文：只维护 `skills/browser-harness/SKILL.md`（不保留根目录副本）。
- README：`README.md`（中文，默认）与 `README.en.md`（英文镜像），改一处要同步另一处。
- 安装文档：只在 `docs/install.md`；架构说明：只在 `docs/architecture.md`。
- 标签组标题/颜色逻辑：`src/tabgroups.mjs`；扩展侧代码只在 `extension/`。

## 维护约定

- 改代码后跑 `npm run test:all`（当前 90 单测 + 27 集成场景 = 117 条）。
- CI：单测跑 ubuntu/windows；集成场景跑 ubuntu（用 xvfb 提供 display，覆盖 headful 标签组场景）。
- 版本与发布：GitHub Release 触发 `.github/workflows/publish.yml`，发布到 GitHub Packages（`@xumi0920/dsh-browser-harness`）；`package.json` 版本号需与 tag 一致。
- 提交信息用 conventional commits（`feat:` / `fix:` / `docs:` / `test:` / `chore:`）。
- 新增浏览器相关能力时，优先扩展 `src/`（零依赖），插件层只做 DSH 适配。

## 下一步规划

- 标签组：颜色/模板占位符再增强；扩展「卸载/重装」命令（当前 `bh groups --retry` 只清冷却并重试）；headless 支持取决于 Chrome 是否开放标签组。
- 测试：浏览器启动失败的 CI 降级路径；headful CLI `groups` 的分组断言；扩展 worker 中途被杀后的恢复。
- 文档：architecture.md 补时序图；`docs/install.md` 增 macOS 实测步骤。
- 发布：npm 可选发布评估（npmjs 名称冲突仍在，GitHub Packages 已发布）；GitHub Packages 一键脚本已提供（见 `scripts/`）。
