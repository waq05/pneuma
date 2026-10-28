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
| P0-1 | 阻断 | 主干 `e500f9c` 编译不过：引用了未入库的 `src/core/attachments.ts`，`StatusView.progress` 也没补齐 | 已修（`7099b8a` 后干净检出 `tsc` 退出码 0） |
| P0-2 | 高 | CI 只有 `release.yml`，类型检查与自检脚本没有任何自动门禁 | 已修（`verify.yml`） |
| P0-3 | 高 | `a20dd74` 上 7 个 `replace` 类型错误进过主干，20 分钟后才被 `d1b8e08` 补上 | 已修 |
| P1-1 | 高 | 四份界面代码，旧渲染层 21,035 行已冻结但仍与新壳高度重复 | **已清**（2026-10-28 整体删除，见 §二十三） |
| P1-2 | 中 | `formatDuration` 5 份、`errText` 体系 19 处、对话框骨架 9 处 | 已修（错误文案 / 数值收敛 / 对象判定各 1 份，TUI 浮层外框 1 处，提交对话框补了焦点；剩下 4 个 `formatDuration` 语义不同，见 §10.4） |
| P1-3 | 中 | 巨石文件：契约 2,091 行、消息流 2,481 行 | 仍在 |
| P2-1 | 中 | 无 ESLint / Prettier / EditorConfig / `.gitattributes`，换行符混乱 | 部分已修（`.gitattributes` + `check:style`） |
| P2-2 | 中 | 三个 pnpm 项目三把锁、无 workspace、`ui-shell` 版本 2.0.0 | 已清（版本对齐 0.7.1，见 §七第 3 条；四个项目已收成 workspace，见 §二十二） |
| P2-3 | 低 | 文档里的路径与规模数字过期 | 已修（§2 仓库地图按 0.7.1 重填） |
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
| `ui-shell/src/plugins/transcript/ui.tsx` | 658（原 2,481） | 第十四批已拆（见 §二十四）：装配 + 主流程 + 分页/折叠接线 |
| `ui-shell/src/plugins/composer/ui.tsx` | 1,023（原 2,354） | 第十五、十六批已拆完，见 §二十五、§二十六 |
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
- 版本号：根 0.7.1、`desktop` 0.7.1、`ui-shell` 2.0.0（私有包 `dsc-ui-shell`）——当时三处不齐，现已对齐 0.7.1。
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
3. ~~**`ui-shell` 的 2.0.0 跟不跟根对齐？**~~ **已定：对齐 0.7.1。** 三处版本号从此同版，
   `release.yml` 按 tag / 根 / `desktop` / `ui-shell` 四方对账。

   代价明写着：`ui-shell` 的 version 同时是插件清单的 `apiVersion`，19 个内置插件按
   `"@dsc/ui": "^0.7.1"` 声明兼容性，构建期逐个校验。所以**每次改版本号，19 个 peer 区间
   要一起改**；`^0.7.1` 只认到 0.8.0 以下，出 0.8.0 那天不改就会被门禁拒掉。漏改不静默：
   `build-plugins` 会把失配的插件点名，`release.yml` 在打包前先跑它。

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
### 第二批（2026-10-28 同日，未提交）

| # | 改了什么 | 落在哪 | 验证 |
| --- | --- | --- | --- |
| 1 | `errText` 彻底收口：7 份本地实现改引 `core/err-text.ts`；另有 3 处 `const err = (error) => ...` 同义别名改成 `import { errText as err }`（既有调用点一个没动） | `src/core/desktop-control.ts`、`core/learnings/skill-write.ts`、`core/lifecycle-hooks.ts`、`plugins/lifecycle-hooks.ts`、`plugins/sandbox.ts`、`plugins/self-improve.ts`、`plugins/spill.ts`、`host/kernel.ts`、`plugins/settings.ts`、`plugins/skills.ts` | 全仓 `function errText` 只剩正主 1 处、`const err = (error` 0 处；根 typecheck 绿 |
| 2 | TUI 浮层外框收口：新增 `PickerFrame`，模型 / 模式 / 技能 / 子代理 / 会话五个浮层改用它，外层 8 行属性只此一份 | `src/app/PickerFrame.tsx`（新）+ 五个浮层 | 根 typecheck 绿；五个文件各少 9 行，`ModelPicker` 从 68 行降到 59 行 |
| 3 | 提交对话框补上焦点管理：Esc 关、Tab 圈在弹层里、打开时焦点落在提交信息框、关掉把焦点还给来源 | `ui-shell/src/plugins/files/changes.tsx:389` 起 `CommitDialog` | 界面壳 typecheck 绿 |
| 4 | 仓库地图的规模数字按 0.7.1 实测重填（日期从 10-16 改到 10-28） | `docs/development.md` §2 | 每格都按 `find`/`wc -l` 现量 |

**关于「9 处 `role="dialog"`」这条，报告写错了一半**：其中 5 处（设置、模型发现、队友面板、轨迹检查器、贴图放大）
早在 2026-10-25 就用上了 `ui-primitives/dialog-focus.ts` 的焦点管理；命令面板与手机配对各自手写了 Esc 与
`tabIndex`；真正裸着的只有**提交对话框**一个——它既没有 Esc、也没有焦点归还，本轮按同一套钩子补齐。
所以「抽一个 `Dialog` 组件替换 9 处」这个建议不成立：这 9 处的遮罩、布局、关闭方式本来就不同，
硬抽只会换来一堆开关；重复的是**行为**（焦点与 Esc），那已经有一个钩子在做。

**这一轮没验证到的**：TUI 浮层与提交对话框都只有 `tsc` 背书。`pnpm run build` 写不进 `lib/`（沙箱拒写已存在的产物），
所以 `scripts/commands-battery-test.mjs` 里那三条渲染冒烟跑的是旧产物，等于没跑；界面壳的 `vite build` 依旧 `spawn EPERM`。
这两处要在有完整权限的环境里各看一眼：终端里开一次 `/model`、`/resume`，以及文件页的「提交」。

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

**2026-10-28 晚些时候的结论**：这一条已经解除。附件功能与状态栏那批改动按 `e478997` → `a4c8f25` →
`d996bd5` 三个提交入库，本批的闸门与收口跟在 `4ef514e` → `8204b2a` → `a646f87` → `de3ae20` → `fe620fd` 后面。
复验方式与之前一样，把 HEAD 单独导出成干净快照：

```bash
git archive HEAD | tar -x -C .tmp-headcheck
node node_modules/typescript/bin/tsc -p .tmp-headcheck/tsconfig.json --noEmit
# 退出码 0
```

这条教训值得留在这里：**本地绿不算数**。同一份代码在本机能编译、导出成干净快照就红，差别只是工作区里
躺着一个没入库的文件——这种错靠人盯是盯不住的，`verify.yml` 那道门就是为它建的。
## 十、现状总览（2026-10-28 收尾）

一句话：**两个 P0 都清了，闸门已经开了，剩下的都是「要大动干戈」和「要人拍板」的账。**

分支 `feat/dock-browser`，HEAD `7099b8a`。这一轮所有改动都已入库，工作区干净；没有推送。

### 10.1 已入库的改动

| commit | 改了什么 | 谁的问题 |
| --- | --- | --- |
| `e478997` | 用户贴图与文件改存内容寻址对象，消息里只留引用 | 在途工作（P0-1 的根因） |
| `a4c8f25` | 输入区支持贴图与文件，消息流挂附件卡片 | 在途工作 |
| `d996bd5` | 状态栏改成 dsh 的三段式，轮/步取宿主真值 | 在途工作（P0-1 的另一半） |
| `4ef514e` | 排版闸门 `scripts/style-check.mjs`、`.gitattributes`、`verify.yml` | P0-2、P2-1 |
| `8204b2a` | `errText` 统一从 `core/err-text` 引，删掉七份本地实现 | P1-2 |
| `a646f87` | 抽 `PickerFrame`，收掉五份 TUI 浮层外框 | P1-2 |
| `de3ae20` | `errText` 的三个同义别名也收敛掉 | P1-2 |
| `fe620fd` | 提交对话框补上焦点管理 | P1-2（复审时新发现的残口） |
| `cc599ae`、`deafc7e`、`7099b8a` | 审查报告、开发日志与手册的对应记录 | P2-3 |

### 10.2 十条问题的结清情况

| 编号 | 现在 | 还差什么 |
| --- | --- | --- |
| P0-1 主干编译不过 | **已清** | 干净检出 `tsc` 退出码 0（复验命令见 §九） |
| P0-2 没有 CI 门禁 | **已清** | `verify.yml` 每次推 / 每个 PR 跑三处 typecheck 加排版；`check:core` 那 8 分钟没进 CI，留给夜跑 |
| P0-3 `replace` 那 7 个错 | 已清 | — |
| P1-1 四份界面代码 | **已清** | 旧渲染层 21,035 行已删除（§二十三）；重复率的大头没了 |
| P1-2 小工具各写一份 | **已清** | `errText` / `clampInt` / `asRecord` 各 1 份（第三批，见 §十一）；`formatDuration` 从 6 份收到 4 份，剩下 4 份**语义各不相同**（见 10.4） |
| P1-3 巨石文件 | **仍在** | 消息流 2,557 行、输入区 2,370 行、契约 2,093 行；拆契约是第三批的事 |
| P2-1 无格式工具 | 部分已清 | 有了 `.gitattributes` 与 `check:style`（零依赖，查 5 类硬伤）；ESLint 与全量格式化**故意没上**，理由见 §九 |
| P2-2 四个 pnpm 项目四把锁 | **已清** | 2026-10-28 收成一个 workspace（§二十二）：一次安装装齐四个项目，react 与 react-dom 用 overrides 钉死同版 |
| P2-3 文档数字过期 | **已清** | §2 仓库地图按 0.7.1 重填 |
| P3-1 自检脚本无框架 | **仍在** | 91 条 `scripts/*-test.mjs`，按文件名自动发现，没有覆盖率统计 |

### 10.3 这一轮验证了什么、没验证什么

在 HEAD `7099b8a` 上实跑：

```
git archive HEAD | tar -x -C .tmp-verify
node node_modules/typescript/bin/tsc -p .tmp-verify/tsconfig.json --noEmit   # 退出码 0
npx tsc -p tsconfig.json --noEmit                                             # 退出码 0
(cd ui-shell && npx tsc -p tsconfig.json --noEmit)                            # 退出码 0
(cd desktop && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json)  # 退出码 0
node scripts/style-check.mjs                                                  # 627 个文件 0 问题
```

**没验证的三处**，都不是「应该没事」，而是「这台机器上做不到」：

