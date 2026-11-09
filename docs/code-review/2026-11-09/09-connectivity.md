# 批次 09：连接与外部工具

> 审查口径见 `docs/code-review/2026-11-09/00-审查口径.md`。只读审查：未改任何源码，未跑 install / build / typecheck / 测试。
> 分支 `feat/pluginization`。**本批范围内的文件在 `git status` 里没有在途改动**（30 个在途文件全在 `ui-*` 与文档），因此下面行号都是工作区当前内容。
> 批次 03 已报的「host-stdio 无实参校验 vs webserver 有校验」、批次 90 第 1/7 节的「58 个 core 垫片与门禁盲区」不重复；本批只补它们没覆盖的第三、第四条通道，以及各模块「现在谁在用」。

## 范围

实际读过的文件（按包）：

- **mcp**：`src/packages/mcp/mcp.ts`（全文 1077 行）、`index.ts`（全文 772 行）、`package.json`、`README.md`、`cordis.patch.yml`
- **lsp**：`client.ts`（全文 879 行）、`manager.ts`（全文 489 行）、`framing.ts`（全文 186 行）、`servers.ts`（全文 396 行）、`index.ts`（结构 + 417–540 段）、`normalize.ts`/`uri.ts`/`line-shift.ts`（只读文件头与导出面）
- **ops**：`index.ts`（全文 231 行）、`worker.ts`（全文 324 行）、`tools.ts`（全文 649 行）、`render.ts`（全文 312 行）
- **webserver**：`index.ts`（全文 354 行）
- **remote**：`index.ts`（178–398、490–621 段 + 结构扫描）、`routes.ts`（全文 413 行）、`http.ts`（全文 22 行）、`types.ts`（方法表声明段）
- **host-stdio**：`index.ts`（全文 445 行）
- **git**：`src/packages/git/index.ts`（全文 208 行）、`src/core/git-exec.ts`（全文 75 行）、`src/core/git-info.ts`（440–511 段 + 结构扫描）、`src/core/git-surface.ts`（全文）
- **schedule**：`src/packages/schedule/index.ts`（全文 599 行）、`src/core/schedule/runner.ts`（结构 + 1–120 段）、`rule.ts`（导出面与 574 行）、`store.ts`（导出面）
- **web-search**：`index.ts`（1–120 段 + apply 结构）
- **core 共用层**：`ui-server.ts`（280–511）、`ui-events.ts`（250–319）、`web-http.ts`（全文）、`snapshot-throttle.ts`（全文）、`host-methods.ts`（头部）、`native-bridge.ts`（1–120 + NATIVE_OPS）
- **垫片**：`src/core/mcp.ts`、`src/core/lsp/*`（7 个）、`src/core/ops/*`（3 个）、`src/core/remote/*`（8 个，逐个读导出面与引用）
- **对照（只读调用关系）**：`src/core/tools/fs-tools.ts`（全文 254 行）、`src/packages/tools-default/search-tools.ts`（glob/grep 注册段）、`src/packages/desktop-dock/index.ts`（395–510 段 + git 分支 grep）、`desktop/electron/main/index.ts`（359–430、840–880、1138–1240）、`desktop/electron/preload/index.ts`（全文）、`src/core/plugin-loader.ts`（1289–1310）

## 结论摘要

- **P0 × 1 / P1 × 9 / P2 × 6**（共 16 条）
- 最重要的一条：MCP 的启动命令解析在 Windows 上**先撞无后缀的 `npx`/`npm` shell 包装脚本**，然后以 `shell: false` 交给 `spawn`，于是设置页给的官方示例 `"command": "npx"` 起不来（`mcp.ts:308-311`）。LSP 那边已经把这个坑修过（`servers.ts:150-154` 明确注释了同一个现象），但修好的那份没被 MCP 用上。
- 第二条：`webserver` 与 `remote` 是**两台各写一遍的界面服务器**——引导、路由表、凭据闸、错误应答各一份，只有 `ui-events`/`ui-route`/`ui-server` 的几个函数被复用；而且两份启动图已经漂移（手机那份没有 `host.language`，也没有 `ask` 通道）。
- 第三条：`invoke` 现在有四条通道、四种闸门（`host-stdio` 无校验、本机 HTTP 有校验+附件净化、远程 HTTP 有校验无净化、远程 WS 只查方法名），而桌面页里还留着一条没有消费者的通用 `window.dsc.invoke`，直通最宽的方法面。

## 八个问题的直接回答

1. **共用的是函数，各写一遍的是「一台服务器」。** 共用：`createUiEvents`（`webserver/index.ts:175`、`remote/index.ts:574`）、`resolveUiResourceRequest`（`ui-server.ts:427`、`routes.ts:375`）、`injectBootScriptTag` + `UI_CONTENT_SECURITY_POLICY`（`ui-server.ts:281/486`、`routes.ts:403-404`）、`serveStatic`（`web-static.ts`）、`sendJson`/`readCookie`（`web-http.ts`）。各写一遍：HTTP 引导与错误兜底（`ui-server.ts:326-333` vs `remote/index.ts:269-277`）、路由表（`ui-server.ts:389-492` vs `routes.ts:304-412`，重叠 `/api/boot`、`/boot.js`、`/plugins/*`、`/api/events`、`/api/invoke` 五条）、凭据（一次性令牌+HMAC 签名 Cookie，`ui-server.ts:296-385` vs 设备 token + 明文 Cookie，`routes.ts:184-191`）、错误应答（纯文本 `sendText` vs JSON `sendJson`）。逐条行号见 F8。
2. **两条链都活着，但用途已经分开，死的是「通用 invoke」。** 本机 HTTP 那条的调用方是页面自己（`ui-events` 的 `/api/invoke`，方法面 `UI_METHODS` + `validateUiArgs`）；`host-stdio` 那条的调用方是**桌面主进程**，只用于主进程代转的特权写（`setPolicy`/`saveProvider`/`installMarketSkill`/`dock`，`desktop/electron/main/index.ts:1148-1230`）。桌面窗口加载的是 webserver 的页面，所以页面自己的读与普通调用走 HTTP；`host-stdio` 只是在旁边当「主进程 → 宿主」的转发器。真正的死链是 `window.dsc.invoke` → `dsc:invoke`（`preload/index.ts:19-20`、`main/index.ts:859-862`）：全仓没有任何页面代码调用它，`dsc:snapshot`/`dsc:ui` 两条推送也没有消费者，但三条都还挂着（见 F13）。
3. **只有「环境变量白名单」和 `buildChildEnv` 共用，其余逐项都是两份。** 分帧必须两份（换行 vs `Content-Length`，协议不同）；但 stderr 尾巴两份（`mcp.ts:530` 字符串截 2000 字符 vs `framing.ts:147-186` 字节环形缓冲 1MB）、启动命令解析两份（`mcp.ts:298-316` vs `servers.ts:133-162`，候选顺序和「找不到怎么办」都不同）、环境变量按名读取两份（`mcp.ts:267-276` vs `servers.ts:165-174`）、超时/取消三份（mcp 只 reject 请求不杀进程、lsp 发 `$/cancelRequest` 再杀树、ops 直接杀）、重连三份（插件层指数退避 / 管理器破键退避 / 每条调用起一个新进程）。逐项见 F1、F2、F3、F4。
4. **围栏共用，上限、并发锚、diff 与行号视图各一套；同一个文件用两族工具改，结论会不同。** 围栏都走 `core/path-policy`（`fs-tools.ts:98/171`、`ops/tools.ts:48/87`），「先读后写」台账也共用（两族都调 `noteRead`/`noteWrite`）——这两条是好的。不同的是：fs 的 `write`/`edit` 用 mtime 做并发锚（`fs-tools.ts:181-184`、`242-245`），ops 用 SHA-256 修订号（`ops/tools.ts:102-120`、`435`）；fs 的 `read` 有 16000 字符硬顶与单行 2000 字符截断（`fs-tools.ts:20-22`、`133`），ops 只受 128KiB 输出顶（`worker.ts:38`）；diff 有三份产物（`core/diff-text.ts` 的 `diffLines`→`summarizeChange`、`ops/render.ts:163-188`、`core/git-info.ts` 的 `git diff` 原文）。逐项见 F6。
5. **`git status` 有三处在跑，porcelain 解析两套，脏文件计数与分支读取各两套。** `git` 插件按 12/30 秒轮询（`git/index.ts:129`），`desktop-dock` 每次面板请求跑一次（`desktop-dock/index.ts:418`），`core/git-info` 每回合首尾各跑一次（`git-info.ts:450`，且不带 `-z`）。解析分 `-z` 版（`git-exec.ts:45-56`）与按行版（`git-info.ts:460-468`）；脏计数规则相同但循环写了两遍（`git/index.ts:132-134` vs `desktop-dock:423-427`）；分支读取在 detached 时给的答案不同（`git/index.ts:119-127` 给短 sha，`desktop-dock:411-413` 给 `'HEAD'`）。见 F7。
6. **schedule 是「实现 + 插件壳」，只有一份。** 定时器重排、6 小时分段、catch-up、宽限、`.lock` 全在 `core/schedule/runner.ts`（`start`/`tick`/`processDue`/`recoverPending`），时区与 DST（gap 跳过、overlap 取早）只在 `core/schedule/rule.ts`，插件只做装配与文案。唯一重复是插件壳内部：`schedule` 工具（`index.ts:285-359`）与 `/schedule` 命令（`366-442`）各自把 create/update/pause/resume 的参数解析与分支写了一遍（见 F15）。
7. **`core/remote/*` 是这些东西的实现层，`packages/remote/*` 是服务与装配层，所有权清楚、没有第二份实现。** 帧 hub（`frames.ts`）、配对（`pairing.ts`）、票据（`tickets.ts`）、上传（`uploads.ts`）、推送（`push.ts`）、主控锁（`owner.ts`）、落盘（`store.ts`）都只在 core，插件只 import。唯一重复在包内：`deviceOf`（`routes.ts:139-142`）与 `authenticated`（`remote/index.ts:617-619`）是同一条「Bearer → Cookie → verifyToken」判定写了两遍（见 F12）。`remote-web/src/lib/reduce.ts` 按口径要求不评。
8. **活代码与死垫片要分开看。** 活：`core/schedule/*`（`packages/schedule` 经 `@pneuma/runtime/core/schedule/*` 引用，是唯一实现）、`core/remote/*`、`core/git-exec.ts`、`core/git-info.ts`、`core/git-surface.ts`。死：`core/lsp/*` 7 个**零引用**（全仓只有 7 处 `@module` 注释提到 `dsc/core/lsp/*`），`core/ops/*` 3 个只剩自检脚本经 `lib/core/ops/*` 用；`core/mcp.ts` 1 个仍被 `lsp/manager.ts:16` 运行时引用（见旧/新双路径清单）。

