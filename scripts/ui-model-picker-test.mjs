/**
 * 输入区「模型 / 思考档位」两颗 chip 的探针（0.6.71 改版）。
 *
 * 用户报的是「模型选择框把思考等级和模型放到一起，看不出来当前选的是哪个模型和思考强度」。
 * 查下去底下压着三处真错，这一条探针主要就是钉住它们不许回来：
 *
 *   1. **档位清单漏了「默认」**：旧版在模型查得到时只列模型声明的四档，于是
 *      `status.effort === 'default'` 时一个都不亮、选完也回不去（宿主把 `default`
 *      当恒可选的档位，见 `src/core/model-caps.ts` 的 `hasEffortLevel`）。
 *   2. **勾选拿 `value === 裸模型名` 判**：`status.model` 是裸名，`value` 是 `端点/模型`，
 *      两者几乎永不相等；同一个 id 挂两个端点时更分不清。
 *   3. **清单只在挂载时取一次**：设置里改过端点后面板还是旧的，当前模型不在清单里时
 *      界面一个字都不交代。
 *
 * 第二版（同一批用户的第二条反馈）：「这选择模型的页面也太大了」——上一版把模型清单当成
 * 右栏一直摆着，整张面板 520px 宽。现在一级只列端点（192px），模型清单改成**悬浮飞出**的
 * 一张卡；卡往哪边飞、多高，都由 `[7]` 那两条纯判定算（量到的 rect 喂进去）——因为面板右缘
 * 对齐模型 chip，chip 宽度与窗口宽度都可变，吃不了 CSS 断点。
 *
 * 十一组断言：
 *
 *   [1] 纯逻辑（`plugins/composer/model-picker.ts`，零运行时依赖，Node 类型擦除直读）
 *   [2] 分组与端点显示名
 *   [3] 当前模型的精确定位（含「同一个 id 挂两个端点」）
 *   [4] chip 文案（单端点不带前缀、查不到时原样显示）
 *   [5] 档位清单恒含「默认」+ 文案与宿主表同值（真读 `src/core/model-caps.ts`）
 *   [6] 徽标 / 上下文读数 / 一级开关 / 尾注 / 搜索
 *   [7] 飞出卡的挑边与夹高度（第二版新增：窄面板 + 悬浮飞出，定位判定也是纯函数）
 *   [8] 界面接线（读 `ui.tsx`）：两颗 chip、一级只列端点、飞出卡、管理模型、展开重取清单
 *   [9] 宿主三处加法（`status.provider` + `providerDisplayName` 的产地）
 *   [10] 样式门：新类名有规则、只用令牌、退役类名与旧的一排档位按钮都不许留（死选择器）
 *   [11] 负向自证：把上面每套扫描器喂一段**坏**输入，必须报红
 *
 * 运行：node scripts/ui-model-picker-test.mjs（读源码，不需要先编译）
 *
 * @module dsc/scripts/ui-model-picker-test
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const picker = await import(
  new URL('../ui-shell/src/plugins/composer/model-picker.ts', import.meta.url).href
)
const {
  EFFORT_FALLBACK,
  EFFORT_LABELS,
  FLYOUT_MAX_HEIGHT,
  FLYOUT_WIDTH,
  chooseFlyoutSide,
  clampShift,
  contextLabel,
  effortChoices,
  effortLabel,
  effortSwitchable,
  filterModels,
  findCurrent,
  groupModels,
  modelBadges,
  modelChipText,
  placeFlyout,
  providerHint,
  shouldShowProviderLevel,
} = picker

// 宿主那张表是**真读**来的（不是抄一份进探针再对抄）：档位文案的镜像门要对着它比。
const hostCaps = await import(new URL('../src/core/model-caps.ts', import.meta.url).href)

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')
// 本仓工作区是 CRLF：跨行文本钉一律先摊平（否则 `{\n  …` 这种写照永远匹配不上）。
const flat = (text) => text.replace(/\r\n/g, '\n')

let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`  ok  ${name}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
}

/** 造一条宿主清单项（字段与 `ModelChoiceView` 一致，默认值取最常见的那一档）。 */
const choice = (provider, model, extra = {}) => ({
  value: `${provider}/${model}`,
  provider,
  providerDisplayName: extra.displayName ?? provider,
  model,
  description: extra.description ?? '',
  contextWindow: extra.contextWindow ?? 128_000,
  thinkingLevels: extra.levels ?? ['off', 'low', 'high', 'max'],
  modalities: extra.modalities ?? ['text'],
})

// ── [1] 纯逻辑 ────────────────────────────────────────────────────────────────
console.log('[1] 纯逻辑：档位清单恒含「默认」')
{
  const one = choice('deepseek', 'deepseek-v4-pro', { levels: ['off', 'low', 'high', 'max'] })
  check('模型查得到：默认在最前，后面跟它声明的档位', JSON.stringify(effortChoices(one)) === JSON.stringify(['default', 'off', 'low', 'high', 'max']))
  const none = choice('local', 'llama-3', { levels: [] })
  check('模型声明了空档位：只留「默认」（这是唯一发得出去的形态）', JSON.stringify(effortChoices(none)) === JSON.stringify(['default']))
  check('模型查不到（清单没取到 / 不在清单里）：兜底五档，不锁死用户', JSON.stringify(effortChoices(undefined)) === JSON.stringify(EFFORT_FALLBACK) && EFFORT_FALLBACK[0] === 'default')
  const dirty = choice('x', 'y', { levels: ['off', 'nonsense', 'high'] })
  check('清单里出现没听过的档位：丢掉，不画一个点不动的按钮', JSON.stringify(effortChoices(dirty)) === JSON.stringify(['default', 'off', 'high']))
  check('只有一档就不给浮层（单档模型：ZCode 同款不给箭头）', effortSwitchable(['default']) === false && effortSwitchable(['default', 'high']) === true)
  check('档位文案取不到原值时原样显示（不编一个假名字）', effortLabel('high') === '高' && effortLabel('weird') === 'weird')
}