| 没验证的 | 为什么 | 怎么补 |
| --- | --- | --- |
| TUI 五个浮层的实际排版 | `pnpm run build` 写不进 `lib/`，渲染冒烟跑的是旧产物 | 终端里开 `/model`、`/resume`、`/skills`、`/preset`，看边框与候选行位置 |
| 提交对话框的焦点行为 | 同上（界面壳要靠 `vite build`，沙箱里 `spawn EPERM`） | 文件页点「提交」，按 Esc 该关、打开时焦点该在提交信息框里 |
| `check:core` 那 49 条探针 | 探针要 spawn 子进程，沙箱拦成 `spawn EPERM` | 本地或 CI 跑一次 `pnpm run check:core`（约 8 分钟） |

### 10.4 剩下这几个时长格式化为什么不算重复

| 位置 | 入参 | 输出 |
| --- | --- | --- |
| `ui-primitives/time.ts:45` | 毫秒 | `2分41秒` / `8秒` / `1时02分05秒`（对话页口径，**正主**） |
| `ui-primitives/time.ts:63`（`formatTraceDuration`） | 毫秒 | `4.2s` / `1m03s` / `2h05m`（轨迹页口径） |
| `ui-shell/src/plugins/status/status-model.ts:182` | 毫秒 | `1小时05分`（连秒都不给，状态页要的是粗粒度） |
| `src/core/schedule/rule.ts:705` | **秒** | `2分41秒`（日程规则里的时长，单位就不是毫秒） |
| `desktop/src/renderer/turn-timing.ts:58` | 毫秒 | 同轨迹页口径，但它在**已冻结的旧渲染层**里，跟着旧层一起日落 |

所以能合的已经合了（团队面板、状态栏两处并进正主）；剩下这几份要么单位和口径都不同，要么在等旧层下线。
硬合成一个带开关的函数，只会让每个调用点都要先想「我该传哪个开关」。

### 10.5 下次接手先跑这五条

```bash
git status --porcelain                    # 确认工作区干净
git log --oneline -5                      # 确认起点
npx tsc -p tsconfig.json --noEmit         # 内核类型
(cd ui-shell && npx tsc -p tsconfig.json --noEmit)   # 界面壳类型
node scripts/style-check.mjs              # 排版闸门（2 秒）
```

五条全绿再动手。要是 `check:style` 报出一堆「整篇 CRLF」，先跑一次 `git add --renormalize .` 再提交。

### 10.6 第三批仍然卡在决策上

三件事都要人拍板，代码本身没难度：

1. **旧渲染层什么时候删**。它 21,035 行、已冻结，是跨文件重复率的大头（8.9% 里绝大部分来自它）。
   建议给个三个月日落日期，到期直接删；不删的话，每个新功能都得考虑两边。
2. **要不要收成 pnpm workspace**。现在是根 / `ui-shell` / `desktop` / `remote-web` 四个项目四把锁，
   装依赖要装四遍，版本容易漂（`ui-shell` 当时还是 2.0.0）。收 workspace 会动发布链路，得一起评估。
3. **契约要不要拆**。`contract.ts` 2,093 行、`services/types.ts` 1,432 行，按域拆成五个文件再 re-export，
   导出面不变、风险可控，但会动到几乎每个文件的 import。

## 十一、第三批（2026-10-28 同日）：三个小工具各归一处

### 11.1 复审又捞出三组重复

前两批收的是「名字一样」的重复（叫 `errText` 的都并掉了）。这一批改成按**实现**搜，又捞出三组：

| 重复的东西 | 份数 | 上一批为什么漏了 |
| --- | --- | --- |
| `errorText(error)` | 10 份，逐字相同 | 上一批只搜 `errText` 这个名字。`errorText` 是同一个实现的另一个名字，改一份要改十处 |
| `clamp(value, min, max, fallback)` | 21 份 | 形态有四种：顶层函数、`readConfig` 里的箭头函数、叫 `clampNumber`、区间收成 `{min, max}`。搜同一个字符串搜不齐 |
| `asRecord` / `isRecord` | 7 份 | 两个名字、两种用法（返回对象 / 类型守卫），散在 core 与 plugins 两头 |

具体位置：`src/core/mcp.ts`、`src/core/remote/notify.ts`、`src/core/remote/push.ts`、`src/core/sandbox/win/{account,doctor,setup,wfp}.ts`、`src/core/schedule/store.ts`、`src/plugins/{lsp,mcp}.ts`（以上是 `errorText`）；`src/plugins/{ask,browser,compact,computer-use,dock-browser,file-review,goal,lsp,mcp,memory,microcompact,schedule,self-improve,session-search,subagent,tools-default,web-search}.ts`、`src/core/{hooks,lifecycle-hooks,image-diet,spill}.ts`（以上是 `clamp`）；`src/core/{mcp,lifecycle-hooks,web-http}.ts`、`src/core/remote/push.ts`、`src/core/lsp/normalize.ts`、`src/ui/frames.ts`、`src/plugins/mcp.ts`（以上是 `asRecord` / `isRecord`）。

### 11.2 怎么收的

| 落到哪 | 收了什么 | 引用方式 |
| --- | --- | --- |
| `src/core/err-text.ts`（原来就有，实现没动） | 10 份 `errorText` | `import { errText as errorText }`，调用点一个字没改 |
| `src/core/clamp.ts`（新增 22 行） | 21 份 `clamp` / `clampNumber` | 少数值形态用 `clampInt`；区间收成对象的用 `clampIntIn`。同样用 `as` 别名保住调用点 |
| `src/core/records.ts`（新增 24 行） | 7 份 `asRecord` / `isRecord` | 返回对象的那份用 `asRecord`，类型守卫那份用 `isRecord` |

三个模块都不 import 任何东西，放 core 谁都能引；`web-http.ts` 的 `isRecord` 改成从 `records.ts` 转出，
远程路由那几个文件的 import 一行都没动。

总账：36 个文件，+92 / −185 行（提交 `62e1823`），之后又补了两处收尾（`web-http.ts` 少一个空行、三处新 import 归位到 core 块内）。

### 11.3 一处行为变了，要说清楚

`src/plugins/self-improve.ts` 原来那份 `clamp` 用的是 `Math.trunc`，其余 20 份都是 `Math.round`。
它自己的注释还写着「照 memory 插件的写法」，而 memory 那份是 `Math.round`——所以是抄岔了，不是有意区分。
统一成四舍五入后，只有「带小数的配置输入」会有差别（设置页只会给整数，手动改 `plugins.json` 写 3.6 才会体现）。
其余 20 份的语义、区间、缺省值全部不变。

### 11.4 刻意没动的三处

| 位置 | 为什么不动 |
| --- | --- |
| `src/plugins/computer-use.ts:534` | 它是 `(num, min, max)` 三参数、没有缺省值的版本，用途是校验设置项（不合法要报错，不该静默回落）。跟 `clampInt` 不是一件事 |
| `src/core/goal.ts:39` `clampRounds`、`src/core/model-caps.ts:179` `clampEffort`、`src/core/desktop-control.ts:747` `clampToScreen` | 名字里有 clamp，做的是别的事（轮次上下限、档位映射、坐标夹进屏幕） |
| `desktop/src/renderer/**` | 冻结的旧渲染层，跟着旧层一起日落，不再单独改 |

### 11.5 验证

```
npx tsc -p tsconfig.json --noEmit                              # 退出码 0
(cd ui-shell && npx tsc -p tsconfig.json --noEmit)             # 退出码 0
(cd desktop && npx tsc -p tsconfig.json --noEmit)               # 退出码 0
(cd desktop && npx tsc -p tsconfig.node.json --noEmit)         # 退出码 0
node scripts/style-check.mjs                                   # 629 个文件 0 问题
```

没跑的还是 §10.3 那三样（TUI 浮层排版、提交对话框焦点、`check:core`），理由一样：这台机器上 spawn 被拦。

### 11.6 这一批之后 P1-2 算不算结清

**补记（同日晚）：这句话下得早了。** 换成按函数体扫之后，同源实现又找出 8 处
（`ui-shell` 七个界面插件各一份 `text`、`core/sandbox/win/backend.ts` 一份 `describeError`），
另外 `displayWidth`、`quoteForCmd`、`expandHome`、`lastUserText` 各两处。第四批已一并处理，见 §十二。

改判据：算结清不是「一份不剩」，而是三条：

1. 同一件事只有一处实现（`errText` / `clampInt` / `asRecord` 各一处）；
2. 剩下的同名函数**语义确实不同**，合并会制造开关参数（见 §10.4 与 §11.4）；
3. 新代码要写这类小工具时，仓库里有现成的、一眼能找到的落点。

下次复审要防的是复发：新增 `clamp` / `isRecord` / `errorText` 这类本地小函数，先看 `src/core/clamp.ts`、`src/core/records.ts`、`src/core/err-text.ts` 有没有现成的。

## 十二、第四批（2026-10-28 同日）：按函数体扫出来的 8 份，与插件边界

### 12.1 这批要解决什么

§11.6 那句「P1-2 算结清」写早了。用函数体比对（不是搜名字）重扫 `src` + `ui-shell/src` 共 386 个文件，
以下各组是**逐字相同**的实现：

| 重复的东西 | 份数 | 位置 |
| --- | --- | --- |
| `errText`（五种名字） | 9（含正主，本次收掉 8） | 正主 `core/err-text.ts`；`core/sandbox/win/backend.ts` 叫 `describeError`；`ui-shell` 七个插件叫 `text` / `describeError` |
| `displayWidth` + `isWideCodePoint` | 2 | `src/app/click.ts`、`src/app/markdown.ts` |
| `quoteForCmd` | 2 | `core/mcp.ts`、`core/lsp/client.ts` |
| `expandHome` / `expandPath` | 2 | `core/spill.ts`、`core/lifecycle-hooks.ts` |
| `lastUserText` / `lastAssistantText` | 2（各一对） | `core/learnings/skill-write.ts`、`plugins/memory.ts` |

### 12.2 插件化规范怎么约束这批改法

`ui-shell` 的七个界面插件都在插件边界上，按 [plugin-development.md](plugin-development.md) §10.4.1，
界面插件**只许值引用平台种子**（`@dsc/ui` / `@dsc/ui-primitives` / `@dsc/ui-slots` / `@dsc/ui-dockkit`），
`@dsc/ui-core` 故意不在种子里（它是壳的内部实现）。所以这 8 份不能就地 import 一个 core 文件了事，做法分三层：

