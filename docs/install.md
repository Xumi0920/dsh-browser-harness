# 安装与验证（Windows / Linux，DSH 0.2.1-rc.5）

## 0. 前置

- DSH `0.2.1-rc.5` + Node.js >= 22（`engines.dsh` / `engines.node` 会校验；版本不符插件不会加载）。
- 一个已开启 remote debugging 的**专用** Chromium 内核浏览器。启动命令、端口约定与 registry 配置见 [configuration.md](configuration.md)。
- 平台：Windows 与 Linux 已验证（Linux CI 用 xvfb 覆盖 headful 标签组）；macOS 未实测。

## 1. 本地自测（不需要 DSH）

```powershell
git clone https://github.com/Xumi0920/dsh-browser-harness.git C:\path\to\dsh-browser-harness
cd C:\path\to\dsh-browser-harness

node --test "tests/unit/**/*.test.mjs"        # 92 单测（fake CDP 替身，无需浏览器）
node --test "tests/integration/**/*.test.mjs" # 27 场景（真实 headless/headful Chromium）
npm run test:all                              # 共 119 条
node scripts/verify.mjs --browser chrome       # 对 live 实例冒烟
```

## 2. 安装插件

插件发布在 **GitHub Packages**：`@xumi0920/dsh-browser-harness`；npmjs.org 上的 `dsh-browser-harness` 是别的项目。GitHub Packages 来源需要先配置 registry + read:packages token（见 2b）；本地目录安装不需要 token。任选一种方式。

### 2a. 一句话交给 DSH 安装（创造模式会话）

在 DSH 创造模式会话里直接对模型说：

> 把 `@xumi0920/dsh-browser-harness` 安装到当前 DSH profile。

使用 GitHub Packages 来源时，**先完成 2b 的两条 npm config**，否则 pnpm 会从 npmjs.org 解析并返回 404/401。本地目录安装则把包名换成绝对路径：

> 把 `C:\path\to\dsh-browser-harness` 安装到当前 profile。

DSH 会调用 `plugin_manager` 的 `install_bundle` 完成安装；`plugin_manager` 是**创造模式专用工具**，每次操作需要 danger-full-access 沙箱或当次批准。安装完成后重启 DSH，即可在**任意会话/预设**里使用 `browser_*` 工具（不限于创造模式）。

### 2b. GitHub Packages（需要带 read:packages 的 GitHub token）

```powershell
npm config set "@xumi0920:registry" "https://npm.pkg.github.com"
npm config set "//npm.pkg.github.com/:_authToken" "<YOUR_GITHUB_TOKEN>"
# 创造模式 / 插件管理器：plugin_manager { action: "install_bundle", target: "@xumi0920/dsh-browser-harness" }
# 或 CLI（先退出 DeepSeek Harness，装完重启）：
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "@xumi0920/dsh-browser-harness"
```

一键脚本（从仓库获取；只会把 token 写进**临时 npm 配置**，安装结束即删除，不写你的 `~/.npmrc`）：

