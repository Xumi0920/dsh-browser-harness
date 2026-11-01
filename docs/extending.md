# 扩展与语言

DSH 的扩展点不止一种语言，但**原生插件是 Node ESM 模块**。按需求选：

| 需求 | 推荐方式 | 语言 |
|---|---|---|
| 给 Agent 加工具、接数据/机器学习生态 | MCP server（stdio / Streamable HTTP） | Python / Go / Rust / Node… 任意 |
| 深度集成 DSH（服务、工具、UI、生命周期） | 原生插件（bundle patch） | JS / TS（Node 22+ ESM） |
| 只加提示词/工作流 | Skill（`SKILL.md`） | Markdown |
| 让外部程序驱动 DSH Agent | ACP bridge（`dsh-acp`） | 任意（走协议） |

---

## 1. 原生插件：JS / TS（Node 22+ ESM）

DSH 用 Cordis loader 加载插件的 **ESM 模块**，插件就是普通 npm 包：

```json
{
  "name": "@local/my-plugin",
  "type": "module",
  "exports": { ".": "./index.js", "./locale/*.json": "./locale/*.json" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- 纯 JS 可以零构建；**TypeScript 需要先构建成 JS**（仓库里用 `tsc` / `tsup` 等均可）；
- UI 插件同样用 JS/TS（`@deepseek-ai/dsh-client-ui-*` 的 client 入口）；
- 插件包通过 `plugin_manager` 或 DSH 插件页安装，安装/移除会进入 HMR 队列。

### 热插拔与重启

DSH 自带 `@deepseek-ai/dsh-hmr`（模块 + profile 配置热重载）和 `@deepseek-ai/dsh-plugin-manager`。安装结果里的 `application` 字段决定是否需要重启：

| application | 含义 | 处理 |
|---|---|---|
| `applied` | 已经热生效 | 直接用 |
| `restart-required` | 本次变更不能在当前进程生效 | 按提示重启，看 `restartReason` |

`restartReason` 常见值：`no-hmr`（该 profile 只在启动时应用更改）、`package-moved`（包解析到另一个目录 / 替换了 DSH 自带包）、`host-module`（改动涉及 DSH 自身已加载模块）、`unmanaged-plugin`、`module-comparison`（需要新的 JS 模块代际）。

> 结论：**新装 bundle 通常可以热生效；替换已安装的包（升级、换目录、改本地 `link:` checkout 的代码）通常要重启。** DSH Web 插件页会直接提示「请重启 DSH 使更改生效。{原因}」，以它为准。

## 2. 其它语言：MCP（推荐给 Python / Go / Rust）

DSH 随包提供 `@deepseek-ai/dsh-mcp-client`，把外部 **MCP server** 的工具注册进模型工具列表，命名是 `mcp__<serverName>__<tool>`。MCP server 可以用任意语言实现，DSH 侧不需要安装 Python/Go 运行时插件。

在 profile patch（或一个很小的 bundle）里插入一条服务器配置：

```yaml
- insert:
    - id: mcp-python-tools
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: python-tools
        transport: stdio
        command: /absolute/path/to/python
        args: ["/absolute/path/to/server.py"]
        # failOnStartupError: true
```

远端服务用 Streamable HTTP：

```yaml
    - id: mcp-python-tools-http
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: python-tools
        transport: streamable-http
        url: http://127.0.0.1:3000/mcp
```

- Python 侧用官方 `mcp` SDK / FastMCP 暴露 tools、resources、prompts 即可；
- stdio 的 `command` 用绝对路径，HTTP 用绝对 URL；凭据用 Loader `!!js process.env.XXX` 引用，不要把 token 写进仓库或会话文本；
- 配置变更由 HMR 协调；返回 `restart-required` 时重启。

## 3. 技能（Markdown）

`SKILL.md` 通过 frontmatter 声明 `name / description / whenToUse`，正文就是操作指南。不需要语言运行时，也不会进工具列表——它进入模型的提示上下文。本插件自带的 `skills/browser-harness/SKILL.md` 就是例子。

## 4. 其它入口

- **ACP**（`dsh-acp`）：让受信程序通过标准协议创建/恢复会话、挂载 MCP servers、提交任务，适合测试运行器/外部编排；
- **Shell / CLI 工具**：已有命令行程序可先用 shell 工具调用，稳定后再包成 MCP server 或原生工具插件；
- **Subagent**：Codex / Claude Code 等子智能体由 DSH 工具层挂载，不是插件语言问题。

## 5. 为什么原生插件是 JS / TS

- 插件在**宿主进程**里被 Node 22 / V8 加载，语言由运行时决定；模型并不"执行 JS"，它只是写代码、调工具；
- 模块级 HMR、类型定义、npm 生态让 Agent 写插件/迭代最快；纯 JS 零构建，TS 提供类型安全；
- 需要 Python 时不用改插件语言：写 MCP server 即可（数据/ML 生态是 MCP 的强项）；
- 当前 DSH `0.2.1-rc.5` 没有"Python 原生插件"接口；跨语言官方路径就是 MCP（以及 ACP）。