---

## 按插件分节

### mcp

#### [F1][P0] Windows 上 `command: "npx"` 必然起不来：候选顺序先撞无后缀 shell 包装脚本，再以 `shell:false` 交给 spawn
- 位置：`src/packages/mcp/mcp.ts:298-316`（关键 `308-311`）、`src/packages/mcp/index.ts:678`（设置页示例）、对照 `src/packages/lsp/servers.ts:150-159`（已修好的同一段逻辑）
- 现象：`resolveCommand` 对 PATH 里每个目录先试**无后缀**的 `root`，再试 `root + PATHEXT`。Windows 的 Node 安装目录同时有 `npm`/`npx`（bash 脚本，2KB 文本）与 `npm.cmd`/`npx.cmd`，`existsSync` 对前者为真，于是返回 `{ file: '…\npx', shell: needsShell('…\npx') === false }`，`spawn` 一个文本文件在 Windows 上必然失败（EINVAL/ENOEXEC）。LSP 的那份实现把带后缀候选排到前面，并在注释里写明了原因（「先撞上它就会错过同目录下真正能跑的 npm.cmd」），但 MCP 没回灌。
- 证据：
  - `mcp.ts:308-311`
    ```ts
    for (const root of roots) {
      for (const candidate of [root, ...suffixes.map((suffix) => root + suffix)]) {
        if (existsSync(candidate)) return { file: candidate, shell: needsShell(candidate) }
      }
    ```
  - `servers.ts:151-154`
    ```ts
    // Windows 上带后缀的候选要排在无后缀**前面**：PATH 里无后缀的 `npm` 往往是 sh 包装脚本，
    // statSync 认得出它是文件（isRunnable 放行）却没法被 spawn；先撞上它就会
    // 错过同目录下真正能跑的 npm.cmd，返回一个起不来的目标。
    const candidates = windows ? suffixes.map((suffix) => root + suffix).concat(root) : [root]
    ```
  - `mcp/index.ts:678`（设置页占位符，就是官方推荐写法）：
    ```
          placeholder: '[{"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_TOKEN":""}}]',
    ```
  - 本机只读核对（`Get-Command npx -All`、`Get-ChildItem <node 目录>`）：同一目录下 `npx`（2073 字节）、`npx.cmd`（538 字节）、`npx.ps1` 三份并存；`npx` 与 `npx.cmd` 在两处 PATH 目录都成对出现。
- 影响：所有按文档示例写的 MCP server 在 Windows 上起不来，走「连接失败 → 指数退避重连 5 次 → 放弃」这条链（`index.ts:586-608`），用户看到的是「连不上」而不是「命令解析错了」。而且只要 PATH 里有同名无后缀文件，`resolveCommand` 的兜底分支（找不到就 `shell:true`，`mcp.ts:313-315`）就不会被走到——它会带着一个 `shell:false` 的文本文件去 spawn。
- 建议：把 `servers.ts:133-162` 的 `resolveExecutable` 抽到 `src/core/process-launch.ts`（顺带把 `isRunnable` 的 X_OK 检查带过来），`mcp.ts` 的 `spawnStdio` 改调它；MCP 的「找不到时交给 shell 试」保留为调用方策略（`plan === undefined` 时再 `shell:true`），不要写进解析器。补一条探针：`resolveCommand('npx', env, cwd).file` 必须不是无后缀文件。
- 置信度：高（候选顺序、`existsSync` 命中、同目录文件存在性都已核对；`spawn` 那一步未实跑，见待核实 1）

#### [F2][P1] 三个外部子进程客户端各写一套「超时/取消/收尸」，ops 的 worker 还整份继承 `process.env`
- 位置：`src/packages/mcp/mcp.ts:561`、`530`；`src/packages/lsp/client.ts:297-316`、`374-391`；`src/packages/ops/worker.ts:232`、`250-272`
- 现象：
  - **取消语义三样**：mcp 只把挂着的请求 reject 掉，子进程继续活着（下一次调用可能打到同一个已经半死的连接）；lsp 先发 `$/cancelRequest`、宽限期到了再杀整棵进程树；ops 每次调用起一个新进程，超时直接 `taskkill /T /F`。
  - **杀进程树两份**：`client.ts:374-391` 用 `spawnSync('taskkill', …)` 且失败退回 `child.kill()`；`worker.ts:250-268` 用异步 `spawn('taskkill', …)` 并挂 `error` 兜底。
  - **环境白名单只覆盖了两家**：`mcp.ts:64-80` 定义 `BASE_ENV_NAMES` 并写明「`process.env` 里有用户的模型 key 与各种令牌，MCP server 是第三方程序，没有理由让它看见」；lsp 经 `core/mcp.js` 复用同一份（`manager.ts:16`、`90`）。ops 的 spawn **不传 env**，于是第三方 exe 拿到宿主整份环境。
- 证据：
  - `worker.ts:232`：`child = spawn(file, [], { cwd: options.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })`
  - `mcp.ts:68-69`：`export const BASE_ENV_NAMES: readonly string[] = [` / `  'PATH',`（白名单开头）
  - `mcp.ts:65`：` * 其余一律不传：\`process.env\` 里有用户的模型 key 与各种令牌，MCP server 是第三方程序，`
  - `client.ts:308`：`        this.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } })`
  - `mcp.ts:561`：`      const gate = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])`
  - `worker.ts:60-61`（自承风险边界）：` * 注意：这里只认路径，不做二进制身份校验——dsh-ops 的 provenance 校验在它自己的 JS 里，` / ` * Rust 侧只读 stdin。所以「显式配置的路径」等于用户授权起哪个 exe，别在文案里假装校验过。`
