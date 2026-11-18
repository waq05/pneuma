/**
 * 技能页「市场」的验收探针（2026-11-17 用户报的三个问题）。
 *
 * 用户报的三件事：
 *   ① 每次点市场 tab、每次换源都要联网等很久（页面卸载丢 state → 每次都抓第一个源；换源必联网；
 *      宿主那边还顶到界面 invoke 的 30 秒超时）；
 *   ② skills.sh 源点开是一张红色错误条（空查询被宿主拒绝），这里应该只剩搜索框 + 中性提示；
 *   ③ 市场 tab 按钮旁的数字没有意义（它是「市场条目数」，跟这个页签没关系）。
 *
 * 修法分两半：界面半（ui-skills 的 ui.tsx）加进程内缓存 + 在途去重 + 预取 + 短查询短路；
 * 宿主半（config-core/market.ts、skills/index.ts）加总预算、失败回退旧磁盘缓存、把关键词
 * 传给搜索型源。这一份把每条修法钉在**源码结构**上：
 *
 * 为什么读源码而不是起界面：一半行为在渲染进程的模块作用域里（纯 Node 起不来），另一半是
 * 「这次到底发不发请求、失败拿什么兜底」的时序，读结构比造一个假 host 通道稳。真正的网络
 * 时序与画面由 `desktop/shots/skills-market-check.ps1` 用本地慢源实拍（首次加载耗时、
 * 二次打开耗时、命中次数、两张截图）。
 *
 * 判据是退出码：全部通过 exit 0，任一失败 exit 1。跑法：
 *   node scripts/ui-skills-market-test.mjs        # 单跑（读工作区）
 *   pnpm run check:ui                             # 按文件名自动收录
 *   node scripts/ui-skills-market-test.mjs --rev HEAD   # 反证：对旧版本跑必须 FAIL
 *
 * `--rev` 只用来证明这条闸不是「永远绿」的摆设：修复前的 ui.tsx / market.ts 一读就应当
 * 报出一串 FAIL。日常门禁与修完后自证都用默认（工作区）模式。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { readPluginSource, resolveUiHalf, root } from './_check-runner.mjs'

let total = 0
let failed = 0

/**
 * 记一条结论。
 * @param name - 断言名（说清「什么行为」）
 * @param ok - 是否成立
 * @param why - 为什么钉：这条挡的是哪一种回归
 */
function check(name, ok, why) {
  total += 1
  if (ok) {
    console.log('  PASS  ' + name)
    return
  }
  failed += 1
  console.log('  FAIL  ' + name)
  console.log('        为什么钉：' + why)
}

// ── 读源码 ───────────────────────────────────────────────────────────────────

/** 界面半的源码目录（`src/packages/ui-skills/ui`）。 */
const uiDir = resolveUiHalf('skills')
/** `--rev <ref>`：把源码换成该版本（git show）来跑，用于反证闸门能报红。 */
const rev = (() => {
  const index = process.argv.indexOf('--rev')
  return index >= 0 ? (process.argv[index + 1] ?? null) : null
})()

/** 读一份源码：默认读工作区，给了 `--rev` 就读那个版本。 */
function readSource(relPath) {
  if (rev !== null) {
    return execFileSync('git', ['show', rev + ':' + relPath], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 32 * 1024 * 1024,
    })
  }
  return readFileSync(join(root, relPath), 'utf8')
}

/** 一份 TS / TSX 源码的语法树。 */
function parseSource(relPath, kind) {
  const source = readSource(relPath)
  return { relPath, source, sf: ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, kind) }
}

/** 界面半入口（`--rev` 模式下也用它当整份插件源码的替身）。 */
const ui = parseSource(uiDir + '/ui.tsx', ts.ScriptKind.TSX)
/** 整份插件源码（含文件名分隔行）：用来判「这几个标识符确实在这个插件里」。 */
const pluginSource = rev === null ? readPluginSource(uiDir) : ui.source
const market = parseSource('src/packages/config-core/market.ts', ts.ScriptKind.TS)
const skillsHost = parseSource('src/packages/skills/index.ts', ts.ScriptKind.TS)

