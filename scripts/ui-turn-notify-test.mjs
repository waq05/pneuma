/**
 * 回合结束 / 等人卡的提示口径（2026-11-07）：桌面通知不再只有「任务完成」一种。
 *
 * 四条钉子：
 *   ① 完成 / 失败 / 输出超长三种结局都响，用户主动中断（aborted）不提示；
 *   ② 失败正文取本轮最后一条错误 system 条目、去掉「错误：」前缀；
 *   ③ 等人的卡（审批 > 计划 > 提问）按卡键只提示一次，正文是卡上那行标题；
 *   ④ 正文一律压空白、截到 NOTICE_BODY_LIMIT（120 字）。
 *
 * 运行：node scripts/ui-turn-notify-test.mjs
 *
 * @module dsc/scripts/ui-turn-notify-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 纯函数模块：只 import type，Node 的类型剥离跑得起来（不会拉起 React 链）。
const notify = await import(
  new URL('../src/packages/ui-transcript/ui/turn-notify.ts', import.meta.url).href
)
const { NOTICE_BODY_LIMIT, turnEndNotice, waitingNotice } = notify

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}

/** 一条座位行（只要 entry，另外两项探针用不到）。 */
const row = (entry) => ({ entry, live: false, at: 0 })
const text = (id, body, process) => row({ kind: 'text', id, text: body, ...(process === true ? { process: true } : {}) })
const long = '甲'.repeat(200)

console.log('\n[1] done：有正文 / 无正文 / 只有过程正文')
{
  const withText = turnEndNotice([text(1, '改好了，三处都过了测试')])
  check('有正文：kind = done', withText?.kind === 'done', JSON.stringify(withText))
  check('有正文：正文原样带出', withText?.body === '改好了，三处都过了测试', String(withText?.body))
  check("有正文：文案键是 'transcript.notify.done'", withText?.titleKey === 'transcript.notify.done', String(withText?.titleKey))

  const wrapped = turnEndNotice([text(2, '  跑完了\n\n三处  都过了  ')])
  check('正文压空白（换行与多余空格都收成一个）', wrapped?.body === '跑完了 三处 都过了', String(wrapped?.body))

  const empty = turnEndNotice([row({ kind: 'user', id: 1, text: '看看' })])
  check('没有任何正文：body 是空串', empty?.body === '', JSON.stringify(empty))

  const onlyProcess = turnEndNotice([text(3, '我先读一下这两个文件', true)])
  check('只有 process 正文：退回最后一条 text', onlyProcess?.body === '我先读一下这两个文件', String(onlyProcess?.body))

  const mixed = turnEndNotice([text(4, '真正的收尾结论'), text(5, '调工具前的前言', true)])
  check('前面有正经正文时优先于后面带 process 标记的', mixed?.body === '真正的收尾结论', String(mixed?.body))

  check('空行也给一条 done（不是 null）', empty !== null && empty.kind === 'done')
}

console.log('\n[2] failed：取错误条目、去掉「错误：」前缀')
{
  const failed = turnEndNotice([
    text(1, '开始干活'),
    row({ kind: 'system', id: 2, text: '错误：模型端点连不上（ECONNREFUSED）', level: 'error' }),
    row({ kind: 'turn-end', id: 3, reason: 'error' }),
  ])
  check('kind = failed', failed?.kind === 'failed', JSON.stringify(failed))
  check("文案键是 'transcript.notify.failed'", failed?.titleKey === 'transcript.notify.failed', String(failed?.titleKey))
  check('正文去掉了「错误：」前缀', failed?.body === '模型端点连不上（ECONNREFUSED）', String(failed?.body))

  const messy = turnEndNotice([
    row({ kind: 'system', id: 1, text: '错误：\n 写不进 D:\\dsc\\a.ts\n  权限不足 ', level: 'error' }),
    row({ kind: 'turn-end', id: 2, reason: 'error' }),
  ])
  check('去前缀后再压空白', messy?.body === '写不进 D:\\dsc\\a.ts 权限不足', String(messy?.body))

  const noError = turnEndNotice([
    text(1, '这轮其实有一句正文'),
    row({ kind: 'turn-end', id: 2, reason: 'error' }),
  ])
  check('没有错误条目：正文给空串（不拿正文顶）', noError?.body === '', JSON.stringify(noError?.body))

  const twoErrors = turnEndNotice([
    row({ kind: 'system', id: 1, text: '错误：第一条', level: 'error' }),
    row({ kind: 'system', id: 2, text: '错误：第二条（最终）', level: 'error' }),
    row({ kind: 'turn-end', id: 3, reason: 'error' }),
  ])
  check('多条错误条目取最后一条', twoErrors?.body === '第二条（最终）', String(twoErrors?.body))

  const infoIgnored = turnEndNotice([
    row({ kind: 'system', id: 1, text: '错误：这是 info 级别', level: 'info' }),
    row({ kind: 'turn-end', id: 2, reason: 'error' }),
  ])
  check('只认 level=error 的 system 条目', infoIgnored?.body === '', JSON.stringify(infoIgnored?.body))

  const afterTruncate = turnEndNotice([
    row({ kind: 'turn-max-tokens', id: 1 }),
    row({ kind: 'system', id: 2, text: '错误：收尾请求失败', level: 'error' }),
    row({ kind: 'turn-end', id: 3, reason: 'error' }),
  ])
  check('失败与超长同时出现：failure 说了算（轮尾更靠后）', afterTruncate?.kind === 'failed', JSON.stringify(afterTruncate))
}

