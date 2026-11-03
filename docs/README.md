# 文档与仓库结构

## 文档索引

| 文档 | 内容 |
|---|---|
| [install.md](install.md) | 安装 / 验证 / 卸载 / 升级 / FAQ |
| [configuration.md](configuration.md) | 浏览器发现、端口约定、registry、profile patch 配置键 |
| [tab-groups.md](tab-groups.md) | 按任务标签组：行为边界、配置、排查、实现方式 |
| [task-lifecycle.md](task-lifecycle.md) | 任务生命周期与标签页锁：Task 状态机、lease 协议、所有权、恢复、测试策略 |
| [usage.md](usage.md) | DSH 工作流、独立库、CLI |
| [architecture.md](architecture.md) | 分层架构、关键流程、错误模型、安全边界、测试策略 |
| [extending.md](extending.md) | 扩展与语言：原生 JS/TS 插件、热插拔/HMR、MCP 接入 Python 等其它语言 |
| [README.md](README.md) | 本文件：仓库结构与维护约定 |

## 目录

本仓库按「TypeScript 源码 / 构建产物 / 运行时资产 / 测试与开发工具 / 文档」分层。

| 目录/文件 | 职责 | 随包发布 |
|---|---|---|
| `src/` | 零依赖核心（**TypeScript**）：CDP 传输、endpoint 发现、Page、AX 快照、state、标签组桥 | ❌（只发构建产物） |
| `lib/` | DSH 插件层（**TypeScript**）：工具定义、skill 注册、`BrowserManager` | ❌（只发构建产物） |
| `bin/` | 独立 CLI（**TypeScript**，`bh doctor/open/snapshot/close/groups …`） | ❌（只发构建产物） |
| `dist/` | `tsc` 构建产物（ESM JS + `.d.ts`），`package.json` 的 main/exports/bin 都指向这里 | ✅ |
| `types/` | 宿主 peer 的最小环境声明（`@deepseek-ai/dsh-tools`） | ❌ |
| `tsconfig.json` | TypeScript 构建配置（`npm run build`） | ❌ |
| `extension/` | 标签组用的 MV3 扩展运行时资产：`manifest.json` + 构建生成的 `sw.js`（仅 `tabs`/`tabGroups` 权限） | ✅ |
| `extension-src/` | MV3 service worker 的 **TypeScript** 源码（`sw.ts` → `extension/sw.js`） | ❌ |
| `skills/browser-harness/` | 运行时技能正文（**单一来源**，`lib/skill.ts` 编译后从 `dist/lib/skill.js` 读取） | ✅ |
| `locale/` | DSH 插件展示元数据（en/zh） | ✅ |
| `docs/` | 本目录：安装/配置/标签组/使用/架构/结构约定 | ✅ |
| `tests/` | 单测/集成场景/helpers/fixture 全部 **TypeScript**，编译到 `dist-tests/` | ❌ |
| `dist-tests/` | 测试的编译产物（`node --test "dist-tests/**/*.test.js"`） | ❌ |
| `scripts/` | 冒烟（`verify.ts` → `dist-scripts/verify.js`）与 GitHub Packages 一键安装脚本 | ❌ |
| `tsconfig*.json` | 主源码 / 测试 / 脚本 / 扩展四套构建配置 | ❌ |
| `.github/` | CI / publish / CodeQL 工作流、Dependabot、Issue 模板 | ❌ |
| `SECURITY.md` | 漏洞私密报告流程、支持版本与数据处理说明 | ✅ |

`package.json` 的 `files` 字段就是发布白名单：`dist/` 构建产物 + 运行时资产（extension/skills/locale）+ `docs/` + README/LICENSE；**源码、测试、脚本、tsconfig 不进包**。

## 单一来源

- 技能正文：只维护 `skills/browser-harness/SKILL.md`（不保留根目录副本）。
- README：`README.md`（中文，默认）与 `README.en.md`（英文镜像），改一处要同步另一处。
- 文档按主题拆分：安装 → `docs/install.md`；配置 → `docs/configuration.md`；标签组 → `docs/tab-groups.md`；使用 → `docs/usage.md`；架构 → `docs/architecture.md`。
- 标签组标题/颜色逻辑：`src/tabgroups.ts`；扩展侧代码只在 `extension-src/sw.ts`，构建到 `extension/sw.js`。
- 发布产物唯一来源：`npm run build`（`tsc`）→ `dist/`、`extension/sw.js`；测试编译到 `dist-tests/`，脚本编译到 `dist-scripts/`。不要手改这些构建产物，也不要提交它们（已 gitignore）。