1. `src/ui/index.ts`（`@dsc/ui-core`）把 `core/err-text.ts` 转出——跟着 `diff-text`、`token-estimate` 的先例，实现仍只有 core 一份；
2. `ui-shell/src/ui-primitives/error-text.ts` 从 `@dsc/ui-core` 再转一手，进平台种子；
3. 七个插件只写 `import { errText as text } from '@dsc/ui-primitives'`，调用点一个字没改。

这样做的另一个好处：第三方插件写 `catch` 文案时也有同一个出口，不必自己再抄一遍。

同一原则也决定了另外几处的落点：

| 落到哪 | 为什么是这里 |
| --- | --- |
| `core/path-policy.ts` 加 `expandHome` | 「用户写的路径怎么解释」本来就是路径护栏的事；两个调用方（`spill`、`lifecycle-hooks`）都已经 import 这个模块 |
| `core/shell-quote.ts`（新增） | 两个调用方都是 `shell: true` 起子进程，`cmd.exe` 的引号规则与业务无关 |
| `core/transcript-text.ts`（新增） | 记忆插件原本要 import「技能写入」这个别的业务域才能复用一段读消息的代码——这是插件边界上的坏味道；挪到 core 后两边都只依赖 core |
| `app/display-width.ts`（新增） | `click.ts`（点击命中）与 `markdown.ts`（表格列宽）互相 import 会成环，抽第三个无依赖模块，两边都引它 |

### 12.3 改了哪些文件

共 37 个文件（+163 / −194 行，另加 4 个新文件）：

- 新增：`src/app/display-width.ts`、`src/core/shell-quote.ts`、`src/core/transcript-text.ts`、`ui-shell/src/ui-primitives/error-text.ts`；
- 收口：`src/ui/index.ts`、`ui-shell/src/ui-primitives/index.ts`（两个桶各加一行出口）；
- 调用方改写：`src/app/` 九处（`click`、`markdown`、`scroll-model`、`ChatView`、`MarkdownView`、`StatusBar`、`TimelineRail`、`ApprovalCard`、`Composer`、`PlanReviewCard`、`SettingsOverlay`）、`src/core/` 六处、`src/plugins/` 四处、`ui-shell` 插件七处。

### 12.4 验证

```
npx tsc -p tsconfig.json --noEmit                              # 退出码 0
(cd ui-shell && npx tsc -p tsconfig.json --noEmit)             # 退出码 0
(cd desktop && npx tsc -p tsconfig.json --noEmit)               # 退出码 0
(cd desktop && npx tsc -p tsconfig.node.json --noEmit)         # 退出码 0
node scripts/style-check.mjs                                   # 633 个文件 0 问题
```

复扫结果：`errText`、`displayWidth`、`quoteForCmd`、`expandHome`、`lastUserText` 五组全部消失；
剩下的重复组见 §12.5。

### 12.5 还没收的重复（下一批的候选）

| 组 | 份数 | 值不值得收 |
| --- | --- | --- |
| `subscribe` / `emit`（监听器集合） | 5 + 3 | 要抽 store 工厂，会动 `ui-layout` 的契约，得单独讨论 |
| `readCwd` / `readTurnState` / `readSessions`（从 snapshot 取字段） | 4 / 3 / 3 | 先确认各家取值口径是否真一致，再谈合并 |
| `splitList`（按逗号空格切词） | 3 | 值得收，但要先看三处的空值与去重规则 |
| `shellOf`、`readBeforeWriteCheck`、`nonEmptyString`、`jsonText`、`isEnvFamily`、`isFiniteNumber`、`utf16Buffer` | 各 2 | 收益小，随手碰到再收 |

> 这张表写于第四批，之后各批陆续把里面的候选收掉了。第十批用 `scripts/dup-scan.mjs`
> 实测：表里 8 个「各 2」现在各只剩 1 处定义；`readCwd` 那组在第七批收进了
> `ui-primitives/snapshot.ts`。**只剩两处**，且都是有意留的：`emit`（2 份，收它等于
> 把一行换成一行调用）与 `formatDuration`（3 份，一份按秒、一份按毫秒、一份按天，
> 语义不同，见 §10.4）。

### 12.6 这批评审的边界

只扫了 `src` 与 `ui-shell/src` 的 TypeScript 函数体；`desktop/src/renderer`（冻结）与 `remote-web` 没扫。
方法上也有盲区：只看 9 行以内的函数体，只看逐字相同（归一化空白后），写法不同但语义相同的仍然识别不出。
所以「扫不出」只能说明没有这段字符串，不能说明没有重复。

## 十三、第五批（2026-10-28 同日）：把「小判定」也各归一处

§12.5 列出的候选里，能安全收的这次收完；要动 `ui-layout` 契约的留到下一批。

### 13.1 收掉的十一组

| 重复的东西 | 份数 | 收到哪 |
| --- | --- | --- |
| `splitList`（逗号/空白切词） | 3 | 新增 `core/strings.ts` |
| `nonEmptyString` / `pickDir` | 2 | 同上 |
| `shellOf`（该用哪个 shell） | 2 | `core/shell-quote.ts`（同属「起 shell」） |
| `jsonText`（序列化不了给 null） | 2 | 新增 `core/json-text.ts` |
| `isFiniteNumber`（类型守卫） | 2 | `core/clamp.ts`（数值判定与收敛同一个家） |
| `isEnvFamily`（`.env` 家族判定） | 2 | `core/path-policy.ts`（原本就住这里，改成导出） |
| `utf16Buffer`（Win32 字符串入参） | 2 | 新增 `core/sandbox/win/utf16.ts` |
| `pluginsDir`（`~/.dsc/plugins`） | 2 | 用 `core/ui-bundles.ts` 已有的 `thirdPartyUiRoot` |
| `uuidOf`（`<uuid>.jsonl` 取键） | 2 | `core/session.ts` 导出 |
| `tokensPerSecond` / `averageTtftMs` / `formatTokensPerSecond` | 3 | `core/throughput.ts` → `@dsc/ui-core` → 新增 `ui-primitives/throughput.ts` |
| `trimZero` / `oneLine` / `formatSize` / `joinPath` / `tsOf` | 各 2 | 基元包里本来就有（`tokens.ts` / `tool-summary.ts` / `sizes.ts` / `paths.ts` / `time.ts`），缺的只补一次导出 |

### 13.2 插件规范再一次决定落点

状态栏那三条吞吐函数上方原本写着这样一段理由：

> 为什么原样抄一份而不是 import：插件能 require 的只有 react 与 @dsc/ui（boot.ts 的白名单），拉不到别的模块。

这条理由**已经过期**：`ui-shell/src/plugin-api.ts:400` 写着「E6 起插件也可以直接按包名 `@dsc/ui-primitives` 取（平台种子，同一份实例）」，
`plugin-api.ts` 本身就有 `export * from '@dsc/ui-primitives'`。也就是说，抄一份的前提早就不成立，而注释还在原地替它作证。
这次一并删掉，并把吞吐口径按「core 出实现 → `@dsc/ui-core` 转出 → 基元包再转出 → 插件只用」三层落地。

`formatSize` / `joinPath` 这类也是同一个模式：两个插件各写一份，注释都写着「与那份同口径」——
「同口径」靠注释维持，就是迟早分叉的意思。收进基元包后由一份代码保证。

### 13.3 验证

```
npx tsc -p tsconfig.json --noEmit                              # 退出码 0
(cd ui-shell && npx tsc -p tsconfig.json --noEmit)             # 退出码 0
(cd desktop && npx tsc --noEmit -p tsconfig.json)               # 退出码 0
(cd desktop && npx tsc --noEmit -p tsconfig.node.json)         # 退出码 0
node scripts/style-check.mjs                                   # 638 个文件 0 问题
```

复扫：函数体重复组从 40 组降到 23 组（本批再收 10 组，加上前几批的红利）。

### 13.4 剩下的 13 组，为什么不在这批收

| 组 | 份数 | 卡在哪 |
| --- | --- | --- |
| `subscribe` / `emit`（监听器集合） | 5 + 3 | 要抽一个 store 工厂，会动 `ui-layout` 的对外契约与 `defineStore` 的用法 |
| `readCwd` / `readTurnState` / `readSessions` / `readSessionPath` / `readEntries` / `readLive` / `readGoal` / `readSessionId` | 4 / 3 / 3 / 2 / 2 / 2 / 2 / 2 | 都是「从 snapshot 某字段取视图」，形状像但取值口径要逐个核对（有的取不到回空数组、有的回 null） |
| `safeStringify` / `report` / `describeRef` / `clock` | 各 2 | 在 `plugins/browser.ts` 与 `plugins/dock-browser.ts` 之间。插件之间不许互相 import，正确做法是提到 `core/cdp/`——那是单独一批的活 |
| `readThrottle` | 2 | `plugins/host-stdio.ts` 与 `plugins/remote.ts` 各读一份自己的配置，属同一个插件间互助问题 |
| `sameGit`、`clip` / `flatten`、`basenameOf` | 各 2 | 跨包（core 与界面壳）或跨基元包，得先定谁转出给谁，避免基元包互相 import 成环 |

### 13.5 这批的边界

依然只处理「逐字相同的纯函数」。像 `subscribe` 那种**结构相同、语义不同**（各自的监听器集合装的是不同的东西）的重复，
合并它需要先设计一层抽象——那是重构，不是收口，不该混在一批里做。

## 十四、第六批（2026-10-28 同日）：浏览器两条链的输出层

§13.4 里「卡在哪」写的是「插件之间不许互相 import，正确落点是 `core/cdp/`」——这批就是把那个落点认下来。

### 14.1 收掉的四组

| 重复的东西 | 份数 | 收到哪 |
| --- | --- | --- |
| `report` / `describeRef` / `safeStringify` / `clock` | 各 2 | 新增 `core/cdp/report.ts` |
| 控制台、网络两行渲染 + `ConsoleEntry` / `NetworkEntry` | 各 2 | 同上（`consoleLine` / `networkLine`） |
| `RingBuffer`（事件环形缓冲） | 2 | 新增 `core/cdp/ring-buffer.ts`（留带 `resize` 的完整版） |
| `readThrottle` + 缺省 80 ms + 区间 16～1000 | 2 | 新增 `core/snapshot-throttle.ts` |
| `sameGit`（`GitSurface` 四字段） | 2 | 新增 `core/git-surface.ts` → `@dsc/ui-core` → `ui-primitives/git-surface.ts` |

### 14.2 这四组为什么排到最晚：注释把它们写成了「约定」

`plugins/dock-browser.ts` 里原本这么写：

> 一行人类可读摘要 + 一行结构化 JSON（照 browser.ts 的 report）。
> 定长环形缓冲：满了丢最旧的（照 browser.ts 的 RingBuffer 思路）。

