# 字体设置（C 方案）实施计划

> 状态：**已实施**（2026-11-17，分支 `feat/font-settings`）。本文是动手前的调研与设计，
> 事实部分（现状、行号）仍有效；§3.5 的「推荐选项 1」没有采纳——用户拍板要**真 px 字段**，
> 实施时按选项 2 做（`textSizePx` 为真源，`fontSize` 变派生值）。其余按原计划执行。
>
> 计划书里写的分支基点与工作区状态是当时的现场，实际开工时仓库已被别人合过一轮，最终基点
> `0c697a3c`（`dev` 当时的最新提交）。

## 0 一句话

给 numa 的外观设置加**两行字体输入框（正文 / 代码）**，把字号滑杆改成 **px 档**，
让字体和字号都落到 `--dsc-font-*` 令牌上；存储仍走 `~/.dsc/settings.json` 的 `ui` 段，
旧档零迁移。

## 1 目标与非目标

**目标**

1. 用户能在设置 → 外观里填「正文字体」「代码字体」，留空即用内置栈，改完**立刻生效**、刷新与重启后保持。
2. 字号以 **px** 呈现（不再是 `%`），滑杆刻度与显示都是像素。
3. 顺带修掉「等宽文本里的中文落到宋体」（当前 `--dsc-font-mono` 尾部的裸 `monospace`，见 §2.4）。

**非目标（本期不做，写清免得误会）**

- 手机远程界面 `remote-web`：它有一套独立的样式表（`remote-web/src/styles.css:57-59` 的
  `--font-ui`），不复用 `@dsc/*` 包（`remote-web/src/**` 里没有任何 `@dsc/` import），
  本期不同步。
- 侧栏终端（xterm）：字体硬编码在 `src/packages/ui-terminal/ui/ui.tsx:141`，P2 再开。
- 字体可用性探测 / 下拉预览：P2。

## 2 现状（调研结论，带证据）

### 2.1 从设置页到像素的完整链路

```
设置页 AppearanceRows        src/packages/ui-settings/ui/ui.tsx:1104-1250
  change(patch)              ui.tsx:1130-1150
    ├─ requestAppearance(…)  即时落地（不发盘）
    └─ setUiPrefs(patch)     落盘
         ↓
壳监听                        src/packages/ui-renderer/ui/ui.tsx:139-144
  appearance = {…, patch}
  applyAppearance(appearance) src/packages/ui-runtime/ui/appearance.ts:154-186
    root.dataset.theme / density
    root.style.setProperty('--dsc-font-scale', …)   appearance.ts:166
         ↓
令牌                          ui-renderer/ui/styles/legacy/tokens.css:227-245 / 384-390
样式消费                      base.css:22-29（body 字体）、views.css（100+ 处 --dsc-font-mono）
```

- 首帧：`syncAppearance()` 先读 localStorage 镜像上色，再回读宿主真值
  （`ui-renderer/ui/ui.tsx:90-97`、`appearance.ts:230-274`）。
- 跨插件请求类型：`AppearancePatch` 在 `ui-shell/src/plugin-api.ts:247-266`。
- 通道白名单与体积上限：`src/core/ui-methods.ts:390`，`setUiPrefs` 的 JSON 上限 32000 字节
  （`MAX_PREF_JSON`，`ui-methods.ts:286`）。

### 2.2 存储与校验

- 真源 `~/.dsc/settings.json`：`src/core/prefs.ts`
  - 默认值 `readPrefs()`：`prefs.ts:360-407`
  - 读档逐键归一：`prefs.ts:422-513`（字号在 447-449）
  - 写盘深合并：`writePrefs()` `prefs.ts:568-579`（只合并 `ui` 与 `remote` 两层）
- 宿主注入点：`src/packages/settings/index.ts:681-689`（`setPrefs` → `savePrefs` → `writePrefs`），
  `prefs()` 返回内存快照 `settings/index.ts:678-680`。
