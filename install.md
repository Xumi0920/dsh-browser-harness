# 安装与验证（Windows / DSH 0.2.1-rc.5）

## 0. 前置

- Node >= 22（DSH 内嵌 Node 已满足）。
- 一个**专用** Chrome 实例已开启 remote debugging（不要用日常 Chrome 主 profile）：
  ```powershell
  Invoke-RestMethod 'http://127.0.0.1:9331/json/version' | ConvertTo-Json -Compress
  ```
  默认约定 9331（`chrome`）/ 9333（`chrome-beta`）两个专用实例端口；插件默认通过 `~/.dsh/browser-cdp/registry.json` 自动发现，可用 config 覆盖。

## 1. 本地自测（不需要 DSH）

```powershell
git clone https://github.com/Xumi0920/dsh-browser-harness.git
cd C:\path\to\dsh-browser-harness

node --test "tests/unit/**/*.test.mjs"        # 单测
node --test "tests/integration/**/*.test.mjs" # 14 场景（临时 headless Chrome）
npm run test:all                              # 单测 + 场景（共 51 条）
node scripts/verify.mjs --browser chrome       # 对 live 实例冒烟（需源码 checkout）
```

## 2. 安装插件

### 2a. 创造模式 / 插件管理器（推荐）

在 Creator（创造模式）空会话里让模型执行（把路径换成本机 checkout 路径）：

```
plugin_manager { action: "install_bundle", target: "C:\\path\\to\\dsh-browser-harness" }
```

返回 `application: "applied"` 即已激活；出现 `nextStep` / `restart-required` 按提示重启 DSH。

### 2b. CLI（装完重启 GUI）

```powershell
$DSH = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $DSH plugin --profile desktop add "C:\path\to\dsh-browser-harness"
# 然后重启 DeepSeek Harness
```

## 3. 验证（由弱到强）

1. `plugin_manager { action: "list_plugins" }` → `dsh-browser-harness` 存在且 enabled。
2. 新建会话（standard/ptc 均可）→ 工具目录里出现 `browser_*`。
3. 创造模式里 `cordis_inspect_query` → Tool provider 能看到 7 个 browser_* 工具与 schema。
4. 实际调用：`browser_status` → `browser_navigate` 打开 `https://example.com` → `browser_snapshot` → `browser_tabs {action:"close"}`。
5. 确认没有碰用户日常浏览器的标签页（`browser_status.tabs` 里只有专用实例的页）。

## 4. 卸载

```powershell
& $DSH plugin --profile desktop remove dsh-browser-harness
# 或 plugin_manager 的 remove_bundle
```

随后重启 DSH。删除本仓库目录不影响浏览器 profile。

## 5. 常见问题

| 现象 | 处理 |
|---|---|
| `E_NO_BROWSER` | 专用 Chrome 没起/端口不对：确认 `/json/version`，或改 config 的 `cdpUrl`/`browser` |
| 安装后工具不出现 | 重启 DSH；确认 `~/.dsh/profiles/desktop/package.json` 有依赖、`cordis.patch.yml` 有 browser-harness 行 |
| Chrome 弹 "Allow remote debugging?" | 用的是日常 Chrome；改用专用 profile 实例 |
| 工具报 `E_SELECTOR_TIMEOUT` | 先 `browser_snapshot` 重取 ref，再操作 |
| 中文输入 | `browser_act {action:"fill"}` 逐字按键，支持中文 |
