# 配置

本插件只**探测**已运行的浏览器，绝不启动、杀死或重配用户的浏览器。所有配置都可以放在 profile patch（`~/.dsh/profiles/desktop/cordis.patch.yml`）里。

## 1. 浏览器如何被发现

解析顺序：显式 `ws` → 显式 `cdpUrl` → 环境变量（`BH_WS` / `BH_CDP_URL` / `BH_BROWSER`）→ `browser` 选择器 → registry 默认 / auto。

- registry 文件：`~/.dsh/browser-cdp/registry.json`
- 不指定 `browser`：只探测已配置的 registry 实例（或项目约定的 9331–9338 端口）；全部失败即报 `E_NO_BROWSER`
- 显式 `browser: "auto"`（或 `BH_ALLOW_FALLBACK=1`）：配置实例都不通时，才并行回退其它已知 Chromium 端口与标准 `9222` / `9223`

> 宽泛回退是**显式 opt-in**：它会探测任意本地 CDP 端口，如果日常浏览器也开了 remote debugging，可能附着到它。普通日常浏览器默认不开启 remote debugging；请确认 9222/9223 不属于你要保护的工作浏览器。

## 2. 支持的浏览器与默认端口

任何**基于 Chromium 内核、支持 CDP remote debugging** 的浏览器都可以（Chrome、Chromium、Edge、Brave、Vivaldi、Opera、Arc……）。端口只是本项目的本地约定：

| 浏览器 | 默认端口 | `browser` 选择器 |
|---|---|---|
| Google Chrome | 9331 | `chrome` |
| Microsoft Edge | 9332 | `edge` |
| Chrome Beta | 9333 | `chrome-beta` |
| Chromium | 9334 | `chromium` |
| Brave | 9335 | `brave` |
| Vivaldi | 9336 | `vivaldi` |
| Opera | 9337 | `opera` |
| Arc | 9338 | `arc` |
| 其它 CDP 端口 | 9222 / 9223（auto 回退） | — |

## 3. 启动专用实例

Windows（PowerShell；`chrome.exe` 等通常不在 PATH，用完整路径，按本机安装位置调整）：

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9331 "--user-data-dir=$env:USERPROFILE\.dsh\browser-cdp\profiles\chrome"
& "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9332 "--user-data-dir=$env:USERPROFILE\.dsh\browser-cdp\profiles\edge"
& "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe" `
  --remote-debugging-port=9335 "--user-data-dir=$env:USERPROFILE\.dsh\browser-cdp\profiles\brave"
```

Linux（以下命令名以发行版安装为准）：

```bash
google-chrome  --remote-debugging-port=9331 --user-data-dir="$HOME/.dsh/browser-cdp/profiles/chrome"
chromium       --remote-debugging-port=9334 --user-data-dir="$HOME/.dsh/browser-cdp/profiles/chromium"
microsoft-edge --remote-debugging-port=9332 --user-data-dir="$HOME/.dsh/browser-cdp/profiles/edge"
```

macOS（未实测）：

```bash
open -na "Google Chrome" --args --remote-debugging-port=9331 "--user-data-dir=$HOME/.dsh/browser-cdp/profiles/chrome"
```

用任意端口（如 9222）也可以：直接配 `cdpUrl: "http://127.0.0.1:9222"`；`browser: "auto"` 会**显式**回退探测标准端口。

## 4. profile patch 配置示例

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加 **id 定向覆盖**：

```yaml
- id: browser-harness
  name: "@xumi0920/dsh-browser-harness"
  config:
    browser: chrome-beta      # 或 chrome / edge / brave / chromium ...
    # cdpUrl: http://127.0.0.1:9333
    # ws: ws://127.0.0.1:9333/devtools/browser/<id>
    maxSnapshotNodes: 250
    # stateDir: ~/.dsh/browser-harness
    # downloadDir: ~/.dsh/browser-harness/downloads
    # screenshotDir: ~/.dsh/browser-harness/screenshots
    # dialogPolicy: auto-dismiss
    tabGroups: true                 # 按任务给自建标签页分组（默认开）
    # tabGroupTitle: "DSH · {session}"  # 支持 {session} / {lane} 占位符
    # tabGroupColor: blue               # 默认按会话稳定分配
```

> **不要**在 profile patch 里再写 `- insert:` 插一行，否则会重复注册；`insert` 是插件包自身 `cordis.patch.yml` 的注册方式。

### 配置键

| 键 | 默认 | 说明 |
|---|---|---|
| `browser` | — | 目标实例选择器（见上表） |
| `cdpUrl` / `ws` | — | 直连端点（二选一，优先于 `browser`） |
| `maxSnapshotNodes` | 250 | 快照节点上限（`browser_snapshot` 可单独指定，最多 400） |
| `stateDir` | `~/.dsh/browser-harness` | 状态文件目录（per-lane JSON） |
| `downloadDir` | `<stateDir>/downloads` | 下载目录 |
| `screenshotDir` | `<stateDir>/screenshots` | 截图输出目录：只允许写这里，拒绝覆盖已有文件 |
| `dialogPolicy` | `auto-dismiss` | 对话框策略 |
| `tabGroups` | `true` | 按任务标签页分组，见 [tab-groups.md](tab-groups.md) |
| `tabGroupTitle` | `DSH · {session}` | 组名模板，支持 `{session}` / `{lane}` |
| `tabGroupColor` | 按会话分配 | 组颜色 |

## 5. registry.json 高级用法

条目除 `port` 外支持 `httpUrl`（任意 CDP 地址，含远程 / WSL / 容器），`enabled` 控制是否参与 auto 探测：

```json
{
  "version": 1,
  "default": "chrome",
  "browsers": {
    "chrome": { "label": "Chrome", "port": 9331, "enabled": true },
    "brave": { "label": "Brave", "httpUrl": "http://127.0.0.1:9222", "enabled": true }
  }
}
```

## 6. 环境变量

| 变量 | 作用 |
|---|---|
| `BH_CDP_URL` | 直接指定 CDP HTTP 地址 |
| `BH_WS` | 直接指定 WebSocket 地址 |
| `BH_BROWSER` | 浏览器选择器（如 `edge` / `auto`） |
| `BH_ALLOW_FALLBACK` | `1` = 允许 `browser` 未指定时也探测其它端口（等同显式 auto） |
| `DSH_HOME` / `BH_STATE_DIR` | 覆盖 `~/.dsh` 与状态目录位置 |

## 7. 安全提醒

- 不要把 `cdpUrl` 指向日常浏览器；专用实例的 profile 与工作 profile 分离。
- `browser_tabs {action:"use"}` 只接受 **page** target 和 `http(s)` / `about:blank` URL：非自建标签页必须用精确 `targetId`，URL 子串只匹配 harness 自建标签页；`file:`、`chrome:`、扩展 worker 等会被拒绝。
- 只允许打开 `http(s)` 页面（`about:blank` 除外）；`file://`、`data:`、`javascript:`、`chrome://` 等会被 `E_POLICY_DENIED` 拒绝。
- 截图默认写入 `screenshotDir`，拒绝目录外路径、symlink 逃逸和覆盖已有文件。
- 工具输出会对 token 类 URL query / 响应 headers 做**尽力脱敏**（参数名归一化；`Location`/`Content-Location` 整值隐藏）；页面正文、HTML、截图和用户输入仍可能包含敏感数据，不要把浏览器工具当作完整 DLP。
- 状态文件里只保留去掉 userinfo/query/fragment 的 URL；harness 探测失败会报 `E_NO_BROWSER`，不会自行启动浏览器。