- 影响：ops 是「用户填路径就能起任意 exe」的能力（`worker.ts:81-85`），却比 MCP 更信任子进程——同一份宿主环境里，MCP 看不见的令牌 ops worker 全看得见。另外 mcp 取消后连接状态不可知：`StdioChannel.alive`（`mcp.ts:550-552`）只看进程退没退，被取消的请求在 server 侧还在跑，下一轮 `tools/list` 可能拿到错位结果。
- 建议：①`worker.ts` 的 spawn 改成 `env: buildChildEnv([], {}, process.env)`（或更窄，只给 PATH/SystemRoot/TEMP），与 mcp/lsp 一个口径；②把「Windows 杀进程树」抽成 `src/core/process-kill.ts` 的 `killTree(child, {force})`，三处共用；③mcp 的取消加一条与 lsp 同款的宽限：先 `notifications/cancelled`，宽限期内不结账就 `close()` 整条连接。
- 置信度：高（三处实现都逐行读过）

#### [F3][P2] stderr 尾巴与环境变量读取各写两遍，且两处上限单位不同
- 位置：`src/packages/mcp/mcp.ts:530`、`60-61`、`267-276`；`src/packages/lsp/framing.ts:147-186`、`src/packages/lsp/servers.ts:165-174`
- 现象：mcp 把 stderr 拼成字符串再 `slice(-STDERR_TAIL_MAX)`（2000 **字符**）；lsp 用 `StderrTail` 做字节环形缓冲（1MB **字节**）再 `tailLines(30)`。同一个「给一句为什么起不来」的需求，两套容量与两套截断单位。环境变量按名读取（Windows 变量名不分大小写）也各写一份，逻辑逐字同构。
- 证据：
  - `mcp.ts:530`：`this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_MAX)`
  - `mcp.ts:61`：`const STDERR_TAIL_MAX = 2000`
  - `framing.ts:24`：`export const MAX_STDERR_TAIL_BYTES = 1024 * 1024`
  - `servers.ts:165-166` 与 `mcp.ts:267-268`：两处都是 `const direct = env[name]` / `if (direct !== undefined) return direct`，后面都是 Windows 小写重试
- 影响：MCP server 起不来时只留最后 2000 个字符（约几十行日志），LSP 留 1MB 字节再取最后 30 行；同一段 stderr 在两个客户端能留下的行数差一到两个数量级，排查时「看到的原因」取决于哪个插件先报错。两份 `readEnv` 已经有分支差异风险（mcp 版本对 `process.platform` 直接判断，lsp 版本可以传入任意 env 对象）。
- 建议：`StderrTail` 上移到 `src/core/`（与 `err-text.ts` 同层），mcp 改成用它；`readEnvValue` 收进 `src/core/env.ts` 一份，两边 import。
- 置信度：高（四处原文都读过）

### lsp

#### [F4][P1] `buildChildEnv` 与 `resolveExecutable` 分居两层：一份在 core 垫片后面被复用，另一份在包内被复制
- 位置：`src/packages/lsp/manager.ts:16`、`90`；`src/core/mcp.ts:1`；`src/packages/lsp/servers.ts:133-162`
- 现象：环境白名单这条走的是「lsp → `../../core/mcp.js` → `../packages/mcp/mcp.js`」，功能包 lsp 经由 core 反向够到功能包 mcp（批次 90 第 7 节已从门禁角度报过这条相对路径漏检，这里补的是运行时后果）：**mcp 一旦改 `BASE_ENV_NAMES`，lsp 的子进程环境随之变化，而 lsp 的模块文档没有任何地方声明这个依赖**。命令解析这条更直接：`servers.ts` 复制了一份 `resolveCommand` 的实现并自行演进，于是同一台机器上 MCP 与 LSP 对「`npx` 该怎么起」给出相反答案（F1）。
- 证据：
  - `manager.ts:16`：`import { buildChildEnv } from '../../core/mcp.js'`
  - `manager.ts:90`：`this.env = options.env?.() ?? buildChildEnv([], {}, process.env)`
  - `src/core/mcp.ts:1`：`export * from '../packages/mcp/mcp.js';`
  - `servers.ts:12-15`（模块注释自承是复制）：
    ```
     * 可执行文件解析照 `src/core/mcp.ts` 的 `resolveCommand`（Windows 上 Node 只执行 PE 文件，
     * `spawn('typescript-language-server')` 明明 PATH 里有 `.cmd` 也会 EINVAL）。差别只有一处：
     * 那边找不到就交给 shell 去试，这里找不到就是**这个服务器不注册**——LSP 多一条「猜错了」的情况，
     * 不如把「PATH 里没有它」当成一个可解释的降级原因直接告诉模型。
    ```
- 影响：改 MCP 的环境白名单会静默改掉 LSP 的启动环境（例如把 `COMSPEC` 移出白名单，`cmd.exe` 派生的 `.cmd` 服务器全起不来，但报错会出现在 lsp 的日志里）；改 `resolveCommand` 的候选顺序修 F1 时，LSP 那份不会跟着变，两边继续分叉。
- 建议：新建 `src/core/process-launch.ts`，放 `BASE_ENV_NAMES`/`buildChildEnv`/`readEnv`/`resolveExecutable`；mcp 与 lsp 都从它 import（不走 `core/mcp.ts` 垫片）；`servers.ts` 只保留「找不到返回 undefined」的策略包装。这条与批次 90 的处置建议 3 是同一个动作，可以合并做。
- 置信度：高（引用链已逐跳核对）

#### [F5][P2] `src/core/lsp/*` 7 个垫片零引用，而 `src/packages/lsp/*` 的 `@module` 仍写着 `dsc/core/lsp/*`
- 位置：`src/core/lsp/client.ts:1` 等 7 个文件；`src/packages/lsp/client.ts:26`、`framing.ts:14`、`line-shift.ts:11`、`manager.ts:11`、`normalize.ts:12`、`servers.ts:17`、`uri.ts:28`
- 现象：7 个垫片的内容都是一个 `export * from '../../packages/lsp/x.js'`，全仓**没有任何 import 指向它们**（`src`/`scripts`/`ui-shell/src`/`desktop/electron`/`remote-web/src` 全扫过，命中项全部是 7 处 `@module` 注释）。也就是说：垫片是死的，但包内每个文件的模块注释都还在把读者指向 `dsc/core/lsp/*`。
- 证据：
  - `src/core/lsp/client.ts:1`：`export * from '../../packages/lsp/client.js';`
  - `src/packages/lsp/client.ts:26`：`* @module dsc/core/lsp/client`
- 影响：新人按注释去 `src/core/lsp/` 找实现，读到的是转发行；搜「谁在用 core/lsp」会得到 7 条注释误报。批次 90 把这类垫片按数量统计过（子目录 33 个零引用），本批补的是**每个模块现在到底谁在用**：lsp 的 7 个是零。
- 建议：删 7 个垫片；包内 `@module` 改成 `dsc/packages/lsp/x`（与 `packages/mcp/mcp.ts` 的 `@module dsc/core/mcp` 一起改，见下条清单）。
- 置信度：高（全仓检索 + 逐文件内容核对）

### ops

#### [F6][P1] 两族文件工具的并发锚、输出上限、diff 与行号渲染各一套，同一个文件用两族改会得到不同结论
- 位置：`src/core/tools/fs-tools.ts:20-22`、`130-144`、`181-184`、`242-245`、`52-72`；`src/packages/ops/tools.ts:102-120`、`435`；`src/packages/ops/render.ts:94-99`、`163-188`；`src/packages/ops/worker.ts:38`
- 现象：
  - **并发锚**：内置 `write`/`edit` 用 mtime（读前 `stat`、写前再 `stat`，差 >1ms 就拒绝）；`ops_write_file`/`ops_edit_file` 用 worker 算的 SHA-256 修订号。外部程序只碰了 mtime 没改内容时，fs 拒绝、ops 放行；反过来 ops 的 `expectedRevision` 不传时是「现在」的版本（`tools.ts:93-97` 自己写明「防不住模型拿旧印象来写」），而 fs 的 `write` 要求「必须先 read 过」（`staleOverwriteReason`）——两道闸的语义不能互相替代。
  - **输出上限**：fs `read` 是 16000 字符 + 单行 2000 字符截断 + 最多 10000 行；`ops_inspect_local_file` 只受 worker 的 128KiB 输出顶（`worker.ts:38`），`limit` 上限 10000 行但没有字符顶。
  - **diff**：fs 侧 `summarizeChange` 把 `diffLines` 的结果裁到 800 行（供轮尾卡）；ops 侧 `renderDiff` 画 `+行号\t正文` 并带 `nextOffset`；`core/git-info.ts:180` 又直接落 `git diff` 原文。
  - **行号视图**：`fs-tools.ts:137` 是 `` `${start + index}\t${shown}` ``，`render.ts:96-98` 是 `` `${String(head)}\t${oneLine(item.text)}` ``——同一种格式两个实现，控制字符处理也不同（前者原样，后者转义）。