- 桥：`src/packages/runtime/index.ts:683-689`（`getUiPrefs` / `setUiPrefs`，后者拼一条 toast 回执，
  外观那几个键归「已保存外观设置」`runtime/index.ts:712-716`）。

### 2.3 归一函数目前有三份拷贝

| 位置 | 作用 |
| --- | --- |
| `src/core/prefs.ts:231-235` `readFontScale` | 读档时夹取 0.85–1.35 |
| `src/packages/ui-runtime/ui/appearance.ts:84-88` `normalizeFontScale` | 落地前再夹一次 |
| `src/packages/ui-settings/ui/ui.tsx:1415-1435` `normalizePrefs` | 只为画控件，第三次夹取 |

代码里已经用注释明说「改这里要两边一起改」（`appearance.ts:30-32`、`prefs.ts:190-194`）。
新增字体串归一不能再加第四份，做法见 §3.2。

### 2.4 当前字体令牌与两个既知缺陷

```css
/* tokens.css:384-390 */
--dsc-font-ui:   'Segoe WPC', 'Segoe UI', -apple-system, BlinkMacSystemFont,
                 'PingFang SC', 'Microsoft YaHei', 'Hiragino Sans GB', system-ui,
                 sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji';
--dsc-font-mono: 'JetBrains Mono', 'Cascadia Mono', 'Sarasa Mono SC', Consolas,
                 'DejaVu Sans Mono', Menlo, ui-monospace, monospace;
```

1. **没有用户可配的字族**：设置页只暴露 `themeMode / fontSize / density` 三个键
   （`ui-settings/ui/ui.tsx:1135` 的 `appearanceKeys`），字体不可选。
2. **等宽栈尾部是裸 `monospace`，且没有 CJK**：本机没装 JetBrains Mono / Cascadia Mono /
   Sarasa Mono SC（`C:\Windows\Fonts` 实测），于是拉丁走 Consolas，中文落到浏览器
   `monospace` 通用族（Windows 上是宋体）。DSH 与 ZCode 都专门修过这一条：
   - DSH `packages/client/ui-theme/src/styles/base.css:1-13`：代码栈**故意不带** `monospace`，
     末尾挂 `'PingFang SC', 'Microsoft YaHei'`，文件头注释写明理由。
   - ZCode `packages/ui/src/styles.css:160-180`：`monospace` 前显式插
     `"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC"`，
     注释写「Windows 的 Consolas 不含中文字形，Tailwind 默认栈最终会让中文落到宋体」。
3. 字号语义是**倍率**（0.85–1.35，基准 14px），设置页显示成 `100%`
   （`ui-settings/ui/ui.tsx:1153`、`1186-1198`），文案还写着过时的「正文 13px 为基准」
   （`ui-settings/locale/ui.zh.json:367`；实际 body 被 `styles.css:3806` 抬到 14/20）。
4. `--dsc-font-scale` 只影响字号与行高（全仓 17 处，全是 `--dsc-fs-*` / `--dsc-lh-*`），
   不影响间距 —— 这意味着「px 字号 ↦ 倍率」不会连带改布局，方案可行（§3.5）。

### 2.5 参考实现的设置形状

- **DSH**：三档角色（正文 / 代码 / 终端）各一行**字体列表**输入框，逗号分隔、留空用内置栈
  （`packages/client/ui-theme/src/theme-settings.ts:56-67`、`client/FontFamilyRow.tsx`）；
  字号按 **px** 且分角色：正文 14（10–22）、代码 11（10–16）、终端 13（10–20）
  （`theme-settings.ts:41-53`）。
- **ZCode**：界面字号 12–20（默认 14，`packages/ui/src/styles.css:91`）、代码字号单独一档、
  终端字体可填（`i18n/locales/zh-CN.ts:3554-3567`）。

## 3 方案设计

### 3.1 数据模型