/** 深度优先遍历（含起点自身）。 */
function descendants(node) {
  const out = []
  const visit = (current) => {
    out.push(current)
    ts.forEachChild(current, visit)
  }
  visit(node)
  return out
}

/** 节点源码文本（去多余空白之前的样子，保住字面量原貌）。 */
/** 把源码压成一行，源码级正则好写一点。 */
const norm = (source) => source.replace(/\s+/g, ' ')

/**
 * 简单数值常量求值：只认数字字面量、括号、正负号、四则运算。
 * （`60 * 60 * 1000`、`15_000` 这类写法都能算出真值，不必钉源码里的字面形态。）
 * @returns 数字；算不出给 null
 */
function numberValue(node) {
  if (node === undefined) return null
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ''))
  if (ts.isParenthesizedExpression(node)) return numberValue(node.expression)
  if (ts.isPrefixUnaryExpression(node)) {
    const value = numberValue(node.operand)
    if (value === null) return null
    if (node.operator === ts.SyntaxKind.MinusToken) return -value
    if (node.operator === ts.SyntaxKind.PlusToken) return value
    return null
  }
  if (ts.isBinaryExpression(node)) {
    const left = numberValue(node.left)
    const right = numberValue(node.right)
    if (left === null || right === null) return null
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return left + right
      case ts.SyntaxKind.MinusToken:
        return left - right
      case ts.SyntaxKind.AsteriskToken:
        return left * right
      case ts.SyntaxKind.SlashToken:
        return right === 0 ? null : left / right
      default:
        return null
    }
  }
  return null
}

/** 顶层（模块作用域）的变量声明：`const x = ...` 这一层。 */
function moduleVariables(sf) {
  const out = []
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) out.push(declaration)
  }
  return out
}

/** 按名字找模块级 `const`/`let` 声明。 */
function moduleVariable(sf, name) {
  return moduleVariables(sf).find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name)
}

/** 按名字找函数声明（普通函数，不是箭头）。 */
function functionNamed(sf, name) {
  return descendants(sf).find(
    (node) => ts.isFunctionDeclaration(node) && node.name !== undefined && node.name.text === name,
  )
}

/** 函数（或任意节点）的源码文本。 */
function bodyText(node) {
  return node === undefined ? '' : norm(node.getText())
}

/** 节点里所有「按名字调用的函数调用」（`foo(...)`，不含 `x.foo(...)`）。 */
function callsNamed(node, name) {
  return descendants(node).filter(
    (child) => ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === name,
  )
}

/** 离这个节点最近的函数（箭头 / 函数声明 / 方法），用来判「这段代码在哪个回调里」。 */
function nearestFunction(node) {
  let current = node.parent
  while (current !== undefined) {
    if (ts.isFunctionLike(current)) return current
    current = current.parent
  }
  return undefined
}

/** 这个函数是不是作为参数传给了某个调用（例如 `useEffect(() => {...})`）。 */
function callWrappingFunction(fn) {
  const parent = fn?.parent
  if (parent === undefined || !ts.isCallExpression(parent)) return undefined
  return parent.arguments.includes(fn) ? parent : undefined
}

/**
 * 一个 JSX 元素 / 自闭合元素的静态 `className`。
 * @returns 静态字符串；动态（模板串 / 表达式）给 null
 */
function staticClassName(node) {
  const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined
  if (opening === undefined) return null
  for (const attribute of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attribute)) continue
    const name = ts.isIdentifier(attribute.name) ? attribute.name.text : ''
    if (name !== 'className' || attribute.initializer === undefined) continue
    if (ts.isStringLiteral(attribute.initializer) || ts.isNoSubstitutionTemplateLiteral(attribute.initializer)) {
      return attribute.initializer.text
    }
  }
  return null
}