- 证据：
  - `fs-tools.ts:182`：`if (anchorStat !== null && (beforeWrite === null || Math.abs(beforeWrite.mtimeMs - anchorStat.mtimeMs) > 1)) {`
  - `ops/tools.ts:435`：`const revision = typeof args.expectedRevision === 'string' && args.expectedRevision !== '' ? args.expectedRevision : await revisionOf(options, path, ctx)`
  - `fs-tools.ts:20`：`const READ_MAX_CHARS = 16_000`
  - `worker.ts:38`：`export const OPS_MAX_BYTES = 128 * 1024`
  - `render.ts:96-97`：`const head = hex ? (item.offset ?? '?') : (item.line ?? '?')` / `` return `${String(head)}\t${oneLine(item.text)}` ``
- 影响：模型对同一个文件会拿到两种「改了多少」的叙述（`+12` 与「修订 abc→def」），而两族的「先读后写」台账是共用的——所以台账认为「读过」，锚却可能拒绝，报错文案指向不同工具，排查时要在两套语义间翻译。改一处上限（例如把 read 的字符顶调到 32k）不会影响 ops，模型会看到 `read` 截断而 `ops_read_files` 不截断。
- 建议：①把「一个文件此刻的修订号」收成 `core/file-revision.ts` 的一个函数，mtime/size/sha 都由它给，两族工具各自取自己需要的字段；②`formatNumberedLines(items, {unit:'line'|'offset'})` 抽进 `core/tools/`，`render.ts` 与 `fs-tools.ts` 共用；③在 `read` 与 `ops_inspect_local_file` 的工具描述里各写一句「另一族的截断点不同」，避免模型把截断当文件结束。
- 置信度：高（两族实现全文读过；「结论不同」是静态可判定的语义差异，未实机对比输出）

### git

#### [F7][P1] 同一工作区三处各跑 `git status`，porcelain 解析两套，脏计数与分支读取各两套且语义已分叉
- 位置：`src/packages/git/index.ts:118-135`；`src/packages/desktop-dock/index.ts:408-433`、`464-473`；`src/core/git-info.ts:445-457`、`459-468`；`src/core/git-exec.ts:45-56`
- 现象：
  - **跑几遍**：`git` 插件按 12s/30s/60s 三档轮询（`git/index.ts:129`）读分支与脏计数；`desktop-dock` 的 `git-status` 每次面板请求跑一遍（`desktop-dock:411-433`）；`core/git-info` 每回合首尾各跑一遍（`git-info.ts:450`）。前两处都用 `--porcelain=v1 -z`，第三处用 `--porcelain=v1 --untracked-files=all` + `-c core.quotePath=false`。
  - **解析两套**：`parsePorcelainZ` 按 NUL 切、rename 时跳过紧邻的下一条记录；`parsePorcelain` 按行切、遇到 ` -> ` 取右半边、再去掉首尾引号。同一份 porcelain 格式，两条互不调用的路径。
  - **脏计数两遍**：规则相同（`toWorkspacePath !== null`），循环写了两遍（`git/index.ts:132-134`、`desktop-dock:423-427`）。
  - **分支两遍且答案不同**：`git/index.ts:122-127` 在 detached 时改用短 sha、空仓给 `'(无提交)'`；`desktop-dock:411-413` 只把异常吞成 `'(无提交)'`，detached 时分支名原样返回 `'HEAD'`（它只在 `git-branches` 分支里判 detached，`469-473`）。
- 证据：
  - `git/index.ts:122-124`
    ```ts
    const detached = head === 'HEAD'
    const branch = detached
      ? await git(cwd, ['rev-parse', '--short', 'HEAD']).then((out) => out.trim()).catch(() => 'HEAD')
    ```
    （125–127 行是空仓回落：`head === ''` → `'(无提交)'`）
  - `desktop-dock/index.ts:411-413`：`const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])` / `.then((out) => out.trim())` / `.catch(() => '(无提交)')`
  - `git-info.ts:450`：`const lines = (await gitExec(cwd, ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '--untracked-files=all']))`
  - `git-exec.ts:53`：`if (code[0] === 'R' || code[0] === 'C') at += 1`
  - `git-info.ts:464-466`：`const arrow = path.indexOf(' -> ')` / `if (arrow >= 0) path = path.slice(arrow + 4)` / `if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)`
- 影响：在 detached HEAD 上，输入框那颗分支钮（读 `surfaces.git`）显示短 sha，Git 页签显示字面 `HEAD`，用户会以为是两个仓库；改 `-z` 的 rename 规则只能改一处，回合变更卡（`collectGitTurnChanges`）走的是按行解析，重命名会算成「新增 + 删除」两次。`git` 插件每一拍本身还要跑 3–4 个 git 子进程（`git/index.ts:118-129`），加上面板与回合那两处，同一个工作区的 `git status` 每 12 秒会跑两到三遍。
- 建议：在 `core/git-exec.ts` 旁边加 `readGitStatus(cwd, { stats })`，返回 `{ repo, branch, detached, dirtyFileCount, staged, unstaged, untracked }`；`git` 插件与 `desktop-dock` 都调它（stats 作参数），`core/git-info` 的回合快照改成调 `parsePorcelainZ`（去掉 `parsePorcelain`）。分支显示规则（detached 用短 sha）写进这个函数，一处生效。
- 置信度：高（五处原文都读过；「显示不一致」由两段分支代码直接推出）

### webserver + remote

#### [F8][P1] 两台界面服务器各写一遍引导、路由表、凭据闸与错误应答，只有几个函数共用
- 位置：`src/core/ui-server.ts:288-333`、`335-385`、`389-492`、`496-507`；`src/packages/remote/index.ts:185-277`、`382-387`；`src/packages/remote/routes.ts:304-412`
- 现象：本机服务与远程服务都在做「起一个 http.Server → 挂静态与启动图 → 挂数据通道 → 关掉」。共用的只有 `createUiEvents`、`resolveUiResourceRequest`、`injectBootScriptTag`、`UI_CONTENT_SECURITY_POLICY`、`serveStatic`、`sendJson`/`readCookie`。剩下四类各写一遍：
  - **引导与兜底**：`ui-server.ts:326-333` 用 `sendText(res, 500, '内部错误')` 兜 handler 抛错；`remote/index.ts:269-277` 用 `sendJson(res, 500, { ok:false, error })` 兜同一件事。
  - **路由表**：`/api/boot`（`ui-server.ts:440-448` vs `routes.ts:397-400`）、`/boot.js`（`451-464` vs `387-396`）、`/plugins/*`（`426-439` vs `374-384`）、`/api/events`+`/api/invoke`（`466-482` vs `361-368`）、静态（`483-491` vs `402-409`）。
  - **凭据**：本机是「一次性令牌 → HMAC 签名的会话 Cookie（30 天，绑 authority）→ 303 跳转」(`ui-server.ts:296-299`、`349-380`)；远程是「设备 token → 明文 HttpOnly Cookie（SameSite=Lax，无签名、无过期绑定）」(`routes.ts:184-191`)。共用 `readCookie`，但两套模型、两套失效语义。
  - **错误应答**：本机全用纯文本（`ui-server.ts:340`、`360`、`382`、`492`），远程全用 JSON（`routes.ts:306`、`356`、`411`），未授权时本机返回 HTML 页、远程返回 JSON。同一个 `/api/invoke` 在两边对「失败」的响应形状不同。