在 `UiPrefsView`（`src/contract/session.ts:148+`）与 `prefs.ui` 里各加两个字段：

| 字段 | 类型 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `textFontFamily` | `string` | `''` | 归一后 ≤ 200 字符、≤ 8 个族 | 空串 = 内置栈 |
| `codeFontFamily` | `string` | `''` | 同上 | 空串 = 内置栈 |

命名取 **DSH 同名**（`textFontFamily` / `codeFontFamily`），以后要移植终端字体时
`terminalFontFamily` 直接对得上；本仓的短名风格（`themeMode`）不强求一致，理由写在字段注释里。

字号见 §3.5（两种做法，推荐「显示 px、存储仍倍率」）。

### 3.2 归一与校验

新增纯函数 `normalizeFontList(value: unknown): string`：

1. 非字符串 → `''`；trim 后为空 → `''`。
2. 按 `,` 切段（不支持引号内含逗号 —— 字体名里出现逗号的情况不存在，写进注释）。
3. 每段：trim → 去掉控制字符、`;`、`{`、`}`、换行 → 剥成对引号 → 长度 ≤ 64。
4. 段内出现空格且没引号 → 自动补双引号（`Noto Sans SC` → `"Noto Sans SC"`）。
5. 不区分大小写去重，最多 8 段，拼回 `"A", "B"`。
6. 整串长度 > 200 → 截断到第 8 段或直接返回 `''`（取更保守：返回 `''`，交给默认栈）。

**放哪里**：`src/contract/fonts.ts`（与 `contract/session.ts:268` 的 `normalizeStatusBarPrefs`
同性质：契约层里的纯归一函数），由 `src/contract.ts` 转出。

**壳侧为什么还要一份**：`ui-core` 只从 contract 转出**类型**（`src/packages/ui-core/index.ts:96-180`），
UI 包没有运行期引用 contract 的先例；宿主（Node）与壳（浏览器）各引一份成本最低。
所以：`core/prefs.ts` 与 `ui-runtime/appearance.ts` 各调同一份实现（都从 `contract.js` 引），
`ui-settings` 那份 `normalizePrefs` 只做「原样显示」，不再夹字体串。
**一致性由测试兜住**：新探针拿一张输入表，断言「宿主读档后的值 == 壳落地前的值」。

### 3.3 落 CSS

`tokens.css` 拆成「默认栈 + 用户前缀」两段（DSH `base.css:26-31` 的写法）：

```css
:root {
  --dsc-font-ui-default:
    'Segoe WPC', 'Segoe UI', -apple-system, BlinkMacSystemFont, 'PingFang SC',
    'Microsoft YaHei', 'Hiragino Sans GB', system-ui, sans-serif,
    'Apple Color Emoji', 'Segoe UI Emoji';
  --dsc-font-ui: var(--dsc-font-text, var(--dsc-font-ui-default)), var(--dsc-font-ui-default);

  --dsc-font-mono-default:
    'JetBrains Mono', 'Cascadia Mono', 'Sarasa Mono SC', Consolas, 'DejaVu Sans Mono',
    Menlo, ui-monospace, 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC',
    'Noto Sans SC', monospace;
  --dsc-font-mono: var(--dsc-font-code, var(--dsc-font-mono-default)), var(--dsc-font-mono-default);
}
```

要点：

- 用户列表**永远**以默认栈收尾 → 用户填的字体缺字时中文仍落到雅黑/Noto，不会掉宋体。
- 默认 mono 栈在 `monospace` **之前**插了 CJK（顺手修 §2.4 第 2 条）。
- 用户没填时 `var(--dsc-font-text, X), X` 会重复一遍 X —— 无害（同族重复被忽略），
  这是 DSH 已在用的写法。
- **空串必须 `removeProperty`**，不能写成 `''`：`var(--a, X)` 解析成空串时整条
  `font-family` 非法，会退回浏览器默认字体。落地函数：