「照某某抄」比干脆不写注释更难被发现——扫重复时很容易读成「有意对齐」，实际含义却是「这份代码没有第二个维护者」。

落点也不是随手选的：插件之间不许互相 import（[plugin-development.md](plugin-development.md) §10.4.1），
所以浏览器那条链的共用件只能落到 `core/cdp/`。这就是它比别的组晚一批的原因——不是收不了，
是先得认下落点，而不是在 `browser.ts` 里 `export` 一个函数让 `dock-browser.ts` 直接 import。

顺带一句：`RingBuffer` 两份里 `dock-browser.ts` 那份少了 `resize`（那台链没有「改设置就重设条数」的路径）。
合并时取完整版，行为不变：`browser.ts` 原本就在改设置后调 `resize`。

### 14.3 一处「必须同口径」的读数：`sameGit`

同一个 `GitSurface` 有两个地方要比一比：

- 宿主 `plugins/git.ts`：读数没变就不推帧（干净仓库每 30 秒白推一帧是纯浪费）；
- 输入区 `ui-shell/src/plugins/composer/ui.tsx`：读数没变就不重画底栏。

两处只要有一处判断不同，界面就停在旧分支名上，而且**再也不会自己刷新**——每次催拍都被判成「没变」。
这类 bug 只在切分支那一刻出现一次，之后一直错着，最难归因。收成一份后由实现本身保证，不再靠注释对齐。

状态栏那份 `sameGit` 是**另一种读数**（`GitSummary`：branch / added / removed / files），不在这批的合并范围。

### 14.4 顺带发现、但没改：控制台时间戳是 UTC

`core/cdp/report.ts` 的 `clock` 用 `toISOString().slice(11, 19)`，输出的是 **UTC**；
而 `plugins/sandbox.ts` 的 `clockOf` 用的是**本地时间**。同一个用户在同一次会话里会看到两套时间
（北京时间差 8 小时），而他多半会以为是浏览器那边的时钟不对。

这批没动它：它改的是用户可见输出，可能牵连既有截图与自检基线，属于单独一改。**建议两边统一走本地时间，等拍板。**

### 14.5 验证

```
npx tsc -p tsconfig.json --noEmit                              # 退出码 0
(cd ui-shell && npx tsc -p tsconfig.json --noEmit)             # 退出码 0
(cd desktop && npx tsc --noEmit -p tsconfig.json)              # 退出码 0
(cd desktop && npx tsc --noEmit -p tsconfig.node.json)         # 退出码 0
node scripts/style-check.mjs                                   # 643 个文件 0 问题
```

另外用 `--noUnusedLocals` 扫了一遍：本批引入的问题共六处——`dock-browser.ts` 里重复声明的
`ConsoleEntry` / `NetworkEntry`、五个插件里不再使用的 `HostSnapshot` 类型、`transcript` 的 `SessionSummary`，
都当场清掉（后两类是第七批的副产物）。其余报错与 HEAD 一致，是存量，没有顺手扩大范围。

复扫：函数体重复组 23 → 9。

## 十五、第七批（2026-10-28 同日）：壳里十个插件的「快照读数」

### 15.1 收掉的八组，加一处顺手

| 重复的东西 | 份数 | 收到哪 |
| --- | --- | --- |
| `readCwd`（会话工作目录） | 4 | 新增 `ui-primitives/snapshot.ts` |
| `readSessions`（会话清单） | 3 | 同上 |
| `readSessionPath`（当前 jsonl 路径） | 2 | 同上 |
| `readEntries` / `readLive`（条目流与在流条目） | 各 2 | 同上 |
| `readTurnState`（回合状态） | 2 | 同上 |
| `readSessionId`（`sessionPath` 取短名） | 2 | 同上 |
| `NO_SESSIONS` / `NO_ENTRIES`（冻结空表） | 各 2～3 | 同上 |

顺手一处：`transcript` 里另有一个 `readCwdValue`，同一个字段回的是空串而不是 `null`。
改成 `readCwd(...) ?? ''`——一个字段不再有两种写法。

### 15.2 为什么一行的解构也值得收

这些函数体短得像样板，但它决定的是「字段缺失算什么」：

- 十份里只要一份回空串、另一份回 `null`，界面就会出现**侧栏底部有工作目录、文件树却说没有**这种自相矛盾；
- 空表必须是**模块级冻结常量**：`useHostSelector` 按引用判等，每帧新建数组会被判成「变了」，逐帧重画。

落点是 `ui-primitives`：插件只能从平台种子取东西（`@dsc/ui` / `@dsc/ui-primitives` / `@dsc/ui-slots` / `@dsc/ui-dockkit`），
壳自己的模块不能直接引，这跟第五批吞吐读数走的是同一条链。

### 15.3 一次操作事故与恢复

这批不是一次做对的，如实记下来。

**事故**：用一个脚本按「函数定义 + 上方文档注释」整块删除重复函数，判断注释是否紧邻的写法是
`/\/\*\*[\s\S]*?\*\/\n$/`。这个正则从左往右找**文件开头的第一个** `/**`，再一路吃到签名之前的最后一个
`*/`——于是匹配到的「一块」其实是整份文件。`files/ui.tsx`、`preview/ui.tsx`、`terminal/ui.tsx` 三个文件当场变成 0 字节。

**恢复**：从会话事件日志取回被删内容。日志在 `~/.dsh/sessions/--D-dsc--/<会话 id>/session.v4.jsonl.zstd`，
是分帧压缩的（本次 2161 帧），用 Node 的 `zstdDecompressSync` 逐帧解完拿到 11 MB 事件流，
再从 `tool/ptc-dispatch` 事件里取回那三次 `edit` 的 `old_string`，原样写回。

**核对**：恢复后 `git diff` 与 HEAD 比，三个文件的差异正好等于第五批的预期改动
（新增 `@dsc/ui-primitives` 导入、删掉本地 `formatSize` / `joinPath`），没有任何一笔别的线的工作被吞掉。

**改法**：此后删除函数必须满足两条——注释的 `*/` 与函数签名**紧邻**（`before.slice(close + 2) === '\n'`），
且算出来的待删块超过 2000 字符就抛错不删。

### 15.4 验证与复扫

四道 typecheck 全 0，`node scripts/style-check.mjs` → 648 个文件 0 问题。

函数体重复组：40（审查起点）→ 23（第五批后）→ 9（第六批后）→ **1**。

### 15.5 剩下那一组为什么不收

`emit`：`for (const listener of listeners) listener()`，两份。抽成 `notifyAll(listeners)` 只是把一行换成一行调用，
没有多出任何保证。真正的重复在 `subscribe`（5 份，各有自己的闭包与初始值），那要抽 store 工厂，
会动 `ui-layout` 的对外契约——是重构，不是收口。

### 15.6 这批的边界：工作区是共享的

验证是在共享工作区上跑的。同一时段另一条线在改「提问卡可收起」（`ui-shell/src/plugins/prompt/ui.tsx`、
`ui-shell/src/legacy/views.css`、`README.md`、`scripts/tmp-*.mjs`）。那些文件本批一行未动，
四道门禁把它们一起带过了，但**不能算作本批的验证结论**。

## 十六、第八批（2026-10-28 同日）：时间戳的时区，与界面壳的模块级信号

这批不是「再找一组重复」，是 §14.4 那条待拍板的事，加上一次有意的试点。

### 16.1 时间戳：两处各自"正确"，合起来是错的

浏览器工具的控制台与网络输出，每行前面是 `[10:15:33]`；沙箱 `/sandbox` 的拒载日志也是同一形状。
两处写法都挑不出错，但**时区不一样**：

| 出处 | 写法 | 输出 |
| --- | --- | --- |
| `core/cdp/report.ts`（原） | `new Date(ts).toISOString().slice(11, 19)` | UTC |
| `plugins/sandbox.ts`（原） | `getHours/getMinutes/getSeconds` + 补零 | 本地时间 |

北京时间的用户 10:15 操作浏览器，控制台显示 `[02:15:33]`；同一屏的沙箱日志显示 `[10:15:33]`。
他不会想到是时区——会以为浏览器那边的时钟坏了。

改动：新增 `core/clock.ts` 的 `clockText(ts)`，**本地时间**；`cdp/report.ts` 的 `clock` 删除，
`plugins/sandbox.ts` 的 `clockOf` 删除，两处都改用它。

为什么不选 UTC：日志是给人看的，人按自己墙上的钟读它。真正该用 UTC 的是「按天统计用量」
（`plugins/commands.ts:588` 取日期那处），那本来就是另一件事，没动。

### 16.2 模块级信号：七处手抄的不是十行代码，是三条语义

界面里有七处模块级共享状态，各自手写「`Set<() => void>` + `subscribe` + 一个 for 循环」：
`ask/store`、`files/tree-store`、`team/ui`、`ui-dockkit/dock-state`、`ui-layout/page-state`、
`ui-layout/thread-view`、`ui-renderer/boot`。

抄过去的是三条**抄漏了不报错、只表现成"界面不刷新"或"卡"** 的语义：

1. **引用稳定**：没变时 `get()` 返回同一个值。`useSyncExternalStore` 靠它判断要不要重画，克隆一次就是逐帧重画；
2. **通知前复制订阅者**：回调里退订（组件卸载时就会发生）不能打断这一轮遍历，否则后面的订阅者这一轮收不到通知；
3. **写入判等**：值没变就不通知。

新增 `src/ui/signal.ts` 的 `createSignal`，把这三条钉死。它**不与 `defineStore` 合并**：
后者是按登记实例化的席位（必须在 `apply(ui)` 里现建、随登记卸载消失、带 actions 与浅拷贝 draft），
前者是模块级单例（没有登记、没有生命周期）。两者共有的只有「订阅 + 没变不通知」。

落点与插件规范：实现在 `@dsc/ui-core`；`ui-layout` 可以直接引 `@dsc/ui-core`（它禁的是聚合面 `@dsc/ui`，
见 `scripts/ui-plugin-test.mjs` 的 [5b] 禁止边表）；插件经新增的 `ui-primitives/signal.ts` 转出取。

### 16.3 试点选 `thread-view`，以及一个意外

原计划是「挑最小的那个先试」。`thread-view` 看着是单字段（`view`），真去改才发现它有**两个字段**
（`view` + `focusStep`），而且 `openTrace(stepId)` 要求**一次通知同时生效**——分两次写会让轨迹页
先按「没聚焦」渲染一帧再重排，滚动位置闪一下（这条理由原代码里就写着）。

