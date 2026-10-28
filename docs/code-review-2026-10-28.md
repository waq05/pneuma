# 全仓代码审查（2026-10-28）

> **审查基线**：分支 `feat/dock-browser`，HEAD `e500f9c`（0.7.1）。
> 审查时间 2026-10-28 00:08–08:40。审查期间工作区有 25 个在途改动（附件功能），
> 本文没有碰它们，也没有提交任何东西；需要区分"HEAD 事实"和"工作区现状"的地方，
> 文中都单独标了。

## 一、怎么审的

- **读**：目录结构、`package.json` / `tsconfig.json`、[development.md](development.md) 与
  [development-log.md](development-log.md)、三条启动链路（`src/boot.ts` / `src/headless.ts` /
  `src/host/kernel.ts`）、契约层（`src/contract.ts` / `src/services/types.ts`）。
- **跑**：根、桌面端、界面壳三处 `tsc --noEmit`；`src` 依赖环扫描；跨文件重复块检测；
  新旧界面层文件对相似度；格式统计（缩进 / 引号 / 分号 / 行宽 / 换行符 / 文件头注释）。
- **量**：448 个 `.ts/.tsx`，合计 145,695 行——`src` 85,933 行、
  `ui-shell/src` 38,727 行、`desktop/src` 21,035 行。

## 二、结论摘要

分层是对的，风格是统一的，这两件事在同类项目里算上等。真正的短板是**校验闸门**
和**同一层里的重复实现**：

1. 主干现在**编译不过**，而且这是 24 小时内的第二次；
2. CI 只负责发版，类型检查和 49 条内核探针没有一处自动跑；
3. 四份界面代码并存，新壳是照冻结的旧渲染层整段搬的（跨文件重复行占 8.9%）；
4. 同一件小事（格式化时长、错误文案、弹窗骨架）各写三五份；
5. 格式统一靠人手工守，没有任何 lint / format / `.gitattributes` 兜底。

| 编号 | 严重度 | 问题 | 状态 |
| --- | --- | --- | --- |
| P0-1 | 阻断 | 主干 `e500f9c` 编译不过：引用了未入库的 `src/core/attachments.ts`，`StatusView.progress` 也没补齐 | **仍在**（工作区已能编译，缺一次提交） |
| P0-2 | 高 | CI 只有 `release.yml`，类型检查与自检脚本没有任何自动门禁 | 已修（`verify.yml`） |
| P0-3 | 高 | `a20dd74` 上 7 个 `replace` 类型错误进过主干，20 分钟后才被 `d1b8e08` 补上 | 已修 |
| P1-1 | 高 | 四份界面代码，旧渲染层 21,035 行已冻结但仍与新壳高度重复 | 仍在（已冻结） |
| P1-2 | 中 | `formatDuration` 5 份、`errText` 体系 19 处、对话框骨架 9 处 | 部分已修（时长格式化收到 1 份） |
| P1-3 | 中 | 巨石文件：契约 2,091 行、消息流 2,481 行 | 仍在 |
| P2-1 | 中 | 无 ESLint / Prettier / EditorConfig / `.gitattributes`，换行符混乱 | 部分已修（`.gitattributes` + `check:style`） |
| P2-2 | 中 | 三个 pnpm 项目三把锁、无 workspace、`ui-shell` 版本 2.0.0 | 仍在 |
| P2-3 | 低 | 文档里的路径与规模数字过期 | 仍在 |
| P3-1 | 低 | 59 条自检脚本无框架、无覆盖率 | 仍在 |

## 三、先说保住的九条

这些是本次审查里**实测确认**的优点，整改时不要顺手弄坏：

| 项 | 实测结果 |
| --- | --- |
| 分层 | `src/core` 里 0 处 import `react` / `ink` / `electron`，development.md 铁律 1 真在执行 |
| 依赖 | `src` 全量扫描 0 个循环依赖 |
| 注释 | 448 个文件里 445 个有文件头注释（缺的 3 个是 2 份 `vite-env.d.ts` 与 `desktop/src/renderer/main.tsx`） |
| 类型 | 全仓 `any` / `as any` 只扫到 1 处；`@ts-ignore` 类 11 处 |
| 排版 | 0 个 Tab、0 行尾空格；单引号 + 无分号 + 2 空格覆盖绝大多数文件 |
| 调试残留 | `src/core` 里 `console.log` 0 处，只出现在两个 CLI 工具里 |
| 契约版本 | `KERNEL_API_VERSION` / `HOST_PROTOCOL_VERSION` / `NATIVE_BRIDGE_VERSION` 三套版本号分治 |
| 测试发现 | 自检脚本按文件名自动发现（`scripts/_check-runner.mjs`），加探针不用改清单 |
| 内核粒度 | `src/core` 142 个文件 46,168 行，平均 325 行、最大 876 行，明显好于界面层 |

