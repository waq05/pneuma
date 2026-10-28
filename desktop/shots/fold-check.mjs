/**
 * 「整轮过程折叠 + 脚注合并 + 过程折叠程度」的只读探针。
 *
 * 为什么要有它：这四件事的行为一半在构建产物里（选择器、类名、设置项、宿主白名单），
 * 肉眼只能看见其中一屏。这个脚本把「产物里必须出现什么、必须不再出现什么」写成断言，
 * 构建完跑一次就能回答「四项改动是不是真的进了包」——包括桌面端吃的那份 lib/contract.d.ts。
 *
 * 只读：全程 readFileSync + readdirSync，不写任何文件、不碰 ~/.dsc、不启动 Electron。
 * 断言分四组，与需求里那四件事一一对应，另加一组「旧结构必须退场」。
 *
 * 用法（在仓库根目录 build 过之后）：
 *   node desktop/shots/fold-check.mjs
 * 退出码：0 = 全部通过；1 = 有断言没过（逐条打印失败原因与实测片段）。
 *
 * @module desktop/shots/fold-check
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(here, '..')
const rootDir = join(desktopDir, '..')

/** 取某个目录下扩展名匹配的第一个文件（打包产物带内容哈希，文件名不该写死）。 */
/** 取某个目录下扩展名匹配的**全部**文件（产物带内容哈希不能写死文件名；分包也不能只看一个）。 */
function allFiles(dir, ext) {
  const names = readdirSync(dir).filter((name) => name.endsWith(ext))
  if (names.length === 0) throw new Error(`${dir} 里没有 ${ext} 文件，先跑 desktop 的 build`)
  return names.map((name) => readFileSync(join(dir, name), 'utf8'))
}

const rendererDir = join(desktopDir, 'out', 'renderer', 'assets')
// js 产物是多分包的（入口 + 懒加载页各一个 chunk），断言要扫全部——只读「字典序第一个」
// 会读到错误的 chunk，报出与源码对不上的假失败（2026-10-02 实测翻过车）。
const js = allFiles(rendererDir, '.js').join('\n')
const css = allFiles(rendererDir, '.css').join('\n')
const prefsJs = readFileSync(join(rootDir, 'lib', 'core', 'prefs.js'), 'utf8')
const runtimeJs = readFileSync(join(rootDir, 'lib', 'plugins', 'runtime.js'), 'utf8')
const contractDts = readFileSync(join(rootDir, 'lib', 'contract.d.ts'), 'utf8')
const loopJs = readFileSync(join(rootDir, 'lib', 'core', 'loop.js'), 'utf8')
const eventsDts = readFileSync(join(rootDir, 'lib', 'core', 'events.d.ts'), 'utf8')
const llmJs = readFileSync(join(rootDir, 'lib', 'core', 'llm.js'), 'utf8')
const llmDts = readFileSync(join(rootDir, 'lib', 'core', 'llm.d.ts'), 'utf8')
const transcriptJs = readFileSync(join(rootDir, 'lib', 'adapter', 'transcript.js'), 'utf8')
const terminalJs = readFileSync(join(rootDir, 'lib', 'app', 'ToolCard.js'), 'utf8')

/** 把样式表拆成「选择器 → 声明块」的清单；先去掉注释，免得注释里提到的类名被当成规则。 */
function cssRules(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = re.exec(clean)) !== null) {
    rules.push({ selector: match[1].replace(/\s+/g, ' ').trim(), body: match[2].replace(/\s+/g, ' ').trim() })
  }
  return rules
}

const rules = cssRules(css)
/** 按选择器全文找规则（大小写敏感；选择器已把连续空白压成一个空格）。 */
const ruleOf = (selector) => rules.find((rule) => rule.selector === selector)
/** 按选择器子串找规则（用于「这一族里有没有哪条写了某个声明」这种判断）。 */
const rulesLike = (needle) => rules.filter((rule) => rule.selector.includes(needle))
/** 在一个选择器族的声明里找某条声明（值用子串比对，容忍写法差异）。 */
function hasDecl(selector, property, valuePart) {
  const rule = ruleOf(selector)
  if (rule === undefined) return false
  const re = new RegExp(`${property}\\s*:\\s*[^;]*${valuePart}`)
  return re.test(rule.body)
}

/**
 * 在「选择器里含这个子串」的全部规则里找某条声明。
 *
 * 为什么需要它：dsc 的样式表里同一个挂点常写成选择器列表
 * （例如 `.round-foot .round-act, .user-turn .user-act, ...` 共用一套 28px 框），
 * 这时整条 selector 不等于单个类名，只按完全相等去找会漏。
 */
function hasDeclInFamily(needle, property, valuePart) {
  const re = new RegExp(`${property}\\s*:\\s*[^;]*${valuePart}`)
  return rulesLike(needle).some((rule) => re.test(rule.body))
}
/** 一个选择器族里所有规则的声明合起来（失败时打印用）。 */
const familyBody = (needle) => rulesLike(needle).map((rule) => `${rule.selector} { ${rule.body} }`).join(' ')

/**
 * 收集样式表里所有 `@media` 块的查询条件与正文。
 *
 * 为什么要单独抠：上面的 cssRules 是按「选择器 { 声明 }」这个形状切的，媒体查询那层花括号
 * 会被它跳过——规则能切出来，但「这条规则是不是写在 @media 里」这个信息丢了。
 * 而 prefers-reduced-motion 的降级规则恰恰只有「写在媒体查询里」才算数。
 * 这里按花括号配平扫，能正确处理嵌套。
 */
function mediaBlocks(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = []
  const re = /@media([^{]*)\{/g
  let match
  while ((match = re.exec(clean)) !== null) {
    const start = re.lastIndex
    let depth = 1
    let index = start
    while (index < clean.length && depth > 0) {
      if (clean[index] === '{') depth += 1
      else if (clean[index] === '}') depth -= 1
      index += 1
    }
    out.push({ query: match[1].trim(), body: clean.slice(start, index - 1) })
  }
  return out
}

/** 所有 prefers-reduced-motion 降级块的正文合起来。 */
const reducedMotion = mediaBlocks(css)
  .filter((block) => block.query.includes('prefers-reduced-motion'))
  .map((block) => block.body)
  .join('\n')

/** 断言表：{name, ok, detail}；detail 只在失败时打印，用来指出到底哪一处对不上。 */
const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok: ok === true, detail: String(detail ?? '') })
}

