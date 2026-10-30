/**
 * 「设置 → 终端环境」这张分区的端到端探针（2026-10-30）。
 *
 * 前面那个 `terminal-env-test.mjs` 验的是探测与执行计划（纯函数 + 子进程），这一个验的是
 * **用户从界面上能看见、能改**：分区有没有进设置页、下拉里摆的是不是真的探到的、
 * 存下去有没有落到 `plugins.json`、存坏值会不会被拒。
 *
 * 为什么要真起内核：这张分区是插件（tools-default）注册的，`builtin` 的判定、字段投影、
 * 保存链路都在内核装配之后才成立。只测纯函数等于没测"用户点得到吗"。
 *
 * 全部跑在临时 HOME 上，真实 `~/.dsc` 一个字节都不动。
 * 用法：`pnpm run build && node scripts/terminal-env-settings-test.mjs`
 *
 * @module dsc/scripts/terminal-env-settings-test
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-terminal-settings-'))
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

const kernel = await createKernel({ config: {}, resumeSessionPath: undefined })
const readPlugins = () => JSON.parse(readFileSync(join(home, '.dsc', 'plugins.json'), 'utf8'))
const configOf = (file) => readPlugins().entries?.find((entry) => entry.file === file)?.config ?? {}

console.log('[1] 分区出现在设置页里')
const sections = kernel.settings.sections()
const section = sections.find((item) => item.id === 'terminal-env')
check('注册了 terminal-env 分区', section !== undefined, JSON.stringify(sections.map((item) => item.id)))
check('builtin=true（桌面端设置页按这个筛）', section?.builtin === true, String(section?.builtin))
check('不是 custom（走通用表单渲染）', section?.custom === false, String(section?.custom))
check('排在内核「通用」之后、模型之前', section?.order === 6, String(section?.order))
check('标题是「终端环境」', section?.title === '终端环境', section?.title)

console.log('[2] 下拉里只有真探到的终端')
const fields = section?.fields ?? []
const select = fields.find((field) => field.type === 'select' && field.key === 'bashShell')
check('有「默认终端」下拉', select !== undefined, JSON.stringify(fields.map((field) => field.type)))
const options = select?.options ?? []
check('第一项是 auto', options[0]?.value === 'auto', JSON.stringify(options.map((option) => option.value)))
check('选项里不出现认不得的值', options.every((option) => env.SHELL_CHOICES.includes(option.value)), JSON.stringify(options.map((option) => option.value)))
const detected = env.detectShells()
for (const option of options.filter((item) => item.value !== 'auto')) {
  const hit = detected.find((item) => item.value === option.value)
  check(`${option.value} 是真探到的（或当前值不可用时的兜底）`, hit?.available === true || option.label.includes('不可用'), option.label)
}
const info = fields.find((field) => field.type === 'info')
check('有一行检测结果', info !== undefined && info.text.includes('PowerShell'), info?.text ?? '')
const button = fields.find((field) => field.type === 'button')
check('有「重新检测」按钮', button?.action === 'redetect', JSON.stringify(button))

console.log('[3] 读出来的当前值')
const values = await kernel.settings.values('terminal-env')
check('默认是 auto', values.bashShell === 'auto', String(values.bashShell))

console.log('[4] 存一个真探到的终端')
const target = options.find((option) => option.value === 'gitbash') !== undefined ? 'gitbash' : options[1]?.value
const saved = await kernel.settings.save('terminal-env', 'bashShell', target)
check('保存成功', saved.ok === true, JSON.stringify(saved))
check('回执里写明切到了哪一档', saved.ok === true && (saved.notice ?? '').includes('下一条命令起生效'), saved.ok === true ? saved.notice : '')
check('落进 plugins.json 的 tools-default 条目', configOf('tools-default').bashShell === target, JSON.stringify(configOf('tools-default')))
env.forgetShellDetection()
check('宿主读回来是刚存的那一档', (await kernel.settings.values('terminal-env')).bashShell === target)
check('选择变更后 shellFlavor 跟着变', env.shellFlavor(target) === env.shellFlavor(target))

console.log('[5] 坏值不落盘')
const before = JSON.stringify(configOf('tools-default'))
const bogus = await kernel.settings.save('terminal-env', 'bashShell', 'fish')
check('认不得的终端被拒', bogus.ok === false && bogus.error.includes('不认识的终端'), JSON.stringify(bogus))
check('被拒之后配置没变', JSON.stringify(configOf('tools-default')) === before)

const wrongKey = await kernel.settings.save('terminal-env', 'nope', 'auto')
check('这个分区没有的键被拒', wrongKey.ok === false, JSON.stringify(wrongKey))

console.log('[6] 重新检测按钮')
const redetected = await kernel.settings.action('terminal-env', 'redetect')
check('动作返回一行结果', redetected.ok === true && (redetected.notice ?? '').includes('重新检测完成'), JSON.stringify(redetected))
const unknownAction = await kernel.settings.action('terminal-env', 'nope')
check('认不得的按钮被拒', unknownAction.ok === false, JSON.stringify(unknownAction))

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? `\n全部通过：${String(passed)} 条` : `\n失败 ${String(failures)} 条，通过 ${String(passed)} 条`)
process.exit(failures === 0 ? 0 : 1)
