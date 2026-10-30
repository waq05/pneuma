/**
 * 审批地板的 shell 口径与工具预算（2026-10-30）：这三条都来自同一份使用反馈。
 *
 * 1. **PowerShell 的 `"\"` 不该被判「引号没闭合」**：转义符是反引号不是反斜杠。
 *    那次会话里 5 条 `Get-ChildItem … .Replace(… + "\","")` 全被误伤，喂进来的原始命令
 *    就抄在下面 [1] 里（从会话 jsonl 还原，不是编的）。
 * 2. **`$(...)` 仍然拒，但理由要能照着改**：`Get-Content $(echo .env)` 这种两半都只读的
 *    组合能把路径藏进替换里、绕过 deny 黑名单，所以不能改成「问人」；能改的是理由文案。
 * 3. **bash 超时文案与 PTC 时限**：原文案「已终止进程」在开始收进程树时就发了，模型以为
 *    活已经死了就重跑一遍；PTC 120 秒在「单条 bash 就能跑 120 秒」的现场必然不够。
 *
 * 跑法：pnpm run build && node scripts/floor-shell-and-budget-test.mjs
 *
 * @module dsc/scripts/floor-shell-and-budget-test
 */
const floorModule = await import('../lib/core/approval-floor.js')
const bashModule = await import('../lib/core/tools/bash.js')
const ptcCore = await import('../lib/core/ptc.js')
const ptcPlugin = await import('../lib/plugins/ptc.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

const floor = floorModule.createApprovalFloor({
  readConfig: () => ({ config: floorModule.DEFAULT_FLOOR_CONFIG, problems: [] }),
  rules: () => [],
})
const signal = new AbortController().signal
const decide = (command) =>
  floor.guard.decide({
    toolName: 'bash',
    risk: 'exec',
    cwd: process.cwd(),
    args: {},
    command,
    signal,
    sessionId: 'floor-shell-test',
    sessionPath: 'floor-shell-test.jsonl',
  })

// 从 1e79386c 会话还原的真实命令（PowerShell，路径结尾带反斜杠）。
const REAL_POWERSHELL = String.raw`Get-ChildItem backend -Recurse -Filter *.py | ForEach-Object { $n=(Get-Content $_.FullName | Measure-Object -Line).Lines; "{0}` + '`t' + String.raw`{1}" -f $n, $_.FullName.Replace((Get-Location).Path + "\","") } | Sort-Object -Descending | Select-Object -First 25`

console.log('[1] PowerShell 的 `"\\"` 不再被当成「引号没闭合」')
{
  const verdict = decide(REAL_POWERSHELL)
  check('那条真实命令不再被拒', verdict.action !== 'deny', `${verdict.action} / ${verdict.reason ?? ''}`)
  check('也不是因为「引号没闭合」', !(verdict.reason ?? '').includes('引号没闭合'), verdict.reason ?? '')
  const simple = decide(String.raw`Write-Output "C:\temp\"`)
  check('单独的 P"\\" 也判得开', simple.action !== 'deny', `${simple.action} / ${simple.reason ?? ''}`)
}

console.log('[2] 命令替换照旧拒，但给出可照做的改法')
{
  const verdict = decide('echo $(Get-Date)')
  check('内层是只读命令也拒（fail-closed）', verdict.action === 'deny', verdict.action)
  check('理由里说明了怎么拆', (verdict.reason ?? '').includes('改成两步'), verdict.reason ?? '')
  const smuggled = decide('echo $(Get-Content .env)')
  check('替换里藏密钥路径仍按黑名单拒', smuggled.action === 'deny' && smuggled.reason.includes('deny 黑名单'), smuggled.reason ?? '')
  const disaster = decide('echo $(rm -rf /)')
  check('灾难命令仍按灾难拒', disaster.action === 'deny' && disaster.reason.includes('灾难'), disaster.reason ?? '')
}

console.log('[3] bash 超时的文案：说清楚「正在终止」与下一步')
{
  const bash = bashModule.createBashTool({ timeoutMs: 1_000, maxTimeoutMs: 2_000, outputChars: 8_000 })
  const output = await bash.run(
    { command: 'Start-Sleep -Seconds 5' },
    { cwd: process.cwd(), signal, sessionId: 't', sessionPath: 't.jsonl' },
  )
  check('不再说「已终止进程」', !output.includes('已终止进程'), output.slice(0, 160))
  check('说「已请求终止」', output.includes('已请求终止'), output.slice(0, 160))
  check('给出后台与 timeoutMs 两条出路', output.includes('run_in_background') && output.includes('timeoutMs'), output.slice(0, 200))
}

console.log('[4] PTC 脚本时限：默认放宽，可配、夹取')
{
  check('默认时限是 300 秒', ptcCore.PTC_LIMITS.deadlineMs === 300_000, String(ptcCore.PTC_LIMITS.deadlineMs))
  check('没配置时用默认值', ptcPlugin.readDeadlineMs(undefined) === 300_000, String(ptcPlugin.readDeadlineMs(undefined)))
  check('配了就用配置值', ptcPlugin.readDeadlineMs({ deadlineMs: 480_000 }) === 480_000)
  check('小于下限被夹到 30 秒', ptcPlugin.readDeadlineMs({ deadlineMs: 1 }) === 30_000, String(ptcPlugin.readDeadlineMs({ deadlineMs: 1 })))
  check('大于上限被夹到 15 分钟', ptcPlugin.readDeadlineMs({ deadlineMs: 99_999_999 }) === 900_000)
}

if (failures > 0) {
  console.log(`\n${String(failures)} 条用例失败`)
  process.exit(1)
}
console.log('\n全部通过')
