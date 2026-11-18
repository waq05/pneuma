/**
 * 两张「请求账单」卡（系统提示 ⚙ / 上下文注入 ⊕）的文案字典（迁自
 * `scripts/ui-prompt-cards-test.mjs` 第 [6] 段）。
 *
 * 报障背景：两张卡的次数、段数、hash、来源位置全部取自字典；翻丢了占位符或键名写错，
 * 界面会把「{count}」或键名原样摆出来。27 个键在 zh / en 必须都在、键集一致、英文真译过、
 * 占位符两边同名同数量——这些对着字典本身查（locale JSON 是运行时读的数据，不是源码），
 * 与 `compaction-locale.spec.ts` 同一手法。
 *
 * 原探针第 [6] 段里「卡片用到的每一个键都在字典里」「两组键与卡片用到的键完全一致（无死键、
 * 无漏写）」不迁：那要从 prompt-card.tsx 的源码里抓 `t('…')` 字面量（文案闸管的事，且是
 * 源码文本钉），归组件渲染批，见交付报告缺口清单。其余六段（组件 JSX、render 接线、
 * round-fold / rounds / ui.tsx 结构表、views.css 样式、反向钉）同样不迁——组件与样式要真
 * 渲染才有行为接缝，归组件渲染批。
 *
 * @module dsc-ui-transcript/ui/prompt-cards-locale.spec
 */
import { describe, expect, test } from 'vitest'
import en from '../locale/ui.en.json'
import zh from '../locale/ui.zh.json'

/** 汉字（与 ui-locale-test 同一条范围）。 */
const CJK = /[\u4e00-\u9fff]/
/** 两张卡的键前缀：系统提示卡 prompt.* 与上下文注入卡 injection.*。 */
const PREFIXES = ['transcript.prompt.', 'transcript.injection.']

const keysOf = (dict: Record<string, unknown>): string[] =>
  Object.keys(dict).filter((key) => PREFIXES.some((prefix) => key.startsWith(prefix))).sort()

describe('两张卡一共 28 个键（2026-11-11 起含注入卡的 newOnlyTip；2026-11-18 起含团队板快照标签）', () => {
  test('中文与英文表里正好 28 个，且键集逐项一致（缺译 / 多键都不放过）', () => {
    const zhKeys = keysOf(zh)
    const enKeys = keysOf(en)
    expect(zhKeys).toHaveLength(28)
    expect(zhKeys).toEqual(enKeys)
  })

  test('每个键在 zh / en 都是非空字符串', () => {
    const empty = keysOf(zh).filter(
      (key) =>
        typeof (zh as Record<string, unknown>)[key] !== 'string' ||
        ((zh as Record<string, string>)[key] ?? '') === '' ||
        typeof (en as Record<string, unknown>)[key] !== 'string' ||
        ((en as Record<string, string>)[key] ?? '') === '',
    )
    expect(empty).toEqual([])
  })

  test('英文真译过（不含汉字）', () => {
    const untranslated = keysOf(en).filter((key) => CJK.test((en as Record<string, string>)[key] ?? ''))
    expect(untranslated).toEqual([])
  })

  test('占位符两边同名同数量（翻丢了会显示半截话）', () => {
    const slotsOf = (value: string): string => (value.match(/\{\w+\}/g) ?? []).sort().join(',')
    const broken = keysOf(zh)
      .map((key) => {
        const zhSlots = slotsOf((zh as Record<string, string>)[key] ?? '')
        const enSlots = slotsOf((en as Record<string, string>)[key] ?? '')
        return zhSlots === enSlots ? null : `${key}: ${zhSlots} vs ${enSlots}`
      })
      .filter((item) => item !== null)
    expect(broken).toEqual([])
  })

  test('中文侧说清「段」「字数」「环境快照」这几个词（口径词不丢）', () => {
    const dict = zh as Record<string, string>
    expect(dict['transcript.prompt.sections']).toContain('段')
    expect(dict['transcript.prompt.chars']).toContain('字')
    expect(dict['transcript.injection.kind.envFacts']).toContain('环境')
  })
})
