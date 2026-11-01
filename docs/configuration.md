# 配置

本插件只**探测**已运行的浏览器，绝不启动、杀死或重配用户的浏览器。所有配置都可以放在 profile patch（`~/.dsh/profiles/desktop/cordis.patch.yml`）里。

## 1. 浏览器如何被发现

解析顺序：显式 `ws` → 显式 `cdpUrl` → 环境变量（`BH_WS` / `BH_CDP_URL` / `BH_BROWSER`）→ `browser` 选择器 → registry 默认 / auto。

- registry 文件：`~/.dsh/browser-cdp/registry.json`
- `browser: "auto"`（或不指定）：先按配置实例顺序探测；都不通时并行回退其它已知 Chromium 端口与标准 `9222` / `9223`

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

Windows（PowerShell）：

```powershell
chrome.exe --remote-debugging-port=9331 "--user-data-dir=$env:USERPROFILE\.dsh\browser-cdp\profiles\chrome"
msedge.exe --remote-debugging-port=9332 "--user-data-dir=$env:USERPROFILE\.dsh\browser-cdp\profiles\edge"
brave.exe  --remote-debugging-port=9335 "--user-data-dir=$env:USERPROFILE\.dsh\browser-cdp\profiles\brave"
```

Linux / macOS：

```bash
google-chrome  --remote-debugging-port=9331 --user-data-dir="$HOME/.dsh/browser-cdp/profiles/chrome"
chromium       --remote-debugging-port=9334 --user-data-dir="$HOME/.dsh/browser-cdp/profiles/chromium"
microsoft-edge --remote-debugging-port=9332 --user-data-dir="$HOME/.dsh/browser-cdp/profiles/edge"
```

用任意端口（如 9222）也可以：`browser: "auto"` 会自动回退探测，或直接配 `cdpUrl: "http://127.0.0.1:9222"`。

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
| `stateDir` / `downloadDir` | `~/.dsh/browser-harness` | 状态文件与下载目录 |
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
| `DSH_HOME` / `BH_STATE_DIR` | 覆盖 `~/.dsh` 与状态目录位置 |

## 7. 安全提醒

- 不要把 `cdpUrl` 指向日常浏览器；专用实例的 profile 与工作 profile 分离。
- harness 探测失败会报 `E_NO_BROWSER`，不会自行启动浏览器。