这正好是我当初列的「七处里只要有一处塞不进工厂，工厂就得加参数」的那个风险点。解法不是给工厂加"批量写"参数，
而是**状态本身写成一个对象**：

```
const state = createSignal<ThreadViewState>({ view: 'chat', focusStep: null })
```

一次 `state.set({ view: 'trace', focusStep: 7 })` = 一次通知、没有中间态。工厂保持三行语义，不用加参数。

### 16.4 验证

四道 typecheck 全 0；`node scripts/style-check.mjs` → 647 个文件 0 问题。

`createSignal` 另跑了一份独立单测（`tsc` 单独编译后 `node` 跑，8 条断言全过）：

- 同值不通知（含 `NaN → NaN`）；变了通知一次；`get()` 返回同一引用；
- 退订后不再收到；**回调里退订不打断本轮遍历**（a 里退订 b，b 本轮仍收到）；
- 一个对象一次 `set` 只通知一次（多字段原子写）。

### 16.5 剩下六处：第九批补上了（见 §十七）

原计划等 `thread-view` 手点验证后再推广。实际下一批直接推广了八处，另有两处**明确不收**（实例作用域 + 每路事件回调签名不同）。
理由与清单见 §十七。

## 十七、第九批（2026-10-28 同日）：模块级状态全部收口，加两处例外

第八批只试点了一处（`thread-view`）。这批把剩下的收完，并把**判据**写下来。

### 17.1 收掉的八处

| 文件 | 状态形状 | 用法 |
| --- | --- | --- |
| `ui-layout/page-state.ts` | `string \| null`（当前整页） | `set` |
| `plugins/team/ui.tsx` | `{ open, peek }` | `set` |
| `plugins/settings/ui.tsx` | `boolean`（面板开合） | `set` |
| `plugins/actions/ui.tsx` | `readonly UiAction[]`（摊平后的动作表） | `set` |
| `ui-dockkit/dock-state.ts` | 四份状态共用一条通道（布局 / 页签注册表 / 审查目标 / 补丁源） | `notify` |
| `plugins/files/tree-store.ts` | 按 cwd 分键的 `Map` | `notify` |
| `plugins/ask/store.ts` | 按会话分桶的 `Map` + 两个挂起计数 | `notify` |
| `ui-renderer/boot.ts` | 挂在 `globalThis` 上的账本 | `notify` |

加上第八批的 `thread-view`，一共九处，写法现在是同一份 `createSignal`。

### 17.2 判据：值由谁拥有

统一不是「看到 `Set<() => void>` 就换掉」，判据只有一条——**这份值归不归信号**：

- **归信号**（`set`）：切页、面板开合、动作表、正文区那张脸。多字段写成一个对象、一次 `set` 发出，
  避免订阅方先渲染半套新值。
- **值在别处**（`notify`）：按 key 分的 `Map`（文件树、旁问）或挂在 `globalThis` 上的账本（启动账本）。
  硬把 Map 塞进信号，每来一次流式增量都得整张复制一遍，换来的是零语义收益。
  `dock-state` 是第三种：一个文件里四份状态共用一条通道，值本身没法打包进一个对象。

两种用法都写在 `src/ui/signal.ts` 的模块注释里，选哪种照着判据办，不用临场发明。

`boot` 那份的 `try/catch` 保住了，但换了位置：原来包在**整轮遍历**里（一个订阅者抛了，后面的人这一轮收不到通知），
现在包在**每个订阅者**外面（只影响他自己）。这是行为改进，不是等价改写，单独记一笔。

### 17.3 明确不收的两处

`ui-layout/host-channel.ts`（`createHostChannel`）与 `ui-renderer/hmr.ts`（`startPluginHmr`）留着原样，理由有两条：

1. **实例作用域**：它们是工厂里现建的对象，不是模块级单例。再给实例开一套「实例级信号」，
   等于给 `defineStore` 再造一个近亲；
2. **多路事件**：`host-channel` 有三组监听器（状态、插件帧、旁问增量），每种回调签名不同，
   一份 `createSignal` 表达不了。

写进这里，是为了下次有人扫到这两处时不必重新论证一遍。

### 17.4 复扫

函数体重复组：**400 个文件里 0 组**（审查起点 40 组）。

### 17.5 验证

四道 typecheck 全 0；`node scripts/style-check.mjs` → 647 个文件 0 问题；`createSignal` 的 8 条断言仍全过
（第八批建立的那份单测，这批只给工厂加了 `notify`，没改原有语义）。

**仍待手点**：顶栏页签切换、工具行「在轨迹中查看」、聚焦滚动、侧栏展开收起、设置面板齿轮开合、
文件树展开与滚动位恢复、旁问流式答案、启动诊断页。这些是「订阅语义错」的典型表现面（不刷新 / 重订阅），
自动化跑不出来，得在真实界面上过一遍。


## 十八、第十批（2026-10-28）：扫描器收成工具，四组重复，以及我自己埋的一处回归

### 18.1 扫描器：从「每用一次手敲一遍」到 `scripts/dup-scan.mjs`

前十批收重复用的是一段临时脚本，每用一次重敲一遍，**扫描目录写死成 `src` 与 `ui-shell/src`**。
§12.6 记过这个盲区：`remote-web` 与旧渲染层从来没被扫过，而「扫不出」被当成了「没有」。

现在它是仓库里的正经工具：

| 能力 | 怎么用 |
| --- | --- |
| 换范围 | `node scripts/dup-scan.mjs remote-web/src`（不给就扫默认两处） |
| 放宽长度 | `node scripts/dup-scan.mjs --max-lines 20 src`（默认 10 行） |
| 给门禁用 | `--strict`：有重复就退出码 1 |

**第一版报了 42 组，全是噪声。** 原因是我把「花括号块」都当成了函数体，于是 JSX 片段、
对象字面量、模板里的块全进来。加上一条判据——**花括号前面（跳过空白）必须是 `)` 或 `=>`**——
之后 401 个文件里只剩 4 组，就是下面这四组。这条教训值得记：报出 42 组和报出 4 组，
工具的成本是一样的，区别全在「什么算一个候选」写清楚没有。

### 18.2 收掉的四组

| 组 | 份数 | 落到哪 | 说明 |
| --- | --- | --- | --- |
| `oneLine`（压成一行 + 截断） | 4 | `src/core/strings.ts` | 审批卡、正文、工具卡、任务条各一份，逐字相同。收口后 `limit` 变成可选：不传就只压平不截断 |
| `compactTokens`（1234 → `1.2k`） | 3 | `src/core/text-format.ts`（新建） | 两处 `const fmtTokens` 加 `plugins/commands.ts` 里一份内联的箭头函数 |
| `shortCwd`（路径缩成末两级） | 2 | 同上 | 状态栏与欢迎页 |
| `absPath` / `stringArg`（工具入参收口） | 2 | `src/core/tools/path-args.ts`（新建） | `fs-tools` 与 `image-tool` 各抄一份，连报错文案都一样 |

**刻意没并的两个近亲**：`ui-shell/src/plugins/sessions/ui.tsx` 也有个 `oneLine`，但它按
**码点**截断（`Array.from` 之后切），emoji 不会被劈成半个；上面那份按码元切。两者行为不同，
并了就是在 emoji 上悄悄改行为。`settings/usage.tsx` 的 `fmtTokens` 是另一回事——它出的是
「万 / 亿」，中文大数口径，和 `1.2k` 是两套给人看的刻度。

### 18.3 一处我自己埋的回归：`rounds.ts` 的运行期 import

`d58dcbe`（第八批那次的第三笔提交）把 `ui-shell/src/plugins/transcript/rounds.ts` 里就地内联的
`tsOf` 换成了 `import { entryTs as tsOf } from '@dsc/ui-primitives'`。

可这个文件头白纸黑字写着「零依赖 / **只许 `import type`**」——因为
`scripts/ui-transcript-render-test.mjs` 是**按 Node 的类型擦除直接 import 这个 `.ts`** 的
（同 `paging.ts` 的口径）。而 `@dsc/ui-primitives` 只是构建期别名（`ui-shell/packages.json`，
由 vite 与 `build-plugins.mjs` 认），Node 解析不了。于是那条探针当场
`ERR_MODULE_NOT_FOUND`。

**为什么当时没发现**：那一次的验收跑的是 `tsc`，`tsc` 认别名，Node 不认。tsc 绿不等于没错。

修法：恢复就地内联（`entry.ts` 有限正数才认），删掉运行期 import；顺带核了另外三个同样声明
「不许运行期 import」的文件——`notice-summary.ts`、`status-model.ts`、`review-notice.ts`——
都没被污染。

### 18.4 验证

- 根 `tsc --noEmit` 退出码 0；
- `node scripts/dup-scan.mjs` → 403 个文件，**0 组**；
- 四条相关探针 PASS：`readme-test`、`sandbox-parity-test`、`turn-changes-test`、
  `ui-transcript-render-test`（修完 `rounds.ts` 之后）；
- `pnpm build` 与 `check:core` **这一轮没跑成**：工作区里另一条正在改 `src/plugins/approval.ts`，
  `ReviewVerdict` 新加了必填的 `failed`，那两处构造还没补，构建红
  （`src/plugins/approval.ts:502`、`:507`）。全量自检要等他们提交完。

### 18.5 两条方法上的教训

1. **文件头写着「零依赖 / 只许 `import type`」的，是给 Node 直读的**。合并重复前先看一眼
   文件头，别把 import 塞进去——那里省下的十行，会在探针里变成一条难查的模块解析错误。
2. **`tsc` 全绿只证明类型对得上**，证明不了模块能被 Node 解析。凡是被 Node 直读的 `.ts`，
   都得跑那条探针本身。

## 十九、「明确不收」的清单，汇到一处

这些判断此前散在 §10.4、§11.4、§12.5、§13.4、§15.5、§17.3 六个地方，找起来要翻半天。
下次有人扫到同样的重复，先看这张表，不必重新论证一遍。

