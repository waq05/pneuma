# 输入区的模型 / 思考档位：两颗 chip + 两级模型菜单

2026-10-15 起做的一件事。用户原话：**「当前项目的模型选择框把思考等级和模型放到一起了，同时
看不出来当前选的是哪个模型和思考强度。可以参考图二 zcode 的展示逻辑」**，并给了两张截图
（一张是当时 dsc 的合并浮层，一张是 ZCode 输入区底栏的模型钮 + 档位钮 + 两级菜单）。

对齐对象是 ZCode composer 的两个触发器与那张菜单：模型与思考档位是**两颗独立的钮**
（`packages/ui/src/v4/composer/V4ComposerToolbar.tsx:1128` / `:1167`），chip 上直接写
`端点/模型`（`packages/ui/src/v4/composer/modelTriggerDisplay.ts`）与当前档位名
（`packages/ui/src/chat-input-toolbar/ThoughtLevelCycleControl.tsx`）；模型菜单是**两级**
（`packages/ui/src/ModelConfigSelect.tsx:614-637`：一级端点、二级该端点的模型，当前端点与当前
模型各自打勾，底部固定一行「管理模型」）。

## 一、报障底下压着三处真缺陷

用户说的是「挤在一起、看不出」，查下去底下是三处会真出错的代码——它们是「看不出」的直接原因，
不是观感问题。

**① 档位清单漏了「默认」。** 宿主把 `default` 当**恒可选**的档位
（`src/core/model-caps.ts:179` 的 `hasEffortLevel`：「默认档永远可选」；`src/core/ui-methods.ts:252`
的 `setEffort` 枚举里也有 `default`，含义是「不发思考字段」）。而旧版在模型查得到时只列
`model.thinkingLevels`（`off/low/high/max` 四档，`ui-shell/src/plugins/composer/ui.tsx` 旧 481 行），
于是**出厂态 `status.effort === 'default'` 时四个按钮一个都不亮**，而且选过档位之后在界面上
回不去「默认」。旧版的兜底（模型查不到时给五档）恰好反证了这一点：有清单反而更差。

**② 打勾基本不出现。** 判据是 `choice.value === model`，而 `status.model` 是**裸模型名**
（`src/plugins/transcript.ts:255` ← `ctx.llm.model`），`value` 才是 `端点/模型`
（`src/plugins/llm.ts` 的 `listModels`）。除非用户的端点名恰好是空串，这个等式永远不成立——
所以清单里一条勾都不会有。同一个模型 id 挂在两个端点下时（`deepseek/deepseek-v4.1-flash` 与
`command/deepseek-v4.1-flash`）更分不清是哪一条。

**③ 清单只在挂载时取一次。** 旧版注释写着「模型清单是进程内静态数据」——它不是：设置里加过
端点、改过模型之后这张清单就是旧的，点开菜单看到的还是上一轮配置，当前模型甚至可能根本不在
里面，而界面**一个字都不交代**（只画一片没有勾的清单）。用户截图里 chip 写
`deepseek-v4.1-flash`、清单里却找不到同一行，大概率就是这一条。

## 二、现在的形态

```
底栏右组：  [包裹] DeepSeek/deepseek-v4.1-flash ⌄   [脑] 默认 ⌄   [↑]
                     └ 模型 chip（端点/模型）          └ 档位 chip（读 status.effort）
```

- **两颗 chip 各管一件事**：模型 chip 画「端点/模型」，档位 chip 画当前档位。四张浮层
  （权限 / 模式 / 分支 / 这两张）两两互斥，口径沿用旧界面。
- **模型菜单两级**：一级**只列端点**（显示名、当前那个带勾、右侧固定一个 `›`），鼠标停在某一
  行（或 Tab 到、或点一下）才**悬浮飞出**该端点的模型清单（名字 + `图`/`视频` 徽标 + `一千 k`
  上下文 + 当前项打勾）。**第二版把这个形态换了**（并排两栏 → 窄面板 + 飞出卡），理由与量法见
  第九节；下面那条「只有一个端点时不摆一级」两版一致。
- **只有一个端点时不摆左栏**（那股前缀与一级列表都是噪音，ZCode 的 `showProviderLevel` 同款）。
- **档位菜单**：`默认` + 该模型声明的档位，当前项带勾。清单**跟着模型变**（两档模型的菜单只有
  `默认/关/高`），模型查不到时给五档兜底（不锁死用户）。
- **单档 / 无档位模型**：退化成一颗**不可点的 `<span>`**（没有箭头、没有 `aria-expanded`），
  `title` 说「这个模型没有可切换的档位」。