/** 所有 `className` 正好等于这一串的 JSX 元素。 */
function jsxWithClass(sf, className) {
  return descendants(sf).filter(
    (node) => (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && staticClassName(node) === className,
  )
}

/** 节点里有没有哪个 JSX 元素的 className 含这个记号（`classList` 语义）。 */
function hasClassToken(node, token) {
  return descendants(node).some((child) => {
    if (!ts.isJsxElement(child) && !ts.isJsxSelfClosingElement(child)) return false
    const className = staticClassName(child)
    return className !== null && className.split(/\s+/).includes(token)
  })
}

/** JSX 子树里所有 `<button>` 元素。 */
function buttonsIn(node) {
  return descendants(node).filter(
    (child) => ts.isJsxElement(child) && child.openingElement.tagName.getText(ui.sf) === 'button',
  )
}

/** 某个 JSX 元素外面是不是被 `{条件 && ...}` 包着；返回那个条件节点的源码文本。 */
function guardOf(node) {
  let current = node.parent
  while (current !== undefined) {
    if (ts.isJsxExpression(current)) {
      // `{cond && <div .../>}`：表达式本身就是 `cond && element`
      const expression = current.expression
      if (expression !== undefined && ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        return expression.left.getText(ui.sf)
      }
      return ''
    }
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) return ''
    current = current.parent
  }
  return ''
}

/** 找一个 JSX 元素是哪一段 JSX 表达式里的（用来读它的显示条件）。 */
function expressionWrapping(node) {
  let current = node.parent
  while (current !== undefined) {
    if (ts.isJsxExpression(current)) return current
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) return undefined
    current = current.parent
  }
  return undefined
}

// ── ① 市场 tab 不再有计数徽章，已安装那个还在 ─────────────────────────────────

const tabBar = jsxWithClass(ui.sf, 'skills-tabs')[0]
const tabButtons = tabBar === undefined ? [] : buttonsIn(tabBar)
const tabText = (button) => button.getText(ui.sf)
const installedTab = tabButtons.find((button) => tabText(button).includes("t('tab.installed')"))
const marketTab = tabButtons.find((button) => tabText(button).includes("t('tab.market')"))

check(
  '市场 tab 的按钮 JSX 里没有条目数徽章（.count / items.length 都不在）',
  marketTab !== undefined && !hasClassToken(marketTab, 'count') && !/items\.length/.test(tabText(marketTab)),
  '这个数字是「市场条目数」，与这个页签本身无关；它曾被渲染在按钮上，用户看不懂它代表什么。',
)
check(
  '已安装 tab 的按钮里仍有 .count（只删了市场那个，没连坐）',
  installedTab !== undefined && hasClassToken(installedTab, 'count') && /length/.test(tabText(installedTab)),
  '已安装数量是有意义的读数；如果两个都删了，说明改的是样式类而不是这一个按钮。',
)
const scopeBar = jsxWithClass(ui.sf, 'skills-scope')[0]
check(
  '作用域 chip 的 .count 保留（同一套计数样式没被删掉）',
  scopeBar !== undefined && hasClassToken(scopeBar, 'count'),
  '作用域「全部 / 全局 / 项目」的计数与市场徽章共用 .count；若这里也空了，删掉的是样式而不是那个无意义数字。',
)

// ── ② 进程内缓存 / 在途去重 / 预取 / 跨卸载还原 ──────────────────────────────

for (const identifier of ['marketCache', 'marketInflight', 'marketCacheKey', 'prefetchMarket']) {
  check(
    '插件源码里存在 `' + identifier + '`',
    pluginSource.includes(identifier),
    '这四样是这次修「点一次就联网等很久」的全部零件；少一样都会退回旧行为，先确认它们都在。',
  )
}

const cacheDecl = moduleVariable(ui.sf, 'marketCache')
const inflightDecl = moduleVariable(ui.sf, 'marketInflight')
const isMapConstruction = (declaration) =>
  declaration?.initializer !== undefined &&
  ts.isNewExpression(declaration.initializer) &&
  declaration.initializer.expression.getText(ui.sf) === 'Map'

check(
  '`marketCache` 是模块级 Map（不是组件内 state / ref）',
  cacheDecl !== undefined && isMapConstruction(cacheDecl),
  '根因是离开技能页时组件整个卸载、state 全丢，所以缓存放组件里等于没有；放模块作用域才能跨卸载保留。',
)
check(
  '`marketInflight` 是模块级 Map（在途请求去重表）',
  inflightDecl !== undefined && isMapConstruction(inflightDecl),
  '预取和用户点开市场可能同时发同一个源；不去重就会对同一个源打两次网络。',
)

