/**
 * 回合结束 / 等人卡的通知口径（迁自 `scripts/ui-turn-notify-test.mjs` 全部行为段）。
 *
 * 2026-11-07 报障：桌面通知只有「任务完成」一种——失败、输出超长、等人都没声音。
 * 这批用例钉四种结局的判定与正文口径：
 *   ① 完成 / 失败 / 输出超长三种结局都响，用户主动中断（aborted）不提示；
 *   ② 失败正文取本轮最后一条错误 system 条目、去掉「错误：」前缀；
 *   ③ 等人的卡（审批 > 计划 > 提问）按卡键提示，正文是卡上那行标题；
 *   ④ 正文一律压空白、截到 NOTICE_BODY_LIMIT（120 字）。
 *
 * 为什么是行为测试：`turn-notify.ts` 是纯函数模块（只 `import type`，零运行时依赖），
 * `turnEndNotice` / `waitingNotice` 的真跑结果就是被测行为。
 *
 * 不迁的部分（原探针第 [6] 段的两条源码钉）：「只有 type-only 导入」「没有别的 import」。
 * 那两条钉的是「Node 探针能靠类型剥离直读本文件」这个前提；Vitest 走 Vite 管线，模块
 * 带不带运行时依赖都能装载，前提本身失效，钉子随之退役（见交付报告缺口清单）。
 *
 * @module dsc-ui-transcript/ui/turn-notify.spec
 */
import { describe, expect, test } from 'vitest'
import type { Row } from './shared.js'
import { NOTICE_BODY_LIMIT, turnEndNotice, waitingNotice } from './turn-notify.js'

/** 一条座位行（通知判定只看 entry；stable 是座位身份，判定用不到但类型要求）。 */
const row = (entry: Row['entry']): Row => ({ entry, live: false, at: 0, stable: '' })
const text = (id: number, body: string, process?: true): Row =>
  row({ kind: 'text', id, text: body, ...(process === true ? { process: true } : {}) }) as Row
/** 200 个字的超长正文（截断断言用）。 */
const long = '甲'.repeat(200)

describe('done：有正文 / 无正文 / 只有过程正文', () => {
  const withText = turnEndNotice([text(1, '改好了，三处都过了测试')])

  test('有正文：kind = done，正文原样带出，文案键是 transcript.notify.done', () => {
    expect(withText?.kind).toBe('done')
    expect(withText?.body).toBe('改好了，三处都过了测试')
    expect(withText?.titleKey).toBe('transcript.notify.done')
  })

  test('正文压空白（换行与多余空格都收成一个）', () => {
    const wrapped = turnEndNotice([text(2, '  跑完了\n\n三处  都过了  ')])
    expect(wrapped?.body).toBe('跑完了 三处 都过了')
  })

  test('没有任何正文：body 是空串，但空行也给一条 done（不是 null）', () => {
    const empty = turnEndNotice([row({ kind: 'user', id: 1, text: '看看' })])
    expect(empty?.body).toBe('')
    expect(empty?.kind).toBe('done')
    expect(empty).not.toBeNull()
  })

  test('只有 process 正文：退回最后一条 text', () => {
    const onlyProcess = turnEndNotice([text(3, '我先读一下这两个文件', true)])
    expect(onlyProcess?.body).toBe('我先读一下这两个文件')
  })

  test('前面有正经正文时优先于后面带 process 标记的', () => {
    const mixed = turnEndNotice([text(4, '真正的收尾结论'), text(5, '调工具前的前言', true)])
    expect(mixed?.body).toBe('真正的收尾结论')
  })
})