- **当前模型不在清单里**时，菜单顶部先给一条说明行（`当前：xxx —— 清单里没有这个模型`），
  且**每次展开重取** `listModels`。
- 底部固定一行「管理模型」→ `shell.settings.open` 的 `detail.section = 'models'`，
  直达设置 → 模型（两栏那页，见 `models-page-two-pane` 那条记忆）。

## 三、判定都住在纯模块里

`ui-shell/src/plugins/composer/model-picker.ts`（**零运行时依赖，只 `import type`**）：

| 导出 | 管什么 |
| --- | --- |
| `groupModels` | 按端点归组，顺序照宿主清单；`displayName` 空串回落端点名 |
| `findCurrent` | 三级判据：**端点 + 裸名** → `value` 全等 → 裸名；返回 `exact` 标记 |
| `modelChipText` | chip 的两段字（`prefix` / `name` / `full`）；只有一个端点时不带前缀 |
| `effortChoices` | **恒含 `default`** + 该模型声明的档位 |
| `effortSwitchable` | 只有一档就不给浮层与箭头 |
| `modelBadges` / `contextLabel` | 徽标与 `1000k` 读数 |
| `providerHint` / `filterModels` | 一级行尾注；二级搜索 |

**为什么非要把逻辑抽出来**：探针读不了 `.tsx`（Node 的类型擦除不认识 JSX），上面 ①② 两条
缺陷能在代码里活这么久，正是因为它们原地长在 `ui.tsx` 里、任何探针都够不着。抽成零依赖 `.ts`
之后 `scripts/ui-model-picker-test.mjs` 能直读跑真断言（同 `draft.ts` / `git-branch.ts` 的路数）。

## 四、宽度账（这一版真正的难点）

`.composer-zone` 的子节点封顶 `--dsc-thread-max`（76ch），**与窗口多宽无关**；实测
`.composer-bar` 的 `clientWidth` 是 **531px**。里面要住：左组三颗（`+` / 权限 / 模式 = **214px**）、
模型 chip、档位 chip（77px）、发送键（34px）、四个 gap（12px）。

**留给模型 chip 的只有约 174px**，而 `端点/模型` 两段字按种子（`DeepSeek/` + `deepseek-v4.1-flash`）
要 **224px**。第一版给 chip 设了 `max-width: 150px`，结果 flex 把两段**按比例各截一半**——
实机截图是 `Dee… deepseek…`，比原样还差（这张丑图留在 `desktop/shots/mp-0-*.png` 当反例）。

定稿口径：**模型名是身份，端点是出处**。

- 放不下就把端点前缀**整段收掉**（ZCode 的 `composer-provider-compact` 同款），只留模型名；
  端点在菜单里带勾、在 `title` 与 `aria-label` 里也有全称。前缀 `flex: none`——**要么整段在、
  要么整段收**，绝不半截。
- 量法（`composer/ui.tsx` 里那两条 `useLayoutEffect` + 一个 `ResizeObserver`）：deps 是
  「完整形态的签名」（`chip.full | 模型数 | 栏宽`），先归位成完整形态再量一次
  （`scrollWidth > clientWidth` 或栏自己溢出就收）；收掉之后不再重量，所以不会来回抖。
  **两条 effect 的顺序是硬要求**：归位那条必须排在测量那条前面，否则同一拍里互相覆盖
  （第一版就这么静默失效——探针与截图各抓到一半）。用 `useLayoutEffect` 是为了同一帧内
  跑完，不然会先画一帧「两段都截半」的丑样子。
- ≤560px 那条窄屏规则直接 `display: none` 掉前缀（手机上必然放不下，别让第一帧闪一下）。
- 另外给 `.bar-left` / `.bar-right` 补了 `min-width: 0`、给 `.model-btn` 补了
  `overflow: hidden; white-space: nowrap`：挤不下时**截字而不是横向溢出**（960px 最小桌面窗口
  碰不到 ≤560 的 `flex-wrap`，溢出会把整行顶出正文列）。

## 五、宿主侧三处加法

都不改口径、不新增方法：

| 位置 | 加了什么 | 为什么 |
| --- | --- | --- |
| `src/contract.ts` `StatusView` | `provider?: string` | `model` 是裸名，界面画不出「从哪来」、也分不清给哪一条打勾 |
| `src/contract.ts` `ModelChoiceView` | `providerDisplayName: string` | 一级菜单与 chip 前缀画显示名；空串回落端点名 |
| `src/plugins/transcript.ts` | `provider: ctx.llm.provider` | 上面那个字段的产地 |
| `src/plugins/llm.ts` | `providerDisplayName: provider.displayName === '' ? provider.name : …` | 同上 |

