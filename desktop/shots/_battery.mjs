/** 全量无头电池（临时）：scripts/*-test.mjs 逐个跑 + commands-battery + legacy-frozen-check + settings-sections-check。 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const root = 'D:/dsc/'
const files = readdirSync(root + 'scripts')
  .filter((f) => f.endsWith('-test.mjs'))
  .map((f) => 'scripts/' + f)
  .concat(['scripts/commands-battery.mjs', 'scripts/legacy-frozen-check.mjs', 'scripts/settings-sections-check.mjs'])

const red = []
for (const file of files) {
  const started = Date.now()
  const res = spawnSync('node', [file], { cwd: root, encoding: 'utf8', timeout: 300000 })
  const out = String(res.stdout ?? '') + String(res.stderr ?? '')
  const tail = out.trim().split('\n').filter((l) => /通过|失败|FAIL|Error|error/.test(l)).slice(-2).join(' | ')
  const ms = Date.now() - started
  const ok = res.status === 0
  if (!ok) red.push(file)
  console.log(`${ok ? 'ok  ' : 'RED '} ${file.padEnd(42)} ${String(ms).padStart(6)}ms  ${tail.slice(0, 110)}`)
  void execFileSync
}
console.log('')
console.log(`电池：${String(files.length - red.length)}/${String(files.length)} 绿${red.length === 0 ? '' : `，红：${red.join(', ')}`}`)
process.exit(red.length === 0 ? 0 : 1)
