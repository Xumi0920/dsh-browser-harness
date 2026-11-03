# 任务生命周期与标签页锁模型

> 状态：Phase A 已随 v1.6.0 实现；严格借用/跨进程锁/context 隔离仍属后续阶段  
> 目标读者：维护者、DSH 插件集成方  
> 适用范围：共享同一浏览器 profile 的多 DSH 会话/任务

## 1. 背景与问题

当前实现按 DSH session 生成 lane，并把 `current` / `ownedTabs` 存在 state 文件中。它能避免不同会话互相覆盖“当前标签页指针”，但有三类缺口：

1. **锁缺失**：两个任务可以同时 attach 同一个 target，分别执行 click/wait/snapshot；后一个操作会改变前一个任务的引用、网络日志和页面状态。
2. **生命周期缺失**：任务只能隐式存在；没有暂停、恢复、结束清理；浏览器断线后也没有显式的回收边界。
3. **所有权只是建议**：`use` 对非自建 tab 只要精确 targetId 即可；关闭有保护，但“谁能操作哪一页”没有强约束。

标签组（tab group）只是视觉组织，不是隔离机制；同一 profile 下 cookies/登录态仍然共享。

## 2. 目标与非目标

### 2.1 目标

- 同一标签页同一时间只允许一个任务执行页面操作。
- 任务有显式状态：`active` / `paused` / `closing` / `closed`。
- 任务结束时释放锁、按策略关闭自建标签页、清理状态和标签组。
- 浏览器重启/连接断开后，能从持久化 state 恢复任务壳，拒绝失效页面并重新获取锁。
- 单任务用户行为尽量不变；跨任务冲突返回稳定错误码而不是静默交错。
- 第一版只做**单 manager 进程内锁**，为后续跨进程锁留接口。

### 2.2 非目标（v1.6）

- 不提供登录态/cookie 隔离；需要隔离时使用独立 browser context/profile（后续等级 L2/L3）。
- 不实现“多个 DSH 宿主进程共用同一浏览器”的强一致锁；第一版锁表在内存中。
- 不把标签组当作安全边界。
- 不改变 `browser_extract js` 的任意脚本执行能力；只读模式是独立议题。

## 3. 核心概念

| 概念 | 定义 |
|---|---|
| Task | 一个 DSH session 对应的生命周期单位；`taskId = lane`（如 `dsh-abc`） |
| Owned tab | 当前任务创建的标签页，`ownedTabs` 记录 targetId |
| Borrowed tab | 非本任务的 tab，需显式借用（后续严格策略；v1.6 先不默认启用） |
| Tab lease | 对某个 targetId 的排他操作权，带 token，同一任务可重入 |
| Task gate | 串行化同一任务内“解析/切换当前标签指针”的锁，避免 current 指针交叉 |
| Page operation | 任何触碰 Page 的工具行为：snapshot/act/extract/wait/screenshot/pdf/diagnose/upload/download |

## 4. 数据模型

### 4.1 持久化 Task（state v2 兼容扩展）

现有 state 文件继续作为 per-lane 状态；新增 `task` 字段，旧 v1 文件读取时补默认值，不破坏原字段：

```json
{
  "version": 2,
  "endpoint": "...",
  "current": { "targetId": "target-1", "url": "https://..." },
  "ownedTabs": [{ "targetId": "target-1", "url": "https://..." }],
  "group": { "id": 42, "title": "DSH · abc", "color": "blue" },
  "task": {
    "id": "dsh-abc",
    "state": "active",
    "createdAt": "2026-11-03T12:00:00.000Z",
    "updatedAt": "2026-11-03T12:00:00.000Z",
    "cleanupPolicy": "close-owned"
  }
}
```

`TaskRecord`：

```ts
type TaskState = "active" | "paused" | "closing" | "closed";

interface TaskRecord {
  id: string;             // lane
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  cleanupPolicy: "close-owned" | "leave";
}
```

### 4.2 内存锁表

```ts
interface TabLock {
  targetId: string;
  taskId: string;
  token: string;
  depth: number;          // 同一任务重入计数
  acquiredAt: number;
}
```

锁不持久化；进程重启后锁表为空，任务恢复后按需重新获取，避免把陈旧锁带入新进程。

### 4.3 任务内运行时表

```ts
laneGates: Map<string, Promise<void>>;   // current/ownedTabs 变更串行
locks: Map<string, TabLock>;             // targetId -> lease
```

## 5. 状态机

### 5.1 Task

