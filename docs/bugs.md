# 缺陷记录（bugs）

按 GitHub issue 的写法记：一条 bug 一节，编号递增，**只增不删**；修好之后把状态改成已修，
并在末尾补一行修复提交与验收命令，不把正文抹掉（后来人要知道它当初怎么坏的）。

## 怎么加一条

复制下面的骨架，按顺序填；填不出来的写「查不到」，不要留空。

**描述只写现象，原因与方案写进「解决」**（BUG-0015 起按这个形状写）：复现、期望、实际、证据是
报告时就知道的东西；什么导致的、怎么修、怎么验，属于事后才知道的，一起塞进「解决」。
分开放有两个好处——报告时不用猜原因（猜的必须标「这是猜的」，否则事后看成了结论），
读者先对上的是现象，再看根因，不会被一个错误的初步判断带偏（BUG-0001 当年就猜错过一次）。

```
## BUG-000N：一句话说清用户遇到什么（只写现象，不写原因）

- **状态**：待修 / 修复中 / 已修 / 不修（附理由）
- **严重度**：P0 阻断（功能不可用）/ P1 高（主要路径受影响）/ P2 中（有替代路径）/ P3 低
- **发现**：2026-MM-DD，版本 x.y.z，构建方式（dev / `dist:dir` 打包）
- **影响**：谁在什么场景下会撞上

**复现**
1. ……
2. 探针：`node scripts/<话题>-test.mjs`（能一条命令跑出来的必须给）

**期望**：……
**实际**：……

**证据**
- 报错原文 / 采样数据 / 截图路径

### 解决（2026-MM-DD）

**原因**：……
**方案**：改了哪些文件、为什么这么改（修完了才知道的，写这里）
**怎么验的**：跑哪条命令、看哪几个判据、结果是什么
**提交**：`<短 hash>`
```

---

## 索引

| 编号 | 标题 | 严重度 | 状态 | 影响功能 |
| --- | --- | --- | --- | --- |
| BUG-0001 | 装好第一次让 numa 跑命令，沙箱打 ACL 失败，命令不执行 | P0 | 已修（2026-11-17） | `bash` 等所有要执行命令的工具 |
| BUG-0002 | 侧栏「技能」「插件」点了不换页 | P1 | 已修（2026-11-17） | 技能页、插件中心两个一级入口 |
| BUG-0003 | 设置里没有「运行日志」分组 | P2 | 已修（2026-11-17） | 日志级别与上限没法在设置页改 |
| BUG-0004 | 附加可写根写相对路径时，围栏与 ACL 按两个不同的 cwd 落点 | P2 | 已修（2026-11-17） | 配了相对路径附加根的人：围栏放行、实际写入仍被拒 |
| BUG-0005 | 设置里显示的「沙箱私有临时目录」不是命令真正用的那个 | P3 | 已修（2026-11-17） | 按显示的路径找临时文件会找不到；策略层放行一个没人写的目录 |
| BUG-0006 | 在某个工作区里新建会话，那个目录整块跳到侧栏顶部 | P2 | 已修（2026-11-17） | 侧栏工作区分组的顺序 |
| BUG-0007 | 工作区文件夹图标点开/关后一直是灰色三角，看不出展开态 | P3 | 已修（2026-11-17） | 侧栏工作区行的图标与悬停换位 |
| BUG-0008 | 影子 git 的回合快照偶发记 0 条，回滚会漏文件 | P2 | 待修 | `checkpoint` 的回合账本与「回滚到回合前」 |
| BUG-0009 | README 的包数与默认关数量落后于磁盘 | P3 | 已修（2026-11-17） | 文档口径：读者照 README 数包会数不对 |
| BUG-0010 | superagent-webhook 没有英文译本，本地化探针的包数口径也停在 91 | P3 | 已修（2026-11-17） | 英文界面下这个包的标题与说明仍是中文；`plugin-locale-test` 必红 |
| BUG-0011 | 设置分区探针的断言停在两处 onChanged，代码已经是三处 | P3 | 已修（2026-11-17） | 不是产品行为，是探针口径漂移；`check:plugin` 必红 |
| BUG-0012 | 等宽文本里的中文落到宋体，代码块与工具输出发灰发糊 | P2 | 已修（2026-11-17） | Windows 上所有走 `--dsc-font-mono` 的地方：代码块、行内代码、工具输出 |
| BUG-0013 | 字号只能整体缩放、字体不可选，正文调不到舒服的大小 | P2 | 已修（2026-11-17） | 设置 → 外观：字体不可配；调到 135% 会连带放大侧栏与标题 |
| BUG-0014 | 过程正文 12px + 54% 灰，对比度约 3.9:1 | P3 | 不修（设计取舍，留记录） | 会话流里的过程正文、工具行、卡片行的可读性 |
| BUG-0015 | 搜索服务填好了 key，`web_search` 每次仍回 HTTP 401 | P1 | 已修（2026-11-17） | 联网搜索（Tavily / 博查 / Serper 三条路都中） |
| BUG-0016 | 没填 key 时 `web_search` 从工具表里消失，模型改用 curl 撞沙箱 TLS | P2 | 已修（2026-11-17） | 联网搜索的默认状态；会话里任何「上网查一下」 |

---

## BUG-0001：装好第一次让 numa 跑命令，沙箱打 ACL 失败，命令不执行

- **状态**：已修（2026-11-17）
- **严重度**：P0（功能不可用：模型发起的命令一条都跑不了）
- **发现**：2026-11-17，0.9.1 + 387 提交合并后的版本，`pnpm --dir desktop run dist:dir` 打包
- **影响**：全新 HOME（第一次安装、或换了 `DSC_HOME`）下，只要调用 `bash` 这类要换执行体的工具就撞。

**复现**

1. 用一次性 HOME 起打包产物，发一句能触发 `bash` 的话（假端点返回 `bash` 工具调用）：
   ```bash
   node desktop/shots/_diag-bash-sandbox.mjs
   ```
2. 看会话流里工具卡下方的说明行。

**期望**：命令执行，卡片是终端块（`$ echo marker-numa` + 输出 + 退出码 0）。

**实际**：命令没有执行；卡片下方一行沙箱说明，助手直接给收尾正文：

```
沙箱：受限令牌后端已降级为策略围栏（不再换执行体）：给可写根
[…\.dsc\sandbox\tmp\112b43dfbc29]（能力 SID S-1-4-122344503-851276823-1）
打 ACL 失败：GetNamedSecurityInfoW(三件套) 失败（Win32 错误码 2）：系统找不到指定的文件。
```

**证据**

- 截图：本地跑 `desktop/shots` 下的诊断脚本得到（截图为本机产物，不入库）
- 两轮对照（`_diag-bash-sandbox.mjs`）：A 不预建任何目录、B 预建 `sandbox/tmp`，**两轮报同一个错**，
  可写根路径里的 hash 也一样（`112b43dfbc29`）。所以不是「目录晚一步建」，是打 ACL 的那个路径
  在打之前就没被创建出来。
- 失败之后 `<HOME>/.dsc/sandbox/` 是空的（没有 `tmp/<hash>`）。

**初步定位**（推测）

- `src/packages/sandbox/win/acl.ts`、`src/packages/sandbox/win/backend.ts` 里给可写根打 DACL 的那一步：
  `GetNamedSecurityInfoW` 拿不到对象 → 说明对象不存在。要么少一次 `mkdir -p`，要么路径拼出来的是
  「临时目录 + 子路径」但只建了父目录。
