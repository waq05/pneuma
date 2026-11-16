/**
 * 自我改进插件的纯决策面（`packages/self-improve/index.ts`）：模型回答解析、整理节流、一次整理的边界。
 *
 * 真整理（搬目录、写台账）归 integration；这里喂字符串与依赖记录器，钉「认哪种回答、什么时候才动手」。
 *
 * @module dsc/packages/self-improve/tests/draft.spec
 */
import { describe, expect, test } from 'vitest'
import { autoCurateOnce, CURATE_INTERVAL_MS, parseDraftAnswer, shouldCurate, type AutoCurateDeps } from '../index.js'

const DRAFT = { name: 'demo-skill', description: '一句话', whenToUse: '需要时', content: '正文内容' }

describe('parseDraftAnswer：新建', () => {
  test('空回答 / 只有 NONE：各给明确结论', () => {
    expect(parseDraftAnswer('   ')).toMatchObject({ kind: 'invalid' })
    expect(parseDraftAnswer('NONE')).toEqual({ kind: 'none' })
    expect(parseDraftAnswer('none，这次没有可提炼的')).toEqual({ kind: 'none' })
  })

  test('一行 JSON、代码块、先说话后给 JSON 都认；别名字段也收', () => {
    expect(parseDraftAnswer(JSON.stringify(DRAFT))).toMatchObject({ kind: 'draft', draft: DRAFT })
    expect(parseDraftAnswer('```json\n' + JSON.stringify(DRAFT) + '\n```')).toMatchObject({ kind: 'draft' })
    expect(parseDraftAnswer('好的，提炼如下：\n' + JSON.stringify(DRAFT))).toMatchObject({ kind: 'draft' })

    const alias = parseDraftAnswer(
      JSON.stringify({ name: 'x', description: 'd', when_to_use: 'w', body: 'b' }),
    )
    expect(alias).toMatchObject({ kind: 'draft', draft: { whenToUse: 'w', content: 'b' } })
  })

  test('字段不合法（名字/正文超限）由校验拦下并给原因', () => {
    const result = parseDraftAnswer(JSON.stringify({ name: 'Bad Name!', description: 'd', whenToUse: 'w', content: 'c' }))
    expect(result).toMatchObject({ kind: 'invalid' })
    if (result.kind === 'invalid') expect(result.error).not.toBe('')
  })

  test('找不到可解析的一行：给一句示例形状', () => {
    const result = parseDraftAnswer('这次只有散文，没有 JSON')
    expect(result).toMatchObject({ kind: 'invalid' })
    if (result.kind === 'invalid') expect(result.error).toContain('没找到')
  })
})

describe('parseDraftAnswer：改一处（patch）', () => {
  test('四个字段齐全就是一条修订；oldString/newString 别名也认', () => {
    const patch = { action: 'patch', name: 'demo-skill', old_string: '旧', new_string: '新', reason: '纠正' }
    expect(parseDraftAnswer(JSON.stringify(patch))).toEqual({
      kind: 'revision',
      revision: { name: 'demo-skill', old_string: '旧', new_string: '新', reason: '纠正' },
    })
    expect(
      parseDraftAnswer(JSON.stringify({ action: 'PATCH', name: 'x', oldString: 'a', newString: 'b', reason: 'r' })),
    ).toMatchObject({ kind: 'revision', revision: { old_string: 'a', new_string: 'b' } })
  })

  test('缺字段逐项点名；新旧相同算没改', () => {
    const missing = parseDraftAnswer(JSON.stringify({ action: 'patch', name: 'x' }))
    expect(missing).toMatchObject({ kind: 'invalid' })
    if (missing.kind === 'invalid') {
      expect(missing.error).toContain('old_string')
      expect(missing.error).toContain('new_string')
      expect(missing.error).toContain('reason')
    }
    const same = parseDraftAnswer(
      JSON.stringify({ action: 'patch', name: 'x', old_string: '一样', new_string: '一样', reason: 'r' }),
    )
    expect(same).toMatchObject({ kind: 'invalid' })
    if (same.kind === 'invalid') expect(same.error).toContain('什么都没改')
  })
})

describe('shouldCurate / autoCurateOnce', () => {
  test('从没跑过（0 / 负数 / 非有限）就跑；距上次满一个间隔才跑', () => {
    expect(shouldCurate(0, 1_000)).toBe(true)
    expect(shouldCurate(-1, 1_000)).toBe(true)
    expect(shouldCurate(Number.NaN, 1_000)).toBe(true)
    expect(shouldCurate(1_000, Number.NaN)).toBe(false)
    expect(shouldCurate(1_000, 1_000 + CURATE_INTERVAL_MS)).toBe(true)
    expect(shouldCurate(1_000, 1_000 + CURATE_INTERVAL_MS - 1)).toBe(false)
    expect(shouldCurate(1_000, 1_500, 1_000)).toBe(false)
    expect(shouldCurate(1_000, 2_000, 1_000)).toBe(true)
  })

  test('开关关着 / 节流未到：一次都不动手，也不写时间戳', () => {
    const calls: string[] = []
    const deps = (overrides: Partial<AutoCurateDeps> = {}): AutoCurateDeps => ({
      enabled: true,
      now: 10_000_000,
      lastRunAt: 0,
      curate: () => {
        calls.push('curate')
        return { stale: [], archived: [] }
      },
      saveLastRunAt: () => calls.push('save'),
      announce: () => calls.push('announce'),
      changed: () => calls.push('changed'),
      ...overrides,
    })

    expect(autoCurateOnce(deps({ enabled: false }))).toEqual({ ran: false, text: '', report: null })
    expect(autoCurateOnce(deps({ lastRunAt: 10_000_000 }))).toEqual({ ran: false, text: '', report: null })
    expect(calls).toEqual([])
  })

  test('跑了但没降级/归档：写时间戳，但不打扰用户也不重算目录', () => {
    const calls: string[] = []
    const outcome = autoCurateOnce({
      enabled: true,
      now: 10_000_000,
      lastRunAt: 0,
      curate: () => {
        calls.push('curate')
        return { stale: [], archived: [] }
      },
      saveLastRunAt: () => calls.push('save'),
      announce: () => calls.push('announce'),
      changed: () => calls.push('changed'),
    })
    expect(outcome).toMatchObject({ ran: true, text: '' })
    expect(calls).toEqual(['curate', 'save'])
  })

  test('有降级/归档：说清数量并通知重算', () => {
    const calls: string[] = []
    const outcome = autoCurateOnce({
      enabled: true,
      now: 10_000_000,
      lastRunAt: 0,
      curate: () => ({ stale: ['a'], archived: ['b', 'c'] }),
      saveLastRunAt: () => calls.push('save'),
      announce: (text) => calls.push(text),
      changed: () => calls.push('changed'),
    })
    expect(outcome.ran).toBe(true)
    expect(outcome.text).toContain('1 个降为 stale')
    expect(outcome.text).toContain('2 个搬进归档区')
    expect(outcome.text).toContain('/skills-ledger')
    expect(calls[0]).toBe('save')
    expect(calls[1]).toBe(outcome.text)
    expect(calls).toContain('changed')
  })
})
