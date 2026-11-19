/**
 * 注入记账的两道闸：上报闸（`shouldReport` / `InjectionReportLedger`）与留底闸
 * （`InjectionNoteLedger`）。
 *
 * 合并自两条探针：
 *   - `scripts/context-injection-report-test.mjs`（上报判据与台账语义）；
 *   - `scripts/injection-note-ledger-test.mjs`（留底台账的两个边角：表满 64、压缩改写历史）。
 *
 * 两条探针测的是同一个文件（`core/context-injection-report.ts`）的两个类，且共用一条判据：
 * 「这一跳该不该再画一张卡」与「这一跳该不该再落一条 note」比的是**不同的东西**——前者比
 * 正文有没有变，后者比这份历史是不是已经为这句话留过底。写在一份 spec 里，是为了让这个
 * 区别在同一个文件里对照着看。
 *
 * ## 为什么这是 unit 层
 *
 * 两个台账都只活在内存里、不读环境、不起内核。留底闸那条压缩用例确实要一个真 `Session`，
 * 但它要的只是「压缩把尾部消息原对象搬过去」这一条事实，不需要整套内核装配。
 *
 * @module dsc/core/context-injection-report.spec
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { InjectionNoteLedger, InjectionReportLedger, shouldReport } from './context-injection-report.js'
import { Session } from './session.js'

/** 留底闸那条压缩用例的临时目录；会话要写盘，必须落在临时目录里。 */
const home = mkdtempSync(join(tmpdir(), 'dsc-injection-note-'))

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 注入清单 A：环境快照 + 模式 + 沙箱（三类的组合，与真现场同形）。 */
const A = [
  { kind: 'env-facts', source: 'env-facts', where: 'user-tail', chars: 908, preview: '环境事实' },
  { kind: 'mode', source: 'mode', where: 'system', chars: 85, preview: '当前模式' },
  { kind: 'sandbox', source: 'sandbox', where: 'system', chars: 445, preview: '沙箱档位' },
] as const

describe('① shouldReport：四种基本判断', () => {
  test('首次（上次缺省）必报', () => {
    expect(shouldReport(undefined, '环境事实：今天 2026-11-11')).toBe(true)
  })

  test('与上次逐字相同 → 不报', () => {
    expect(shouldReport('同一段正文', '同一段正文')).toBe(false)
  })

  test('正文不同 → 报', () => {
    expect(shouldReport('旧正文', '新正文')).toBe(true)
  })

  test('空正文（首次）不报：没有可看的读数', () => {
    expect(shouldReport(undefined, '')).toBe(false)
  })

  test('只有空格换行也算空正文', () => {
    expect(shouldReport(undefined, ' \n\t ')).toBe(false)
  })

  test('上次非空、这次空 → 不报（但会被记成当前状态）', () => {
    expect(shouldReport('旧正文', '')).toBe(false)
  })

  test('判断是逐字的：大小写与标点都算变了', () => {
    expect(shouldReport('A', 'a')).toBe(true)
    expect(shouldReport('A。', 'A')).toBe(true)
  })
})

describe('② 台账：同一会话里「首次 → 相同 → 不同」', () => {
  test('第一次报、第二次相同不报、第三次仍相同不报、变了就报、变回去也算变', () => {
    const ledger = new InjectionReportLedger()
    expect(ledger.take('s1', 'env-facts', '快照 A')).toBe(true)
    expect(ledger.take('s1', 'env-facts', '快照 A')).toBe(false)
    expect(ledger.take('s1', 'env-facts', '快照 A')).toBe(false)
    expect(ledger.take('s1', 'env-facts', '快照 B')).toBe(true)
    // 上次已是 B：再回到 A 又是一次真实变化，不能因为「历史上出现过 A」就吞掉。
    expect(ledger.take('s1', 'env-facts', '快照 A')).toBe(true)
  })
})