- 降级逻辑本身是对的（打不上就退策略围栏），问题在**打不上**这件事。

**修复方向**：打 ACL 之前确保目标目录存在（`mkdir` 后再打，或先 `CreateDirectory` 再取安全描述符）；
打失败时把「哪个路径不存在」写进日志，别只留一句降级说明。

**验收**：`node desktop/shots/_diag-bash-sandbox.mjs` 两轮都出现工具卡、`marker-numa` 在正文里、
没有「打 ACL 失败」；再跑 `node desktop/shots/_verify-features-packaged.mjs` 第 [2] 段全绿。

### 修复（2026-11-17）

**真正的原因**：宿主（`src/packages/sandbox/index.ts:224`）建的私有临时目录是
`sandboxTmpDir(DSC_HOME, cwd, currentSessionId())`，**带会话 id**；受限令牌后端要授权的却是
`sandboxTmpDir(DSC_HOME, root)`（[backend.ts:206](../src/packages/sandbox/win/backend.ts#L206)），
**不带会话 id = 工作区哈希**。后端自己算出来的那个目录谁都没建过，`GetNamedSecurityInfoW`
返回 Win32 错误 2（找不到文件），`ensureAuthorized` 就整条降级——第一次跑命令必然如此。

自检之所以一直绿，是因为 `scripts/sandbox-win-token-test.mjs` 里替它建好了目录，注释还写着
「真实宿主里由插件建」——那句话是错的。

**改了什么**：`ensureAuthorized` 在打 ACL 之前只给**私有临时目录**（`side === 'temp'`）`mkdirSync`，
建不出来才降级，理由写明是哪条路径；工作区与附加根**不替用户建**（它们是既有路径，配错了要让人
看见，别悄悄造目录再打上可继承的低完整性标签）。
（[backend.ts:279-303](../src/packages/sandbox/win/backend.ts#L279-L303)）

**怎么验的**

| 命令 | 结果 |
| --- | --- |
| `node scripts/sandbox-win-token-test.mjs` | **93 通过 / 0 失败**：新增 3 条「临时目录不存在 → 后端自己建、plan 仍换执行体」+ 3 条「附加根不存在 → 不替用户建、按降级并说明、降级前 temp 照建」 |
| `node desktop/shots/_verify-sandbox-write-packaged.mjs`（打包版，读会话 jsonl 的工具结果） | **PASS**：`CWD=D:\dsc INSIDE_OK OUTSIDE_DENIED EPERM`，写根内文件真的落盘，写根外被系统层拒，界面无降级提示 |

修前的最小复现（当时 exit 1、报 Win32 错误 2）是一个临时脚本，现在被上面那 3 条自检判据覆盖，
不再需要单独脚本——`tmp-repro/` 不进版本库，写在文档里谁也复现不了。

**顺带修了探针**：`desktop/shots/_pkg-harness.mjs` 的 HOME 从仓库里挪到系统临时目录（C 盘）。
这台机器的 D 盘**不许给新建目录设完整性标签**（`icacls /setintegritylevel` 直接 Access is denied），
探针 HOME 落在仓库里会让每个沙箱用例都撞 ACL 失败——那是探针位置的问题，不是产品的问题。

---

## BUG-0002：侧栏「技能」「插件」点了不换页

- **状态**：已修（2026-11-17）
- **严重度**：P1（两个一级入口完全失效，插件中心没有别的入口）
- **发现**：2026-11-17，打包版；dev 版（本地起开发构建）同样复现，**不是打包问题**
- **影响**：想进技能页或插件中心的人，点侧栏没反应，只剩「设置」一条路（而设置里也没有插件中心）。

**复现**

1. 起打包产物，停在首屏：
   ```bash
   node desktop/shots/_diag-page-switch.mjs
   ```
   或 `DIAG_DEV=1 node desktop/shots/_diag-plugins.mjs`（dev 版）
2. 点侧栏「技能」或「插件」。

**期望**：主区换成整页（技能列表 / 插件中心），按钮点亮（`aria-pressed=true`、class 带 `on`）。

**实际**：主区仍是首屏。50ms 采样连采 1.5 秒（30 次），`aria-pressed` **始终 false**、class 始终没有 `on`；
`.welcome` 一直在。正文只多了 7 个字（侧栏冒出一条「新会话 刚刚」）。

**证据**

- `_diag-page-switch.mjs` 输出：
  `[技能] 出现变化的采样数: 0 / 30`、`[插件] 出现变化的采样数: 0 / 30`
- `_diag-plugins.mjs`：三种点法（`el.click()`、CDP 真实鼠标、点父节点）结果一致；
  节点是 `BUTTON.nav-item`、`disabled=false`、rect `[8,127,220,32]`
- 打包产物 `resources/dsc-core/lib/ui/plugins/` 里 22 个包齐全，含 `plugins`、`skills`

**初步定位**（推测，两条都要排）

1. 切页后立刻被踢回：[ui-sessions/ui.tsx:220](../src/packages/ui-sessions/ui/ui.tsx#L220)
   `if (page !== null && !pageEntry) setShellPage(null)`；`pageEntry` 来自
   `usePageEntryAvailable(page ?? '')`（同文件 `:167`），判据是 `frame.graph.entries.some(e => e.id === entryId)`，
   **精确等值**。而两个页在槽里的 id 是 `plugins.page` / `skills.page`
   （[ui-plugins/ui/ui.tsx:147](../src/packages/ui-plugins/ui/ui.tsx#L147)、
   [ui-skills/ui/ui.tsx:120](../src/packages/ui-skills/ui/ui.tsx#L120)），传进去的却是 `'plugins'` / `'skills'`。
   如果 `entries` 里没有这些短名，守卫就会在 effect 里立刻把页踢回 null——与「按下即回滚、一次都没点亮」吻合。
2. 点击没进到 React：按钮的 `onClick` 绑的是 `setShellPage(...)`；`el.click()` 与真实鼠标都试过，
   若 handler 根本没跑，采样也应该一次都不变（与观察一致）。区分这两条最省事的办法是在 handler
   里临时打一行 console，或把守卫的条件打印出来。

**修复方向**：把「页 id」与「槽条目 id」的口径统一（要么都叫 `plugins`，要么判断时按 `id === x || id === x + '.page'`）；
守卫只应处理「界面包被停用」，不该把「刚切过去、槽还没挂上」当成停用。

**验收**：`node desktop/shots/_verify-pages-packaged.mjs` 三页全绿；`_diag-page-switch.mjs` 里
`aria-pressed` 至少一次变 true、`.welcome` 消失。

### 修复（2026-11-17）

**先排除了两条猜测**（都写进证据，免得后来人重走）：

- 候选 1（id 口径不一致）**不成立**：`frame.graph.entries` 里的 id 就是界面包目录名
  `plugins` / `skills` / `superagent`（从 `/api/events` 自己收一条 plugins 帧打印出来核对的），
  与侧栏写进去的短名一致，`pageEntry` 在那种情况下是 true。
- 候选 2（点击没进 React）**不成立**：从按钮的 `__reactProps$` 上取出 `onClick` 直接调用，
  与真实鼠标点击结果一致；点击之后侧栏那一行确实重渲染了一次（`MutationObserver` 记到两次
  `aria-pressed` 属性写入）。

**真正的原因**：`usePageEntryAvailable` 把「这一页在不在」算成一个**布尔**存进 `useState`。
布尔是按**当时的** entryId 算的：停在对话页时传进去的是 `''`（谁都匹配不上 → 恒 false），
点技能那一帧 entryId 变成 `'skills'`，可 state 里还是上一个 entryId 的答案 false。
守卫 `if (page !== null && !pageEntry) setShellPage(null)` 就在同一个提交之后跑起来，
把「答案还没更新」当成「这页的插件被停用了」，当场把页踢回对话页——所以点几次都没反应，
`getSnapshot()` 读到的也一直是 null。

**改了什么**：state 里存**启动图帧**，每次渲染现算「在不在」，entryId 与答案不会再错位
（[ui-sessions/ui/ui.tsx:167-190](../src/packages/ui-sessions/ui/ui.tsx#L167-L190)）。守卫保留
（现在是同文件第 226 行，修前在第 220 行）。

**怎么验的**

| 命令 | 结果 |
| --- | --- |
| `node scripts/ui-page-switch-test.mjs`（新加的闸门，已进 `check:ui`） | **15 通过 / 0 失败**；含「脏副本必须红」：把布尔缓存写法换回去，判据立刻红 |
| `node scripts/check-ui.mjs` | **80/80 通过**（exit 0），新探针 `ui-page-switch-test.mjs` 在列 |
| `node desktop/shots/_diag-page-switch2.mjs`（打包版） | 真实鼠标点「技能」→ `aria-pressed="true"`、`.welcome` 消失、正文 149 字（技能页）；再点一次回对话页。插件同理 |
| `node desktop/shots/_verify-pages-packaged.mjs` | 设置 / 插件 / 技能三页各自画出内容且无加载失败，**全部通过** |

---

## BUG-0003：设置里没有「运行日志」分组

- **状态**：已修（2026-11-17）
- **严重度**：P2（日志照写，只是设置页改不了级别与上限）
- **发现**：2026-11-17，打包版
- **影响**：想在设置里统一改日志配置的人找不到入口（插件中心那张卡片详情页里还能改，
  但「设置 → 运行日志」这条路断了，log/README 写的就是这条路）。

**复现**

1. 起打包产物，点侧栏「设置」：
   ```bash
   node desktop/shots/_verify-features-packaged.mjs
   ```
   看第 [6] 段，或直接看截图。
2. 设置弹窗左栏只有九个分区：通用、模型、模式、用量统计、归档、终端界面、远程控制、工作区、关于。

**期望**：左栏有「运行日志」，进去能改级别、保留天数、单文件上限、总量上限（CHANGELOG「未发布」
的「可观测性」一段这么写的）。

**实际**：没有这一项。

**证据**

- 截图：本地跑设置页诊断脚本得到（截图为本机产物，不入库）
- `src/packages/log/locale/ui.zh.json` 里确实有 `section.title = 运行日志`、`section.subtitle = 落到 ~/.dsc/logs…`
- `src/packages/log` 只有宿主半（`index.ts`/`sink.ts`/`filter.ts`/`locale`），没有 `ui/` 目录、
  `package.json` 里也没有 `client` 声明；`lib/ui/plugins/` 与打包产物 `resources/dsc-core/lib/ui/plugins/`
  下都没有 `log` 这一项。

**初步定位**（推测）：这个分区该由宿主把「设置分区元数据」推给设置页（`log` 包提供 section，
设置页只需要渲染）。现在的现象像是**宿主没把它算进分区表**，或者设置了 `enabled` 条件未满足。

**修复方向**：确认 `log` 包是否在启动图里、是否把 section 注册进设置分区表；若它本就该是
「宿主半 + 设置分区」，补上注册即可；若是刻意隐藏，把条件与理由写进 CHANGELOG。

**验收**：`_verify-features-packaged.mjs` 第 [6] 段出现「运行日志」，点进去能看到级别下拉。

### 修复（2026-11-17）

**真正的原因**：`log` 包注册分区时没声明 `{ inSettings: true }`。设置页只列「内置分区 +
显式声明进来的插件分区」——`src/packages/settings/index.ts:551` 的
`builtin: section.inSettings === true || builtinIds.has(section.id)`，而内置那 8 个 id 里没有 `log`。
所以分区其实**推上来了**，只是在设置页的过滤里被扔掉，终端里一直看得见。
`src/packages/log/README.md:40` 写的是「设置 → 运行日志」能改，文档与界面这一处对不上。

**改了什么**：`ctx.settings.registerSection(section, { inSettings: true })`
（[log/index.ts:349](../src/packages/log/index.ts#L349)），并就近写清为什么必须声明。

**怎么验的**

| 命令 | 结果 |
| --- | --- |
| `node desktop/shots/_diag-settings-sections2.mjs` | 修前左栏 9 项、没有运行日志；修后 **10 项**，多出「运行日志」（排在「工作区」与「关于」之间，order 880） |
| `node desktop/shots/_diag-log-section.mjs` | 点进去字段全在：记录级别（当前 `info`）、日志目录、保留多少天、单文件上限、目录总量上限、当前文件（真实路径）、「立即清理」按钮可点 |
| `node desktop/shots/_verify-features-packaged.mjs` | 第 [6] 段 3 条全绿；整份 **14 通过 / 0 失败 / 3 不适用** |

---

## BUG-0004：附加可写根写相对路径时，围栏与 ACL 按两个不同的 cwd 落点

- **状态**：已修（2026-11-17）
- **严重度**：P2（只在「附加可写根填相对路径」时撞上；绝对路径没这个问题）
- **发现**：2026-11-17，修 BUG-0001 时的复核发现（同一片代码，独立成因）
- **影响**：用户在附加可写根里写 `rel/sub` 这类相对路径时，策略层按**会话 cwd** 放行，
  受限令牌后端按**宿主进程 cwd** 打 ACL，于是围栏说「可以写」、系统层仍然拒。

**复现**

1. 设置 → 插件中心 → 文件与命令围栏，附加可写根填一个相对路径（例如 `rel-out`）。
2. 让模型跑一条往 `<会话cwd>/rel-out/x.txt` 写的命令。
3. 围栏放行，但命令里那次写返回 `EPERM`。

**期望**：相对路径按「会话工作目录」解析，围栏与 ACL 落到同一处（帮助文案就是这么说的）。

**实际**：两处落点不同——策略层 `src/packages/sandbox/policy.ts:677` 用
`canonicalizePath(value, { win32, cwd })` 按会话 cwd 展开；后端
`src/packages/sandbox/win/backend.ts:207-210`（**修前的行号**）直接拿原始串传给 `grantWrite`，
相对路径由宿主进程的 cwd 决定（打包版就是安装目录），于是 ACL 打在另一个地方。
（顺带一个相邻的坑：附加根写成**已存在的文件**时，`grantWrite` 走 `GetNamedSecurityInfoW` /
`SetNamedSecurityInfoW`，对文件同样能成功，只是 OI|CI 继承在文件上没有意义——既不抛也不降级，
所以它不是「打 ACL 失败」那条路。复核时实测过。）

**证据**：`src/packages/sandbox/locale/ui.zh.json:20` 的帮助文案、
`policy.ts:677` 与 `backend.ts:207-210`（修前行号）的对照；复核者用一次性探针确认了两处解析结果不同。

**修复方向**：在 `src/packages/sandbox/index.ts:530` 一带先把附加根绝对化（按当前会话 cwd），
再交给后端；或者后端复用 `canonicalizePath` 并在 `plan()` 里按 `run.cwd` 解析。
两处必须用同一个函数，别各写一套。

**验收**：自检里加一条「附加根给相对路径时，围栏允许的路径与 ACL 授权的路径是同一个绝对路径」。

### 修复（2026-11-17）

**改了什么**：走的是「后端复用同一个函数」那条路——`writeRootsFor` 里对每条附加根调用
`canonicalizePath(…, { cwd })`（与 `policy.ts` 的 `createPolicy` 同一个函数、同一个 cwd），
拿到绝对路径再派生能力 SID、再交给 `grantWrite`
（[backend.ts:216-231](../src/packages/sandbox/win/backend.ts#L216-L231)）。

为什么不在 `sandbox/index.ts` 提前绝对化：那里有两个入口（策略快照与受限令牌后端），
只要有一个漏了就会重现同一个 bug；放在 `writeRootsFor` 里是「产出可写根的那一处」，
后端无论被谁调用都绕不过去。顺带把绝对路径也过一遍这个函数——大小写、8.3 短名、符号链接
拼法不同会派生出另一个 SID 身份，同一个目录就有两份能力 ACE（root 侧授权不回收），
去重也认不出来。

`cwd` 自己也过一遍同一个函数：会话从 junction / 符号链接进来时（`D:\link\proj` 实际指
`E:\data\proj`），cwd 按原串、附加根按真实拼法，同一个目录会变成两条根。这一条留给
「同一条路径只该有一个身份」，不是防 runner 退 127——runner 的 `verifySidForPath`
（[runner-entry.ts:300-306](../src/packages/sandbox/win/runner-entry.ts#L300-L306)）用的是
`--root` 收到的那个串原样复算，宿主怎么拼它就怎么算，对不上是不可能的；上一版文档里
「runner 按 realpath 复算，对不上会退 127」这句是错的，复核时纠正了。

`cwd` 规范化抽成了 `canonicalWriteCwd`，`plan()` 的 `--temp` 也用它。这一条是复核第二轮
抓到的回归：授权的是规范化后的那条 temp 根，`--temp` 还用原串，junction / 大小写拼法的会话里
TMP/TEMP 就指到一条既没能力 ACE、也没人建过的目录，子进程写临时目录直接被拒。

规范化**不通过**的那一类（8.3 短名、盘符不存在）与策略层同口径：这条根干脆不加。
否则策略层已经把它记进 `problems` 并拒绝写，后端还去授权，失败一次就把整条后端降级。

**怎么验的**

| 命令 | 结果 |
| --- | --- |
| `node scripts/sandbox-win-token-test.mjs` | **101 通过 / 0 失败**：新增 8 条 —— 相对附加根解析成「会话 cwd + rel-out」/ 不是宿主进程 cwd 旁边的那个 rel-out / 与 `createPolicy` 的可写根是同一条路径 / `--root` 里带的是绝对路径 / **受限令牌里真往那条相对附加根写文件成功** / 规范化不通过的附加根不加进来 / 经 junction 进来的 cwd 与真实路径的附加根只算一条根 / **junction 会话的 `--temp` 与已授权的 temp 根是同一条** |
| `node desktop/shots/_verify-sandbox-write-packaged.mjs`（重建后的打包版） | **PASS**（这次改动不碰工作区口径，跑它是确认没把 P0 那条弄回去） |

**没验到的**：没有在打包版界面上点着改「附加根」再跑命令（要动设置表单 + 一次重建），
证据停在令牌层——那正是这条 bug 出问题的那一层。

---

## BUG-0005：设置里显示的「沙箱私有临时目录」不是命令真正用的那个

- **状态**：已修（2026-11-17）
- **严重度**：P3（不影响强制，但显示骗人：按那个路径找临时文件找不到；策略层还放行了一个没人写的目录）
- **发现**：2026-11-17，复核 BUG-0004 第三轮时发现（同一片代码，独立成因）
- **影响**：想按界面上的路径去看沙箱临时文件的人会扑空；策略层的可写根多了一条不存在的口径。

**复现**

1. 设置 → 插件中心 → 文件与命令围栏，看「沙箱私有临时目录」那一行。
2. 让模型跑一条会写临时文件的命令（例如 node 脚本写 `process.env.TEMP`）。
3. 实际落点与界面显示的不是同一个目录。

**期望**：界面上显示的就是子进程 `TMP/TEMP` 指向的那个目录，也是策略层放行的那一个。

**实际**：插件层按**会话 id** 算（`sandboxTmpDir(DSC_HOME, cwd, currentSessionId())`），
受限令牌后端按**规范化 cwd 的哈希**算（`sandboxTmpDir(DSC_HOME, canonicalWriteCwd(cwd))`，
不带会话 id）。于是 `<DSC_HOME>/sandbox/tmp/` 下有两个目录：会话 id 那个是策略层放行、
界面显示、并被人 `mkdir` 出来的；哈希那个才是子进程真正在用的。

**证据**：`src/packages/sandbox/index.ts:224` 与 `src/packages/sandbox/win/backend.ts`
的 `writeRootsFor` / `--temp` 两处派生；复核者用一次性探针比对过两个路径不同。

**修复方向**：两处用同一个函数算，删掉「会话 id」那一版。

### 修复（2026-11-17）

**改了什么**：插件层改用后端导出的 `canonicalWriteCwd` 算临时目录
（[index.ts:224](../src/packages/sandbox/index.ts#L224)），`currentSessionId` 这个帮手随之删掉。
现在「策略层放行 / 界面显示 / 后端授权 / 子进程 TMP」是同一个路径。

**怎么验的**：`node scripts/sandbox-win-token-test.mjs` → **102 通过 / 0 失败**，新增判据
「插件层算的私有临时目录 = 后端授权的那条 temp 根」。

---

## BUG-0006：在某个工作区里新建会话，那个目录整块跳到侧栏顶部

- **状态**：已修（2026-11-17）
- **严重度**：P2（有替代路径：拖一次工作区顺序就固定了；但日常「在某个工作区里建一条新会话」就会撞上）
- **发现**：2026-11-17，0.9.1，dev（侧栏行为，开发态与打包态都一样）
- **影响**：用默认「手动排序」且从没拖过工作区顺序的人。在某个工作区里新建一条会话，那个工作区的分组整块跑到侧栏第一位；建在哪个工作区，哪个工作区就上浮。

**复现**

1. 侧栏至少有两个工作区（D:\dsc 与 C:\Users\waq 这类），顺序随便。
2. 在**靠后**的那个工作区里新建一条会话（工作区行尾的 ⊕，或切到那个目录后点「新会话」）。
3. 看侧栏：那个工作区整组跳到第一位。
4. 探针（纯 Node，不需要界面）：
   `node scripts/ui-sidebar-order-test.mjs` —— [7] 那组判据在修复前的代码上会红。

**期望**：那个工作区的位置不动。
**实际**：整个分组顶到顶部。

**证据**

```
修复前：基线 ["D:\\dsc","C:\\Users\\waq"] → 在 waq 新建一条会话后 ["C:\\Users\\waq","D:\\dsc"]
修复后：同一场景仍为 ["D:\\dsc","C:\\Users\\waq"]
```

**初步定位**

- `src/packages/ui-sessions/ui/grouping.ts:200`（修复前行号）：manual 档在 `workspaceOrder` 为空时，组间兜底
  用「组内最近一条会话的 `updatedAt` 倒序」。新建会话的 `updatedAt` 就是此刻，整组必然上浮。
- 同一根因的第二处：`workspaceOrder` 非空、但参与比较的两组都不在表里时，比较器同样掉回 `lastUsed`，
  于是「表外的工作区里新建会话」也会跳到表外第一。
- 读者注意：2026-11-13 修过「点会话时工作区跟着跑」（那修的是活动组置顶的 `aFresh` 守卫），
  没碰这个兜底，所以走「建会话」这条路的位移一直留着。

**修复方向**：组间的键换成「工作区第一次出现的时间」＝组内最早一条 `createdAt`，降序（越新加入的越靠上），
同键用 cwd 兜底成全序；空组取 `-Infinity` 排最后；非有限的 `createdAt` 按 0 计，避免 `NaN` 让比较器
失去全序。提交 `53ae9a67`。

**验收**：`node scripts/ui-sidebar-order-test.mjs` 退出码 0（35 条，含脏副本 A/B/C 各自必须变红）。

**手工复测（在侧栏里点一遍，约 1 分钟）**

1. 准备：侧栏至少两个工作区，「视图选项 → 排序方式」保持默认的**手动排序**；记下当前顺序，
   例如 `dsc → testing → waq`。
2. 在**最后一个**工作区点行尾的 ⊕（在此工作区新建会话）。侧栏顶上会出现一条高亮「新会话」行。
3. **看**：`waq` 这一组还在最后，没有跑到第一位。这一步就是报障现场。
4. 在这个组里发一条消息（内容随便），宿主会把临时行换成正式行。
5. **再看**：组顺序仍未变（新建会话 + 发第一条消息都不该让它上浮）。
6. 反证判据没空转：先用鼠标把某个工作区拖到最前（`workspaceOrder` 落盘），再按第 2~3 步在别的工作区
   新建会话——顺序仍按你拖的那份，会话活动不抢位。
7. 想验「表外组」那一路：搜索框里只留一个工作区名、把它拖一次（落盘的顺序只含这一个），清空搜索，
   再在别的组里新建会话——别的组照旧排在已拖组之后，不因新建而上浮。

---

## BUG-0007：工作区文件夹图标点开/关之后一直是灰色三角

- **状态**：已修（2026-11-17）
- **严重度**：P3（不影响操作，但展开/收起看不出文件夹状态）
- **发现**：2026-11-17，0.9.1，dev
- **影响**：用鼠标点过任意一个工作区行之后，那一行（以及之后点过的行）文件夹图标被换成三角并常驻，展开态该显示的「打开的文件夹」永远看不到；指针移开也不恢复。

**复现**

1. 侧栏里用鼠标点一下某个工作区的行（展开或收起都行）。
2. 把指针移到别处：那一行仍然显示灰色三角，而不是文件夹图标。
3. 探针：`node desktop/shots/_verify-sidebar-group-icons.mjs`（真机，CDP 发真鼠标事件；
   修复前 26 条里 7 条红，报障的样子原样复现）。

**期望**：指针移开就回到文件夹图标（收起=闭合文件夹，展开=打开的文件夹）；只有悬停、或键盘 Tab 到这一行时
才换成三角。

**实际**：三角常显，文件夹图标被 `display: none` 藏掉。

**证据**：截图 `desktop/shots/out/sidebar-group-icons-1-clicked.png`（修复那轮真机实拍）；
修复前后的对照图 `desktop/shots/out/sidebar-icon-before-after.png`。

**初步定位**：`src/packages/ui-renderer/ui/styles/legacy/views.css:347-372`（修复前行号）。
「文件夹常显、悬停换三角」这条设计没错，错在触发条件写成 `:focus-within`；而工作区行是
`<div role="button" tabIndex={0}>`（`src/packages/ui-sessions/ui/ui.tsx`），鼠标点一下就有焦点、
而且不会自己丢，于是 `:focus-within` 常成立。

**修复方向**：两条选择器都改 `:focus-visible`（鼠标点击不算键盘焦点，Tab 过来才算）；图标本身与展开态的
90° 旋转不动。产品口径由用户拍定：悬停时**仍然**换三角（对齐参考实现），这次只修焦点卡住。
提交 `0b296043`（CSS）、`d42e3b6f`（真机探针）。

**验收**：

- `node scripts/ui-group-folder-icon-test.mjs` 退出码 0（17 条静态判据，旧 CSS 与「图标写反」的 TSX 必须判红）。
- `node desktop/shots/_verify-sidebar-group-icons.mjs` 退出码 0（26/26：点完 `focusVisible=false` 时
  `.folder-icon` 是 `flex`、三角是 `none`；展开态 svg 子节点 `rect/rect/path`；悬停仍换三角；键盘 Tab 仍出三角）。
- **注意**：改 `views.css` 之后必须 `pnpm run build && pnpm run build:ui`，只跑 `build` 不重建界面包，
  真机加载的还是 `lib/ui/assets/style-<旧哈希>.css`，会把原始报障原样演一遍。

**手工复测（在侧栏里点一遍，约 1 分钟）**

1. 起界面之前先重建：`pnpm run build && pnpm run build:ui`（桌面端再加 `pnpm --dir desktop run build`）。
   **漏了 `build:ui` 你会看到旧样式，本 bug 会「原样复现」——这是复测里最容易踩的坑。**
   自检一句：`node -e "const fs=require('fs');const d='lib/ui/assets';for(const f of fs.readdirSync(d))if(f.endsWith('.css'))console.log(f,fs.readFileSync(d+'/'+f,'utf8').includes('focus-visible .folder-chevron'))"`
   应当打印 `true`。
2. 侧栏里用**鼠标**点一下任意工作区行（先记下它原来是展开还是收起）。
3. 把指针移到正文区（别停在侧栏上）。**看**：那一行左边是文件夹图标——收起态是闭合文件夹，
   展开态是「打开的文件夹」（前片往外翻的那个），不再是灰色三角。
4. 把指针移回那一行。**看**：这时换成实心三角（展开态旋转 90°）。这是设计里的悬停提示，**不算 bug**。
5. 按 Tab 把焦点移到某个工作区行（或先点正文再 Tab）。**看**：焦点落在行上时同样显示三角（键盘可见焦点），
   Tab 走开就回到文件夹图标。
6. 再点一次收起：图标换成闭合文件夹，三角不常驻。
7. 对照证据：`desktop/shots/out/sidebar-icon-before-after.png`（上：修前；下：修后）。

---

## BUG-0008：影子 git 的回合快照偶发记 0 条，回滚会漏文件

- **状态**：待修（2026-11-17 发现，未动代码）
- **严重度**：P2（不阻断日常；但账本为空时「回滚到回合前」看不到这回合改了哪些文件，回滚会漏）
- **发现**：2026-11-17，跑 `pnpm run check:plugin` 时撞见。`src/packages/checkpoint` 与 `main` 一字未改，是既有问题，不是当天那批提交引入的
- **影响**：想回滚到某个回合之前的人，偶尔会拿到一份空的改动清单，误以为这回合什么都没改

**复现**

1. 同一个文件连跑三次：

   ```sh
   node --test --test-isolation=none src/packages/checkpoint/tests/checkpoint.test.mjs
   ```

2. 三次实测（2026-11-17 16:47）分别是 `pass=5 fail=2`、`pass=6 fail=1`、`pass=7 fail=0`，挂的用例每次不同。

**期望**：pre/post 两张快照的树不同时，`recordTurnLedger` 一定记下改动条目。

**实际**：两张快照都返回 `ok: true`，但 `git diff <pre> <post>` 是空的，账本记 0 条
（断言原文：`第 1 回合应当记两条（改 a.txt、新增 b.txt），实际 0`）。另外两个集成用例也偶发失败：
「pre/post 两张快照、内容可回看、用户 .git 不受影响」与「超大文件进了 info/exclude 且活过多次 ensureRepo」。

**证据**

- 快照实现：`src/packages/checkpoint/shadow.ts:333`（`snapshot`）→ `:372`（`capture`：`add -A` → `commit --allow-empty` → 打 tag）。
- 账本实现：`shadow.ts:926` 的 `recordTurnLedger`，用 `git diff --name-status -z <pre> <post>` 取条目。
- 三个集成用例各自 `mkdtemp` 独立目录，不存在互相踩目录。

**初步定位**（推测，未证实）

`capture()` 只对 `git add -A` 抛错这条路有判据（`shadow.ts:375` 返回 `ok: false`）；
「加成功了但树没变」这条路没有任何判据，于是静默成功。可疑点：`commit --allow-empty`
让空提交也算成功，把「一个文件都没暂存到」和「本来就没改动」混成同一个结果。

**修复方向**

1. 先改 `capture`：提交前后 tree hash 相同、而工作树确实有改动时返回错误，把静默失败变成可见失败。
2. 再查 `add -A` 的时序：是文件写入与索引刷新撞车，还是 `ensureRepo` 首次初始化时索引未就绪。
3. **不许改测试去迁就失败**——「两张快照都 ok」这条断言本身是对的。

**验收**

- 连跑 10 次 `node --test --test-isolation=none src/packages/checkpoint/tests/checkpoint.test.mjs` 全绿。
- 人为让 `add -A` 空转（例如先把文件标成 `assume-unchanged` 再改内容）时，新判据必须判红。

---

## BUG-0009：README 的包数与默认关数量落后于磁盘

- **状态**：已修（2026-11-17）
- **严重度**：P3（文档骗人，不影响功能；但它是唯一不编译就能对外说谎的地方）
- **发现**：2026-11-17 跑 `check-core` 时 `readme-test` 2/26 失败
- **影响**：读者照 README 数包会数少一个；「默认关 12 个」与实际 13 个不符，照着数插件中心会对不上

**复现**

```sh
node scripts/readme-test.mjs
```

失败原文：`功能包数写的是磁盘上的数 — README 79 / 磁盘 80`、`默认关的个数与包清单一致 — README 12 / 包清单 13`。

**期望**：README 写的包数、默认关个数与 `src/packages/` 磁盘现状一致。

**实际**：README 停在 `superagent-webhook` 加进来之前的口径：79 个功能包、默认关 12、总包数 91、功能档 17。

**证据**

- 磁盘实测：92 个包目录 = 80 个功能包 + 12 个库包；默认关 13 个（官方 10 + 实验 3）。
- 漂移位置：`README.md:161`（功能包数与默认关）、`:163`（功能档与官方档计数）、`:235`（架构树里的包数）。

### 修复（2026-11-17）

**改了什么**：三处数字按磁盘对齐——功能包 `79→80`、默认关 `12→13`、总包数 `91→92`；
「17 个功能档」改「18 个」、「9 个在官方档」改「10 个」并补上 Super Agent Webhook。提交 `4193bbaf`。

**怎么验的**：`node scripts/readme-test.mjs` → **26/26 通过，退出码 0**。

---

## BUG-0010：superagent-webhook 没有英文译本，本地化探针的包数口径也停在 91

- **状态**：已修（2026-11-17）
- **严重度**：P3（英文界面下这个包的标题与说明仍是中文；同时让 `plugin-locale-test` 必红）
- **发现**：2026-11-17 跑 `check-core` 时 `plugin-locale-test` 3 条失败
- **影响**：把界面语言切成英文的人，在插件中心看到「Super Agent Webhook」这一档的中文说明；
  另外这条探针红着，`check:plugin` / `check-core` 都过不去

**复现**

```sh
node scripts/plugin-locale-test.mjs
```

失败原文：`包目录数与门禁口径一致（91） <- 92`、`全部包都声明了 ./locale/*.json 键 <- 91/92`、
`整体有合法的 title/description 译本 <- superagent-webhook: 清单没声明 ./locale/*.json；缺 locale/en.json`。

**期望**：每个功能包都声明 `./locale/*.json`，且有 `locale/en.json`（`title` ≤24 字符、`description` ≤80 字符）。

**实际**：`superagent-webhook` 是全仓唯一缺译本的功能包——`package.json` 里没有 `./locale/*.json` 导出，
也没有 `locale/` 目录；探针里的包数还写死成 91。

**证据**

- `src/packages/superagent-webhook/package.json`（修复前只有 `.`、`./cordis.patch.yml`、`./package.json` 三个导出）。
- `scripts/plugin-locale-test.mjs:89` 写死 `ids.length === 91`，磁盘是 92。

### 修复（2026-11-17）

**改了什么**：给包补 `./locale/*.json` 导出、`files` 里的 `locale/**`，新增 `locale/en.json`（两行：title / description）；
探针的包数口径 `91→92`（含两处注释）。顺带把 `superagent` 的英文 description 从 86 字符压到 76——它超了探针新加的 80 字符上限。提交 `4193bbaf`。

**怎么验的**：`node scripts/plugin-locale-test.mjs` → **38/38 通过，退出码 0**；
`node scripts/plugin-standard-check.mjs` → 0 条问题。

---

## BUG-0011：设置分区探针的断言停在两处 onChanged，代码已经是三处

- **状态**：已修（2026-11-17）
- **严重度**：P3（不涉及产品行为，是探针口径漂移；但它让 `check:plugin` 必红，挡合并）
- **发现**：2026-11-17 跑 `check-core` 时 `settings-embed-slot-test` 1 条失败
- **影响**：合并前门禁红，且失败信息写成「：3」，容易被误读成产品多调用了一次

**复现**

```sh
node scripts/settings-embed-slot-test.mjs
```

失败原文：`写回成功后通知父页重取分区清单（两处：保存与按钮动作）：3`。

**期望**：探针断言的口径与代码现状一致。

**实际**：代码里 `onChanged?.()` 有三处，探针写死两处。

**证据**

- `src/packages/ui-settings/ui/ui.tsx:501`（子分区字段保存后）、`:548`（按钮动作后）、`:736`（通用字段保存后）。
- 第三处由 `1bf3f53e`（设置字段补 fact 与 rows 并接通四个界面）引入，是两类保存 + 一个动作，不是重复调用。

### 修复（2026-11-17）

**改了什么**：断言与标签都改成三处（`两处保存与按钮动作`），不删任何一处调用。提交 `4193bbaf`。

**怎么验的**：`node scripts/settings-embed-slot-test.mjs` → **31/31 通过，退出码 0**。

---

## 记录模板之外的两句

- 验收用的探针都留在 `desktop/shots/`（不进 CI，本机跑）：`_pkg-harness.mjs` 是共用壳，
  `_verify-*-packaged.mjs` 是场景，`_diag-*.mjs` 是排查用的一次性脚本。
  **能脱离打包产物复现的**，另写一份进闸门的静态/纯函数自检（`scripts/<话题>-test.mjs`，
  由 `check:ui`、`check:plugin` 自动捡起）——BUG-0002 就是补的 `scripts/ui-page-switch-test.mjs`。
- 一条 bug 只写一个现象。像 BUG-0002 这种「可能是 A 也可能是 B」的，把两个候选都列出来，
  修的时候用一条实验区分，别在文档里下结论；两条都被排掉也别删，写清「怎么排掉的」——
  真正的原因往往在第三处（BUG-0002 收尾就是这样）。

---

## BUG-0012：等宽文本里的中文落到宋体，代码块与工具输出发灰发糊

- **状态**：已修（2026-11-17）
- **严重度**：P2（有替代路径：内容是能读的，只是笔画糊；11–12px 上最明显）
- **发现**：2026-11-17，0.9.1，`dev` 分支本机构建
- **影响**：Windows 上所有走 `--dsc-font-mono` 的地方——代码块、行内代码、工具输出、命令预览。
  Mac / Linux 上不明显：PingFang / Noto 会先命中系统等宽栈里的中文族，落不到宋体。

**复现**

1. 任意会话里让模型输出一段带中文注释的代码块（或把行内代码写成中文）。
2. 截一张图放大到 200% 看笔画：中文是宋体的横细竖粗，和旁边的 Consolas 不搭。

**期望**：中文用无衬线黑体（微软雅黑 / 思源黑体），不该是宋体。

**实际**：中文落到浏览器 `monospace` 通用族；Windows 上那是宋体。

**证据**

- 旧令牌：`--dsc-font-mono: 'JetBrains Mono', 'Cascadia Mono', 'Sarasa Mono SC', Consolas,
  'DejaVu Sans Mono', Menlo, ui-monospace, monospace`——整条没有 CJK，最后一族是裸 `monospace`。
- 本机 `C:\Windows\Fonts` 里没有 JetBrains Mono / Cascadia Mono / Sarasa Mono SC，
  Consolas 本身不含中文字形（`node scripts/ui-font-apply-test.mjs` 里那条「CJK 在 monospace 之前」
  就是给这件事上的锁）。

**初步定位**（已确证）

- `src/packages/ui-renderer/ui/styles/legacy/tokens.css:387-389`（修复前）：等宽栈没有 CJK 兜底。
- 同款问题 dsh 与 zcode 都修过：dsh 的代码栈**不带** `monospace` 尾巴、末尾挂雅黑；
  zcode 在 `monospace` 前显式插 `Microsoft YaHei UI / PingFang SC / Noto Sans CJK SC`。

**修复方向**：在 `monospace` 之前显式插入各平台 CJK 无衬线，让缺字形的西文等宽字体先跳过中文。

### 修复（2026-11-17）

**改了什么**：`tokens.css` 把等宽令牌拆成 `--dsc-font-mono-default`（用户变量在前、它兜底），
默认栈在 `monospace` 前插 `'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC'`。
提交 `1016fc48`。

**怎么验的**：`node scripts/ui-font-apply-test.mjs` → **42/42 通过**，其中两条判据：
「等宽栈在 monospace 之前含中文无衬线」「CJK 兜底不止一种（Mac / Linux）」。

---

## BUG-0013：字号只能在 85%–135% 之间整体缩放，字体不可选，正文调不到舒服的大小

- **状态**：已修（2026-11-17）
- **严重度**：P2（有替代路径：改系统缩放，但会连带改整个桌面）
- **发现**：2026-11-17，0.9.1，`dev` 分支本机构建
- **影响**：所有嫌正文偏小、或想换掉系统默认字体的人。调字号时侧栏、标题、卡片一起变，
  没有「只把正文放大」的档；字体更是完全不可配。

**复现**

1. 打开 设置 → 外观。
2. 只有一行「字号 100%」滑杆（85–135%），没有正文字体 / 代码字体可填。
3. 把滑杆拉到 135%：侧栏行高、标题、卡片一起放大，正文仍只能用这套系统字体。

**期望**：正文 / 代码能各填一条字体列表（留空用默认），字号按 px 直接调，改完立刻生效、重启保持。

**实际**：只有整体倍率；字体写死在令牌里。

**证据**

- 修复前 `src/packages/ui-settings/ui/ui.tsx:1135` 的 `appearanceKeys` 只有
  `themeMode / fontSize / density`，设置页没有字体控件。
- 修复前 `~/.dsc/settings.json` 的 `ui` 段没有字体字段；`tokens.css:384-390` 两条字体令牌写死。
- 字号语义是倍率，基准实际 14px（`styles.css:3806` 覆盖了 tokens 里的 13px），
  于是「100%」和「14px」在界面上对不上——设置页的说明还写着「正文 13px 为基准」。

**初步定位**：设计缺口，不是某一处写错。方案与取舍见 `docs/font-settings-plan.md`。

### 修复（2026-11-17）

**改了什么**：

- 字号真源换成 `ui.textSizePx`（10–22，默认 14）；`fontSize` 保留为派生值（px ÷ 14），
  给还没升级的消费方读；旧档只写了倍率或 `'sm'|'md'|'lg'` 的，读档时一次性换算成 px。
- 新增 `ui.textFontFamily` / `ui.codeFontFamily`，逗号分隔、空串 = 内置栈。
  归一函数 `normalizeFontList` 与 px↔倍率换算收在 `src/contract/fonts.ts`，宿主、壳、设置页共用一份。
- 设置页外观区加两行字体输入框（草稿 + 失焦/回车提交 + Esc 还原），字号滑杆改成 px（10–22，步长 1）。
- 字体令牌改成 `var(--dsc-font-text, 内置栈), 内置栈` 的形状；空串时壳 `removeProperty`
  （写空串会让整条 `font-family` 非法、退回浏览器默认字体）。

提交 `1016fc48`。

**怎么验的**：

- `node scripts/ui-font-prefs-test.mjs` → **41/41**（旧档迁移、夹取、字体串归一、写盘往返）。
- `node scripts/ui-font-apply-test.mjs` → **42/42**（假 DOM 上跑真 `applyAppearance`：空串删变量、
  px→倍率、老镜像迁移、令牌接线）。
- `pnpm run check:ui` → **83/83**；`pnpm run build`、`build:ui`、两份 `tsc`、`desktop typecheck` 全 0。
- 真机 `desktop/shots/font-scale-shots.ps1 -Case fonts-custom` 的 DOM 读数：
  `textInput="\"Noto Sans SC\""`、`codeInput="Consolas"`、`bodyFirst="Noto Sans SC"`，
  落盘 `settings.json` 是 `textSizePx:15 / fontSize:1.0714 / textFontFamily:"\"Noto Sans SC\""`。

---

## BUG-0014：过程正文 12px + 54% 灰，对比度约 3.9:1，低于小字号的 4.5:1

- **状态**：不修（理由见下：这是 2026-11-07 的排版取舍，改配色属于主题层整批调整；
  这次的字号滑杆已能把它按比例放大，先留记录）
- **严重度**：P3（可读性差，不影响功能）
- **发现**：2026-11-17，0.9.1，`dev`
- **影响**：会话流里「模型先说一句再调工具」那种过程正文（`.entry-note`），以及同档灰的
  工具行 / 卡片行（11px）。中文雅黑在这个色阶上笔画发虚。

**复现**：任意一轮里找「我来查一下……」这种过程正文，截图取色。

**期望**：小字号正文的对比度 ≥ 4.5:1。

**实际**：`--dsc-text-tertiary-a: 54%` 压在 claude 主题的 `#faf9f5` 上约 `#7e7e7b`，
对比度约 3.9:1。

**证据**

- `src/packages/ui-renderer/ui/styles/legacy/views.css:1416-1420`（`.entry-note`：12px + tertiary）。
- `tokens.css:536`（`--dsc-text-tertiary-a: 54%`）、`tokens.css:497-537`（claude 主题色阶）。

**初步定位**：`views.css:1416-1420` + `tokens.css:536`。

**修复方向**：两条路——把 `.entry-note` 提到 secondary（74%，约 7.7:1），或把 tertiary 整体上调；
后者会牵动所有用同一档灰的次要文字（时间、说明、角标），要跟主题层一起评估。

**验收**：改完用取色脚本量 `.entry-note` 的前景/背景，对比度 ≥ 4.5:1；并复查深色与 claude 两套主题。

---

## BUG-0015：搜索服务填好了 key，`web_search` 每次仍回 HTTP 401，一条结果都搜不到

- **状态**：已修（2026-11-17）
- **严重度**：P1（有替代路径：可以让我直接抓网页，但「搜索」这条主路径整个不可用）
- **发现**：2026-11-17，0.9.1，`dev` 分支本机构建
- **影响**：在插件中心给「联网搜索」填过 Tavily / 博查 / Serper 任何一家 key 的人。因为填不填 key
  都一样失败，第一反应通常是「key 填错了」「服务挂了」「额度用完了」——排查方向被带偏。

**复现**

1. 插件中心 → 联网搜索 → 搜索服务选 Tavily，填一个好用的 key，保存。
2. 会话里让模型查一条公开消息（例如某个库的最新版本号）。
3. 工具结果回 `HTTP 401：{"detail":{"error":"Unauthorized: missing or invalid API key."}}`。

**期望**：返回标题 + 链接 + 摘要的结果清单。

**实际**：每次调用都 401，换哪家提供方都一样。

**证据**

- 修复前 `src/packages/web-search/index.ts:222-227` 已经把鉴权头算好了
  （`{ authorization: 'Bearer <key>' }` 或 `{ 'X-API-KEY': <key> }`），
  但 `index.ts:228-231` 调 `search()` 时**没把它传下去**。
- 修复前 `search()` 的签名里没有这个参数，三个 `postJson(...)` 的第二参都写死空对象：
  `index.ts:135-137`（tavily）、`index.ts:154-156`（博查）、`index.ts:166`（serper）。
- 于是请求里既没有 `authorization` 也没有 `X-API-KEY`，服务端按未鉴权处理，回 401。

### 解决（2026-11-17）

**原因**：key 取到了、头也拼好了，但 `search()` 的入参里没这一项，调用点想传都传不进去。
TypeScript 不会为「算出来没用」报错（那个变量在声明处活了一次就没人读），所以编译、门禁、
源码形状断言全绿，只有真发一次请求才炸。

**方案**：

- 把 key 挪进请求对象（`SearchRequest`），由 `search()` 自己拼鉴权头（`authHeaders()`）。
  这样「少传 key」是**编不过**的，同类「参数算了却没传」不会再从数据面漏出去。
- 三个 `postJson(...)` 改成收 `auth`，不留空头的写法。
- 补一条请求面探针 `src/packages/web-search/tests/web-search-request.test.mjs`：用假 ctx +
  假 fetch 把工具真跑一遍，断言 `authorization === 'Bearer test-key-123'`、切到 serper 时换成
  `X-API-KEY`。以前的包级测试只对源码做形状断言，挡不住运行期丢参数。

**怎么验的**：`node src/packages/web-search/tests/web-search-request.test.mjs` → **18/18 通过，
退出码 0**；`pnpm run check:plugin` → **退出码 0**（93 包 / 143 用例 / 1752 断言全过）。

**提交**：`9d4db04f`

---

## BUG-0016：没填 key 时 `web_search` 从工具表里消失，模型改用 curl 抓网页并报 SEC_E_NO_CREDENTIALS

- **状态**：已修（2026-11-17）
- **严重度**：P2（有替代路径：填上 key 立刻正常；但用户看到的是「网络不通」的假象）
- **发现**：2026-11-17，0.9.1，`dev` 分支本机构建
- **影响**：装好、用默认配置、还没给「联网搜索」填 key 的人。会话里任何一句「上网查一下」
  都会落到 shell 里的 curl 上。

**复现**

1. 不动插件配置：`~/.dsc/plugins.json` 里 `web-search` 是开着的，但没有 `apiKey` / `apiKeyEnv`，
   环境变量与 `~/.dsc/credentials.yaml` 里也没有对应 key。
2. 会话里说「查一下 X 的最新版本」，模型拿不到 `web_search`，于是 `bash` + `curl https://…`。
3. 沙箱里回：`curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)`。

**期望**：模型看得见 `web_search`，调用后拿到一句「还没配 key，去哪填」，把原因转述给用户。

**实际**：工具整个不在工具表里，提示词里也没有搜索这回事。模型改用 curl，撞上沙箱的 TLS 限制，
用户看到的是一句网络错误。

**证据**

- 修复前 `src/packages/web-search/index.ts:179-182`：`syncTool()` 开头
  `if (resolveKey(config) === '') return () => {}`——没 key 就什么都不注册。
- 修复前 `index.ts:239-249`：提示词也在没 key 时返回空串（`resolveKey(readConfig()) === '' ? '' : …`），
  模型连「这里本来有搜索」都不知道。
- 本机 30 个会话的 `session.jsonl` 里 `web_search` 调用 **0 次**；启动时那句 notice
  （「联网搜索已启用，但还没配搜索服务的 key」）**一次都没出现**——两条独立证据都指向「工具不在场」。
- 同一环境下 `node -e "fetch('https://www.baidu.com')"` 与 `git ls-remote https://…` 都通，
  只有走 Windows Schannel 的 `curl.exe` / `Invoke-WebRequest` 失败——所以「网络不通」是假象。

### 解决（2026-11-17）

**原因**：两件事叠在一起。① 没 key 就把工具撤掉，模型失去「我能搜」这个信号，只能改用 shell；
② 沙箱的受限令牌（Low 完整性 + 限制 SID）拿不到用户凭据，走 Schannel 的 curl 因此报
`SEC_E_NO_CREDENTIALS`，而 Node 自己的 TLS 栈不受影响。

**方案**：

- 工具改成**稳定注册**：一直挂在工具表里；没取到 key 时调用回一句可照做的错
  （写明 `DEEPSEEK_API_KEY` / `~/.dsc/credentials.yaml` / 插件中心，并明说别用 curl）。提示词同样常驻。
- 新增 `web-fetch` 插件（工具 `web_fetch`）：抓取搬到宿主进程，HTML 转 Markdown，不依赖任何 key，
  模型不必再碰 shell；提示词里写明「别用 curl，沙箱里会报 SEC_E_NO_CREDENTIALS」。

**怎么验的**：

- `node src/packages/web-search/tests/web-search-request.test.mjs` → **18/18**（其中三条钉的就是：
  没 key 时工具仍在场、调用回可照做的错、启动 notice 提到 `DEEPSEEK_API_KEY`）。
- `node src/packages/web-fetch/tests/web-fetch.test.mjs` → **25/25**。
- 真机（进程内、临时 HOME）：`web_fetch` 抓 `https://example.com` → HTTP 200 + Markdown；
  `http://github.com` → 明确报「被重定向到 https://…（跨域，不自动跟随）」；`file://` → 拦住。

**提交**：`9d4db04f`（web-search 侧）、`b2f55c30`（web-fetch 侧）