- 证据：
  - `ui-server.ts:330`：`if (!res.headersSent) sendText(res, 500, '内部错误')`
  - `remote/index.ts:272`：`sendJson(res, 500, { ok: false, error: errText(error) })`
  - `ui-server.ts:381-383`
    ```ts
    if (!verifyUiCookie(signingKey, authority, readCookie(req.headers.cookie, UI_COOKIE), Date.now())) {
      res.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' })
      res.end(UNAUTHORIZED_HTML)
    ```
  - `routes.ts:356`：`sendJson(res, 401, { ok: false, error: '设备凭据无效或已被吊销，请重新配对' })`
  - `routes.ts:188-189`：
    ```
          `${REMOTE_COOKIE}=${outcome.token}; Max-Age=${String(Math.floor(REMOTE_COOKIE_MAX_AGE_MS / 1000))}; ` +
          'Path=/; HttpOnly; SameSite=Lax',
    ```
  - `ui-server.ts:370`、`374`、`375`：`` `${UI_COOKIE}=${issueUiCookie(signingKey, authority, expiresAt)}`, `` / `'HttpOnly',` / `'SameSite=Strict',`
- 影响：给 `/api/invoke` 加一条统一的前置检查（例如请求体大小、方法审计）要在两处各写一遍；两套 Cookie 的 `SameSite` 不同（Strict vs Lax），跨站场景下的行为差异没人写过说明；本机那条的 `/api/attachments` 与远程那条的 `/api/upload` 是同一功能的两套协议（`ui-server.ts:389-423` vs `routes.ts:224-255`），附件在手机上是另一条路径。
- 建议：把「同一份壳的路由」抽成 `core/ui-route.ts` 里的 `createShellRoutes({ boot, combos, events, assetsDir, csp, log })`，返回 `(req,res) => boolean`（命中即 true）；`ui-server` 与 `createRemoteServer` 各自只保留**凭据闸**（本机 Cookie / 远程设备）与自己的业务路由，错误应答统一走 `web-http.ts` 的一条 `sendFailure`。附件与上传二选一：要么远程复用 `/api/attachments`，要么在远程壳里明确关掉附件入口。
- 置信度：高（两台实现的路由段都逐行读过）

#### [F9][P1] 启动图与事件通道的装配各一份，两份图已经漂移（手机缺 `host.language`，缺 `ask` 通道，订阅源不同）
- 位置：`src/packages/webserver/index.ts:138-257`、`265-272`；`src/packages/remote/index.ts:534-621`
- 现象：两边都在做「造一张启动图 + 造 `createUiEvents` + 订阅 graph-dirty 推帧」，但：
  - **图内容不同**：本机那份的 `host` 带 `language`（首帧语言要用），手机那份只有 `name`/`version`。
  - **通道能力不同**：本机那份有 `ask`（旁问增量，`webserver/index.ts:151-160`、`215-222`），手机那份没有这个字段，于是 `event: ask` 永远不会出现在手机壳里；本机那份还挂了 HMR 轮询（`276-299`），手机那份靠「每个请求现算一次图」。
  - **快照变化源不同**：本机订阅 `runtime.subscribe`（`205`），手机订阅 `ctx.transcript.subscribe`（`588`）——同一份页面，两个界面对「什么算变化」的回答不同。
  - **图的生命周期不同**：本机用 `UiServerHandle.boot()`（`165`）拿当前代快照；手机每次请求都 `bootSource.refresh()` 重收（`562-565`）。
- 证据：
  - `webserver/index.ts:267`：`host: { name: 'Pneuma', version: DSC_VERSION, language: languageOfConfigFile(activeConfigFile()) },`
  - `remote/index.ts:556`：`host: { name: 'Pneuma', version: DSC_VERSION },`
  - `webserver/index.ts:205`：`subscribe: (onChange) => runtime.subscribe(onChange),`
  - `remote/index.ts:588`：`subscribe: (listener) => ctx.transcript.subscribe(listener),`
  - `webserver/index.ts:215-216`：`ask: {` / `subscribe: (listener) => {`
- 影响：手机端首帧拿不到 `host.language`，若壳按它选文案就会回落默认语言（桌面与手机同一个人看到两种语言）；旁问的增量在手机上只能等 `invoke` 的最终答案补；`transcript.subscribe` 与 `runtime.subscribe` 覆盖的状态集合不同，快照面（`surfaces.*`）变化在手机上可能不触发推帧——这类问题只在手机上出现，桌面复现不了。
- 建议：把「壳通道的装配」收成 `core/ui-shell-channel.ts` 的 `createShellChannel({ runtime, boot, graphFrames, ask, log })`，`webserver` 与 `remote` 各传自己的 `boot` 与日志，`ask`/`subscribe` 由参数决定；`host` 字段直接用 `createUiServer` 拼好的那一份，不要在 remote 里重拼。
- 置信度：高（两段装配代码都逐行读过；字段差异是静态可判定的）

#### [F10][P1] 四条 `invoke` 通道四种闸门：`validateUiArgs` 只在两条上，附件净化只在本机那条上
- 位置：`src/packages/webserver/index.ts:187-198`；`src/packages/remote/routes.ts:361-368` + `src/packages/remote/index.ts:576-581`（远程 HTTP）；`src/packages/remote/index.ts:333-342`（远程 WS）；`src/packages/host-stdio/index.ts:226-239`
- 现象：同一个 `submit` 方法，四条路的检查不同：
  - 本机 HTTP：`isUiMethod` + `validateUiArgs` + `sanitizeFileRefs`（仅 `submit` 的第 3 个实参）。
  - 远程 HTTP（壳）：`REMOTE_SHELL_SET` + `validateUiArgs`，**没有** `sanitizeFileRefs`。
  - 远程 WS（经典档）：只查 `REMOTE_SET`，实参原样铺开。
  - `host-stdio`：只查 `isInvokableMethod`，实参原样铺开。
- 证据：
  - `webserver/index.ts:188-195`（191–193 行是注释与 `finalArgs` 取参，此处省）
    ```ts
    if (!isUiMethod(method)) throw new Error(`界面通道不允许调用的方法：${method}`)
    const checked = validateUiArgs(method, args)
    if (!checked.ok) throw new Error(checked.error)
    // 文件引用只认仓库按 sha 算出的路径：页面编的 path 一律丢掉（见 sanitizeFileRefs）。
    const finalArgs = [...checked.args]
    if (method === 'submit' && finalArgs.length > 2) {
      finalArgs[2] = sanitizeFileRefs(finalArgs[2])
    }
    ```
  - `remote/index.ts:577-580`
    ```ts
    if (!REMOTE_SHELL_SET.has(method)) throw new Error(`远程壳不开放这个方法：${method}`)
    const checked = validateUiArgs(method as UiMethod, args)
    if (!checked.ok) throw new Error(checked.error)
    return (await invoke(method, checked.args)) ?? null
    ```
  - `remote/index.ts:333-338`
    ```ts
    if (!REMOTE_SET.has(method)) {
      send({ type: 'result', id, ok: false, error: `远程不开放这个方法：${method}` })
      return
    }
    try {
      const value = await deps.invoke(method, args)
    ```
  - `host-stdio/index.ts:234`：`const value = Reflect.apply(runtime[method], runtime, args)`
  - `runtime/index.ts:104-105`：`submit(text: string, images?: string[], files?: UserFileAttachment[]) {` / `ctx.agent.followup(text, images, undefined, 'user', files)`（`files` 原样进会话，没有第二道校验）
- 影响：`sanitizeFileRefs` 是唯一「附件必须在仓库里、最多 20 个」的闸（`core/attachments.ts` 里逐项 `store.has(sha)`），它只在本机 HTTP 上生效；手机壳与桌面主进程代转都能把任意形状的 `files` 送进 `submit`。批次 03 报的是「两条链一个校验一个不校验」，这里补的是**第三、第四条**：即使都「有校验」的两条，净化步骤也不一样。
- 建议：把「方法是否开放 + 实参规格 + 逐方法净化」收成一个函数（`core/ui-methods.ts` 里加 `prepareUiCall(method, args)`，返回 `{ ok, args } | { ok:false, error }`），四条通道都调它，各自只传自己的方法白名单；净化规则按方法名内聚，不再由调用方记「submit 要洗第 3 个参数」。
- 置信度：高（四条通道原文都读过）

