/**
 * 「分区并进某一页」（注册契约的 parent 位）的探针（2026-11-06）。
 *
 * 用户要求：设置左导航里不再单列「终端环境」，内容并进「通用」页，交互一项不少。
 * 实现刻意**不在界面壳里写「如果是 terminal-env 就…」**：tools-default 在自己的分区
 * 声明里写 `parent: 'general'`，界面壳只按宿主给的声明把子分区整块画到父页末尾。
 * 这个探针就钉这条边界：
 *
 *   1. 宿主侧：terminal-env 仍注册、仍 builtin、parent=general、字段与 order 不变；
 *   2. 路由：读写与按钮动作仍按**子分区自己的 id** 走（并在父页里不改写口）；
 *   3. 切换后检测结果真的跟着变（「（当前）」标记落到新选的那一档）；
 *   4. 界面侧：ui-settings 里没有 terminal-env / tools-default 这类硬编名字，
 *      导航按 parent 链滤掉子分区、父页按声明渲染子分区；
 *   5. 中英字典两侧键一一对应（tools-default 与 ui-settings）。
 *
 * 全部跑在临时 HOME 上，真实 ~/.dsc 一个字节都不动。
 * 用法：`pnpm run build && node scripts/settings-embed-slot-test.mjs`
 *
 * @module dsc/scripts/settings-embed-slot-test
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'dsc-settings-embed-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
// 内核装配需要一个能读的 config.yaml，不连真模型。
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')

const { createKernel } = await import('../lib/host/kernel.js')
const env = await import('../lib/core/terminal-env.js')

let passed = 0
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const kernel = await createKernel({ config: {}, resumeSessionPath: undefined })

console.log('[1] 宿主侧：分区还在，但它并进了「通用」')
const sections = kernel.settings.sections()
const terminal = sections.find((section) => section.id === 'terminal-env')
const general = sections.find((section) => section.id === 'general')
check('terminal-env 分区仍注册着', terminal !== undefined, JSON.stringify(sections.map((section) => section.id)))
check('仍进设置页（builtin=true，壳的第一道筛子）', terminal?.builtin === true, String(terminal?.builtin))
check('仍是通用表单（custom=false）', terminal?.custom === false, String(terminal?.custom))
check('parent 指向 general', terminal?.parent === 'general', String(terminal?.parent))
check('「通用」自己不在任何页里', general?.parent === undefined, String(general?.parent))
check('order 没变（仍是 6，TUI 那边位次不动）', terminal?.order === 6, String(terminal?.order))
const fields = terminal?.fields ?? []
check('字段没缩水：下拉 + 检测结果 + 按钮', fields.map((field) => field.type).join(',') === 'select,info,button', JSON.stringify(fields.map((field) => field.type)))

console.log('\n[2] 界面壳的导航规则：有权重的那一条')
const navIds = sections.filter((section) => section.parent === undefined).map((section) => section.id)
check('按 parent 过滤后导航里没有 terminal-env', !navIds.includes('terminal-env'), JSON.stringify(navIds))
check('按 parent 过滤后 general 还在', navIds.includes('general'))

console.log('\n[3] 读写仍按子分区自己的 id 走')
const options = fields.find((field) => field.type === 'select')?.options ?? []
const target = options.find((option) => option.value === 'gitbash') !== undefined ? 'gitbash' : options[1]?.value
const saved = await kernel.settings.save('terminal-env', 'bashShell', target)
check('保存成功且带回执', saved.ok === true && (saved.notice ?? '').includes('下一条命令起生效'), JSON.stringify(saved))
const values = await kernel.settings.values('terminal-env')
check('回读的是刚存的那一档', values.bashShell === target, String(values.bashShell))

console.log('\n[4] 切换之后检测结果跟着刷新（右侧「当前：…」换成新选的那一档）')
const refreshed = kernel.settings.sections().find((section) => section.id === 'terminal-env')
const infoField = (refreshed?.fields ?? []).find((field) => field.type === 'info')
const infoText = infoField?.text ?? ''
const infoHelp = infoField?.help ?? ''
const label = env.shellChoiceLabel(target)
const allLabels = env.detectShells().map((item) => item.label)
check('检测结果这一行还在（说明里是完整列表）', (infoHelp.match(/[✓✗]/g) ?? []).length >= 3, infoHelp)
check(`右侧写的是当前这一档（当前：${label}）`, infoText.includes('当前：') && infoText.includes(label), infoText)
check('右侧不带 ✓/✗（可用性只由左栏列表说，不互相复述）', !/[✓✗]/.test(infoText), infoText)
check('右侧不重复列表里的其它 shell 名（一行只说一件事）', allLabels.filter((name) => name !== label).every((name) => !infoText.includes(name)), infoText)
check('整张 ✓/✗ 列表在说明里（可折行，不会被单行省略截掉）', (infoHelp.match(/[✓✗]/g) ?? []).length >= 3 && infoHelp.includes(label), infoHelp)
const redetected = await kernel.settings.action('terminal-env', 'redetect')
check('「重新检测」按钮仍按子分区 id 生效', redetected.ok === true && (redetected.notice ?? '').includes('重新检测完成'), JSON.stringify(redetected))

console.log('\n[5] 界面壳里没有硬编具体插件')
const shell = read('src/packages/ui-settings/ui/ui.tsx')
check("ui-settings 源码里没有 'terminal-env' 字面量（注释里提一句不算硬编）", !/['"]terminal-env['"]/.test(shell))
check("ui-settings 源码里没有 'tools-default' 字面量", !/['"]tools-default['"]/.test(shell))
check('导航按 parent 链滤掉子分区（通用规则，不点名）', /\.filter\(\(section\) => pageOf\(byId, section\.id\) === section\.id\)/.test(shell))
check('父页按声明渲染子分区（pages.get(section.id)）', /\(pages\.get\(section\.id\) \?\? \[\]\)\.map/.test(shell))
check('子分区那一块自带标题与说明', /<div className="settings-group-title">\{section\.title\}<\/div>/.test(shell))
check('子分区控件复用同一个渲染器（GenericFields）', /<GenericFields section=\{section\} onChanged=\{onChanged\} \/>/.test(shell))
check('写回成功后通知父页重取分区清单（三处：两处保存与按钮动作）', (shell.match(/onChanged\?\.\(\)/g) ?? []).length === 3, String((shell.match(/onChanged\?\.\(\)/g) ?? []).length))
const tools = read('src/packages/tools-default/index.ts')
check('tools-default 自己声明 parent: general', /parent: 'general',/.test(tools))
check('tools-default 的检测结果写「当前：…」', /field\.detected\.currentValue/.test(tools))

console.log('\n[6] 中英字典两侧键一一对应')
const localeOf = (pkg) => ({
  zh: JSON.parse(read(`src/packages/${pkg}/locale/ui.zh.json`)),
  en: JSON.parse(read(`src/packages/${pkg}/locale/ui.en.json`)),
})
for (const pkg of ['tools-default', 'ui-settings']) {
  const { zh, en } = localeOf(pkg)
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  check(
    `${pkg}：两侧键数相同且一一对应`,
    zhKeys.length === enKeys.length && zhKeys.every((key, index) => key === enKeys[index]),
    `zh=${String(zhKeys.length)} en=${String(enKeys.length)}`,
  )
}
const toolsLocale = localeOf('tools-default')
for (const key of ['section.shell.title', 'section.shell.subtitle', 'field.detected.currentValue']) {
  check(
    `tools-default：${key} 中英都有且英文非空`,
    typeof toolsLocale.zh[key] === 'string' && toolsLocale.zh[key] !== '' && typeof toolsLocale.en[key] === 'string' && toolsLocale.en[key] !== '',
    String(toolsLocale.en[key]),
  )
}

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? `\n全部通过：${String(passed)} 条` : `\n失败 ${String(failures)} 条，通过 ${String(passed)} 条`)
process.exit(failures === 0 ? 0 : 1)
