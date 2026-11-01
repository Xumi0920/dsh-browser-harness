# 仓库结构与维护约定

本仓库按「运行时资产 / DSH 插件层 / 零依赖核心 / 测试与开发工具 / 文档」分层。

## 目录

| 目录 | 职责 | 随包发布 |
|---|---|---|
| `src/` | 零依赖核心：CDP 传输、endpoint 发现、Page、AX 快照、state、标签组桥 | ✅ |
| `lib/` | DSH 插件层：工具定义（`tools.js`）、skill 注册、`BrowserManager` | ✅ |
| `bin/` | 独立 CLI（`bh doctor/open/snapshot/close …`） | ✅ |
| `extension/` | 标签组用的 MV3 扩展（仅 `tabs`/`tabGroups` 权限），运行时经 CDP 装入专用浏览器 | ✅ |
| `skills/browser-harness/` | 运行时技能正文（**单一来源**，`lib/skill.js` 直接读取） | ✅ |
| `locale/` | DSH 插件展示元数据（en/zh） | ✅ |
| `docs/` | 安装/验证（`install.md`）与本文档 | ✅ |
| `tests/fixtures/` | 集成测试用的本地 fixture 站 | ❌ |
| `tests/unit/helpers/` | 单测替身（FakeTransport / FakeWebSocket） | ❌ |
| `tests/integration/helpers/` | 真机测试辅助（任意 Chromium 启动器） | ❌ |
| `scripts/` | 冒烟脚本（`verify.mjs`，需要源码 checkout） | ❌ |

`package.json` 的 `files` 字段就是发布白名单：运行时资产 + `docs/` + README/LICENSE，测试与脚本不进包。

## 单一来源

- 技能正文：只维护 `skills/browser-harness/SKILL.md`（不再保留根目录副本）。
- README：`README.md`（中文，默认）与 `README.en.md`（英文镜像），改一处要同步另一处。
- 安装文档：只在 `docs/install.md`。
- 标签组标题/颜色逻辑：`src/tabgroups.mjs`；扩展侧代码只在 `extension/`。

## 维护约定

- 改代码后跑 `npm run test:all`（当前 87 单测 + 27 集成场景 = 114 条）；CI 会跑单测（ubuntu/windows）与集成场景（ubuntu + Chrome）。
- 版本与发布：GitHub Release 触发 `.github/workflows/publish.yml`，发布到 GitHub Packages（`@xumi0920/dsh-browser-harness`）；`package.json` 版本号需与 tag 一致。
- 提交信息用 conventional commits（`feat:` / `fix:` / `docs:` / `test:` / `chore:`）。
- 新增浏览器相关能力时，优先扩展 `src/`（零依赖），插件层只做 DSH 适配。

## 下一步规划

- 标签组：组名模板/颜色可配置增强；扩展安装失败的显式重试命令；headless 支持（取决于 Chrome 是否开放标签组）。
- 测试：工具层补 `browser_extract` network 失败路径、扩展安装失败注入、`browser_status.tabGroups` 断言。
- 文档：`docs/` 增加架构说明（CDP 内核 / 插件层 / 扩展桥的分工）。
- 发布：GitHub Packages 安装的一键脚本、npm 可选发布评估（名称冲突仍在）。