// ── 1) 竖排字修复：.think-label 的 flex:none + white-space:nowrap ─────────────────
{
  const rule = ruleOf('.think-label')
  check('竖排字：构建产物里有 .think-label 规则', rule !== undefined)
  check('竖排字：.think-label 写了 flex: none', hasDecl('.think-label', 'flex', 'none'), rule?.body)
  check('竖排字：.think-label 写了 white-space: nowrap', hasDecl('.think-label', 'white-space', 'nowrap'), rule?.body)
  // 修复的两条必须真的落在 .think-label 自己身上，而不是顺手写在别的选择器里
  check(
    '竖排字：这两条与字号同处一条规则（不是被别的规则顶替）',
    hasDecl('.think-label', 'font-size', 'dsc-fs-ui') &&
      hasDecl('.think-label', 'flex', 'none') &&
      hasDecl('.think-label', 'white-space', 'nowrap'),
    rule?.body,
  )
}

// ── 2) 整轮过程折叠：选择器 + 行为钩子 ───────────────────────────────────────────
{
  const row = ruleOf('.turn-fold')
  check('整轮折叠：有 .turn-fold 规则', row !== undefined)
  check('整轮折叠：整行可点（cursor: pointer）', hasDecl('.turn-fold', 'cursor', 'pointer'), row?.body)
  check('整轮折叠：行高同 dsh（min-height: calc(33px * var(--dsc-density))）', hasDecl('.turn-fold', 'min-height', 'dsc-density'), row?.body)
  check('整轮折叠：下边框分节线同 dsh（0.5px + --dsc-stroke-3）', hasDecl('.turn-fold', 'border-bottom', 'dsc-stroke-3'), row?.body)
  check('整轮折叠：字号取 --dsc-fs-ui（与 .think-label 同档）', hasDecl('.turn-fold', 'font-size', 'dsc-fs-ui'), row?.body)
  check('整轮折叠：左对齐（justify-content: flex-start）', hasDecl('.turn-fold', 'justify-content', 'flex-start'), row?.body)
  check('整轮折叠：整行铺满（width: 100%）', hasDecl('.turn-fold', 'width', '100%'), row?.body)
  // hover 对齐 dsh 的 .root:not(:disabled):hover：只提字色、不铺底色（0.6.35 实机反馈后改的）
  {
    const hover = ruleOf('.turn-fold:not(:disabled):hover')
    check(
      '整轮折叠：hover 只提字色不给底色（对齐 dsh :not(:disabled):hover）',
      hover !== undefined && hasDecl('.turn-fold:not(:disabled):hover', 'color', 'dsc-text-primary') && hover.body.includes('background') === false,
      hover?.body,
    )
    check(
      '整轮折叠：hover 时 label 同步提到最亮一档',
      hasDecl('.turn-fold:not(:disabled):hover .turn-fold-label', 'color', 'dsc-text-primary'),
      ruleOf('.turn-fold:not(:disabled):hover .turn-fold-label')?.body,
    )
  }
  check('整轮折叠：按下不再铺底色（:active 底色规则已撤）', ruleOf('.turn-fold:active') === undefined)
  check('整轮折叠：键盘焦点圈在（focus-visible）', ruleOf('.turn-fold:focus-visible') !== undefined)
  check('整轮折叠：展开态靠 data-open 转箭头', ruleOf('.turn-fold[data-open] .turn-fold-chevron') !== undefined)
  check(
    '整轮折叠：箭头是 180° 旋转复用同一个图标',
    hasDecl('.turn-fold[data-open] .turn-fold-chevron', 'transform', 'rotate\\(180deg\\)'),
    ruleOf('.turn-fold[data-open] .turn-fold-chevron')?.body,
  )
  check('整轮折叠：label 与 arrow 两个挂点都在样式里', ruleOf('.turn-fold-label') !== undefined && ruleOf('.turn-fold-chevron') !== undefined)

  // 渲染层的挂点（类名与 data-* 必须真的出现在 JSX 里）
  for (const marker of ['turn-fold', 'turn-fold-label', 'turn-fold-chevron']) {
    check(`整轮折叠：渲染产物里有类名 ${marker}`, js.includes(marker))
  }
  check('整轮折叠：总开关是 role=button 可开合（aria-expanded 挂在开关上）', js.includes('aria-expanded'))
  check('整轮折叠：总开关带轮次钩子 data-round-index（自检与调试用）', js.includes('data-round-index'))
  check('整轮折叠：存档键格式 会话id:turn:轮序号', js.includes(':turn:'))
  check('整轮折叠：算不出用时的降级文案「已完成」', js.includes('已完成'))
  check('整轮折叠：标签是「用时 X」', js.includes('用时 '))

  // 行为：档位能力表决定折不折、关不关摘要；跑动中不画总开关；计划卡不进组
  check(
    '整轮折叠：整轮折不折由档位能力表给（foldTurns = policy.foldTurns）',
    /const foldTurns = policy\.foldTurns/.test(js),
    js.match(/const foldTurns = [^\n]*/)?.[0],
  )
  check(
    '整轮折叠：摘要预览由档位能力表给（showReasoningPreview = policy.reasoningPreview）',
    /const showReasoningPreview = policy\.reasoningPreview/.test(js),
    js.match(/const showReasoningPreview = [^\n]*/)?.[0],
  )
  check(
    '整轮折叠：只有 thinking / tool / text 进组（plan 与 system 不进，审批流看得见）',
    /entry\.kind !== "thinking" && entry\.kind !== "tool" && entry\.kind !== "text"/.test(js),
  )
  check(
    '整轮折叠：组只到「本轮最后一条定稿 text」为止（answerIndex 从轮末往前找）',
    /let answerIndex = -1/.test(js) && /entry\.kind === "text" && entry\.id >= 0/.test(js),
  )
  check(
    '整轮折叠：跑动中的轮强制展开（running 认直播条目 / 最后一轮 / 未收尾）',
    // 预算器在 chat/round-fold.ts（buildRoundFolds）：running 的三形态判据原样搬了过去
    /running:\s*hasLiveEntry \|\| options\.live && round\.index === options\.lastRoundIndex \|\| !round\.answered/.test(js.replace(/\s+/g, ' ')),
    js.replace(/\s+/g, ' ').match(/running: hasLiveEntry[^,]*/)?.[0],
  )
  check(
    '整轮折叠：跑动中的轮连总开关行都不渲染（dsh 只在轮次 closed 时渲染 turn-process）',
    /seat\.withFoldRow && seat\.fold !== void 0 && !seat\.fold\.running/.test(js),
    js.match(/seat\.withFoldRow &&[^,]*/)?.[0],
  )
  check(
    '整轮折叠：收起时不再卸载 DOM，改成挂 hidden="until-found"（Ctrl+F 能命中、焦点不被抽走）',
    js.includes('until-found') && !/!turnExpanded && !foot\) return null/.test(js),
  )
  check(
    '整轮折叠：轮收尾（跑动 → 定稿）复位成默认收起',
    /previousRunningRounds/.test(js) && /writeFold\(key, false\)/.test(js),
  )
  check('整轮折叠：总开关由 ChatView 的 turnFoldKey 拼键（与 fold-state 同一函数）', js.includes('turnFoldKey('))
}