describe('③ 片段各算一类：整段快照变了，没变的片段不跟着重报', () => {
  /** 按「整段 + 两个片段」逐类上报，返回这一跳真正上报了的类别。 */
  function reportAll(ledger: InjectionReportLedger, mode: string, sandbox: string): string[] {
    const out: string[] = []
    if (ledger.take('s2', 'env-facts', `环境事实：\n${mode}\n${sandbox}`)) out.push('env-facts')
    if (ledger.take('s2', 'mode', mode)) out.push('mode')
    if (ledger.take('s2', 'sandbox', sandbox)) out.push('sandbox')
    return out
  }

  test('第 1 跳三项全报，第 2 跳一字未变则一项都不报', () => {
    const ledger = new InjectionReportLedger()
    expect(reportAll(ledger, '模式：执行', '沙箱：workspace-write')).toEqual(['env-facts', 'mode', 'sandbox'])
    expect(reportAll(ledger, '模式：执行', '沙箱：workspace-write')).toEqual([])
  })

  test('只改模式：报整段快照 + mode，沙箱那一条不重报', () => {
    const ledger = new InjectionReportLedger()
    reportAll(ledger, '模式：执行', '沙箱：workspace-write')
    expect(reportAll(ledger, '模式：计划', '沙箱：workspace-write')).toEqual(['env-facts', 'mode'])
  })

  test('又变回原模式：同样只报变的那几项', () => {
    const ledger = new InjectionReportLedger()
    reportAll(ledger, '模式：执行', '沙箱：workspace-write')
    reportAll(ledger, '模式：计划', '沙箱：workspace-write')
    expect(reportAll(ledger, '模式：执行', '沙箱：workspace-write')).toEqual(['env-facts', 'mode'])
  })
})

describe('④ 空正文：记状态但不报，重新出现算新', () => {
  test('首次非空要报、变空不报、空着再来不报、从空重新出现要报', () => {
    const ledger = new InjectionReportLedger()
    expect(ledger.take('s3', 'mode', '模式：执行')).toBe(true)
    expect(ledger.take('s3', 'mode', '')).toBe(false)
    expect(ledger.take('s3', 'mode', '')).toBe(false)
    expect(ledger.take('s3', 'mode', '模式：执行')).toBe(true)
  })
})

describe('⑤ 会话隔离：A 报过不影响 B 的「首次」', () => {
  test('两个会话各自首次都要报，之后各自都不重报', () => {
    const ledger = new InjectionReportLedger()
    expect(ledger.take('a', 'sandbox', '沙箱：workspace-write')).toBe(true)
    expect(ledger.take('b', 'sandbox', '沙箱：workspace-write')).toBe(true)
    expect(ledger.take('a', 'sandbox', '沙箱：workspace-write')).toBe(false)
    expect(ledger.take('b', 'sandbox', '沙箱：workspace-write')).toBe(false)
  })
})

describe('⑥ 正文固定不变的提醒：8 跳都注入，只报第 1 跳', () => {
  test('8 跳只上报一次', () => {
    const ledger = new InjectionReportLedger()
    const text = '（提醒：任务清单有未完成项，做完一步就把状态改掉）'
    const reports: number[] = []
    for (let hop = 1; hop <= 8; hop += 1) {
      if (ledger.take('s4', 'todo-reminder', text)) reports.push(hop)
    }
    expect(reports).toEqual([1])
  })
})

describe('⑦ 留底闸：同一份历史二次派生只落一条', () => {
  test('尾部对象引用相同 + 正文相同 → 第二次不落', () => {
    const ledger = new InjectionNoteLedger()
    const tail = { role: 'assistant', content: '尾' }
    expect(ledger.take('n1', tail, '提醒原文')).toBe(true)
    expect(ledger.take('n1', tail, '提醒原文')).toBe(false)
    // 尾部换了对象（两次真请求之间一定落过新消息）就照常落。
    expect(ledger.take('n1', { role: 'assistant', content: '新尾' }, '提醒原文')).toBe(true)
  })

  test('同一尾部、正文变了照常落', () => {
    const ledger = new InjectionNoteLedger()
    const tail = { role: 'assistant', content: '尾' }
    expect(ledger.take('n2', tail, '提醒一')).toBe(true)
    expect(ledger.take('n2', tail, '提醒二')).toBe(true)
  })

  test('会话隔离：不同会话各落各的', () => {
    const ledger = new InjectionNoteLedger()
    const tail = { role: 'assistant', content: '尾' }
    expect(ledger.take('n3', tail, '提醒')).toBe(true)
    expect(ledger.take('n4', tail, '提醒')).toBe(true)
    expect(ledger.take('n3', tail, '提醒')).toBe(false)
  })
})

