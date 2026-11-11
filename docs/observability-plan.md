# 可观测性补全计划（日志 / doctor / 测试）

> 本文是**执行计划**，不是已落地的设计说明。批次状态以文末表格为准；每批落地后回填证据。
> 为什么这么排、参照了谁，见 [harness-benchmark-roadmap.md](harness-benchmark-roadmap.md) 与
> [development-log.md](development-log.md) 对应日期的条目。

## 0. 决策记录（2026-11-11，用户拍板）

| # | 问题 | 决定 | 理由 |
| --- | --- | --- | --- |
| 1 | 日志默认开还是默认关 | **默认开**，级别 `info`，只记元数据不记正文 | 默认关的话，出事那一刻正好没日志，等于白做 |
| 2 | 测试框架 | **`node --test`**，不引 vitest | node 22 自带、零新依赖、与现有 `.mjs` 探针同构 |
| 3 | doctor 的形态 | **先做命令 `/doctor`**，界面页第二批再说 | 命令 TUI 可用、能贴进 issue，成本最低 |
| 4 | 顺序 | 先记录任务，暂不动代码 | — |

## 1. 现状与差距（做之前的基线）

| 项 | 现状 | 证据 |
| --- | --- | --- |
| 日志 | 只有内存环形缓冲，无落盘、无级别开关 | 全库仅 `src/packages/dsh-compat/index.ts:48` 调用过 `ctx.logger.exporter` |
| 崩溃现场 | `uncaughtException` / `unhandledRejection` 无统一处理 | 未找到集中注册点 |
| 体检 | 只有 Windows 网络沙箱一项 | `src/packages/sandbox/win/doctor.ts:39` 的 `doctorWindowsNetwork()` |
| 单测 | 无框架，只有 184 个 `*-test.mjs` + 33 个 `*-check.mjs` | `scripts/` |
| 覆盖率 | 无 | 未找到配置 |
| 请求侧 request-id | 无（`src/packages/cdp/report.ts:30` 的 `requestId` 是浏览器 CDP 的，不是模型 HTTP 的） | — |

## 2. 批 1：`@pneuma/log`

### 2.1 形态与位置

运行时插件，内置包：

```
src/packages/log/
  package.json          # name: @pneuma/log，pneuma.order 取 1（必须早于一切会打日志的包）
  cordis.patch.yml
  index.ts              # 宿主半边
  filter.ts             # 脱敏与字段白名单（可单测，不依赖 ctx）
  ring.ts               # 内存环形缓冲（可单测）
  tests/*.spec.mjs      # node --test
```

为什么不放内核：它要接管**所有** `ctx.logger` 调用，唯一入口是 cordis 的 exporter 扩展点，不需要动内核。

### 2.2 接口（已确认的用法）

`ctx.logger.exporter(patch)` 返回一个退订函数，`patch.export(message)` 收到每条日志：

```ts
const off = ctx.logger.exporter({
  levels: { default: 3 },        // 阈值语义见 src/packages/dsh-compat/index.ts:45 的注释：
                                 // 默认阈值会滤掉 warn/error，要收到必须显式放开
  export: (message) => {
    // message.type: 'debug' | 'info' | 'warn' | 'error'
    // message.name: 具名 logger 的名字（可为空串）
    // 正文用 Logger.format + defaultFormatters 还原 printf 占位符，见同一处 :50-53
  },
})
```

落地时已经读过了，结论记在这里：`LoggerLevel` 是 `ERROR=0 / WARN=1 / INFO=2 / DEBUG=3`，
派发处的判据是 `(levels[name] ?? levels.default ?? 2) < level` 就丢弃——所以「放行到 info」
写 `2`，`{ default: 3 }` 才是连 debug 一起收。`Logger.format(exporter, message)` 只读
`formatters` 与 `maxLength`，`export` 传个空实现即可。

### 2.3 落盘布局

```
~/.dsc/logs/2026-11-11/dsc-<pid>.jsonl
```