#### [F11][P1] 快照节流泵有三份（`host-stdio`、`remote`、`ui-events`），`core/snapshot-throttle.ts` 只统一了数字
- 位置：`src/packages/host-stdio/index.ts:207-222`；`src/packages/remote/index.ts:194-256`；`src/core/ui-events.ts:266-289`；`src/core/snapshot-throttle.ts:16-28`
- 现象：三处都在写「pending 标记 + 单个 setTimeout + 上次发送时刻」，都把「没人连着就记 `missedWhileIdle`」这段逻辑抄了一遍。`core/snapshot-throttle.ts` 只提供间隔与夹取（16–1000ms，缺省 80），不含泵本体。批次 03 对照了前两份（leading vs trailing），本批补第三份：`remote` 的 `scheduleFrame` 与 `ui-events` 的 `scheduleFrame` 结构逐句同构，只有节流边界（leading vs trailing）不同。
- 证据：
  - `remote/index.ts:235`、`237`、`240`、`244`：`    if (sockets.size === 0) {` / `      missedWhileIdle = true` / `    framePending = true` / `    const wait = Math.max(0, deps.throttleMs - (Date.now() - lastFrameAt))`
  - `ui-events.ts:270`、`273`、`276`：`    if (clients.size === 0) {` / `      missedWhileIdle = true` / `    dirty = true`
  - `host-stdio/index.ts:212-214`：`      pendingSnapshot = true` / `      if (timer !== null) return` / `      const wait = Math.max(0, throttleMs - (Date.now() - lastSentAt))`
  - `snapshot-throttle.ts:26`：`export function snapshotThrottleMs(value: unknown): number {`
- 影响：三处的「空连接记账」各自演进——`remote` 多了 `framePending` 与 `missedWhileIdle` 两个字段、`ui-events` 多了 `seq` 与背压断开，`host-stdio` 什么都没有；补一个「推送失败要重试」或「按连接分帧率」的需求，要改三处且只能手动保证语义一致。
- 建议：抽 `core/snapshot-pump.ts`：`createSnapshotPump({ emit, throttleMs, mode: 'leading' | 'trailing', hasListeners })`，三处各传 `emit` 与 `mode`；`missedWhileIdle` 的记账收进泵里（三处都需要它，只是 `host-stdio` 现在没写）。
- 置信度：高（三处泵体都逐行读过）

#### [F12][P2] `core/remote` 的凭据判定在包内写了两遍，一处返回设备、一处返回布尔
- 位置：`src/packages/remote/routes.ts:139-142`；`src/packages/remote/index.ts:617-619`
- 现象：同一条「Authorization Bearer 或设备 Cookie → `pairing.verifyToken`」判定，路由层写成一个返回 `device | null` 的 `deviceOf`，壳层装配里又写成返回 `boolean` 的 `authenticated`。两处都从 `core/web-http` 取 `bearerToken`/`readCookie`，都从同一个 `pairing` 实例验证。
- 证据：
  - `routes.ts:140-141`：`const token = bearerToken(req.headers.authorization) ?? readCookie(req.headers.cookie, REMOTE_COOKIE)` / `return token === null ? null : deps.pairing.verifyToken(token)`
  - `remote/index.ts:618-619`：`const token = bearerToken(req.headers.authorization) ?? readCookie(req.headers.cookie, REMOTE_COOKIE)` / `return token !== null && pairing.verifyToken(token) !== null`
- 影响：加一条凭据来源（例如 `X-Device-Token` 头，给不支持 Cookie 的 WebView）要改两处；两处的返回类型不同，改的时候容易只改一处，表现是「页面能进但接口全 401」或反过来。
- 建议：`authenticated` 改成调 `deviceOf`（把它提到 `routes.ts` 的导出，或放进一个 `auth.ts`），只留一份判定。
- 置信度：高（两段原文都读过）

### host-stdio

#### [F13][P1] 通用 `window.dsc.invoke` 已经没有调用方，却仍然对同一份文档开放，直通最宽的方法面
- 位置：`desktop/electron/preload/index.ts:17-21`、`desktop/electron/main/index.ts:859-862`、`src/packages/host-stdio/index.ts:226-239`、对照 `src/packages/webserver/index.ts:170-174`
- 现象：桌面窗口加载的是 webserver 伺服的那份文档（`main/index.ts:1494-1498`），页面自己的调用走 HTTP。`preload` 同时把 `window.dsc.invoke(method, args)` 挂进了同一个 world，`dsc:invoke` handler 没有任何白名单，直接 `protocol.invoke`，`host-stdio` 只查 `isInvokableMethod` 就 `Reflect.apply`。全仓没有任何页面代码调用它（`grep window.dsc|dsc.invoke` 在 `src/packages`、`ui-shell/src` 零命中），但接口仍在。真正在用的 `host-stdio invoke` 是主进程代转的那一批特权写（`main/index.ts:1148-1230`：`setPolicy`、`setReviewer`、`saveProvider`、`setProviderKey`、`installMarketSkill`、`dock`）。
- 证据：
  - `preload/index.ts:19-20`：`invoke(method: string, args: unknown[] = []): Promise<unknown> {` / `return ipcRenderer.invoke('dsc:invoke', method, args)`
  - `main/index.ts:859-861`：`ipcMain.handle('dsc:invoke', (_event, method: string, args: unknown[]) => {` / `if (protocol === null) throw new Error('宿主进程未运行')` / `return protocol.invoke(method, args ?? [])`
  - `host-stdio/index.ts:227-234`（231–233 行是 try 与注释，此处省）
    ```ts
    if (!isInvokableMethod(method)) {
      transport.send({ type: 'result', id, ok: false, error: `协议不允许调用的方法：${method}` })
      return
    }
    try {
      // 方法名已经收窄成 DscRuntime 的键，参数是线上来的 unknown：
      // 通用调用只有这一处，靠 Reflect.apply 展开实参（渲染器那侧由 RuntimeProxy 的映射类型保证签名对得上）。
      const value = Reflect.apply(runtime[method], runtime, args)
    ```
  - `webserver/index.ts:171-173`（注释里的边界主张）：
    ```
    // 白名单**不是**整张 INVOKABLE_METHODS：页面里跑着第三方插件 bundle，与壳同源，
    // 任一插件被投毒就等于拿到 Cookie；所以只放界面真正要用的子集，凭据类 / 破坏性 /
    // 任意命令执行 / 策略写入一律排除，理由逐条写在 core/ui-methods.ts 的文件头。
    ```
  - `preload/index.ts:8`（注释自承这条门更宽）：` * 是旧渲染层那 26 个 IPC 的入口（里面还有装插件/装技能这两个供应链写入口），`
- 影响：`UI_EXCLUDED` 那条「凭据类、策略写入不进界面通道」的边界在这份文档里不成立——与壳同源的任意插件 bundle 只要调 `window.dsc.invoke('setPolicy', ['full'])` 就能绕开它，而且没有任何校验记录。同时 `dsc:snapshot`/`dsc:ui`/`dsc:host-log` 三条推送也没有页面消费者（`main/index.ts:458-462` 仍在转发），`host-stdio` 那套 80ms 全量快照订阅（`host-stdio/index.ts:223`、`411-418`）在桌面场景里是纯开销。
- 建议：①删掉 `preload` 的通用 `invoke` 与 `main` 的 `dsc:invoke` handler（旧渲染层已整体删除，注释里也这么写），只留 `dscNative` 的白名单入口；②`host-stdio` 的 invoke 改成「主进程代转白名单」（`dock`/`setPolicy`/`saveProvider`/…）而不是 `INVOKABLE_METHODS` 全量；③确认 `dsc:snapshot`/`dsc:ui` 无消费者后停掉 `host-stdio` 的快照推送（桌面用 SSE）。
- 置信度：高（preload/main/host-stdio 三处原文都读过，页面侧零消费者是全仓 grep 结论；「任意插件可调用」是静态推断，未实机验证，见待核实 2）

