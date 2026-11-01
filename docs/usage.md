# 使用

## 在 DSH 里

Agent 通过 7 个 `browser_*` 工具操作专用浏览器；插件同时内嵌 `browser-harness` 技能，给出完整工作流：

1. `browser_status` — 确认端点、浏览器版本、当前标签页；
2. `browser_navigate {url}` — 打开页面并拿到紧凑快照（`e1`、`e2`… 引用）；
3. `browser_act` — `{action:"click", ref}` / `{action:"fill", selector, text}` / `{action:"press", key}` / `{action:"scroll", dy}`；
4. `browser_extract` — `text` / `html` / `js` / `network`（最多最近 100 条请求，`includeBody` 较慢）；
5. `browser_snapshot` / `browser_screenshot` 复核；`browser_tabs` 管理自建标签页。

> refs 属于产生它的快照：导航或 DOM 变化后重新 `browser_snapshot`。受控输入用 `fill`（真实聚焦键 + `Input.insertText` + `input`/`change`），`type` 只在需要逐键语义时使用。

## 独立库（不装 DSH）

```js
import { connect } from "@xumi0920/dsh-browser-harness/core";
const bh = await connect({ browser: "chrome" });
const page = await bh.newTab("https://example.com");
console.log(await page.info(), (await page.snapshot()).nodes.length);
await page.click({ selector: "a" });
await page.screenshot({ path: "shot.png" });
await bh.close();
```

源码 checkout 内也可直接 `import { connect } from "./src/index.mjs"`（零依赖，Node 22+）。

## CLI

```sh
node bin/bh.mjs doctor              # 列出已知端点与状态
node bin/bh.mjs tabs                # 列出标签页
node bin/bh.mjs open <url>          # 打开 URL（记为自建标签页）
node bin/bh.mjs info | snapshot | text [sel] | js <expr> | shot [path]
node bin/bh.mjs close [targetId] [--force]
node bin/bh.mjs groups [--retry]    # 标签组状态/列表；--retry 重试安装扩展
```

`node scripts/verify.mjs [--browser chrome|edge|brave|...]` 可对 live 专用浏览器做冒烟（需源码 checkout）。

## 提示

- 登录墙：停手问人，不要输入未获授权的凭据；
- 默认后台操作，不抢前台；
- 需要登录态/交互式页面时才用浏览器，纯公开读取优先 `web_fetch`。