// ── [2] 分组与端点显示名 ──────────────────────────────────────────────────────
console.log('[2] 分组：按端点归组，顺序照宿主清单')
{
  const groups = groupModels([
    choice('deepseek', 'a'),
    choice('command', 'b', { displayName: 'Command Code' }),
    choice('deepseek', 'c'),
  ])
  check('归成两组、顺序是首次出现的顺序', groups.length === 2 && groups[0].provider === 'deepseek' && groups[1].provider === 'command')
  check('同端点的模型聚在一组里（不是按出现位置拆散）', groups[0].models.length === 2 && groups[0].models[1].model === 'c')
  check('端点显示名：宿主给了就用它', groups[1].displayName === 'Command Code')
  check('端点显示名：宿主没填（空串）时回落端点名，不留空标题', groups[0].displayName === 'deepseek')
  check('空清单不炸', groupModels([]).length === 0)
}

// ── [3] 当前模型的精确定位 ────────────────────────────────────────────────────
console.log('[3] 当前模型：按「端点 + 裸名」精确定位')
{
  const groups = groupModels([
    choice('command', 'deepseek-v4.1-flash'),
    choice('opencode', 'deepseek-v4.1-flash'),
  ])
  const hit = findCurrent(groups, 'opencode', 'deepseek-v4.1-flash')
  check('同一个 id 挂两个端点：命中的是 status.provider 指的那一个', hit.entry?.value === 'opencode/deepseek-v4.1-flash' && hit.exact === true)
  check('同一件事走另一条端点也对（不是靠顺序撞上的）', findCurrent(groups, 'command', 'deepseek-v4.1-flash').entry?.value === 'command/deepseek-v4.1-flash')
  check('端点未知时退回裸名匹配，并如实标记不是精确命中', findCurrent(groups, '', 'deepseek-v4.1-flash').exact === false)
  const full = findCurrent(groups, '', 'opencode/deepseek-v4.1-flash')
  check('`status.model` 本身是完整值时也能命中（远程页与老记录里有这种形态）', full.entry?.value === 'opencode/deepseek-v4.1-flash')
  check('清单里没有这个模型：如实给 undefined（界面据此说「清单里没有」）', findCurrent(groups, 'deepseek', 'ghost-model').entry === undefined)
  check('模型名为空（还没选）：不给任何命中', findCurrent(groups, 'deepseek', '').entry === undefined)
  check('端点对但模型名对不上：不算命中（不能打错勾）', findCurrent(groups, 'command', 'gpt-9').entry === undefined)
}

// ── [4] chip 文案 ─────────────────────────────────────────────────────────────
console.log('[4] chip 文案：多端点带前缀，单端点不带')
{
  const two = groupModels([choice('command', 'glm-5.3-flash', { displayName: 'Command Code' }), choice('opencode', 'haiku')])
  check('多端点：前缀是显示名 + 斜杠', modelChipText(two, 'command', 'glm-5.3-flash').prefix === 'Command Code/')
  check('多端点：名字是模型名（前缀与名字分开给，窄屏好收）', modelChipText(two, 'command', 'glm-5.3-flash').name === 'glm-5.3-flash')
  check('全称给悬浮说明用（收掉前缀后还看得到）', modelChipText(two, 'command', 'glm-5.3-flash').full === 'Command Code/glm-5.3-flash')
  const one = groupModels([choice('deepseek', 'deepseek-v4-pro')])
  check('只有一个端点：不带前缀（纯噪音）', modelChipText(one, 'deepseek', 'deepseek-v4-pro').prefix === '' && modelChipText(one, 'deepseek', 'deepseek-v4-pro').full === 'deepseek-v4-pro')
  check('模型不在清单里：原样显示宿主给的值，不吞也不改名', modelChipText(two, 'command', 'ghost').full === 'Command Code/ghost')
  check('还没选模型：说「未知模型」，不画一对空斜杠', modelChipText(two, '', '').name === '未知模型' && modelChipText(two, '', '').prefix === '')
}

// ── [5] 档位文案与宿主表同值 ──────────────────────────────────────────────────
console.log('[5] 档位文案：壳里那份是宿主表的镜像')
{
  const host = hostCaps.THINKING_LEVEL_LABELS
  const mismatched = Object.keys(EFFORT_LABELS).filter((key) => key !== 'default' && EFFORT_LABELS[key] !== host[key])
  check('四档文案与 `src/core/model-caps.ts` 的 THINKING_LEVEL_LABELS 逐字相同', mismatched.length === 0, mismatched.join('、'))
  check('四档的顺序也与宿主那四个键对得上（off/low/high/max 都在）', ['off', 'low', 'high', 'max'].every((level) => EFFORT_LABELS[level] === host[level]))
  check('多出来的那一档是「默认」（不发思考字段，宿主恒认）', EFFORT_LABELS.default === '默认')
  check('兜底清单也是五档、默认在最前', EFFORT_FALLBACK.length === 5 && EFFORT_FALLBACK[0] === 'default')
}

