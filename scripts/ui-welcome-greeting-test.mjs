/**
 * 空会话首屏那句招呼语的确定性探针。
 *
 * 用户要求：那句「从一个任务开始」太单薄，要按时间段换，还要照顾周末、隔了些天回来、
 * 头一回打开这三种由头。实现拆成两半：判定在 `ui/greeting.ts`（纯函数，这里直接 import），
 * 文案在 `ui-transcript/locale/ui.zh.json` 与 `welcome.tsx` 的字面量表里。
 *
 * 五段：
 *   [1] 文案表：九组各五句，中英键集一致，老的单句键已撤，句子长度不超上限；
 *   [2] 时段边界：05:00 算清晨、08:00 才算上午，深夜跨零点（不单独判会落进上午）；
 *   [3] 三个由头的优先级：头一回 > 久未使用 > 周末 > 时段；
 *   [4] 换句规则：同一天同一组固定，隔天换一句，相邻组错开，序号永远在范围内；
 *   [5] 接线钉：表在渲染处被查到、读数由 ui.tsx 递进去、样式有折行兜底。
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

const { greetingSlot, GREETING_VARIANTS } = await import(pathToFileURL(join(uiDir, 'greeting.ts')).href)

/** 两份字典。 */
const zh = JSON.parse(readFileSync(join(localeDir, 'ui.zh.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(localeDir, 'ui.en.json'), 'utf8'))

/** 九个组的固定清单（与 `greeting.ts` 的 `GreetingSlot` 对齐）。 */
const SLOTS = [
  'earlyMorning',
  'morning',
  'noon',
  'afternoon',
  'evening',
  'lateNight',
  'weekend',
  'returning',
  'firstRun',
]

/** 一周里的某一天：`2026-11-02` 起跳到第一个周二，后面「只按时段」的用例都从它派生。 */
function weekdayAt(hour, minute = 0) {
  const at = new Date(2026, 10, 2, hour, minute, 0, 0)
  while (at.getDay() !== 2) at.setDate(at.getDate() + 1)
  return at
}

/** 同一时刻换一天（只动日，时辰不动）。 */
function plusDays(at, days) {
  const next = new Date(at.getTime())
  next.setDate(next.getDate() + days)
  return next
}

// ── 1. 文案表 ──────────────────────────────────────────────────────────────
console.log('[1] 文案表：九组各五句，中英对齐，长度不超上限')
{
  const KEY = /^transcript\.welcome\.hello\.([A-Za-z]+)\.([1-9])$/
  const collect = (dict) => {
    const out = new Map()
    for (const [key, value] of Object.entries(dict)) {
      const hit = KEY.exec(key)
      if (hit === null) continue
      const list = out.get(hit[1]) ?? []
      list.push({ n: Number(hit[2]), key, value })
      out.set(hit[1], list)
    }
    return out
  }
  const zhGroups = collect(zh)
  const enGroups = collect(en)

  check('九个组都在中文表里', SLOTS.every((slot) => zhGroups.has(slot)) && zhGroups.size === SLOTS.length, [...zhGroups.keys()].join(','))
  check('九个组都在英文表里', SLOTS.every((slot) => enGroups.has(slot)) && enGroups.size === SLOTS.length, [...enGroups.keys()].join(','))

  const problems = []
  for (const slot of SLOTS) {
    const list = [...(zhGroups.get(slot) ?? [])].sort((a, b) => a.n - b.n)
    if (list.length !== GREETING_VARIANTS) problems.push(`${slot} 有 ${list.length} 句，要求 ${GREETING_VARIANTS}`)
    const numbers = list.map((item) => item.n).join(',')
    if (numbers !== '1,2,3,4,5') problems.push(`${slot} 的句号是 ${numbers}`)
    for (const item of list) {
      // 首屏那行是 28px 的 H1，一句超过 18 个字就要折行、首屏重心就散了。
      const length = [...item.value].length
      if (length > 18) problems.push(`${item.key} 有 ${length} 个字`)
      if (item.value.trim() === '') problems.push(`${item.key} 是空的`)
    }
  }
  check('每组五句、句号连续、中文不超过 18 字', problems.length === 0, problems.slice(0, 4).join('；'))

  const enProblems = []
  for (const slot of SLOTS) {
    for (const item of enGroups.get(slot) ?? []) {
      if ([...item.value].length > 64) enProblems.push(`${item.key} 有 ${item.value.length} 个字符`)
      if (/[\u4e00-\u9fff]/.test(item.value)) enProblems.push(`${item.key} 还是中文`)
    }
  }
  check('英文不超过 64 字符、没有漏译', enProblems.length === 0, enProblems.slice(0, 4).join('；'))

  const zhKeys = Object.keys(zh).filter((key) => KEY.test(key)).sort()
  const enKeys = Object.keys(en).filter((key) => KEY.test(key)).sort()
  check('中英的招呼语键完全一致', zhKeys.length === enKeys.length && zhKeys.every((key, i) => key === enKeys[i]), `${zhKeys.length} / ${enKeys.length}`)

  check(
    '老的单句键已撤掉（两个字典都不留）',
    !('transcript.welcome.title' in zh) && !('transcript.welcome.title' in en),
    [Object.hasOwn(zh, 'transcript.welcome.title'), Object.hasOwn(en, 'transcript.welcome.title')].join(','),
  )

  // 文案表在渲染处，且每一句都在：表里少一句，界面就 blank 一行。
  const welcome = readSource('src/packages/ui-transcript/ui/welcome.tsx')
  const missing = zhKeys.filter((key) => !welcome.includes(`t('${key}')`))
  check('welcome.tsx 的文案表逐句用字面量取词', missing.length === 0, missing.slice(0, 4).join(','))
  check('渲染处按「组 + 序号」查表', /GREETING_TEXT\[pick\.slot\]\[pick\.index\]/.test(welcome))
  check('首屏 H1 用查出来的那一句', /<h1>\{greetingLine\(greeting\)\}<\/h1>/.test(welcome))
}

// ── 2. 时段边界 ────────────────────────────────────────────────────────────
console.log('[2] 时段边界：左闭右开，深夜跨零点')
{
  const facts = { hasHistory: true, longAbsence: false }
  const cases = [
    [0, 0, 'lateNight'],
    [4, 59, 'lateNight'],
    [5, 0, 'earlyMorning'],
    [7, 59, 'earlyMorning'],
    [8, 0, 'morning'],
    [11, 59, 'morning'],
    [12, 0, 'noon'],
    [13, 59, 'noon'],
    [14, 0, 'afternoon'],
    [17, 59, 'afternoon'],
    [18, 0, 'evening'],
    [22, 59, 'evening'],
    [23, 0, 'lateNight'],
  ]
  const wrong = cases.filter(([hour, minute, slot]) => greetingSlot({ at: weekdayAt(hour, minute), ...facts }).slot !== slot)
  check(
    `${cases.length} 个整点边界都对`,
    wrong.length === 0,
    wrong.map(([hour, minute, slot]) => `${hour}:${String(minute).padStart(2, '0')} 应为 ${slot}，实为 ${greetingSlot({ at: weekdayAt(hour, minute), ...facts }).slot}`).join('；'),
  )
  const slotAt = (hour) => greetingSlot({ at: weekdayAt(hour), ...facts }).slot
  check('六个时段都各不相同', new Set([6, 9, 13, 15, 20, 23].map(slotAt)).size === 6, [6, 9, 13, 15, 20, 23].map(slotAt).join(','))
}

// ── 3. 三个由头的优先级 ───────────────────────────────────────────────────
console.log('[3] 优先级：头一回 > 久未使用 > 周末 > 时段')
{
  const saturday = (() => {
    const at = new Date(2026, 10, 2, 2, 0, 0, 0)
    while (at.getDay() !== 6) at.setDate(at.getDate() + 1)
    return at
  })()
  const sunday = plusDays(saturday, 1)
  check('基准日确实是周六、周日', saturday.getDay() === 6 && sunday.getDay() === 0, `${saturday.getDay()}/${sunday.getDay()}`)

  const slotOf = (at, hasHistory, longAbsence) => greetingSlot({ at, hasHistory, longAbsence }).slot
  check('头一回打开，周六凌晨也是第一次用', slotOf(saturday, false, false) === 'firstRun')
  check('头一回打开时「久未使用」不成立（没有历史）', slotOf(saturday, false, false) !== 'returning')
  check('隔了些天回来，压过周末', slotOf(saturday, true, true) === 'returning')
  check('隔了些天回来，压过时段', slotOf(weekdayAt(10), true, true) === 'returning')
  check('周六算周末', slotOf(saturday, true, false) === 'weekend')
  check('周日算周末', slotOf(sunday, true, false) === 'weekend')
  check('工作日按时段', slotOf(weekdayAt(10), true, false) === 'morning')
  check('工作日深夜按时段', slotOf(weekdayAt(2), true, false) === 'lateNight')
}

// ── 4. 换句规则 ────────────────────────────────────────────────────────────
console.log('[4] 换句：同一天固定，隔天换一句，相邻组错开')
{
  const at = weekdayAt(10)
  const first = greetingSlot({ at, hasHistory: true, longAbsence: false })
  const again = greetingSlot({ at: new Date(at.getTime()), hasHistory: true, longAbsence: false })
  check('同一时刻问两次，得到同一句', first.index === again.index, `${first.index}/${again.index}`)

  const tomorrow = greetingSlot({ at: plusDays(at, 1), hasHistory: true, longAbsence: false })
  check('隔一天，组内序号往前走一句', tomorrow.index === (first.index + 1) % GREETING_VARIANTS, `${first.index} → ${tomorrow.index}`)

  // 同一天里相邻两段（清晨→上午→中午→下午→晚上→深夜）的序号依次加一：
  // 这是 `ORDER` 的偏移在起作用，不这样的话六段永远共用同一句的序号。
  const indices = [6, 9, 13, 15, 20, 23].map((hour) => greetingSlot({ at: weekdayAt(hour), hasHistory: true, longAbsence: false }).index)
  const stepped = indices.every((value, i) => i === 0 || value === (indices[i - 1] + 1) % GREETING_VARIANTS)
  check('同一天里六段序号依次加一', stepped, indices.join(','))

  // 一年（闰年多算几天）逐日走一遍：序号永远在范围内，且每天只走一步。
  let inRange = true
  let walked = true
  let previous = greetingSlot({ at: weekdayAt(10), hasHistory: true, longAbsence: false }).index
  let cursor = weekdayAt(10)
  for (let i = 0; i < 400; i += 1) {
    cursor = plusDays(cursor, 1)
    const pick = greetingSlot({ at: cursor, hasHistory: true, longAbsence: false })
    if (pick.index < 0 || pick.index >= GREETING_VARIANTS) inRange = false
    const slot = pick.slot
    // 周末与工作日走的是不同的组，序号跳变不算错；只查工作日那一段。
    if (slot === 'morning' && pick.index !== (previous + 1) % GREETING_VARIANTS) walked = false
    previous = pick.index
  }
  check('400 天里序号始终在 0–4', inRange)
  check('400 天里每个工作日都只往前走一句', walked)
}

// ── 5. 接线钉 ──────────────────────────────────────────────────────────────
console.log('[5] 接线：读数从 ui.tsx 递进来，样式有折行兜底')
{
  const ui = readSource('src/packages/ui-transcript/ui/ui.tsx')
  check('ui.tsx 调 greetingSlot', /greetingSlot\(\{/.test(ui))
  check('ui.tsx 把结果递给首屏', /greeting=\{greeting\}/.test(ui))
  check('「久未使用」和「接着上次」读同一个窗口', (ui.match(/RECENT_WINDOW_MS/g) ?? []).length >= 3)
  check('历史会话排除当前这条与已归档的', /session\.id !== sessionPath && session\.archivedAt === undefined/.test(ui))
  const css = readSource('src/packages/ui-renderer/ui/styles/styles.css')
  check('首屏 H1 有折行兜底', /\.welcome h1 \{[^}]*text-wrap: balance/.test(css))
}

console.log('')
console.log(`首屏招呼语：${passed} 条通过，${failures} 条失败`)
process.exit(failures === 0 ? 0 : 1)