#### [F14][P2] `inject: ['ui']` 却用 `ctx.get('webServer')` 跨过契约拿服务，桌面窗口的界面地址就靠这条隐式依赖
- 位置：`src/packages/host-stdio/index.ts:186-193`、`429-443`
- 现象：插件声明的依赖只有 `ui`，但它在 apply 末尾读 `ctx.get('webServer')` 并调 `ensure()`——这是桌面窗口拿到带令牌地址的唯一来源（`main/index.ts:385-407` 的 `adoptUiServer`）。`ctx.get` 不参与装载顺序检查：`webserver` 没挂或挂得晚，这里拿到 `undefined`，于是静默走「桌面壳回落到本地文件加载」。
- 证据：
  - `host-stdio/index.ts:188`：`inject: ['ui'],`
  - `host-stdio/index.ts:433`：`const web = ctx.get('webServer')`
  - `host-stdio/index.ts:441`：``ctx.logger.warn(`host-stdio: 本机界面服务起不来（${errText(error)}），桌面壳将回落到本地文件加载`)``
- 影响：把 webserver 停用/改名之后，桌面端不会报错，只会掉回另一条加载路径（`shellDir()` 存在与否决定看到什么），排查时看不出是「服务没起」还是「壳没接上」。`inject` 数组此时是误导性的——它告诉读者这个插件只依赖 `ui`。
- 建议：`inject` 加 `webServer`（cordis 的服务依赖名就是 `provide: 'webServer'`，见 `webserver/index.ts:120`），把 `ctx.get` 换成 `ctx.webServer`；如果「webserver 可缺席」是有意的，就在 `inject` 里用可选依赖写法并在文件头写明这条降级路径。
- 置信度：高（三行原文 + `provide` 名已核对）

### schedule

#### [F15][P2] 实现只有一份（核对结论），但插件壳里 `schedule` 工具与 `/schedule` 命令把同一组动作写了两遍
- 位置：`src/packages/schedule/index.ts:285-359`（工具）、`366-442`（命令）、`184-190`（`ensureSchedule`）；实现层 `src/core/schedule/runner.ts:305-362`、`rule.ts:574`
- 现象：定时器重排、6 小时分段、catch-up 宽限、`.lock`、DST 都只在 `core/schedule/{runner,rule,store}.ts` 里，插件只装配——这部分是干净的，`core/schedule/*` 是**活代码**（`packages/schedule/index.ts:37-39` 经 `@pneuma/runtime/core/schedule/*` 引用），不是待迁垫片。重复在插件壳内部：工具按 `action` 分发（create/list/update/run/delete/pause/resume），命令按子命令分发（list/add/pause/resume/run/remove），两边各自做参数校验、`parseRule`、`store.create/update`、回执拼装；`create` 与 `add` 只有「从 args 取」和「从字符串切」的区别。
- 证据：
  - `index.ts:294-296`（工具 create）：
    ```ts
    const parsed = parseRule(ruleText, zone, Date.now())
    if (!parsed.ok) throw new Error(parsed.error)
    const task = await store.create({
    ```
  - `index.ts:390-396`（命令 add）：
    ```ts
    const parsed = parseRule(split.ruleText, config.timeZone, Date.now())
    if (!parsed.ok) {
      ui.notice(parsed.error)
      return
    }
    void store
      .create({
    ```
- 影响：加一个字段（例如「只在某个会话里生效」）要改两条入口；两边错误出口不同（工具抛异常给模型、命令 `ui.notice` 给人看），同一句校验失败在两条路上的措辞已经不同（`index.ts:290-293` 与 `383-388`）。
- 建议：抽 `createTask(input): Promise<ScheduleTask>`、`updateTask(id, patch)`、`pauseTask/removeTask` 三个纯函数，工具与命令都只做「取参 → 调它 → 按各自出口报结果」。
- 置信度：高（两条入口全文读过；实现层单份已核对 `runner.ts`/`rule.ts` 的导出面与 `nextRunAt` 唯一定义）

### web-search

#### [F16][P2] `readConfig()` 不接受 `passed`，装配期配置被丢弃；请求超时/取消又是第四份手写
- 位置：`src/packages/web-search/index.ts:56-74`、`77-98`、`175`
- 现象：全仓插件的惯例是 `apply(ctx, passed)` 再把 `passed` 传给 `resolvePluginConfig(file, passed)`（mcp `index.ts:116-117`、ops `index.ts:53-54`、schedule `index.ts:74-75`）。web-search 的 `apply(ctx)` 不收第二参，`readConfig()` 也不收，于是只读磁盘那份；`resolvePluginConfig` 的合并语义（`{...passed, ...fromDisk}`）在这里永远只用后一半。另外 `postJson` 自己拼 `AbortController` + `setTimeout(20s)` 的取消组合，与 mcp/lsp/ops 那三份并列成为第四份。
- 证据：
  - `web-search/index.ts:56-57`：`function readConfig(): WebSearchConfig {` / `const raw = resolvePluginConfig(CONFIG_KEY)`
  - `web-search/index.ts:175`：`apply(ctx) {`
  - `web-search/index.ts:78-81`：
    ```ts
    const controller = new AbortController()
    const onAbort = (): void => { controller.abort() }
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(onAbort, 20_000)
    ```
- 影响：用组合包/补丁给 web-search 传 `provider` 或 `maxResults` 不会生效，只有写进 `plugins.json` 才行；这类「配了没反应」的问题不会报错。超时上限 20s 硬编码在函数里，与设置页无关（它的设置项里也没有超时项）。
- 建议：`apply(ctx, passed)` + `readConfig(passed)` 改成与其他插件一致；超时用 `AbortSignal.timeout(20_000)` 与外部 signal 走 `AbortSignal.any`（与 `mcp.ts:561` 同一写法），或等 `core/process-launch.ts` 那批整理时一起收。
- 置信度：高（三处原文 + 四个对照插件的 `apply` 签名都核对过）

---

## 旧/新双路径清单

| 能力 | 旧路径 | 新路径 | 谁还在用旧路径 | 处置建议 |
| --- | --- | --- | --- | --- |
| LSP 实现入口 | `src/core/lsp/{client,framing,line-shift,manager,normalize,servers,uri}.ts`（7 个一行垫片） | `src/packages/lsp/*`（被 `lsp/index.ts` 直接 import） | **无人**：全仓只有 7 处 `@module dsc/core/lsp/*` 注释提到，零 import | 删 7 个垫片，注释改成 `dsc/packages/lsp/*` |
| ops 实现入口 | `src/core/ops/{render,tools,worker}.ts`（3 个一行垫片） | `src/packages/ops/*`（被 `ops/index.ts` 直接 import） | 只剩自检：`scripts/ops-test.mjs:67-69` 经 `lib/core/ops/*` | 自检改 import `lib/packages/ops/*`，再删垫片 |
| MCP 底座入口 | `src/core/mcp.ts`（一行垫片） | `src/packages/mcp/mcp.ts` | **活**：`src/packages/lsp/manager.ts:16` 取 `buildChildEnv`；`scripts/mcp-name-test.mjs:19` 取 `mcpToolName` | 按批次 90 建议把 `buildChildEnv` 抽到 `core/process-launch.ts`，lsp 不再够 mcp |
| 定时任务实现 | 无（没有第二份） | `src/core/schedule/{rule,store,runner}.ts`，`packages/schedule` 是壳 | 唯一路径 | 不用动；注意方向是「实现在 core、壳在包」，与 58 个反向垫片相反，别一起清 |
| 远程控制实现 | 无（没有第二份） | `src/core/remote/{frames,pairing,tickets,uploads,push,owner,store,notify}.ts` + `packages/remote/{index,routes,http,types}.ts` | 唯一路径；`packages/remote/http.ts` 是薄转发层（22 行，全量 re-export `core/web-http`） | 不用动；转发层可以留，注释已说明理由 |
| 界面服务 | 无（`ui-server.ts` 是唯一本机实现） | 同上 | 唯一路径 | 见 F8：远程那台要复用路由，不是复用整个服务 |
| 邀请/换票 | 本机：一次性 `?token=` → 签名 Cookie（`ui-server.ts:296-385`） | 远程：设备 token → 明文 Cookie（`routes.ts:184-191`） | 两套都在跑，服务不同的人群 | 保留两套模型，但把「失败形状」统一（F8） |
| 页面 invoke | `host-stdio` 通用 invoke（`INVOKABLE_METHODS`，无校验） | 本机 HTTP（`UI_METHODS` + `validateUiArgs` + 附件净化） | 页面侧：新路径；主进程代转的特权写：旧路径（`main/index.ts:1148-1230`） | 删通用 `window.dsc.invoke`/`dsc:invoke`；host-stdio 只留主进程白名单那几条 |
| 快照推送 | `host-stdio` leading-edge（`index.ts:207-222`） | `ui-events` trailing + seq + 补帧（`ui-events.ts:266-289`）；`remote` leading（`remote/index.ts:234-256`） | 桌面窗口：两条都在跑（IPC 那条无消费者） | 抽 `createSnapshotPump`，模式作参数；停掉 IPC 那条 |
| git 读数 | `desktop-dock` 的 `git-status` op（按请求） | `git` 插件的 `surfaces.git`（轮询快照） | 两处都在跑，各自 `git status` | 抽 `readGitStatus(cwd,{stats})`，两处共用 |
| 文件工具族 | `read`/`write`/`edit`（core/tools/fs-tools.ts） | `ops_*` 13 个（packages/ops） | 并存，系统提示靠一段话分工（`ops/index.ts:131-139`） | 保留两族，但把「修订号」与行号渲染收成一份（F6） |

