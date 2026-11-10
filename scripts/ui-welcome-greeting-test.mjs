/**
 * 空会话首屏那句招呼语的确定性探针。
 *
 * 2026-11-10 用户要求放弃原来「9 组 × 5 句」的方案，改成 zcode 的按时段一句 +
 * codex 的「不寒暄，只给下一步」：问候语只按现在几点挑一句，每段一句；「能干什么」
 * 交给首屏那行提示和四张卡。判定在 `ui/greeting.ts`（纯函数，这里直接 import），
 * 文案在 `ui-transcript/locale/ui.zh.json` 与 `welcome.tsx` 的字面量表里。
 *
 * 五段：
 *   [1] 文案表：六段各一句，中英键集一致，长度不超上限，渲染处逐句字面量取词；
 *   [2] 时段边界：05 清晨、09 上午、12 中午、14 下午、18 晚上、23 深夜（左闭右开）；
 *   [3] 接线钉：读数由 ui.tsx 递进来、首屏 H1 用查出来的那一句、样式有折行兜底；
 *   [4] 老方案已撤：不再有「组 + 序号」的池子，也不再按周末 / 久未用 / 头一回分岔；
 *   [5] 换档定时：到整点才换、永远给正数，一天里六段依次走过。
 *
 * 不碰磁盘上的 `~/.dsc`：整个探针只读仓库里的几份文件。
 *
 * 跑法：node scripts/ui-welcome-greeting-test.mjs（check:ui 自动收录）
 *
 * @module dsc/scripts/ui-welcome-greeting-test
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readSource } from './_source.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const localeDir = join(root, 'src', 'packages', 'ui-transcript', 'locale')
const uiDir = join(root, 'src', 'packages', 'ui-transcript', 'ui')

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

const { greetingSlot, nextGreetingBoundaryDelayMs } = await import(pathToFileURL(join(uiDir, 'greeting.ts')).href)

/** 两份字典。 */
const zh = JSON.parse(readFileSync(join(localeDir, 'ui.zh.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(localeDir, 'ui.en.json'), 'utf8'))

/** 六个时段的固定清单（与 `greeting.ts` 的 `GreetingSlot` 对齐）。 */
const SLOTS = ['earlyMorning', 'morning', 'noon', 'afternoon', 'evening', 'lateNight']

/** 一周里的某一天：`2026-11-02` 起跳到第一个周二，所有用例都从它派生。 */
function weekdayAt(hour, minute = 0) {
  const at = new Date(2026, 10, 2, hour, minute, 0, 0)
  while (at.getDay() !== 2) at.setDate(at.getDate() + 1)
  return at
}

// ── 1. 文案表 ──────────────────────────────────────────────────────────────
console.log('[1] 文案表：六段各一句，中英对齐，长度不超上限')
{
  const KEY = /^transcript\.welcome\.hello\.([A-Za-z]+)$/
  const of = (dict) => Object.entries(dict).filter(([key]) => KEY.test(key))

  const zhKeys = of(zh).map(([key]) => key).sort()
  const enKeys = of(en).map(([key]) => key).sort()
  const expected = SLOTS.map((slot) => `transcript.welcome.hello.${slot}`).sort()

  check('中文表里正好是这六段', zhKeys.length === expected.length && zhKeys.every((key, i) => key === expected[i]), zhKeys.join(','))
  check('英文表里正好是这六段', enKeys.length === expected.length && enKeys.every((key, i) => key === expected[i]), enKeys.join(','))

  const problems = []
  for (const slot of SLOTS) {
    const value = zh[`transcript.welcome.hello.${slot}`]
    if (value === undefined || value.trim() === '') {
      problems.push(`${slot} 是空的`)
      continue
    }
    // 首屏那行是 28px 的 H1，一句超过 18 个字就要折行、首屏重心就散了。
    const length = [...value].length
    if (length > 18) problems.push(`${slot} 有 ${length} 个字`)
  }
  check('六句都非空、中文不超过 18 字', problems.length === 0, problems.slice(0, 4).join('；'))

  const enProblems = []
  for (const slot of SLOTS) {
    const value = en[`transcript.welcome.hello.${slot}`] ?? ''
    if ([...value].length > 64) enProblems.push(`${slot} 有 ${value.length} 个字符`)
    if (/[\u4e00-\u9fff]/.test(value)) enProblems.push(`${slot} 还是中文`)
  }
  check('英文不超过 64 字符、没有漏译', enProblems.length === 0, enProblems.slice(0, 4).join('；'))

  // 文案表在渲染处，且每一句都在：表里少一句，界面就 blank 一行。
  const welcome = readSource('src/packages/ui-transcript/ui/welcome.tsx')
  const missing = expected.filter((key) => !welcome.includes(`t('${key}')`))
  check('welcome.tsx 的文案表逐句用字面量取词', missing.length === 0, missing.slice(0, 4).join(','))
  check('渲染处按时段直接查表', /GREETING_TEXT\[slot\]/.test(welcome))
  check('首屏 H1 用查出来的那一句', /<h1>\{greetingLine\(greeting\)\}<\/h1>/.test(welcome))
}

// ── 2. 时段边界 ────────────────────────────────────────────────────────────
console.log('[2] 时段边界：左闭右开，深夜跨零点')
{
  const cases = [
    [0, 0, 'lateNight'],
    [4, 59, 'lateNight'],
    [5, 0, 'earlyMorning'],
    [8, 59, 'earlyMorning'],
    [9, 0, 'morning'],
    [11, 59, 'morning'],
    [12, 0, 'noon'],
    [13, 59, 'noon'],
    [14, 0, 'afternoon'],
    [17, 59, 'afternoon'],
    [18, 0, 'evening'],
    [22, 59, 'evening'],
    [23, 0, 'lateNight'],
  ]
  const wrong = cases.filter(([hour, minute, slot]) => greetingSlot({ at: weekdayAt(hour, minute) }) !== slot)
  check(
    `${cases.length} 个边界都对`,
    wrong.length === 0,
    wrong.map(([hour, minute, slot]) => `${hour}:${String(minute).padStart(2, '0')} 应为 ${slot}，实为 ${greetingSlot({ at: weekdayAt(hour, minute) })}`).join('；'),
  )
  const at = (hour) => greetingSlot({ at: weekdayAt(hour) })
  check('六个时段都各不相同', new Set([6, 10, 13, 15, 20, 23].map(at)).size === 6, [6, 10, 13, 15, 20, 23].map(at).join(','))
  check('同一天里问两次，答案一样', at(15) === at(15), `${at(15)}/${at(15)}`)
}

// ── 3. 接线钉 ──────────────────────────────────────────────────────────────
console.log('[3] 接线：时钟从 ui.tsx 递进来，样式有折行兜底')
{
  const ui = readSource('src/packages/ui-transcript/ui/ui.tsx')
  check('ui.tsx 按时段查表', /greetingSlot\(\{ at: greetingAt \}\)/.test(ui))
  check('ui.tsx 挂着到点重绘的定时器', /nextGreetingBoundaryDelayMs\(greetingAt\)/.test(ui) && /window\.setTimeout/.test(ui))
  check('ui.tsx 把结果递给首屏', /greeting=\{greeting\}/.test(ui))
  check('ui.tsx 不再递「有没有历史 / 隔了多久」两个老读数', !/hasHistory|longAbsence/.test(ui))
  const css = readSource('src/packages/ui-renderer/ui/styles/styles.css')
  check('首屏 H1 有折行兜底', /\.welcome h1 \{[^}]*text-wrap: balance/.test(css))
}

// ── 4. 老方案已撤 ──────────────────────────────────────────────────────────
console.log('[4] 老方案已撤：没有组内序号，也没有三个由头')
{
  const source = readSource('src/packages/ui-transcript/ui/greeting.ts')
  check('不再导出句数常量', !/GREETING_VARIANTS/.test(source))
  check('不再按周末 / 久未用 / 头一回分岔', !/weekend|returning|firstRun/.test(source))
  const numbered = Object.keys(zh).filter((key) => /^transcript\.welcome\.hello\.[A-Za-z]+\.\d+$/.test(key))
  const numberedEn = Object.keys(en).filter((key) => /^transcript\.welcome\.hello\.[A-Za-z]+\.\d+$/.test(key))
  check('两个字典都不留「组 + 序号」的旧键', numbered.length === 0 && numberedEn.length === 0, `${numbered.length} / ${numberedEn.length}`)
}

// ── 5. 换档定时 ────────────────────────────────────────────────────────────
console.log('[5] 换档定时：到整点才换，永远给正数')
{
  const at = (hour, minute = 0, second = 0) => {
    const date = weekdayAt(hour, minute)
    date.setSeconds(second, 0)
    return date
  }
  const toMinutes = (ms) => Math.round(ms / 60_000)

  check('08:59 挂 1 分钟，09:00 换档', nextGreetingBoundaryDelayMs(at(8, 59)) === 60_000, `${nextGreetingBoundaryDelayMs(at(8, 59))}`)
  check('04:59:30 只挂 30 秒', nextGreetingBoundaryDelayMs(at(4, 59, 30)) === 30_000, `${nextGreetingBoundaryDelayMs(at(4, 59, 30))}`)
  check('23:30 挂到次日 05:00（330 分钟）', toMinutes(nextGreetingBoundaryDelayMs(at(23, 30))) === 330, `${toMinutes(nextGreetingBoundaryDelayMs(at(23, 30)))}`)
  // 正好卡在边界上时给下一个边界；给 0 会让定时器原地空转，每一帧重绘一次。
  check('09:00:00 给的是 3 小时后，不是 0', nextGreetingBoundaryDelayMs(at(9)) === 3 * 3_600_000, `${nextGreetingBoundaryDelayMs(at(9))}`)

  let shortest = Infinity
  let longest = 0
  for (const hour of [0, 4, 5, 8, 9, 11, 12, 13, 14, 17, 18, 22, 23]) {
    for (const minute of [0, 1, 30, 59]) {
      const delay = nextGreetingBoundaryDelayMs(at(hour, minute, 7))
      shortest = Math.min(shortest, delay)
      longest = Math.max(longest, delay)
    }
  }
  check('间隔始终是正数，最长不超过 6 小时', shortest >= 1 && longest <= 6 * 3_600_000, `${shortest} → ${longest}`)

  // 一天里逐次按定时器走：醒来 6 次，正好撤换 6 段。
  let cursor = at(0, 0, 0)
  const seen = [greetingSlot({ at: cursor })]
  for (let i = 0; i < 12; i += 1) {
    cursor = new Date(cursor.getTime() + nextGreetingBoundaryDelayMs(cursor))
    seen.push(greetingSlot({ at: cursor }))
  }
  const firstDay = seen.slice(0, 7).join('>')
  check(
    '一整天按定时器走，六段依次换过',
    firstDay === 'lateNight>earlyMorning>morning>noon>afternoon>evening>lateNight',
    firstDay,
  )
}

console.log('')
console.log(`首屏招呼语：${passed} 条通过，${failures} 条失败`)
process.exit(failures === 0 ? 0 : 1)
