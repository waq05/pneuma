/**
 * P0-2 / P0-3 / P0-4 探针：patch 行的 `config` 真的到得了插件；一次开关只写一次盘；
 * 「插件开没开」只有一套判定。
 *
 * 病根（`docs/code-review/2026-11-09/02-plugin-runtime.md`）：
 *   - P0-2：`applyPatchLayers` 认真实现了「config 整块替换」，但 `mountRow` 调
 *     `mountExternalPlugin` 时只传 inject / native / 宿主配置，`row.config` 从头到尾没人读；
 *   - P0-3：界面点一次开关，`runtime` 的入口先写一次盘，`setPluginEnabledHot` 里再写一次；
 *   - P0-4：`plugin-registry.readEnabledPlugins` 认旧键别名、认 `defaultDisabled`，
 *     而装载器的 `isDisabledByEntry` 只认精确 file，同一份 plugins.json 会得出两个结论。
 *
 * 这个探针真起一个 cordis root、真跑组合包挂载与开关（不是读源码猜），验这些事：
 *   1. 组合包 patch 写 `config: {foo: 1}`：插件拿到的配置里 foo=1，磁盘独有的新键也在
 *      （三档优先级「宿主直给 > patch 行 > plugins.json」，见 plugin-registry 的 registerRowConfig）；
 *   2. 调一次开关，`plugins.json` 只被写 1 次，且别的段（uiTrust、无关条目）不被吃掉；
 *   3. 热开关「停用→启用」重挂后，apply 仍拿到同一份配置（修前 patch 的 config 会丢）；
 *   4. apply 里调 `resolvePluginConfig`：patch 的键不被磁盘旧值顶掉、磁盘的新键能进来；
 *   5. 同一份 plugins.json（含旧键别名与 `defaultDisabled`），`readEnabledPlugins` 与装载器
 *      的结论逐条一致；
 *   6. `plugin_manager` 装一个已停用的同名插件不会绕开开关把它挂上；
 *   7. `plugin_manager` 对运行内核行给可读错误、0 写盘；
 *   8. 启动时就停用的行（从没挂过）在插件中心启用后，apply 仍拿到 patch 的 config，
 *      且与「启动时就启用」那一行逐键相同；停用期间用户改过磁盘配置时，patch 的键与磁盘的
 *      新键同时在场；
 *   9. 组合包 patch 删掉一行后，它的行选项与 patch 配置登记一并清掉（被别的包复用同 id 不串味）。
 *
 * 纯 Node 跑（不需要 build）：源码按 NodeNext 写 `.js` 说明符、`@pneuma/*` 是构建期路径映射，
 * 这里用官方 resolve hook 补上，剩下的交给 Node 的类型擦除（与 scripts/todo-session-scope-check.mjs
 * 同一套做法）。HOME / DSC_HOME 指到临时目录，绝不碰真实 `~/.dsc`。
 *
 * 运行：node scripts/plugin-config-enable-check.mjs
 *
 * @module dsc/scripts/plugin-config-enable-check
 */
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
// 这里**不能**静态 import `node:fs`：那道静态导入会把 node:fs 的命名导出快照钉死在
// 原函数上，后面换的 writeFileSync 对被测模块就不生效了（写盘计数就没有 1 可数）。
const fsCjs = createRequire(import.meta.url)('node:fs')

// runtime 插件的依赖图（core/ui-bundles.ts）用了 TS 参数属性，Node 的类型擦除模式不认；
// 只有 --experimental-transform-types 能跑。子进程重跑一次，调用方仍然只写
// `node scripts/plugin-config-enable-check.mjs`，不用记那个参数。
if (process.env['DSC_PROBE_TRANSFORM_TYPES'] !== '1') {
  const { spawnSync } = await import('node:child_process')
  const child = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, DSC_PROBE_TRANSFORM_TYPES: '1' } },
  )
  process.exit(child.status ?? 1)
}

