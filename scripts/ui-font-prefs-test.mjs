/**
 * 正文字体 / 代码字体 / 正文字号（px）读档的确定性测试。
 *
 * 为什么要有这一条：2026-11 把字号的**真源**从「倍率」换成了「像素」（`ui.textSizePx`），
 * 同时加了正文与代码两套字体列表。这一步要同时兼容三种旧档：0.85–1.35 的数字倍率、
 * 0.6 之前的 `'sm' | 'md' | 'lg'` 三档字符串、以及完全没有字号键的老档——三种都得落到
 * 同一个 px 上。算错了用户只会看到「升级后字号跳了一档」，没人会想到是迁移换算的问题。
 *
 * 另一处容易漏的：`ui.fontSize` 现在只是派生值（px ÷ 14）。档里存着旧倍率时必须按 px
 * 重算，不能「档里写了什么就信什么」，否则会出现设置页显示 16px、界面按旧倍率画 14px。
 *
 * 跑法：node scripts/ui-font-prefs-test.mjs（先 pnpm run build，它 import 的是 lib/）
 *
 * @module dsc/scripts/ui-font-prefs-test
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
/** 读仓库里的源文件（接线检查用；真行为用下面的动态 import 跑）。 */
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

// 先钉住 DSC_HOME，再动态 import：prefs 的 settings.json 路径是模块求值时算出来的。
const home = mkdtempSync(join(tmpdir(), 'dsc-ui-font-prefs-'))
process.env.DSC_HOME = home
const { DSC_SETTINGS_JSON, readPrefs, writePrefs } = await import('../lib/core/prefs.js')

let passed = 0
let failed = 0

/**
 * 记一条断言。
 *
 * @param {string} name 断言名（中文，报表里直接读）
 * @param {boolean} ok 是否通过
 * @param {string} detail 失败时附上的读数
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ok  ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL  ${name}${detail === '' ? '' : `  <- ${detail}`}`)
}

/**
 * 造一份 settings.json。
 *
 * @param {object} doc 文件内容
 */
function writeSettings(doc) {
  mkdirSync(dirname(DSC_SETTINGS_JSON), { recursive: true })
  writeFileSync(DSC_SETTINGS_JSON, JSON.stringify(doc), 'utf8')
}

/**
 * 倍率断言用：允许最后一位的四舍五入误差（实现里保留 4 位小数）。
 *
 * @param {number} actual 读出来的倍率
 * @param {number} expected 期望值
 * @returns {boolean} 是否在 1e-9 内相等
 */
function near(actual, expected) {
  return typeof actual === 'number' && Math.abs(actual - expected) < 1e-9
}

console.log('\n[1] 空档：出厂 14px、两套字体空串、倍率 1')
{
  writeSettings({})
  const ui = readPrefs().ui
  check('textSizePx 出厂 14', ui.textSizePx === 14, String(ui.textSizePx))
  check('正文（会话/界面）字体出厂空串', ui.textFontFamily === '', JSON.stringify(ui.textFontFamily))
  check('代码字体出厂空串', ui.codeFontFamily === '', JSON.stringify(ui.codeFontFamily))
  check('fontSize 是派生值 1（14 ÷ 14）', ui.fontSize === 1, String(ui.fontSize))
}

