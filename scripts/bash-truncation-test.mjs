/**
 * bash 输出截断探针：超预算时留头也留尾，别把报错尾巴丢掉。
 *
 * 0.7.1 之前只留开头 `output.slice(0, outputLimit)`：编译错误、测试断言、退出前的
 * 报错几乎都在末尾，于是模型拿着前几千字进度条，看不到真正的失败原因。现在按
 * 头 60% + 省略标记 + 尾 40% 切，标记里写清省了多少字符。
 *
 * 两段断言：
 *   ① 纯函数 truncateBashOutput 的切法与标记（短输出不动、长输出头尾都在）；
 *   ② 真跑一次子进程，确认 spawnShell 真的走了这条切法（不是只测了没接线的函数）。
 *
 * 跑法：node scripts/bash-truncation-test.mjs（先 pnpm run build）
 *
 * @module dsc/scripts/bash-truncation-test
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnShell, truncateBashOutput } from '../lib/core/tools/bash.js'

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsc-bash-trunc-')))

console.log('[1] 纯函数：短输出原样返回')
{
  const short = '只有一行输出'
  check('不超过上限时一个字节都不动', truncateBashOutput(short, 100) === short)
  check('刚好等于上限也不截', truncateBashOutput('x'.repeat(100), 100) === 'x'.repeat(100))
}

console.log('[2] 纯函数：头 60% + 标记 + 尾 40%')
{
  const limit = 1000
  // 中间用不同的字填充，方便确认「省略」的确实是中段而不是头或尾
  const head = 'HEAD-开头第一行\n' + 'h'.repeat(400)
  const middle = 'm'.repeat(2500) + 'MIDDLE-SHOULD-BE-GONE' + 'm'.repeat(2500)
  const tail = 't'.repeat(400) + '\nFINAL-ERROR: 最后一行才是报错'
  const output = head + middle + tail
  const truncated = truncateBashOutput(output, limit)

  check('开头内容保留', truncated.startsWith('HEAD-开头第一行'), JSON.stringify(truncated.slice(0, 40)))
  check('尾部报错保留', truncated.endsWith('FINAL-ERROR: 最后一行才是报错'), JSON.stringify(truncated.slice(-60)))
  check('中间省略标记写明了省多少字符', /中间省略 \d+ 字符/.test(truncated), JSON.stringify(truncated))
  check('标记里有「完整输出」往哪看的说明', truncated.includes('完整输出'), JSON.stringify(truncated))
  const omitted = Number(/中间省略 (\d+) 字符/.exec(truncated)?.[1])
  // 保留的正文字符数 = 头 600 + 尾 400；标记本身另算
  const markerStart = truncated.indexOf('\n…（中间省略')
  const markerEnd = truncated.indexOf('）\n', markerStart) + 2
  const bodyChars = truncated.length - (markerEnd - markerStart)
  check('头 60% + 尾 40% 都算进预算', bodyChars === limit, String(bodyChars))
  check('省略字数 = 原长 - 保留字数', omitted === output.length - bodyChars, `${String(omitted)} vs ${String(output.length - bodyChars)}`)
  check('被省略的中段没有漏进来', !truncated.includes('MIDDLE-SHOULD-BE-GONE'), JSON.stringify(truncated.slice(0, 20)))
}

console.log('[3] 真跑子进程：spawnShell 走同一条截断')
{
  const outputLimit = 600
  // 总量压在 2 倍上限以内：spawnShell 只在 output.length < outputLimit * 2 时继续收，
  // 超了就会提前停，最后那句报错可能根本没进来——那是另一个问题，这里只测截断切法。
  const script = [
    "const pad = 'x'.repeat(100)",
    'for (let i = 0; i < 6; i += 1) console.log(`head-${i} ${pad}`)',
    "console.log('FINAL-ERROR: 找不到模块 approval.ts')",
  ].join('\n')
  const plan = { file: process.execPath, args: ['-e', script], cwd, env: process.env }
  const result = await spawnShell(plan, 20_000, outputLimit, new AbortController().signal)
  check('子进程输出保留了开头', result.includes('head-0'), JSON.stringify(result.slice(0, 80)))
  check('子进程输出保留了结尾报错', result.includes('FINAL-ERROR: 找不到模块 approval.ts'), JSON.stringify(result.slice(-120)))
  check('子进程输出带省略标记与字数', /中间省略 \d+ 字符/.test(result), JSON.stringify(result))
}

if (failures > 0) {
  console.log(`\n${String(failures)} 项不通过`)
  process.exit(1)
}
console.log('\n全部通过')