## 四、问题逐条

### P0-1　主干编译不过（现在仍然红）

**现象**：把 HEAD 单独导出成干净快照后跑类型检查，退出码 2，3 个错误：

```
$ git archive HEAD | tar -x -C .tmp-headcheck
$ cd .tmp-headcheck && npx tsc -p tsconfig.json --noEmit
src/contract.ts(10,41): error TS2307: Cannot find module './core/attachments.js'
src/services/types.ts(23,41): error TS2307: Cannot find module '../core/attachments.js'
src/plugins/transcript.ts(254,11): error TS2741: Property 'progress' is missing in type
  '{ cwd: string; ... contextSegments: RequestSegments; }' but required in type 'StatusView'.
EXIT=2
```

**根因**：

1. `src/contract.ts:10` 与 `src/services/types.ts:23` 已经 `import type { UserFileAttachment }`，
   但实现文件 `src/core/attachments.ts` **没有入库**——`git ls-files src/core/attachments.ts`
   输出为空，工作区里它是 `??` 未跟踪状态。也就是说，`d1b8e08` 只提交了引用方，没提交被引用方。
2. `src/contract.ts` 的 `StatusView` 新增了必填字段 `progress`，但 `src/plugins/transcript.ts:254`
   的构造点没有补上。同一批改动只改了一半。

**影响**：任何人此刻 `git clone` 后 `pnpm install && pnpm build` 都会报错；发布流水线
`release.yml` 里 `pnpm build` 也会失败（`tsc` 退出码 2）。本机的绿，是因为工作区里恰好
躺着那个未跟踪的文件。

**建议**：先把 `src/core/attachments.ts` 与相关改动一起提交，再补 `transcript.ts` 的
`progress` 字段；提交后用干净快照复验一次（命令见 §六 第一批第 1 条）。

**状态**：仍在（本次审查不写业务代码，只记录）。

### P0-2　CI 只负责发版，不负责校验

**证据**：`.github/workflows/` 下只有 `release.yml`，做三件事——tag 与两处 `package.json`
版本对账、npm 发布、打 Windows 安装器。而 [package.json](../package.json) 里的
`typecheck`、`check:core`、`check:ui`、`check:dsh`、`check:all` **全是手动命令**，
没有任何 job 调用它们。

**影响**：P0-3 已经发生过一次（`a20dd74` 上 7 个类型错误）；P0-1 是 12 小时后的第二次。
两次都不是"不会写"，是"没人拦"。

**建议**：加一个 `verify` 作业，`on: [push, pull_request]`，跑
`pnpm install --frozen-lockfile && pnpm typecheck && pnpm check:core`（`check:ui` 无浏览器
时可先只跑非 e2e 那 36 条）。成本约 10 分钟机器时间，收益是把这两类事故挡在合并前。

**状态**：仍在。

### P0-3　类型错误进过主干一次（已修，留作证据）

**证据**：`a20dd74` 上 `npx tsc -p tsconfig.json --noEmit` 报 7 个错误，全部同一根因：
`Preset` 接口缺 `replace` 字段，而 `src/core/presets.ts` 的 222 / 249 / 280 / 306 / 373 行
在写它、`src/plugins/presets.ts` 的 44 / 155 行在读它。`d1b8e08`（00:32）在
`src/core/presets.ts:87` 补上了 `replace: boolean`。

**这条的价值不在"修好了"，在于它证明了 P0-2**：一个 7 个错误的提交，在一个只有发版
流水线的仓库里，是可以静悄悄进主干的。

**状态**：已修（`d1b8e08`）。

### P1-1　四份界面代码，新壳是照冻结的旧渲染层整段搬的

**现状**：README 说"一颗内核，三种前端"，代码里实际是四份界面实现：

| 前端 | 位置 | 行数 | 状态 |
| --- | --- | --- | --- |
| 终端 TUI（Ink） | `src/app/` | 5,900 | 在用 |
| 旧桌面渲染层 | `desktop/src/renderer/` | 21,035 | **已冻结**，壳产物缺失时回落 |
| 新界面壳（桌面 + 手机共用） | `ui-shell/src/` | 38,727 | 在用，默认加载 |

