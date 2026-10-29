# ask_user 批量化（一批问题一次挂出）· 实施与验收报告

日期：2026-09-30　　改动范围：`src/contract.ts`、`src/services/types.ts`、`src/plugins/ask.ts`（宿主）
新增自检脚本：`desktop/shots/ask3-shots.ps1`（`desktop/` 的源码一行未改）

## 一、结论

宿主侧「一批问题一次挂出、按题序收答案、收齐整批才 resolve」已实现并端到端跑通。
仓库根与 desktop 的 typecheck / build 全绿；宿主级回归全部通过；真机（真宿主 + 真桌面端 +
本机假模型端点）3 题一轮的 DOM 探针 33 条断言全 PASS、退出码 0；真实 `~/.dsc` 跑前跑后
135 个文件逐个 SHA256 一致。

## 二、改了什么

### 1. `src/contract.ts`
- `110-127`：新增 `AskQuestionItem`（`question` / `header?` / `options` / `multiSelect` /
  `allowFreeText`），就是原来单题字段去掉 `id`。
- `129-149`：`AskUserView` 加可选 `questions?: AskQuestionItem[]`；单题字段（`question`、
  `options`、`multiSelect`、`allowFreeText`）全部保留，语义写成「第 1 题的投影」，
  与 `questions[0]` 同源。老会话回放里没有 `questions` 的单题视图不需要迁移。
- `151-152`：`AskUserViewInput = Omit<AskUserView, 'id' | 'questions'>`，`ask()` 的参数类型
  由此保持原样（老调用方不受影响）。
- `297`：`RuntimeSurfaces.pendingQuestion` 注释补一句「它自己可能带一批题目」。
- `758`：`answerQuestion` 注释补「一批多题时按题序一次交一题」。

### 2. `src/services/types.ts`
- `37-39`：补 `AskQuestionItem`、`AskUserViewInput` 的类型导入。
- `253-270`：`AskService`：
  - `pendingQuestion(): AskUserView | null` **签名不变**（多题时返回的那张视图自己带
    `questions`）——这是对现有调用方扰动最小的方案：宿主 `host-stdio` 白名单、`runtime.ts`
    透传、桌面端 `surfaces.pendingQuestion` 全都不用动。
  - `ask(question: AskUserViewInput, signal)` 保留原语义（单题）。
  - 新增 `askMany(questions, signal): Promise<string[]>`：一次挂一批，答案按题序与入参一一对应。
  - `answerQuestion(answer: string): void` 签名不变，语义补一句「第 1 次调用解决第 1 题……」。

### 3. `src/plugins/ask.ts`（改动主体）
- `32-39`：四条收尾用实话（中断 / 换会话 / 退出 / 被新批顶掉）集中成常量。
- `58-72`：`withRest()`——把「已收到的答案 + 剩下几题」拼成整份答案，四条收尾路径共用。
- `89-127`：`askMany()`——一次挂出：
  - `103-108` 深拷贝题目；`110` 视图 = `{ id, ...questions[0], questions }`，单题字段与
    `questions[0]` 同源，不可能出现两处不一致；`id` 只发一次，整批期间稳定不变。
  - `112-118` `settle()` 是唯一出口：清挂起状态、退订 abort、`touch()` 广播、resolve。
  - `119-124` abort 收尾按题序补齐；信号进来就已经 abort 时立刻收尾（旧实现这一步会挂死，
    见第五节）。
- `129-156`：
  - `answerQuestion()`：收下当前这一题的答案；**没收齐之前视图一动不动、不广播**（界面已经
    点了统一提交、本地草稿也清了，中途 `touch()` 会把一张半空的卡推回去重画一次）；收齐整批
    才 `settle` 并 resolve。
  - `ask()` 用 `askMany([一题])` 实现，`pendingQuestion()` 返回挂起视图。
  - `surfaces.register('pendingQuestion')`、`waiting.register('ask')` 语义不变（批没答完之前
    仍算「有人挡着」，自动续跑不会硬推）。
- `200-240`：`run()` 把工具参数里的一批问题**先整批收干净再挂卡**（正文空的题丢掉、选项裁剪、
  空批直接报错），拿到整份答案后按题序拼成
  `问题\n用户回答：答案`，一次性作为工具结果回给模型。跳过语义沿用界面写的
  「（用户跳过了这一题）」，原样带回。
- `243-253`：`dsc/session-open` / `dsc/exit` 两条收尾改成对整批收尾（答过的保留原话，
  没答的填对应实话）。
- `161-168`：工具描述补一句「一次可以问多个问题：挂在同一张卡上，你在同一个工具结果里按题序
  拿到全部答案」；参数描述补「一次全挂在同一张卡上」。工具参数结构没变。

### 4. `desktop/` 源码
一行未改。新增的只有自检脚本与截图/日志。

## 三、验收：命令与退出码

