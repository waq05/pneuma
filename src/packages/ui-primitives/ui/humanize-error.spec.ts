/**
 * humanizeError 真值表（迁自 `scripts/ui-interaction-base-test.mjs` 第 [1] 段）。
 *
 * 这一段是「错误文案的人话层」：网络断、路径没了、凭据不对、限流、服务端 5xx、超时、
 * 没命中规则的原样回落、空值。真值表落在 `humanizeError` / `humanErrorLine` /
 * `humanErrorText` 的真实返回上——判据对「永远返回同一句」的假实现必须红，
 * 所以表末保留了那条**负向对照**（万能话实现在同一张表上必须大面积不符）。
 *
 * 为什么归 ui project：`humanize-error.ts` 从 `@dsc/ui-core` 取词并直接 import 两份
 * 字典 JSON，unit 层（node、无 `@dsc/*` 别名）装载不了。
 *
 * 原探针没迁的：[2] 弹层焦点 hook 的逐条文本钉与四个接入点、[3] 骨架屏的 CSS/组件
 * 文本钉、[4]–[11] 各轮走查的 CSS/JSX 结构钉——按手册 §2 属必删项，接缝在渲染层，
 * 归「待组件渲染批」；见交付报告缺口清单。
 *
 * @module dsc-ui-primitives/ui/humanize-error.spec
 */
import { describe, expect, test } from 'vitest'
import { humanErrorLine, humanErrorText, humanizeError } from './humanize-error.js'

/** 真值表：原样摘自探针（每条都对应一类真实事故）。 */
const CASES: ReadonlyArray<readonly [string, string]> = [
  ['Error: connect ECONNREFUSED 127.0.0.1:17321', '连不上宿主'],
  ['TypeError: Failed to fetch', '连不上宿主'],
  ["Error: ENOENT: no such file or directory, open 'D:\\nope'", '这个路径不存在了'],
  ['Error: EACCES: permission denied, mkdir', '系统不允许这一步'],
  ['HTTP 401 Unauthorized: invalid api key', '凭据不对或过期'],
  ['Error: 429 Too Many Requests', '请求太频繁，被服务方限流了'],
  ['Error: ETIMEDOUT while reading', '等太久了，请求被掐断'],
  ['HTTP 502 Bad Gateway', '对方服务自己出错了'],
]

describe('humanizeError 真值表', () => {
  test.each(CASES)('「%s」→ %s，原文保留且有下一步', (input, title) => {
    const got = humanizeError(input)
    expect(got.title).toBe(title)
    expect(got.detail).toBe(input)
    expect(typeof got.hint).toBe('string')
    expect(got.hint.length).toBeGreaterThanOrEqual(4)
  })

  test('没命中规则：原文第一句当标题（去掉 Error: 前缀），不吞成一句万能话', () => {
    const generic = humanizeError('Error: 会话文件校验不过\n    at readSession (x.js:1:1)')
    expect(generic.title).toBe('会话文件校验不过')
    expect(generic.hint).toContain('再试一次')
    expect(generic.detail).toContain('at readSession')
  })

  test('空值回落成给定文案、不抛；非字符串值可被 String 化', () => {
    const empty = humanizeError(undefined)
    expect(empty.title).toBe('这一步没有完成')
    expect(empty.detail).toBe('')
    expect(humanizeError({ code: 1 }).detail).toContain('code')
  })

  test('负向对照：万能话实现在同一张表上大面积不符（表真的在区分错因）', () => {
    const naive = (): { title: string; hint: string; detail: string } => ({ title: '操作失败', hint: '请重试', detail: '' })
    const misses = CASES.filter(([input, title]) => naive().title !== title).length
    expect(misses).toBe(CASES.length)
  })
})

describe('单行与两段形态', () => {
  test('humanErrorLine 是单行且含下一步（toast 只有一行）', () => {
    const line = humanErrorLine('Error: ENOENT: no such file')
    expect(line.includes('\n')).toBe(false)
    expect(line).toContain('——')
    expect(line).toContain('路径')
  })

  test('humanErrorText 给 text + detail 两件', () => {
    const inline = humanErrorText('Error: connect ECONNREFUSED', '读取失败')
    expect(inline.text).toContain('连不上宿主')
    expect(inline.detail).toContain('ECONNREFUSED')
  })
})