// ── 3) 设置项：过程折叠程度四档 + 两个默认态开关，宿主白名单 + 回执 + 桌面端读写 ──
{
  check('设置项：契约里有 UiProcessFold 类型', contractDts.includes('UiProcessFold'))
  check(
    '设置项：四档都在契约里（compact / standard / detailed / verbose）',
    /UiProcessFold = ['"]compact['"] \| ['"]standard['"] \| ['"]detailed['"] \| ['"]verbose['"]/.test(contractDts),
    contractDts.match(/UiProcessFold = [^\n]*/)?.[0],
  )
  check(
    '设置项：UiPrefsView 带上了 processFold 字段',
    /processFold: UiProcessFold/.test(contractDts),
  )
  check(
    '设置项：UiPrefsView 带上两个默认态开关',
    /reasoningDefaultOpen: boolean/.test(contractDts) && /toolDefaultOpen: boolean/.test(contractDts),
  )
  check('设置项：宿主读档白名单里认这一项（readProcessFold）', prefsJs.includes('readProcessFold'))
  check(
    '设置项：四档常量表在宿主侧',
    prefsJs.includes('PROCESS_FOLDS') && /'compact'/.test(prefsJs) && /'detailed'/.test(prefsJs) && /'verbose'/.test(prefsJs),
  )
  check('设置项：默认档是 standard', /processFold: PROCESS_FOLD_DEFAULT/.test(prefsJs) && /PROCESS_FOLD_DEFAULT = 'standard'/.test(prefsJs))
  check(
    '设置项：两个默认态开关的出厂值都是 false（升级不改变现状）',
    /reasoningDefaultOpen: false/.test(prefsJs) && /toolDefaultOpen: false/.test(prefsJs),
  )
  check(
    '设置项：写偏好回执认这一项（漏了会出「已保存工作区名字」的假提示）',
    runtimeJs.includes('patch.processFold !== undefined'),
  )
  check(
    '设置项：四档各有自己的回执文案',
    runtimeJs.includes('过程折叠程度改为紧凑') &&
      runtimeJs.includes('过程折叠程度改为标准') &&
      runtimeJs.includes('过程折叠程度改为详细') &&
      runtimeJs.includes('过程折叠程度改为逐条摊开'),
  )
  check(
    '设置项：两个默认态开关也各有回执',
    runtimeJs.includes('定稿的思考行默认展开') && runtimeJs.includes('工具卡默认收起'),
  )
  check('设置项：渲染层有「过程折叠程度」这一行', js.includes('过程折叠程度'))
  check(
    '设置项：四个档位标签都在（紧凑 / 标准 / 详细 / 完全展开）',
    js.includes('"compact", label: "紧凑"') &&
      js.includes('"standard", label: "标准"') &&
      js.includes('"detailed", label: "详细"') &&
      js.includes('"verbose", label: "完全展开"'),
  )
  check('设置项：改档直接写回宿主 ui 偏好（onUiPrefs({ processFold })）', /onUiPrefs\(\{ processFold: value \}\)/.test(js))
  check('设置项：App 把偏好传给 ChatView（processFold={uiPrefs.processFold}）', /processFold: uiPrefs\.processFold/.test(js))
  check(
    '设置项：坏值归一（normalizeProcessFold 回落 standard）',
    /processFold: normalizeProcessFold\(prefs\.processFold\)/.test(js),
  )
  check(
    '设置项：四档都过归一（verbose 不会被吞成 standard）',
    /value === "compact" \|\| value === "detailed" \|\| value === "verbose"/.test(js),
    js.match(/value === "compact"[^\n]*/)?.[0],
  )
  check(
    '设置项：回读时两个开关只认 true（老宿主缺项落到同一个结果）',
    /reasoningDefaultOpen: prefs\.reasoningDefaultOpen === true/.test(js),
  )
}

// ── 4) 脚注新结构：一条左对齐行，顺序 复制 · 赞 · 踩 · 分叉 · 用量 · 时刻 ─────────
{
  check('脚注：还是一行 .round-foot', js.includes('"round-foot"'))
  check('脚注：复制 / 赞 / 踩换成 .round-act（28px 框走「对话区修正批」那一段）', js.includes('round-act'))
  check('脚注：用量与时刻两项都还在（.round-tokens / .round-clock）', js.includes('round-tokens') && js.includes('round-clock'))
  check(
    '脚注：CSS 给 .round-foot .round-act 排了 28px 框',
    hasDeclInFamily('.round-foot .round-act', 'width', '28px'),
    familyBody('.round-foot .round-act'),
  )
  check(
    '脚注：图标跟着 --dsc-btn-scale 一起缩放',
    hasDeclInFamily('.round-foot .round-act svg', 'width', 'dsc-btn-scale'),
    familyBody('.round-foot .round-act svg'),
  )
  check('脚注：点过的评价常亮（.round-act.on）', ruleOf('.round-foot .round-act.on') !== undefined)
  check('脚注：复制 17px、分叉 15px 的图标规格没变（IconCopy 17 / IconBranch 15）', /IconCopy/.test(js) && /IconBranch/.test(js))

  // 顺序：图 4 是「动作在前、读数在后」。用每项独有的文案在产物里的下标比对。
  const order = [
    ['复制', '复制这条回复的原文'],
    ['赞', '这条回复不错'],
    ['踩', '这条回复不好'],
    ['分叉', '以这条消息为界分叉出新会话'],
    ['用量', '这一轮所有模型请求的 prompt 与 completion 之和'],
    ['时刻', '这条消息发出的时刻（本机时区）'],
  ]
  const at = order.map(([, text]) => js.indexOf(text))
  check(
    '脚注：六项顺序照 dsh 图 4（复制 · 赞 · 踩 · 分叉 · 用量 · 时刻）',
    at.every((value) => value >= 0) && at.every((value, index) => index === 0 || value > at[index - 1]),
    JSON.stringify(order.map(([label], index) => `${label}@${at[index]}`)),
  )

  // 用量优先真值
  check(
    '脚注：真值取整轮最后一条带 usage 的条目（text / tool 都看）',
    /entry\.kind !== "text" && entry\.kind !== "tool"/.test(js) && js.includes('const usage = entry.usage'),
  )
  check(
    '脚注：真值 = inputTokens + outputTokens（不带波浪号的那一档）',
    /props\.usage\.inputTokens \+ props\.usage\.outputTokens/.test(js),
  )
  check(
    '脚注：真值优先、估算只在没有真值时回落（real / estimated 二选一）',
    /const real = measured !== null && measured > 0 \? measured : null/.test(js) &&
      /const estimated = real !== null/.test(js),
  )
  check('脚注：真值文案是「用量 N tok」', js.includes('用量 '))
  check('脚注：估算文案保留 ~ 前缀', /\{?"~", ?formatTokens/.test(js) || /"~" \+ formatTokens/.test(js) || /`~\$\{formatTokens/.test(js) || js.includes('"~"'))
  check('脚注：真值与估算各有一句 title 说明口径', js.includes('宿主上报的真实用量') && js.includes('这是估算值'))

  // 「用时」不占行面，进整行 title
  check(
    '脚注：用时进整行 title（不再是 .round-used 那一格）',
    /title: used === null \? void 0 : `用时 \$\{used\}（从发出这条消息到这一轮最后一次写入/.test(js),
  )
  check('脚注：.round-used 那个格子已经退场', !js.includes('round-used'))
}

// ── 5) 阶段组：一轮之内的第二级折叠（对照 dsh 的 ChatGroupSeat / process-groups） ──
{
  // 样式：组头行 + 三个挂点 + 展开态转箭头
  const row = ruleOf('.step-fold')
  check('阶段组：有 .step-fold 规则', row !== undefined)
  check('阶段组：整行可点（cursor: pointer）', hasDecl('.step-fold', 'cursor', 'pointer'), row?.body)
  check('阶段组：与整轮开关同规格（min-height: var(--dsc-row-h)）', hasDecl('.step-fold', 'min-height', 'dsc-row-h'), row?.body)
  check('阶段组：整行铺满（width: 100%）', hasDecl('.step-fold', 'width', '100%'), row?.body)
  check(
    '阶段组：hover 底色与过程行同款令牌',
    hasDecl('.step-fold:hover', 'background', 'dsc-row-hover-bg'),
    ruleOf('.step-fold:hover')?.body,
  )
  check('阶段组：按下有更深一档底色', hasDecl('.step-fold:active', 'background', 'dsc-row-active-bg'))
  check('阶段组：键盘焦点圈在（focus-visible）', ruleOf('.step-fold:focus-visible') !== undefined)
  check(
    '阶段组：标题比思考行亮一档（text-secondary 对 tertiary）——两级折叠靠颜色分层，不靠缩进',
    hasDecl('.step-fold-label', 'color', 'dsc-text-secondary'),
    ruleOf('.step-fold-label')?.body,
  )
  check(
    '阶段组：展开态靠 data-open 把箭头转 180°',
    hasDecl('.step-fold[data-open] .step-fold-chevron', 'transform', 'rotate\\(180deg\\)'),
    ruleOf('.step-fold[data-open] .step-fold-chevron')?.body,
  )
  check(
    '阶段组：图标 / 标题 / 箭头三个挂点都在样式里',
    ruleOf('.step-fold-icon') !== undefined && ruleOf('.step-fold-label') !== undefined && ruleOf('.step-fold-chevron') !== undefined,
  )
  check(
    '阶段组：web 类别有专属图标（地球 path 在产物里）',
    js.includes('M12 3c2.5 2.4 3.9 5.6'),
  )

  // 渲染层挂点
  for (const marker of ['step-fold', 'step-fold-text', 'step-fold-icon', 'step-fold-label', 'step-fold-detail', 'step-fold-chevron']) {
    check(`阶段组：渲染产物里有类名 ${marker}`, js.includes(marker))
  }
  check('阶段组：组头带轮内组号钩子 data-step-group', js.includes('data-step-group'))
  check('阶段组：组头带类别钩子 data-step-activity（自检与调试用）', js.includes('data-step-activity'))
  check('阶段组：组头带类别次数 data-step-counts（次数不上面面，留给自检）', js.includes('data-step-counts'))
  check('阶段组：组头带收口状态 data-step-closed', js.includes('data-step-closed'))
  check('阶段组：存档键格式 会话id:step:轮:组', js.includes(':step:'))

  // 行为：切分与文案都在纯函数模块里，渲染层只消费
  check('阶段组：ChatView 调纯函数分组器（groupSteps）', js.includes('groupSteps('))
  check('阶段组：标题在 process-groups.ts 里拼（stepGroupTitle）', js.includes('stepGroupTitle'))
  check('阶段组：存档键走 stepGroupFoldKey', js.includes('stepGroupFoldKey('))
  check(
    '阶段组：整轮收起时组头跟着一起收（由 StepGroupSeat 的 turnCollapsed 办）',
    /turnCollapsed: collapsed/.test(js),
    js.match(/turnCollapsed[^,]*/)?.[0],
  )
  check(
    '阶段组：组收起时组内条目不再卸载，改成挂 hidden',
    js.includes('until-found') && !/!stepExpanded && !foot\) return null/.test(js),
  )
  check(
    '阶段组：组的默认态是收起（不认本轮跑不跑，跟 dsh 的初始收起一致）',
    /return foldOpen\[key\] \?\? readFold\(key, false\)/.test(js),
    js.match(/return foldOpen\[key\][^\n]*/)?.[0],
  )
  check(
    '阶段组：轮收尾时两级折叠一起复位（previousRunningRounds）',
    js.includes('previousRunningRounds') && /writeFold\(key, false\)/.test(js),
  )

  // 文案体系：已结束报聚合、未结束报实时类别
  for (const label of [
    '已读取文件', '已读取图片', '已搜索代码', '已写入文件', '修改了文件',
    '执行了命令', '运行了代码', '已搜索网页', '已浏览网页',
    '已完成分析', '正在分析请求', '正在读取文件', '正在运行命令',
  ]) {
    check(`阶段组：产物里有文案「${label}」`, js.includes(label))
  }
  check('阶段组：两类用「并」连接', js.includes('"并"'), js.match(/.{0,16}"并".{0,16}/)?.[0])
  check('阶段组：超过三类收进「等」', js.includes('"等"'), js.match(/.{0,16}"等".{0,16}/)?.[0])
  check('阶段组：实时类别沿用同一套「正在…」文案表', js.includes('正在协调子智能体'))
  check(
    '阶段组：完全展开档整个不分（stepGrouping 为 none 时给空分组，过程条目逐条摊开）',
    js.includes('EMPTY_STEP_GROUPING') && /policy\.stepGrouping === "none" \? EMPTY_STEP_GROUPING : groupSteps\(/.test(js),
    js.replace(/\s+/g, ' ').match(/.{0,30}EMPTY_STEP_GROUPING : groupSteps.{0,30}/)?.[0],
  )
  check(
    '阶段组：已结束的组不带实时类别与详情（收口时一起清空）',
    /group\.running = live\.activity/.test(js) && /group\.runningDetail = detail/.test(js),
    js.match(/group\.running = [^\n]*/)?.[0],
  )
}

// ── 7) 直播态对齐 dsh：组头实时详情 + 150ms 最短保留（A1 / A2） ───────────────────
{
  check('直播详情：参数优先级表在产物里（DETAIL_KEYS）', js.includes('DETAIL_KEYS'))
  check('直播详情：按字素簇截断（Intl.Segmenter）', js.includes('Intl.Segmenter'))
  check('直播详情：上限常量在（DETAIL_MAX_CHARS）', js.includes('DETAIL_MAX_CHARS'))
  check('直播详情：详情在组头标题下一行（.step-fold-detail 元素，不再「 · 」接尾）', js.includes('step-fold-detail'))
  check(
    '直播详情：文本柱放开收缩下限（min-width: 0），长思考截在组头宽度里不撑破会话',
    hasDecl('.step-fold-text', 'min-width', '0'),
    familyBody('step-fold-text'),
  )
  check(
    '直播详情：详情行单行截断（overflow: hidden + nowrap），直播态右缘渐隐收口',
    hasDecl('.step-fold-detail', 'overflow', 'hidden') && hasDecl('.step-fold-detail', 'mask-image', 'linear-gradient'),
    familyBody('step-fold-detail'),
  )
  check('直播详情：组头带 data-step-detail 钩子（自检取详情用）', js.includes('data-step-detail'))
  check('直播详情：档位开关真的接上了（showDetail: policy.liveDetail）', /showDetail: policy\.liveDetail/.test(js))
  check('直播详情：没有运行中的工具时退回最后一段直播尾思考', js.includes('liveReasoningDetail') || js.includes('lastLiveThinking'))
  check(
    '直播防抖：最短保留常量是 150（照抄 dsh 的 PROCESS_TITLE_MINIMUM_MS）',
    js.includes('PROCESS_TITLE_MINIMUM_MS') && /PROCESS_TITLE_MINIMUM_MS = 150/.test(js),
  )
  check('直播防抖：判定走纯函数 liveTitleDecision（时钟从外面传进来）', js.includes('liveTitleDecision'))
  check('直播防抖：到点换成最新那一个（中间态跳过）', js.includes('wantedRef'))
  check('直播防抖：定稿的组不参与防抖（直接返回 desired）', /return active\d* \? shown : desired/.test(js))
}

// ── 8) 四档档位与两个默认态开关（B1 / B2） ───────────────────────────────────────
{
  check('档位：能力表在产物里（PROCESS_FOLD_POLICIES）', js.includes('PROCESS_FOLD_POLICIES'))
  check(
    '档位：四档都在能力表里',
    ['compact', 'standard', 'detailed', 'verbose'].every((mode) => js.includes(`"${mode}"`)),
  )
  check('档位：detailed 走「只有历史轮分组」', /stepGrouping: "history"/.test(js))
  check('档位：verbose 不分组', /stepGrouping: "none"/.test(js))
  check('档位：ChatView 只读能力（policy.stepGrouping）', js.includes('policy.stepGrouping'))
  check('档位：只给历史轮分组时把 settledOnly 传进分组器', /stepGrouping === "history"/.test(js))
  check(
    '默认态开关：思考行的初始态接上偏好',
    /defaultOpen: props\.reasoningDefaultOpen === true/.test(js),
  )
  check(
    '默认态开关：工具卡的初始态接上偏好',
    /defaultOpen: props\.toolDefaultOpen === true/.test(js),
  )
  check(
    '默认态开关：App 把两项都传给 ChatView',
    /reasoningDefaultOpen: uiPrefs\.reasoningDefaultOpen/.test(js) && /toolDefaultOpen: uiPrefs\.toolDefaultOpen/.test(js),
  )
  check(
    '默认态开关：直播尾那一条仍然强制展开（live || defaultOpen）',
    /readFold\(storeKey, live \|\| defaultOpen\)/.test(js),
  )
  check('默认态开关：设置页有两行（定稿的思考行 / 工具卡）', js.includes('定稿的思考行') && js.includes('"工具卡"'))
  check(
    '默认态开关：写回宿主走 onUiPrefs',
    /onUiPrefs\(\{ reasoningDefaultOpen: value === "open" \}\)/.test(js) &&
      /onUiPrefs\(\{ toolDefaultOpen: value === "open" \}\)/.test(js),
  )
}

// ── 9) 组体限高 / 方向渐隐 / 组内滚动 / 组头 hover 换箭头（C1 / C2） ──────────────
{
  check(
    '组体：限高 min(400px, 50vh)（照 dsh 的 .body）',
    hasDecl('.step-body', 'max-height', 'min\\(400px, 50vh\\)'),
    ruleOf('.step-body')?.body,
  )
  check('组体：组内独立滚动（overflow-y: auto）', hasDecl('.step-body', 'overflow-y', 'auto'))
  check(
    '组体：两条方向渐隐走 mask（不是叠色块，浅色主题才不会露馅）',
    /mask-image:\s*linear-gradient/.test(ruleOf('.step-body[data-scroll-up]')?.body ?? ''),
    ruleOf('.step-body[data-scroll-up]')?.body,
  )
  check(
    '组体：两条边同时出现时有合并的那条 mask',
    ruleOf('.step-body[data-scroll-up][data-scroll-down]') !== undefined,
  )
  check(
    '组体：渐隐宽度是 24px（照 dsh）',
    hasDeclInFamily('.step-body[data-scroll-up]', 'mask-image', '24px'),
  )
  check('组体：渲染层带 data-scroll-up / data-scroll-down 钩子', js.includes('data-scroll-up') && js.includes('data-scroll-down'))
  check(
    '组体：内容列是 flex column + 同档 gap',
    hasDecl('.step-content', 'display', 'flex') && hasDecl('.step-content', 'gap', 'dsc-turn-gap'),
    ruleOf('.step-content')?.body,
  )
  check('组体：组内自己滚动跟随（useProcessScroll）', js.includes('useProcessScroll'))
  check(
    '组体：展开未结束的组贴底、已结束的组从顶部开始',
    /body\.scrollTop = live \? body\.scrollHeight : 0/.test(js),
  )
  check(
    '组体：滚离底部暂停跟随、滚回贴底档恢复（与外层同一把尺子）',
    /AT_BOTTOM_EPS/.test(js) && /follow\.current = limit <= 0 \|\| limit - body\.scrollTop <= AT_BOTTOM_EPS/.test(js),
  )
  check('C2：图标与箭头叠在同一格（.step-fold-leading 是 inline-grid）', hasDecl('.step-fold-leading', 'display', 'inline-grid'))
  check(
    'C2：静息只显图标，悬停 / 聚焦 / 展开时换成箭头',
    hasDecl('.step-fold-chevron', 'opacity', '0') &&
      hasDeclInFamily('.step-fold:hover .step-fold-chevron', 'opacity', '1') &&
      hasDeclInFamily('.step-fold:hover .step-fold-icon', 'opacity', '0'),
    ruleOf('.step-fold-chevron')?.body,
  )
  check('C2：展开态也把箭头显出来（data-open 那一路）', ruleOf('.step-fold[data-open] .step-fold-chevron') !== undefined)
  check('C2：渲染层把图标与箭头包进 .step-fold-leading', js.includes('step-fold-leading'))
  check('C1：展开的组头与组体之间留 8px（照 dsh）', hasDecl('.step-fold[data-open]', 'padding-bottom', '8px'))
}

// ── 10) 可访问性：焦点保护与浏览器查找（D1 / D2） + 动效降级（E2） ────────────────
{
  check('D1/D2：收起走 hidden="until-found"，DOM 不再卸载', js.includes('until-found'))
  check(
    'D1：隐藏前先看焦点在不在里面（contains(ownerDocument.activeElement)）',
    /contains\(element\d*\.ownerDocument\.activeElement\)/.test(js),
  )
  check('D2：监听 beforematch，命中就把内容放出来', js.includes('beforematch'))
  check('D2：整轮与组体共用同一个 hook（useSearchableHidden）', js.includes('useSearchableHidden'))
  check('D1：点组头先把焦点收到组头自己身上', /currentTarget\.focus\(\)/.test(js))
  check(
    '退场：两处「收起就卸载」的 return null 都不在了',
    !/!turnExpanded && !foot\) return null/.test(js) && !/!stepExpanded && !foot\) return null/.test(js),
  )
  check(
    'D2 的代价：.entry-row 从 display:contents 改成真盒子（否则 hidden 不起作用）',
    hasDecl('.entry-row', 'display', 'flex'),
    ruleOf('.entry-row')?.body,
  )
  check('D2：作者样式里显式补了 [hidden] 压过 display', hasDecl('.entry-row[hidden]', 'display', 'none'))
  check('D2：组座位也补了 [hidden]', hasDecl('.step-seat[hidden]', 'display', 'none'))
  check(
    'E2：降级规则写在 prefers-reduced-motion 里（不是散在外面）',
    reducedMotion.includes('.step-fold') && reducedMotion.includes('.step-fold-chevron'),
    reducedMotion.slice(0, 200),
  )
  check(
    'E2：组头、图标、箭头三处都把 transition 关掉',
    /\.step-fold[\s\S]*?\btransition:\s*none/.test(reducedMotion) &&
      reducedMotion.includes('.step-fold-icon') &&
      reducedMotion.includes('.step-fold-chevron'),
  )
}