```ts
function setFontVar(name: string, value: string): void {
  if (value === '') document.documentElement.style.removeProperty(name)
  else document.documentElement.style.setProperty(name, value)
}
```

调用点：`applyAppearance()`（`appearance.ts:154-186`）里写 `--dsc-font-text` / `--dsc-font-code`。

### 3.4 设置页

`AppearanceRows`（`ui-settings/ui/ui.tsx:1104+`）在「字号」上方插两行，沿用现成样式类
`.setting-row / .setting-text / .setting-label / .setting-help / .setting-input`
（`views.css:6330-6355` 已有 `.setting-input`，不需要新样式）：

```
正文字体   [ 输入框 ]  用于界面与会话正文。多个字体用逗号分隔，留空使用默认。
代码字体   [ 输入框 ]  用于代码块、行内代码与工具输出。
字号       [ 滑杆 ] 16px
```

交互：

- 输入框是**草稿态**（`useState`），`blur` 或 `Enter` 提交，`Esc` 还原；提交时先本地归一
  （与服务端同规则），把归一结果回填输入框 —— 用户能当场看见「我写的这串被收成了什么」。
- 提交走现有 `change({ textFontFamily })`：先 `requestAppearance`（立刻变），再 `setUiPrefs`（落盘），
  失败回滚显示值（与主题那几行同一条路，`ui.tsx:1130-1150`）。
- `AppearancePatch` 加两个可选字段（`ui-shell/src/plugin-api.ts:247-251`）。
- 壳侧 `Appearance` 接口与 `appearanceFromPrefs` / `DEFAULT_APPEARANCE` 同步加字段
  （`ui-runtime/ui/appearance.ts:51-72`、`128-137`）。
- `setUiPrefs` 的回执链把新键并入「已保存外观设置」（`runtime/index.ts:712-716`）。

文案（`ui-settings/locale/ui.zh.json` + `ui.en.json`，两份键集必须一致，`scripts/ui-locale-test.mjs` 会查）：

| key | 中文 |
| --- | --- |
| `settings.ui.fontFamily.text.label` | 正文字体 |
| `settings.ui.fontFamily.text.help` | 用于界面与会话正文。多个字体用逗号分隔，留空使用默认。 |
| `settings.ui.fontFamily.text.placeholder` | 例如 "Noto Sans SC", "Segoe UI" |
| `settings.ui.fontFamily.code.label` | 代码字体 |
| `settings.ui.fontFamily.code.help` | 用于代码块、行内代码与工具输出。 |
| `settings.ui.fontFamily.code.placeholder` | 例如 "JetBrains Mono", "Sarasa Mono SC" |
| `settings.ui.fontSizeHelp`（改） | 正文基准 14px，按像素调；其它字号按比例跟随。 |
| `settings.ui.fontSizePx` | {px} px（显示后缀，若需要单独一条） |

### 3.5 字号：倍率还是 px

**选项 1（推荐）——显示 px，存储仍倍率**

- 滑杆改成按 px 取整，显示 `16px`：取值 **12–18px**（步长 1）。为什么不取到 19：
  19/14 = 1.357 超出现在的上限 1.35（`prefs.ts:192`），要 19 就得放宽上限，那是另一件事。
- 写入：`fontSize = px / 14`，保留 4 位小数（`scale = Math.round(px / 14 * 1e4) / 1e4`）。
- 读档：`px = Math.round(fontSize * 14)`，滑杆按它回位。
- 优点：`--dsc-font-scale` 契约不动 → TUI、旧接口、`calc(13px * scale)` 那一批全不用改；
  迁移零成本。缺点：px 只能落在 1/14 网格上（12px 实际是 0.857），显示层看不出；
  「正文之外的字号」仍按比例走，不能单独调。

**选项 2（真 px 存储）——新增 `textSizePx`**

