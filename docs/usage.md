# 使用

## 在 DSH 里

插件装好后，**任意 DSH 会话/预设**都可以使用这些工具（不限于创造模式；创造模式只影响用 `plugin_manager` 安装这一步）。Agent 通过 13 个 `browser_*` 工具操作专用浏览器；插件同时内嵌 `browser-harness` 技能，给出完整工作流：

1. `browser_status` — 确认端点、浏览器版本、当前标签页；
2. `browser_navigate {url}` / `{action:"back"|"forward"|"reload"}` — 打开页面或浏览器历史导航，并拿到紧凑快照（`e1`、`e2`… 引用）；
3. `browser_wait` — 等待出现/消失、URL/文本变化、response、network_idle 或 delay，避免反复快照盲等；
4. `browser_act` — `{action:"click"|"hover"|"highlight", ref}` / `{action:"fill", selector, text}` / `{action:"type", ref, text}` / `{action:"selectOption", selector, values}` / `{action:"check"|"uncheck", ref}` / `{action:"press", key}` / `{action:"scroll", dy}` / `{action:"dialog", accept}`；可附加 `expectUrl`/`expectText`/`expectSelector`，失败返回 `E_EXPECTATION_FAILED`；
5. `browser_extract` — `text` / `html` / `js` / `network` / `console` / `frames`；`text/html/js` 可传 `frameId`/`frameUrl`；
6. `browser_snapshot`（支持 `offset`/`limit` 分页和 checked/selected/expanded 状态）/ `browser_screenshot` / `browser_pdf` 复核；`browser_diagnose` 生成失败诊断包；
7. `browser_upload` / `browser_download` 处理文件；`browser_tabs` 管理自建标签页；
8. `browser_task` 查看/暂停/恢复/关闭/重新开始当前 Task；页面操作持有 target 独占锁，跨任务冲突返回 `E_TAB_LOCKED` 或 `E_LOCK_TIMEOUT`；closed Task 需 `{action:"start"}` 新建任务壳；
9. `browser_tabs use` 非自建 tab 必须显式 `{borrow:true}`；其他 Task 自建 tab 返回 `E_TAB_OWNER_CONFLICT`。

> refs 属于产生它的快照：导航或 DOM 变化后重新 `browser_snapshot`。受控输入用 `fill`（真实聚焦键 + `Input.insertText` + `input`/`change`），`type` 只在需要逐键语义时使用。`fill` 只返回 `{ok, length, verified}`，**不回显输入值**。

- `browser_extract {mode:"js"}` 可以执行任意页面 JavaScript（`userGesture:true`），能修改 DOM/发请求，工具已标为非并发；只在你确实需要脚本时使用。
- `readOnly: true` 在工具层阻止 `browser_act`、`browser_extract js`、上传/下载、`browser_tabs new/close`、`browser_task` 变更；导航、快照、文本/HTML/network/console/frames、截图和诊断仍可用。它是页面写操作边界，不保证 GET 导航没有服务端副作用。
- `browser_tabs {action:"use"}` 只接受 page target + `http(s)`/`about:blank`；非自建页必须精确 `targetId`，URL 子串只匹配自建页。
- `browser_extract {mode:"network"}` 会对 token 类 query/headers 做尽力脱敏；正文、HTML、截图仍可能含敏感数据，别把它们当作完整脱敏。
- `browser_screenshot` / `browser_pdf` 的 `path` 是相对 `screenshotDir`（默认 `<stateDir>/screenshots`）的路径，拒绝 `..`/symlink 逃逸和覆盖已有文件。
- `browser_upload` 只接受 `uploadDir`（默认 `<stateDir>/uploads`）内的普通文件，拒绝 `..`/symlink 逃逸；`browser_download` 只写入 `downloadDir`（默认 `<stateDir>/downloads`）。
- `browser_extract {mode:"console"}` 返回最近 console/Log 事件（URL/文本尽力脱敏）；页面控制台内容本身仍可能包含敏感信息。
- `browser_act {action:"dialog"}` 仅在使用 `dialogPolicy: "manual"` 且当前有弹窗时可用；默认 `auto-dismiss` 会自动取消 confirm。
- `browser_extract {mode:"frames"}` 列出 iframe；`browser_snapshot {frameId}` 对 iframe 生成 e1… 引用，随后可直接用 ref `click/fill/type`。`browser_act {action:"highlight"}` 用 CDP Overlay 高亮元素，适合 headful 调试。
- `browser_act {action:"click"}` 在点击 ref/selector 前检查目标是否被遮挡；被遮挡返回 `E_CLICK_INTERCEPTED`。确需点击坐标或接受遮挡时用 `x/y` 或 `force:true`。
- `browser_navigate` 的 `waitUntil:"load"` 现在等待 `readyState=complete`，`domcontentloaded` 才允许 interactive；首次导航在导航前开启网络抓取，首屏请求不会漏记。
- `browser_snapshot` 的 `role/name` 过滤发生在节点上限之前；不再出现“目标在 450 个按钮最后但返回 nodes:0”。

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

源码 checkout 内先 `npm install && npm run build`，再 `import { connect } from "./dist/src/index.js"`（运行时零第三方依赖，Node 22+）。

## CLI

```sh
node dist/bin/bh.js doctor              # 列出已知端点与状态
node dist/bin/bh.js tabs                # 列出标签页
node dist/bin/bh.js open <url>          # 打开 URL（记为自建标签页）
node dist/bin/bh.js info | snapshot | text [sel] | js <expr> | shot [path]   # path 相对 screenshotDir
node dist/bin/bh.js close [targetId] [--force]
node dist/bin/bh.js groups [--retry]    # 标签组状态/列表；--retry 重试安装扩展
```

`npm run verify -- --browser chrome` 可对 live 专用浏览器做冒烟（脚本为 TypeScript，编译到 `dist-scripts/verify.js`；需源码 checkout）。

## 提示

- 登录墙：停手问人，不要输入未获授权的凭据；
- 默认后台操作，不抢前台；
- 需要登录态/交互式页面时才用浏览器，纯公开读取优先 `web_fetch`；
- 敏感页面（邮件/银行/后台）优先使用专用 profile；工具输出会进入 DSH/模型上下文，不要把 token/密码贴进 `fill` 或 `js`

扩展与语言（原生插件 JS/TS、MCP、技能、ACP）见 [extending.md](extending.md)。