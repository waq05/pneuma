/**
 * 留底台账（`InjectionNoteLedger`）的两个边角：表满 64、压缩改写历史。
 *
 * 为什么单列：主探针 `injection-note-test.mjs` 走真内核、只证明「常规路径二次派生
 * 只落一条」，构造不出「表里已经有 64 条别的会话」与「压缩把历史换过一遍但尾部对象
 * 还是那一个」。这两处一旦判错，症状都是安静的：前者在忙碌的进程里把别人的记录清掉、
 * 后者吞掉一次真注入的留底，日志事后都对不出来。
 *
 * 判据与 `src/core/context-injection-report.ts` 的注释同一条：
 * 会话 id + 历史尾对象引用 + 正文，三样都一样才认为「这份历史已经为这句话留过底」。
 *
 * ② 的前提「压缩后尾对象引用不变」不靠读注释、靠真跑一遍 `Session.replaceWithSummary`：
 * `compact.ts` 的 `kept = [{role:'user', content: summary}, ...messages.slice(cut)]` 是原对象，
 * 这里用真的 `Session` 断言压缩前后尾对象是同一个引用。前提一旦变（比如以后改成克隆尾部），
 * 这条先红，后面的台账断言才有意义。
 *
 * 运行：pnpm run build && node scripts/injection-note-ledger-test.mjs
 *
 * @module dsc/scripts/injection-note-ledger-test
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InjectionNoteLedger } from '../lib/core/context-injection-report.js'

const home = mkdtempSync(join(tmpdir(), 'dsc-injection-note-ledger-'))
process.env.DSC_HOME = join(home, '.dsc')
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(process.env.DSC_HOME, { recursive: true })

const { Session } = await import('../lib/core/session.js')

let passed = 0
let failed = 0
const check = (name, condition, detail = '') => {
  if (condition === true) {
    passed += 1
    console.log(`  ok  ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL  ${name}${detail === '' ? '' : `  <- ${detail}`}`)
}

console.log('留底台账边角测试')

// ── ① 表满 64 之后的二次派生 ────────────────────────────────────────────────
{
  const ledger = new InjectionNoteLedger()
  const tail = { role: 'assistant', content: '尾一' }
  const text = '（提醒：任务清单有未完成项，做完一步就把状态改掉）'
  check('① 首次落一条', ledger.take('s0', tail, text) === true)
  // 再填 63 个会话，表刚好满 64。这一步不会清表：每次都是「新会话」且 size < 64。
  // 尾部对象各自留一份引用，后面要拿 s63 判「整表清」还是「淘汰最老一条」。
  const tails = new Map()
  for (let i = 1; i <= 63; i += 1) {
    const item = { role: 'assistant', content: `尾${String(i)}` }
    tails.set(`s${i}`, item)
    ledger.take(`s${i}`, item, text)
  }
  check('① 表刚好 64 条时二次派生不再落（没有把「表满」误当成新会话去清表）',
    ledger.take('s0', tail, text) === false)
  check('① 第三次派生仍不落（判重是稳定的，不是只挡一下）',
    ledger.take('s0', tail, text) === false)
  // 真新消息（尾部换了对象）照常落：清表不能把这个也截掉。
  check('① 表满后尾部换成新对象照常落', ledger.take('s0', { role: 'assistant', content: '尾一之后' }, text) === true)

  // 表满时来一个**新会话**会整表清掉（现状取舍：宁可让老会话多落一条，也不让新会话无声消失）。
  // 这一拍最容易手误（比如把 clear 挪到 set 之后、或按「上一个最老」而非整表清），所以钉牢：
  // ① 触发清表的那一跳自己，二次派生也不能再落；
  // ② 清表是真清（表里最后一条 s63 的记录也没了——只淘汰最老一条的话它还在，会返回 false）。
  check('① 表满时新会话先落一条', ledger.take('s-new', tail, text) === true)
  check('① 触发清表那一跳的二次派生仍只落一条（clear 不能把刚写进去的那条也算成「没见过」）',
    ledger.take('s-new', tail, text) === false)
  check('① 清表是真清（不是只淘汰最老一条）：s63 也被清掉，会重新落一条',
    ledger.take('s63', tails.get('s63'), text) === true)
  check('① 清表后老会话同一份历史会重新落一条（宁可多一条，不吞）', ledger.take('s0', tail, text) === true)
}

// ── ② 压缩改写历史：尾对象引用不变 / 变了 / 正文变了 ───────────────────────
{
  const session = Session.create(home, join(home, 'compact.jsonl'))
  session.appendUser('把这件事办完。')
  session.appendAssistant('好，先看边界。', '', [])
  const tail = session.messages[session.messages.length - 1]
  const text = '（提醒：任务清单有未完成项）'

  const ledger = new InjectionNoteLedger()
  check('② 压缩前那一跳落了', ledger.take('c', tail, text) === true)

  // 真跑压缩：尾部消息原样搬过去（compact.ts 的 kept 是 messages.slice(cut) 的原对象）。
  session.replaceWithSummary('摘要（压缩）', [{ role: 'user', content: '摘要（压缩）' }, tail])
  const after = session.messages[session.messages.length - 1]
  check('② 压缩把历史换成「摘要 + 保留的尾部」，尾部仍是同一个消息对象',
    after === tail, 'tail 与压缩后的尾不是同一个引用')
  check('② 压缩后尾对象没换、正文没变：不重复落（与上报闸同一口径）',
    ledger.take('c', tail, text) === false)
  // 正文变了必须落：压缩本身不能变成「永远吞掉这一类注入」的理由。
  check('② 压缩后正文变了照常落', ledger.take('c', tail, `${text}（新增一项：部署）`) === true)
  // 尾对象换了（压缩之后又落了新消息）同样要落。
  check('② 压缩后又来了新尾部：照常落',
    ledger.take('c', { role: 'assistant', content: '压缩后的新尾' }, `${text}（新增一项：部署）`) === true)
  session.close()
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failed)}`)
const code = failed === 0 ? 0 : 1
try { rmSync(home, { recursive: true, force: true }) } catch {}
process.exit(code)