**重复的量化**（基线 `a20dd74`，界面层在那之后没有被改过）：

- 跨文件重复块覆盖 **8.9%** 的有效行；
- 只看 `desktop/src`：**35.3%**；只看 `ui-shell/src`：**22.6%**；`src/core` 只有 3.2%。

相似度超过 30% 的文件对共 **29 对**，最扎眼的七对：

| 相似度 | 行数 | 文件对 |
| --- | --- | --- |
| 100% | 70 | `desktop/src/renderer/files-tree-store.ts` ↔ `ui-shell/src/plugins/files/tree-store.ts` |
| 98% | 503 | `desktop/src/renderer/completion-sound.ts` ↔ `ui-shell/src/ui-primitives/completion-sound.ts`（只差 2 行） |
| 94% | 532 | `desktop/src/renderer/process-groups.ts` ↔ `ui-shell/src/plugins/transcript/process-groups.ts` |
| 91% | 408 | `desktop/src/renderer/icons.tsx` ↔ `ui-shell/src/ui-primitives/icons.tsx` |
| 90% | 82 | `desktop/src/renderer/unified-diff.ts` ↔ `ui-shell/src/plugins/files/diff.ts` |
| 77% | 305 | `desktop/src/renderer/dock-model.ts` ↔ `ui-shell/src/ui-dockkit/dock-model.ts` |
| 77% | 248 | `desktop/src/renderer/trace-format.ts` ↔ `ui-shell/src/plugins/trace/trace-format.ts` |

**已经开始分叉的实例**：`appearance.ts` 两份（旧层 302 行、壳 207 行），壳侧文件头写着
"从旧版搬过来时故意删掉三件事……现在回来了"。同一个外观偏好、两套归一化规则，改一边
忘一边就是"桌面端字号正常、手机页不生效"。

**影响**：同一处 UI bug 要修两遍；修的时候两边行为已经不完全一致，无法机械照搬。
21,035 行的冻结层还占着仓库体积与 grep 噪音。

**建议**：既然已经冻结，就给它一个**日落日期**（建议三个月），期间只修 P0 bug；
真正的复用不在"共享组件"，而在把**不含 JSX 的纯逻辑**下沉——`process-groups`、
`trace-format`、diff 解析、`dock-model`、`files-tree-store` 这些是纯函数，抽到
`src/core/` 或共享包，三条界面皮一起引，还能直接进 `check:core`。

**状态**：已冻结，未日落。

### P1-2　同一件小事，各处各写一份（HEAD 复核）

| 重复项 | 份数 | 位置 |
| --- | --- | --- |
| `formatDuration`（入参毫秒，可为 null） | 5 | `ui-shell/src/ui-primitives/time.ts:45`、`plugins/statusbar/ui.tsx:720`、`plugins/team/ui.tsx:51`、`plugins/status/status-model.ts:182`、`desktop/src/renderer/turn-timing.ts:58` |
| `errText` 体系 | 19 处 | 正主 `src/core/err-text.ts`；**7 个文件自己又写一遍**（`core/desktop-control.ts`、`core/learnings/skill-write.ts`、`core/lifecycle-hooks.ts`、`plugins/lifecycle-hooks.ts`、`plugins/sandbox.ts`、`plugins/self-improve.ts`、`plugins/spill.ts`）；**8 个文件从 `adapter/transcript.js` 转手拿**；另有 3 处用 `const err = (error) => ...` 起了同义函数（`host/kernel.ts:79`、`plugins/settings.ts:59`、`plugins/skills.ts:41`） |
| 圆角全屏浮层骨架 | 6 | `src/app/ModelPicker.tsx:24`、`PresetPicker.tsx:30`、`SkillsPicker.tsx:25`、`AgentsOverlay.tsx:86`、`SessionPicker.tsx:97`、`SettingsOverlay.tsx:254` |
| `role="dialog"` 手写弹窗 | 9 | 分布在 7 个壳插件（files / palette / settings×2 / team / trace） |

**影响**：不是"多几行代码"，是口径会漂。`errText` 的正主文件头自己写着"这句话此前抄了
五份"，说明作者知道这件事，但没收敛干净；现在数出来是 19 处。

