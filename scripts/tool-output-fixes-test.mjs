/**
 * 四项工具层修复的探针（2026-10-30）：spill 预览、`.env` 黑名单、PowerShell 编码、glob 大括号。
 *
 * 每条用例都对着一份真实报障写：
 *   1. 溢出预览只给前 30 行，报错和结论全在末尾，模型被迫再读一次（`~/.dsc/spill` 里
 *      落着 8 份「这里只显示前 30 行，还有 317 行」）；
 *   2. `Test-Path .env` 被判「命中用户 deny 黑名单」，写 `.env.example` 也被 `*.env.*` 拦；
 *   3. `Get-ChildItem` 的中文文件名在会话里是一串乱码（25 条结果含替换字符）；
 *   4. `{vue,ts,js,json}` 这种模式一条都不匹配，而且不报错，看起来像目录是空的。
 *
 * 跑法：pnpm run build && node scripts/tool-output-fixes-test.mjs
 *
 * @module dsc/scripts/tool-output-fixes-test
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const spill = await import('../lib/core/spill.js')
const floorModule = await import('../lib/core/approval-floor.js')
const search = await import('../lib/core/tools/search-tools.js')
const bashModule = await import('../lib/core/tools/bash.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

const sessionId = 'tool-output-fixes-test'
const sessionPath = 'tool-output-fixes-test.jsonl'
const signal = new AbortController().signal

// ---------------------------------------------------------------- 1. spill 预览

console.log('[1] 溢出预览：开头和结尾都要给')
{
  const config = spill.parseSpillConfig({ dir: join(tmpdir(), 'dsc-spill-fixes-test') })
  const lines = Array.from({ length: 300 }, (_, index) => `line-${String(index + 1)}`)
  const preview = spill.spillPreview('C:\\fake\\spill.log', lines.join('\n'), config)
  check('保留了第一行', preview.includes('line-1\n') || preview.startsWith('line-1'))
  check('保留了最后一行', preview.includes('line-300'))
  check('写清了中间省略多少行', preview.includes('中间省略 240 行'), preview.slice(0, 200))
  check('续读从第 31 行开始', preview.includes('offset=31'), preview.slice(-160))
  check('仍给出落盘路径', preview.includes('C:\\fake\\spill.log'))

  const short = spill.spillPreview('C:\\fake\\spill2.log', 'a\nb\nc', config)
  check('短文本不写「省略」', !short.includes('省略'), short)
}

// ---------------------------------------------------------------- 2. .env 黑名单

console.log('[2] deny 黑名单：模板放行、只读探测放行、读内容仍拒')
{
  const floor = floorModule.createApprovalFloor({
    readConfig: () => ({ config: floorModule.DEFAULT_FLOOR_CONFIG, problems: [] }),
    rules: () => [],
  })
  const judge = (input) =>
    floor.guard.decide({
      toolName: 'bash',
      risk: 'exec',
      cwd: process.cwd(),
      args: {},
      signal,
      sessionId,
      sessionPath,
      ...input,
    })
  const verdict = (command) => judge({ command })
  const writeVerdict = (target) => judge({ toolName: 'write', risk: 'write', target })

  check('Test-Path .env 不再被拒', verdict('Test-Path .env').action !== 'deny', JSON.stringify(verdict('Test-Path .env')))
  check('Get-Content .env 仍然被拒', verdict('Get-Content .env').action === 'deny')
  check('type .env 仍然被拒', verdict('type .env').action === 'deny')
  check(
    '写 .env.example 放行',
    writeVerdict(join(process.cwd(), '.env.example')).action !== 'deny',
    JSON.stringify(writeVerdict(join(process.cwd(), '.env.example'))),
  )
  check('写 .env 仍然被拒', writeVerdict(join(process.cwd(), '.env')).action === 'deny')
  check('Test-Path id_rsa 不跟着放行', verdict('Test-Path id_rsa').action === 'deny')
}

// ---------------------------------------------------------------- 3. PowerShell 编码

console.log('[3] bash：中文文件名的回显')
{
  const dir = await mkdtemp(join(tmpdir(), 'dsc-bash-encoding-'))
  try {
    await writeFile(join(dir, '中文测试.txt'), 'hello')
    const bash = bashModule.createBashTool()
    const output = await bash.run(
      { command: 'Get-ChildItem -Name' },
      { cwd: dir, signal, sessionId, sessionPath },
    )
    check('输出里能认出中文文件名', output.includes('中文测试.txt'), output.slice(0, 200))
    const exit = await bash.run({ command: 'exit 3' }, { cwd: dir, signal, sessionId, sessionPath })
    check('退出码仍然透传（exit 3）', exit.includes('退出码 3'), exit.slice(0, 120))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 4. glob 大括号

console.log('[4] glob：大括号展开')
{
  check(
    '展开成两条',
    search.expandBraces('src/**/*.{ts,tsx}').length === 2,
    JSON.stringify(search.expandBraces('src/**/*.{ts,tsx}')),
  )
  check('单值不展开', search.expandBraces('a{b}c').length === 1)
  let threw = false
  try {
    search.expandBraces('a{b')
  } catch {
    threw = true
  }
  check('没配对的 { 直接报错', threw)

  const dir = await mkdtemp(join(tmpdir(), 'dsc-glob-brace-'))
  try {
    await writeFile(join(dir, 'a.vue'), '')
    await writeFile(join(dir, 'b.json'), '')
    await writeFile(join(dir, 'c.ts'), '')
    const output = await search.globTool.run({ pattern: '**/*.{vue,json}' }, { cwd: dir, signal, sessionId, sessionPath })
    check('匹配到 .vue', output.includes('a.vue'), output)
    check('匹配到 .json', output.includes('b.json'), output)
    check('没有混进 .ts', !output.includes('c.ts'), output)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 5. edit 参数名提示

console.log('[5] edit：参数名传成旧名字时，报错要直接说清楚')
{
  const fsTools = await import('../lib/core/tools/fs-tools.js')
  const ctx = { cwd: tmpdir(), signal, sessionId, sessionPath }
  const messageOf = async (args) => {
    try {
      await fsTools.editTool.run(args, ctx)
      return ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  const alias = await messageOf({ path: 'nope.txt', old_string: 'a', new_string: 'b' })
  check('old_string 被认出来并给了正确参数名', alias.includes('old_string') && alias.includes('path / old / new'), alias)
  const fileAlias = await messageOf({ file_path: 'nope.txt', old: 'a', new: 'b' })
  check('file_path 同样给出提示', fileAlias.includes('file_path') && fileAlias.includes('path / old / new'), fileAlias)
}

if (failures > 0) {
  console.log(`\n${String(failures)} 条用例失败`)
  process.exit(1)
}
console.log('\n全部通过')