界面通道白名单（`core/ui-methods.ts`）一行没动——用的还是 `listModels` / `setModel` / `setEffort`。

## 六、验收

- **新探针 `scripts/ui-model-picker-test.mjs`**：第一版 84 条，第二版扩到 **132 条**——纯逻辑
  （分组 / 精确命中含「同一个 id 挂两个端点」/ chip 文案 / 档位清单恒含默认 + **与
  `src/core/model-caps.ts` 的 `THINKING_LEVEL_LABELS` 真读对账** / 徽标读数 / 一级开关 /
  **飞出卡三条定位判定** `chooseFlyoutSide` · `placeFlyout` · `clampShift` 的表驱动用例）、
  `ui.tsx` 接线钉、宿主加法产地、样式门（新类名有规则、**撞名门**、**死选择器门**、无硬编码色、
  无幽灵令牌、退役类名不许回来、宽度上限、窄屏规则）、负向自证。
- **外部负向验证五次**（证明探针不是空转）：`effortChoices` 去掉 `default` → 恰好 4 条红；
  `findCurrent` 的端点分支改坏 → 恰好 2 条红；`chooseFlyoutSide` 退化成恒走右边 → 3 条红；
  `placeFlyout` 去掉夹高度 → 5 条红；把行类名改回撞名的 `.model-row`（连探针清单一起改）→
  恰好撞名门 1 条红；面板的 `mouseleave` 拿掉 → 恰好 1 条红。每次都还原并核对哈希。
- **全量无头电池**（`pnpm build` + `pnpm build:ui` 之后跑）。
- **实机走查一（第一版，隔离 HOME 三个端点）**：同名模型挂两个端点 / 两档模型 / 无档位模型，
  逐条读回执：`data-composer-model = deepseek/deepseek-v4.1-flash`（含端点，歧义已消）、档位菜单
  `默认(on)/关/低/高/最大`、切到 `command` 后同名模型 `data-model-current` 为 `null`（不误勾）、
  两档模型的菜单只有 `默认/关/高`、无档位模型 `effortTag = SPAN`。
- **实机走查二（第二版，四个端点含一个九模型的端点）**：1150px 下飞出卡走右边（
  `cardX 830 / right 1094`，容器 237…1150，完全落在里面）；九模型时卡片被夹到 167px 高
  （内容 298px）自己滚，卡片底边 549 ≤ 面板底 561 < 输入行 566（**不盖输入框**）；620px 下
  两边都塞不下 → `side=overlay` 就地占位；390px 下面板被 `clampShift` 推回（`translateX(137.7px)`，
  面板 60…380），九个模型名一个都没截。

## 七、有意不做的

- **冻结的旧桌面渲染层 `desktop/src/renderer/Composer.tsx` 没动**：它那份同款合并浮层还是老样子
  （「旧桌面版不动」是既有拍板，见 `legacy-frozen-check.mjs` 的口径）。
- ZCode 的**档位进度小条**与 `Ctrl+M` / `Ctrl+T` 热键没做（前者是装饰，后者是另一件事）。
- **没 bump 版本、没打包**：壳契约与 `package.json` 的版本留待整批发布时一起抬。

## 八、走查配方（这套可以照抄）

```bash
node desktop/shots/_mp-seed.mjs                     # 造隔离 HOME（三端点 + 同名模型 + 无档位模型）
MP_FAKE_KEY=walkthrough-key \
  DSC_UI_SERVE_HOME="D:/dsc/desktop/shots/mp-home" \
  DSC_UI_SERVE_CWD="D:/dsc/desktop/shots/mp-home/ws" \
  node scripts/_ui-shell-serve.mjs                  # 打印带 token 的地址
```

三条坑（都踩过）：

1. **假端点要真给 key**：`config.yaml` 里 `apiKeyEnv: MP_FAKE_KEY` 必须配同名环境变量，否则宿主
   报「没有可用的模型端点」、`status.model` 是空的。
2. **令牌换的那张 Cookie 在重载时没带住**（`reload()` 会掉回「需要凭据」页）→ **改完代码要重启
   伺服器拿新 token 再 `goto`**，别指望 reload。
3. 种子的档位字段名照 `core/model-caps.ts` 的 `RawModelCaps`：**`thinkingLevels`**（`n` 不是它）。

量走查里的关键读数（页面里直接打通道，比 curl 方便）：`fetch('/api/invoke', …)` 读
`listModels`；`document.querySelector('[data-composer-model]')` 读 chip 的 `data-*` 与
`scrollWidth/clientWidth`；宽窄两档用 `tab.setViewportSize({width,height})` 切。

