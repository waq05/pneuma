/**
 * 打包权限预设（沙箱 + 权限模式 + 审阅者三合一）的确定性探针。
 *
 * 为什么单开一层：三根旋钮各自独立是对的，但用户要从「我打算让模型干多大的活」直接落到
 * 一组取值上——分开选就会出现「完全访问 + 沙箱仍工作区可写」这种自相矛盾的组合。
 * 预设把三根捆成一颗按钮：表是**纯表**（`src/core/permission-presets.ts`，零依赖），
 * 应用动作全在插件里（`src/plugins/permission-presets.ts`）。这两处正是本探针要钉的地方：
 * 纯逻辑按 Node 的类型擦除直读 `.ts`（同 `ui-paging-test.mjs` 的做法，不需要先 build），
 * 插件那半靠源码文本钉住结构约定（照 `ui-transcript-render-test.mjs` 的 `uiCode()` 去注释）。
 *
 * 四段：
 *   [1] 纯逻辑：出厂四预设的名字/顺序/三项取值 + 默认档 + 组合互不相同
 *   [2] 纯逻辑：matchPermissionPreset 三项全等才命中，任一不同 → custom
 *   [3] 纯逻辑：findPermissionPreset 认不出返回 null（custom 是推导状态、不是可选项）
 *   [4] 形态钉：写口只调 setMode / setPolicy / setReviewer；不认识的预设名当场抛错；
 *       沙箱插件缺席时明说那一半没落地
 *   [5] 派生状态的显示名：derivedPresetLabel 的两位取值 + 契约/宿主/壳三处的接线
 *       （壳那两份同构渲染跨了层，但钉的是同一条显示规则，放一起才看得见漂移）
 *
 * 运行：node scripts/permission-presets-test.mjs
 *
 * @module dsc/scripts/permission-presets-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const presets = await import(new URL('../src/core/permission-presets.ts', import.meta.url).href)
const {
  BUILTIN_PERMISSION_PRESETS,
  DEFAULT_PERMISSION_PRESET,
  CUSTOM_PERMISSION_PRESET,
  findPermissionPreset,
  matchPermissionPreset,
  derivedPresetLabel,
} = presets

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

/** 数一段文本里某个片段出现几次（钉子要「只此一处」时用）。 */
const count = (text, piece) => text.split(piece).length - 1

console.log('[1] 出厂四个预设：名字 / 顺序 / 三项取值')
{
  const names = BUILTIN_PERMISSION_PRESETS.map((preset) => preset.name)
  check('顺序固定：read-only → workspace → full-access → auto-review', JSON.stringify(names) === JSON.stringify(['read-only', 'workspace', 'full-access', 'auto-review']), JSON.stringify(names))
  check('新会话默认档是 workspace', DEFAULT_PERMISSION_PRESET === 'workspace', DEFAULT_PERMISSION_PRESET)
  check('custom 常量就是字符串 custom', CUSTOM_PERMISSION_PRESET === 'custom', CUSTOM_PERMISSION_PRESET)

  const byName = Object.fromEntries(BUILTIN_PERMISSION_PRESETS.map((preset) => [preset.name, preset]))
  check('read-only = read-only 沙箱 + readonly + 本人审', byName['read-only'].sandbox === 'read-only' && byName['read-only'].policy === 'readonly' && byName['read-only'].reviewer === 'user', JSON.stringify(byName['read-only']))
  check('workspace = workspace-write 沙箱 + auto-edit + 本人审', byName.workspace.sandbox === 'workspace-write' && byName.workspace.policy === 'auto-edit' && byName.workspace.reviewer === 'user', JSON.stringify(byName.workspace))
  check('full-access = danger-full-access + full-access + 本人审', byName['full-access'].sandbox === 'danger-full-access' && byName['full-access'].policy === 'full-access' && byName['full-access'].reviewer === 'user', JSON.stringify(byName['full-access']))
  // 参考实现的 Auto：沙箱钉死在不设围栏，每一次调用先过模型判官（评审者 = auto-review）。
  check('auto-review = danger-full-access + full-access + auto-review（对齐参考实现的 Auto）', byName['auto-review'].sandbox === 'danger-full-access' && byName['auto-review'].policy === 'full-access' && byName['auto-review'].reviewer === 'auto-review', JSON.stringify(byName['auto-review']))

  check('四个都标了 builtin（出厂删不掉）', BUILTIN_PERMISSION_PRESETS.every((preset) => preset.builtin === true))
  check('每个预设都有 label 与 description（界面要画）', BUILTIN_PERMISSION_PRESETS.every((preset) => preset.label.length > 0 && preset.description.length > 0))
  // 取值必须落在契约的三档 / 两位枚举里，别写错一个字。
  check('沙箱取值都是三档之一', BUILTIN_PERMISSION_PRESETS.every((preset) => ['read-only', 'workspace-write', 'danger-full-access'].includes(preset.sandbox)))
  check('权限模式取值都是三档之一', BUILTIN_PERMISSION_PRESETS.every((preset) => ['readonly', 'auto-edit', 'full-access'].includes(preset.policy)))
  check('审阅者取值都是两位之一', BUILTIN_PERMISSION_PRESETS.every((preset) => ['user', 'auto-review'].includes(preset.reviewer)))
  // 三项组合必须两两不同，否则匹配（matchPermissionPreset）会有歧义。
  const triples = new Set(BUILTIN_PERMISSION_PRESETS.map((preset) => `${preset.sandbox}|${preset.policy}|${preset.reviewer}`))
  check('四个预设的三项组合互不相同（匹配无歧义）', triples.size === BUILTIN_PERMISSION_PRESETS.length, String(triples.size))
}

