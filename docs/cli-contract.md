# CLI JSON 与退出码契约

> 状态：v1.10 F6 定义；适用于 `bh` 独立 CLI。
> 目标：人读输出保持简洁，机器输出可稳定解析；错误不混入 stdout。

## 1. 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 命令成功 |
| 1 | 命令执行失败（工具错误、浏览器错误、参数校验失败、超时等） |
| 2 | 用法错误（未知命令、未知子命令） |

约定：

- 成功时 stdout 只包含命令数据。
- 失败时 stdout 为空；错误写 stderr，格式为 `<CODE>: <message>`。
- 参数校验失败按当前 CLI 约定返回 **1**；仅未知命令返回 2。
- `E_*` 错误码保持稳定，不把堆栈写到 stderr。

## 2. 输出类型

### 人读输出

- `navigate/open`：`<url>\t<title>`
- `snapshot`：格式化后的 ref 文本
- `text`：页面文本
- `tabs list`：每行 `<targetId>\t<title>\t<url>`

### JSON 输出

以下命令成功时输出**一个 JSON 对象**到 stdout：

- `status`
- `info`
- `groups`
- `close`
- `tabs new` / `tabs use` / `tabs close`
- `act`
- `wait`
- `shot` / `pdf` / `diagnose`
- `upload` / `download`
- `task`

`extract`：

- `text` / `html`：原始文本
- `js` / `network` / `console` / `frames`：JSON 对象

`snapshot --json`：

```json
{
  "targetId": "string",
  "snapshotId": "string",
  "snapshotVersion": 1,
  "generation": "1",
  "url": "string",
  "nodes": 2,
  "total": 450,
  "offset": 0,
  "limit": 50,
  "truncated": true
}
```

- JSON 模式不输出 `text` 字段（保留分页元数据）。
- `generation` 仅在同 manager/进程内有效；CLI 单次调用不保证跨进程复用。

### 工具结果 JSON

`status/info/act/wait/shot/pdf/diagnose/upload/download/task/tabs` 的 JSON 为工具层返回对象，字段由对应工具 schema 定义；CLI 不额外包裹 envelope。

## 3. 错误格式

```text
E_BAD_ARG: navigate needs a URL
E_STALE_SNAPSHOT: snapshot generation 7 is stale; take a new browser_snapshot
E_LOCK_TIMEOUT: timed out waiting for tab ...
```

- 不输出 `stack`、token、绝对临时路径。
- 诊断包路径可以出现在错误消息中（自动诊断开启时）。
- 使用 `--json` 的命令目前**不会**把错误转成 JSON；错误统一走 stderr。

## 4. 兼容性

- 现有 JSON 字段只增不减；删除/重命名视为 breaking。
- 人读输出可增加字段，但必须保持第一行可解析。
- 新增命令必须声明：成功退出码、输出类型（human/json）、错误码。

## 5. 测试

- CLI 参数校验：`tests/unit/cli.test.ts`
- CLI 退出码与 JSON 结构：integration T65
- 快照 JSON 分页：T53
- 命令帮助：T54