| 组 | 份数 | 为什么不做 | 原判断 |
| --- | --- | --- | --- |
| `subscribe`（各自的监听器集合） | 5 | 要抽 store 工厂，动 `ui-layout` 的对外契约。那是重构，不是收口 | §12.5 §13.4 §15.5 |
| `emit` | 2 | 抽成 `notifyAll(listeners)` 只是把一行换成一行调用，不多出任何保证 | §15.5 |
| `formatDuration` | 3 | 语义不同：一份收**秒**并出「天」（定时任务），一份收**毫秒**但有小时就省掉秒（状态栏），一份收毫秒且时分秒全出（对话页）。冻结层还有第四份 | §10.4 |
| `clampRounds` / `clampEffort` / `clampToScreen` / `computer-use` 的 `clamp` | 4 | 边界与兜底值不同；`computer-use` 那份不带兜底值是故意的 | §11.4 |
| `createHostChannel` / `startPluginHmr` | 2 | 实例作用域（不是模块单例），且 `host-channel` 有三组不同签名的回调 | §17.3 |
| `oneLine`（`sessions/ui.tsx` 那份） | 1 | 按码点截断，emoji 不劈半；与码元版行为不同 | §18.2 |
| `fmtTokens`（`settings/usage.tsx` 那份） | 1 | 出的是「万 / 亿」中文大数，与 `1.2k` 是两套刻度 | §18.2 |
| 旧渲染层 `desktop/src/renderer` | 21,035 行 | 已冻结，等日落日期整体删除；逐个合并没有意义 | §十 |

## 二十、`defineStore` 与 `createSignal` 怎么选

第九批之后壳里有两套状态写法，都能订阅、都能「没变不通知」。此前答案只写在
`src/ui/signal.ts` 的注释里，新建状态的人得先读代码。这里给一张判据表。

| 判据 | `defineStore`（`src/ui/store.ts`） | `createSignal`（`src/ui/signal.ts`） |
| --- | --- | --- |
| 谁创建它 | 插件在 `apply(ui)` 里现建，随登记卸载消失 | 模块顶层单例，谁引都是同一份 |
| 有没有生命周期 | 有（登记时建、卸载时没） | 没有 |
| 有没有 actions 表 | 有，还能拿浅拷贝 draft 改完一次提交 | 没有，只有 `get` / `set` / `notify` / `subscribe` |
| 值归谁 | 归 store | `set` 归信号；`notify` 只借它当变更通道（值在 Map 或 `globalThis` 上） |
| 典型用场 | 插件自己的界面状态 | 跨插件共享的那几处：切页、dock 布局、正文区那张脸、文件树、旁问、团队面板、启动账本 |

三句话的用法：

1. **问「谁建它」**：插件装上去才存在 → `defineStore`；模块一加载就该有 → `createSignal`。
2. **问「值归不归它」**：值在信号里 → `set`；值在别处（Map、`globalThis` 的账本）→ `notify`。
   硬把 Map 塞进信号，每次流式增量都要整张复制一遍，换不来任何语义收益。
3. **多字段写成一个对象、一次 `set`**。分两次写，订阅方会先渲染半套新值——
   `thread-view` 的「切到轨迹并聚焦某一步」就踩过：滚动位置会闪一下。

## 二十一、第十一批（2026-10-28）：契约按域拆成十份，ui-shell 版本对齐产品号

### 21.1 契约为什么值得拆，怎么拆的

`src/contract.ts` 原本 2,093 行、135 个文件引用它。改「设置」里的一个字段，要在两千行里
找位置；四个人同时改就是四次冲突。这是 P1-3 里风险最小的一块（纯类型，没逻辑），
也是唯一不会改变任何运行行为的一块。

拆法：按声明归域，**逐字搬移**，不重排、不重命名、不改注释。十个域：

| 文件 | 行数 | 装什么 |
| --- | --- | --- |
| `contract/mode.ts` | 80 | 思考档位、权限模式、审阅者、沙箱模式、协作模式 |
| `contract/task.ts` | 207 | 待办、计划、后台作业、定时任务、目标、提问卡 |
| `contract/transcript.ts` | 289 | 工具卡、转录条目、压缩标记、子代理卡、差异 |
| `contract/usage.ts` | 140 | token 用量、按日 / 按模型的用量统计、旁问 |
| `contract/runtime.ts` | 259 | 状态行、预设面、git 读数、运行时快照面 |
| `contract/approval.ts` | 86 | 审批卡（差异、升权、请求、应答） |
| `contract/session.ts` | 210 | 会话、归档、主题与偏好（含 `normalizeStatusBarPrefs`） |
| `contract/plugin.ts` | 242 | 插件行、UI 信任、队友、模型选择、`/` 命令、技能、市场 |
| `contract/settings.ts` | 233 | 设置项、配对 / 链接分享、供应商、连接测试 |
| `contract/snapshot.ts` | 438 | 运行时快照、`DscRuntime`（275 行）、电脑操作 |

`src/contract.ts` 只剩 26 行：文件头（边界规则）+ 十行 `export *`。所以
「`src/adapter/**` 是唯一允许 import `@deepseek-ai/*` 的层」「UI 层只依赖中立类型」这两条
边界规则仍然写在入口上，不会被拆散。

**跨域引用怎么处理**：搬完之后编译，把 `Cannot find name` 一条条按「这个名字在哪个域声明」
补 `import type`，循环引用交给类型擦除（全是 `import type`，运行期没有边）。十份文件里
最多的那份（`snapshot`）导入了另外 7 个域的类型。

**文档里的行号引用也跟着搬**：`docs/` 里 10 处 `src/contract.ts:NNN` 已改指到新文件的
声明行（历史记录 `development-log.md` 不动，那是当时的事实）。

### 21.2 一处必须说清的操作：别人手上的未提交改动

拆分时工作区里 `src/contract.ts` 还压着另一条线的未提交改动——`ApprovalRequestView` 加
`meaning?: string`（审批卡上那句「这次调用要干什么」）。处理顺序是：

1. 用 **HEAD 的版本**做拆分并提交，所以这次提交是纯搬移，不含任何人的半成品；
2. 把那 12 行改动按原样落回 `src/contract/approval.ts`，**保持未提交**——它仍然是那条线的
   在途改动，等着他们自己提交。

换句话说：他们的改动没有丢，也没有被算进这次提交，只是换了个文件路径。

### 21.3 ui-shell 的版本对齐产品号（B 案）

按拍板把 `ui-shell/package.json` 从 2.0.0 降到 0.7.1，与根、`desktop` 同版；
`release.yml` 的 verify 作业改成 tag / 根 / `desktop` / `ui-shell` 四方对账。

连带要改的四处（不一起改就构建失败）：

- 19 个内置插件的 `"@dsc/ui"` 区间：`^2.0.0` → `^0.7.1`；
- 五个逻辑包的包身份（`ui-shell/src/ui-{primitives,slots,dockkit,layout,renderer}/package.json`）；
- `src/ui/package.json`（`@dsc/ui-core` 的身份，门禁断言它与壳版本同源）；
- 示例插件 `examples/plugin-two-halves`。

**代价写进文档了**：`^0.7.1` 只认到 0.8.0 以下，所以每次改版本号都要把 19 个区间一起改。
漏改不静默——`build-plugins` 会点名哪个插件失配，`release.yml` 在打包前先跑一次它。
探针侧也顺手改成读壳版本（`ui-package-plugin-test.mjs` 的夹具），免得每逢发版红一次。

### 21.4 验证

- 根 / `ui-shell` / `desktop` 三处 `tsc` 全 0（`desktop` 那两套 tsconfig 都跑）；
- `pnpm build` 产出 `lib/contract/*.js` + `lib/contract.js`，`@dsc/runtime/contract.js` 仍能解析；
- `build-plugins` 19 个插件全部通过 0.7.1 的 peer 门禁；
- `ui-api-gate-test` / `ui-plugin-test` / `ui-package-plugin-test` / `ui-batches-test` 全 PASS；
- `dup-scan` 0 组；`style-check` 全过；`check:core` 全量在后台跑（结果见下轮）。

### 21.5 顺带做掉的一步：界面产物缺失时给提示页，不再白屏

删旧渲染层的前置里有一条是「壳产物缺失时怎么办」。原先 `desktop/electron/main/index.ts`
在既没有 dev server、也没有宿主界面地址时会 `loadFile(out/renderer/index.html)`；那份文件一旦
随目录删掉，Electron 给的是一张纯白窗口——用户看不出是构建没跑还是装坏了。

现在补了一道闸：文件在就照旧加载（删目录之前这段仍然有效），不在就加载一张内联提示页
（data URL，不依赖构建产物），写清「界面还没构建出来」、跑哪两条命令、日志在 `~/.dsc/logs`。

**还没做的**：`electron.vite.config.ts` 的 `renderer` 段与 `desktop/src/renderer` 目录本身。
那两处要等另一条线把 `ApprovalCard.tsx`、`styles.css` 的改动提交掉——现在删等于把他们的活蒸发。

## 二十二、第十二批（2026-10-28）：四个 pnpm 项目收成一个 workspace

### 22.1 收之前是什么样

根 / `ui-shell` / `desktop` / `remote-web` 各有一份 `package.json` 与一份 `pnpm-lock.yaml`，
装依赖要装四遍，`react`、`shiki`、`xterm`、`pdfjs-dist`、`xlsx` 在三个项目里各存一份物理副本。
版本靠人肉对齐——`ui-shell` 漂到 2.0.0、另外三个在 0.7.1，整整差一个大版本，没人发现。

### 22.2 怎么收的

1. 根加 `pnpm-workspace.yaml`，成员只有三个子目录。**四个项目之间没有互相依赖**
   （它们靠 `lib/` 的构建产物与 `ui-shell/packages.json` 的别名衔接），所以不写 `workspace:*`；
2. 删掉三份子锁，`pnpm install` 重新生成根锁；
3. CI 两处跟着改：`verify.yml` 的界面壳 / 桌面端两个作业不再 `working-directory` 安装，
   `release.yml` 删掉 `pnpm -C ui-shell install`、`pnpm -C remote-web install`、desktop 作业里
   那次多余安装。

### 22.3 收的过程撞到的两件事

**① react 与 react-dom 版本分叉。** 分开装时各自解各自的，收成一个 workspace 之后 pnpm 统一解，
结果是 `react 19.3.0` + `react-dom 19.3.1`——后者的 peer 要 `^19.3.1`，装完就在警告里躺着。
两个 React 版本不一致不会装不上，会在运行期以 hooks 报错的形式出现。
根 `pnpm.overrides` 把两个都钉到 `19.3.1`，一处管住四个项目。

**② electron 的二进制不会自己下来。** 旧的 `desktop/node_modules/electron/dist` 是上次单独安装时
留下的；workspace 重装之后那份 node_modules 被重建，二进制没了，`electron-builder` 直接报
「The specified electronDist does not exist」。

两处修：根 `pnpm.onlyBuiltDependencies` 加 `electron`（新检出执行 `pnpm install` 就会下；
CI 的桌面作业用 `--ignore-scripts`，仍然由 `release.yml` 里那句 `node node_modules/electron/install.js`
显式补一次，两不冲突）；本机这次先用 `node node_modules/electron/install.js` 补上。

### 22.4 验证