- 新字段 10–22（默认 14），`--dsc-font-scale = px / 14` 由壳算；旧 `fontSize` 只在读档时换算一次。
- 优点：与 DSH 同形，将来加「代码字号独立」最顺。缺点：一段两字段并存，
  远程/旧壳读到旧字段要有兼容分支；19px 以上要放宽倍率上限；`getUiPrefs` 的线格式变宽。

**结论：本期选 1。** 若你要的是「设置里就存 16 这个数」，再上 2 —— 影响面在
`prefs.ts` 读档 + `appearance.ts` + 设置页三处，另有 TUI 的兼容取值要核。

### 3.6 代码字号（P1，不在 P0）

`--dsc-fs-code` 现在只有 4 处消费（`views.css:1809/1957/2436/12104`）。P1 加
`codeSizePx`（10–16，默认 11），壳直接 `setProperty('--dsc-fs-code', px+'px')` 覆盖
tokens 里的计算值（内联样式优先级更高），不需要改生成器。P0 不做，避免一次改两件。

## 4 改动清单

| # | 文件 | 改什么 | 批次 |
| --- | --- | --- | --- |
| 1 | `src/contract/session.ts` | `UiPrefsView` 加 `textFontFamily` / `codeFontFamily`（含注释与默认口径） | P0-a |
| 2 | `src/contract/fonts.ts`（新） | `normalizeFontList` 纯函数 + 单元注释 | P0-a |
| 3 | `src/contract.ts` | 转出 `./contract/fonts.js` | P0-a |
| 4 | `src/core/prefs.ts` | 默认 `''`、读档调用归一、字段进 `DscPrefs.ui` | P0-a |
| 5 | `src/packages/ui-runtime/ui/appearance.ts` | `Appearance` 加两字段；`appearanceFromPrefs` 归一；`applyAppearance` 写 `--dsc-font-text/-code` | P0-b |
| 6 | `ui-shell/src/plugin-api.ts` | `AppearancePatch` 加两字段 | P0-b |
| 7 | `ui-renderer/ui/styles/legacy/tokens.css` | 拆默认栈 + 用户前缀 + mono 补 CJK（§3.3） | P0-b |
| 8 | `src/packages/ui-settings/ui/ui.tsx` | 两行输入框 + 草稿/提交/回滚；字号滑杆改 px；`normalizePrefs` 带新字段 | P0-c |
| 9 | `src/packages/ui-settings/locale/ui.zh.json` / `ui.en.json` | 新增/修订文案（§3.4） | P0-c |
| 10 | `src/packages/runtime/index.ts` | 回执链并入「已保存外观设置」 | P0-a |
| 11 | `scripts/ui-font-prefs-test.mjs`（新） | 归一表 + 宿主/壳一致性 + 读档坏值回落 | P0-a/c |
| 12 | `scripts/ui-font-apply-test.mjs`（新） | 断言 `applyAppearance` 写/删变量（纯函数式，用假 document 或 jsdom 替代） | P0-b |
| 13 | `docs/development-log.md` / `docs/ui-design.md` | 记录字体轴与令牌拆分（P0 收尾） | P0-c |

## 5 批次与验收

每批都能独立验收，不做「一次性全部改完再看」。

**P0-a 契约与宿主**（1–4、10、11）
- 验收：`pnpm run build` 通过；临时 `DSC_HOME` 跑新探针，断言
  「写 `textFontFamily: 'Noto Sans SC, "A B"'` → 读回 `"Noto Sans SC", "A B"`」、
  「坏值（数字/超长/带分号）→ `''`」、「旧 settings.json 无这两键 → `''`」。

**P0-b 壳与令牌**（5–7、12）
- 验收：`pnpm run build:ui` 后 `node scripts/_ui-shell-serve.mjs`，手改 `settings.json` 里的字体 →
  界面立即变、刷新保持；`--dsc-font-mono` 的 CJK 兜底用一行中文代码块肉眼确认（或截图对比）。