每行一条：`{ t, lvl, name, msg, ...fields }`。

- 按天分片：跨天换目录，删目录即清理。
- 按进程分文件：桌面端主进程 / utilityProcess / TUI 各写各的，不互相踩。
- 异步追加 + 100 ms 批量 flush，不阻塞主循环。

### 2.4 上限与清理

| 项 | 值 | 参照 |
| --- | --- | --- |
| 单文件轮转 | 8 MiB，切到 `.1` | codex `codex-rs/app-server-daemon/src/backend/stderr_log.rs:18-19` |
| 保留窗口 | 10 天 | codex `codex-rs/state/src/runtime/logs_maintenance.rs:10` |
| 总量预算 | 64 MiB，超了把窗口对半缩 | 同上 `:10-11` |
| 队列容量 | 2048 | codex `codex-rs/state/src/log_db.rs:56` |

### 2.5 三条硬要求

1. **脱敏先于落盘**：`sk-`、`Bearer `、`api_key=`、`Authorization:` 四类命中即替换成 `***`。漏一条就是事故。
2. **默认不记正文**：`info` 只记「谁、何时、调了什么、耗时、成败」；要看 prompt 与文件内容必须 `DSC_LOG=debug`。
3. **崩溃必须留现场**：`process.on('uncaughtException')` / `('unhandledRejection')` 里**同步** flush 一次再退出（参照 codex 把 panic 写进 tracing，`codex-rs/tui/src/tui.rs:646-652`）。

### 2.6 对外服务与用户入口

```ts
ctx.log.file()                    // 当前日志文件绝对路径
ctx.log.tail(n)                   // 最近 n 条（内存环形）
ctx.log.query({ level, since, name })
```

- `/log` 命令：打印路径、当前级别、最近 20 条（`ui.notice`）。
- 设置页新增「日志」分区：级别、打开目录、清空（`ctx.settings.registerSection`，分区 order 取 890 附近，靠「关于」）。

### 2.7 验收

```powershell
# 1) 有内容
Get-ChildItem "$env:USERPROFILE\.dsc\logs" -Recurse -Filter *.jsonl

# 2) 无密钥泄漏（期望 0 命中）
Select-String -Path "$env:USERPROFILE\.dsc\logs\*\*.jsonl" -Pattern 'sk-[A-Za-z0-9]{8}'

# 3) 轮转与预算：造 9 MiB 日志，确认出现 .1 且总量 ≤ 64 MiB

# 4) 崩溃留现场：注入一个未捕获异常，确认最后一条是 process 级 error
```

## 3. 批 2：`@pneuma/doctor`

### 3.1 形态

内置包 `src/packages/doctor/`，只提供 `/doctor` 命令（界面页留到第二批）。

### 3.2 检查项

| # | id | 查什么 | 依据 |
| --- | --- | --- | --- |
| 1 | `install` | 版本、`lib/` 产物完整性、node ≥ 22.19、桌面 exe 存在 | `package.json` 的 engines |
| 2 | `config` | `config.yaml` 能否解析、`plugins.json` 合法性、字段类型 | `config-core` |
| 3 | `auth` | key 是否配置（**只报有无，不打印值**） | — |
| 4 | `reachability` | 对配置端点发一次轻量请求并计延迟 | codex `cli/src/doctor.rs` 的 provider 检查 |
| 5 | `plugins` | 每个清单项能否 resolve、`inject` 是否满足、版本区间、加载失败原因 | `scripts/plugin-inventory-check.mjs` 已有底子 |
| 6 | `session` | `~/.dsc` 可写、残留 `.lock`、最近 5 个会话能否打开 | `src/core/session.ts` 的租约 |
| 7 | `sandbox` | 直接调 `doctorWindowsNetwork()` | `src/packages/sandbox/win/doctor.ts:39` |
| 8 | `terminal` | shell 探测结果，且能强制重探（绕开 7 天缓存） | README「默认终端可选」 |
| 9 | `disk` | `~/.dsc` 各子目录占用、日志目录占用 | codex `cli/src/doctor/disk.rs` |