## 维护约定

- 全量 TypeScript：源码/测试/脚本/扩展均为 TS（主源码 `strict: true` 含 `noImplicitAny`；测试因动态替身以 `noCheck` 编译）。先 `npm install`，改代码后跑 `npm run test:all`（自动构建源码与测试，当前 178 单测 + 48 集成场景 = 226 条）。
- CI：`npm ci` 后单测跑 ubuntu / windows / macOS（另有 Node 24 任务）；集成场景先 `npm run build:tests` 再在 ubuntu + xvfb 跑 `dist-tests/integration/**/*.test.js`，门禁要求正好 48 条且 S15/S16 必须实际执行；publish 校验 tag==v版本并做打包冒烟（含 `dist/` 产物）；CodeQL 在 push main / 每周扫描 `javascript-typescript`。
- 版本与发布：GitHub Release 触发 `.github/workflows/publish.yml`，发布到 GitHub Packages（`@xumi0920/dsh-browser-harness`）；版本号需与 tag 一致。保留完整 git tag/Release 历史（v0.1.0 起已补全），只将最新稳定版标记为 latest；**不要删除历史 Release/tag**，便于回滚、安全公告和版本追溯。
- 依赖升级（Dependabot，weekly）：逐个 PR `gh pr checkout <n>` → `npm ci` → `npx tsc --noEmit` → `npm run build` → 全量 `npm run test:all`（178 单测 + 48 集成）；分支落后 main 时先 `gh pr update-branch <n>` 再复测；通过后 `gh pr merge <n> --squash --delete-branch`。仅 devDependencies/lockfile 变化时**不必发版**（`dist/` 与运行时依赖不变）；typescript / @types/node 等工具链升级必须同时通过类型检查与集成场景。
- DSH 版本兼容：`engines.dsh` 与 DSH peer 均为 `>=0.2.1-rc.5`（不设上限）；`tests/unit/package.test.ts` 按 DSH plugin-manager 的 `semver.satisfies(..., { includePrerelease: true })` 逻辑校验。
- 提交信息用 conventional commits（`feat:` / `fix:` / `docs:` / `test:` / `chore:`）。
- 新增浏览器相关能力时，优先扩展 `src/`；插件层只做 DSH 适配。

## GitHub 仓库设置建议（需在网页/API 手动开启）

以下设置**不在仓库文件里自动生效**，建议由维护者在 GitHub 设置中开启：

- **main 分支保护 / ruleset**：Require a pull request before merging（至少 1 次 review）、Require status checks（`unit (ubuntu-latest)` / `unit (windows-latest)` / `unit (macos-latest)` / `unit-node24` / `integration`）、Require conversation resolution、Block force pushes、Restrict deletions；若保持直接 push 工作流，可只先要求 status checks 且禁止 force push/删除。
- **Tag 保护**：对 `v*` 禁止非维护者创建/移动/删除；Release 只从 tag 发布。
- **Code security**：Secret scanning + Push protection（已开启）、Dependabot alerts + security updates（已开启）、CodeQL（已加工作流）；依赖图保持开启。
- **Private vulnerability reporting**：Security 标签页 → 开启私密漏洞报告（SECURITY.md 已链接）。
- **Actions 加固**：publish 现在只接受 tag 发布（`workflow_dispatch` 非 tag ref 会失败），`packages:write` 已限定到发布 job；关键 action 可进一步固定到 commit SHA（与 Dependabot 升级配合），目前使用官方 major tag。
- **Publish 环境**：可为 `publish` job 配置 Environment + required reviewers；tag 校验已存在（tag 必须等于 `v${version}`）。
- 本地 `.env` / `.npmrc` / 证书 / 截图目录已加入 `.gitignore`，不要提交 token。

## 下一步规划

- 标签组：headless 支持取决于 Chrome 是否开放标签组；组名模板 `{session}`/`{lane}` 与颜色已支持。
- 测试：更多 CLI 命令/工具参数端到端覆盖；macOS 真机集成场景；插件入口的 DSH 运行时冒烟。
- 文档：architecture.md 补时序图；install.md 增 macOS 实测步骤。
- 发布：npm 可选发布评估（npmjs 名称冲突仍在，GitHub Packages 已发布）。