// ── [6] 徽标 / 读数 / 开关 / 尾注 / 搜索 ──────────────────────────────────────
console.log('[6] 徽标与读数')
{
  check('能收图 → 标「图」', JSON.stringify(modelBadges(choice('a', 'b', { modalities: ['text', 'image'] }))) === JSON.stringify(['图']))
  check('图片 + 视频 → 两个标（顺序固定）', JSON.stringify(modelBadges(choice('a', 'b', { modalities: ['text', 'image', 'video'] }))) === JSON.stringify(['图', '视频']))
  check('纯文本不吃标（那是默认，标出来只添噪音）', modelBadges(choice('a', 'b')).length === 0)
  check('上下文读数：取整到 k', contextLabel(1_000_000) === '1000k' && contextLabel(256_128) === '256k')
  check('读数缺失（0 / 非数）时给空串，不画「0k」', contextLabel(0) === '' && contextLabel(Number.NaN) === '')
  const groups = groupModels([choice('a', 'm'), choice('b', 'n')])
  check('多端点才摆一级（单端点直接列模型）', shouldShowProviderLevel(groups) === true && shouldShowProviderLevel([groups[0]]) === false)
  const current = findCurrent(groups, 'a', 'm')
  check('尾注：当前模型属于这一家时才给模型名', providerHint(groups[0], current) === 'm' && providerHint(groups[1], current) === '')
  check('搜索：空串不筛', filterModels(groups[0].models, '   ').length === 1)
  check('搜索：按名字与完整值都筛得到', filterModels([choice('a', 'glm-5')], 'glm').length === 1 && filterModels([choice('cmd', 'x')], 'cmd/x').length === 1)
}

// ── [7] 飞出卡的挑边与夹高度 ──────────────────────────────────────────────────
console.log('[7] 飞出卡：挑边与夹高度（纯判定，量到的 rect 由界面喂）')
{
  // 挑边：面板右缘对齐模型 chip，两边各剩多少是量出来的；判据用**裁剪容器**（实机是 .thread-main）。
  const roomy = { left: 0, right: 1440 }
  check('右边放得下就走右边（与 ZCode 一致）', chooseFlyoutSide({ left: 400, right: 592 }, roomy, 264) === 'right')
  check('正好放下也算放得下（边界不吃掉一个像素）', chooseFlyoutSide({ left: 400, right: 592 }, { left: 0, right: 592 + 8 + 264 + 6 }, 264) === 'right')
  check('差一像素就翻到左边', chooseFlyoutSide({ left: 400, right: 592 }, { left: 0, right: 592 + 8 + 264 + 5 }, 264) === 'left')
  check('右边挤得只剩一点、左边放得下：翻到左边', chooseFlyoutSide({ left: 400, right: 592 }, { left: 0, right: 700 }, 264) === 'left')
  check(
    '两边都塞不下就盖住一级（硬飞会被裁剪容器裁掉半张卡，模型名读不全）',
    chooseFlyoutSide({ left: 278, right: 470 }, { left: 56, right: 620 }, 264) === 'overlay',
  )
  check(
    '判据是裁剪容器而不是视口：视口放得下、容器放不下时也一样走 overlay',
    chooseFlyoutSide({ left: 278, right: 470 }, { left: 56, right: 620 }, 264) === 'overlay' &&
      chooseFlyoutSide({ left: 278, right: 470 }, { left: 0, right: 1150 }, 264) === 'right',
  )
  check('卡片宽度是唯一那个数（CSS 通过 `--flyout-w` 读它，不许两处各写一份）', FLYOUT_WIDTH === 264 && FLYOUT_MAX_HEIGHT === 288)

  // 夹高度：不许越过面板底边——面板底边只离输入行 10px，越过去就是盖住用户要打字的地方。
  const fits = placeFlyout(40, 72, 300, 200)
  check('卡片比剩下的空间矮：顶端对齐悬浮那一行', fits.top === 40 && fits.maxHeight === 200)
  const tall = placeFlyout(40, 72, 300, 500)
  check('卡片比面板内高还高：压到面板内高，自己滚', tall.maxHeight === 300 - 24 && tall.top === 12)
  const last = placeFlyout(250, 282, 300, 100)
  check('停在最后一行：整体上移，底边与自己那一行对齐', last.top === 182 && last.maxHeight === 100)
  const tiny = placeFlyout(40, 72, 100, 200)
  check('面板本身就矮（端点很少）：上限收到面板内高，位置退到顶边', tiny.maxHeight === 100 - 24 && tiny.top === 12)
  const rows = [
    [12, 44, 300, 288], [40, 72, 220, 180], [150, 182, 240, 96],
    [200, 232, 300, 288], [12, 44, 120, 400], [280, 300, 320, 40],
  ]
  const overflows = rows.filter(([rowTop, rowBottom, panelHeight, cardHeight]) => {
    const placed = placeFlyout(rowTop, rowBottom, panelHeight, cardHeight)
    return placed.top < 12 || placed.top + placed.maxHeight > panelHeight - 12 + 0.001
  })
  check('六组典型位置都夹在面板里（顶不越顶边、底不越底边）', overflows.length === 0, JSON.stringify(overflows))

  // 面板整体横移：窄屏上 chip 落得太靠左时，面板右缘对齐它会整块探到视口外（390px 实测 -78px）。
  check('面板在容器里：不用动', clampShift({ left: 278, right: 470 }, { left: 56, right: 620 }) === 0)
  check('面板探出左边（390px 实测的形状）：往右推到余量线上', clampShift({ left: -78, right: 242 }, { left: 56, right: 390 }) === 56 + 4 + 78)
  check('面板探出右边：往左推', clampShift({ left: 600, right: 920 }, { left: 56, right: 900 }) === -(920 - (900 - 4)))
  check('两边都探出（面板比容器还宽）：先保左边（名字在左边，读数在右边）', clampShift({ left: -50, right: 500 }, { left: 56, right: 300 }) === 110)
}