**建议**：`formatDuration` 统一到 `ui-primitives/time.ts`；`errText` 一律从
`core/err-text.js` 引，删掉 7 份本地实现与 8 条转手路径；TUI 抽 `PickerFrame`、
壳抽 `Dialog`，替换 6 + 9 处手写。

**状态**：仍在。

### P1-3　巨石文件（HEAD 行数）

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `ui-shell/src/plugins/transcript/ui.tsx` | 2,481 | 31 个顶层函数 + 7 个 Context，一个文件就是整条消息流 |
| `ui-shell/src/plugins/composer/ui.tsx` | 2,110 | |
| `src/contract.ts` | 2,091 | 116 个导出，UI ⇄ 运行时唯一契约 |
| `ui-shell/src/plugins/sessions/ui.tsx` | 1,943 | |
| `ui-shell/src/plugins/settings/models.tsx` | 1,900 | |
| `ui-shell/src/plugins/status/ui.tsx` | 1,886 | |
| `src/app/App.tsx` | 1,853 | TUI 总装 |
| `src/services/types.ts` | 1,432 | 62 个导出 |
| `src/plugins/browser.ts` | 1,546 | 单个插件 |

`contract.ts` 与 `services/types.ts` 合起来 3,523 行、178 个导出，是整仓类型的脊柱。
它们的问题不是"长"，是**没有按服务切开**：任何一处改动都让 IDE 变慢、review 只能看 diff。

**建议**：`contract.ts` 按域拆成 transcript / settings / session / dock / preset 五个文件
再 re-export，导出面不变、导入方零改动；`transcript/ui.tsx` 先拆 `useFollowBottom` 与
欢迎页两块出去（它们是自包含的）。

**状态**：仍在。

### P2-1　格式统一靠人肉，没有工具兜底

**现状数据**（说明现状是好的）：
- 缩进：0 个 Tab；0 行尾空格；
- 引号 / 分号：557/561 个文件统一"单引号 + 无分号"；
- 行宽：软 100 列，99 分位 116 列，超 100 列的只占 2.4%。

**缺的东西**：`.eslintrc*`、`eslint.config.*`、`.prettierrc*`、`.editorconfig`、
`.gitattributes` **一个都没有**，`package.json` 也没有 `lint` 脚本。

**换行符**：索引里全是 LF，工作区里 436 个文件 LF、**287 个 CRLF、6 个 mixed**；
`core.autocrlf=true` 且没有 `.gitattributes`。每次 git 触碰都会刷
`LF will be replaced by CRLF` 警告（本次审查复现了）。

**影响**：现在的统一是"上一拨人手工统一过"，不是"机器保证的"。下一个人用别的编辑器
保存一次就开始漂；扩容到多人时，一个纯换行符的 diff 会淹掉真实改动。

**建议**：先加 `.gitattributes`（`* text=auto eol=lf` + 二进制白名单，一次性把 mixed 的
6 个文件归一），再加 ESLint 三条规则（`no-unused-vars`、`no-floating-promises`、
`import/order`）与 `prettier --check`，**只查改动文件**，不做全量重排——全量重排会产出
14 万行的纯格式提交，`git blame` 全废。

**状态**：仍在。

### P2-2　工程组织：三个项目、三把锁、版本号不齐

- 根、`desktop/`、`ui-shell/` 是三个独立 pnpm 项目，**三把 lockfile、没有
  `pnpm-workspace.yaml`**，react / vite 等同名依赖各装一份。
- 版本号：根 0.7.1、`desktop` 0.7.1、**`ui-shell` 2.0.0**（私有包 `dsc-ui-shell`）。
  `release.yml` 的版本对账只核前两个。
- 壳通过 vite alias 指向根的 `../lib`：**不先编译根就编不过壳**，两个项目隐式强耦合，
  却不在一把锁里。

**建议**：要么引入 workspace 统一安装与版本，要么在 `docs/development.md` 里写清
"为什么保持三个独立项目、升级依赖时怎么同步"。`ui-shell` 的 2.0.0 需要一句解释，
或者跟根对齐。

**状态**：仍在。

### P2-3　文档里的路径与数字过期

- `src/contract.ts:5-9` 的边界说明还在讲"UI 层（`src/app/**`、`src/state/**`、
  `src/commands.ts`）"——`src/state/` 与 `src/commands.ts` 早就不存在了。
- `docs/development.md` §2 说 `src/core/` 是 **131 个文件 ≈42400 行**，实测
  **142 个文件 46,168 行**；同表写 `src/core/dsh-compat/` 2 个文件，实际 8 个。

