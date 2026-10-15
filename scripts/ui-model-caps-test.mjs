/**
 * 「拉取的模型按能力自动配置」这条的探针（0.6.69 第三轮报障）。
 *
 * 报障原话：拉清单进来的模型能力一律是缺省（128k / 只吃文本），一个 1M 上下文、
 * 能收图的模型也得手改。修法是四档来源的推断（`plugins/settings/model-infer.ts`）：
 * 别的端点配过的同 id > id 里写着的尺寸/视觉词 > 家族表 > 缺省。
 *
 * 五段：
 *   [1] 纯逻辑：归一化 / 尺寸标记 / 视觉词 / 四档来源的优先级 / 家族表顺序
 *   [2] 与宿主同源：缺省常数等于 `core/model-caps.ts` 与 `core/config.ts` 的缺省
 *   [3] 壳侧接线：忙碌态按端点、采用时按推断填、弹窗每行给依据
 *   [4] 窄格 CSS：`.setting-input` 的 220px 下限在模型行里被收回（重叠那个 bug）
 *   [5] 形状钉：推断来源打进 `data-discover-source`（探针/自检认得出走了哪一档）
 *
 * 运行：npx tsc -p tsconfig.json && node scripts/ui-model-caps-test.mjs
 *
 * @module dsc/scripts/ui-model-caps-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`  ok  ${name}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
}

const infer = await import(new URL('../ui-shell/src/plugins/settings/model-infer.ts', import.meta.url).href)
const { normalizeModelId, readSizeMarker, readModalityMarkers, buildKnownIndex, inferModelCaps, FALLBACK_CONTEXT, FALLBACK_OUTPUT } = infer

/** 造一份「已经配过的模型」。 */
const configured = (id, extra = {}) => ({
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

console.log('[1] 推断的纯逻辑（model-infer.ts）')
{
  check('归一化：大小写、点、下划线、空格都不算数', normalizeModelId('DeepSeek V41 Flash') === normalizeModelId('deepseek-v4.1-flash'))
  check('归一化后仍能区分不同版本', normalizeModelId('glm-5.3') !== normalizeModelId('glm-5.3-flash'))

  check('尺寸标记：-1m / _256k / 512K 都认', readSizeMarker('qwen3-1m') === 1_000_000 && readSizeMarker('hy3_256k') === 256_000 && readSizeMarker('x-512K') === 512_000)
  check('尺寸标记：不误认版本号里的点（glm-5.3 不是尺寸）', readSizeMarker('glm-5.3') === null)
  check('尺寸标记：不误认普通词尾（m/k 后必须断开）', readSizeMarker('claude-haiku-mk') === null && readSizeMarker('gpt-4minor') === null)
  check('视觉词：-vl / vision / omni 认，普通词不认', readModalityMarkers('qwen3-vl').image && readModalityMarkers('x-vision').image && readModalityMarkers('x-omni').image && !readModalityMarkers('llava').image)

  // 第一档：别的端点配过的同 id 照抄（用户自己填过一遍的那份最硬）
  const known = buildKnownIndex([
    { name: 'lab', displayName: '试验台', models: [] },
    { name: 'deepseek', displayName: 'DeepSeek 官方', models: [configured('deepseek-v4-pro', { contextWindow: 1_000_000, maxTokens: 65_536 })] },
  ])
  const reused = inferModelCaps('deepseek-v4-pro', known)
  check('配过的同 id：能力照抄（1M / 65536），来源记 known', reused.source === 'known' && reused.contextWindow === 1_000_000 && reused.maxTokens === 65_536)
  check('配过的同 id：换大小写/写法也认得（DeepSeek V4 Pro）', inferModelCaps('DeepSeek V4 Pro', known).source === 'known')
  check('提示里报出是哪张端点配的（用户知道这份能力从哪来）', reused.note.includes('DeepSeek 官方'))

  // 第二档：id 里写着尺寸/视觉词
  const marked = inferModelCaps('qwen3-1m-vl', new Map())
  check('id 里写着 1m + vl：1M + 图，来源记 marker', marked.source === 'marker' && marked.contextWindow === 1_000_000 && marked.modalities.includes('image'))
  check('marker 档的提示把两个依据都写出来', marked.note.includes('1000k') && marked.note.includes('视觉'))

  // 第三档：家族表
  const claude = inferModelCaps('claude-sonnet-9', new Map())
  const gemini = inferModelCaps('gemini-10-ultra', new Map())
  check('家族表：claude → 200k + 图 + reasoning_effort', claude.source === 'family' && claude.contextWindow === 200_000 && claude.modalities.join('+') === 'text+image' && claude.thinkingParam === 'reasoning-effort')
  check('家族表：gemini → 1M + 图 + 视频', gemini.contextWindow === 1_000_000 && gemini.modalities.join('+') === 'text+image+video')
  check('家族表：deepseek-v4 排在 deepseek 前面（先匹配的赢）', inferModelCaps('deepseek-v4.9-flash', new Map()).contextWindow === 1_000_000)
  check('家族表：没有 v4 的 deepseek 走 128k 那一档', inferModelCaps('deepseek-chat', new Map()).contextWindow === 128_000)
  check('家族表：提示里说清「是猜的、建议核一眼」', claude.note.includes('家族') && claude.note.includes('核'))

  // 第四档：什么都不认得 → 缺省，并明说
  const unknown = inferModelCaps('mystery-model-zz', new Map())
  check('查不到就落回缺省 128k / 只吃文本，来源记 default', unknown.source === 'default' && unknown.contextWindow === 128_000 && unknown.modalities.join('+') === 'text')
  check('缺省档提示明说「没查到，按缺省」，不装成查出来的', unknown.note.includes('没查到') && unknown.note.includes('128k'))

  // 已知索引的两条边界
  const preferFilled = buildKnownIndex([{ name: 'a', displayName: 'A', models: [configured('m', { contextWindow: 0 }), configured('m', { contextWindow: 200_000 })] }])
  check('同 id 多份时取「填过窗口」的那份（0 那份没有参考价值）', preferFilled.get('m').model.contextWindow === 200_000)
  check('空 id 不进表（线上清单里可能出现空串）', buildKnownIndex([{ name: 'a', displayName: 'A', models: [configured('')] }]).size === 0)
  check('没给 known 时也能推断（省略索引 = 没有可复用的配置）', inferModelCaps('claude-sonnet-9').source === 'family')
}

console.log('[2] 缺省值与宿主同源')
{
  const caps = await import('../lib/core/model-caps.js')
  check('四档清单与宿主一致（core/model-caps.ts）', caps.DEFAULT_THINKING_LEVELS.join('+') === 'off+low+high+max')
  check('缺省档位字段与宿主一致（thinking 开关）', caps.DEFAULT_THINKING_PARAM === 'thinking')
  check('缺省上下文 128000 与宿主 config.ts 的缺省一致', FALLBACK_CONTEXT === 128_000 && read('src/core/config.ts').includes('128_000'))
  check('缺省最大输出 8192 与宿主 config.ts 的缺省一致', FALLBACK_OUTPUT === 8_192 && read('src/core/config.ts').includes('8_192'))
  check('推断只改「填错也不致命」的字段：档位字段只在有公开惯例的家族里给', read('ui-shell/src/plugins/settings/model-infer.ts').includes('param?: ThinkingParam'))
}

console.log('[3] 壳侧接线（设置 → 模型页）')
{
  const models = read('ui-shell/src/plugins/settings/models.tsx')
  check('忙碌态是「按端点记的集合」，不是一个全局布尔', models.includes('useState<ReadonlySet<string>>(() => new Set())'))
  check('右栏只认自己那一位（拉一个端点别的端点不跟着转）', /\bdiscovering=\{discovering\.has\(current\.name\)\}/.test(models))
  check('拉到之后逐个从集合里摘掉自己', /next\.delete\(provider\)/.test(models))
  check('采用时能力按推断填（不再是缺省那四个数）', models.includes('ids.map((id) => discoveredModel(id, infer(id)))'))
  check('推断的入口是 buildKnownIndex + inferModelCaps（用的是整份端点清单）', models.includes('buildKnownIndex(config?.providers ?? [])') && models.includes('inferModelCaps(id, known)'))
  check('弹窗每行画的是推断出来的能力（窗口 + 图/视频 + 无思考）', models.includes('data-discover-source={caps.source}') && models.includes('{contextLabel(caps.contextWindow)}'))
  check('上下文读数只有一份实现（1M / 256K / 128K），弹窗与模型行共用', models.includes('function contextLabel(tokens: number): string') && models.includes('{contextLabel(caps.contextWindow)}') && /contextLabel\(shown\.contextWindow\)/.test(models))
  check('每行的提示写着这份能力从哪来', models.includes('`${caps.note}${on ? \' · 点一下取消\' : \' · 点一下勾上\'}`'))
  check('旧的「一律按缺省能力加入」那句已经不在', !models.includes('按缺省能力加入'))
}

console.log('[4] 模型行的窄格（重叠那个 bug）')
{
  const css = read('ui-shell/src/legacy/views.css')
  check('.setting-input 的通用下限仍是 220px（别处照旧）', /\.setting-input,\s*\n\.setting-select \{[\s\S]{0,400}min-width: 220px/.test(css))
  check('模型行的输入框把下限收回 0（110px 的格子装得下，不会溢出压邻居）', /\.model-row-field \.setting-input \{\s*\n\s*min-width: 0;/.test(css))
  check('「线上值」那几个 84px 的输入框同样收回下限', /\.cap-wire-input \{[\s\S]{0,200}min-width: 0;/.test(css))
  check('模型行仍是四列（1.2fr / 1fr / 110px / 110px + 删除钮）', /\.model-row-main \{[\s\S]{0,200}grid-template-columns: minmax\(0, 1\.2fr\) minmax\(0, 1fr\) 110px 110px auto/.test(css))
}

console.log('[5] 形状钉：来源标签')
{
  const models = read('ui-shell/src/plugins/settings/models.tsx')
  for (const source of ['known', 'marker', 'family', 'default']) {
    check(`来源 ${source} 在推断模块里存在`, read('ui-shell/src/plugins/settings/model-infer.ts').includes(`'${source}'`))
  }
  check('弹窗把来源打到 DOM 上（自检/探针认得出走了哪一档）', models.includes("data-discover-source={caps.source}"))
  check('能力摘要与端点卡片上那颗钮同一套写法（ctx + cap-badge）', models.includes('className="models-discover-caps"') && read('ui-shell/src/legacy/views.css').includes('.models-discover-caps'))
}

if (failures === 0) {
  console.log('\n全部通过')
} else {
  console.log(`\n${failures} 项失败`)
}
process.exit(failures === 0 ? 0 : 1)
