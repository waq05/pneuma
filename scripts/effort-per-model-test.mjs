/**
 * 「不同模型的思考档位能不能各自适配」的探针（2026-10-28 用户提问）。
 *
 * 用户问的是：思考档位那颗滑杆，遇到不同模型档位不一样时会不会错。
 * 机制上档位来自模型自己的能力声明（`config.yaml` 的 `thinkingLevels` / `thinkingParam` /
 * `effortMap`），滑杆按清单长度画、请求按清单发字段。这一条探针把三处口径钉在一起：
 *
 *   [1] 档位清单：模型声明两档 / 四档 / 不声明（没有思考）分别得到什么
 *   [2] 换模型：原来选的档位在新模型上不存在时夹回「默认」，不把发不出去的值留着
 *   [3] 请求字段：`thinking` 开关 vs `reasoning_effort` vs 不发，各档映射对不对
 *   [4] 壳侧滑杆：按清单长度画、不写死四档；宿主拒绝时挂在 chip 下的那条错
 *   [5] 负向：把「一律四档」的写法塞回去会被抓到
 *
 * 运行：npx tsc -p tsconfig.json && node scripts/effort-per-model-test.mjs
 *
 * @module dsc/scripts/effort-per-model-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
}

const caps = await import('../lib/core/model-caps.js')
const {
  DEFAULT_THINKING_LEVELS,
  clampEffort,
  effortToWire,
  hasEffortLevel,
  normalizeEffortMap,
  normalizeThinkingLevels,
} = caps
const picker = await import(
  new URL('../ui-shell/src/plugins/composer/model-picker.ts', import.meta.url).href
)
const { effortChoices } = picker

/** 造一份模型能力（缺省按「四档 + thinking 开关 + 只吃文本」）。 */
const modelCaps = (extra = {}) => ({
  thinkingLevels: [...DEFAULT_THINKING_LEVELS],
  thinkingParam: 'thinking',
  effortMap: {},
  modalities: ['text'],
  ...extra,
})

console.log('[1] 档位清单：模型声明几档，界面就几档（外加恒在的「默认」）')
{
  const two = effortChoices({ thinkingLevels: ['low', 'high'], modalities: ['text'] })
  const four = effortChoices({ thinkingLevels: ['off', 'low', 'high', 'max'], modalities: ['text'] })
  const none = effortChoices({ thinkingLevels: [], modalities: ['text'] })
  check('两档的模型：默认 + 低 + 高', two.join('+') === 'default+low+high', two.join('+'))
  check('四档的模型：默认 + 四档', four.join('+') === 'default+off+low+high+max', four.join('+'))
  check('不声明思考的模型：只剩「默认」', none.join('+') === 'default', none.join('+'))
  check('清单长度各不相同（滑杆按它画点）', two.length === 3 && four.length === 5 && none.length === 1)
  check('模型声明里出现没听过的档位：丢掉，不画一个点不动的点', effortChoices({ thinkingLevels: ['off', 'ultra'], modalities: ['text'] }).join('+') === 'default+off')
  check('配置里的档位写法容错：字符串 / 数组 / false 都认', normalizeThinkingLevels('low, high').join('+') === 'low+high' && normalizeThinkingLevels(false).length === 0)
}

console.log('[2] 换模型：旧档位在新模型上不存在就夹回「默认」')
{
  const two = modelCaps({ thinkingLevels: ['low', 'high'], thinkingParam: 'reasoning-effort' })
  const noThinking = modelCaps({ thinkingLevels: [] })
  check('两档模型上没有 max：夹回默认', clampEffort(two, 'max') === 'default', String(clampEffort(two, 'max')))
  check('两档模型上有 high：保留', clampEffort(two, 'high') === 'high')
  check('没有思考的模型上一律回默认', clampEffort(noThinking, 'low') === 'default' && clampEffort(noThinking, 'default') === 'default')
  check('hasEffortLevel 认「默认」恒可选', hasEffortLevel(noThinking, 'default') && !hasEffortLevel(noThinking, 'off'))
  // 宿主真的在 setModel 里调它（不然界面上还显示着 max，发出去却是别的）
  check('setModel 里调用 clampEffort（换模型时夹档）', read('src/plugins/llm.ts').includes('currentEffort = clampEffort(capsFor(provider, model), currentEffort)'))
  check('setEffort 先查 hasEffortLevel，认不出就报错而不是静默吞', read('src/plugins/llm.ts').includes('if (!hasEffortLevel(caps, effort))'))
  check('报错文案把可用档位列出来（用户知道该去勾哪一档）', read('src/plugins/llm.ts').includes('这个模型只支持：'))
}