| # | 命令 | 结果 |
|---|---|---|
| 1 | `pnpm run typecheck`（仓库根） | 0 错误，exit 0 |
| 2 | `pnpm run build`（仓库根） | 0 错误，exit 0 |
| 3 | `pnpm --config.verify-deps-before-run=false run typecheck`（desktop/） | 0 错误，exit 0 |
| 4 | `pnpm --config.verify-deps-before-run=false run build`（desktop/） | 0 错误，exit 0 |
| 5 | `node shots/approval-floor-check.mjs` | PASS 95 / FAIL 0，exit 0（不回归） |
| 6 | `node shots/integration-check.mjs` | 全部通过，exit 0 |
| 7 | `node shots/m5-integration-check.mjs` | 全部通过，exit 0 |
| 8 | `node shots/modes-runtime-smoke.mjs` | 全部通过，exit 0（含 `pendingQuestion === null` 那条） |
| 9 | `node shots/modes-security-check.mjs` | 全部通过，exit 0（含 `state('pendingQuestion') === undefined`） |
| 10 | `pwsh -NoProfile -File desktop/shots/ask3-shots.ps1` | 33 条断言全 PASS / FAIL 0，exit 0 |

第 5-10 项都是在**最终产物**上重跑的（`lib/plugins/ask.js` 时间戳 2026-09-30 17:15:09，
桌面端 bundle `index-D1H876w1.js` sha256 `9EC01FDB…`，与源码重建结果一致）。

`shots/` 里碰 ask_user 的检查清单（grep `ask_user|pendingQuestion|answerQuestion`）：
- `approval-floor-check.mjs`、`integration-check.mjs`、`m5-integration-check.mjs`、
  `modes-runtime-smoke.mjs`、`modes-security-check.mjs` —— 已全部跑过。
- `modes-shots.ps1:81-89`、`modes-shots-live.ps1:40` —— **没跑**：它们 `pnpm dev` 起桌面端、
  用**真模型**发自然语言问一句，而且不隔离 HOME，会写真实 `~/.dsc`。要跑得用户在场并且愿意让
  它连真端点。
- `desktop/shots/ask2-shots.ps1` —— 上一个组的脚本，按「宿主逐题挂卡、三题＝三张卡顺序出现」
  的旧行为写断言（它只打印探针 JSON，不判失败），改版后它的 `ask2-walk` 语义已过时；
  这一轮的对应脚本是 `desktop/shots/ask3-shots.ps1`。

## 四、端到端探针（真宿主 + 真桌面端 + 假端点）

脚本：`desktop/shots/ask3-shots.ps1`；假端点：`desktop/shots/ask2-fake-llm.mjs`
（`ask3` 模式＝一次问 3 题：单选 / 多选 / 纯自由输入；`ask1` 模式＝1 题）。
用例与截图：`ask3-batch-list.png`、`ask3-batch-switch.png`、`ask3-batch-submit.png`、
`ask3-single.png`；探针 JSON 在 `ask3-*.log`，完整输出在 `ask3-shots.out`。

**测到的渲染层版本**（写进 `ask3-renderer-revision.txt`）：
`desktop/src/renderer/TaskDock.tsx` mtime 2026-09-30 16:38:28、
sha256 `424A3766E36713C6B13C6E789E2A61A5A5FCCCB6EC2756084912B4BD33F32E85`；
bundle `index-D1H876w1.js` sha256 `9EC01FDBAED99C65C57384193B3CA5F0858663AD1A199C5CA2FD151A62BD49B9`。

### a) 一批同屏（ask3-batch-list）
- `.ask-card` 数量 = **1**（不是三张卡顺序出现），`data-ask-count` = **3**，同屏面板 = **1**。
- 同一张卡里依次翻到 3 道题：`1/3` →「这次只改对话区，还是连轨迹页一起对齐？」、
  `2/3` →「两条轨道的宽度以哪边为准？」、`3/3` →「还有什么要我一并处理的？（不写就直说没有）」，
  翻回第 1 题仍是同一张卡（卡片数仍为 1）。
- 快照直读（`window.dsc.onSnapshot`）：挂起视图 id 全程只有一个
  （`36e80bab-0cc5-421b-9e60-2007c39fb4d4`），`questions.length` = **3**。
  这一条是契约层证据：宿主挂的是一批，不是逐题换卡。

### b) 切题草稿保留（ask3-batch-switch）
- 第 1 题点单选「只改对话区（推荐）」→ 自动推进到第 2 题（`index` 0→1）；
- 翻到第 3 题输入「没有，先按上面两条做」；翻回第 1 题：勾还在
  （`picked = ["只改对话区（推荐）"]`）；再翻回第 3 题：输入框里还是
  「没有，先按上面两条做」（`draftKept = true`）。

### c) 统一提交（ask3-batch-submit）
- 三题各答各的：第 1 题勾「只改对话区（推荐）」，第 2 题写「以正文列宽为准，另加一条兜底」，
  第 3 题写「没有，先按上面两条做」，中途来回切题草稿不丢；