console.log('[2] matchPermissionPreset：三项全等才命中，任一不同 → custom')
{
  check('三项全等 → 命中 workspace', matchPermissionPreset('workspace-write', 'auto-edit', 'user') === 'workspace', matchPermissionPreset('workspace-write', 'auto-edit', 'user'))
  // 逐个改一项验证：任意一根不同就落回 custom（用户可以在设置页拼出任意组合）。
  check('只改沙箱一项 → custom', matchPermissionPreset('read-only', 'auto-edit', 'user') === CUSTOM_PERMISSION_PRESET, matchPermissionPreset('read-only', 'auto-edit', 'user'))
  check('只改权限模式一项 → custom', matchPermissionPreset('workspace-write', 'readonly', 'user') === CUSTOM_PERMISSION_PRESET, matchPermissionPreset('workspace-write', 'readonly', 'user'))
  check('只改审阅者一项 → custom', matchPermissionPreset('workspace-write', 'auto-edit', 'auto-review') === CUSTOM_PERMISSION_PRESET, matchPermissionPreset('workspace-write', 'auto-edit', 'auto-review'))
  check('另一档的组合命中它自己（auto-review）', matchPermissionPreset('danger-full-access', 'full-access', 'auto-review') === 'auto-review', matchPermissionPreset('danger-full-access', 'full-access', 'auto-review'))
  check('每个预设都能被自己那组取值命回原名', BUILTIN_PERMISSION_PRESETS.every((preset) => matchPermissionPreset(preset.sandbox, preset.policy, preset.reviewer) === preset.name))
}

console.log('[3] findPermissionPreset：认不出返回 null')
{
  check("findPermissionPreset('custom') 返回 null（推导状态不是可选项）", findPermissionPreset(CUSTOM_PERMISSION_PRESET) === null, String(findPermissionPreset(CUSTOM_PERMISSION_PRESET)))
  check('未知名字返回 null', findPermissionPreset('nope') === null && findPermissionPreset('') === null)
  check('认得的名字返回对象', findPermissionPreset('auto-review')?.name === 'auto-review')
}

console.log('[4] 形态钉：插件那半只做组合，不放宽安全（src/plugins/permission-presets.ts）')
{
  const src = read('src/plugins/permission-presets.ts')
  // 先剥注释再钉：「不该出现」的断言会被修法自己的注释打脸（同 ui-transcript-render-test 的 uiCode）。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  // 写口只调这三处 setter——预设放宽不了安全，是结构上成立的，不是靠自觉。
  check('写口调 sandbox.setMode', code.includes('sandbox.setMode('))
  check('写口调 ctx.approval.setPolicy', code.includes('ctx.approval.setPolicy('))
  check('写口调 ctx.approval.setReviewer', code.includes('ctx.approval.setReviewer('))
  check('setMode 只出现一次（只在那一处写口）', count(code, '.setMode(') === 1, String(count(code, '.setMode(')))
  check('setPolicy 只出现一次', count(code, '.setPolicy(') === 1, String(count(code, '.setPolicy(')))
  check('setReviewer 只出现一次', count(code, '.setReviewer(') === 1, String(count(code, '.setReviewer(')))
  // 负向：预设插件不许自己碰沙箱配置或审批的应答口（绕过 setter 的路径一律不许有）。
  check('不直接写沙箱配置（不碰 writePluginConfig）', !code.includes('writePluginConfig'))
  check('不碰审批的应答口（不调 answer）', !code.includes('.answer('))
  check('不碰灾难地板规则文件（不引 policy.rules）', !code.includes('policy.rules'))

  // 不认识的预设名（含推导态 custom）当场抛错——use() 不在「认不出就静默回落」的宽容档。
  check('use() 用 findPermissionPreset 查表', code.includes('findPermissionPreset(next)'))
  check('认不出时当场 throw new Error', code.includes('throw new Error(hint)'))
  check('custom 被专门点名为「拼出来的状态，不是可选预设」', code.includes('CUSTOM_PERMISSION_PRESET') && code.includes('不是可选预设'))

  // 沙箱插件缺席时（可停用）要明说那一半没落地，用户不该以为自己已被围起来。
  check('沙箱插件缺席时读 ctx.get(sandbox)', code.includes("ctx.get('sandbox')"))
  check('缺席时明说「沙箱插件没开，… 这一半没落地」', code.includes('沙箱插件没开') && code.includes('没落地'))

  // 投影登记点固定（输入框那颗旋钮与设置页都读它）。
  check('登记 surfaces.permissionPresets', code.includes("ctx.surfaces.register('permissionPresets'"))
  check('provide 的是 permissionPresets', code.includes("provide: 'permissionPresets'"))
  // 表来自纯表模块，不在插件里另抄一份（两边各写一份迟早会漂）。
  check('预设表来自 core/permission-presets（不另抄一份）', code.includes('BUILTIN_PERMISSION_PRESETS') && code.includes("from '../core/permission-presets.js'"))
}

