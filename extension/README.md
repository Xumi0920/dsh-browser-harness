# extension/ — 标签组运行时资产

本目录是随包发布的 **MV3 扩展运行时**，由 harness 在首次需要标签组时通过 CDP `Extensions.loadUnpacked` 装入专用浏览器 profile。

| 文件 | 说明 |
|---|---|
| `manifest.json` | MV3 清单（仅 `tabs` / `tabGroups` 权限，无 content script / host 权限） |
| `sw.js` | **构建产物**：service worker（只注册 `chrome.tabs.onCreated` 唤醒监听；实际分组由 harness 经 CDP 驱动） |

- 源码：[`extension-src/sw.ts`](../extension-src/sw.ts)
- 构建：`npm run build`（等价于 `tsc -p tsconfig.extension.json`）
- `sw.js` 已 gitignore，不要手改或提交；仓库 checkout / 本地目录安装前请先构建
- 标签组行为与排查见 [docs/tab-groups.md](../docs/tab-groups.md)