- 在最后一题按主按钮（`提交`）→ 卡片消失（提交后 `.ask-card` 数量 = **0**）；
- 假端点把宿主交回的工具结果原样回显，回显里三条答案按题序出现
  （位置 41 / 79 / 117，严格递增），且**各出现 1 次**（`1,1,1`）：
  ```
  这次只改对话区，还是连轨迹页一起对齐？ 用户回答：只改对话区（推荐）
  两条轨道的宽度以哪边为准？ 用户回答：以正文列宽为准，另加一条兜底
  还有什么要我一并处理的？（不写就直说没有） 用户回答：没有，先按上面两条做
  ```
- 快照：整批答完之前挂起视图 id 只有一个，最后一条快照里 `pendingQuestion = null`
  （视图撤下）。

### d) 单题不回归（ask3-single，`ask1` 模式）
- `data-ask-count` = 1，同屏面板 = 1，进度条不存在（`progress = null`），
  切题/翻页控件数 = **0**（单题没有 ‹ › 也没有行内箭头），主按钮直接是「提交」；
- 没答之前主按钮禁用；选完选项卡片撤下；回显里有这条答案；
- 快照里 `questions.length` = 1（单题也走同一条批处理通道，界面不回归）。

### 隔离（真实家目录指纹）
- 隔离变量：`DSC_HOME=desktop/shots/ask3-home/.dsc`、`USERPROFILE=desktop/shots/ask3-home`、
  `DSC_DESKTOP_USER_DATA=…/electron-userdata`。父环境里 `HOME` 未设置，Windows 上 node 的
  `os.homedir()` 与 Electron 的 `app.getPath('home')` 都先看 `USERPROFILE`，所以只设它就够；
  脚本里没有出现 `$HOME` / `$home`，不碰那个只读自动变量。
- 真实 `C:\Users\waq\.dsc`：跑前跑后 **135 个文件逐个 SHA256 完全一致**（PASS）。
- 真实 `C:\Users\waq\.dsh`：只有本会话自己（以及同工作区并行会话）在写的
  `sessions\` / `usage\` / `storages\` / `dsh-usage\` 4 个文件在动；**没有**出现桌面端工作目录
  那一族（`*desktop*`）的会话目录——桌面端没有漏到真实 `.dsh`（PASS）。

## 五、顺带修掉的一个潜在挂死

旧实现是 `for (const raw of list) { await ask(...) }`，每次 `ask()` 才注册一次 abort 监听。
如果中断落在第 1 题上，第 1 题按「没回答」收尾，循环接着挂第 2 题——而第 2 题拿到的是**已经
abort 过**的 signal，`addEventListener('abort', …)` 对已 abort 的信号不会再触发，这个工具调用
就永远悬着。改成一整批共用一个监听、并且进来就 `signal.aborted` 就立刻收尾（ask.ts:119-124）。

## 六、需要裁决的一件事：渲染层在我干活期间被换了

- 16:36 我读到的 `TaskDock.tsx` 是「一卡列出全部题目行」版（`.ask-item` / `data-ask-item` /
  `data-ask-state` / `data-ask-done` / `.ask-item-note` / `.ask-item-caret`）。16:39 我用它跑过
  一轮端到端：`cardCount=1`、`rowCount=3`、`data-ask-count=3`，正是「同屏 3 题列表」。
- 16:38:28 该文件被改成「向导式、一题一面板」（当前 sha256 `424A3766…`）：`.ask-panel` /
  `data-ask-index` / `.ask-text` / 翻页器 `data-ask-page` + `.ask-progress`「1/3」，注释写着
  「一卡只露当前这一题」。`desktop/out/renderer` 随之在 16:47、17:09 被重建。
- 后果：第四节的验收是在**向导版**上做的；(a) 项「同屏 3 题列表」在这个 DOM 里落成
  「同一张卡、`data-ask-count=3`、翻页器 1/3，三题都能在同一张卡里翻到（不是三张卡顺序出现）」。
  如果「列表版」才是要保留的口径，请让渲染层那位别再动（或恢复），我按列表版的类名重跑
  （探针已经做成布局无关，两版都能测，跑哪个都会在 `ask3-shots.ps1` 输出里打印 `布局=`）。
- 为避免再被改名坑住，探针不写死任何一版的类名：题目文本、当前题号、切题动作走统一访问器，
  每次跑都会把 `TaskDock.tsx` 与 bundle 的 mtime + sha256 记进 `ask3-renderer-revision.txt`。

## 七、复现命令

```powershell
cd D:\dsc; pnpm run typecheck; pnpm run build
cd D:\dsc\desktop; pnpm --config.verify-deps-before-run=false run typecheck
                   pnpm --config.verify-deps-before-run=false run build
cd D:\dsc; node shots/approval-floor-check.mjs
          node shots/integration-check.mjs
          node shots/m5-integration-check.mjs
          node shots/modes-runtime-smoke.mjs
          node shots/modes-security-check.mjs
pwsh -NoProfile -File D:\dsc\desktop\shots\ask3-shots.ps1
```