console.log('\n[2] 旧档迁移：倍率与三档字符串都换算成 px')
{
  writeSettings({ ui: { fontSize: 1.12 } })
  let ui = readPrefs().ui
  check('旧倍率 1.12 → 16px（1.12 × 14 = 15.68）', ui.textSizePx === 16, String(ui.textSizePx))
  check('倍率同步重算成 1.1429', near(ui.fontSize, 1.1429), String(ui.fontSize))

  writeSettings({ ui: { fontSize: 'lg' } })
  ui = readPrefs().ui
  check("旧档 'lg' → 16px", ui.textSizePx === 16, String(ui.textSizePx))

  writeSettings({ ui: { fontSize: 'md' } })
  ui = readPrefs().ui
  check("旧档 'md' → 14px", ui.textSizePx === 14, String(ui.textSizePx))

  writeSettings({ ui: { fontSize: 'sm' } })
  ui = readPrefs().ui
  check("旧档 'sm' → 13px（0.92 × 14 = 12.88）", ui.textSizePx === 13, String(ui.textSizePx))

  writeSettings({ ui: { fontSize: 0.5 } })
  ui = readPrefs().ui
  check('旧倍率越低越界 0.5 夹到 0.85 → 12px', ui.textSizePx === 12, String(ui.textSizePx))

  writeSettings({ ui: { fontSize: 9 } })
  ui = readPrefs().ui
  check('旧倍率越高越界 9 夹到 1.35 → 19px', ui.textSizePx === 19, String(ui.textSizePx))

  writeSettings({ ui: { fontSize: '大' } })
  ui = readPrefs().ui
  check("认不出的 '大' → 14px（不是 0px、不拦启动）", ui.textSizePx === 14, String(ui.textSizePx))

  writeSettings({ ui: { fontSize: null } })
  ui = readPrefs().ui
  check('null（JSON 里 NaN 的样子）→ 14px', ui.textSizePx === 14, String(ui.textSizePx))

  writeSettings({ ui: {} })
  ui = readPrefs().ui
  check('缺键 → 14px', ui.textSizePx === 14, String(ui.textSizePx))

  // 整份文件不是合法 JSON 时 JSON.parse 就炸了，连 ui 都读不到：必须回落出厂值，不许抛。
  mkdirSync(dirname(DSC_SETTINGS_JSON), { recursive: true })
  writeFileSync(DSC_SETTINGS_JSON, '{"ui":{"fontSize":NaN}}', 'utf8')
  ui = readPrefs().ui
  check('坏文件（JSON 里裸写 NaN）→ 14px，不抛错', ui.textSizePx === 14, String(ui.textSizePx))
}

console.log('\n[3] 新键优先，fontSize 永远按 px 重算（不信档里的旧倍率）')
{
  writeSettings({ ui: { textSizePx: 18, fontSize: 1.12 } })
  const ui = readPrefs().ui
  check('两个键都在时以 textSizePx 为准（18）', ui.textSizePx === 18, String(ui.textSizePx))
  check('档里的旧倍率 1.12 被忽略，重算成 1.2857', near(ui.fontSize, 1.2857), String(ui.fontSize))
}

console.log('\n[4] px 夹取与取整（设置页滑杆之外还有手改档这条路）')
{
  writeSettings({ ui: { textSizePx: 30 } })
  check('30 夹到上限 22', readPrefs().ui.textSizePx === 22, String(readPrefs().ui.textSizePx))

  writeSettings({ ui: { textSizePx: 3 } })
  check('3 夹到下限 10', readPrefs().ui.textSizePx === 10, String(readPrefs().ui.textSizePx))

  writeSettings({ ui: { textSizePx: 16.6 } })
  const ui = readPrefs().ui
  check('16.6 取整成 17', ui.textSizePx === 17, String(ui.textSizePx))
  check('17px 的倍率是 1.2143', near(ui.fontSize, 1.2143), String(ui.fontSize))

  writeSettings({ ui: { textSizePx: '16' } })
  check('字符串 "16" 不当 px，回落 14', readPrefs().ui.textSizePx === 14, String(readPrefs().ui.textSizePx))

  writeSettings({ ui: { textSizePx: 22 } })
  check('22px 的倍率是 1.5714（不只夹取，派生值也要跟着变）', near(readPrefs().ui.fontSize, 1.5714), String(readPrefs().ui.fontSize))
}

