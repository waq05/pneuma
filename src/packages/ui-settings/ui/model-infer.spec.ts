/**
 * 「拉取的模型按能力自动配置」的四档推断（ui 层）。
 *
 * 来源：`scripts/ui-model-caps-test.mjs` 第 [1] 段（归一化 / 尺寸标记 / 视觉词 / 四档来源的
 * 优先级 / 家族表顺序）与第 [2] 段里能单位化的部分（缺省常数与宿主同值——真 import 宿主
 * 常量对着比，不再是「config.ts 里含有 128_000 这串文本」）。
 * `model-infer.ts` 只依赖取词器与本包字典（零 React），ui project 直接 import 跑真代码。
 *
 * 不迁的部分（原探针）：第 [2] 段的 config.ts 文本钉、第 [3] 段壳侧接线（models.tsx 的忙碌
 * 集合写法、contextLabel 共用）、第 [4] 段窄格 CSS、第 [5] 段 `data-discover-source` 形状钉
 * ——渲染体 / CSS / 宿主源码文本钉，无行为接缝，归组件渲染批（缺口清单）。
 *
 * @module dsc-ui-settings/ui/model-infer.spec
 */
import { expect, test } from 'vitest'
import { DEFAULT_THINKING_LEVELS, DEFAULT_THINKING_PARAM } from '@pneuma/runtime/core/model-caps.js'
import type { ProviderModelView } from '@dsc/ui'
import {
  buildKnownIndex,
  FALLBACK_CONTEXT,
  FALLBACK_OUTPUT,
  inferModelCaps,
  normalizeModelId,
  readModalityMarkers,
  readSizeMarker,
} from './model-infer.js'

/** 造一份「已经配过的模型」。 */
const configured = (id: string, extra: Partial<ProviderModelView> = {}): ProviderModelView => ({
  id,
  name: id,
  contextWindow: 512_000,
  maxTokens: 32_768,
  thinkingLevels: ['off', 'low', 'high', 'max'],
  thinkingParam: 'thinking',
  effortMap: {},
  modalities: ['text', 'image'],
  ...extra,
})

// ── 归一化与标记 ─────────────────────────────────────────────────────────────

test('归一化：大小写、点、下划线、空格都不算数；归一化后仍能区分不同版本', () => {
  expect(normalizeModelId('DeepSeek V41 Flash')).toBe(normalizeModelId('deepseek-v4.1-flash'))
  expect(normalizeModelId('glm-5.3')).not.toBe(normalizeModelId('glm-5.3-flash'))
})

test('尺寸标记：-1m / _256k / 512K 都认', () => {
  expect(readSizeMarker('qwen3-1m')).toBe(1_000_000)
  expect(readSizeMarker('hy3_256k')).toBe(256_000)
  expect(readSizeMarker('x-512K')).toBe(512_000)
})

test('尺寸标记：不误认版本号里的点，不误认普通词尾（m/k 后必须断开）', () => {
  expect(readSizeMarker('glm-5.3')).toBeNull()
  expect(readSizeMarker('claude-haiku-mk')).toBeNull()
  expect(readSizeMarker('gpt-4minor')).toBeNull()
})

test('视觉词：-vl / vision / omni 认，普通词不认', () => {
  expect(readModalityMarkers('qwen3-vl').image).toBe(true)
  expect(readModalityMarkers('x-vision').image).toBe(true)
  expect(readModalityMarkers('x-omni').image).toBe(true)
  expect(readModalityMarkers('llava').image).toBe(false)
})

// ── 第一档：别的端点配过的同 id 照抄 ────────────────────────────────────────

const known = buildKnownIndex([
  { name: 'lab', displayName: '试验台', models: [] },
  {
    name: 'deepseek',
    displayName: 'DeepSeek 官方',
    models: [configured('deepseek-v4-pro', { contextWindow: 1_000_000, maxTokens: 65_536 })],
  },
])

test('配过的同 id：能力照抄（1M / 65536），来源记 known', () => {
  const reused = inferModelCaps('deepseek-v4-pro', known)
  expect(reused.source).toBe('known')
  expect(reused.contextWindow).toBe(1_000_000)
  expect(reused.maxTokens).toBe(65_536)
})

test('配过的同 id：换大小写 / 写法也认得', () => {
  expect(inferModelCaps('DeepSeek V4 Pro', known).source).toBe('known')
})

