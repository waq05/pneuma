/**
 * 「远程页在手机上要能看」的两道闸：老内核（函数/写法）与窄屏（布局）。
 *
 * 起因是 2026-10-14 的手机报障：侧栏与浮层点开是**透明的**、跟会话叠在一起，输入框也没适配。
 * 查下来是两件独立的事，合在一个探针里是因为它们同属「同一个手机页面上的形态」：
 *
 *   A. **老内核**：手机上的 WebView 停在 2022 年前后（证据是页面里那条
 *      `AbortSignal.timeout is not a function`）。于是 ① 不认 `color-mix()` 的整套令牌
 *      （兜底那半在 `scripts/ui-color-fallback-test.mjs` 里钉）、② 少几个标准方法，
 *      ③ `inset` 简写这类新写法也会静默丢掉。
 *   B. **窄屏**：390px 下输入行塞不下五颗控件、状态栏的隐藏悬浮卡与拖宽把手把文档
 *      撑到 431px（页面能左右拖 41px）；停靠区那条「手机不给」的规则打在了一个
 *      壳里根本不存在的类名上（`.dock-slot`），规则是死的。
 *
 * 四段：
 *   [1] 标准方法底线：不许出现「太新」的那几个（带负向验证，证明扫描不是空转）
 *   [2] AbortSignal：手写超时闸的接线（超时/外部取消两条路都在，且收尾干净）
 *   [3] inset 兜底：五张整屏遮罩 + 与 legacy 那侧的对账（兜底不许变成僵尸规则）
 *   [4] 窄屏规则：输入行两行化、状态栏与把手藏掉、停靠区那条死选择器不许回来
 *
 * 运行：node scripts/ui-legacy-compat-test.mjs
 *
 * @module dsc/scripts/ui-legacy-compat-test
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')
const flat = (text) => text.replace(/\r\n/g, '\n')
/** 去注释：扫源码找 API 时要先把说明文字剔掉（注释里正是写着「别用这些」）。 */
const uncomment = (text) => flat(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

/** 递归收集源码文件（只认 .ts/.tsx/.css）。 */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) collect(full, out)
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(full)
  }
  return out
}

console.log('[1] 标准方法底线：不许用「太新」的那几个')
{
  // 底线口径写在 ui-primitives/compat.ts 的文件头与 docs/development.md 的「浏览器底线」一节。
  const FORBIDDEN = [
    'AbortSignal.timeout(',
    'AbortSignal.any(',
    '.findLast(',
    '.findLastIndex(',
    '.toSorted(',
    '.toReversed(',
    'structuredClone(',
    'Object.groupBy(',
    'Promise.withResolvers(',
  ]
  /** 扫一批源码，返回 `文件:行 → 命中片段`。 */
  const scan = (files) => {
    const hits = []
    for (const file of files) {
      const rel = file.slice(root.length).replace(/\\/g, '/')
      if (rel.endsWith('ui-primitives/compat.ts')) continue // 替身自己住在那里
      for (const [index, line] of uncomment(readFileSync(file, 'utf8')).split('\n').entries()) {
        for (const piece of FORBIDDEN) if (line.includes(piece)) hits.push(`${rel}:${String(index + 1)} → ${piece}`)
      }
    }
    return hits
  }
  const files = [...collect(join(root, 'ui-shell/src')), ...collect(join(root, 'src/ui'))]
  check('扫到了源码（不是空目录）', files.length > 100, String(files.length))
  const hits = scan(files)
  check(`壳与界面核心里没有禁用的新 API（扫了 ${String(files.length)} 个文件）`, hits.length === 0, hits.slice(0, 4).join(' | '))
  // 负向验证：把一段人造源码塞进扫描器，必须被抓到（否则这条闸是空转的）。
  const probeFile = join(root, 'ui-shell/src/__probe__.ts')
  const caught = (() => {
    const hits = []
    for (const [index, line] of uncomment('const a = rows.findLast((r) => r.ok)\n').split('\n').entries()) {
      for (const piece of FORBIDDEN) if (line.includes(piece)) hits.push(`${String(index + 1)}:${piece}`)
    }
    return hits
  })()
  void probeFile
  check('负向：人造的 findLast 调用会被抓到', caught.length === 1 && caught[0].includes('.findLast('), JSON.stringify(caught))

  const compat = read('ui-shell/src/ui-primitives/compat.ts')
  check('替身模块导出了 findLast', compat.includes('export function findLast'))
  check('替身带类型谓词重载（调用处的收窄照旧成立）', compat.includes('item is S'))
  const barrel = read('ui-shell/src/ui-primitives/index.ts')
  check('替身从基元库转出去（插件与壳都拿得到）', barrel.includes("export * from './compat'"))
  const transcript = read('ui-shell/src/plugins/transcript/ui.tsx')
  check('正文区改用替身（import 自 @dsc/ui-primitives）', transcript.includes('findLast') && transcript.includes("from '@dsc/ui-primitives'"))
  check('正文区不再直接调 .findLast(', !uncomment(transcript).includes('.findLast('))
}