// ── 临时家目录：插件开关、条目树、profile 全落在这里 ─────────────────────────
const home = fsCjs.mkdtempSync(join(tmpdir(), 'dsc-plugin-cfg-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
// 热更轮询不参与这一次判定（它会读盘、会定时器），关掉让时序可复现。
process.env.DSC_HOT = '0'
fsCjs.mkdirSync(process.env.DSC_HOME, { recursive: true })
const pluginsJson = join(process.env.DSC_HOME, 'plugins.json')

// ── 路径映射：`@pneuma/runtime/*` → src/*；`@pneuma/<id>/<x>` → src/packages/<id>/<x>；
//    `.js` 说明符回落成 `.ts`（源码盘上只有 ts，构建才产出 js）─────────────────
registerHooks({
  resolve(specifier, context, nextResolve) {
    let mapped = specifier
    if (specifier.startsWith('@pneuma/runtime/')) {
      mapped = pathToFileURL(join(root, 'src', specifier.slice('@pneuma/runtime/'.length))).href
    } else if (specifier.startsWith('@pneuma/')) {
      const rest = specifier.slice('@pneuma/'.length)
      const slash = rest.indexOf('/')
      const id = slash < 0 ? rest : rest.slice(0, slash)
      const tail = slash < 0 ? 'index.js' : rest.slice(slash + 1)
      mapped = pathToFileURL(join(root, 'src', 'packages', id, tail)).href
    }
    const attempt = (candidate) => {
      try {
        return nextResolve(candidate, context)
      } catch {
        return null
      }
    }
    let result = attempt(mapped)
    if (result === null && mapped.endsWith('.js')) result = attempt(`${mapped.slice(0, -3)}.ts`)
    // 落不到源码就交回原始说明符：真正的错误（包没装之类）照原样冒出来，不掩盖。
    return result ?? nextResolve(specifier, context)
  },
})

/** 一条断言：通过打印 ok，失败打印 FAIL 并带现场。 */
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  ok  ${name}`)
    return
  }
  fail += 1
  console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
}

// ── 写盘计数钩子：必须在加载被测模块**之前**装好 ─────────────────────────────
// `node:fs` 的 ESM 命名绑定在 node:fs 第一次被链接时固定成当时的函数，所以先换掉
// writeFileSync，再 import 源码模块（探针自己 fixture 的写盘也走这个入口）。
const realWriteFileSync = fsCjs.writeFileSync
let writeCount = 0
fsCjs.writeFileSync = (...args) => {
  const target = String(args[0] ?? '')
  if (target.replace(/\\/g, '/').endsWith('/plugins.json')) writeCount += 1
  return realWriteFileSync(...args)
}
const resetWrites = () => {
  writeCount = 0
}
const writesNow = () => writeCount

const writeText = (file, text) => {
  fsCjs.mkdirSync(dirname(file), { recursive: true })
  fsCjs.writeFileSync(file, text, 'utf8')
}
const readJson = (file) => {
  try {
    return JSON.parse(fsCjs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// ── 夹具：一个 profile，一个组合包，两条 patch 行 ───────────────────────────
const profileDir = join(process.env.DSC_HOME, 'profiles', 'probe')
const bundleDir = join(profileDir, 'node_modules', '@probe', 'cfg')
writeText(
  join(profileDir, 'package.json'),
  JSON.stringify({ name: 'probe-profile', type: 'module', dsh: { profile: { bundles: ['@probe/cfg'] } } }, null, 2) + '\n',
)
writeText(
  join(bundleDir, 'package.json'),
  JSON.stringify({ name: '@probe/cfg', version: '1.0.0', type: 'module', pneuma: { bundle: { patch: './cordis.patch.yml' } } }, null, 2) + '\n',
)
// 第一条行（probe-cfg）：patch 里写 config，验 P0-2。
// 第二条行（probe-alias）：入口文件名与行 id 不同，条目树里只认旧键（文件名），验 P0-4 的别名。
writeText(
  join(bundleDir, 'cordis.patch.yml'),
  [
    '- insert:',
    '    - id: probe-cfg',
    '      name: ./cfg-plugin.js',
    '      config:',
    '        foo: 1',
    '    - id: probe-alias',
    '      name: ./alias-plugin.js',
    '    - id: probe-off',
    '      name: ./off-plugin.js',
    '      config:',
    '        foo: 1',
    '',
  ].join('\n'),
)
// 探针里必须钉到**源码**那一份 registry：插件走 `@pneuma/runtime/...` 说明符时会被装载器的
// 解析钩子短路到 `lib/node_modules/@pneuma/runtime/...`（构建产物，这里是旧的 re-export 桩），
// 那样插件调的是另一份模块实例、注册表落空。生产构建里两侧同源（桩是 `export *`），身份一致。
const regUrl = pathToFileURL(join(root, 'src', 'core', 'plugin-registry.ts')).href
writeText(
  join(bundleDir, 'cfg-plugin.js'),
  [
    `import { resolvePluginConfig } from '${regUrl}'`,
    "export const name = 'probe-cfg'",
    'export function apply(_ctx, config) {',
    '  globalThis.__PROBE_CFG = config',
    '  // 插件运行期现读配置走的就是这个函数：它和 apply 收到的是不是同一份，是这次的重点。',
    "  globalThis.__PROBE_RESOLVED = resolvePluginConfig('probe-cfg', config)",
    '}',
    '',
  ].join('\n'),
)
writeText(
  join(bundleDir, 'alias-plugin.js'),
  "export const name = 'probe-alias'\nexport function apply() {\n  globalThis.__PROBE_ALIAS_APPLIED = true\n}\n",
)
// 条目树里停用、启动时因此没挂过的那一行：插件中心点「启用」时也得拿回 patch 的 foo=1。
writeText(
  join(bundleDir, 'off-plugin.js'),
  "export const name = 'probe-off'\nexport function apply(_ctx, config) {\n  globalThis.__PROBE_OFF_CFG = config\n}\n",
)

// 条目树：probe-cfg 磁盘上有一份与 patch 同键（foo）的旧值、外加一个 patch 没有的键（disk）——
// 同一个键 patch 赢、磁盘独有的键补进来，这两件事第 1 段分别断言；probe-alias 只按旧键
// （入口文件名）记着「停用」。
writeText(
  pluginsJson,
  JSON.stringify(
    {
      version: 1,
      uiTrust: { 'kept/ui/client.js': { trustedAt: 1 } },
      entries: [
        { file: 'probe-cfg', disabled: false, config: { foo: 0, disk: 'only' } },
        // 与 probe-cfg 同形，只是停用：第 7 段在插件中心启用它，结果应与 probe-cfg 逐键相同。
        { file: 'probe-off', disabled: true, config: { foo: 0, disk: 'only' } },
        { file: 'alias-plugin.js', disabled: true, config: {} },
        // off.js 在 ~/.dsc/plugins/ 下，条目树明确记着停用（下面第 4 段要它）。
        { file: 'off.js', disabled: true, config: {} },
        // wasoff.js：第 5 段要装一个同名文件，停用状态不能被「装一次」绕过去。
        { file: 'wasoff.js', disabled: true, config: {} },
        { file: 'unrelated-row', disabled: false, config: { keep: true } },
      ],
    },
    null,
    2,
  ) + '\n',
)

// ── 加载被测模块（HOME / DSC_HOME 指好之后）─────────────────────────────────
const { Context } = await import('@deepseek-ai/cordis')
const srcUrl = (relative) => pathToFileURL(join(root, 'src', relative)).href
const registry = await import(srcUrl('core/plugin-registry.ts'))
const loader = await import(srcUrl('core/plugin-loader.ts'))
const runtimeModule = await import(srcUrl('packages/runtime/index.ts'))

// ── 1. P0-2：patch 行的 config 到得了插件，且与运行期口径一致 ────────────────
console.log('── 1. P0-2 组合包 patch 里的 config ──')
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const cordisRoot = new Context()
// 裸 Context 没有 transcript：装载器只在告警时用它（夹具不该有告警，拿不到就算了）。
try {
  Object.defineProperty(cordisRoot, 'transcript', { value: { system() {} }, configurable: true })
} catch {
  // 定义不上不影响这一段
}
const mount = await loader.mountBundlePlugins(cordisRoot, profileDir, { appDir: root })
const mountedIds = () => loader.listMountedPluginSources().map((item) => item.identity)
check('组合包那一行挂上了', mountedIds().includes('probe-cfg'), JSON.stringify({ failures: mount.failures, mounted: mountedIds() }))
// 首次挂载的现场：第 3 段热开关之后要跟这一份逐键比对（patch 的键、磁盘的键都看）。
const firstConfig = globalThis.__PROBE_CFG
const firstResolved = globalThis.__PROBE_RESOLVED
check(
  '插件拿到的就是 patch 写的 config（foo=1，没被磁盘旧值 foo:0 顶掉）',
  isObject(firstConfig) && firstConfig['foo'] === 1,
  JSON.stringify(firstConfig),
)
// 三档优先级：宿主直给 > patch 行 > plugins.json。patch 的键赢，磁盘独有的新键也要进来
// （修前是「整块替换」：apply 拿 patch、resolve 拿磁盘，两边对不上，磁盘的新键进不到 apply）。
check(
  '磁盘独有的新键也在（disk:"only"），没有被整块替换掉',
  isObject(firstConfig) && firstConfig['disk'] === 'only',
  JSON.stringify(firstConfig),
)
check(
  'apply 里调 resolvePluginConfig 与 apply 收到的是同一份（挂载口径 = 运行期口径）',
  isObject(firstResolved) && JSON.stringify(firstResolved) === JSON.stringify(firstConfig),
  JSON.stringify({ applied: firstConfig, resolved: firstResolved }),
)

// ── 2. P0-4 别名：只按旧键记着停用的行不挂 ──────────────────────────────────
console.log('── 2. P0-4 旧键别名 ──')
check(
  '旧键（入口文件名）记着停用 → 这一行不挂',
  !mountedIds().includes('probe-alias') && globalThis.__PROBE_ALIAS_APPLIED === undefined,
  JSON.stringify(mountedIds()),
)
check(
  '同一份 plugins.json：readEnabledPlugins 也说它关着',
  !registry.readEnabledPlugins(['probe-alias']).has('probe-alias'),
  JSON.stringify([...registry.readEnabledPlugins(['probe-alias'])]),
)
// 插件中心那一份列表（listPluginInfos）也不能另立一套：旧键命中时它以前按精确 file
// 查不到条目，会把这一行显示成「开」，而装载器根本没挂。
check(
  '插件中心的列表与装载器同结论（probe-alias 显示停用）',
  registry.listPluginInfos().find((item) => item.file === 'probe-alias')?.enabled === false,
  JSON.stringify(registry.listPluginInfos().find((item) => item.file === 'probe-alias')),
)

// ── 3. P0-3：一次开关只写一次盘 ─────────────────────────────────────────────
console.log('── 3. P0-3 一次开关写一次盘 ──')
// 计数钩子装在加载源码之前（见文件开头）：这里只负责清零与读值。

// 用真插件的 apply 拿到它 provide 的 `ui` 服务：这一段要驱动的是 runtime 入口本身。
let ui = null
const fakeCtx = {
  provide(name, service) {
    if (name === 'ui') ui = service
  },
  emit() {},
  get() {
    return undefined
  },
  transcript: {
    system() {},
    touch() {},
    subscribe() {
      return () => {}
    },
    getSnapshot() {
      return {}
    },
  },
}
runtimeModule.runtimePlugin.apply(fakeCtx)
check('runtime 插件 provide 了 ui 服务', ui !== null && typeof ui?.setPluginEnabled === 'function')

if (ui !== null) {
  resetWrites()
  await ui.setPluginEnabled('probe-cfg', false)
  const offWrites = writesNow()
  check('停用一次只写 1 次盘', offWrites === 1, `写了 ${offWrites} 次`)
  check('停用结果真的落盘了（条目 disabled=true）', readJson(pluginsJson)?.entries?.some((e) => e.file === 'probe-cfg' && e.disabled === true) === true)

  resetWrites()
  await ui.setPluginEnabled('probe-cfg', true)
  const onWrites = writesNow()
  check('启用一次只写 1 次盘', onWrites === 1, `写了 ${onWrites} 次`)
  check('启用结果真的落盘了（条目 disabled=false）', readJson(pluginsJson)?.entries?.some((e) => e.file === 'probe-cfg' && e.disabled === false) === true)

  // ── 3b. 热开关重挂：patch 的 config 不能丢（复审实测的那条）─────────────
  // 修前 setPluginEnabledHot 重挂时一个行选项都不传，apply 收到的是磁盘那份，foo 变回 0。
  const toggledConfig = globalThis.__PROBE_CFG
  const toggledResolved = globalThis.__PROBE_RESOLVED
  check(
    '停用→启用后 apply 真的重跑了一次（不是复用旧对象）',
    toggledConfig !== firstConfig,
    JSON.stringify({ firstConfig, toggledConfig }),
  )
  check(
    '停用→启用后 apply 仍拿到 patch 写的 foo=1',
    isObject(toggledConfig) && toggledConfig['foo'] === 1,
    JSON.stringify(toggledConfig),
  )
  check(
    '停用→启用后 apply 的配置与首次挂载逐键相同',
    JSON.stringify(toggledConfig) === JSON.stringify(firstConfig),
    JSON.stringify({ firstConfig, toggledConfig }),
  )
  check(
    '停用→启用后 apply 里再 resolve 仍是同一份（三处口径一致）',
    isObject(toggledResolved) && JSON.stringify(toggledResolved) === JSON.stringify(toggledConfig),
    JSON.stringify({ toggledConfig, toggledResolved }),
  )

  // 写盘是「读整份 → 改一条 → 写回」：别人的段和条目不能被这一来一回吃掉。
  const doc = readJson(pluginsJson)
  check('信任记录（uiTrust 段）没被开关写丢', doc?.uiTrust?.['kept/ui/client.js']?.trustedAt === 1, JSON.stringify(doc?.uiTrust))
  check(
    '无关条目没被开关写丢',
    Array.isArray(doc?.entries) && doc.entries.some((e) => e.file === 'unrelated-row' && e.config?.keep === true),
    JSON.stringify(doc?.entries),
  )

  // ── 3c. 用户改设置：磁盘的新键进得来，patch 的键不被同键旧值顶掉 ──────────
  registry.writePluginConfig('probe-cfg', { bar: 2 })
  const afterSave = registry.resolvePluginConfig('probe-cfg', globalThis.__PROBE_CFG)
  check('用户新写进磁盘的键，resolve 里读得到（bar=2，保存即生效）', afterSave['bar'] === 2, JSON.stringify(afterSave))
  check('同一个键磁盘压不过 patch（foo 仍是 1）', afterSave['foo'] === 1, JSON.stringify(afterSave))
  check('磁盘原有的键还在（disk:"only"）', afterSave['disk'] === 'only', JSON.stringify(afterSave))
}

// ── 4. P0-4：defaultDisabled / 精确条目，两套判定必须同结论 ─────────────────
console.log('── 4. P0-4 defaultDisabled 与精确条目 ──')
const externalDir = join(process.env.DSC_HOME, 'plugins')
// plugins/ 下是单文件插件：写一份 type=module 让它按 ESM 解析，探针才不会先撞 CJS 警告。
writeText(join(externalDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n')
writeText(join(externalDir, 'dd.js'), "export const name = 'dd.js'\nexport function apply() {}\n")
writeText(join(externalDir, 'on.js'), "export const name = 'on.js'\nexport function apply() {}\n")
writeText(join(externalDir, 'off.js'), "export const name = 'off.js'\nexport function apply() {}\n")
// dd.js：目录里登记了一条 defaultDisabled（条目树里没有它的记录 → 默认关）；
// off.js：条目树明确记着停用；on.js：两处都没说 → 开。
registry.registerPluginMeta({ file: 'dd.js', name: 'dd', description: '', source: 'external', defaultDisabled: true })
const before = new Set(mountedIds())
// 先问注册表、再让装载器动手：装载器挂载时会用模块导出重建一次 meta，顺序反了就不是
// 「同一份 plugins.json 的两个判定」了。
const registryVerdict = registry.readEnabledPlugins(['dd.js', 'on.js', 'off.js'])
const failures = await loader.mountAllExternalPlugins(cordisRoot, [])
const mountedNow = new Set(mountedIds().filter((id) => !before.has(id)))
check('三种判定用例都跑到了（没被别的原因挡掉）', failures.length === 0, JSON.stringify(failures))
for (const file of ['dd.js', 'on.js', 'off.js']) {
  const registrySays = registryVerdict.has(file)
  const loaderSays = mountedNow.has(file)
  check(
    `${file}：readEnabledPlugins 与装载器同结论（都 ${registrySays ? '开' : '关'}）`,
    registrySays === loaderSays,
    `registry=${registrySays} 装载器=${loaderSays}`,
  )
}
check('defaultDisabled 且无条目 → 不挂', !mountedNow.has('dd.js'), JSON.stringify([...mountedNow]))

// ── 5. plugin_manager：装一个已停用的同名插件不许绕过开关 ───────────────────
console.log('── 5. plugin_manager install 不绕过开关 ──')
const pmModule = await import(srcUrl('packages/plugin-manager/index.ts'))
let pmTool = null
const pmCtx = {
  tools: {
    register(entry) {
      pmTool = entry
      return () => {}
    },
  },
  effect() {},
}
pmModule.pluginManagerPlugin.apply(pmCtx)
check('plugin_manager 注册出了工具', pmTool !== null && typeof pmTool.run === 'function')

if (pmTool !== null) {
  // 源文件就叫 wasoff.js：目标是 ~/.dsc/plugins/wasoff.js，与条目树里那条停用记录同名。
  const incoming = join(home, 'incoming', 'wasoff.js')
  writeText(incoming, "export const name = 'wasoff.js'\nexport function apply() { globalThis.__PROBE_WASOFF_APPLIED = true }\n")
  resetWrites()
  const installMsg = String(await pmTool.run({ action: 'install', file: incoming }))
  check(
    '文件确实复制过去了（不是靠「没拷成」蒙过去的）',
    fsCjs.existsSync(join(process.env.DSC_HOME, 'plugins', 'wasoff.js')),
  )
  check(
    '停用过的同名插件重装：不被挂上',
    !mountedIds().includes('wasoff.js') && globalThis.__PROBE_WASOFF_APPLIED === undefined,
    JSON.stringify({ installMsg, mounted: mountedIds() }),
  )
  check('停用过的同名插件重装：文案说清它还是停用状态', /停用/.test(installMsg), installMsg)
  check('停用过的同名插件重装：0 写盘', writesNow() === 0, `写了 ${writesNow()} 次`)

  // ── 6. plugin_manager：运行内核行给可读错误，0 写盘 ──────────────────────
  console.log('── 6. plugin_manager 对运行内核行 ──')
  registry.registerPluginMeta({ file: 'kernel-row', name: 'kernel-row', description: '', source: 'builtin' })
  check('内核行判为不可停用（canTogglePlugin=false）', registry.canTogglePlugin('kernel-row') === false)
  resetWrites()
  const kernelMsg = String(await pmTool.run({ action: 'disable', file: 'kernel-row' }))
  check(
    '内核行：错误说清「属于运行内核、不能停用」',
    /内核/.test(kernelMsg) && !/找不到插件文件/.test(kernelMsg),
    kernelMsg,
  )
  check('内核行：0 写盘', writesNow() === 0, `写了 ${writesNow()} 次`)
  check(
    '内核行：条目树里没留下它的停用记录',
    !(readJson(pluginsJson)?.entries ?? []).some((e) => e.file === 'kernel-row'),
    JSON.stringify(readJson(pluginsJson)?.entries),
  )
}

// ── 7. 启动时就停用的行：插件中心启用后不能丢 patch 的 config ───────────────
// 这一行从没挂过，`mountDetails` 里没有它的选项；修前「启用」只读磁盘，foo 变回 0。
console.log('── 7. 启动时停用的行：启用后仍拿 patch config ──')
check(
  'probe-off 启动时没挂（停用状态，apply 没跑过）',
  !mountedIds().includes('probe-off') && globalThis.__PROBE_OFF_CFG === undefined,
  JSON.stringify({ mounted: mountedIds(), cfg: globalThis.__PROBE_OFF_CFG }),
)
resetWrites()
await ui.setPluginEnabled('probe-off', true)
check('插件中心启用后真的挂上了', mountedIds().includes('probe-off'), JSON.stringify(mountedIds()))
check(
  '启用后 apply 拿到 patch 写的 foo=1',
  isObject(globalThis.__PROBE_OFF_CFG) && globalThis.__PROBE_OFF_CFG['foo'] === 1,
  JSON.stringify(globalThis.__PROBE_OFF_CFG),
)
check(
  '与「启动时就启用」那一行 apply 逐键相同',
  JSON.stringify(globalThis.__PROBE_OFF_CFG) === JSON.stringify(firstConfig),
  JSON.stringify({ probeOff: globalThis.__PROBE_OFF_CFG, probeCfg: firstConfig }),
)

// 停用期间用户改磁盘配置：启用时得按「patch 压磁盘、磁盘新键补进来」那一套重建，
// 既不能拿挂载时的旧快照（bar 永远进不来），也不能丢掉 patch 的键（foo 变回 0）。
await ui.setPluginEnabled('probe-off', false)
check('再停用后真的卸了（这一轮才算「停用期间的改动」）', !mountedIds().includes('probe-off'), JSON.stringify(mountedIds()))
registry.writePluginConfig('probe-off', { bar: 2 })
await ui.setPluginEnabled('probe-off', true)
check(
  '停用期间加的键在启用后进得来（bar=2）',
  isObject(globalThis.__PROBE_OFF_CFG) && globalThis.__PROBE_OFF_CFG['bar'] === 2,
  JSON.stringify(globalThis.__PROBE_OFF_CFG),
)
check(
  '停用期间改磁盘，patch 的键仍是 1（foo=1）',
  isObject(globalThis.__PROBE_OFF_CFG) && globalThis.__PROBE_OFF_CFG['foo'] === 1,
  JSON.stringify(globalThis.__PROBE_OFF_CFG),
)
check(
  '磁盘原有、patch 没给的键也还在（disk:"only"）',
  isObject(globalThis.__PROBE_OFF_CFG) && globalThis.__PROBE_OFF_CFG['disk'] === 'only',
  JSON.stringify(globalThis.__PROBE_OFF_CFG),
)

// ── 8. 行从 patch 里删掉：登记要跟着清（同 id 被别的包复用不串味）───────────
console.log('── 8. 行消失后清掉登记 ──')
writeText(
  join(bundleDir, 'cordis.patch.yml'),
  [
    '- insert:',
    '    - id: probe-cfg',
    '      name: ./cfg-plugin.js',
    '      config:',
    '        foo: 1',
    '    - id: probe-alias',
    '      name: ./alias-plugin.js',
    '',
  ].join('\n'),
)
const reconciled = await loader.reconcileProfileBundles(cordisRoot, profileDir, { appDir: root })
check('重扫把删掉的那一行卸了', reconciled.unmounted.includes('probe-off'), JSON.stringify(reconciled.unmounted))
check(
  'patch 配置登记也清了（resolve 只剩磁盘那份，foo=0）',
  registry.resolvePluginConfig('probe-off')['foo'] === 0,
  JSON.stringify(registry.resolvePluginConfig('probe-off')),
)
// 更硬的证据：登记要是没清，这个 id 再被启用时还会吃到上一份 patch 的 foo=1；
// 清掉了就只能按磁盘那份来（foo=0）。这也正是「同一个 id 被别的包复用时串味」的样子。
await ui.setPluginEnabled('probe-off', true)
check(
  '行消失后同 id 再启用，不会串回上一份 patch 配置（apply 的 foo=0）',
  isObject(globalThis.__PROBE_OFF_CFG) && globalThis.__PROBE_OFF_CFG['foo'] === 0,
  JSON.stringify(globalThis.__PROBE_OFF_CFG),
)

fsCjs.writeFileSync = realWriteFileSync

console.log(`\nPASS ${pass} / FAIL ${fail}`)
if (fail > 0) process.exitCode = 1