### 3.3 插件化落点：检查项可注册

```ts
ctx.health.register({
  id: 'sandbox/win-network',
  title: 'Windows 网络沙箱布防',
  order: 70,
  async run() {
    return { status: 'ok' | 'warn' | 'fail', summary, detail, fix }
  },
})
```

`doctor` 只负责「收集 + 排序 + 渲染」。以后 `browser` 登记「Chromium 能否启动」、`lsp` 登记「语言服务器能否拉起」，不改 doctor 一行。

改造 `sandbox/win/doctor.ts` 作为第一个注册者：它的返回本来就是「一句话明细列表」，形状几乎不用动。

### 3.4 输出

人读版按分组，末尾一行汇总；`--json` 版同构但抹掉路径里的用户名与全部 key。

```
Pneuma Doctor 0.9.1  (win32 x64, node 22.20.0)

安装      ✓ 产物完整
配置      ✓ config.yaml 解析通过
...
插件      ✗ ui-trace 加载失败：Cannot find module './client.js'
          修复：pnpm build:ui 后重试

1 项失败，1 项警告
```

### 3.5 验收

- 故意改坏 `config.yaml` 一个字段 → `config` 项报 fail 且给出修复建议。
- 停掉一个插件产物 → `plugins` 项点名到具体包。
- `--json` 输出里 `grep` 不到任何 key 片段与用户名。

## 4. 批 3：测试层对齐

### 4.1 不做成运行时插件

测试跑在 CI，不该受宿主装配顺序影响；做成可停用插件等于给人一个「关掉测试」的开关。插件化落在**每个插件自带 spec**。

### 4.2 共享工具

`scripts/_testkit.mjs`（纯 ESM，不参与构建），已落地：

| 导出 | 干什么 |
| --- | --- |
| `readPackage(id)` | 读 `src/packages/<id>/package.json` 与 `cordis.patch.yml`，给形状测试用 |
| `loadPlugin(id)` | 从 `lib/packages/<id>/index.js` 按形状找带 `apply` 的导出 |
| `createFakeContext(seed)` | 铺齐 logger / provide / commands / settings / tools 等常用面，全部记进 `captured` |
| `mountPlugin(id, {config, seed})` | 装一个包，返回 `{plugin, ctx, captured, dispose}` |
| `expectRegistered(captured, area, name)` | 断言某个 registry 里有某个名字，失败时把现有名字一起打出来 |
| `runCommand(captured, name, args)` | 跑一条命令，收集 `ui.notice` 的文字 |
| `tick(ms)` | 等一个宏任务，给 async 处理函数用 |
| `snapshotJson(file, value, {update})` | 快照比对；`UPDATE_SNAPSHOTS=1` 刷新 |

用法：

```js
import { expectRegistered, mountPlugin, runCommand } from '../../../../scripts/_testkit.mjs'

test('apply 挂上命令与服务', async () => {
  const { captured, dispose } = await mountPlugin('log', { config: { dir } })
  expectRegistered(captured, 'commands', 'log')
  const notices = await runCommand(captured, 'log', ['5'])
  dispose()
})
```

包级测试文件放 `src/packages/<id>/tests/<id>.test.mjs`，`node --test` 与 `scripts/package-tests.mjs`
（它按 `node <文件>` 直接跑）两种方式都能跑通，因此 `check:plugin` 自动收录。

### 4.3 迁移路径

1. 新写的三个插件先配 spec；
2. 老探针不动，只要求「新代码必须有 spec」；
3. `_testkit.mjs` 稳定后再逐步迁老探针。

### 4.4 快照断什么

断**格式**，不断行为：一条落盘记录、一段渲染文本的字段形状。行为由普通断言盯。

第一批只钉了 `log` 的落盘记录形状（`src/packages/log/tests/log-record.snapshot.json`）：
字段名 `t/lvl/name/sn/msg` 一改，读日志的脚本与体检就会跟着坏，快照负责在改的那一刻红。