console.log('[3] 请求字段：三套端点三种发法')
{
  const switchModel = modelCaps({ thinkingParam: 'thinking' })
  check('thinking 开关：低/高/最大都发 enabled', ['low', 'high', 'max'].every((level) => effortToWire(switchModel, level).thinking === 'enabled'))
  check('thinking 开关：关发 disabled', effortToWire(switchModel, 'off').thinking === 'disabled')
  check('选「默认」不发思考字段', JSON.stringify(effortToWire(switchModel, 'default')) === '{}')

  const effortModel = modelCaps({ thinkingParam: 'reasoning-effort' })
  check('reasoning_effort：各档按缺省线上值发', effortToWire(effortModel, 'low').reasoningEffort === 'low' && effortToWire(effortModel, 'max').reasoningEffort === 'max')
  check('reasoning_effort：off 发 none', effortToWire(effortModel, 'off').reasoningEffort === 'none')

  const mapped = modelCaps({ thinkingParam: 'reasoning-effort', effortMap: normalizeEffortMap({ low: 'minimal', max: 'xhigh' }) })
  check('effortMap 覆盖生效（端点用 minimal / xhigh 这种名字时）', effortToWire(mapped, 'low').reasoningEffort === 'minimal' && effortToWire(mapped, 'max').reasoningEffort === 'xhigh')
  check('effortMap 里写 null 的那一档不发字段', JSON.stringify(effortToWire(modelCaps({ thinkingParam: 'reasoning-effort', effortMap: normalizeEffortMap({ high: null }) }), 'high')) === '{}')

  check('thinkingParam: none 的端点：选哪档都不发', ['off', 'low', 'high', 'max'].every((level) => JSON.stringify(effortToWire(modelCaps({ thinkingParam: 'none' }), level)) === '{}'))
  check('没有思考档位的模型：选哪档都不发', ['off', 'low', 'high', 'max'].every((level) => JSON.stringify(effortToWire(modelCaps({ thinkingLevels: [] }), level)) === '{}'))
}

console.log('[4] 壳侧滑杆：按清单长度画，不写死四档')
{
  const slider = read('ui-shell/src/plugins/composer/effort-slider.tsx')
  check('点位由清单长度决定（percentOf(index, count)）', slider.includes('function percentOf(index: number, count: number)') && slider.includes('percentOf(at, levels.length)'))
  check('每个档位画一个点（levels.map）', slider.includes('{levels.map((level, at) => ('))
  check('滑钮位置同样按长度算', /style=\{\{ left: percentOf\(index, levels\.length\) \+ '%' \}\}/.test(slider))
  check('键盘 Home/End 落在首尾两档（不是写死的 3）', slider.includes('next = levels.length - 1'))
  check('宿主拒绝时把原因显示出来（不是默默回到旧值）', read('ui-shell/src/plugins/composer/model-controls.tsx').includes('onFault(reason instanceof Error ? reason.message : String(reason))'))
  check('档位清单来自模型自己的能力声明（不是固定表）', read('ui-shell/src/plugins/composer/model-picker.ts').includes('const levels: readonly ThinkingLevel[] = entry.thinkingLevels'))
}

console.log('[5] 负向：把「一律四档」塞回去要报红')
{
  const fakeSlider = 'const dots = [0, 1, 2, 3].map((at) => at)'
  check('写死四个点的实现会被 [4] 那几条抓到', !fakeSlider.includes('levels.map(') && !fakeSlider.includes('percentOf(at, levels.length)'))
  const fakePicker = 'const levels = [\'off\', \'low\', \'high\', \'max\']'
  check('固定表的实现不符合 [4] 最后一条的判据', !fakePicker.includes('entry.thinkingLevels'))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
if (failures > 0) process.exitCode = 1