console.log('\n[5] 字体列表归一（这串值最终进 CSS 变量）')
{
  writeSettings({ ui: { textFontFamily: 'Noto Sans SC, "Segoe UI"' } })
  check(
    '含空格的族自动加双引号、原引号剥掉',
    readPrefs().ui.textFontFamily === '"Noto Sans SC", "Segoe UI"',
    JSON.stringify(readPrefs().ui.textFontFamily),
  )

  writeSettings({ ui: { textFontFamily: 'Inter, inter, INTER' } })
  check('重复项不区分大小写去重（留第一个的写法）', readPrefs().ui.textFontFamily === 'Inter', JSON.stringify(readPrefs().ui.textFontFamily))

  writeSettings({ ui: { textFontFamily: 'Inter;{}, Fallback' } })
  check('`;` 与 `{}` 被剔掉，不是整条丢弃', readPrefs().ui.textFontFamily === 'Inter, Fallback', JSON.stringify(readPrefs().ui.textFontFamily))

  writeSettings({ ui: { codeFontFamily: "'JetBrains Mono', 等宽字体" } })
  check(
    '单引号也剥掉，中文族名不加引号',
    readPrefs().ui.codeFontFamily === '"JetBrains Mono", 等宽字体',
    JSON.stringify(readPrefs().ui.codeFontFamily),
  )

  // 每条 26 字符、共 10 条：单条没超 64，整串超过 200 —— 挡的是「半截列表」。
  const longList = Array.from({ length: 10 }, (_, index) => `Font${String(index).padStart(2, '0')}${'x'.repeat(20)}`).join(', ')
  writeSettings({ ui: { textFontFamily: longList } })
  check('整串超过 200 字符 → 空串（不截断）', readPrefs().ui.textFontFamily === '', JSON.stringify(readPrefs().ui.textFontFamily))

  writeSettings({ ui: { textFontFamily: 'A'.repeat(70) } })
  check('单个族名超过 64 字符 → 空串', readPrefs().ui.textFontFamily === '', JSON.stringify(readPrefs().ui.textFontFamily))

  writeSettings({ ui: { textFontFamily: ', ,,' } })
  check('只有逗号 → 空串', readPrefs().ui.textFontFamily === '', JSON.stringify(readPrefs().ui.textFontFamily))

  writeSettings({ ui: { textFontFamily: 42 } })
  check('非字符串 → 空串', readPrefs().ui.textFontFamily === '', JSON.stringify(readPrefs().ui.textFontFamily))

  const nine = Array.from({ length: 9 }, (_, index) => `F${String(index + 1)}`).join(', ')
  writeSettings({ ui: { codeFontFamily: nine } })
  check('最多认 8 个族，多的忽略', readPrefs().ui.codeFontFamily.split(', ').length === 8, JSON.stringify(readPrefs().ui.codeFontFamily))
}

console.log('\n[6] 写盘往返：改 px 落盘，重读时倍率跟着重算')
{
  writeSettings({ ui: { textFontFamily: 'Inter', codeFontFamily: 'Mono' } })
  const before = readPrefs().ui
  writePrefs({ ui: { ...before, textSizePx: 18 } })
  const after = readPrefs().ui
  check('textSizePx 读回 18', after.textSizePx === 18, String(after.textSizePx))
  check('fontSize 读回 1.2857（18 ÷ 14）', near(after.fontSize, 1.2857), String(after.fontSize))
  check('两套字体没被写盘抹掉', after.textFontFamily === 'Inter' && after.codeFontFamily === 'Mono', `${after.textFontFamily} / ${after.codeFontFamily}`)
  const doc = JSON.parse(readFileSync(DSC_SETTINGS_JSON, 'utf8'))
  check('落盘的就是 px（不是换算回倍率）', doc.ui.textSizePx === 18, String(doc.ui.textSizePx))
  check('落盘的字体是归一后的那串', doc.ui.textFontFamily === 'Inter', JSON.stringify(doc.ui.textFontFamily))
}

console.log('\n[7] 接线检查（读档之外的两处）')
{
  const session = read('src/contract/session.ts')
  check(
    '契约里有 textSizePx / textFontFamily / codeFontFamily 三个字段',
    session.includes('textSizePx: number') && session.includes('textFontFamily: string') && session.includes('codeFontFamily: string'),
  )
  const runtime = read('src/packages/runtime/index.ts')
  check(
    '运行期把 px 字号与两套字体也算进「已保存外观设置」',
    runtime.includes('patch.textSizePx !== undefined') &&
      runtime.includes('patch.textFontFamily !== undefined') &&
      runtime.includes('patch.codeFontFamily !== undefined'),
  )
  check('壳与设置页共用契约里那份 normalizeFontList（不再各写一份）', read('src/packages/ui-core/index.ts').includes('normalizeFontList'))
  // 运行期写盘前必须先把 px 归一、再派生倍率：同一次会话里 setUiPrefs({textSizePx:30})
  // 若只归一派生值，落盘的 px 会是 30、界面按 22 画，要等下次读档才对上。
  check(
    '运行期先归一 textSizePx 再派生倍率（落盘与界面同源）',
    runtime.includes('next.textSizePx = normalizeTextSizePx(next.textSizePx)') &&
      runtime.indexOf('next.textSizePx = normalizeTextSizePx(next.textSizePx)') < runtime.indexOf('next.fontSize = fontScaleFromTextSizePx(next.textSizePx)'),
  )
}

console.log(`\n${String(passed)}/${String(passed + failed)} 通过`)
process.exit(failed === 0 ? 0 : 1)