console.log('[2] AbortSignal：超时闸是手写的')
{
  const channel = read('ui-shell/src/ui-layout/host-channel.ts')
  const code = uncomment(channel)
  check('不再用 AbortSignal.timeout / AbortSignal.any', !code.includes('AbortSignal.timeout(') && !code.includes('AbortSignal.any('))
  check('用 AbortController 自建闸', code.includes('new AbortController()'))
  check('超时走 setTimeout', code.includes('setTimeout('))
  check('收尾清掉计时器（finally 里 clearTimeout）', /finally \{[\s\S]{0,80}clearTimeout\(timer\)/.test(code))
  check('外部取消信号转发进来（addEventListener 转发 + 收尾摘掉）', code.includes("outside?.addEventListener('abort', forwardAbort)") && code.includes("outside?.removeEventListener('abort', forwardAbort)"))
  check('进来前就已取消的信号也认（aborted 预判）', code.includes('outside?.aborted === true'))
  check('超时与外部取消分得开（报错类型不同）', code.includes("timedOut ? 'timeout' : 'aborted'"))
  check('fetch 拿的是闸的 signal', code.includes('signal: gate.signal'))
}

console.log('[3] inset 兜底：整屏遮罩')
{
  const styles = flat(read('ui-shell/src/styles.css'))
  const block = /@supports not \(inset: 0\) \{([\s\S]*?)\n\}/.exec(styles)
  check('styles.css 里有 @supports not (inset: 0) 兜底块', block !== null)
  const masks = ['dsc-overlay', 'menu-backdrop', 'pop-mask', 'git-dialog-backdrop', 'overlay']
  const inner = block === null ? '' : block[1]
  check('五张整屏遮罩都点名了', masks.every((name) => inner.includes(`.${name}`)), masks.filter((n) => !inner.includes(`.${n}`)).join(','))
  check('兜底写的是四个方向（不是又写一遍 inset）', inner.includes('top: 0') && inner.includes('left: 0') && !inner.includes('inset:'))
  // 与 legacy 那侧对账：兜底点的名字必须在 legacy 里真的是 `inset: 0` 的规则，
  // 否则这条兜底会变成僵尸（名字改了没人发现）。
  const legacy = flat(read('ui-shell/src/legacy/views.css')) + flat(read('ui-shell/src/legacy/primitives.css'))
  const stale = masks.filter((name) => !new RegExp(`\\.${name}\\s*\\{[^}]*inset:\\s*0`).test(legacy))
  check('这些名字在 legacy 里确实还是 inset: 0（兜底没变僵尸）', stale.length === 0, stale.join(','))
}

console.log('[4] 窄屏规则：输入行、状态栏、停靠区')
{
  const styles = flat(read('ui-shell/src/styles.css'))
  /** 取 `@media (max-width: Npx)` 里**含某段文字**的那一块（同一档可能不止一处）。 */
  const mediaBlock = (width, marker) => {
    const all = [...styles.matchAll(new RegExp(`@media \\(max-width: ${String(width)}px\\) \\{([\\s\\S]*?)\\n\\}`, 'g'))]
    return all.map((m) => m[1]).find((body) => body.includes(marker)) ?? null
  }
  const block560 = mediaBlock(560, '.composer-bar .bar-left')
  const block860 = mediaBlock(860, '.sidebar:not(.rail)')
  check('≤560 那一档在（输入行那条）', block560 !== null)
  check('≤860 那一档在（侧栏让位那条）', block860 !== null)
  const small = block560 ?? ''
  const wide = block860 ?? ''

  check('输入行允许换行（左组一行、右组换行贴右）', /\.composer-bar \{[\s\S]*?flex-wrap: wrap/.test(small))
  check('两组都允许收缩（min-width: 0）', /\.composer-bar \.bar-left,\s*\n\s*\.composer-bar \.bar-right \{[\s\S]*?min-width: 0/.test(small))
  check('chip 里的名字不竖着排（white-space: nowrap 写在钮上）', /\.model-btn \{[\s\S]*?white-space: nowrap/.test(small))
  check('输入区左右内距在窄屏收窄', /\.composer-zone \{[\s\S]*?padding: 0 12px 8px/.test(small))
  check('状态栏悬浮卡与正文把手在窄屏藏掉（横向溢出的两个来源）', /\.statusbar \.ctx-card,\s*\n\s*\.thread-handle \{\s*\n\s*display: none/.test(small))

  check('停靠区在窄屏整块不给', /\.dock,\s*\n\s*\.dock-toggle \{\s*\n\s*display: none/.test(wide))
  // 死选择器门：`.dock-slot` 这个类名在壳里不存在（dock 重构后没了），规则打在它身上等于没写。
  const deadDockSlot = (text) => /\.dock-slot\s*\{/.test(text)
  check('负向：`dock-slot { … }` 这种死规则会被抓到', deadDockSlot('.dock-slot {\n  display: none;\n}'))
  const shellFiles = collect(join(root, 'ui-shell/src'))
  const deadHits = shellFiles.filter((file) => deadDockSlot(flat(readFileSync(file, 'utf8')))).map((f) => f.slice(root.length))
  check('壳源码里没有打在 .dock-slot 上的规则', deadHits.length === 0, deadHits.join(','))
  const assetsDir = join(root, 'lib/ui/assets')
  const builtCss = (() => {
    try {
      return readdirSync(assetsDir)
        .filter((f) => f.endsWith('.css'))
        .map((f) => readFileSync(join(assetsDir, f), 'utf8'))
        .join('\n')
    } catch {
      return ''
    }
  })()
  check('产物里也没有 .dock-slot（跑过壳构建时）', builtCss === '' || !builtCss.includes('.dock-slot'))
  check('产物里带着窄屏那两条（跑过壳构建时）', builtCss === '' || (builtCss.includes('flex-wrap:wrap') && builtCss.includes('.dock,.dock-toggle')))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
