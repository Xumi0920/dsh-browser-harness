# 安全策略

## 支持的版本

| 版本 | 支持 |
|---|---|
| v1.x（当前 v1.0.0）/ 最新 Release | ✅ 接收安全报告 |
| v0.6.x（上一稳定线） | ✅ 尽力修复 |
| 更旧版本 | ❌ 建议先升级 |

## 报告漏洞

请**不要**通过公开 Issue 报告安全问题。请使用 GitHub 的私密报告入口：

- [Security Advisories / Report a vulnerability](https://github.com/Xumi0920/dsh-browser-harness/security/advisories/new)
- 或仓库 **Security** 标签页 → **Report a vulnerability**

报告时请附：受影响版本（DSH + 插件）、复现步骤、影响（读取/写入/接管/拒绝服务等）、以及最小化的脱敏证据。**不要**粘贴真实 token、Cookie、业务数据、浏览器 profile 或个人路径；需要复现时请使用脱敏样例。

### 范围

- 本仓库的插件入口、CDP 内核、工具层、安装脚本、MV3 扩展与 GitHub Actions 工作流。
- 浏览器/DSH/Electron/Chromium 自身漏洞请报告给对应上游项目。
- DSH 宿主的模型供应商、日志留存策略不在本仓库控制范围。

### 响应

- 7 天内确认收到并给出初步分级；
- 修复后通过 GitHub Security Advisory 协调披露，并在 Release Notes 中致谢（除非你要求匿名）。

## 数据处理提示

- 状态文件：`~/.dsh/browser-harness/state-<lane>.json`（URL 已去除 userinfo/query/fragment，POSIX 0600/目录 0700）。
- 截图：默认写入 `<stateDir>/screenshots/`，拒绝覆盖已有文件、不允许逃逸到目录外。
- 安装 token：一键脚本只写入临时 npm 配置；手动 `npm config set` 会持久化到 `~/.npmrc`，请安装后删除并撤销。
- GitHub Packages 只能使用 **classic PAT**（`read:packages`），不支持 fine-grained token。