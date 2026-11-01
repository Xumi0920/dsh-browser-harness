# 按任务标签页分组（Chrome tab groups）

插件默认把**自己创建的标签页**收进一个按任务（DSH 会话）命名的 Chrome 标签组，避免和工作标签页混在一起。组名形如 `DSH · a1b2c3`，颜色按会话稳定分配。

## 行为与边界

- **只操作自己新建的标签页**：不移动、不改名、不关闭用户已有标签页，也不会把工作标签页拉进组；
- 同一会话的多个标签页自动加入同一个组；不同会话各自成组；
- 空组由 Chrome 自动移除；组名/颜色只在创建时设置，之后手动改名/换色不会被覆盖；
- 只关闭本 harness 创建的标签页（`browser_tabs` 默认如此，`force` 需用户明确同意）；
- 需要带界面的浏览器：headless 自动跳过且不影响开标签页；Linux 无 `DISPLAY` 时同样跳过（CI 用 xvfb 跑 headful 场景）。

## 配置

```yaml
- id: browser-harness
  name: "@xumi0920/dsh-browser-harness"
  config:
    tabGroups: true                     # 默认开；false 关闭（不再加载扩展）
    tabGroupTitle: "任务 {session}"      # 可选，支持 {session} / {lane}
    tabGroupColor: blue                 # 可选，默认按会话稳定分配
```

可用的 `tabGroupColor`：`blue` `cyan` `green` `orange` `pink` `purple` `red` `yellow` `grey`。

## 状态与排查

- `browser_status` 返回 `tabGroups: { enabled, available, extensionId, extensionPath, error }`；
- `bh groups` 打印同一份状态与当前所有组；`bh groups --retry` 清除失败冷却并重试安装扩展；
- 扩展出现在专用浏览器的 `chrome://extensions`，名称 **DSH Browser Harness Tab Groups**；不想保留可在该页面手动移除（下次使用会重新安装），或用 `tabGroups: false` 完全关闭。

| 现象 | 处理 |
|---|---|
| `available: false`、开标签页正常 | 需要带界面浏览器 / Linux 需 `DISPLAY`；装不上扩展时看 `error`，修好后 `bh groups --retry` |
| 组没有出现 | 确认标签页是插件自建的；共享/日常浏览器 profile 不会装扩展；重启 DSH 后重试 |
| 组名/颜色被改回 | 不会：插件只在创建时设置一次 |

## 实现方式

CDP 本身没有标签组 API，因此随包内置一个极小的 MV3 扩展（仅 `tabs` / `tabGroups` 权限，无 content script、无 host 权限）：

1. 首次使用时通过 CDP `Extensions.loadUnpacked` 把 `extension/` 装进专用浏览器 profile；
2. 打开新标签页会唤醒扩展的 service worker，harness 附着该 worker 会话；
3. 给**刚创建的标签页**临时设置一个 nonce 标题，让 worker 用 `chrome.tabs.query({title})` 精确定位这一页；
4. 调 `chrome.tabs.group` / `chrome.tabGroups.update` 建组或加组，随后恢复原标题。

扩展不可用或 headless 时只做降级（不建组），失败一次后 60 秒冷却，不影响开标签页。