- 四个项目 `tsc --noEmit` 全 0（根 / 界面壳 / 桌面端两套 tsconfig / 遥控 Web 两套）；
- 四处构建全绿：`pnpm build`、`pnpm -C ui-shell build`、`pnpm -C remote-web build`、
  `pnpm -C desktop exec electron-vite build`（main / preload / renderer 三段都出产物）；
- `pnpm run check:ui` 39/39 通过（装完依赖后重跑，确认 node_modules 结构变化没影响探针）；
- 打包（`dist:dir`）见 22.5。

### 22.5 打包这一关：验证到什么程度

第一次 `dist:dir` 失败，原因是 22.3 ② 的 electron 二进制缺失，与 workspace 本身无关。
补装这一步**本机没成功**：`node node_modules/electron/install.js` 跑了十几分钟没有任何输出，
缓存目录也是空的——这台机器下不到 electron 二进制（仓库注释里本来就写着直连 GitHub 不稳，
`ECONNRESET` 与 600 秒超时都撞过）。所以：

- **已验的**：四处构建全绿，`electron-vite build` 的 main / preload / renderer 三段都出产物；
- **没验的**：`electron-builder` 打包与 asar 内容。CI 的 `release.yml` 有那条显式补装，
  路径没被我动过，但这次没有在本机跑通它。发版前必须在能下 electron 的机器上打一次包。

**这条经验值得记住**：workspace 收口真正会咬人的地方不是 `tsc`，是打包链路——
`electron-builder.yml` 里 `electronDist: node_modules/electron/dist` 这种**写死路径**，
在依赖布局变化时不会给出好看的错误，只会说一句「路径不存在」。

## 二十三、第十三批（2026-10-28）：旧渲染层整体删除（21,035 行）

### 23.1 三条前置，前两条早就满足了

`desktop/src/renderer/bridge.ts` 里写着物理退役的三条前置：① 内置浏览器进桥或砍掉；
② `installPlugin` / `installSkill` 有去处；③ 旧渲染层整体退出安装包。核了一遍：

- ① ✅ `src/core/native-bridge.ts:415-429` 有 `dockBrowser` / `browserNav` / `browserClose`；
- ② ✅ 同文件 `:357-363` 有 `installSkill` / `installPlugin` / `installMarketSkill`，壳里也有对应界面；
- ③ 就是这次做的事。

那段注释写于 2026-10-11，之后两条先后满足，但没人回头改它——**过期的前置条件会让后面的人
以为还差东西**，这次一并写进文档。

### 23.2 删了什么，留下什么

| 动的地方 | 怎么处理 |
| --- | --- |
| `desktop/src/renderer/`（90 个文件 21,035 行） | 整体删除 |
| `desktop/electron.vite.config.ts` | 去掉 `renderer` 段与 `@vitejs/plugin-react`，只剩 main / preload |
| `desktop/tsconfig.web.json` | 删除（只剩 `src/renderer/**` 一个 include，没有输入了） |
| `desktop/package.json` 的 `typecheck` | 只跑 `tsconfig.node.json` |
| `desktop/electron/main/index.ts` | 删 `rendererDir()`；`uiProfile()` 恒返回 `'shell'`（老配置打一条说明）；`uiAssetsDir()` 只给壳产物；加载分支只剩「宿主地址」与「提示页」两种 |
| `scripts/legacy-frozen-check.mjs` | 删除（它的唯一职责是查旧渲染层与壳的样式分叉） |
| 6 条探针的「旧渲染层同口径」断言 | 删除断言与对应的文件读取，保留壳侧的断言 |
| `ui-shell/src/legacy/*`（四份样式副本） | **保留**：壳还在用它们，与旧渲染层不是一回事 |

一一对应地看，这一批没有改任何界面行为：删掉的是「第二份实现」和「跟它对齐的断言」。

### 23.3 两个诚实说明

**① 那批旧 IPC 通道没删。** `desktop/electron/main/index.ts` 里 `dsc:choose-directory` 这类
handler 现在没有消费方（壳走原生桥），但它们的实现体与原生桥共用同一批具名函数，删掉只是
少一层包装、不减少任何能力。留着的代价是「读代码的人要多问一句这是谁在用」，已在原地
写了注释说明。真要删，等下一次清理 `electron/preload/index.ts` 时一起。

**② 删除前一刻，旧渲染层还有人在改。** 另一条线把「审批卡瘦身」镜像进了旧渲染层
（`ApprovalCard.tsx` / `styles.css`），这些改动先提交、随后随目录删除。听起来是白做，
但顺序是对的：**先让两条界面口径一致再删，删除提交的语义才干净**；反过来就是「一半新一半旧」。

### 23.4 验证

- `pnpm --dir desktop typecheck` → 0（现在只剩 `tsconfig.node.json` 一套）；
- `pnpm typecheck`（根）→ 0；
- `pnpm run check:ui` **39/39** 通过（含 6 条改过的探针）；
- `node scripts/dup-scan.mjs` 0 组、`style-check` 全过；
- `check:core` 全量在后台跑（结果见下轮）。

## 二十四、第十四批（2026-10-28）：拆对话流（2,553 → 658 行）

### 拆法

一个文件里原本住着四种东西，各自的生命周期完全不同，硬塞在一处：

| 新文件 | 行数 | 装的是什么 |
| --- | --- | --- |
| `shared.ts` | 175 | 三条 context（折叠偏好 / 流内动作 / 会话工作目录）、toolview 子槽的名字与渲染形状、`Row` / `Seat`、行 key 与座位切分 |
| `follow.ts` | 213 | 贴底跟随（松手 / 只认自己的写 / 贴底门槛三条规矩） |
| `welcome.tsx` | 161 | 空会话首屏：四张能力卡、接着上次、开场区该露的那几行 |
| `render.tsx` | 317 | 座位骨架：一轮（`SeatBody`）→ 一行（`RowBody`）→ 行级错误边界（`RowBoundary`） |
| `rows/user-row.tsx` | 216 | 用户消息那一行 + 附件条 + 只读出口的同一气泡 |
| `rows/think-row.tsx` | 196 | 思考栏与两条「首行摘要」算法 |
| `rows/tool-row.tsx` | 283 | 工具卡 + 子智能体卡 |
| `rows/changes-card.tsx` | 274 | 一轮的「文件已更改」卡与悬停 diff |
| `rows/foot.tsx` | 168 | 轮尾（用时 / 用量 / 复制 / 评价 / 分叉）与进行中状态行 |
| `rows/fold-body.ts` | 29 | 思考栏与工具卡共用的「内容够不够长」量法 |
| `subagent-flow.tsx` | 84 | 只读「子智能体条目流」 |

`ui.tsx` 只剩三样：插件装配（`apply`）、`TranscriptFlow` 主流程（取数、分页、折叠接线、
动作）、以及三个取值小函数。

### 为什么按这条缝切

行渲染器们只依赖 context 与平台种子，**彼此之间不互相调用**——除了 `SeatBody` 要
`ChangesCard` + `RoundFoot`、`RowBody` 要五种行。这条依赖是单向的（骨架 → 行），所以
把行搬到 `rows/` 不会形成环。反过来按「上半屏 / 下半屏」切就会切断一个座位的渲染。

### 行为零变化

只搬不移：所有函数的实现体逐字未改，`TranscriptFlow` 的空会话分支改成渲染
`<WelcomeState …/>`，那一段 JSX 也是原样搬的。对外导出（`FoldPrefs`、`ToolEntry`、
`TOOLVIEW_SLOT`、`SUBAGENT_FLOW_SLOT`、`TranscriptFlowProps`、`TranscriptFlowService`）
在 `ui.tsx` 里继续 re-export，插件外面不用改一行。

同时顺手清掉两处错位的注释：`ComposerDraftService` 头上原本挂着「首屏四张能力卡」的
说明（那是 `WELCOME_CARDS` 的注释，贴错了对象），已跟着卡片搬到 `welcome.tsx`；
`elapsedLabel` 头上原有一句「会话清单」（`readSessions` 早就搬去平台种子了），删除。

### 探针跟着改

12 条探针按文本读 `ui.tsx`。现在它们改读整棵插件子树（`_check-runner.mjs` 新增
`readPluginSource`），断言原意不变——「这段代码在插件里」本来就不该钉在某个文件名上。
三处要单独说明，都不是「改绿了事」：

1. `ui-transcript-render-test` 的「排布走纯函数 `seatPlan`」原本还要求 `ui.tsx` 里出现
   某条 import。import 随代码搬到了 `render.tsx`，改成对 `render.tsx` 判：那里有
   `for (const item of seatPlan(`、且不出现 `kind === 'user'`（切座位的判据只在 `rounds.ts`）。
2. 同一条里「不再另算一份 `roundInfos`」原本对整个插件判，但 `timing.ts` 本来就导出
   `roundInfos`，整面扫必然失败。改成按 `buildSeats` 函数体判。
3. `ui-model-picker-test` 的「旧口径不许回来」原本对整个 `composer/` 目录判，可是
   `model-picker.ts` 里本来就该有 `=== model` 这些比较（它正是那份纯逻辑）。这条改回只扫
   视图 `composer/ui.tsx`——这条断言从一开始说的就是「视图里别再自己判」。

### 验证

| 门 | 结果 |
| --- | --- |
| `pnpm -C ui-shell typecheck` | 0 |
| `pnpm run check:ui` | 39/39 |
| `node scripts/style-check.mjs --changed` | 25 个文件全过（顺手把两处混用行尾归到 CRLF） |
| `node scripts/dup-scan.mjs` | 425 个文件、0 组 |
| `pnpm -C ui-shell build` | 见下一条（同批跑） |

## 二十五、第十五批（2026-10-28）：拆输入区，2,354 → 1,650 行（第一批）

### 这一批搬走的

| 新文件 | 行数 | 装的是什么 |
| --- | --- | --- |
| `surfaces.ts` | 235 | 七片宿主快照面（模型 / 端点 / 档位 / 待批 / 会话路径与草稿归属 / 权限预设 / 模式预设 / git），每片「取值 + 相等判断」一对 |
| `queue-dock.tsx` | 247 | 排队消息条：折叠语义、改 / 撤 / 插话、摘要压行 |
| `notice-strip.tsx` | 39 | 待投递通知条（机器唤醒，只读） |
| `branch-menu.tsx` | 261 | 分支钮与「搜 / 切 / 新建」菜单，含两个写口 |

`ComposerBox` 从 1,712 行降到约 1,310 行。

### 只搬不改，除了一处必须改的：开关归谁

分支菜单原来和另外三张浮层共处一个组件，靠「开这一张时把别的三个 `setXxxOpen(false)`」
维持互斥。搬出去之后，如果它自己藏一个 `branchOpen`，父组件就关不掉它——四张浮层会同时开着。