## 重复逻辑清单

| 逻辑 | 位置 A | 位置 B | 差异 | 抽取建议 |
| --- | --- | --- | --- | --- |
| 启动命令解析（PATH/PATHEXT） | `mcp.ts:298-316` | `servers.ts:133-162` | A 先试无后缀、找不到就 `shell:true` 猜；B 先试带后缀、`isRunnable` 查 X_OK、找不到返回 undefined | 抽 `core/process-launch.ts`（F1 的根因） |
| 子进程环境白名单 | `mcp.ts:68-80`、`249-264` | `manager.ts:90`（复用同一份，经 `core/mcp` 垫片） | 逻辑共用，但依赖方向反了 | 上移 core，去掉垫片中转 |
| 环境变量按名读取（Windows 不分大小写） | `mcp.ts:267-276` | `servers.ts:165-174` | 逐字同构 | 收进 `core/env.ts` |
| stderr 尾巴 | `mcp.ts:530`（2000 字符） | `framing.ts:147-186`（1MB 字节 + tailLines） | 单位、容量、是否分行都不同 | 上移 `StderrTail` |
| 杀进程树（Windows taskkill /T /F） | `lsp/client.ts:374-391`（spawnSync + kill 兜底） | `ops/worker.ts:250-268`（异步 spawn + error 兜底） | 同步/异步、失败兜底写法不同 | 抽 `core/process-kill.ts` |
| 请求超时+取消 | `mcp.ts:561`（只 reject） | `lsp/client.ts:297-316`（cancelRequest + 杀树）、`ops/worker.ts:269-277`、`web-search/index.ts:78-81` | 四种取消语义 | 前三条各自演化有理由（协议不同），超时组合可共用 `AbortSignal.any` 写法 |
| 快照节流泵 | `host-stdio/index.ts:207-222` | `remote/index.ts:234-256`、`ui-events.ts:266-289` | leading ×2、trailing ×1；`missedWhileIdle` 只有两处写 | 抽 `core/snapshot-pump.ts`（F11） |
| 界面服务引导与 500 兜底 | `ui-server.ts:326-333` | `remote/index.ts:269-277` | 一个 `sendText`、一个 `sendJson` | 见 F8 |
| 壳路由（/api/boot、/boot.js、/plugins/*、events、invoke） | `ui-server.ts:426-482` | `routes.ts:361-400` | 认证在各自外层；错误形状不同 | 抽 `createShellRoutes` |
| 启动图与事件通道装配 | `webserver/index.ts:138-257` | `remote/index.ts:534-621` | 手机缺 `language`/`ask`；订阅源不同 | 抽 `createShellChannel`（F9） |
| 凭据判定（Bearer → Cookie → verifyToken） | `routes.ts:139-142` | `remote/index.ts:617-619` | 返回值类型不同 | 留一份，另一处调用它 |
| 脏文件计数 | `git/index.ts:132-134` | `desktop-dock:423-427` | 规则相同，循环两遍 | 随 `readGitStatus` 合并 |
| porcelain 解析 | `git-exec.ts:45-56`（-z） | `git-info.ts:460-468`（按行） | rename 处理、去引号方式不同 | 统一走 `-z` 版 |
| 分支读取（detached / 空仓） | `git/index.ts:119-127` | `desktop-dock:411-413` | detached 时一个给短 sha、一个给 `'HEAD'` | 合并进 `readGitStatus` |
| 行号视图渲染 | `fs-tools.ts:130-144` | `ops/render.ts:94-99`、`102-117` | 截断点、控制字符处理不同 | 抽 `formatNumberedLines` |
| 文件并发锚 | `fs-tools.ts:181-184`、`242-245`（mtime） | `ops/tools.ts:102-120`、`435`（SHA-256） | 锚类型不同，「别人改过没有」的判定不同 | 抽 `core/file-revision.ts` |
| diff 产物 | `fs-tools.ts:52-72`（`diffLines`，800 行顶） | `ops/render.ts:163-188`；`git-info.ts:180`（`git diff` 原文）；`desktop-dock:141-169`（未跟踪文件合成） | 四种形状，四种裁剪 | 不强行合一（用途不同），但把「行号口径」写进工具描述 |
| 定时任务动作入口 | `schedule/index.ts:285-359`（工具） | `schedule/index.ts:366-442`（命令） | 取参方式不同，校验与回执各写 | 抽 `createTask/updateTask/…`（F15） |
| 请求超时硬编码 | `web-search/index.ts:81`（20s） | 其余插件都从配置读 | web-search 不可配 | 与其他插件对齐 |

## 待核实

1. **F1 的最后一跳**：`spawn('…\\npx', [], { shell:false })` 在 Windows 上的确切失败形态（EINVAL / ENOEXEC / UNKNOWN）没有实跑；本机只核对了「无后缀 `npx`（2073 字节）与 `npx.cmd`（538 字节）同目录并存」这个前提。若 Node 对这个文件有特殊处理（例如自动回退到 `.cmd`），F1 要降级为 P1。
2. **F13 的可利用性**：`window.dsc` 由 `contextBridge.exposeInMainWorld` 挂到主窗口的 world，推断「加载到这一窗的任何文档（含第三方插件 bundle）都能调 `.invoke`」；未在真机验证「webserver 伺服的那份文档是否也带这个 preload」。若主窗口的 preload 只对 `file://` 生效（当前代码没有这层判断），结论成立。
3. **`dsc:snapshot` / `dsc:ui` / `dsc:host-log` 是否真的零消费者**：本批 grep 覆盖 `src/packages`、`ui-shell/src`、`desktop/electron`；`desktop/src`（旧渲染层）在当前 checkout 不存在。若仓库外还有旧产物，可能仍有人读。
4. **`remote` 壳档的 `ask` 缺失**是有意降级还是漏了：`ui-runtime/ui/host-channel.ts` 是否在手机端监听 `ask` 事件、没有事件时是否静默——本批只核对了宿主侧没有这个字段，客户端侧未逐个文件读。
5. **`core/schedule/runner.ts` 的 `waiting.any` 闸**（批次 07 已报全局问题）：本批只确认「投递前问 `ctx.waiting.any`」这一处在 `packages/schedule/index.ts:210`，没有评价其正确性，留给批次 07 的结论。
6. **`ops` 的 worker 是否真的需要 `process.env`**：`dsh-ops-worker`（Rust）是否读环境变量（例如 `HTTP_PROXY`）未查上游文档；若确实需要代理变量，白名单要显式加上而不是整份继承。
7. **`packages/remote/types.ts` 的 `REMOTE_METHODS` 与 `REMOTE_SHELL_METHODS`** 只读了声明段（54、105 行）与两个 Set（132、135 行），没有逐条与 `UI_METHODS`/`INVOKABLE_METHODS` 做集合差；「哪些方法只在某一条通道上」的完整矩阵未做。
8. **`desktop-dock` 的 `git-diff` 未跟踪文件合成段**（`index.ts:141-169`）只读了头尾，未逐行核对与 `git diff` 输出格式的兼容性（壳侧解析器在批次 04/05 的范围）。
