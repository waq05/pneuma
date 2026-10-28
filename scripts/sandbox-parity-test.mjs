/**
 * 权限与沙箱对齐 dsh 的回归探针（2026-10-28）。
 *
 * 钉五件事：
 *   [1] 命令判定：`git -c …` 不再把写子命令看成只读；网络开关不再被带值开关绕过；
 *       嵌套 shell 拆得比两层更深。
 *   [2] 沙箱越界分两类：能问的（outside-writable-roots / mode-read-only）交审批卡，
 *       不能问的（形状、受保护名、只读子路径、网络开关）保持硬拒。
 *   [3] 审批顺序：AI 复核排在「完全访问」自动放行之前；沙箱边界排在两者之前。
 *   [4] 模式四档：PTC 是全量 + run_code；极简是 shell + read_image、替换式人格、保留 AGENTS.md。
 *   [5] 权限预设三根一起持久化。
 *
 * 运行：node scripts/sandbox-parity-test.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
// 必须在任何内核模块被加载之前固定 DSC_HOME：path-policy 在 import 时就把 DSC_HOME
// 算成常量了，晚一步设就还是读真实的 ~/.dsc（那里有用户改过的旧模式文件）。
const home = mkdtempSync(join(tmpdir(), 'dsc-parity-'))
process.env.DSC_HOME = home
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log('  ok  ' + name)
  } else {
    fail += 1
    console.log('  FAIL  ' + name + (detail === '' ? '' : '  <- ' + detail))
  }
}

// 安全模块之间有相对 `.js` 导入，Node 的类型擦除不认那种写法，所以这一份读编译产物。
// `check:core` 的其余电池也是这个约定（跑之前先 `pnpm run build`）。
const execpolicy = await import(new URL('../lib/core/sandbox/execpolicy.js', import.meta.url).href)
const commandPolicy = await import(new URL('../lib/core/command-policy.js', import.meta.url).href)

const cw = (raw) => ({
  allowed: raw.toLowerCase().startsWith('d:/dsc'),
  rule: 'outside-writable-roots',
  reason: 'outside',
  resolved: raw,
})
const sandbox = (command) => execpolicy.evaluateCommand(command, { networkAccess: false, checkWrite: cw, win32: true })

console.log('[1] 命令判定：git 全局开关、网络开关、嵌套 shell')
{
  check('git -c x=y reset --hard 不再被判只读', commandPolicy.classifyCommand('git -c x=y reset --hard').decision === 'ask', commandPolicy.classifyCommand('git -c x=y reset --hard').decision)
  check('git -c x=y clean -fd 不再被判只读', commandPolicy.classifyCommand('git -c x=y clean -fd').decision === 'ask', commandPolicy.classifyCommand('git -c x=y clean -fd').decision)
  check('git -c core.pager=calc log 仍是只读（子命令还是 log）', commandPolicy.classifyCommand('git -c core.pager=calc log').decision === 'allow', commandPolicy.classifyCommand('git -c core.pager=calc log').decision)
  check('git -C dir status 仍是只读', commandPolicy.classifyCommand('git -C sub status').decision === 'allow')

  check('pnpm --dir . install 网络关时被拒', sandbox('pnpm --dir . install').decision === 'forbidden', sandbox('pnpm --dir . install').decision + ':' + sandbox('pnpm --dir . install').rule)
  check('npm --registry=https://x install 网络关时被拒', sandbox('npm --registry=https://x install').decision === 'forbidden')
  check('git -c http.x=y clone https://x 网络关时被拒', sandbox('git -c http.x=y clone https://x').decision === 'forbidden')
  check('pnpm --dir . test 不因带值开关被当成联网', sandbox('pnpm --dir . test').network === false)

  const three = sandbox('bash -c "bash -c \'rm -rf D:/outside/x\'"')
  check('三层嵌套 shell 认得出越界写目标', three.decision === 'forbidden' && three.rule.includes('outside-writable-roots'), three.decision + ':' + three.rule)
  const four = sandbox('bash -c "bash -c \'bash -c \\\'rm -rf D:/outside/x\\\'\'"')
  check('四层嵌套 shell 也认得出越界写目标', four.decision === 'forbidden', four.decision + ':' + four.rule)
}

console.log('[2] 沙箱越界分两类：能问的 defer，不能问的硬拒')
{
  const code = strip(read('src/plugins/sandbox.ts'))
  check('有可申请规则集合 ASKABLE_RULES', code.includes('ASKABLE_RULES'))
  const askable = code.slice(code.indexOf('const ASKABLE_RULES'), code.indexOf('}', code.indexOf('const ASKABLE_RULES')))
  check('可申请含 outside-writable-roots', askable.includes("'outside-writable-roots'"))
  check('可申请含 mode-read-only', askable.includes("'mode-read-only'"))
  check('受保护名不在可申请里', !askable.includes('protected-metadata'))
  check('只读子路径不在可申请里', !askable.includes('read-only-subpath'))
  check('网络开关不在可申请里', !askable.includes('network-off'))
  check('越界只有审批在场时才 defer', code.includes("askableRule(verdict.rule) && ctx.get('approval') !== undefined"))
  check('defer 之后仍会走到 refuse（没有审批就硬拒）', code.includes('return refuse(config, policy, input.toolName, verdict)'))
  check('服务暴露 check(target, command)', code.includes('check(target: string | undefined, command: string | undefined'))
}

console.log('[3] 审批顺序：沙箱边界 → AI 复核 → 自动放行')
{
  const code = strip(read('src/plugins/approval.ts'))
  const fenceAt = code.indexOf("ctx.get('sandbox')?.check")
  const reviewAt = code.indexOf("if (reviewer === 'auto-review')")
  check('审批读沙箱的 check', fenceAt >= 0)
  check('沙箱边界排在 AI 复核之前', fenceAt >= 0 && fenceAt < reviewAt, String(fenceAt) + ' vs ' + String(reviewAt))
  // 0.7.1 把「完全访问 / 工作区自动」收进 policyAutoReason()（复核没跑完时要复用同一份判断），
  // 于是 `policy === 'full-access'` 这几个字最早出现在函数**定义**处，按字面位置比会误报。
  // 真正要守的顺序是：先问复核，复核缺席了才轮到自动放行——所以比的是第一次**调用**的位置。
  const autoAt = code.indexOf('policyAutoReason()')
  check('AI 复核排在自动放行之前', reviewAt >= 0 && autoAt > reviewAt, String(reviewAt) + ' vs ' + String(autoAt))
  check('复核缺席才走自动放行（不是反过来）', code.includes('reviewed.failed && !signal.aborted ? policyAutoReason() : null'))
  check('越界时跳过所有自动放行', code.includes('protectedWhy === null && forced === \'\' && !fenced'))
  check('越界只给「这一次」授权', code.includes('if (fenced) {'))
  check('工作区内免卡还要沙箱同意', code.includes('const writable = PATH_WRITE_TOOLS.has(request.toolName) && insideCwd && (fence?.allowed ?? true)'))
}

console.log('[4] 模式四档对齐 dsh')
{
  const presets = await import(new URL('../lib/core/presets.js', import.meta.url).href)
  presets.ensureBuiltinPresets()
  const list = presets.listPresets()
  check('四个出厂档都在', list.length >= 4, String(list.length))
  const names = list.slice(0, 4).map((item) => item.name)
  check('顺序对齐 dsh：standard → ptc → minimal → maker', JSON.stringify(names) === JSON.stringify(['standard', 'ptc', 'minimal', 'maker']), JSON.stringify(names))

  const byName = Object.fromEntries(list.map((item) => [item.name, item]))
  check('标准档是全量工具', byName.standard.tools === null)
  check('PTC 档是全量工具 + run_code（不再只有 run_code）', byName.ptc.tools === null && byName.ptc.prompt.includes('run_code'), JSON.stringify(byName.ptc.tools))
  check('极简档只有 shell 与 read_image', JSON.stringify(byName.minimal.tools) === JSON.stringify(['bash', 'read_image']), JSON.stringify(byName.minimal.tools))
  check('极简档是替换式人格', byName.minimal.replace === true)
  check('极简档保留 AGENTS.md 注入（drop 里没有 instructions）', !byName.minimal.drop.includes('instructions'), JSON.stringify(byName.minimal.drop))
  check('标准档不替换人格', byName.standard.replace === false)

  const imageTools = await import(new URL('../lib/core/tools/image-tool.js', import.meta.url).href)
  check('read_image 工具存在且只挂极简档', imageTools.readImageTool.name === 'read_image' && JSON.stringify(imageTools.readImageTool.presets) === JSON.stringify(['minimal']))
  check('read_image 是只读风险', imageTools.readImageTool.risk === 'read')
}

console.log('[5] 权限预设三根一起持久化')
{
  const code = strip(read('src/plugins/permission-presets.ts'))
  check('apply 写 defaultPolicy', code.includes('defaultPolicy: preset.policy'))
  check('apply 写 defaultReviewer', code.includes('defaultReviewer: preset.reviewer'))
  check('走 settings.setPrefs（与设置页同一条持久化路径）', code.includes('ctx.settings.setPrefs('))
}

rmSync(home, { recursive: true, force: true })
console.log('')
console.log('对齐探针：' + String(pass) + ' 通过 / ' + String(fail) + ' 失败')
if (fail > 0) process.exitCode = 1
