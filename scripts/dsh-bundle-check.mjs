// 组合包（dsh 安装形态）自检：profile 层序、bundle 的 patch、insert 行、版本闸、!!js 拒绝。
// 跑法：cd D:\dsc && pnpm run build && node scripts/dsh-bundle-check.mjs
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-dsh-bundle-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')

const { createKernel } = await import('../lib/host/kernel.js')
const { mountBundlePlugins, mountAllExternalPlugins } = await import('../lib/core/plugin-loader.js')
const { writePluginEnabled } = await import('../lib/core/plugin-registry.js')

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${extra === '' ? '' : ` — ${extra}`}`)
  }
}

// ── 造一个组合包 + 一个 profile ───────────────────────────────────────────────
const profileDir = join(home, '.dsc', 'profiles', 'test')
const bundleDir = join(profileDir, 'node_modules', 'demo-bundle')
mkdirSync(join(bundleDir, 'plugins'), { recursive: true })

// 包里带的插件本体（一个最普通的 cordis 插件，注册一个工具）
writeFileSync(
  join(bundleDir, 'plugins', 'hello.js'),
  `export const name = 'bundle-hello'
export const inject = ['tools']
export function apply(ctx) {
  const off = ctx.tools.register({
    name: 'bundle_hello',
    description: 'Say hello from a bundle.',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    run: async () => 'hello from bundle',
  })
  return () => off()
}
`,
  'utf8',
)

// 包的 patch：插一行（点名自己的插件文件）
writeFileSync(
  join(bundleDir, 'cordis.patch.yml'),
  `- insert:
    - id: demo-hello
      name: ./plugins/hello.js
      config:
        greeting: hi
- id: demo-hello
  config:
    greeting: hello
`,
  'utf8',
)

writeFileSync(
  join(bundleDir, 'package.json'),
  JSON.stringify(
    {
      name: 'demo-bundle',
      version: '1.0.0',
      engines: { dsh: '>=0.2.0-0 <0.3.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    },
    null,
    2,
  ),
  'utf8',
)

// 另一个包：版本闸该拦下它
const badDir = join(profileDir, 'node_modules', 'too-new')
mkdirSync(badDir, { recursive: true })
writeFileSync(
  join(badDir, 'package.json'),
  JSON.stringify({ name: 'too-new', version: '2.0.0', engines: { dsh: '^0.3.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2),
  'utf8',
)
writeFileSync(join(badDir, 'cordis.patch.yml'), '- insert:\n    - id: nope\n      name: ./nope.js\n', 'utf8')

// profile：包序 + 自己的一层 patch
writeFileSync(
  join(profileDir, 'package.json'),
  JSON.stringify({ name: 'test-profile', dsh: { profile: { bundles: ['demo-bundle', 'too-new'] } } }, null, 2),
  'utf8',
)

async function boot() {
  return createKernel({
    config: {
      providers: {
        test: {
          name: 'test',
          displayName: 'Test',
          baseUrl: 'http://127.0.0.1:9',
          apiKey: 'k',
          models: [{ id: 'm', name: 'm', contextWindow: 1000, maxTokens: 100, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} }],
        },
      },
      defaultProvider: 'test',
      defaultModel: 'm',
    },
    resumeSessionPath: null,
  })
}

async function stop(ctx) {
  ctx.emit('dsc/exit')
  const fiber = ctx?.fiber
  if (fiber !== null && fiber !== undefined && typeof fiber.dispose === 'function') await fiber.dispose()
}

console.log('组合包：层序、insert、版本闸')
{
  const ctx = await boot()
  const result = await mountBundlePlugins(ctx, profileDir)
  const warnings = result.warnings.join('；')
  check('组合包里的插件挂上了', result.failures.length === 0, JSON.stringify(result.failures))
  const names = ctx.tools.list().map((tool) => tool.name)
  check('patch insert 的行真的加载了（工具进注册表）', names.includes('bundle_hello'), JSON.stringify(names))
  const tool = ctx.tools.list().find((item) => item.name === 'bundle_hello')
  const out = await tool.run({}, { cwd: home, signal: new AbortController().signal })
  check('插件能执行', out === 'hello from bundle', String(out))
  const { listPluginInfos } = await import('../lib/core/plugin-registry.js')
  const row = listPluginInfos().find((item) => item.name === 'bundle-hello')
  check('插件中心能看出它来自哪个组合包', row?.bundle === 'demo-bundle', JSON.stringify(row?.bundle))
  check('版本不满足的包被拦下并说清原因', warnings.includes('too-new') && warnings.includes('0.3'), warnings)
  check('后一层 patch 改到了前一层 insert 的行（不报「找不到」）', !warnings.includes('demo-hello'), warnings)
  await stop(ctx)
}

console.log('组合包：包名那一行要解析到入口文件（不是目录）')
{
  const pkgDir = join(profileDir, 'node_modules', 'pkg-export-bundle')
  mkdirSync(join(pkgDir, 'dist'), { recursive: true })
  // 入口写在 exports["."] 里，dist/ 下；patch 行只写包名——dsh 就是这么装的。
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: 'pkg-export-bundle',
        version: '1.0.0',
        exports: { '.': { default: './dist/main.js' } },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(join(pkgDir, 'cordis.patch.yml'), '- insert:\n    - id: pkg-row\n      name: pkg-export-bundle\n', 'utf8')
  writeFileSync(
    join(pkgDir, 'dist', 'main.js'),
    `export const name = 'pkg-hello'