// ── 6) 旧结构必须退场 ────────────────────────────────────────────────────────────
{
  check('退场：.entry-meta 那条操作条不再渲染', !js.includes('entry-meta'))
  check('退场：.entry-with-meta 包裹类不再渲染', !js.includes('entry-with-meta'))
  check('退场：.meta-btn / .meta-actions 不再渲染', !js.includes('meta-btn') && !js.includes('meta-actions'))
  const leftovers = rules.filter((rule) => rule.selector.includes('.entry-meta'))
  check(
    '退场：styles.css 里不再有 .entry-meta 的规则（含那条 justify-content: flex-end）',
    leftovers.length === 0,
    leftovers.map((rule) => rule.selector).join(' | '),
  )
}

// ── 11) 与 dsh 继续对齐：轮结束原因、轮中途插话、独立节点（0.6.8） ─────────────
{
  // 契约：三样新东西
  check(
    '契约：TurnEndReason 三态在（completed / aborted / error）',
    /TurnEndReason = ['"]completed['"] \| ['"]aborted['"] \| ['"]error['"]/.test(contractDts),
    contractDts.match(/TurnEndReason = [^\n]*/)?.[0],
  )
  check('契约：user 条目带 steering 标志（轮中途插话）', /steering\?: boolean/.test(contractDts))
  check(
    '契约：新增 turn-end 与 turn-max-tokens 两种条目',
    /kind: ['"]turn-end['"]/.test(contractDts) && /kind: ['"]turn-max-tokens['"]/.test(contractDts),
  )

  // 宿主事件链：原料要真的从循环里出来
  check('事件：user 带 steering', /steering\?: boolean/.test(eventsDts))
  check('事件：message 带 finishReason', /finishReason\?: string \| null/.test(eventsDts))
  check(
    '宿主：followup 把「回合中收到的消息」标成插话',
    /const steering = this\.running/.test(loopJs),
  )
  check('宿主：message 事件带上 finishReason', /finishReason: result\.finishReason/.test(loopJs))
  check(
    'adapter：轮尾标记只在中断 / 失败时落条目（正常结束不落）',
    /if \(event\.reason !== ['"]completed['"]\)/.test(transcriptJs),
  )
  check('adapter：finishReason === length 落长度上限条目', /event\.finishReason === ['"]length['"]/.test(transcriptJs))
  check(
    'adapter：插话不重置整轮用量（否则前半段的量被当场抹掉）',
    /if \(event\.steering !== true\)\s+this\.turnUsage/.test(transcriptJs),
  )
  check('adapter：插话标志写进 user 条目', /event\.steering === true \? \{ steering: true \}/.test(transcriptJs))

  // 渲染层：总开关的三态、四道闸门、独立节点
  check('渲染：独立节点表在产物里', js.includes('TURN_PROCESS_INDEPENDENT'))
  check('渲染：总开关三态文案都在（已停止 / 过程失败）', js.includes('已停止') && js.includes('过程失败'))
  check(
    '渲染：不可折时画成 disabled（照 dsh 的 disabled={!canCollapse}）',
    /disabled: !seat\.fold\.hasContent \|\| seat\.fold\.blocked/.test(js),
    js.match(/disabled: !seat\.fold[^\n]*/)?.[0],
  )
  check(
    '渲染：整轮折叠四道闸门（档位 / 有内容 / 已收尾 / 没被阻断）',
    /if \(!fold\.foldable \|\| !fold\.hasContent \|\| fold\.running \|\| fold\.blocked\) return false/.test(js),
    js.match(/if \(!fold\.foldable[^\n]*/)?.[0],
  )
  check(
    '渲染：插话 / 中断 / 失败都算阻断（对照 dsh 的 turnProcessAlwaysOpen）',
    /hasSteering \|\| endReason === ['"]aborted['"] \|\| endReason === ['"]error['"]/.test(js),
  )
  check(
    '渲染：没有过程内容时也画那一行抬头（画在用户消息之后）',
    /fold\.hasContent \? fold\.startIndex : round\.startIndex \+ 1/.test(js),
  )
  check('渲染：独立节点不进过程区', /TURN_PROCESS_INDEPENDENT\.has\(entry\.kind\)/.test(js))
  check('渲染：长度上限有一条上屏提示', js.includes('这一轮的输出达到长度上限'))
  check('渲染：轮尾标记自己不上屏（只是给整轮折叠读的元数据）', /case ['"]turn-end['"]:/.test(js))
  // 打包器会把这里的 node 重命名成 node2（外层已有一个同名变量），所以按 node\d* 匹配
  check(
    '渲染：内容为空的条目不产出盒子（空盒子会白吃一段间距）',
    /if \(node\d* === null\) return null/.test(js),
  )
  check(
    '组体：组收口时不再重置阅读位置（只在刚展开那一刻定位）',
    /if \(!wasOpen\.current\)/.test(js),
    js.match(/if \(!wasOpen\.current\)[^\n]*/)?.[0],
  )
  check('样式：不可折那一行不响应悬停（hover 规则带 :not(:disabled) 门 + cursor 收回）', ruleOf('.turn-fold:not(:disabled):hover') !== undefined && ruleOf('.turn-fold:disabled') !== undefined)
  check('轨迹页：认得两种新条目（轮结束 / 长度上限）', js.includes('轮结束') && js.includes('达到长度上限'))
}

// ── 12) 批 2：准备中态与模型重试行 ───────────────────────────────────────────────
{
  // 契约
  check(
    '契约：ToolStatus 里多了 preparing',
    /ToolStatus = ['"]preparing['"] \| ['"]running['"]/.test(contractDts),
    contractDts.match(/ToolStatus = [^\n]*/)?.[0],
  )
  check('契约：新增 model-retry 条目', /kind: ['"]model-retry['"]/.test(contractDts))

  // 流式层：原料要真的从 llm 里出来
  check(
    '流式层：回调表里有 onToolPrepare',
    /onToolPrepare\?\(name: string\): void/.test(llmDts),
    llmDts.match(/onToolPrepare\?[^\n]*/)?.[0],
  )
  check('流式层：回调表里有 onRetry', /onRetry\?\(nextAttempt: number, reason: string\): void/.test(llmDts))
  check('流式层：首次拿到工具名就报一声', /handlers\.onToolPrepare\?\.\(name\)/.test(llmJs))
  check('流式层：重试之前报一次', /handlers\.onRetry\?\.\(attempt \+ 1/.test(llmJs))

  // 事件链：两个新事件与两条转发
  check('事件：tool/prepare 在', /type: ['"]tool\/prepare['"]/.test(eventsDts))
  check('事件：model/retry 在', /type: ['"]model\/retry['"]/.test(eventsDts))
  check(
    '宿主：两个回调都转发成事件',
    /onToolPrepare: \(name\) => this\.deps\.emit\(\{ type: ['"]tool\/prepare['"]/.test(loopJs)
      && /onRetry: \(attempt, reason\) => this\.deps\.emit\(\{ type: ['"]model\/retry['"]/.test(loopJs),
  )

  // adapter：排队 → 就地升级 → 轮末清理
  check('adapter：准备中的条目排进队列', /this\.prepared = \[\]/.test(transcriptJs) && js.includes('takePrepared') === false)
  check(
    'adapter：tool/call 就地升级（不另开一条）',
    /this\.takePrepared\(event\.name\)/.test(transcriptJs),
    transcriptJs.match(/takePrepared\(event\.name\)[^\n]*/)?.[0],
  )
  check('adapter：轮末清掉等不到升级的「准备中」', /this\.dropPrepared\(\)/.test(transcriptJs))
  check('adapter：准备中的条目落成 preparing 状态', /status: ['"]preparing['"]/.test(transcriptJs))
  check(
    'adapter：准备中的条目由 liveEntries 合成（不进 list，免得插到直播尾前面）',
    /liveEntries\(\)/.test(transcriptJs) && /prepared\.map/.test(transcriptJs),
    transcriptJs.match(/const prepared = this\.prepared\.map[^\n]*/)?.[0],
  )
  check(
    'adapter：轮末清队列就够（条目从没进过 list，没有下标要修）',
    /dropPrepared/.test(transcriptJs) && !/const rebuilt = new Map/.test(transcriptJs),
  )

  // 渲染层
  check(
    '渲染：十四类准备文案都在产物里',
    js.includes('准备读取文件') && js.includes('准备调用工具') && js.includes('准备浏览网页'),
  )
  check('渲染：组头把 preparing 传进文案函数', /live\.preparing/.test(js))
  check(
    '渲染：工具卡在准备中时不可展开（参数此刻本来就不全）',
    /open && !preparing/.test(js),
    js.match(/open && !preparing[^\n]*/)?.[0],
  )
  check('渲染：工具卡状态文字有「准备中」', js.includes('准备中'))
  check('渲染：模型重试有一条上屏提示', js.includes('正在重试'))
  check('渲染：运行指示分开「正在准备」与「正在调用」', js.includes('正在准备 ') && js.includes('正在调用 '))
  check('轨迹页：认得模型重试', js.includes('模型重试'))
  check('TUI：状态表里也补了「准备中」', terminalJs.includes('准备中'))
}

// ── 13) 批 3：组头跑动中的扫光（与思考摘要共用同一套写法） ──────────────────────
{
  check(
    '批 3：组头的扫光与思考摘要共用同一条规则（两条选择器并列）',
    /\.think-summary-text\[data-shimmer\]::after,\s*\.step-fold-label\[data-shimmer\]::after/.test(css.replace(/\s+/g, ' ')),
    css.replace(/\s+/g, ' ').match(/\.think-summary-text\[data-shimmer\][^{]*/)?.[0],
  )
  check(
    '批 3：组头 label 是扫光的定位父级（::after 要绝对定位叠在字形上）',
    hasDecl('.step-fold-label', 'position', 'relative'),
    ruleOf('.step-fold-label')?.body,
  )
  check(
    '批 3：渲染层在跑动中给 label 挂 data-shimmer（收口的不给）',
    // 属性名带连字符，打包后是带引号的键；0.6.46 起扫光值是标题本体（详情行自己另挂一份）
    /"data-shimmer": closed \? void 0 : label/.test(js),
    js.match(/"data-shimmer": closed[^\n]*/)?.[0],
  )
  check('批 3：reduced-motion 下组头扫光也关掉', reducedMotion.includes('.step-fold-label[data-shimmer]'))
  check(
    '批 3：扫光的节奏照 dsh（1.5s steps(48, end) 0.3s 无限循环）',
    /animation: dsc-think-shimmer 1\.5s steps\(48, end\) 0\.3s infinite/.test(css.replace(/\s+/g, ' ')),
  )
}

// ── 打印 ────────────────────────────────────────────────────────────────────────
const passed = checks.filter((entry) => entry.ok).length
const failed = checks.filter((entry) => !entry.ok)
process.stdout.write(`[fold-check] 产物：\n  css+js ${rendererDir}（全部分包）\n  host ${join(rootDir, 'lib')}\n`)
for (const entry of checks) {
  process.stdout.write(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}\n`)
  if (!entry.ok && entry.detail !== '') process.stdout.write(`      实测：${entry.detail}\n`)
}
process.stdout.write(`[fold-check] 断言 ${String(checks.length)} 条，通过 ${String(passed)} 条，失败 ${String(failed.length)} 条\n`)
process.exit(failed.length === 0 ? 0 : 1)