**P0-c 设置页与文案**（8、9、13）
- 验收：设置 → 外观出现两行输入；输入 `Noto Sans SC` 回车后正文立刻换字体；清空回车恢复默认；
  英文界面无缺译（`node scripts/ui-locale-test.mjs`）；`pnpm run check:ui` 全绿。

**P1**：代码字号独立（§3.6）。字号 px 档已经并进 P0-c（用户点名要的那一项）。
**P2**：终端字体（`ui-terminal/ui/ui.tsx:141`）、字体探测与预览、`remote-web` 对齐。

## 6 验收命令（每批都跑，跑过才写「通过」）

```powershell
pnpm run typecheck
pnpm run build
node scripts/check-core.mjs
pnpm run check:style
pnpm run check:ui
pnpm run build:ui
pnpm --dir desktop typecheck
node scripts/ui-locale-test.mjs --package ui-settings   # 只查改了文案的包
```

手工：`node scripts/_ui-shell-serve.mjs` 起壳，设置页改两行字体 + 字号，重启壳确认保持；
截图前后各一张（会话页 + 设置页）附在交接里。

## 7 风险与回滚

| 风险 | 处理 |
| --- | --- |
| 用户填了本机没有的字体 | 静默回落默认栈（CSS 语义），P2 再给「当前生效」提示 |
| 用户字体不含中文 | 用户列表后**永远**拼默认栈兜底 → 中文仍走雅黑/Noto |
| 字体串注入 | 只走 CSSOM `setProperty`，字符白名单 + 长度上限，不拼 HTML |
| 空串写成 `''` 导致整条 font-family 失效 | 约定 `removeProperty`，测试里专门断言这一条 |
| 首帧闪烁 | 镜像存的是整份 `Appearance`（`appearance.ts:267-274`），新字段自动进镜像 |
| 远端（手机）不同步 | 明确非目标，文档写清 |
| 回滚 | 全是新增字段与 CSS 变量；回退 = 删两个字段 + 恢复 tokens，旧档不受影响（缺键回落空串） |

## 8 待拍板（四问，给了推荐值）

1. **字段名**：DSH 同名 `textFontFamily` / `codeFontFamily`（推荐，向后兼容移植），
   还是本仓风格 `fontFamilyText` / `fontFamilyCode`？
2. **字号**：选项 1「显示 px、存储倍率」（推荐，零迁移）还是选项 2「真 px 字段」？
3. **代码字号**：P1 再做（推荐），还是 P0 一起上？
4. **顺带修中文落宋体**：P0 一起修（推荐，一行 CSS，收益最大），还是单独一个提交？

## 9 调研边界（诚实说明）

- 读过的代码：`prefs.ts`（全文）、`appearance.ts`（全文）、`plugin-api.ts:200-289`、
  `ui-renderer/ui/ui.tsx:60-220`、`ui-settings/ui/ui.tsx:1090-1450`、`tokens.css` 字号与字体段、
  `views.css` 相关行、`contract/session.ts` 与 `contract/settings.ts`、`settings/index.ts:126-156 / 217-316 / 672-711`、
  `runtime/index.ts:678-733`、`ui-methods.ts:284-290/388-390`、`check-ui.mjs`、`panel-prefs-test.mjs`、
  `ui-locale-test.mjs`、DSH `base.css` / `theme-settings.ts` / `FontFamilyRow.tsx`、
  ZCode `styles.css` / `zh-CN.ts` 字体段。
- **没做**：没改代码、没跑 `build` / `check:*`、没起壳截图。所以本文里没有「通过」字样。
- 本机字体实测：`C:\Windows\Fonts` 有 微软雅黑（msyh）、Noto Sans SC、MiSans、Consolas、
  Ubuntu Mono；**没有** Segoe WPC、PingFang SC、JetBrains Mono、Cascadia Mono、Sarasa Mono SC。