export const inject = ['tools']
export function apply(ctx) {
  // 模块顶层到 apply 之间读 env：兼容层应该在导入之前就把 DSH_HOME 翻成 dsc 的家。
  const home = process.env.DSH_HOME
  // 兼容层开着时 ctx.tools 是 dsh 形状（execute），与真插件一致。
  const off = ctx.tools.register({
    name: 'pkg_home',
    description: 'Where DSH_HOME points.',
    parameters: { type: 'object', properties: {} },
    execute: async () => String(home),
  })
  return () => off()
}
`,
    'utf8',
  )
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: 'test-profile', dsh: { profile: { bundles: ['pkg-export-bundle'] } } }, null, 2),
    'utf8',
  )
  // dsh 插件要在兼容层开着时挂（默认关，用户得在插件中心打开）。
  writePluginEnabled('dsh-compat', true)
  const ctx = await boot()
  const result = await mountBundlePlugins(ctx, profileDir)
  check('包名行挂上了（exports["."] 的入口被找到）', result.failures.length === 0, JSON.stringify(result.failures))
  const names = ctx.tools.list().map((tool) => tool.name)
  check('入口文件里的工具进了注册表', names.includes('pkg_home'), JSON.stringify(names))
  const tool = ctx.tools.list().find((item) => item.name === 'pkg_home')
  const out = tool === undefined ? '' : await tool.run({}, { cwd: home, signal: new AbortController().signal })
  check('导入前把 DSH_HOME 翻成 Pneuma 的家（不写进 dsh 目录）', out === join(home, '.dsc'), String(out))
  await stop(ctx)
}

console.log('组合包：运行时 ctx.get 缺服务要说清缺什么')
{
  const badApply = join(profileDir, 'node_modules', 'needs-services')
  mkdirSync(badApply, { recursive: true })
  writeFileSync(
    join(badApply, 'package.json'),
    JSON.stringify({ name: 'needs-services', version: '1.0.0', main: 'main.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2),
    'utf8',
  )
  writeFileSync(join(badApply, 'cordis.patch.yml'), '- insert:\n    - id: needs-row\n      name: needs-services\n', 'utf8')
  // 不声明 inject，直接在 apply 里 ctx.get——真插件（cost-meter）就是这么干的。
  writeFileSync(
    join(badApply, 'main.js'),
    `export const name = 'needs-services'
export function apply(ctx) {
  const projections = ctx.get('sessionProjections')
  return projections.install()
}
`,
    'utf8',
  )
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: 'test-profile', dsh: { profile: { bundles: ['needs-services'] } } }, null, 2),
    'utf8',
  )
  writePluginEnabled('dsh-compat', true)
  const ctx = await boot()
  const result = await mountBundlePlugins(ctx, profileDir)
  const problem = result.failures.map((item) => item.problem).join(' ')
  check('挂不上时说明它取过哪个服务', problem.includes('sessionProjections'), problem)
  check('并且给出这个服务的判定（不是一句异常）', problem.includes('事件投影'), problem)
  await stop(ctx)
}

console.log('组合包：!!js 一律拒绝')
{
  const jsDir = join(profileDir, 'node_modules', 'js-bundle')
  mkdirSync(jsDir, { recursive: true })
  writeFileSync(
    join(jsDir, 'package.json'),
    JSON.stringify({ name: 'js-bundle', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2),
    'utf8',
  )
  writeFileSync(join(jsDir, 'cordis.patch.yml'), '- id: x\n  config: !!js/function >\n    function () { return 1 }\n', 'utf8')
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: 'test-profile', dsh: { profile: { bundles: ['js-bundle'] } } }, null, 2),
    'utf8',
  )
  const ctx = await boot()
  const result = await mountBundlePlugins(ctx, profileDir)
  const warnings = result.warnings.join('；')
  check('含 !!js 的包被拒绝', warnings.includes('!!js'), warnings)
  check('拒绝文案说明理由（任意表达式）', warnings.includes('任意'), warnings)
  await stop(ctx)
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: 'test-profile', dsh: { profile: { bundles: ['demo-bundle'] } } }, null, 2),
    'utf8',
  )
}

console.log('组合包：启动链路（没配 profile 时完全不碰）')
{
  writePluginEnabled('dsh-compat', false)
  const ctx = await boot()
  const failures = await mountAllExternalPlugins(ctx, [])
  check('没有 profile 配置时不加载组合包（工具不在）', !ctx.tools.list().some((tool) => tool.name === 'bundle_hello'))
  check('也没有因此报错', failures.length === 0, JSON.stringify(failures))
  await stop(ctx)
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
