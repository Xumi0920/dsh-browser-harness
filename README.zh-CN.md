# dsh-browser-harness

**DeepSeek Harness（DSH）原生浏览器工具。** 零依赖 CDP 内核，把 `browser_*` 工具挂到 DSH 上，直连一个**专用、已登录**的真实 Chrome，并提供带引用编号（e1、e2…）的无障碍树快照。

```
browser_status      端点 / Chrome 版本 / 标签页 / 当前标签页
browser_navigate    打开 URL，返回页面信息 + 快照
browser_snapshot    紧凑引用（e1…），含角色、名称、视口中心坐标
browser_act         click / type / fill / press / scroll
browser_extract     text / html / JS / network
browser_screenshot  PNG 路径
browser_tabs        list / use / new / close
```

## 为什么不用 Playwright

- **零依赖**：只用 Node 22+ 内置能力（`fetch`、`WebSocket`、`node:test`），不下载浏览器、不需要构建。
- **真实登录态**：连用户自己起好的专用 Chrome 实例（例如 9331），登录一次长期有效。
- **文本优先**：无障碍树 + ref 比“截图喂视觉模型”更准更省；截图只是可选补充。
- **场景测试**：30 个单测 + 14 个端到端场景（登录、异步渲染、多标签、iframe、Shadow DOM、下载、上传、对话框、表单校验、选择器超时、标签页被关恢复、截图、网络捕获、Cookie），全部跑在真实 headless Chrome + 本地 fixture 站上。

## 安装（DSH 0.2.1-rc.5）

```powershell
# 本地目录（创造模式 / 插件管理器）：
#   plugin_manager { action: "install_bundle", target: "G:\\path\\to\\dsh-browser-harness" }
# 或 CLI（装完重启 DSH）：
& "$env:LOCALAPPDATA\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd" `
  plugin --profile desktop add "G:\\path\\to\\dsh-browser-harness"
```

插件是 DSH bundle（`dsh.bundle.patch` → `cordis.patch.yml`），安装后在 profile 级注册 `browser_*` 工具，并内嵌 `browser-harness` 技能。

## 配置目标浏览器

默认读取 `~/.dsh/browser-cdp/registry.json`，附着到默认专用实例（`chrome`，端口 9331）。可在 patch 行覆盖：

```yaml
- insert:
    - id: browser-harness
      name: dsh-browser-harness
      config:
        browser: chrome-beta      # 或 chrome
        # cdpUrl: http://127.0.0.1:9333
        # ws: ws://127.0.0.1:9333/devtools/browser/<id>
        maxSnapshotNodes: 250
```

本插件只**探测**已运行浏览器，绝不启动、杀死或重配用户的浏览器。需要自启时手动起一个专用实例：

```powershell
chrome.exe --remote-debugging-port=9331 "--user-data-dir=$env:USERPROFILE\.dsh\browser-cdp\profiles\chrome"
```

## 独立库 / CLI（不装 DSH 也能用）

```js
import { connect } from "./src/index.mjs";
const bh = await connect({ browser: "chrome" });
const page = await bh.newTab("https://example.com");
console.log(await page.info(), (await page.snapshot()).nodes.length);
bh.close();
```

```sh
node bin/bh.mjs doctor
node bin/bh.mjs open https://example.com
node bin/bh.mjs snapshot
```

## 测试

```sh
npm test                    # 单测（无浏览器）
npm run test:integration    # 14 个场景（临时 headless Chrome）
node scripts/verify.mjs     # 对 live 专用 Chrome 冒烟
```

集成测试自起临时 profile 的 Chrome，不碰用户浏览器；找不到 Chrome 时自动跳过。

## 安全边界

- 只关闭本 harness 创建的标签页，绝不改用户标签页。
- Cookie 默认脱敏，不打印任何密钥。
- 全部后台操作，不抢前台。
- 遇到登录墙停手问人。

## 状态

v0.1.0：首个原生插件版本。下载/上传/Cookie 能力已在内核库中，但一期不作为工具暴露。

MIT © 2026 Xumi0920