test('提示里报出是哪张端点配的（用户知道这份能力从哪来）', () => {
  expect(inferModelCaps('deepseek-v4-pro', known).note).toContain('DeepSeek 官方')
})

// ── 第二档：id 里写着尺寸 / 视觉词 ──────────────────────────────────────────

test('id 里写着 1m + vl：1M + 图，来源记 marker，提示把两个依据都写出来', () => {
  const marked = inferModelCaps('qwen3-1m-vl', new Map())
  expect(marked.source).toBe('marker')
  expect(marked.contextWindow).toBe(1_000_000)
  expect(marked.modalities).toContain('image')
  expect(marked.note).toContain('1000k')
  expect(marked.note).toContain('视觉')
})

// ── 第三档：家族表 ───────────────────────────────────────────────────────────

test('家族表：claude → 200k + 图 + reasoning-effort', () => {
  const claude = inferModelCaps('claude-sonnet-9', new Map())
  expect(claude.source).toBe('family')
  expect(claude.contextWindow).toBe(200_000)
  expect(claude.modalities.join('+')).toBe('text+image')
  expect(claude.thinkingParam).toBe('reasoning-effort')
})

test('家族表：gemini → 1M + 图 + 视频', () => {
  const gemini = inferModelCaps('gemini-10-ultra', new Map())
  expect(gemini.contextWindow).toBe(1_000_000)
  expect(gemini.modalities.join('+')).toBe('text+image+video')
})

test('家族表：deepseek-v4 排在 deepseek 前面（先匹配的赢）；没有 v4 的走 128k 那一档', () => {
  expect(inferModelCaps('deepseek-v4.9-flash', new Map()).contextWindow).toBe(1_000_000)
  expect(inferModelCaps('deepseek-chat', new Map()).contextWindow).toBe(128_000)
})

test('家族表：提示里说清「是猜的、建议核一眼」', () => {
  const claude = inferModelCaps('claude-sonnet-9', new Map())
  expect(claude.note).toContain('家族')
  expect(claude.note).toContain('核')
})

// ── 第四档：什么都不认得 → 缺省，并明说 ─────────────────────────────────────

test('查不到就落回缺省 128k / 只吃文本，来源记 default，提示明说「没查到」', () => {
  const unknown = inferModelCaps('mystery-model-zz', new Map())
  expect(unknown.source).toBe('default')
  expect(unknown.contextWindow).toBe(FALLBACK_CONTEXT)
  expect(unknown.contextWindow).toBe(128_000)
  expect(unknown.modalities.join('+')).toBe('text')
  expect(unknown.note).toContain('没查到')
  expect(unknown.note).toContain('128k')
})

// ── 已知索引的两条边界 ───────────────────────────────────────────────────────

test('同 id 多份时取「填过窗口」的那份（0 那份没有参考价值）', () => {
  const preferFilled = buildKnownIndex([
    { name: 'a', displayName: 'A', models: [configured('m', { contextWindow: 0 }), configured('m', { contextWindow: 200_000 })] },
  ])
  expect(preferFilled.get('m')?.model.contextWindow).toBe(200_000)
})

test('空 id 不进表（线上清单里可能出现空串）', () => {
  expect(buildKnownIndex([{ name: 'a', displayName: 'A', models: [configured('')] }]).size).toBe(0)
})

test('没给 known 时也能推断（省略索引 = 没有可复用的配置）', () => {
  expect(inferModelCaps('claude-sonnet-9').source).toBe('family')
})

// ── 缺省常数与宿主同源（真 import 宿主常量对着比） ───────────────────────────

test('缺省上下文 / 最大输出与宿主 config 的缺省同值（128000 / 8192）', () => {
  expect(FALLBACK_CONTEXT).toBe(128_000)
  expect(FALLBACK_OUTPUT).toBe(8_192)
})

test('缺省档位面与宿主 model-caps 的缺省一致（四档 + thinking 开关）', () => {
  const unknown = inferModelCaps('mystery-model-zz', new Map())
  expect(unknown.thinkingLevels.join('+')).toBe(DEFAULT_THINKING_LEVELS.join('+'))
  expect(unknown.thinkingParam).toBe(DEFAULT_THINKING_PARAM)
})