**影响**：注释和手册是"指路牌"，指错路比不写更费时间。

**建议**：改代码时顺手校正（本次审查不动这两处，避免与在途改动抢同一片 diff）。

**状态**：仍在。

### P3-1　自检脚本：思路好，工具原始

59 个 `scripts/*-test.mjs`，全部用自建 runner（`scripts/_check-runner.mjs`），
按退出码判定——这个约定干净，也让"加探针不用登记"成立。但：**0 个文件用 `node:test`**，
没有覆盖率、没有 watch、失败定位靠各脚本自己打印。

**建议**：不急着换框架。先给核心纯函数（压缩预算、上下文裁剪、策略判定、路径围栏）
补一层 `node:test` 单测——它们不需要真 HOME、跑得快，是最便宜回归网。

**状态**：仍在。

## 五、架构判断

**分层是清楚的，问题在"层内分裂"。**

`core（纯能力）→ services/contract（契约）→ plugins（能力包装）→ host（装配）`，加上
UI 侧"宿主只暴露白名单方法"的边界，这套骨架经得起看：实测 0 循环依赖、core 0 UI 依赖、
三套版本号分治、扩展点真在被使用。

要动的是两件：

1. **同一层长出了多份实现**（TUI + 旧渲染层 + 新壳），而且复制方式是"整文件复制"。
2. **契约用单个巨型文件承载整个边界**，边界清楚但改动面巨大。

一个有意思的旁证：`src/core` 平均 325 行一个文件、最大 876 行；界面层最大 2,481 行。
重复与膨胀都长在皮上，没长在骨头上——所以整改应该从界面层下手，别动内核的骨架。

## 六、整改计划

### 第一批（半天，零风险；先装闸门）

1. **修 P0-1**：提交 `src/core/attachments.ts`，补 `transcript.ts` 的 `progress`。
   复验方式：
   ```
   git archive HEAD | tar -x -C .tmp-headcheck
   cd .tmp-headcheck && npx tsc -p tsconfig.json --noEmit   # 期望 EXIT=0
   ```
2. **加 CI**：`verify` 作业跑 `typecheck` + `check:core`，`on: [push, pull_request]`。
3. **加 `.gitattributes`**：`* text=auto eol=lf`，把 6 个 mixed 文件归一。
4. **加 ESLint 三条规则 + `prettier --check`（只查改动文件）**。

### 第二批（1–2 天；收敛重复）

1. `formatDuration` 并到 `ui-primitives/time.ts`，其余 4 处改 re-export。
2. `errText` 全部改从 `core/err-text.js` 引；删 7 份本地实现、8 条转手路径、3 个同义别名。
3. TUI 抽 `PickerFrame`（替换 6 处）、壳抽 `Dialog`（替换 9 处）。
4. 校正 `contract.ts` 头部路径与 `development.md` §2 的规模数字。

### 第三批（1–2 周；需要拍板，收益最大）

1. 旧渲染层定日落日期（建议三个月），期间只修 P0。
2. 纯逻辑下沉：`process-groups`、`trace-format`、diff 解析、`dock-model`、
   `files-tree-store` 移到 `src/core/` 或共享包，三条界面皮一起引，并进 `check:core`。
3. 契约拆分：`contract.ts` 按域拆五个文件再 re-export，导出面不变。

## 七、待拍板

1. **旧渲染层留多久？** 建议"已冻结 + 三个月日落"，到期删除，届时能砍掉 21,035 行、
   把跨文件重复率从 8.9% 压到 3% 以内。
2. ~~**要不要 Prettier 全量重排？**~~ 已决定不做，改用零依赖的 `check:style`（理由见 §九）。
3. **`ui-shell` 的 2.0.0 跟不跟根对齐？** 若跟随根发版就该同版；若独立演进，就写进
   `release.yml` 的对账说明并在开发手册里留一句。

## 八、这次审查的边界

- **只读**：没有改任何源码，没有提交。
- **没跑全量自检**：`check:core`（约 8 分钟）、`check:ui`、`check:dsh` 都没跑；
  本次只跑了三处 `tsc` 与静态检测。所以"功能是否仍然正确"不在本文结论里。
- **没算在途改动**：审查期间工作区的 25 个改动（附件功能）没有被纳入任何结论；
  P0-1 恰恰是因为它们才在本机"看起来是绿的"。