// ── [8] 界面接线 ──────────────────────────────────────────────────────────────
console.log('[8] 界面接线（ui.tsx）')
{
  const ui = flat(read('ui-shell/src/plugins/composer/ui.tsx'))
  check('两颗 chip 各自带钩子（自检脚本认这两个）', ui.includes('data-composer-model=') && ui.includes('data-composer-effort='))
  check('模型 chip 画「前缀 + 名字」两段（前缀单独成 span，窄屏才收得掉）', ui.includes('className="composer-model-provider"') && ui.includes('{chip.prefix}'))
  check(
    '放不下时把端点前缀**整段**收掉（量到截断就收，不是让两段都截半）',
    ui.includes('const [dropPrefix, setDropPrefix] = useState(false)') &&
      /cut\('\.model-name'\) \|\| cut\('\.composer-model-provider'\)/.test(ui) &&
      ui.includes('{chip.prefix === \'\' || dropPrefix ? null : ('),
  )
  check(
    '量的是完整形态、收掉后不再重量（不会来回抖）；归位那条排在测量那条**前面**（同一拍里互相覆盖过）',
    /if \(dropPrefix\) return/.test(ui) &&
      ui.includes('const chipMeasureKey =') &&
      ui.indexOf('setDropPrefix(false)') < ui.indexOf("cut('.model-name')") &&
      ui.includes('bar.scrollWidth > bar.clientWidth + 1') &&
      ui.includes('new ResizeObserver'),
  )
  check('用 useLayoutEffect（同一帧内先归位再量，不然会先画一帧「两段都截半」）', ui.includes('useLayoutEffect(') && ui.includes('import { useEffect, useLayoutEffect'))
  check('档位 chip 的读数取宿主快照（不靠模型清单，清单过期也不会显示错）', ui.includes('readEffort)') && ui.includes('const effortText = effortLabel(effort)'))
  check('档位 chip 分成「可切」与「单档」两条路（单档不给浮层、不给箭头）', ui.includes('{switchEffort ? (') && ui.includes('className="model-btn composer-effort-chip fixed"'))
  check('当前模型与档位都走纯模块判定（不是就地拍脑袋）', ui.includes('findCurrent(groups, provider, model)') && ui.includes('effortChoices(current.entry)'))
  check('旧口径不许回来：`value === model` 判勾 / 直接用 thinkingLevels / 壳里再抄一份档位表', !ui.includes('=== model') && !ui.includes('.thinkingLevels') && !ui.includes('EFFORT_FALLBACK') && !ui.includes('EFFORT_LABEL'))
  check('旧的分组函数也删干净了（分组归纯模块）', !ui.includes('groupByProvider'))
  check(
    '一级只列端点（多端点才摆），行里是显示名 + 勾 + 固定的 `›`',
    ui.includes('className="model-providers"') &&
      ui.includes('className={`pop-item provider-row${group.provider === hoverProvider ?') &&
      ui.includes('className="provider-arrow"') &&
      ui.includes('data-provider-current={owns ?'),
  )
  check('端点那一行的悬浮说明仍带当前模型名（一级只看得到勾，全称在 title 里）', ui.includes('providerHint(group, current)'))
  check(
    '模型清单在飞出卡里（面板的子节点）、按量出来的位置与上限摆',
    ui.includes('className={`model-flyout${') &&
      ui.includes('data-side={flyoutSide}') &&
      ui.includes("'--flyout-top':") &&
      ui.includes("'--flyout-max':") &&
      ui.includes("'--flyout-w':") &&
      ui.includes('as CSSProperties'),
  )
  check(
    '面板自己带上当前档位（样式据此在「盖住」那一档藏掉端点列）',
    ui.includes('data-flyout-side={flyoutShown ? flyoutSide : undefined}') &&
      ui.includes('const flyoutShown = twoLevel && flyout !== null && hoveredGroup !== undefined') &&
      (ui.match(/flyoutShown \?/g) ?? []).length === 2,
  )
  check(
    '盖住那一档不进绝对定位、也不吃量出来的位置（就地占位，面板按它长高）',
    ui.includes("flyoutSide === 'overlay' ? ' model-flyout-inline' : ''") &&
      /flyoutSide === 'overlay'\s*\n?\s*\? undefined/.test(ui),
  )
  const panel = ui.slice(ui.indexOf('model-pop model-picker'), ui.indexOf('className="model-providers"'))
  check('单端点时不摆一级，面板直接列模型（同一份行渲染，不写两遍）', ui.includes('const modelRowList = (choices: readonly ModelChoiceView[]): ReactNode =>') && (ui.match(/modelRowList\(/g) ?? []).length >= 2)
  check(
    '单端点时面板挂 `.flat`（不挂的话那条宽度规则就是死选择器——实机 390/单端点走查抓到的形态）',
    ui.includes("className={`model-pop model-picker${twoLevel ? '' : ' flat'}`}"),
  )
  check('二级行给当前模型打勾（钩子 `data-model-current`）', ui.includes('data-model-current={on ?'))
  check(
    '勾那一格始终占着（不是当前行才长出来）——不然当前行的读数会被挤左一格，上下对不齐',
    (ui.match(/className="model-picker-check"/g) ?? []).length === 2 &&
      ui.includes('{on ? <IconCheck size={14} className="check" /> : null}') &&
      ui.includes('{owns ? <IconCheck size={13} className="check" /> : null}') &&
      !ui.includes('{on ? <IconCheck size={14} className="check" /> : null}</button>'),
  )
  check('悬浮 / 焦点 / 点击三条路都切端点（触摸屏没有悬浮，只认悬浮等于手机点不开二级）', (ui.match(/openFlyout\(group\.provider, event\.currentTarget\)/g) ?? []).length >= 3)
  check('飞出方向是量出来的（挑边纯函数 + 裁剪容器），不吃 CSS 断点', ui.includes('chooseFlyoutSide(') && ui.includes('clipBoxOf(panel)') && ui.includes('FLYOUT_WIDTH'))
  check(
    '判据取**真会裁它的那个祖先**（`overflow-x` 不是 visible 的盒子），不是视口',
    /const clipBoxOf = \(el: HTMLElement\)[\s\S]{0,400}?getComputedStyle\(node\)\.overflowX !== 'visible'/.test(ui),
  )
  check(
    '面板开着的期间会把自己推回正文列里（窄屏 chip 贴左边时面板整块探出视口）',
    ui.includes('clampShift({ left: box.left, right: box.right }, clipBoxOf(panel))') &&
      ui.includes('translateX(${String(panelShift)}px)') &&
      ui.includes('const [panelShift, setPanelShift] = useState(0)'),
  )
  check('飞出高度是量出来的（夹取纯函数 + 卡片自然高）', /placeFlyout\(\s*rowBox\.top - panelBox\.top/.test(ui) && ui.includes('card.scrollHeight'))
  check('指针离开面板就收起飞出卡（卡片是面板的子节点，所以移进卡片不算离开）', /onMouseLeave=\{\(\) => \{[\s\S]{0,200}?setHoverProvider\(null\)[\s\S]{0,80}?setFlyout\(null\)/.test(ui))
  check('端点列表滚过之后重量一次（卡片还贴着那一行）', ui.includes('onScroll={() =>') && ui.includes("querySelector<HTMLElement>(") && ui.includes('[data-model-provider='))
  check('量完再画：卡片渲染出来之后用 useLayoutEffect 拿自然高修正一次（不然靠近底部的行会盖住输入框）', ui.includes('useLayoutEffect(') && ui.includes('card.scrollHeight') && ui.includes('setFlyout((prev) =>'))
  check('当前模型不在清单里时有一条说明（不是一片「一条都不打勾」）', ui.includes('data-model-unknown="true"') && ui.includes('清单里没有这个模型'))
  check('展开时把当前模型滚进视野（勾在滚动区外等于没打勾）', (ui.match(/scrollIntoView\(\{ block: 'nearest' \}\)/g) ?? []).length >= 1 && ui.includes('[data-model-current="true"]'))
  check('底部「管理模型」跳到设置的模型分区', ui.includes('data-model-manage=') && ui.includes("new CustomEvent('shell.settings.open', { detail: { section: 'models' } })"))
  check('清单每次展开重取（挂载取一次那条旧口径的修法）', /'listModels'\)[\s\S]{0,400}?\}, \[channel, modelOpen\]\)/.test(ui))
  check('每次展开都是干净态（上次悬浮停在哪家不带过来）', /setModelOpen\(\(open\) => !open\)[\s\S]{0,200}?setHoverProvider\(null\)/.test(ui))
  check('省掉头部那行标题（ZCode 没有，它也是白白的高度开销）', !panel.includes('pop-label'), panel.slice(0, 120))
  check('退役类名一个都不许回来（并排两栏那一版）', ['pop-rail', 'pop-models', 'rail-item', 'rail-arrow', 'two-level'].every((name) => !ui.includes(name)))
  check('当前端点来自快照（`status.provider`），壳不猜', ui.includes('function readProvider(') && ui.includes("['provider']"))
  check('四张浮层两两互斥（开一颗收掉其余三颗）', (ui.match(/setEffortOpen\(false\)/g) ?? []).length >= 4 && (ui.match(/setModelOpen\(false\)/g) ?? []).length >= 4)
  check('两颗新图标来自基元库（`@dsc/ui` 整包转出）', ui.includes('IconPackage') && ui.includes('IconBrain') && read('ui-shell/src/plugin-api.ts').includes("export * from '@dsc/ui-primitives'"))
  check('死的 `data-tip` 换成真 `title`（壳里 data-tip 是不渲染的死属性）', !ui.includes('data-tip="模型与思考强度"') && ui.includes('title={`模型：${chip.full}（点开换）`}'))
  const icons = flat(read('ui-shell/src/ui-primitives/icons.tsx'))
  check('两颗图标真定义了（细线风格，currentColor）', icons.includes('export function IconPackage(') && icons.includes('export function IconBrain('))
}

// ── [9] 宿主三处加法 ──────────────────────────────────────────────────────────
console.log('[9] 宿主：端点名与显示名的产地')
{
  const contract = flat(read('src/contract.ts'))
  check('`StatusView.provider` 在契约里（可选：老快照没有它）', /interface StatusView \{[\s\S]*?provider\?: string/.test(contract))
  check('契约里写清了它为什么必须存在（裸名分不清同名模型）', contract.includes('同一个模型 id 可以挂在两个端点下'))
  check('`ModelChoiceView.providerDisplayName` 是必填（一级菜单的行标题）', /interface ModelChoiceView \{[\s\S]*?providerDisplayName: string/.test(contract))
  check('transcript 把端点名放进快照', flat(read('src/plugins/transcript.ts')).includes('provider: ctx.llm.provider'))
  const llm = flat(read('src/plugins/llm.ts'))
  check('listModels 供上显示名，空串回落端点名', llm.includes("providerDisplayName: provider.displayName === '' ? provider.name : provider.displayName"))
  check('界面通道白名单没被顺手动过（没加新方法）', flat(read('src/core/ui-methods.ts')).includes("listModels: [],"))
}

// ── [10] 样式门 ───────────────────────────────────────────────────────────────
console.log('[10] 样式门：新类名有规则、只用令牌、退役的那两版都不许留')
{
  const shellCss = flat(read('ui-shell/src/styles.css'))
  const viewsCss = flat(read('ui-shell/src/legacy/views.css'))
  const NEW_CLASSES = ['composer-model-chip', 'composer-model-provider', 'composer-effort-chip', 'model-picker', 'model-picker-body', 'model-providers', 'provider-row', 'provider-arrow', 'model-flyout', 'model-flyout-card', 'model-picker-rows', 'model-picker-row', 'model-picker-check', 'model-manage', 'model-unknown']
  const missing = NEW_CLASSES.filter((name) => !new RegExp(`\\.${name}[\\s,{:.]`).test(shellCss))
  check('十五个新类名都在壳的 styles.css 里定义过', missing.length === 0, missing.join('、'))
  // 「在 styles.css 里有规则」不足以证明这个名字是新的——上一版 `.model-rows` / `.model-row`
  // 撞上了设置页模型卡的同名类（`legacy/views.css:6622` 的竖排卡片），我的模型行**静静继承**
  // 了 `flex-direction: column`：静态扫描全绿，实机走查一截图就是四行竖排（截图抓到的那条）。
  const otherShellFiles = (() => {
    const out = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && !/\/composer$/.test(dir)) walk(full)
          continue
        }
        if (/\.(ts|tsx)$/.test(entry.name) && !full.includes('/plugins/composer/')) out.push(full)
      }
      return out
    }
    return walk(`${root}/ui-shell/src`)
  })()
  const legacyCss = ['legacy/views.css', 'legacy/tokens.css', 'legacy/base.css', 'legacy/primitives.css']
    .map((file) => flat(read(`ui-shell/src/${file}`)))
    .join('\n')
  const collided = NEW_CLASSES.filter((name) => {
    if (new RegExp(`\\.${name}[\\s,{:]`).test(legacyCss)) return true
    return otherShellFiles.some((file) => flat(read(file.replace(root, ''))).includes(name))
  })
  check('新类名没有一个是别处已经在用的（撞名 = 我的行静默继承别人的版式）', collided.length === 0, collided.join('、'))
  // 「规则在、对象不在」= 白写一条：这一版真的踩过（`.flat` 定义了但 JSX 一直没挂上，
  // 单端点面板就一直是 192px、模型名被截）。每个类名（含修饰类）都必须在 ui.tsx 里当类名用。
  const uiSource = flat(read('ui-shell/src/plugins/composer/ui.tsx'))
  const USED_CLASSES = ['model-picker', 'model-picker-body', 'model-providers', 'provider-row', 'provider-arrow', 'model-flyout', 'model-flyout-card', 'model-flyout-inline', 'model-picker-rows', 'model-picker-row', 'model-picker-check', 'model-manage', 'model-unknown', 'flat']
  const unused = USED_CLASSES.filter((name) => !new RegExp(`['"\` {}$]${name}['"\` {}$]`).test(uiSource))
  check('这一版的每个类名／修饰类都有对象（死选择器门）', unused.length === 0, unused.join('、'))
  const RETIRED_CLASSES = ['pop-rail', 'pop-models', 'rail-item', 'rail-arrow']
  const leftover = RETIRED_CLASSES.filter((name) => new RegExp(`\\.${name}[\\s,{:]`).test(shellCss) || new RegExp(`\\.${name}[\\s,{:]`).test(viewsCss))
  check('退役的并排两栏那四个类名不许留死规则', leftover.length === 0, leftover.join('、'))
  check(
    '新类名不叫 `.model-chip`（那是模型设置页上一版退役的类名，设置页的探针有一条闸不许它回来）',
    !/\.model-chip[ ,{]/.test(shellCss) && !read('ui-shell/src/plugins/composer/ui.tsx').includes('"model-chip'),
  )

  /** 规则块里带硬编码色值的那些（`#rgb` / `#rrggbb` / `rgb(` / `rgba(`）——配色一律走令牌。 */
  const hardcodedColors = (css, classNames) => {
    const hits = []
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (match[1] ?? '').trim().split('\n').pop()?.trim() ?? ''
      if (selector.startsWith('@')) continue
      if (!classNames.some((name) => selector.includes(`.${name}`))) continue
      const body = match[2] ?? ''
      if (/(#[0-9a-fA-F]{3,8}\b|rgba?\()/.test(body)) hits.push(`${selector} { ${body.trim()} }`)
    }
    return hits
  }
  const painted = hardcodedColors(shellCss, NEW_CLASSES)
  check('新类名一个硬编码色值都没有', painted.length === 0, painted.join(' | '))

  const allCss = ['styles.css', 'legacy/tokens.css', 'legacy/base.css', 'legacy/primitives.css', 'legacy/views.css']
    .map((file) => read(`ui-shell/src/${file}`))
    .join('\n')
  const slice = shellCss.slice(shellCss.indexOf('.model-btn.composer-model-chip'), shellCss.indexOf('.model-manage:hover'))
  const ghost = [...slice.matchAll(/var\((--dsc-[a-z0-9-]+)/g)]
    .map((match) => match[1])
    .filter((token, index, all) => all.indexOf(token) === index)
    .filter((token) => !allCss.includes(`${token}:`))
  check('新样式里没有幽灵令牌（每个 var 都在令牌表里定义过）', ghost.length === 0, ghost.join('、'))

  /** 「规则打在某个类名上」——死选择器门用它（规则在、对象不在 = 白写一条）。 */
  const hasRule = (css, selector) => new RegExp(`(^|\\n)${selector.replace(/[.\\[\]()]/g, '\\$&')}[\\s,{]`).test(css)
  check('旧的一排档位按钮（`.effort-row` / `.effort-btn`）两条规则都删干净了', !hasRule(viewsCss, '.effort-row') && !hasRule(viewsCss, '.effort-btn') && !hasRule(shellCss, '.effort-btn'))
  check('删掉的地方留了字（不是无声消失，下一个读代码的人知道档位搬哪去了）', viewsCss.includes('档位现在是输入区**另一颗 chip**'))
  check('模型 chip 有宽度上限（960px 最小窗口下右组要放得下两颗）', /\.model-btn\.composer-model-chip \{[^}]*max-width: 224px;/.test(shellCss))
  check('右组可收缩（挤不下时截字，不是顶出正文列）', /\.bar-left,\s*\n\.bar-right \{[^}]*min-width: 0;/.test(shellCss))
  check(
    '端点前缀不参与收缩（要收就整段收掉，不留半截「Dee…」——实机走查抓到的形态）',
    /\.composer-model-provider \{[^}]*flex: none;/.test(shellCss) && !/\.composer-model-provider \{[^}]*text-overflow: ellipsis;/.test(shellCss),
  )
  check('档位 chip 不参与收缩（收了就什么都看不见了）', /\.composer-effort-chip \{\s*\n\s*flex: none;/.test(shellCss))
  check(
    '一级只占 192px（ZCode 一级是 `min-w-48`；上一版 520px 就是用户报的「太大」）',
    /\.model-pop\.model-picker \{\s*\n\s*width: 192px;/.test(shellCss) && !shellCss.includes('min(520px'),
  )
  check('单端点扁铺时按模型行给宽度（名字 + 徽标 + 读数 + 勾）', /\.model-pop\.model-picker\.flat \{[^}]*min\(264px, calc\(100vw - 24px\)\)/.test(shellCss))
  check(
    '飞出卡尺寸只读变量（挑边与夹高度的结果，别在样式里再写一份数）',
    /\.model-flyout-card \{[\s\S]*?max-height: var\(--flyout-max, 288px\);[\s\S]*?width: var\(--flyout-w, 264px\);/.test(shellCss) &&
      /\.model-flyout \{[^}]*top: var\(--flyout-top, 12px\);/.test(shellCss),
  )
  check('飞出卡两侧都有一条摆法（右边放不下就翻左边）', /\[data-side='right'\] \{\s*\n\s*left: 100%;/.test(shellCss) && /\[data-side='left'\] \{[^}]*right: 100%;/.test(shellCss))
  check(
    '第三档：两边都塞不下时盖住一级——就地占位（不绝对定位），卡片边与投影都收掉',
    /\.model-flyout-inline \{[\s\S]{0,80}?position: static;/.test(shellCss) &&
      /\.model-flyout-inline \.model-flyout-card \{[\s\S]{0,220}?border: none;/.test(shellCss),
  )
  check(
    '盖住那一档把端点列藏掉（卡片是透明的，不藏就两列字叠一起）',
    /\.model-picker\[data-flyout-side='overlay'\] \.model-providers \{\s*\n\s*display: none;/.test(shellCss),
  )
  check(
    '与面板之间那 6px 缝算在卡片的盒子里（鼠标横穿过去不能触发面板的 mouseleave，否则卡片会闪）',
    /\.model-flyout \{[^}]*padding-left: 6px;/.test(shellCss),
  )
  check('一级列表能自己滚（端点一多不至于把面板撑到视口外）', /\.model-providers \{[^}]*max-height: 336px;[\s\S]*?overflow-y: auto;/.test(shellCss))
  check('窄屏收掉端点前缀（390px 里两段字轮流被截，两段都读不全）', /@media \(max-width: 560px\) \{[\s\S]*?\.composer-model-provider \{\s*\n\s*display: none;/.test(shellCss))
  check(
    '手机那一档面板放宽（192px 里模型名只剩半截）',
    /@media \(max-width: 560px\) \{[\s\S]*?\.model-pop\.model-picker \{\s*\n\s*width: min\(320px, calc\(100vw - 24px\)\);/.test(shellCss) &&
      /@media \(max-width: 560px\) \{[\s\S]*?\.composer-model-provider \{\s*\n\s*display: none;/.test(shellCss),
  )
}

// ── [11] 负向自证 ─────────────────────────────────────────────────────────────
console.log('[11] 负向自证：这些扫描器不是空转的')
{
  const shellCss = flat(read('ui-shell/src/styles.css'))
  const hardcodedColors = (css, classNames) => {
    const hits = []
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (match[1] ?? '').trim().split('\n').pop()?.trim() ?? ''
      if (selector.startsWith('@')) continue
      if (!classNames.some((name) => selector.includes(`.${name}`))) continue
      const body = match[2] ?? ''
      if (/(#[0-9a-fA-F]{3,8}\b|rgba?\()/.test(body)) hits.push(selector)
    }
    return hits
  }
  check('负向：假 CSS 里的硬编码色会被抓到', hardcodedColors('.composer-model-chip { color: #ff0000; }', ['composer-model-chip']).length === 1)
  check('负向：这套色值扫描器在真 CSS 上的确什么也没抓到（不是恒真/恒假）', hardcodedColors(shellCss, ['composer-model-chip']).length === 0)

  const fakeUi = flat('const effortLevels = current.thinkingLevels\nclassName={`pop-item${choice.value === model ?')
  check('负向：把旧口径（`value === model` / 直接用 thinkingLevels）塞回假源码会被抓到', fakeUi.includes('=== model') && fakeUi.includes('.thinkingLevels'))
  check('负向：档位清单漏「默认」的实现会被纯逻辑挡下', JSON.stringify(effortChoices(choice('a', 'b', { levels: ['off', 'low'] }))) !== JSON.stringify(['off', 'low']))

  const hasRule = (css, selector) => new RegExp(`(^|\\n)${selector.replace(/[.\\[\]()]/g, '\\$&')}[\\s,{]`).test(css)
  check('负向：`\\n.effort-btn {` 这种死规则会被 `hasRule` 抓到', hasRule('\n.effort-btn {\n  padding: 0;\n}', '.effort-btn'))
  check('负向：`hasRule` 不会被「同名类名出现在注释里」骗过（注释里那名没有规则体）', hasRule('/* .effort-btn 删了 */\n', '.effort-btn') === false)

  const ghostScan = (slice, table) =>
    [...slice.matchAll(/var\((--dsc-[a-z0-9-]+)/g)]
      .map((match) => match[1])
      .filter((token, index, all) => all.indexOf(token) === index)
      .filter((token) => !table.includes(`${token}:`))
  check('负向：拼错的令牌会被差集扫出来', ghostScan('.x { color: var(--dsc-text-primry); }', '--dsc-text-primary: #fff;').length === 1)

  // 这一版新增的两条定位判定：改坏了必须报红（不是「不抛错就算过」）。
  const noSide = () => 'right'
  check(
    '负向：不挑边（恒走右边）的实现会被裁剪容器把卡片裁掉半张',
    noSide() === 'right' && chooseFlyoutSide({ left: 400, right: 592 }, { left: 0, right: 700 }, 264) === 'left',
  )
  check(
    '负向：不认「两边都塞不下」（退回挑余量大的一边）的实现会漏掉 overlay 这一档',
    (() => {
      const broken = (panel, bounds) => {
        const roomRight = bounds.right - 8 - panel.right
        const roomLeft = panel.left - bounds.left - 8
        if (roomRight >= 264 + 6) return 'right'
        if (roomLeft >= 264 + 6) return 'left'
        return roomRight >= roomLeft ? 'right' : 'left'
      }
      return broken({ left: 278, right: 470 }, { left: 56, right: 620 }) === 'left' &&
        chooseFlyoutSide({ left: 278, right: 470 }, { left: 56, right: 620 }, 264) === 'overlay'
    })(),
  )
  const noClamp = (rowTop, cardHeight) => ({ top: rowTop, maxHeight: cardHeight })
  const unclamped = noClamp(280, 200)
  const clamped = placeFlyout(280, 312, 300, 200)
  check(
    '负向：不夹高度的实现（顶端对齐那一行）会把卡片推出面板底边，夹过的不会',
    unclamped.top + unclamped.maxHeight > 300 - 12 && clamped.top + clamped.maxHeight <= 300 - 12 + 0.001,
  )
  check(
    '负向：退役类名的死规则门不是恒假（喂一条真规则要能抓到）',
    ['pop-rail', 'rail-item'].every((name) => new RegExp(`\\.${name}[\\s,{:]`).test(`\n.${name} {\n  width: 136px;\n}`)),
  )
}

if (failures === 0) {
  console.log('\n全部通过')
} else {
  console.log(`\n${failures} 项失败`)
}
process.exit(failures === 0 ? 0 : 1)
