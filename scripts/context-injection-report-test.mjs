/**
 * 「注入上报闸」的离线测试（纯函数 + 台账，不连宿主、不起界面）。
 *
 * 要守的语义（2026-11-11 改口径）：注入卡记的是「这一跳**新增**了哪些注入」，不是
 * 「这一跳注入了什么」。所以注入照旧每跳都做，但记账只在正文变化时发生：
 *   1. 首次必报（这个会话还没报过这一类）；
 *   2. 与上一次上报的正文逐字相同 → 不报；
 *   3. 正文变了 → 报；
 *   4. 空正文不上报（没有可看的读数），但会被记成当前状态；
 *   5. 片段各算一类，互不牵连：整段快照变了、其中一个片段没变，就只报变的那几个；
 *   6. 台账按会话分开：别的会话报过同一段正文，不影响本会话的「首次」。空正文也是一次
 *      真实的状态变化：片段从「有」到「空」再到「有」，第二次出现必须上报。
 *
 * 为什么要单列一条而不是只靠真机探针：真机的判据是「卡片张数对不对」，一旦闸门写错，
 * 那条探针只会红在「张数」上，看不出是「相同也报」还是「不同不报」。这里逐条钉住判据。
 *
 * 运行：pnpm build && node scripts/context-injection-report-test.mjs
 * 为什么先 build：与 `context-injection-merge-test.mjs` 同一条规矩——import 的是编译
 * 产物 `lib/`（Node 的说明符解析认 `.js`，源文件是 `.ts`）。
 *
 * @module dsc/scripts/context-injection-report-test
 */
import { InjectionReportLedger, shouldReport } from '../lib/core/context-injection-report.js'

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

console.log('注入上报闸测试')

// ── ① 纯函数：四种基本判断 ──────────────────────────────────────────────────
{
  check('① 首次（last 缺省）必报', shouldReport(undefined, '环境事实：今天 2026-11-11') === true)
  check('① 与上次逐字相同 → 不报', shouldReport('同一段正文', '同一段正文') === false)
  check('① 正文不同 → 报', shouldReport('旧正文', '新正文') === true)
  check('① 空正文（首次）不报', shouldReport(undefined, '') === false, String(shouldReport(undefined, '')))
  check('① 空白正文（只有空格换行）不报', shouldReport(undefined, ' \n\t ') === false)
  check('① 上次非空、这次空 → 不报（没有可看的读数）', shouldReport('旧正文', '') === false)
  check('① 判断是逐字的：大小写 / 标点不同都算变', shouldReport('A', 'a') === true && shouldReport('A。', 'A') === true)
}

// ── ② 台账：同一会话里「首次 → 相同 → 不同」 ────────────────────────────────
{
  const ledger = new InjectionReportLedger()
  check('② 第一次报', ledger.take('s1', 'env-facts', '快照 A') === true)
  check('② 第二次相同不报', ledger.take('s1', 'env-facts', '快照 A') === false)
  check('② 第三次仍相同不报', ledger.take('s1', 'env-facts', '快照 A') === false)
  check('② 变了就报', ledger.take('s1', 'env-facts', '快照 B') === true)
  check('② 变回去也算变（上次是 B，不是 A）', ledger.take('s1', 'env-facts', '快照 A') === true)
}

// ── ③ 片段层面单独判断：整段快照变了，没变的片段不跟着重报 ──────────────────
{
  const ledger = new InjectionReportLedger()
  const snapshot = (mode, sandbox) => `环境事实：\n${mode}\n${sandbox}`
  const reportAll = (mode, sandbox) => {
    const out = []
    if (ledger.take('s2', 'env-facts', snapshot(mode, sandbox))) out.push('env-facts')
    for (const [kind, text] of [['mode', mode], ['sandbox', sandbox]]) {
      if (ledger.take('s2', kind, text)) out.push(kind)
    }
    return out
  }
  check('③ 第 1 跳三项全报', reportAll('模式：执行', '沙箱：workspace-write').join(',') === 'env-facts,mode,sandbox')
  check('③ 第 2 跳一字未变，一项都不报', reportAll('模式：执行', '沙箱：workspace-write').length === 0)
  check('③ 第 3 跳只改模式：报整段快照 + mode，沙箱那一条不重报',
    reportAll('模式：计划', '沙箱：workspace-write').join(',') === 'env-facts,mode')
  check('③ 第 4 跳又变回原模式：同样只报变的那几项',
    reportAll('模式：执行', '沙箱：workspace-write').join(',') === 'env-facts,mode')
}

// ── ④ 空正文：记状态但不报，重新出现时算新 ──────────────────────────────────
{
  const ledger = new InjectionReportLedger()
  check('④ 首次非空要报', ledger.take('s3', 'mode', '模式：执行') === true)
  check('④ 片段变空不报', ledger.take('s3', 'mode', '') === false)
  check('④ 空着再来一次仍不报', ledger.take('s3', 'mode', '') === false)
  check('④ 从空重新出现要报（中间那段空也算一次状态变化）', ledger.take('s3', 'mode', '模式：执行') === true)
}

// ── ⑤ 会话隔离：A 报过不影响 B 的「首次」 ───────────────────────────────────
{
  const ledger = new InjectionReportLedger()
  check('⑤ 会话 A 首次报', ledger.take('a', 'sandbox', '沙箱：workspace-write') === true)
  check('⑤ 会话 B 同一段正文仍算首次', ledger.take('b', 'sandbox', '沙箱：workspace-write') === true)
  check('⑤ 会话 A 再报同一段不报', ledger.take('a', 'sandbox', '沙箱：workspace-write') === false)
  check('⑤ 会话 B 再报同一段不报', ledger.take('b', 'sandbox', '沙箱：workspace-write') === false)
}

// ── ⑥ 提醒那条：正文固定不变，越过阈值后的每一跳都注入、但只报第一次 ────────
{
  const ledger = new InjectionReportLedger()
  const text = '（提醒：任务清单有未完成项，做完一步就把状态改掉）'
  const reports = []
  for (let hop = 1; hop <= 8; hop += 1) {
    if (ledger.take('s4', 'todo-reminder', text)) reports.push(hop)
  }
  check('⑥ 8 跳都注入了同一句提醒，只报了第 1 跳', reports.join(',') === '1', JSON.stringify(reports))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failed)}`)
process.exit(failed === 0 ? 0 : 1)