describe('failed：取错误条目、去掉「错误：」前缀', () => {
  const failed = turnEndNotice([
    text(1, '开始干活'),
    row({ kind: 'system', id: 2, text: '错误：模型端点连不上（ECONNREFUSED）', level: 'error' }),
    row({ kind: 'turn-end', id: 3, reason: 'error' }),
  ])

  test('kind = failed，文案键是 transcript.notify.failed', () => {
    expect(failed?.kind).toBe('failed')
    expect(failed?.titleKey).toBe('transcript.notify.failed')
  })

  test('正文去掉了「错误：」前缀', () => {
    expect(failed?.body).toBe('模型端点连不上（ECONNREFUSED）')
  })

  test('去前缀后再压空白', () => {
    const messy = turnEndNotice([
      row({ kind: 'system', id: 1, text: '错误：\n 写不进 D:\\dsc\\a.ts\n  权限不足 ', level: 'error' }),
      row({ kind: 'turn-end', id: 2, reason: 'error' }),
    ])
    expect(messy?.body).toBe('写不进 D:\\dsc\\a.ts 权限不足')
  })

  test('没有错误条目：正文给空串（不拿正文顶）', () => {
    const noError = turnEndNotice([text(1, '这轮其实有一句正文'), row({ kind: 'turn-end', id: 2, reason: 'error' })])
    expect(noError?.body).toBe('')
  })

  test('多条错误条目取最后一条', () => {
    const twoErrors = turnEndNotice([
      row({ kind: 'system', id: 1, text: '错误：第一条', level: 'error' }),
      row({ kind: 'system', id: 2, text: '错误：第二条（最终）', level: 'error' }),
      row({ kind: 'turn-end', id: 3, reason: 'error' }),
    ])
    expect(twoErrors?.body).toBe('第二条（最终）')
  })

  test('只认 level=error 的 system 条目', () => {
    const infoIgnored = turnEndNotice([
      row({ kind: 'system', id: 1, text: '错误：这是 info 级别', level: 'info' }),
      row({ kind: 'turn-end', id: 2, reason: 'error' }),
    ])
    expect(infoIgnored?.body).toBe('')
  })

  test('失败与超长同时出现：failure 说了算（轮尾更靠后）', () => {
    const afterTruncate = turnEndNotice([
      row({ kind: 'turn-max-tokens', id: 1 }),
      row({ kind: 'system', id: 2, text: '错误：收尾请求失败', level: 'error' }),
      row({ kind: 'turn-end', id: 3, reason: 'error' }),
    ])
    expect(afterTruncate?.kind).toBe('failed')
  })
})

describe('aborted：用户主动中断，不提示', () => {
  test('aborted 返回 null', () => {
    expect(turnEndNotice([text(1, '干到一半'), row({ kind: 'turn-end', id: 2, reason: 'aborted' })])).toBeNull()
  })

  test('aborted 即便前面撞过长度上限也返回 null', () => {
    expect(
      turnEndNotice([row({ kind: 'turn-max-tokens', id: 1 }), row({ kind: 'turn-end', id: 2, reason: 'aborted' })]),
    ).toBeNull()
  })
})

describe('truncated：输出撞上长度上限', () => {
  const cut = turnEndNotice([text(1, '话说到一半'), row({ kind: 'turn-max-tokens', id: 2 })])

  test('kind = truncated，文案键是 transcript.notify.truncated，正文带出最后一句', () => {
    expect(cut?.kind).toBe('truncated')
    expect(cut?.titleKey).toBe('transcript.notify.truncated')
    expect(cut?.body).toBe('话说到一半')
  })

  test('没 process 标记的正文优先', () => {
    const preferPlain = turnEndNotice([
      text(1, '这一轮的结论'),
      text(2, '又调了一次工具', true),
      row({ kind: 'turn-max-tokens', id: 3 }),
    ])
    expect(preferPlain?.body).toBe('这一轮的结论')
  })

  test('正文截到 120 字', () => {
    const clipped = turnEndNotice([text(1, long), row({ kind: 'turn-max-tokens', id: 2 })])
    expect(clipped?.body.length).toBe(120)
  })

  test('没有正文时给空串', () => {
    const noText = turnEndNotice([row({ kind: 'turn-max-tokens', id: 1 })])
    expect(noText?.body).toBe('')
  })
})

describe('waitingNotice：审批 / 计划 / 提问三张卡', () => {
  test('approval：文案键对，正文压空白', () => {
    const approval = waitingNotice({ kind: 'approval', key: 'approval:a1', headline: '  bash   git push --force ' })
    expect(approval?.titleKey).toBe('transcript.notify.approval')
    expect(approval?.body).toBe('bash git push --force')
  })

  test('plan / question：正文是标题', () => {
    const plan = waitingNotice({ kind: 'plan', key: 'plan:.dsc/plans/p.md', headline: '重构通知层' })
    expect(plan?.titleKey).toBe('transcript.notify.plan')
    expect(plan?.body).toBe('重构通知层')
    const question = waitingNotice({ kind: 'question', key: 'question:q1', headline: '用哪种方案？' })
    expect(question?.titleKey).toBe('transcript.notify.question')
    expect(question?.body).toBe('用哪种方案？')
  })

  test('card 为 null 返回 null', () => {
    expect(waitingNotice(null)).toBeNull()
  })

  test('超长 headline 截到 120 字；空 headline 给空正文', () => {
    const longHead = waitingNotice({ kind: 'approval', key: 'approval:a2', headline: long })
    expect(longHead?.body.length).toBe(120)
    const blank = waitingNotice({ kind: 'plan', key: 'plan:x', headline: '   ' })
    expect(blank?.body).toBe('')
  })
})

describe('常量口径', () => {
  test('NOTICE_BODY_LIMIT = 120（改这里等于改通知口径）', () => {
    expect(NOTICE_BODY_LIMIT).toBe(120)
  })
})