console.log('\n[3] aborted：用户主动中断，不提示')
{
  check('aborted 返回 null', turnEndNotice([text(1, '干到一半'), row({ kind: 'turn-end', id: 2, reason: 'aborted' })]) === null)
  check(
    'aborted 即便前面撞过长度上限也返回 null',
    turnEndNotice([row({ kind: 'turn-max-tokens', id: 1 }), row({ kind: 'turn-end', id: 2, reason: 'aborted' })]) === null,
  )
}

console.log('\n[4] truncated：输出撞上长度上限')
{
  const cut = turnEndNotice([text(1, '话说到一半'), row({ kind: 'turn-max-tokens', id: 2 })])
  check('kind = truncated', cut?.kind === 'truncated', JSON.stringify(cut))
  check("文案键是 'transcript.notify.truncated'", cut?.titleKey === 'transcript.notify.truncated', String(cut?.titleKey))
  check('正文带出最后一句', cut?.body === '话说到一半', String(cut?.body))

  const preferPlain = turnEndNotice([
    text(1, '这一轮的结论'),
    text(2, '又调了一次工具', true),
    row({ kind: 'turn-max-tokens', id: 3 }),
  ])
  check('没 process 标记的正文优先', preferPlain?.body === '这一轮的结论', String(preferPlain?.body))

  const clipped = turnEndNotice([text(1, long), row({ kind: 'turn-max-tokens', id: 2 })])
  check('正文截到 120 字', clipped?.body.length === 120, String(clipped?.body.length))

  const noText = turnEndNotice([row({ kind: 'turn-max-tokens', id: 1 })])
  check('没有正文时给空串', noText?.body === '', JSON.stringify(noText))
}

console.log('\n[5] waitingNotice：审批 / 计划 / 提问三张卡')
{
  const approval = waitingNotice({ kind: 'approval', key: 'approval:a1', headline: '  bash   git push --force ' })
  check('approval 文案键', approval?.titleKey === 'transcript.notify.approval', String(approval?.titleKey))
  check('approval 正文压空白', approval?.body === 'bash git push --force', String(approval?.body))

  const plan = waitingNotice({ kind: 'plan', key: 'plan:.dsc/plans/p.md', headline: '重构通知层' })
  check('plan 文案键', plan?.titleKey === 'transcript.notify.plan', String(plan?.titleKey))
  check('plan 正文是标题', plan?.body === '重构通知层', String(plan?.body))

  const question = waitingNotice({ kind: 'question', key: 'question:q1', headline: '用哪种方案？' })
  check('question 文案键', question?.titleKey === 'transcript.notify.question', String(question?.titleKey))
  check('question 正文是标题', question?.body === '用哪种方案？', String(question?.body))

  check('card 为 null 返回 null', waitingNotice(null) === null)

  const longHead = waitingNotice({ kind: 'approval', key: 'approval:a2', headline: long })
  check('超长 headline 截到 120 字', longHead?.body.length === 120, String(longHead?.body.length))

  const blank = waitingNotice({ kind: 'plan', key: 'plan:x', headline: '   ' })
  check('空 headline 给空正文', blank?.body === '', JSON.stringify(blank))
}

console.log('\n[6] 常量与零依赖')
{
  check('NOTICE_BODY_LIMIT = 120', NOTICE_BODY_LIMIT === 120, String(NOTICE_BODY_LIMIT))
  const source = readFileSync(
    fileURLToPath(new URL('../src/packages/ui-transcript/ui/turn-notify.ts', import.meta.url)),
    'utf8',
  )
  check('只有 type-only 导入（运行时零依赖）', /^import type \{ Row \} from '\.\/shared'$/m.test(source))
  check('没有别的 import 语句', source.split('\n').filter((line) => /^import /.test(line)).length === 1)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`)
process.exit(failures === 0 ? 0 : 1)
