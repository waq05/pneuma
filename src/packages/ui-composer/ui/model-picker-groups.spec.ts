/**
 * 模型选择器的分组、定位、chip 文案与飞出几何（ui 层）。
 *
 * 来源：`scripts/ui-model-picker-test.mjs` 第 [1]–[7] 段里能单位化的纯逻辑（第 [1] 段的
 * effortChoices 已由本目录 `model-picker.spec.ts` 覆盖，这里补它没盖到的部分）。
 * `model-picker.ts` 只依赖取词器与本包字典（零 React），ui project 直接 import 跑真代码。
 *
 * 不迁的部分（原探针）：
 * - 第 [8][9] 段：`ui.tsx` 接线、契约与宿主的字段产地——渲染体 / 类型文本钉，无行为接缝，
 *   归组件渲染批（缺口清单）；
 * - 第 [10] 段：styles.css 的样式门（类名定义、令牌差集、尺寸）——CSS 文本，无行为接缝；
 * - 第 [11] 段：探针自证扫描器不是空转——那是探针自己的助手函数，Vitest 版不需要；
 *   其中「改坏了会红」的产品行为已由第 [1][7] 的行为断言覆盖。
 *
 * @module dsc-ui-composer/ui/model-picker-groups.spec
 */
import { describe, expect, test } from 'vitest'
import { THINKING_LEVEL_LABELS } from '@pneuma/runtime/core/model-caps.js'
import type { ModelChoiceView } from '@dsc/ui'
import {
  contextLabel,
  EFFORT_FALLBACK,
  EFFORT_LABELS,
  chooseFlyoutSide,
  clampShift,
  effortLabel,
  effortSwitchable,
  filterModels,
  findCurrent,
  FLYOUT_MAX_HEIGHT,
  FLYOUT_WIDTH,
  groupModels,
  modelBadges,
  modelChipText,
  placeFlyout,
  providerHint,
  shouldShowProviderLevel,
  type Box,
} from './model-picker.js'

/** 造一条宿主清单项（字段与 `ModelChoiceView` 一致，默认值取最常见的那一档）。 */
function choice(provider: string, model: string, extra: Partial<ModelChoiceView> = {}): ModelChoiceView {
  return {
    value: `${provider}/${model}`,
    provider,
    providerDisplayName: (extra.providerDisplayName as string) ?? provider,
    model,
    description: '',
    contextWindow: 128_000,
    thinkingLevels: ['off', 'low', 'high', 'max'],
    modalities: ['text'],
    ...extra,
  }
}

// ── 分组：按端点归组，顺序照宿主清单 ─────────────────────────────────────────

test('归成两组、顺序是首次出现的顺序；同端点的模型聚在一组里', () => {
  const groups = groupModels([choice('deepseek', 'a'), choice('command', 'b'), choice('deepseek', 'c')])
  expect(groups).toHaveLength(2)
  expect(groups[0]?.provider).toBe('deepseek')
  expect(groups[1]?.provider).toBe('command')
  expect(groups[0]?.models).toHaveLength(2)
  expect(groups[0]?.models[1]?.model).toBe('c')
})

test('端点显示名：宿主给了就用它；宿主没填（空串）时回落端点名，不留空标题', () => {
  const groups = groupModels([choice('deepseek', 'a'), choice('command', 'b', { providerDisplayName: 'Command Code' })])
  expect(groups[1]?.displayName).toBe('Command Code')
  expect(groups[0]?.displayName).toBe('deepseek')
})

test('空清单不炸', () => {
  expect(groupModels([])).toHaveLength(0)
})

// ── 当前模型的精确定位 ───────────────────────────────────────────────────────

describe('findCurrent：按「端点 + 裸名」精确定位', () => {
  const groups = groupModels([choice('command', 'deepseek-v4.1-flash'), choice('opencode', 'deepseek-v4.1-flash')])

  test('同一个 id 挂两个端点：命中的是 status.provider 指的那一个', () => {
    const hit = findCurrent(groups, 'opencode', 'deepseek-v4.1-flash')
    expect(hit.entry?.value).toBe('opencode/deepseek-v4.1-flash')
    expect(hit.exact).toBe(true)
  })

  test('同一件事走另一条端点也对（不是靠顺序撞上的）', () => {
    expect(findCurrent(groups, 'command', 'deepseek-v4.1-flash').entry?.value).toBe('command/deepseek-v4.1-flash')
  })

  test('端点未知时退回裸名匹配，并如实标记不是精确命中', () => {
    expect(findCurrent(groups, '', 'deepseek-v4.1-flash').exact).toBe(false)
  })

  test('`status.model` 本身是完整值时也能命中（远程页与老记录里有这种形态）', () => {
    expect(findCurrent(groups, '', 'opencode/deepseek-v4.1-flash').entry?.value).toBe('opencode/deepseek-v4.1-flash')
  })

  test('清单里没有这个模型 / 模型名为空 / 端点对但模型名对不上：都不给命中', () => {
    expect(findCurrent(groups, 'deepseek', 'ghost-model').entry).toBeUndefined()
    expect(findCurrent(groups, 'deepseek', '').entry).toBeUndefined()
    expect(findCurrent(groups, 'command', 'gpt-9').entry).toBeUndefined()
  })
})

