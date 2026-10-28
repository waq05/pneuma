# 整轮过程折叠 + 脚注合并 + 过程折叠程度 —— 改动与自检报告

日期：2026-09-30 · 仓库：D:\dsc · 不改版本号、不 commit、不写真实 `~/.dsc`

对照的 dsh 参考源码（只读）：`D:\deepseek-harness\deepseek-harness\packages\client\ui-chat\src\client\`
（`chat/TurnProcessNodeView.tsx`、`chat/TurnProcessNodeView.module.css`、`chat/ChatNodeSeat.tsx`、
`chat/ReasoningRow.tsx`、`chat/MessageIconActions.tsx`、`chat/MessageIconActions.module.css`、
`chat/TurnTailNodeView.tsx`、`presentation-policy.ts`）

---

## 一、逐文件改动（行段）

### 1. 思考过程竖排字（任务 1）

| 文件 | 行段 | 改了什么 |
| --- | --- | --- |
| `desktop/src/renderer/styles.css` | 5555–5564（`.think-label` 规则内） | 补 `flex: none` 与 `white-space: nowrap`，并写清为什么：`.think-head` 是 flex 行，`.think-summary` 的 `flex: 1 1 auto` 把剩余宽度全吃掉，窗口一窄标题被压到只剩一个汉字宽，浏览器按「汉字间可断行」把「思考过程」排成一列。修复后标题不参与压缩、也不再被断行 |

### 2. 整轮过程折叠（任务 2）

| 文件 | 行段 | 改了什么 |
| --- | --- | --- |
| `desktop/src/renderer/ChatView.tsx` | 21–31（模块注释） | 新增「整轮过程折叠」的模块说明（行为口径、plan 不折、跑动轮不折、档位开关） |
| 同上 | 98–151 | 新增 `interface RoundFold` 与 `<TurnFoldRow>`（总开关行：`data-open` / `data-round-index` / `aria-expanded`，标签「用时 X」，算不出用时退「已完成」） |
| 同上 | 183–191 | 新增 `turnOpen` state（React 立刻重画）+ 注释说明它与 fold-state 的分工 |
| 同上 | 354–360 | `live` / `lastRoundIndex` 提前到 memo 之前；新增 `foldTurns`（详细档关折）与 `showReasoningPreview`（紧凑档关摘要） |
| 同上 | 376–416 | `roundFold`：算出每一轮的过程区（answerIndex 从轮末往前找最后一条定稿 text；只收 thinking/tool/text；plan 与 system 不进组；`running = 直播条目 或 最后一轮跑动 或 未收尾`） |
| 同上 | 418–434 | `roundAnswer`：每轮最终回答（复制按钮的内容） |
| 同上 | 436–447 | `roundUsage`：每轮最后一条带 `usage` 的条目（宿主累计口径的真值） |
| 同上 | 449–480 | `runningFoldKeys` + `previousRunningFoldKeys` + `useEffect`：轮收尾（跑动 → 定稿）时复位成默认收起（dsh enclosing-Turn reset 语义） |
| 同上 | 482–495 | `foldCollapsed`（跑动轮永远展开）与 `toggleRoundFold`（同时写 state 与 fold-state） |
| 同上 | 651–666 | map 回调里新增 `fold` / `inFold` / `foldOpen` / `foldHead` 判定 |
| 同上 | 812–820 | 收起时组内条目不渲染；例外保留总开关那一条与页脚那一条（一轮没有最终正文时页脚正落在组内） |
| 同上 | 840–871 | 渲染总开关（跑动轮不画）并把页脚的 `usage` / `copyText` / `voteState` / `onVote` 传下去 |
| `desktop/src/renderer/fold-state.ts` | 20–33 | 新增 `turnFoldKey(sessionId, roundIndex)` → 键格式 `会话id:turn:轮序号` |
| `desktop/src/renderer/styles.css` | 6440–6584（文件末尾新段「整轮过程折叠」） | `.turn-fold` / `.turn-fold-label` / `.turn-fold-chevron` / `[data-open]` 旋转 / hover·active·focus 令牌 / `prefers-reduced-motion` 降级；每段都注明对照的 dsh 源码位置 |

### 3. 过程折叠程度三档（任务 3）

| 文件 | 行段 | 改了什么 |
| --- | --- | --- |
| `src/contract.ts` | 401–412、432–433 | 新增 `UiProcessFold = 'compact' \| 'standard' \| 'detailed'` 与 `UiPrefsView.processFold` |
| `src/core/prefs.ts` | 13、44–50、103–117、135、165、179–183 | 三档常量表 `PROCESS_FOLDS`、默认 `PROCESS_FOLD_DEFAULT = 'standard'`、`readProcessFold`（认不出回落 standard）、默认值、读档白名单 |
| `src/plugins/runtime.ts` | 298–304 | `setUiPrefs` 回执校验新增 `patch.processFold` 分支，三档各有回执（不加就会出「已保存工作区名字」的假提示） |
| `desktop/src/renderer/appearance.ts` | 9、12、88–101、127–129 | `normalizeProcessFold`（坏值回落 standard）并接进 `normalizeUiPrefs` |
| `desktop/src/renderer/App.tsx` | 75–76、85–87、301、528–531 | 首帧默认 `processFold: 'standard'`；把 `uiPrefs.processFold` 传给 `<ChatView>` |
| `desktop/src/renderer/SettingsModal.tsx` | 89、204、392、458–475 | 「通用 → 外观」组末尾加「过程折叠程度」一行（沿用 `Segments` 分段选择），含说明文案 |
| `desktop/src/renderer/ChatView.tsx` | 169–172、787–790 | 新增 `processFold` prop 并传给 `ThinkingBlock` 的 `showPreview` |
| `desktop/src/renderer/ThinkingBlock.tsx` | 93、104–110、127–128、153–155、176–187 | 新增 `showPreview` prop：紧凑档定稿行不渲染分隔点与摘要（`data-preview` 一并去掉），跑动中照显 |

### 4. 脚注合并 + 真实 tok（任务 4）

| 文件 | 行段 | 改了什么 |
| --- | --- | --- |
| `desktop/src/renderer/TurnFooter.tsx` | 全文重写（189 行） | 一条左对齐行，顺序 复制 · 赞 · 踩 · 分叉 · 用量 · 时刻；「用时」进整行 `title`；`usage` 真值优先、`tokens` 估算回落（带 `~`）；`copyText` / `voteState` / `onVote` 新 props |
| `desktop/src/renderer/ChatView.tsx` | 773–775（原 544–575 删） | 删掉助手消息末尾的 `.entry-meta` 操作条（复制 / 赞 / 踩 三颗按钮）与其包裹类 `entry-with-meta` |
| 同上 | 862–866 | 页脚拿到 `answer.text`、`answer.id` 派生的评价键与 `vote` 回调 |
| `desktop/src/renderer/styles.css` | 580–583（删）、1168–1172、6104–6106、6375–6397 | 删掉 `.entry-meta` / `.entry-with-meta` / `.meta-*` 的全部规则（含那条 `justify-content: flex-end`）；「对话区修正批」段的 28px 框选择器换成 `.round-foot .round-act` |
| 同上 | 6490–6530（新段内） | `.round-foot .round-act` 的颜色三态与 `.on` 常亮；分叉图标静息色提到 tertiary（与 dsh 一行同色） |

---

## 二、四件事的完成情况

1. **竖排字修复**：已完成。`.think-label` 补 `flex: none` + `white-space: nowrap`，静态探针 4 条断言通过；
   隔离截图自检把正文列压到 360px，`.think-label` 的 `getClientRects().length === 1`、`flex === '0 0 auto'`、
   `white-space === 'nowrap'`、宽 48px（不是被压成一列字的宽度）。
2. **整轮过程折叠**：已完成。定稿轮默认收起（用户消息 → 总开关行 → 最终回答），跑动轮强制展开且**不画总开关**
   （对齐 dsh `TurnProcessNodeView.tsx:18` 的 `status !== 'closed' → null`），plan / system 不进组，
   最终正文与页脚不折；展开态存 `会话id:turn:轮序号`，轮收尾自动复位成默认收起。
   一处实现反复：第一版跑动轮也画了总开关（点了没反应），实时用例把它量了出来（`toggleRounds` 里出现了跑动轮），
   改成跑动轮不渲染后才过。
3. **过程折叠程度三档**：已完成，全链路（contract → prefs 白名单 → runtime 回执 → 桌面端读写）。
   紧凑档：整轮折叠 + 定稿思考行不画摘要（实测 `data-preview` 缺失、`.think-summary` 与 `.think-dot` 计数为 0）；
   标准档（默认）：摘要回来（`data-preview="1"`、摘要文本非空）；详细档：不做整轮折叠（总开关数 0、过程条目照旧摊开）。
4. **脚注合并 + 真实 tok**：已完成。六项顺序在产物里的下标严格递增（复制 < 赞 < 踩 < 分叉 < 用量 < 时刻）；
   「用时」只在整行 `title` 里，行面文本不再含「用时」；实时用例里页脚显示 **`用量 330 tok`**（宿主上报的
   100+10+200+20 累计，不带 `~`，title 说明「宿主上报的真实用量」），老会话截图里仍是 `~58 tok`（估算，title 说明是估算）。

---

## 三、构建与自检结果

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 宿主侧编译 | `C:\Users\waq\node_global\pnpm.cmd build`（仓库根） | exit 0 |
| 桌面端类型检查 | `C:\Users\waq\node_global\pnpm.cmd --dir desktop typecheck` | exit 0 |
| 桌面端打包 | `C:\Users\waq\node_global\pnpm.cmd --dir desktop build` | exit 0（`out/renderer/assets/index-DUZ0ZtUS.css`、`index-DygPX1H7.js`） |
| 只读探针 | `node desktop/shots/fold-check.mjs` | **65 条断言，通过 65，失败 0**（日志 `fold-check.out`） |
| 隔离截图自检 | `pwsh -NoProfile -File fold-shots.ps1`（3 个用例） | **38 条断言全过**：fold-static 18/18、fold-settings 9/9、fold-live 11/11（日志 `fold-shots.out`、`fold-*.err.log`） |

截图（`desktop/shots/`）：`fold-static.png`（三轮收起态 + 页脚新结构）、`fold-settings.png`（设置行 + 详细档）、
`fold-live.png`（实时轮定稿后自动收起，页脚 `用量 330 tok`）。

### 真实 `~/.dsc` 指纹（跑前 / 跑后）

- 跑前：文件数 **137**（其中被运行中的 Muse Code 独占、只能记 LOCKED 的 1 个）·
  清单聚合 SHA256 `a38e01f642e787163fe95a26746a01a9351567db58c0a801976d6f9c9c8bb020` ·
  内容聚合 SHA256 `d2fa4313a670dc67cc82b29d82475e898f7d81c874d8b8d6fc07390e064cbf19`
- 跑后：文件数 **137**（LOCKED 1）·
  清单聚合 `a38e01f642e787163fe95a26746a01a9351567db58c0a801976d6f9c9c8bb020` ·
  内容聚合 `d2fa4313a670dc67cc82b29d82475e898f7d81c874d8b8d6fc07390e064cbf19`
- 差异行：**0 条**（Compare-Object 无输出）· 路径增删：**新增 0 / 减少 0**

隔离纪律：临时目录变量一律自命名（`$foldHome` / `$foldRealDsc` / `$foldElectron` …，绝不出现 `$home` / `$HOME`）；
`fold-home\AppData\Roaming` 预先建好；Electron 用 `Start-Process` 起 `node_modules\electron\dist\electron.exe`，
轮询 stderr 日志里的 `[selfcheck] 已写出`，最后 `taskkill /PID <自己那棵> /T /F`（没碰任何别的进程，尤其没动 Muse Code.exe）。

---

## 四、取舍与未尽事项

1. **分叉图标仍是 15px，复制 / 赞 / 踩是 17px**：需求只要求「图标沿用现在 17px 的规格」，分叉那颗原来是 15px，
   没被要求改，所以保持 15px（dsh 那一行是 17px 统一）。同一行两种大小是有意保留的现状，若要统一成 17px 是一行改动。
2. **页脚动作不再 hover 才出现**：改版前复制 / 赞 / 踩 挂在助手消息末尾，hover 或聚焦才浮出；现在这一行常驻
   （对照 dsh 的 `data-actions-reveal='always'`，收尾那一轮的动作条就是常显）。若想保留 hover 显隐，需要再包一层显隐规则。
3. **跑动中的轮不显示用量**：沿用改版前的口径（那一刻状态行正在报时间、用量还在长），真值只在定稿后显示。
   dsh 的整轮用量挂件也是轮收尾才渲染。
4. **plan 条目不折叠只在静态与代码层面验证**：种子会话造不出 `plan` 条目（要真跑一次 `exit_plan_mode` 审批），
   所以「plan 不进组」由探针在产物里断言（`entry.kind !== 'thinking' && !== 'tool' && !== 'text'` 那道过滤），
   没有做成截图用例。
5. **`roundTokens` 估算口径保留**：真值缺失时才用，估算与真值绝不混写（一个带 `~`、一个不带）。
   第三轮（一句正文都没有）用量那一格整块不画，而不是画 `~0 tok`。
6. **`.entry-meta` 旧规则整块删除**：base 段、`shot-reveal` 挂钩、改版段里那条 `justify-content: flex-end` 一起删了；
   `.round-sep` 这条旧规则仍在用（用量与时刻之间那个 `·`）。
7. **未做**：没有加 `docs/development-log.md` 条目（不在需求里），没有 commit、没有改版本号。
8. **未验证**：浅色主题下这一屏没另拍（结构与深色同一套令牌）；`prefers-reduced-motion` 只写了样式降级，没做截图用例。