所以它的开关做成受控：父组件持有 `branchOpen`，菜单收 `open` / `onOpenChange`，
「开这张就把别的收掉」写在父组件那个回调里。菜单自己的清单、搜索词、新建输入框仍留在
组件内——那些状态只有它用，别人不该知道。

### 探针跟着改：三条，都要看清原意

`ui-git-branch-test` 里有三条按「一个文件里的先后顺序」判的断言，跨文件之后 index 比较
没有意义了：

1. 「分支行与输入框是兄弟」原本比 `composer-git` 与 `composer` 的 `indexOf`。现在分支行
   在另一个文件里。改成两段判：`ui.tsx` 里 `composer-stack` → `<BranchMenu` →
   `.composer` → `.composer-bar` 的顺序，加 `branch-menu.tsx` 自己画出 `.composer-git`。
2. 「故障便条在框外那层」原本用整个插件的 `indexOf('shell-composer-fault')`。可排队条里
   也有一处同名的 fault 行，而排队条的文件排在 `ui.tsx` 前面，`indexOf` 会取到那一处。
   改成只在 `ui.tsx` 里比位置。
3. 两条正则里的 `setFault` / `setBranchOpen` 换成了搬迁后的 `onFault` / `onOpenChange`。
   断言说的是「先收菜单再等审批」「失败写进 fault 行」，换了名字仍然成立。

### 为什么这一批到这里停

剩下的 1,310 行里最大一块是「模型 chip + 思考档位 chip + 两级浮层」（约 500 行）：
读数、乐观值、飞出卡的量高与挑边、面板横移、端点前缀收放都写在里面。它们和输入行本身
互相咬着三处——`barRef`（量栏宽）、`imageInputAllowed`（附件能不能收）、`fault`（错误行），
硬拆要么把这三样也搬走（输入框就得跟着改），要么往组件里塞一堆反向回调。这批先不动它，
单独立一批做，改完要跑满 `ui-model-picker-test` 那 90 多条（含 11 条负向自证）。

### 验证

| 门 | 结果 |
| --- | --- |
| `pnpm -C ui-shell typecheck` | 0 |
| `pnpm run check:ui` | 39/39 |
| `pnpm -C ui-shell build` | 19 份插件产物照常出，`bundle.json` 只重写有变化的那几份 |
| `node scripts/style-check.mjs --changed` | 全过 |
| `node scripts/dup-scan.mjs` | 429 个文件、0 组 |

## 二十六、第十六批（2026-10-28）：拆模型面板，1,640 → 1,023 行

### 这一批搬走的

| 新文件 | 行数 | 装的是什么 |
| --- | --- | --- |
| `model-controls.tsx` | 687 | 模型 chip 与两级浮层、档位 chip 与滑杆卡、乐观值、飞出卡的量高与挑边、面板横移、端点前缀收放 |

搬完 `composer/ui.tsx` 1,023 行，其中 `ComposerBox` 约 900 行——输入区的巨石化到此结束。

### 关键决定：做成 hook，不做成组件

上一批的分支菜单做成了组件（受控），因为它的状态只服务自己。这一块不能照抄：它和输入行咬着
三处——底栏的 `barRef`（量栏宽决定端点前缀收不收）、附件的能力门（当前模型吃不吃图片）、
错误行 `fault`。

做成组件的话，要么把 `barRef` 与能力门往下传、把「失败」往上回调，要么让组件自己再读一遍
快照（两份真值）。做成 hook 则**状态仍住在 `ComposerBox`**，只是代码换了文件：
`useModelControls` 接三个入参（通道、写错误行、开浮层前收别人），交出四样（两颗 chip 的节点、
能力门、关这两张浮层的函数、底栏那一行的 ref）。

**不新增组件边界**，所以重挂时机、状态生命周期、React 树形状一行没变。

### 一处必须改的接线：互斥改成一个回调

四张浮层互斥原来是四颗 chip 各自调四个 setter。搬出去之后：

- 模型 / 档位两颗（在 hook 里）调 `onTakeOver()`，由父组件收掉权限 / 模式 / 分支；
- 权限 / 模式两颗（还在父组件里）调 `controls.close()`。

行为等价，但**读代码时互斥关系从「四乘四处 setter」变成了「两条通道」**，比原来清楚。

### 探针跟着改：三条

1. `ui-git-branch-test`「四颗旋钮的浮层互斥」原来数 `setBranchOpen(false)` 出现 ≥4 次。
   现在模型/档位两颗不再直接调它，改数两条通道：`setBranchOpen(false) ≥3`、
   `controls.close() ≥3`、`onTakeOver() ≥2`——四颗各有一条「收别的」路径，这才是那句话的意思。
2. `ui-mobile-shell-test`「三处 sheet 与三张浮层一一对应」原来在整棵插件子树里比 `indexOf`。
   档位那张搬进 `model-controls.tsx`，而它按文件名排在 `ui.tsx` 前面，跨文件比序号必然错位。
   改成按文件各判各的：`ui.tsx` 里两张（权限 → 模式）、`model-controls.tsx` 里一张（档位）。
3. `ui-interaction-base-test`「宿主拒绝时撤乐观值并报错」的正则里 `setFault` 换成了 `onFault`
   （hook 的回调名），断言含义不变。

### 验证

| 门 | 结果 |
| --- | --- |
| `pnpm -C ui-shell typecheck` | 0 |
| `pnpm run check:ui` | 39/39 |
| `pnpm -C ui-shell build` | 0 |
| `style-check --changed` | 全过 |
| `dup-scan` | 430 个文件、0 组 |

## 二十七、第二轮全仓复查：规范 / 格式 / 架构再看一遍（2026-10-28）

上一轮十九批收拾的是结构；这一轮按 skill 的组件边界、状态归属、barrel 导入、渲染分支四类规则，
配脚本把「规范」与「格式」变成可复查的数字，再清掉量出来的六条。**结论：格式与规范是过关的，
缺口在工程门禁，不在代码本身。**

### 量出来的数

| 项 | 数 |
| --- | --- |
| 源文件 / 行数（不含 `node_modules`、`lib`、`.worktrees`） | 602 / 169,946 |
| 缩进 | 2 空格 **439/439**（按最小缩进判，剔 JSDoc 行） |
| 制表符 / 行尾空白 / BOM / 混用行尾 | 0 / 0 / 0 / 0（607 个文件） |
| 深相对导入（`../../../`） | 0 |
| `any` / `as any` | 3 / 2（全在测试与负例） |
| `@ts-expect-error` | 12（全在 `slot-contract.typecheck.tsx` 的负例） |
| 插件引用 `src/core` / 壳引用 `src` | 0 / 0 |
| 插件横穿到另一个插件 | **2**（已修，见下） |

### 修掉的六条

| 编号 | 问题 | 落点 |
| --- | --- | --- |
| F1 | CI 夜跑不跑界面探针（40 条 + 4 条 e2e 只在 `package.json`） | `.github/workflows/verify.yml` 夜跑加 `ui-shell build` + `check:ui` |
| F2 | 轨迹页从 `../transcript/review-notice` 横穿取模块 | 两份模块搬进 `ui-primitives`，两家改走 `@dsc/ui-primitives` |
| F3 | `verify.yml` 数字漂（49/77 → 57/80）、同一条注释重复两遍 | 文案不写数字，去重 |
| F4 | 13 处 `eslint-disable` 空指令（仓库没有 ESLint） | 全改成普通注释，写清「为什么故意不列依赖」 |
| F5 | 字节读法五份（`512B` / `512 B` / `1536 字节` / `1.2 MB` / `1.00 GB`） | 并成宿主 `src/core/bytes.ts` + 壳 `ui-primitives/sizes.ts`，`ui-bytes-test` 逐字钉 |
| F6 | `commands-battery.mjs` 不合探针命名，任何闸门都不收它 | 改名 `commands-battery-test.mjs`，自动进 `check-core` 发现列表 |
| F7 | 无 `.editorconfig`；根目录 19 个 pack 产物 `.tgz` | 加 `.editorconfig`、删 `.tgz` |

### F2 的做法与代价

搬走的是两个模块：`review-notice.ts`（纯解析，零依赖）与 `review-notice-card.tsx`（79 行卡片）。
卡片原来 import `@dsc/ui` 与 `@dsc/ui-primitives`，搬进基元包后改成 `./icons`、`./file-icons`、
`./paths`——基元包不许反向依赖 `@dsc/ui`（`ui-plugin-test.mjs:1032` 那条链上有闸）。
引用方三处（`transcript/render.tsx`、`transcript/welcome.tsx`、`trace/ui.tsx`）改走包名。

好处是实的两条：两个插件产物里不再各存一份；transcript 改签名时 trace 不会跟着坏。
探针 `ui-review-notice-test` 新增第 [7] 段钉住「两家都从 `@dsc/ui-primitives` 取、插件目录之间
不再出现相对导入」——把这条路堵回去。

### F5 为什么不能只留一份

分层规定壳不许 import `src/`（`ui-plugin-test` 的依赖链闸门），反向也不许。所以字节读法只能
「宿主一份 + 壳一份」，代价是两份可能漂。处理办法是钉而不是合：
`scripts/ui-bytes-test.mjs` 抠出两份函数体、剔注释压空白后逐字比对，再把 14 个样本（含 0 / 负数 /
NaN / Infinity）两侧真跑一遍比输出。改一边不改另一边，探针立刻红。

顺带收掉 `formatSize` 这个名字：它与 `formatBytes` 是同一件事的两个名字，留着只会招来第六份。

### 没动的两条（记账）

- **238 个文件整篇 CRLF**：`.gitattributes` 已钉 LF，归位要 `git add --renormalize .`，
  一次作废 238 个文件的 blame。要人拍板，不夹在功能批里做。
- **TUI 的 39 个 `src/app/*.tsx` 用 PascalCase**：与壳里 `ui.tsx` 的小写命名并存。React 组件惯例，
  改名收益只是好看，代价是全量改文件，不动。

### 验证

| 门 | 结果 |
| --- | --- |
| `pnpm typecheck` / `pnpm -C ui-shell typecheck` | 0 / 0 |
| `pnpm run check:core` | 57/57 |
| `pnpm run check:ui` | 40/40 |
| `node scripts/ui-bytes-test.mjs` | 19/19 |
| `node scripts/ui-review-notice-test.mjs` | 63/63 |
| `pnpm -C ui-shell build` | 0 |
| `check:style` 全仓 | 607 个文件全过 |
| `dup-scan` | 431 个文件、0 组 |