// ── chip 文案：多端点带前缀，单端点不带 ─────────────────────────────────────

describe('modelChipText', () => {
  const two = groupModels([choice('command', 'glm-5.3-flash', { providerDisplayName: 'Command Code' }), choice('opencode', 'haiku')])

  test('多端点：前缀是显示名 + 斜杠，名字是模型名（两段分开给，窄屏才收得掉）', () => {
    const chip = modelChipText(two, 'command', 'glm-5.3-flash')
    expect(chip.prefix).toBe('Command Code/')
    expect(chip.name).toBe('glm-5.3-flash')
    expect(chip.full).toBe('Command Code/glm-5.3-flash')
  })

  test('只有一个端点：不带前缀（纯噪音）', () => {
    const one = groupModels([choice('deepseek', 'deepseek-v4-pro')])
    expect(modelChipText(one, 'deepseek', 'deepseek-v4-pro').prefix).toBe('')
    expect(modelChipText(one, 'deepseek', 'deepseek-v4-pro').full).toBe('deepseek-v4-pro')
  })

  test('模型不在清单里：原样显示宿主给的值，不吞也不改名', () => {
    expect(modelChipText(two, 'command', 'ghost').full).toBe('Command Code/ghost')
  })

  test('还没选模型：说「未知模型」，不画一对空斜杠', () => {
    const chip = modelChipText(two, '', '')
    expect(chip.name).toBe('未知模型')
    expect(chip.prefix).toBe('')
  })
})

// ── 档位：清单恒含「默认」、文案与宿主表同值 ─────────────────────────────────

test('模型查不到（清单没取到 / 不在清单里）：兜底五档，默认在最前', () => {
  expect([...EFFORT_FALLBACK]).toEqual(['default', 'off', 'low', 'high', 'max'])
})

test('只有一档就不给浮层（单档模型不给箭头）', () => {
  expect(effortSwitchable(['default'])).toBe(false)
  expect(effortSwitchable(['default', 'high'])).toBe(true)
})

test('档位文案取不到原值时原样显示（不编一个假名字）', () => {
  expect(effortLabel('high')).toBe('高')
  expect(effortLabel('weird')).toBe('weird')
})

test('壳里那份档位文案是宿主表的镜像：四档逐字相同、顺序对得上', () => {
  // 宿主那张表是**真读**来的（不是抄一份进测试再对抄）：镜像门要对着它比。
  for (const level of ['off', 'low', 'high', 'max'] as const) {
    expect(EFFORT_LABELS[level], `档位 ${level} 与宿主 THINKING_LEVEL_LABELS 同值`).toBe(THINKING_LEVEL_LABELS[level])
  }
})

test('多出来的那一档是「默认」（不发思考字段，宿主恒认）', () => {
  expect(EFFORT_LABELS.default).toBe('默认')
})

// ── 徽标 / 读数 / 一级开关 / 尾注 / 搜索 ─────────────────────────────────────

test('能收图 → 标「图」；图片 + 视频 → 两个标（顺序固定）；纯文本不吃标', () => {
  expect(modelBadges(choice('a', 'b', { modalities: ['text', 'image'] }))).toEqual(['图'])
  expect(modelBadges(choice('a', 'b', { modalities: ['text', 'image', 'video'] }))).toEqual(['图', '视频'])
  expect(modelBadges(choice('a', 'b'))).toHaveLength(0)
})

test('上下文读数：取整到 k；缺失（0 / 非数）给空串，不画「0k」', () => {
  expect(contextLabel(1_000_000)).toBe('1000k')
  expect(contextLabel(256_128)).toBe('256k')
  expect(contextLabel(0)).toBe('')
  expect(contextLabel(Number.NaN)).toBe('')
})

test('多端点才摆一级（单端点直接列模型）', () => {
  const groups = groupModels([choice('a', 'm'), choice('b', 'n')])
  expect(shouldShowProviderLevel(groups)).toBe(true)
  expect(shouldShowProviderLevel([groups[0] as NonNullable<(typeof groups)[number]>])).toBe(false)
})

test('尾注：当前模型属于这一家时才给模型名', () => {
  const groups = groupModels([choice('a', 'm'), choice('b', 'n')])
  const current = findCurrent(groups, 'a', 'm')
  expect(providerHint(groups[0] as NonNullable<(typeof groups)[number]>, current)).toBe('m')
  expect(providerHint(groups[1] as NonNullable<(typeof groups)[number]>, current)).toBe('')
})

