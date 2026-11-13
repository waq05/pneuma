# superagent（Super Agent）

一句话：把一句自然语言需求派给一个独占工作区的智能体去改代码，改完把结果连同改动摘要退回工单。

## 这个包是什么

Super Agent 的**宿主半**。界面半是 `@pneuma/ui-superagent`，两半各自独立启停：本包默认关
（[`cordis.patch.yml:7`](cordis.patch.yml#L7)），因为它一开就要建库、抢锁、起子进程；界面包默认开，
宿主没开时页面画「未启动」而不是空白。

装配面一共五处（[`index.ts:473`](index.ts#L473) 的 `apply`）：

| 装配面 | 做什么 | 位置 |
| --- | --- | --- |
| 设置分区 | `repoPath` / `maxWorkers` / `ticketTimeoutSeconds` / GitHub / 飞书 / 判定模型 | `index.ts:492` |
| 命令 | `/sa new`、`/sa list`、`/sa stop`、`/sa retry`、`/sa clean` | `commands.ts` |
| 2 秒泵 | 超时取消、到期 Eval、判定队列、出站发送 | `index.ts:873-897` |
| 服务 + 快照面 | `ctx.superagent` 五个方法与 `surfaces.superagent` | `service.ts`、`surface.ts` |
| 体检项 | `superagent/orchestrator` 与飞书各一项 | `health.ts` |

## 它怎么工作

```
来源（手动 / GitHub / 飞书）→ Trigger → 准入闸 → Eval 研判 → Decision
  → Ticket（带 Mandate）+ Assignment → WorkerExecutor
  → git worktree + 独立 Session + MiniAgent → 改代码、跑测试、git commit
  → 报告 ready / failed → outbox → 发送泵（飞书回一条、GitHub 回一条评论）
  → 快照面 surfaces.superagent → 侧栏徽标 + 工单页
```

领域规则全在 `core/`，从上游 dsh-superagent **逐文件搬**，只改 import 后缀。适配层（`adapters/`）负责把
端口接到 SQLite、DSC 的会话与工具、GitHub 与飞书。

## Model Experience

- **主会话**：不新增任何工具。新增的 `/sa` 是**用户**敲的命令（`commands.ts`），不是模型可调的工具；
  快照面与界面通道都不进模型上下文。
- **worker 会话**：每张工单一个独立会话，模型看到的是 `buildWorkerPrompt` 拼的三段模板
  （工单 / 环境 / 交付要求，[`adapters/executor.ts:238`](adapters/executor.ts#L238)）。这段提示词不在内核的
  段注册表里，所以在「系统提示」卡上是一段合成的段（`from: 'plugin:superagent'`）。
- **判定器**：配了判定模型才发一次问答请求，不配时一次网络请求都不发，行为与没有判定器一致
  （`adapters/assessor-select.ts`）。

## Known Limitations

- **worker 报告只有 `ready` / `failed` 两种**：core 定义了 6 种状态，执行器只会产出这两种
  （[`adapters/executor.ts:33-35`](adapters/executor.ts#L33-L35)）。worker 在正文里提的问题不会被识别成
  `blocked` / `waiting`，它落在摘要里，工单按 `ready` 收尾；要等人回话只能靠超时转 `failed` 再重试。
- **无人值守权限是三档简化版**：worker 钉 `workspace-write`，`deny` 档拒「放宽沙箱 / 越界」，`ask` 档改钉
  `auto-edit`。受保护文件（`AGENTS.md` 这类）与强制问人的安全钩子仍可能在无人值守时弹卡。
- **没有后台任务与子智能体**：worker 是进程内 `MiniAgent`，一轮跑完就结束；宿主一死会话就没了，靠
  「起新分配 + 恢复提示词」接续（[`runtime.ts:486`](runtime.ts#L486)）。
- **飞书不能自动发现新群 / 私聊**，也没有秒级延迟：轮询只能补收设置里点名的群，收发都走 `lark-cli` 子进程。
- **GitHub / 飞书没有真账号验收过**：代码侧就位，离线用例跑通，`@` 一次真的产出 PR 这条只能人来验。

## 行与开关

- 行 id `superagent`，包名 `@pneuma/superagent`，order 3800。
- resolution 是 overridable（`package.json` 的 `pneuma.resolution`），别的包可以盖掉这一行。
- `exports` 有 `.`、`./cordis.patch.yml`、`./package.json`、`./locale/*.json`。
- 全部退订与清理交给 `ctx.effect` 统一收口（`index.ts:873-925`），停用这一行时 cordis 自动调它：
  先停飞书、再丢 GitHub、再关运行期、最后关库。