**会话重放快照**（2026-11-11 补上）：`scripts/_testkit.mjs` 的 `replaySession(fixture)` 把一份
会话 JSONL 复制到临时 `DSC_HOME`、把 `meta.cwd` 改写成本机临时目录，用
`createKernel({resumeSessionPath})` 重放，再导出 `permissions / mode / preset / todos / plan / plans`
六个状态键。探针 `scripts/session-replay-test.mjs` 断言这些键，并用
`scripts/session-replay.snapshot.json` 钉住整包形状。

三个坑写在 `replaySession` 的注释里：`DSC_HOME` 必须在 import 内核**之前**设好（`core/session.ts`
有模块级 `const` 直接调 `dscPath()`）；fixture 的 `cwd` 必须改写（写死 `D:\w` 在 Linux CI 上打不开）；
必须 `dispose`（否则测试进程不退出）。

## 5. 批 4：还差的补丁

| # | 内容 | 参照 | 状态 |
| --- | --- | --- | --- |
| 4.1 | 模型 HTTP 响应里的 `x-request-id` / `cf-ray` 记进错误；成功后经 `onRequestDebug` 记一行日志 | codex `codex-rs/response-debug-context/src/lib.rs:4-8` | 已落地：`src/core/http-debug.ts`，探针 9 条 |
| 4.2 | 脱敏导出包：`/doctor --bundle` 写 `.json.gz`，`--with-session` 追加会话摘要 | codex `/feedback` 附件 | 已落地：`src/packages/doctor/bundle.ts` |

### 5.1 遗留三项（2026-11-11 全部补完）

| 遗留 | 做法 | 验证 |
| --- | --- | --- |
| 成功响应里的追踪号没记 | `StreamHandlers.onRequestDebug`，在 `packages/llm` 的 `stream()` 唯一汇聚点记 debug 日志 | 探针 9 条（含成功 SSE） |
| 会话重放快照没做 | `_testkit.replaySession` + `scripts/session-replay-test.mjs` + 快照文件 | 探针 5 条 |
| 诊断包不含会话正文 | `--with-session` 显式开关，带最后 200 条事件、每条 400 字截断、过 `core/redact` | 包级测试 3 条 + 真机冒烟 |

### 5.2 第二轮补齐（2026-11-11，随差异清单核对一起做）

| 欠缺 | 做法 | 验证 |
| --- | --- | --- |
| 成功请求的追踪号只进日志，没进会话 | `packages/llm` 在 `stream()` 里 `appendNote('llm/request-id', …)`：note 只进会话 JSONL，不进提示词、不上界面 | 新探针 `llm-request-note-test.mjs` 5 条（内存 notes + 落盘 jsonl 两处都验） |
| 重放快照只钉状态键，看不到日志本身 | `replaySession` 增加日志记录序列（`log.records` / `log.types`），并断言「重放不会往日志里追写记录」 | `session-replay-test.mjs` 7 条 |

## 6. 明确不做

| 不做 | 理由 |
| --- | --- |
| SQLite 日志库 | 个人版日志每天 MB 级，JSONL 够用；多一个原生依赖不划算 |
| 默认遥测上报 / OTel | 与 roadmap `:84` 的判断一致：个人版低优先，默认上报会吓跑用户 |
| Sentry 崩溃监控 | 需要服务端，等有服务端再说 |
| doctor 的图形界面 | 第一批只做命令 |

## 7. 顺序与依赖

```
批 1（日志） ──> 批 2（doctor，读日志） ──> 批 3（testkit，给前两个配 spec） ──> 批 4
```

批 1 不先落地，批 2 只能查配置、查不了「刚才为什么崩」。

## 8. 批次状态