const cacheKeyFn = functionNamed(ui.sf, 'marketCacheKey')
const cacheKeyText = bodyText(cacheKeyFn)
check(
  '`marketCacheKey(source, needle)` 的键同时由源名与搜索词组成',
  cacheKeyFn !== undefined &&
    cacheKeyFn.parameters.length === 2 &&
    ts.isTemplateExpression(
      (() => {
        const returns = descendants(cacheKeyFn).filter((node) => ts.isReturnStatement(node))
        return returns.length === 1 ? returns[0].expression : undefined
      })(),
    ) === true &&
    /\bsource\b/.test(cacheKeyText) &&
    /\bneedle\b/.test(cacheKeyText),
  '键里不带搜索词，换一个词查询会命中上一个词的结果（同一个源、不同搜索词是两份清单）。',
)

const cacheLimit = moduleVariable(ui.sf, 'MARKET_CACHE_LIMIT')
check(
  '缓存有 24 条上限，超出按最旧淘汰',
  cacheLimit !== undefined &&
    numberValue(cacheLimit.initializer) === 24 &&
    descendants(saveFn()).some(
      (node) =>
        ts.isWhileStatement(node) && /marketCache\.size > MARKET_CACHE_LIMIT/.test(node.expression.getText(ui.sf)),
    ),
  '没有上限的长会话会把每次搜索的市场结果一直攒在内存里；淘汰顺序按 Map 插入序（最旧先踢）。',
)
/** `saveMarketCache` 函数声明。 */
function saveFn() {
  return functionNamed(ui.sf, 'saveMarketCache')
}

const freshConstName = moduleVariables(ui.sf).find(
  (declaration) =>
    ts.isIdentifier(declaration.name) && /FRESH/.test(declaration.name.text) && numberValue(declaration.initializer) === 3_600_000,
)
check(
  '本地缓存有 1 小时新鲜期常量（3600000ms）',
  freshConstName !== undefined,
  '新鲜期内重进市场不该再联网；1h 与宿主磁盘缓存的 TTL 同口径，两层过期才真的等网络。',
)
check(
  '浏览入口按新鲜期判缓存命中（不新鲜才联网）',
  descendants(ui.sf).some(
    (node) =>
      ts.isIfStatement(node) &&
      /Date\.now\(\) - cached\.at </.test(node.expression.getText(ui.sf)) &&
      /FRESH/.test(node.expression.getText(ui.sf)),
  ),
  '常量得真的接进判断；只声明不消费，重进市场照样发请求。',
)

const requestFn = functionNamed(ui.sf, 'requestMarket')
const requestText = bodyText(requestFn)
check(
  '`requestMarket` 同键在途只发一次：先查 marketInflight、命中直接复用，结束后删键',
  requestText.includes('marketInflight.get(key)') &&
    /return running/.test(requestText) &&
    requestText.includes('marketInflight.set(key, task)') &&
    requestText.includes('marketInflight.delete(key)'),
  '预取 + 用户点开 + 后台刷新可能同时要同一份结果；不去重就是 2~3 次网络。',
)
check(
  '成功结果写缓存，且「失败且一条可用结果都没有」的结果不写缓存',
  requestText.includes('saveMarketCache(key, result)') &&
    /error !== undefined && result\.items\.length === 0\) return/.test(bodyText(saveFn())),
  '失败结果若进缓存，接下来一小时每次进市场都只回放那张红条，用户连重试都没得点。',
)
check(
  '缓存为「首个源」的结果顺手写一条真源名别名的缓存',
  /source === '' && result\.source !== ''/.test(requestText),
  '`source === \'\'` 代表「清单里的第一个源」；不给真源名补一条，用户点同名 chip 会把同一份清单再联网抓一遍。',
)

const prefetchFn = functionNamed(ui.sf, 'prefetchMarket')
const prefetchWired = callsNamed(ui.sf, 'prefetchMarket').some((call) => {
  const fn = nearestFunction(call)
  const wrapper = callWrappingFunction(fn)
  return wrapper !== undefined && ts.isIdentifier(wrapper.expression) && wrapper.expression.text === 'useEffect'
})
check(
  '`prefetchMarket` 真的接在 useEffect 里（进页面就温缓存）',
  prefetchFn !== undefined && prefetchWired,
  '预取函数写了但没人调，等于没预取：用户点开市场那一下还是等网络。',
)
check(
  '预取跳过搜索型源（skills.sh 没有榜单，预取必失败）',
  /isSkillsShUrl\(source\.url\)/.test(bodyText(prefetchFn)) && /continue/.test(bodyText(prefetchFn)),
  '对 skills.sh 预取空查询只会换来一次注定失败的请求，还可能白占内存缓存。',
)