describe('⑧ 留底闸：表满 64 的边角', () => {
  const TEXT = '（提醒：任务清单有未完成项，做完一步就把状态改掉）'

  /** 建一本「刚好满 64 条」的台账，返回它、s0 的尾部与 s63 的尾部。 */
  function ledgerFull(): { ledger: InjectionNoteLedger; tail: object; tail63: object } {
    const ledger = new InjectionNoteLedger()
    const tail = { role: 'assistant', content: '尾一' }
    expect(ledger.take('s0', tail, TEXT)).toBe(true)
    let tail63: object = tail
    for (let i = 1; i <= 63; i += 1) {
      const item = { role: 'assistant', content: `尾${String(i)}` }
      if (i === 63) tail63 = item
      ledger.take(`s${String(i)}`, item, TEXT)
    }
    return { ledger, tail, tail63 }
  }

  test('表刚好 64 条时，老会话的二次派生不再落（没把「表满」误当成新会话去清表）', () => {
    const { ledger, tail } = ledgerFull()
    expect(ledger.take('s0', tail, TEXT)).toBe(false)
    // 判重是稳定的，不是只挡一下。
    expect(ledger.take('s0', tail, TEXT)).toBe(false)
    // 真新消息（尾部换了对象）照常落：清表不能把这个也截掉。
    expect(ledger.take('s0', { role: 'assistant', content: '尾一之后' }, TEXT)).toBe(true)
  })

  test('表满时来新会话：整表清掉，老会话同一份历史重新落一条', () => {
    const { ledger, tail, tail63 } = ledgerFull()
    expect(ledger.take('s-new', tail, TEXT)).toBe(true)
    // 触发清表那一跳自己：刚写进去的那条不能又被算成「没见过」。
    expect(ledger.take('s-new', tail, TEXT)).toBe(false)
    // 清表是真清（不是只淘汰最老一条）：s63 的记录也没了，会重新落一条。
    expect(ledger.take('s63', tail63, TEXT)).toBe(true)
    // 宁可让老会话多落一条，也不让新会话无声消失。
    expect(ledger.take('s0', tail, TEXT)).toBe(true)
  })
})

describe('⑨ 留底闸：压缩改写历史', () => {
  test('压缩把尾部消息原对象搬过去，尾对象与正文都没变 → 不重复落', () => {
    const session = Session.create(home, join(home, 'compact.jsonl'))
    try {
      session.appendUser('把这件事办完。')
      session.appendAssistant('好，先看边界。', '', [])
      const tail = session.messages[session.messages.length - 1]!
      const text = '（提醒：任务清单有未完成项）'
      const ledger = new InjectionNoteLedger()
      expect(ledger.take('c', tail, text)).toBe(true)

      // 真跑压缩：`compact.ts` 的 kept 是 `messages.slice(cut)` 的原对象。这条断言是下面
      // 两条的前提——前提一旦变（以后改成克隆尾部），先红在这里，台账断言才有意义。
      session.replaceWithSummary('摘要（压缩）', [{ role: 'user', content: '摘要（压缩）' }, tail])
      expect(session.messages[session.messages.length - 1]).toBe(tail)
      expect(ledger.take('c', tail, text)).toBe(false)
    } finally {
      session.close()
    }
  })

  test('压缩后正文变了照常落，压缩后又来了新尾部也照常落', () => {
    const session = Session.create(home, join(home, 'compact-b.jsonl'))
    try {
      session.appendUser('把这件事办完。')
      session.appendAssistant('好，先看边界。', '', [])
      const tail = session.messages[session.messages.length - 1]!
      const text = '（提醒：任务清单有未完成项）'
      const ledger = new InjectionNoteLedger()
      ledger.take('c2', tail, text)
      session.replaceWithSummary('摘要（压缩）', [{ role: 'user', content: '摘要（压缩）' }, tail])
      expect(ledger.take('c2', tail, `${text}（新增一项：部署）`)).toBe(true)
      expect(ledger.take('c2', { role: 'assistant', content: '压缩后的新尾' }, `${text}（新增一项：部署）`)).toBe(true)
    } finally {
      session.close()
    }
  })
})

describe('⑩ 注入清单的形状（夹具自检）', () => {
  test('A 是三类注入的组合，第 4 类只能是 B 多出来的那一条', () => {
    // 这条不是测产品代码，是钉住本文件用的夹具：下面「按 parts 判等」的用例都建立在
    // 「A 三部分、B 四部分」之上，夹具改坏了它们会一起失去判别力。
    expect(A).toHaveLength(3)
    expect(A.map((part) => part.kind)).toEqual(['env-facts', 'mode', 'sandbox'])
  })
})