| 批 | 范围 | 状态 |
| --- | --- | --- |
| 1 | `@pneuma/log` + 崩溃钩子 | **已落地 2026-11-11**：`src/packages/log/`，基础包第一行（order 5），包级测试 7/7，真内核冒烟与崩溃冒烟均通过。`pnpm run check:plugin` 硬项 0 条 |
| 2 | `@pneuma/doctor` | **已落地 2026-11-11**：`src/packages/doctor/`，九项检查 + `ctx.health` 注册表 + `/doctor --json`，包级测试 9/9，真内核九项全出结论 |
| 3 | `_testkit.mjs` + spec | **已落地 2026-11-11**：`scripts/_testkit.mjs`（8 个导出），`log` / `doctor` 两份测试改用共享工具，新增落盘记录格式快照。两个包合计 19 条断言全过 |
| 4 | request-id + 导出包 | **已落地 2026-11-11**：`src/core/http-debug.ts` 抽 `x-request-id` / `cf-ray` 进 `LlmError`；`/doctor --bundle` 写 `.json.gz` 诊断包（不含密钥与正文）。两个新探针共 18 条断言 |

### 批 1 验收实况

| 验收项 | 结果 |
| --- | --- |
| 日志文件生成于 `DSC_HOME/logs/<日期>/dsc-<pid>.jsonl` | 通过（临时 HOME 真跑） |
| `sk-…` 落盘为 `sk-***` | 通过（四类外形逐条断言） |
| 写满轮转到 `.jsonl.1` | 通过（测试用 400 字节上限 + 2.4 KB 输入） |
| 过期目录整目录删、今天那份保留 | 通过 |
| 崩溃留现场（未捕获异常 → 写盘 → 退出码 1） | 通过（子进程实测） |
| `/log`、设置分区、`ctx.log` 三样都挂上 | 通过（包级测试） |
| `pnpm typecheck` / `build` / `check:style` | 全过（75 包，基础包 75 行） |

### 批 2 验收实况

| 验收项 | 结果 |
| --- | --- |
| 九项检查都能跑出结论 | 通过（`install/config/auth/plugins/session/disk/sandbox/reachability/terminal`） |
| 某单项抛错不拖垮整轮 | 通过（包级测试） |
| 重复 id 当场抛错、退订生效 | 通过（包级测试） |
| `/doctor --json` 可解析且不含家目录 | 通过（真机冒烟 + 包级测试） |
| `/doctor` 已注册且能执行 | 通过（`commands.specs()` 含 `doctor`，`run('/doctor')` 返回 true 并有输出） |
| 锁判定不误报 | 通过（只判「主人不在了」，常驻锁不算残留） |
| `pnpm typecheck` / `build` / `check:style` / `check:plugin` | 全过（76 包，硬项 0 条） |

### 批 3 验收实况

| 验收项 | 结果 |
| --- | --- |
| `_testkit.mjs` 能被两个包共用 | 通过（`log` 与 `doctor` 都改成 `mountPlugin` / `readPackage` / `expectRegistered`） |
| 两种跑法都通 | 通过（`node --test --test-isolation=none …` 与 `node <文件>` 各跑一次，均 0 退出） |
| 快照能红 | 通过（把 `lvl` 改回 `level` 试跑，快照立即失败并给出差异） |
| 合并跑两个包 | 19/19 |

### 批 4 验收实况

| 验收项 | 结果 |
| --- | --- |
| 500 响应里的 `x-request-id` 进错误对象 | 通过（本地回环服务真发一次，`error.requestId === 'req_probe_500'`） |
| 文案里带追踪号 | 通过（`（request-id req_probe_500）`） |
| 端点不给号时不硬凑 | 通过（`requestId` 为 undefined，文案不出现 `request-id`） |
| 带换行 / 超长的号被丢掉 | 通过（`scripts/http-debug-test.mjs`） |
| `--bundle` 写出可解压的 `.json.gz` | 通过（真内核，`gunzip` 后 JSON 可解析） |
| 包里不含家目录与密钥 | 通过（脱敏断言 + `excluded` 字段自述） |
| 只留最近 300 行日志 | 通过（包级测试用 500 行输入验证） |
