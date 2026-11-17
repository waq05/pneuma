# 缺陷记录（bugs）

按 GitHub issue 的写法记：一条 bug 一节，编号递增，**只增不删**；修好之后把状态改成已修，
并在末尾补一行修复提交与验收命令，不把正文抹掉（后来人要知道它当初怎么坏的）。

## 怎么加一条

复制下面的骨架，按顺序填；填不出来的写「查不到」，不要留空。

```
## BUG-000N：一句话说清用户遇到什么

- **状态**：待修 / 修复中 / 已修 / 不修（附理由）
- **严重度**：P0 阻断（功能不可用）/ P1 高（主要路径受影响）/ P2 中（有替代路径）/ P3 低
- **发现**：2026-MM-DD，版本 x.y.z，构建方式（dev / `dist:dir` 打包）
- **影响**：谁在什么场景下会撞上

**复现**
1. ……
2. 探针：`node desktop/shots/_xxx.mjs`（能一条命令跑出来的必须给）

**期望**：……
**实际**：……

**证据**
- 报错原文 / 采样数据 / 截图路径

**初步定位**（推测要标出来）
- `文件:行号`：……

**修复方向**：……
**验收**：跑哪条命令、看哪几个判据
```

---

## 索引

| 编号 | 标题 | 严重度 | 状态 | 影响功能 |
| --- | --- | --- | --- | --- |
| BUG-0001 | 装好第一次让 numa 跑命令，沙箱打 ACL 失败，命令不执行 | P0 | 已修（2026-11-17） | `bash` 等所有要执行命令的工具 |
| BUG-0002 | 侧栏「技能」「插件」点了不换页 | P1 | 已修（2026-11-17） | 技能页、插件中心两个一级入口 |
| BUG-0003 | 设置里没有「运行日志」分组 | P2 | 已修（2026-11-17） | 日志级别与上限没法在设置页改 |
| BUG-0004 | 附加可写根写相对路径时，围栏与 ACL 按两个不同的 cwd 落点 | P2 | 待修（2026-11-17 复核发现） | 配了相对路径附加根的人：围栏放行、实际写入仍被拒 |

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

- 截图：`desktop/shots/out/feat-bash-card.png`
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
`sandboxTmpDir(DSC_HOME, root)`（[backend.ts:206](src/packages/sandbox/win/backend.ts#L206)），
**不带会话 id = 工作区哈希**。后端自己算出来的那个目录谁都没建过，`GetNamedSecurityInfoW`
返回 Win32 错误 2（找不到文件），`ensureAuthorized` 就整条降级——第一次跑命令必然如此。

自检之所以一直绿，是因为 `scripts/sandbox-win-token-test.mjs` 里替它建好了目录，注释还写着
「真实宿主里由插件建」——那句话是错的。

**改了什么**：`ensureAuthorized` 在打 ACL 之前只给**私有临时目录**（`side === 'temp'`）`mkdirSync`，
建不出来才降级，理由写明是哪条路径；工作区与附加根**不替用户建**（它们是既有路径，配错了要让人
看见，别悄悄造目录再打上可继承的低完整性标签）。
（[backend.ts:279-303](src/packages/sandbox/win/backend.ts#L279-L303)）

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
- **发现**：2026-11-17，打包版；dev 版（`desktop/out`）同样复现，**不是打包问题**
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

1. 切页后立刻被踢回：[ui-sessions/ui.tsx:220](src/packages/ui-sessions/ui/ui.tsx#L220)
   `if (page !== null && !pageEntry) setShellPage(null)`；`pageEntry` 来自
   `usePageEntryAvailable(page ?? '')`（同文件 `:167`），判据是 `frame.graph.entries.some(e => e.id === entryId)`，
   **精确等值**。而两个页在槽里的 id 是 `plugins.page` / `skills.page`
   （[ui-plugins/ui/ui.tsx:147](src/packages/ui-plugins/ui/ui.tsx#L147)、
   [ui-skills/ui/ui.tsx:120](src/packages/ui-skills/ui/ui.tsx#L120)），传进去的却是 `'plugins'` / `'skills'`。
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
（[ui-sessions/ui/ui.tsx:167-190](src/packages/ui-sessions/ui/ui.tsx#L167-L190)）。守卫保留
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

- 截图：`desktop/shots/out/feat-settings.png`
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
（[log/index.ts:349](src/packages/log/index.ts#L349)），并就近写清为什么必须声明。

**怎么验的**

| 命令 | 结果 |
| --- | --- |
| `node desktop/shots/_diag-settings-sections2.mjs` | 修前左栏 9 项、没有运行日志；修后 **10 项**，多出「运行日志」（排在「工作区」与「关于」之间，order 880） |
| `node desktop/shots/_diag-log-section.mjs` | 点进去字段全在：记录级别（当前 `info`）、日志目录、保留多少天、单文件上限、目录总量上限、当前文件（真实路径）、「立即清理」按钮可点 |
| `node desktop/shots/_verify-features-packaged.mjs` | 第 [6] 段 3 条全绿；整份 **14 通过 / 0 失败 / 3 不适用** |

---

## BUG-0004：附加可写根写相对路径时，围栏与 ACL 按两个不同的 cwd 落点

- **状态**：待修
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
`src/packages/sandbox/win/backend.ts:207-210` 直接拿原始串传给 `grantWrite`，
相对路径由宿主进程的 cwd 决定（打包版就是安装目录），于是 ACL 打在另一个地方。
（顺带一个相邻的坑：附加根写成**已存在的文件**时，`mkdirSync` 会抛 `EEXIST`——BUG-0001 修完
只对 temp 建目录之后，这条路回到「打 ACL 失败 → 降级」，不会再抛。）

**证据**：`src/packages/sandbox/locale/ui.zh.json:20` 的帮助文案、
`policy.ts:677` 与 `backend.ts:207-210` 的对照；复核者用一次性探针确认了两处解析结果不同。

**修复方向**：在 `src/packages/sandbox/index.ts:530` 一带先把附加根绝对化（按当前会话 cwd），
再交给后端；或者后端复用 `canonicalizePath` 并在 `plan()` 里按 `run.cwd` 解析。
两处必须用同一个函数，别各写一套。

**验收**：自检里加一条「附加根给相对路径时，围栏允许的路径与 ACL 授权的路径是同一个绝对路径」。

---

## 记录模板之外的两句

- 验收用的探针都留在 `desktop/shots/`（不进 CI，本机跑）：`_pkg-harness.mjs` 是共用壳，
  `_verify-*-packaged.mjs` 是场景，`_diag-*.mjs` 是排查用的一次性脚本。
  **能脱离打包产物复现的**，另写一份进闸门的静态/纯函数自检（`scripts/<话题>-test.mjs`，
  由 `check:ui`、`check:plugin` 自动捡起）——BUG-0002 就是补的 `scripts/ui-page-switch-test.mjs`。
- 一条 bug 只写一个现象。像 BUG-0002 这种「可能是 A 也可能是 B」的，把两个候选都列出来，
  修的时候用一条实验区分，别在文档里下结论；两条都被排掉也别删，写清「怎么排掉的」——
  真正的原因往往在第三处（BUG-0002 收尾就是这样）。