- Windows：[install-github-packages.ps1](https://github.com/Xumi0920/dsh-browser-harness/blob/main/scripts/install-github-packages.ps1)
- Linux / macOS：[install-github-packages.sh](https://github.com/Xumi0920/dsh-browser-harness/blob/main/scripts/install-github-packages.sh)

> 如果你运行过**旧版**脚本，它可能把 token 明文留在了 `~/.npmrc`：执行 `npm config delete "//npm.pkg.github.com/:_authToken"`，并到 GitHub 撤销那个 token，换用 fine-grained、只带 `read:packages` 的新 token。

### 2c. 本地 clone 目录（推荐开发/自用）

在 Creator（创造模式）空会话里让模型执行（路径换成你本机 clone 的绝对路径；JSON 里的反斜杠要写两份）：

```
plugin_manager { action: "install_bundle", target: "C:\\path\\to\\dsh-browser-harness" }
```

`plugin_manager` 每次操作需要 danger-full-access 沙箱或当次批准；返回 `application: "applied"` 即已激活，遇到 `nextStep` / `restart-required` 按提示重启。

### 2d. CLI 安装本地目录

先退出 DeepSeek Harness，再执行（装完重启）：

```powershell
$DSH = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $DSH plugin --profile desktop add "C:\path\to\dsh-browser-harness"
```

### 2e. Linux / macOS

```bash
npm config set "@xumi0920:registry" "https://npm.pkg.github.com"
npm config set "//npm.pkg.github.com/:_authToken" "$GITHUB_TOKEN"
# 先退出 DSH；dsh 不在 PATH 时传 CLI 绝对路径
dsh plugin --profile desktop add "@xumi0920/dsh-browser-harness"
# 或一键脚本：GITHUB_TOKEN="$GITHUB_TOKEN" ./scripts/install-github-packages.sh desktop
```

## 3. 验证（由弱到强）

> 第 1、3 步需要创造模式会话（`plugin_manager` 工具只在创造模式提供）；其余步骤任意会话均可。

1. `plugin_manager { action: "list_plugins" }` → `@xumi0920/dsh-browser-harness` 存在且 enabled。
2. 确认 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 含该包；注册行在**插件包自身**的 `cordis.patch.yml`，profile patch 不必出现。
3. 创造模式里 `cordis_inspect_query` → Tool provider 能看到 7 个 `browser_*` 工具与 schema。
4. 实际调用：`browser_status` → `browser_navigate` 打开 `https://example.com` → `browser_snapshot` → `browser_tabs {action:"close"}`。
5. 确认 `browser_status.tabs` 里只有专用实例的页；需要时用 `bh groups` 检查标签组。

首调返回 `connected:false` 时：先启动专用浏览器并确认 `http://127.0.0.1:9331/json/version` 可访问，再重启 DSH。

## 4. 卸载

```powershell
$DSH = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $DSH plugin --profile desktop remove "@xumi0920/dsh-browser-harness"
# 或 plugin_manager 的 remove_bundle
```

随后重启 DSH。删除仓库目录不影响浏览器 profile；标签组扩展可留在 profile，或用 `chrome://extensions` 手动移除（见 [tab-groups.md](tab-groups.md)）。

## 5. 升级

- GitHub Packages：重新执行 `dsh plugin --profile desktop add "@xumi0920/dsh-browser-harness"` 后重启；
- 本地目录：`git pull` 后重启 DSH（link 安装即时生效）。

## 6. 常见问题

| 现象 | 处理 |
|---|---|
| `npm install` 报 **404 Not Found** | 没配 `@xumi0920:registry`：scoped 包在 npmjs.org 不存在，先执行 2b 的两条 npm config |
| 报 **401 Unauthorized** / token not provided | `GITHUB_TOKEN` 缺失、过期或没有 `read:packages`；重新配置后重试 |
| `E_NO_BROWSER` | 专用浏览器没起/端口不对：确认 `/json/version`，或改配置 `cdpUrl`/`browser`（见 [configuration.md](configuration.md)） |
| 安装后工具不出现 | 是否重启 DSH；确认 profile 的 dependencies / bundles 含 scoped 包名；DSH/Node 版本是否满足 `engines` |
| 浏览器弹 "Allow remote debugging?" | 用的是日常浏览器；改用专用 profile 实例 |
| `E_SELECTOR_TIMEOUT` / `E_ELEMENT_NOT_FOUND` | 先 `browser_snapshot` 重取 ref，再操作 |
| `E_POLICY_DENIED` | 试图关闭非本 harness 创建的标签页，或导航到非 http(s) 地址；需要 `force` 关闭时先取得用户明确同意 |
| 标签组不可用（`tabGroups.available=false`） | 见 [tab-groups.md](tab-groups.md) 的“状态与排查” |