const lastViewDecl = moduleVariable(ui.sf, 'lastMarketView')
const restoreDecl = descendants(ui.sf).find(
  (node) =>
    ts.isVariableDeclaration(node) &&
    ts.isArrayBindingPattern(node.name) &&
    ts.isIdentifier(node.name.elements[0]?.name ?? {}) &&
    node.name.elements[0].name.text === 'market' &&
    node.initializer !== undefined &&
    ts.isCallExpression(node.initializer) &&
    ts.isIdentifier(node.initializer.expression) &&
    node.initializer.expression.text === 'useState',
)
check(
  '卸载后靠模块级 `lastMarketView` + 初始化读缓存还原视图',
  lastViewDecl !== undefined &&
    restoreDecl !== undefined &&
    /restoredView/.test(restoreDecl.getText(ui.sf)) &&
    /readMarketCache\(/.test(ui.source),
  '这是「离开技能页再回来秒开」的另一半：缓存有了，初始化还得把 state 从缓存填回去；否则回来仍 market=null，又抓一次。',
)

// ── ③ 搜索型源短查询不请求宿主，只给中性提示 ────────────────────────────────

const minChars = moduleVariable(ui.sf, 'MIN_SEARCH_CHARS')
const uiThreshold = numberValue(minChars?.initializer)
check(
  '界面有短查询门槛 MIN_SEARCH_CHARS = 2',
  uiThreshold === 2,
  '宿主对 skills.sh 的空查询直接抛错（见 browseSkillsSh）；界面低于这个门槛就不能发请求。',
)
const hostThreshold = (() => {
  const fn = functionNamed(market.sf, 'browseSkillsSh')
  const match = bodyText(fn).match(/needle\.length < (\d+)/)
  return match === null ? null : Number(match[1])
})()
check(
  '界面门槛与宿主门槛同口径（都要求 ≥2 个字符）',
  uiThreshold !== null && hostThreshold === uiThreshold,
  '一边放行一边报错，用户就会看到「只提供搜索」的红条；两个门槛必须一起改。',
)

const shortIfs = descendants(ui.sf).filter(
  (node) => ts.isIfStatement(node) && /needle\.length < MIN_SEARCH_CHARS/.test(node.expression.getText(ui.sf)),
)
check(
  '找到短查询短路分支（searchable && needle.length < MIN_SEARCH_CHARS）',
  shortIfs.length >= 1,
  '这条分支是「没输入够就不发请求」的唯一落点；找不到说明短路被删了。',
)
check(
  '短查询分支里不发市场请求、不置红条错误',
  shortIfs.length > 0 &&
    shortIfs.every((node) => {
      const text = bodyText(node)
      const calls = callsNamed(node, 'setMarketError')
      // 短查询只许「清空错误」（setMarketError('')），不许写进任何错误文案
      const onlyClears = calls.every((call) => {
        const first = call.arguments[0]
        return first !== undefined && ts.isStringLiteral(first) && first.text === ''
      })
      return !/requestMarket\(/.test(text) && !text.includes("'browseMarket'") && !/\bbrowse\(/.test(text) && onlyClears
    }),
  '短查询走网络只会换来一张「只提供搜索」红条；用户还没输完就报错是噪音，这里必须只清状态、不发请求。',
)

const debounceEffects = descendants(ui.sf).filter((node) => {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'useEffect') return false
  const text = norm(node.getText(ui.sf))
  return text.includes('setTimeout') && /\bbrowse\(/.test(text)
})
check(
  '搜索输入防抖：请求只从 setTimeout 里发，卸载/改词时有 clearTimeout 清理',
  debounceEffects.length === 1 &&
    callsNamed(debounceEffects[0], 'browse').every((call) => {
      const wrapper = callWrappingFunction(nearestFunction(call))
      return (
        wrapper !== undefined && ts.isIdentifier(wrapper.expression) && wrapper.expression.text === 'setTimeout'
      )
    }) &&
    callsNamed(debounceEffects[0], 'clearTimeout').length > 0,
  'onChange 直接查 = 一个按键一次网络，敲 10 个字就是 10 次请求；防抖 + 清理才能既省请求又不把旧词的结果盖上去。',
)
check(
  '防抖 effect 的依赖里有搜索词（输入变化才进 effect）',
  debounceEffects.length === 1 &&
    descendants(debounceEffects[0]).some(
      (node) =>
        ts.isArrayLiteralExpression(node) &&
        node.elements.some((element) => ts.isIdentifier(element) && element.text === 'query'),
    ),
  '依赖里没有 query，输入变化根本不会触发这个 effect，防抖等于没有。',
)

const selectSourceFn = functionNamed(ui.sf, 'selectSource')
const searchSourceIf = descendants(selectSourceFn ?? ui.sf).find(
  (node) => ts.isIfStatement(node) && /isSearchSource\(name\)/.test(node.expression.getText(ui.sf)),
)
const searchSourceIfText = bodyText(searchSourceIf)
const searchSourceBrowseCalls = searchSourceIf === undefined ? [] : callsNamed(searchSourceIf, 'browse')
check(
  '点 skills.sh 源不自动发请求；只在关键词已够长时才查，并把光标放进搜索框',
  searchSourceIf !== undefined &&
    /searchRef\.current\?\.focus\(\)/.test(searchSourceIfText) &&
    searchSourceBrowseCalls.every((call) => {
      let current = call.parent
      while (current !== undefined && current !== searchSourceIf) {
        if (ts.isIfStatement(current) && /MIN_SEARCH_CHARS/.test(current.expression.getText(ui.sf))) return true
        current = current.parent
      }
      return false
    }),
  '点开源本身发请求（空查询）就是那张红条的来源；skills.sh 只能等用户输入，所以点源只该聚焦输入框。',
)

const hintElements = jsxWithClass(ui.sf, 'market-hint')
check(
  '市场区有中性提示 .market-hint，且由「关键词太短」条件驱动',
  hintElements.length === 1 && /searchTooShort/.test(guardOf(hintElements[0])),
  'skills.sh 不是坏源，它只是还没输入；中性一行字才符合「等待输入」，不是「出错了」。',
)
check(
  '搜索型源的短查询状态由 searchTooShort 统一推导（不自造错误文案）',
  descendants(ui.sf).some(
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'searchTooShort' &&
      /MIN_SEARCH_CHARS/.test(node.initializer?.getText(ui.sf) ?? ''),
  ),
  '提示、刷新按钮禁用、空态三处都该看同一个判据；各处各写一遍迟早出现「提示说没输入、列表却在报错」。',
)

const errorBars = descendants(ui.sf).filter(
  (node) =>
    (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) &&
    (staticClassName(node) ?? '').split(/\s+/).includes('settings-note') &&
    (staticClassName(node) ?? '').split(/\s+/).includes('error'),
)
check(
  '市场区的红条只由 marketError 驱动，短查询不会点亮它',
  errorBars.some((bar) => /marketError/.test(guardOf(bar))) &&
    errorBars.every((bar) => !/searchTooShort/.test(guardOf(bar))),
  '红条是「一条可用结果都没有」的硬错误；短查询把它点亮，用户会以为这个源坏了。',
)

const placeholderAttr = descendants(ui.sf).find(
  (node) => ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'placeholder' && /search\.skillsSh/.test(node.getText(ui.sf)),
)
check(
  '搜索框对 skills.sh 有专门占位提示（输入框保留且提示「至少 2 个字符」）',
  placeholderAttr !== undefined,
  'skills.sh 唯一的取词入口就是这个输入框；占位提示不跟着换，用户根本不知道该在这里打字。',
)

// ── ④ 宿主：总预算 / 旧缓存回退 / 关键词真的传下去 ───────────────────────────

const budgetConst = moduleVariable(market.sf, 'BROWSE_BUDGET_MS')
const budgetValue = numberValue(budgetConst?.initializer)
const invokeTimeout = (() => {
  try {
    const host = parseSource('src/packages/ui-runtime/ui/host-channel.ts', ts.ScriptKind.TS)
    const declaration = moduleVariable(host.sf, 'DEFAULT_INVOKE_TIMEOUT_MS')
    return numberValue(declaration?.initializer)
  } catch {
    return null
  }
})()
check(
  '宿主有浏览总预算 BROWSE_BUDGET_MS，且严格小于界面 invoke 超时（30s）',
  budgetValue !== null && budgetValue > 0 && invokeTimeout !== null && budgetValue < invokeTimeout,
  '预算必须低于界面一次 invoke 的超时，否则超时先到、预算没机会生效，用户看到的还是 aborted 红条。',
)

const budgetConsumed = /Date\.now\(\) \+ \(options\.budgetMs \?\? BROWSE_BUDGET_MS\)/.test(norm(market.source))
check(
  '总预算真的接进浏览入口（算出一个 deadlineAt）',
  budgetConsumed,
  '常量声明了不消费等于没修；预算是从入口算截止时间、各阶段只许用剩下的时间。',
)
const budgetUses = (market.source.match(/budgetedTimeout\(deadlineAt\)/g) ?? []).length
check(
  '每一跳联网都按剩余预算收紧（budgetedTimeout(deadlineAt) 至少 4 处）',
  budgetUses >= 4,
  '预算只挂在入口没用：trees 等满 15 秒 + 补描述 6 秒叠起来还是会把界面拖到超时。',
)

const browseSourceFn = functionNamed(market.sf, 'browseMarketSource')
const browseText = bodyText(browseSourceFn)
check(
  'browseMarketSource 联网失败时回退旧磁盘缓存，没有旧缓存才把错误抛出去',
  /catch \(error\)[\s\S]*?return cached\.entries/.test(browseText) && /throw error/.test(browseText),
  '联网失败 ≠ 市场没内容；旧清单能看能装，比一张红条有用。完全没有缓存才该报错，不能拿空数组冒充成功。',
)
check(
  'TTL 只决定「要不要联网」，不卡旧缓存回退（读缓存那层不看 TTL）',
  !/CACHE_TTL_MS/.test(bodyText(functionNamed(market.sf, 'readMarketCache'))) &&
    /Date\.now\(\) - cached\.at < CACHE_TTL_MS/.test(browseText) &&
    /return cached\.entries/.test(browseText),
  '若回退路径也判 TTL，那「失败交旧清单」只在 1 小时内有效，过期后照样红条——这正是用户报的「等很久还失败」。',
)
check(
  '搜索型源的磁盘缓存键带上关键词（换词不串用上一次的结果）',
  norm(market.source).includes('cachePath(searchDriven ? `${source.url}\\u0000${needle}` : source.url)'),
  'skills.sh 的条目由关键词决定；缓存键只有 URL 时，换一个词查到的还是上一个词的结果。',
)

const browseRemoteCall = /browseRemote\(target\.source, refreshEntries === true, needle\)/.test(norm(skillsHost.source))
check(
  'skills/index.ts 调 browseRemote 时把搜索词作为第三个参数传下去',
  browseRemoteCall,
  '不传词，宿主就拿空查询去查 skills.sh，必抛「只提供搜索」——这就是「点开是红条」的直接根因之一。',
)
const browseRemoteFn = functionNamed(skillsHost.sf, 'browseRemote')
const browseRemoteText = bodyText(browseRemoteFn)
check(
  '宿主 browseRemote 第三参数是 query，并把它交给 browseMarketSource',
  browseRemoteFn !== undefined &&
    browseRemoteFn.parameters.length >= 3 &&
    /query/.test(browseRemoteFn.parameters[2].getText(skillsHost.sf)) &&
    /browseMarketSource\(source, \{ refresh: force, query/.test(browseRemoteText),
  '关键词得一路传到抓取层；中间任何一层吞掉它，skills.sh 都查不到东西。',
)
const cacheReadAt = browseRemoteText.indexOf('entriesCache.get(key)')
const networkAt = browseRemoteText.indexOf('browseMarketSource(')
check(
  '宿主内存缓存命中直接返回（离开技能页再进来秒开的根本）',
  cacheReadAt >= 0 && networkAt > cacheReadAt && /return \{ entries: cached\.entries/.test(browseRemoteText),
  '缓存路径必须排在联网之前，且命中时一次网络都不碰；删掉它，界面缓存再快也得先等一次宿主往返。',
)
check(
  '宿主兜第三层：连磁盘缓存都没了，内存旧列表也不被一次失败清掉',
  /catch \(error\)[\s\S]*?cached !== undefined[\s\S]*?return \{ entries: cached\.entries/.test(browseRemoteText) &&
    /throw error/.test(browseRemoteText),
  '用户清过 ~/.dsc/cache 之后磁盘缓存为空；此时内存里那份旧列表是最后一层兜底，不能被一次失败清掉。',
)

// ── ⑤ 契约未动 + 中性提示有样式 ─────────────────────────────────────────────

/** 跑一条 git 命令，返回 { code, stdout, stderr }（不抛）。 */
function git(...args) {
  try {
    const stdout = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      code: typeof error.status === 'number' ? error.status : -1,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: String(error.stderr ?? error.message ?? error),
    }
  }
}
const contractStatus = git('status', '--porcelain', '--', 'src/contract')
/**
 * 2026-11-17：这条原来钉「契约 src/contract/** 与 HEAD 完全一致」——那是技能市场修复那一次的
 * 自约束（修界面与宿主内部行为，不该顺手改契约）。但契约改动本身是允许的：本分支
 * `feat/agent-team-collab` 按设计给 SettingsField 加了 `checks` 控件、给任务板视图加了
 * 进展/活动投影字段。把断言改成「契约改动只能落在已声明的两个文件」，既保留防越界的作用，
 * 又不会在多任务分支上误伤；合入后工作区干净、差集为空，同样通过。
 */
const CONTRACT_CHANGE_ALLOWED = new Set([
  'src/contract/settings.ts', // checks 控件：SettingsValue 加 string[]、SettingsField 加 checks 分支
  'src/contract/plugin.ts', // 任务板：TeamTaskView 进展字段、TeamBoardView.activity、TeammateView.taskId
  // 每轮缓存明细（P2b）：TurnUsageView 给 text/tool 条目的 usage 加 cacheHitTokens /
  // cacheMissTokens 两个可选字段，只是加法，不动已有字段与口径。
  'src/contract/transcript.ts',
])
const contractChangedFiles = contractStatus.stdout
  .split(/\r?\n/)
  // 只去尾部空白：`git status --porcelain` 的 XY 两列在行首，trim() 会把列位置吃错
  .map((line) => line.replace(/\s+$/, ''))
  .filter((line) => line !== '')
  .map((line) => {
    // `git status --porcelain` 一行的格式：XY <path>（重命名还有 ` -> `）
    const path = line.slice(3).trim()
    const arrow = path.indexOf(' -> ')
    return arrow < 0 ? path : path.slice(arrow + 4)
  })
const contractOutOfScope = contractChangedFiles.filter((file) => !CONTRACT_CHANGE_ALLOWED.has(file))
check(
  '契约改动只落在已声明的文件里（settings.ts 的 checks 控件、plugin.ts 的任务板投影、transcript.ts 的每轮缓存明细；其余契约文件不动）',
  contractOutOfScope.length === 0,
  `越界的契约改动：${contractOutOfScope.join('、') || '（无）'}。本分支只允许 CONTRACT_CHANGE_ALLOWED 里登记的文件做增量改动，其它 src/contract/** 文件不许动。`,
)

const cssPath = 'src/packages/ui-renderer/ui/styles/legacy/views.css'
let cssSource = ''
try {
  cssSource = readSource(cssPath)
} catch {
  cssSource = ''
}
check(
  '中性提示 .market-hint 有样式规则（与正文/红条在视觉上区分开）',
  /\.market-hint\s*\{/.test(cssSource),
  '只有类名没有样式，「中性提示」就和正文一个样；用户分不清这是提示还是内容。',
)

// ── 汇总 ─────────────────────────────────────────────────────────────────────
console.log('')
console.log('技能市场修复探针：' + String(total - failed) + '/' + String(total) + ' 项通过')
if (failed > 0) {
  console.log(String(failed) + ' 项失败')
  process.exit(1)
}
console.log('全部通过')
process.exit(0)