```text
(不存在) --首次页面操作--> active
active --pause--> paused --resume--> active
active --close--> closing --> closed
paused --close--> closing --> closed
```

规则：

- `paused`：拒绝新的页面操作（`E_TASK_PAUSED`），不关闭标签页；释放所有 lease。
- `closing`：拒绝新操作；等待 in-flight 操作；释放 lease。
- `closed`：只允许 status，其他页面操作返回 `E_TASK_CLOSED`。
- 暂停/关闭必须通过 Task gate 等待当前操作结束，避免在操作中途抽走锁。

### 5.2 Tab lock

```text
free --acquire(task)--> held(task, depth=1)
held(task) --acquire(same task)--> held(task, depth+1)
held(task) --release(depth=0)--> free
held(taskA) --acquire(taskB)--> wait / E_LOCK_TIMEOUT
```

默认等待 `taskLockTimeoutMs = 5000`；超时返回 `E_LOCK_TIMEOUT`，包含持有者 taskId。  
`force` 不绕过标签页锁，只用于显式坐标点击等操作级逃生。

## 6. 锁获取与释放流程

`manager.withPage(sessionId, fn)`：

```text
1. 获取/创建 TaskRecord，校验 state == active
2. 获取 laneGate（串行化 current 解析）
3. 从 state.current 解析 target
4. attach Page；必要时启用网络抓取
5. 获取 targetId 的 Tab lease（taskId 可重入）
6. 执行 fn(page)
7. finally 释放 lease；释放 laneGate
```

`manager.withNavigatedPage(sessionId, url, options, fn)`：

1. 获取 laneGate、校验 active。
2. 复用现有 owned tab 或创建 about:blank 新 tab。
3. 在导航前启动 Network capture。
4. 获取目标 tab lease。
5. 执行导航，然后执行 fn。
6. finally 释放 lease、laneGate。

`browser_tabs` 的 use/new/close 先在 laneGate 内处理所有权和指针变更，再获取目标 lease；close 在释放锁后关闭 target。

## 7. 与工具层集成

- 所有页面工具改为 `manager.withPage` / `manager.withNavigatedPage` 包裹；不再直接长期持有 `pageFor()` 的 Page。
- `browser_status` 增加 `task`、`currentLock`、`ownedTabs` 摘要。
- `browser_tabs list` 增加 `ownerTask`、`lockedBy`、`leaseMode`。
- `browser_diagnose` 增加 task 状态和锁信息。
- 新增 `browser_task`：
  - `{action:"status"}`
  - `{action:"pause"}`
  - `{action:"resume"}`
  - `{action:"close", cleanup:"close-owned"|"leave"}`
- `browser_task.close` 关闭自建 tabs（默认）后清理 state；用户 tab 永不自动关闭。
- 工具并发标记：所有页面操作 `isConcurrencySafe:false`；status 可并发。

## 8. 所有权与借用（分阶段）

v1.6 先保证**锁互斥**，暂不改变现有 `use` 的非自建 tab 精确 targetId 行为；锁会覆盖所有页面操作。

后续严格策略：

| 场景 | 行为 |
|---|---|
| 本 Task 自建 tab | 直接使用 |
| 其他 Task 自建 tab | 默认拒绝 `E_TAB_OWNER_CONFLICT` |
| 用户 tab | 需 `use {targetId, borrow:true}`，产生 borrowed lease，禁止 close |
| 被借用的用户 tab | 其他 Task 拒绝 `E_TAB_LOCKED` |
| URL 子串 | 仅匹配本 Task 自建 tab |

## 9. 生命周期操作

### pause
- 获取 laneGate，等待 in-flight 页面操作完成。
- 状态置 `paused`；释放该任务所有 lease。
- 保留 current/ownedTabs/tabGroup。
- 页面操作返回 `E_TASK_PAUSED`；status 可用。

### resume
- 状态置 `active`。
- current target 若已消失则置空；不自动导航。
- 下一次页面操作重新获取 lease。

### close
1. 获取 laneGate，状态 `closing`。
2. 释放该任务所有 lease。
3. 按 cleanupPolicy 关闭 owned tabs；用户 tab 不动。
4. 清空 current/ownedTabs/group 引用。
5. 状态 `closed`；重复 close 幂等。
6. 保留 state 文件作为 tombstone 或按配置删除；默认保留 task.state=closed，便于审计。

## 10. 浏览器重启/断线恢复