## 九、第二版：一级只列端点，模型悬浮飞出（2026-10-15）

用户第二条反馈，原话：**「这选择模型的页面也太大了，图二是 zcode 的大小。需要先只展示厂商，
鼠标悬浮到厂商上再显示对应的模型。」**

第一版把模型清单当右栏一直摆着（并排主从），于是整张面板 520px 宽、最高 420px。第二版：

- **一级只有端点**，192px（ZCode 一级是 `min-w-48`）：显示名 + 当前那个的 ✓ + 固定的 `›`，
  底部一行「管理模型」。顺带去掉头部那行标题（ZCode 没有，它也是白白的高度开销）。
- **二级是悬浮飞出的一张 264px 卡**，上限 288px（ZCode 二级 `max-h-72` 同款），超出自己滚。
- 一级行 `hover` / `focus` / **点一下**三处都开：触摸屏没有悬浮，只认悬浮等于手机点不开二级。
- 卡片是**面板的子节点**——`mouseleave` 认 DOM 层级不认几何，所以鼠标从端点行横穿到卡片上不会
  把卡片关掉，**不需要任何延迟计时器**（ZCode 那 100ms 是 Radix 的默认值，我们这里没必要）。
- 单端点仍然扁铺（面板挂 `.flat`，宽度按模型行给 264px）。
- 指针离开面板 → 收起飞出卡，回到「只有一级那一列」。

### 位置判定：全是量出来的，吃不了 CSS 断点

面板右缘对齐模型 chip，而 chip 宽度随模型名长短变、窗口宽度可拖——「两边各剩多少」只有拿到
rect 才知道（ZCode 那边同样是 Radix 拿实测 rect 挑边）。三条判定都在纯模块里，探针逐条钉：

| 判定 | 输入 | 口径 |
| --- | --- | --- |
| `chooseFlyoutSide` | 面板区间、**裁剪容器**区间、卡宽 | 右放得下 → `right`；左放得下 → `left`；都放不下 → **`overlay`**（盖住一级） |
| `placeFlyout` | 悬浮那一行的上下边、面板高、卡片自然高 | 顶边对齐那一行；整张卡夹在面板里（`top + maxHeight ≤ 面板底 − 12`），放不下就压高度让它滚 |
| `clampShift` | 面板区间、容器区间 | 面板探出容器就整体 `translateX` 推回来 |

**判据是「裁剪容器」而不是视口**，这一条是被实机走查逼出来的：`.thread-main` 是 `overflow: auto`，
飞出卡越出它的左边界就被**裁掉一条**——620px 实测卡片左缘被截 47px，模型名前缀直接看不见
（看着像「飞出去了」，其实半张卡没了）。`clipBoxOf` 往上找第一个 `overflow-x !== 'visible'` 的祖先。

**`overlay` 那一档是「就地占位」而不是绝对定位**：绝对定位的卡片盖在面板上时端点列已被藏掉、
面板塌成一条，卡片会落到「管理模型」上面叠字（第一版就是这个形态）。改成静态占位之后，面板按
卡片长高、「管理模型」留在下面，也不需要任何量出来的位置。

## 十、这一版被实机走查抓出来的四处

四条都是**静态扫描全绿、只有截图/量几何才看得见**的，所以每条都在探针里补了对应的门：

1. **类名撞名**：`.model-rows` / `.model-row` 撞上设置页模型卡那一套
   （`legacy/views.css:6622` 起是竖排卡片 `flex-direction: column`）——我的模型行静默继承，
   四行字竖着排。改名 `model-picker-rows` / `model-picker-row`，并加**撞名门**：这一版的新类名
   不许在 legacy CSS 或别的插件源码里出现过。
2. **`.flat` 是死选择器**：CSS 定义了、JSX 一直没挂上 → 单端点面板一直是 192px、模型名被截。
   加**死选择器门**：这一版每个类名（含修饰类）都必须在 `ui.tsx` 里当类名用。
3. **勾把读数挤走**（用户反馈的原话：「对勾不要把 1000k 等字样挤走，放在空白处，不然上下对不齐
   很难受」）：勾原先只有当前行才长出来，而读数是 `margin-left: auto` 顶到右边的 → 当前行的
   `1000k` 被挤左一格。改成**勾那一格始终占位**（`.model-picker-check`）。同一页面现场量：
   修前带勾行读数左缘 1028 / 不带勾行 1050，修后都是 1028。
4. **390px 面板整块探到视口外**（实测 `panelX: -78`，窄屏输入行换行后 chip 落在很靠左的位置）→
   `clampShift` 把它推回正文列里。