console.log('[5] 派生状态的显示名：命中预设留空，拼出来的组合读作「AI 审查」/「自定义」')
{
  // 规则本身是纯的：只按审阅者一位决定。审阅者是 AI 复核时，这个组合的实际含义就是
  // 「先过 AI 审查」——说「自定义」等于什么都没说（用户报的正是这个）。
  check('审阅者是 auto-review → 「AI 审查」', derivedPresetLabel('auto-review') === 'AI 审查', derivedPresetLabel('auto-review'))
  check('审阅者是 user → 「自定义」', derivedPresetLabel('user') === '自定义', derivedPresetLabel('user'))
  // 名字只用于显示：它不改变「custom 不是可选项」这条（[3] 已钉 findPermissionPreset）。
  check('派生名不进预设表（表里查不到它）', BUILTIN_PERMISSION_PRESETS.every((preset) => preset.label !== 'AI 审查' && preset.label !== '自定义'))

  const contract = read('src/contract.ts')
  check('契约给 select 字段开了 derivedLabelKey', contract.includes('derivedLabelKey?: string'))

  const host = read('src/plugins/settings.ts')
  check('宿主把派生显示名挂在 permissionPresetName 上', host.includes("derivedLabelKey: 'permissionPresetName'"))
  check('宿主用 derivedPresetLabel 算这个名字（不另写一份规则）', host.includes('derivedPresetLabel(ctx.approval.reviewer)'))

  // 壳那两份同构渲染都要有这条出口：值不在选项表里 + 宿主给了名字 → 置灰只读 + 显示那个名字。
  // 跨行匹配前先把 CRLF 压平（本仓工作区是 CRLF，直接 includes 多行文本永远匹配不上）。
  const flat = (text) => text.replace(/\r\n/g, '\n')
  /** 派生那一支的形状：置灰的 Select + 直接给显示名 + 选项表原样传（不塞假选项）。 */
  const derivedOutlet = /displayLabel=\{derivedLabel\}\s+disabled\s+options=\{field\.options\}/
  const shell = flat(read('ui-shell/src/plugins/settings/ui.tsx'))
  const shellPlugins = flat(read('ui-shell/src/plugins/plugins/ui.tsx'))
  check('设置面板读 field.derivedLabelKey（判据 + 取值两处都在）', count(shell, 'field.derivedLabelKey') === 2, String(count(shell, 'field.derivedLabelKey')))
  check('设置面板派生时置灰只读并给显示名', derivedOutlet.test(shell))
  check('插件中心那份同构渲染也读 field.derivedLabelKey', count(shellPlugins, 'field.derivedLabelKey') === 2, String(count(shellPlugins, 'field.derivedLabelKey')))
  check('插件中心那份也置灰只读并给显示名', derivedOutlet.test(shellPlugins))
  check('两处都靠「不在选项表里 + 宿主给了名字」这一条判据', count(shell, "!listed && derivedLabel !== ''") === 1 && count(shellPlugins, "!listed && derivedLabel !== ''") === 1)
  // 负向：真正的脏值仍然要照实显示（别把「认不出」这条路一并删掉）。
  check('认不出的值仍走「· 未识别」那条（两条路都在）', shell.includes('· 未识别') && shellPlugins.includes('· 未识别'))
  check('两处渲染各只有一条派生出口', count(shell, 'displayLabel={derivedLabel}') === 1 && count(shellPlugins, 'displayLabel={derivedLabel}') === 1)
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