- 连接断开：清空内存锁、Page 缓存；Task 状态保留。
- 重连：
  1. 读取 state task；
  2. `Target.getTargets` 核对 current/ownedTabs；
  3. 不存在 target 从 Task 中移除；
  4. 锁表为空，下一次操作按需获取。
- 不自动恢复旧 URL；只恢复 current targetId（如果仍存在）。
- 若 target 被另一个 manager 锁住：正常 `E_TAB_LOCKED`。

## 11. 隔离等级

| 等级 | 机制 | 隔离内容 | 状态 |
|---|---|---|---|
| L1 | Tab lease + Task ownership | 页面操作并发/指针冲突 | v1.6 实现 |
| L2 | `Target.createBrowserContext` per Task | cookies/storage/cache | 后续 |
| L3 | 每 Task 独立 browser/profile | 进程/登录/扩展/缓存 | 后续 |

标签组 ≠ 隔离；L1 不能阻止两个任务读取同一登录态。

## 12. 错误码

| code | 含义 |
|---|---|
| `E_TAB_LOCKED` | 锁被另一 Task 持有 |
| `E_LOCK_TIMEOUT` | 等锁超时 |
| `E_TASK_PAUSED` | 任务已暂停 |
| `E_TASK_CLOSING` | 任务正在关闭 |
| `E_TASK_CLOSED` | 任务已关闭 |
| `E_TAB_OWNER_CONFLICT` | 严格所有权阶段：其他任务拥有该 tab |
| `E_TAB_BORROW_REQUIRED` | 严格所有权阶段：非自建 tab 未显式借用 |

## 13. 测试策略

单元：

1. 锁互斥、同任务重入、释放、超时。
2. 两个 lane 并发 `withPage`：一个成功一个 `E_TAB_LOCKED/E_LOCK_TIMEOUT`。
3. pause 后操作 `E_TASK_PAUSED`；resume 恢复。
4. close 只关闭 owned tabs；用户 tab 不动；重复 close 幂等。
5. state v1→v2 迁移；closed task 状态持久化。
6. 浏览器重启：current 丢失后任务仍可 status，页面操作要求重新导航。
7. withPage 的 lease 在异常路径也释放。

集成：

8. 两个 DSH session 并发操作同一 tab，第二个收到锁错误。
9. 两个 session 各自新建 tab 并行操作互不阻塞。
10. 关闭 session 后 owned tab 被关闭，用户 tab 保留。
11. pause/resume/close 的真实工具流程。

## 14. 实施阶段

### Phase A（v1.6 本版）
- `src/tasks.ts`：TabLockManager + task helpers。
- state v2 兼容字段 + TaskRecord 读写。
- Manager `withPage/withNavigatedPage`，工具接入。
- `browser_task` status/pause/resume/close。
- 单 manager 进程内锁；严格借用策略暂不启用。

### Phase B（后续）
- 严格所有权/借用、`borrow:true`。
- 跨进程锁（state 文件租约 + pid/heartbeat）。
- Task context/profile 隔离（L2/L3）。

## 15. v1.6 Phase A 实现状态

已实现：

- state v2 兼容字段 `task`，旧 state 自动补 `id/state/createdAt/updatedAt/cleanupPolicy`；
- `src/tasks.ts` 的 `TabLockManager`：按 target 独占、同任务重入、等锁超时、任务级批量释放；
- `BrowserManager.withPage` / `withNavigatedPage`：lane gate + target lease；
- 所有页面工具接入锁；`browser_task` 提供 status/pause/resume/close；
- pause 释放 lease；close 默认关闭 owned tabs 并写 `closed` tombstone；
- 单测覆盖锁互斥/重入/超时、任务状态、集成覆盖跨 session 锁与 pause/resume/close。

尚未实现（保留为 Phase B/C）：

- 非自建 tab 的严格 `borrow:true` 策略与 `E_TAB_OWNER_CONFLICT`；
- 跨 manager 进程的文件租约/心跳；
- L2 browser context / L3 独立 profile 隔离；
- 浏览器重启后的 target 级自动恢复测试（当前仅清理锁、按 state 重新解析）。

## 16. 已选默认值

- 锁等待 `5000ms`，超时返回 `E_LOCK_TIMEOUT`。
- Task 结束默认 `cleanupPolicy:"close-owned"`。
- `pause/resume/close` 通过 `browser_task` 暴露；页面工具默认不暴露。
- v1.6 只做单 manager 内存锁；跨进程和 context/profile 隔离明确延后。