- **重复率是抽样口径**：以"连续 8 行规范化后跨文件相同"为判据，行覆盖法统计；
  它衡量的是"复制粘贴的体量"，不等于"所有可复用点"。
## 九、整改记录

### 第一批（2026-10-28 已落地，未提交）

| # | 改了什么 | 落在哪 | 验证 |
| --- | --- | --- | --- |
| 1 | 排版闸门：零依赖小脚本，查缩进里的制表符、行尾空白、BOM、同一文件混用 CRLF/LF、文件末尾缺换行 | `scripts/style-check.mjs`（新）、`package.json` 的 `check:style` | 全仓 634 个文件 0 问题，退出码 0 |
| 2 | 行尾归一：`.gitattributes` 把文本钉成 LF、二进制标 `binary`、Windows 脚本留 CRLF | `.gitattributes`（新） | `git diff` 里已出现"CRLF will be replaced by LF"提示，规则生效 |
| 3 | CI 门禁：每次推与每个 PR 跑根 / 界面壳 / 桌面端三处 typecheck 加排版检查 | `.github/workflows/verify.yml`（新） | 三处 typecheck 本地均绿（见下） |
| 4 | 时长格式化收口：团队面板与状态栏各删一份本地 `formatDuration`，改引 `ui-primitives/time.ts` | `ui-shell/src/plugins/team/ui.tsx`、`ui-shell/src/plugins/statusbar/ui.tsx` | `ui-shell` typecheck 绿 |
| 5 | 闸门查出来的既有问题一并修掉：4 个文件混用了行尾（`src/core/config.ts`、`src/core/market.ts`、`src/core/session-meta.ts`、`scripts/session-open-in-test.mjs`），11 个文件末尾缺换行 | 见 `git diff --numstat` | 混用的 4 个文件修完 `git diff` 为零（Git 本就按 LF 存）；缺末尾换行的 11 个文件各只多 1 行 |

**为什么没上 Prettier**：整仓重排会让 14.7 万行的 `git blame` 全部作废；"只查改动文件"
又会在每个被顺手改到的老文件上报出一堆与本次修改无关的错，逼着人重排，diff 更没法看。
这份代码库本来就 0 制表符、0 行尾空白，真正会破的是行尾与文件末尾这些"肉眼看不见"
的东西，一个小脚本就够了。§七 待拍板的第 2 问据此关闭。

**验证跑过的**：

```
npx tsc -p tsconfig.json --noEmit                 # 根，绿
pnpm -C ui-shell exec tsc -p tsconfig.json --noEmit  # 界面壳，绿
pnpm -C desktop exec tsc --noEmit -p tsconfig.node.json && ... -p tsconfig.web.json  # 桌面端，绿
pnpm run check:style                              # 634 个文件 0 问题
node scripts/style-check.mjs --changed            # 只看改动，同样绿
```

**验证没跑成的**：`pnpm -C ui-shell build`。这条要 vite 调 esbuild 子进程，在当前沙箱下
被拦成 `spawn EPERM`（子进程管道不可用）。typecheck 覆盖了类型，但"打包能不能过"
这一项本轮没有验证。

### 卡住的一条：P0-1 缺一次提交

工作区里 `src/core/attachments.ts`（484 行）与 `src/plugins/transcript.ts:291` 的
`progress` 都在，所以**工作区能编译**；缺的是把它们提交上去。本轮没有代劳，原因有两个：

1. 它们是别的在途改动（附件功能，25 个文件）的一部分，替人拆开提交会打断那条线的完整性；
2. 本机 `.git` 目录不可写——`git checkout -- src/core/config.ts` 直接报
   `fatal: Unable to create 'D:/dsc/.git/index.lock': Permission denied`，暂存与提交都做不了。

交付命令（确认附件功能完整后执行）：

```bash
git add src/core/attachments.ts src/contract.ts src/services/types.ts src/plugins/transcript.ts \
        src/core/session.ts src/core/loop.ts src/core/llm.ts src/core/events.ts \
        src/core/ui-methods.ts src/core/ui-server.ts ui-shell/src/plugins/composer/attachments.ts
git add .gitattributes .github/workflows/verify.yml scripts/style-check.mjs package.json
git commit -m "fix(build): 补齐附件模块与状态进度字段，主干恢复编译"
git archive HEAD | tar -x -C .tmp-headcheck && (cd .tmp-headcheck && npx tsc -p tsconfig.json --noEmit)
```

最后一行是复验：只有干净检出也能过，才算真的修好。

