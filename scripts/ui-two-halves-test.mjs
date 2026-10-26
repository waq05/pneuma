// 一个包两半的端到端自检：examples/plugin-two-halves 装进 profile 后，
// 宿主半（工具）与界面半（状态栏那一段）都要到位。
// 跑法：cd D:\dsc && pnpm run build && node scripts/ui-two-halves-test.mjs
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-two-halves-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
process.env.DSC_PROFILE = 'demo'
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const example = join(root, 'examples', 'plugin-two-halves')
const profile = join(home, '.dsc', 'profiles', 'demo')
const installed = join(profile, 'node_modules', 'dsc-demo-two-halves')
mkdirSync(profile, { recursive: true })
cpSync(example, installed, { recursive: true })
writeFileSync(
  join(profile, 'package.json'),
  JSON.stringify({ name: 'demo-profile', private: true, dsh: { profile: { bundles: ['dsc-demo-two-halves'] } } }, null, 2),
  'utf8',
)

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (extra === '' ? '' : ' — ' + extra)) }
}

const { createKernel } = await import('../lib/host/kernel.js')
const { mountBundlePlugins } = await import('../lib/core/plugin-loader.js')
const { listPluginInfos } = await import('../lib/core/plugin-registry.js')
const { collectUiArtifactsForPlatform } = await import('../lib/core/ui-bundles.js')
const { resolveUiBundleRequest } = await import('../lib/core/ui-route.js')
const { composeUiBootGraph } = await import('../lib/ui/manifest.js')
const { toUiPluginRows } = await import('../lib/core/ui-bundles.js')

const ctx = await createKernel({
  config: {
    providers: { test: { name: 'test', displayName: 'Test', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', models: [{ id: 'm', name: 'm', contextWindow: 1000, maxTokens: 100, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} }] } },
    defaultProvider: 'test',
    defaultModel: 'm',
  },
  resumeSessionPath: null,
})

console.log('宿主半')
const mounted = await mountBundlePlugins(ctx, profile)
check('组合包挂上了', mounted.failures.length === 0, JSON.stringify(mounted.failures))
const tool = ctx.tools.list().find((item) => item.name === 'two_halves_hi')
check('宿主半的工具进了注册表', tool !== undefined, JSON.stringify(ctx.tools.list().map((t) => t.name).slice(-5)))
const output = tool === undefined ? null : await tool.run({}, { cwd: home, signal: new AbortController().signal })
check('工具能执行', output === '两半都在', String(output))
const info = listPluginInfos().find((item) => item.name === 'dsc-demo-two-halves')
check('插件中心认得出它来自组合包', info?.bundle === 'dsc-demo-two-halves', JSON.stringify(info?.bundle))
// 界面半是我们自己会加载的（platform: pneuma），不能标成「dsh 客户端插件 · 只列不加载」。
check(
  '不把会加载的 pneuma 界面半标成「只列不加载」',
  !(info?.clientCapabilities ?? []).includes('platform:pneuma'),
  JSON.stringify(info?.clientCapabilities),
)

console.log('界面半')
const artifacts = collectUiArtifactsForPlatform('web', { force: true })
const entry = artifacts.entries.find((item) => item.id === 'dsc-demo-two-halves')
check('界面半收进了产物表', entry !== undefined, JSON.stringify(artifacts.problems))
check('来源标成 package', entry?.origin === 'package', String(entry?.origin))
const graph = composeUiBootGraph({ name: 'Pneuma', version: 'test' }, toUiPluginRows(artifacts.entries))
const row = graph.entries.find((item) => item.id === 'dsc-demo-two-halves')
check('进得了启动图', row !== undefined, JSON.stringify(graph.entries.map((e) => e.id)))
const route = resolveUiBundleRequest('/plugins/dsc-demo-two-halves/client.js', String(entry?.rev))
check('路由按 rev 伺服装载到这份 bundle', route.status === 200 && String(route.body).includes('__DSC_UI_FACTORIES__'), String(route.status) + ' ' + (route.reason ?? ''))
const wrong = resolveUiBundleRequest('/plugins/dsc-demo-two-halves/client.js', '0'.repeat(16))
check('rev 对不上给 404（内容寻址）', wrong.status === 404, String(wrong.status) + ' ' + (wrong.reason ?? ''))

console.log('示例包的工厂形状')
// 这份 bundle 是手写的（不走构建），壳的工厂协议一变它就静默失效——只有 e2e 能发现。
// 这里当场把它跑一遍：注册名、工厂产出、require 白名单、apply 注册到哪个槽、组件带什么标记。
{
  const source = readFileSync(join(example, 'client.bundle.js'), 'utf8')
  const previous = globalThis.__DSC_UI_FACTORIES__
  const table = {}
  globalThis.__DSC_UI_FACTORIES__ = table
  new Function(source)()
  const factory = table['dsc-demo-two-halves']
  check('bundle 注册的工厂名与包名一致', typeof factory === 'function', Object.keys(table).join(','))
  const asked = []
  const require_ = (spec) => {
    asked.push(spec)
    if (spec === 'react') {
      return {
        createElement: (type, props, ...children) => ({
          type,
          props: { ...props, ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) },
        }),
      }
    }
    if (spec === '@dsc/ui') return { defineUiPlugin: (definition) => definition }
    throw new Error('白名单外的模块：' + spec)
  }
  const mod = { exports: {} }
  if (typeof factory === 'function') factory(require_, mod, mod.exports)
  const exported = mod.exports.default
  check('工厂产出的模块有 name 与 apply', typeof exported?.name === 'string' && typeof exported?.apply === 'function', JSON.stringify(Object.keys(exported ?? {})))
  check('只 require 白名单里的模块（react 与 @dsc/ui）', asked.every((spec) => spec === 'react' || spec === '@dsc/ui'), asked.join(','))
  const registered = []
  exported?.apply?.({
    slots: {
      register: (slot, meta, component) => { registered.push({ slot, id: meta.id, component }) },
      injectSlot: () => undefined,
      declare: () => undefined,
    },
    host: { name: 'Pneuma', version: 'test', platform: 'web' },
  })
  check('apply 把一段注册进 shell.statusbar', registered.length === 1 && registered[0].slot === 'shell.statusbar', JSON.stringify(registered.map((item) => item.slot)))
  const element = registered[0] === undefined ? null : registered[0].component()
  check('注册的组件带 data-two-halves 标记（e2e 靠它认这条）', element?.props?.['data-two-halves'] === '1', JSON.stringify(element?.props ?? null))
  check('组件文字是「两半示例」', element?.props?.children === '两半示例', String(element?.props?.children))
  if (previous === undefined) delete globalThis.__DSC_UI_FACTORIES__
  else globalThis.__DSC_UI_FACTORIES__ = previous
}

ctx.emit('dsc/exit')
if (ctx.fiber !== null && ctx.fiber !== undefined) await ctx.fiber.dispose()

console.log(String.fromCharCode(10) + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