test('搜索：空白不筛；按名字与完整值都筛得到', () => {
  const groups = groupModels([choice('a', 'm'), choice('b', 'n')])
  expect(filterModels(groups[0]?.models ?? [], '   ')).toHaveLength(1)
  expect(filterModels([choice('a', 'glm-5')], 'glm')).toHaveLength(1)
  expect(filterModels([choice('cmd', 'x')], 'cmd/x')).toHaveLength(1)
})

// ── 飞出卡：挑边与夹高度（纯判定，量到的 rect 由界面喂） ─────────────────────

describe('chooseFlyoutSide：判据是裁剪容器而不是视口', () => {
  const roomy: Box = { left: 0, right: 1440 }

  test('右边放得下就走右边（与 ZCode 一致）；正好放下也算放得下', () => {
    expect(chooseFlyoutSide({ left: 400, right: 592 }, roomy, 264)).toBe('right')
    expect(chooseFlyoutSide({ left: 400, right: 592 }, { left: 0, right: 592 + 8 + 264 + 6 }, 264)).toBe('right')
  })

  test('差一像素就翻到左边；右边挤得只剩一点、左边放得下：也翻到左边', () => {
    expect(chooseFlyoutSide({ left: 400, right: 592 }, { left: 0, right: 592 + 8 + 264 + 5 }, 264)).toBe('left')
    expect(chooseFlyoutSide({ left: 400, right: 592 }, { left: 0, right: 700 }, 264)).toBe('left')
  })

  test('两边都塞不下就盖住一级（硬飞会被裁剪容器裁掉半张卡，模型名读不全）', () => {
    expect(chooseFlyoutSide({ left: 278, right: 470 }, { left: 56, right: 620 }, 264)).toBe('overlay')
  })

  test('判据是裁剪容器而不是视口：视口放得下、容器放不下时一样走 overlay', () => {
    // 同一个面板，容器窄（620）走 overlay、容器宽（1150）走右边——判据吃的是喂进来的盒子。
    expect(chooseFlyoutSide({ left: 278, right: 470 }, { left: 56, right: 620 }, 264)).toBe('overlay')
    expect(chooseFlyoutSide({ left: 278, right: 470 }, { left: 0, right: 1150 }, 264)).toBe('right')
  })

  test('卡片宽度与高度上限是唯二的两个数（CSS 通过变量读它们，不许两处各写一份）', () => {
    expect(FLYOUT_WIDTH).toBe(264)
    expect(FLYOUT_MAX_HEIGHT).toBe(288)
  })
})

describe('placeFlyout：夹在面板的上下边之间，绝不盖住输入行', () => {
  test('卡片比剩下的空间矮：顶端对齐悬浮那一行', () => {
    expect(placeFlyout(40, 72, 300, 200)).toEqual({ top: 40, maxHeight: 200 })
  })

  test('卡片比面板内高还高：压到面板内高（300-24），自己滚，位置退到顶边', () => {
    expect(placeFlyout(40, 72, 300, 500)).toEqual({ top: 12, maxHeight: 276 })
  })

  test('停在最后一行：整体上移，底边与自己那一行对齐', () => {
    expect(placeFlyout(250, 282, 300, 100)).toEqual({ top: 182, maxHeight: 100 })
  })

  test('面板本身就矮（端点很少）：上限收到面板内高，位置退到顶边', () => {
    expect(placeFlyout(40, 72, 100, 200)).toEqual({ top: 12, maxHeight: 76 })
  })

  test('六组典型位置都夹在面板里（顶不越顶边、底不越底边）', () => {
    const rows: Array<[number, number, number, number]> = [
      [12, 44, 300, 288],
      [40, 72, 220, 180],
      [150, 182, 240, 96],
      [200, 232, 300, 288],
      [12, 44, 120, 400],
      [280, 300, 320, 40],
    ]
    const overflows = rows.filter(([rowTop, rowBottom, panelHeight, cardHeight]) => {
      const placed = placeFlyout(rowTop, rowBottom, panelHeight, cardHeight)
      return placed.top < 12 || placed.top + placed.maxHeight > panelHeight - 12 + 0.001
    })
    expect(overflows).toHaveLength(0)
  })
})

describe('clampShift：面板贴边时把它推回裁剪容器里', () => {
  test('面板在容器里：不用动', () => {
    expect(clampShift({ left: 278, right: 470 }, { left: 56, right: 620 })).toBe(0)
  })

  test('面板探出左边（390px 实测的形状）：往右推到余量线上', () => {
    expect(clampShift({ left: -78, right: 242 }, { left: 56, right: 390 })).toBe(138)
  })

  test('面板探出右边：往左推', () => {
    expect(clampShift({ left: 600, right: 920 }, { left: 56, right: 900 })).toBe(-24)
  })

  test('两边都探出（面板比容器还宽）：先保左边（名字在左边，读数在右边）', () => {
    expect(clampShift({ left: -50, right: 500 }, { left: 56, right: 300 })).toBe(110)
  })
})
