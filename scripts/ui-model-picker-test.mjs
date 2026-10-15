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
 * 十组断言：
 *
 *   [1] 纯逻辑（`plugins/composer/model-picker.ts`，零运行时依赖，Node 类型擦除直读）
 *   [2] 分组与端点显示名
 *   [3] 当前模型的精确定位（含「同一个 id 挂两个端点」）
 *   [4] chip 文案（单端点不带前缀、查不到时原样显示）
 *   [5] 档位清单恒含「默认」+ 文案与宿主表同值（真读 `src/core/model-caps.ts`）
 *   [6] 徽标 / 上下文读数 / 一级开关 / 尾注 / 搜索
 *   [7] 界面接线（读 `ui.tsx`）：两颗 chip、两级菜单、管理模型入口、展开重取清单
 *   [8] 宿主三处加法（`status.provider` + `providerDisplayName` 的产地）
 *   [9] 样式门：新类名有规则、只用令牌、旧的一排档位按钮那两条不许留（死选择器）
 *   [10] 负向自证：把上面每套扫描器喂一段**坏**输入，必须报红
 *
 * 运行：node scripts/ui-model-picker-test.mjs（读源码，不需要先编译）
 *
 * @module dsc/scripts/ui-model-picker-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const picker = await import(
  new URL('../ui-shell/src/plugins/composer/model-picker.ts', import.meta.url).href
)
const {
  EFFORT_FALLBACK,
  EFFORT_LABELS,
  contextLabel,
  effortChoices,
  effortLabel,
  effortSwitchable,
  filterModels,
  findCurrent,
  groupModels,
  modelBadges,
  modelChipText,
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

// ── [7] 界面接线 ──────────────────────────────────────────────────────────────
console.log('[7] 界面接线（ui.tsx）')
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
  check('两级菜单：左栏端点 + 右栏模型，且只有多端点时才摆左栏', ui.includes('className={`model-picker-body${twoLevel ?') && ui.includes('className="pop-rail"') && ui.includes('className="pop-models"'))
  check('一级行给当前端点打勾 + 尾注当前模型名', ui.includes('data-provider-current={owns ?') && ui.includes('providerHint(group, current)'))
  check('二级行给当前模型打勾（钩子 `data-model-current`）', ui.includes('data-model-current={on ?'))
  check('当前模型不在清单里时有一条说明（不是一片「一条都不打勾」）', ui.includes('data-model-unknown="true"') && ui.includes('清单里没有这个模型'))
  check('展开时把当前项滚进视野（勾在屏幕外等于没打勾）', (ui.match(/scrollIntoView\(\{ block: 'nearest' \}\)/g) ?? []).length >= 2)
  check('底部「管理模型」跳到设置的模型分区', ui.includes('data-model-manage=') && ui.includes("new CustomEvent('shell.settings.open', { detail: { section: 'models' } })"))
  check('清单每次展开重取（挂载取一次那条旧口径的修法）', /'listModels'\)[\s\S]{0,400}?\}, \[channel, modelOpen\]\)/.test(ui))
  check('当前端点来自快照（`status.provider`），壳不猜', ui.includes('function readProvider(') && ui.includes("['provider']"))
  check('四张浮层两两互斥（开一颗收掉其余三颗）', (ui.match(/setEffortOpen\(false\)/g) ?? []).length >= 4 && (ui.match(/setModelOpen\(false\)/g) ?? []).length >= 4)
  check('两颗新图标来自基元库（`@dsc/ui` 整包转出）', ui.includes('IconPackage') && ui.includes('IconBrain') && read('ui-shell/src/plugin-api.ts').includes("export * from '@dsc/ui-primitives'"))
  check('死的 `data-tip` 换成真 `title`（壳里 data-tip 是不渲染的死属性）', !ui.includes('data-tip="模型与思考强度"') && ui.includes('title={`模型：${chip.full}（点开换）`}'))
  const icons = flat(read('ui-shell/src/ui-primitives/icons.tsx'))
  check('两颗图标真定义了（细线风格，currentColor）', icons.includes('export function IconPackage(') && icons.includes('export function IconBrain('))
}

// ── [8] 宿主三处加法 ──────────────────────────────────────────────────────────
console.log('[8] 宿主：端点名与显示名的产地')
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

// ── [9] 样式门 ────────────────────────────────────────────────────────────────
console.log('[9] 样式门：新类名有规则、只用令牌、旧的一排按钮那两条不许留')
{
  const shellCss = flat(read('ui-shell/src/styles.css'))
  const viewsCss = flat(read('ui-shell/src/legacy/views.css'))
  const NEW_CLASSES = ['composer-model-chip', 'composer-model-provider', 'composer-effort-chip', 'model-picker', 'model-picker-body', 'pop-rail', 'pop-models', 'rail-item', 'model-manage', 'model-unknown']
  const missing = NEW_CLASSES.filter((name) => !new RegExp(`\\.${name}[\\s,{:.]`).test(shellCss))
  check('十个新类名都在壳的 styles.css 里定义过', missing.length === 0, missing.join('、'))
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
  check('浮层宽度收在视口里（手机上不探出去）', /\.model-pop\.model-picker \{[^}]*min\(520px, calc\(100vw - 32px\)\)/.test(shellCss))
  check('窄屏收掉端点前缀（390px 里两段字轮流被截，两段都读不全）', /@media \(max-width: 560px\) \{[\s\S]*?\.composer-model-provider \{\s*\n\s*display: none;/.test(shellCss))
}

// ── [10] 负向自证 ─────────────────────────────────────────────────────────────
console.log('[10] 负向自证：这些扫描器不是空转的')
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
}

if (failures === 0) {
  console.log('\n全部通过')
} else {
  console.log(`\n${failures} 项失败`)
}
process.exit(failures === 0 ? 0 : 1)
