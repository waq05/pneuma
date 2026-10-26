// 实测：从 npm 装一个**真**第三方 dsh 组合包（dsh-cost-meter 1.9.41），走完整链路。
// 跑法：node scripts/dsh-real-plugin-check.mjs
//   前置：DSC_REAL_PROFILE 指向一个装好包的 profile 目录（默认 D:/tmp/dsc-real-home/.dsc/profiles/cost）
//   这个脚本只读那个目录，所有写入都落在它自己的临时家里。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.DSC_REAL_HOME ?? 'D:/tmp/dsc-real-home'
const profileDir = process.env.DSC_REAL_PROFILE ?? join(root, '.dsc', 'profiles', 'cost')
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSC_HOME = join(root, '.dsc')
process.env.DSC_PROFILE = 'cost'
mkdirSync(join(root, '.dsc'), { recursive: true })
if (!existsSync(join(root, '.dsc', 'config.yaml'))) {
  writeFileSync(join(root, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
}

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (extra === '' ? '' : ' — ' + extra)) }
}

if (!existsSync(join(profileDir, 'node_modules', 'dsh-cost-meter'))) {
  console.log('跳过：' + profileDir + ' 里没装 dsh-cost-meter（先 npm install dsh-cost-meter）')
  process.exit(0)
}

const { createKernel } = await import('../lib/host/kernel.js')
const { mountBundlePlugins } = await import('../lib/core/plugin-loader.js')
const { isPluginEnabled, listPluginInfos, writePluginEnabled } = await import('../lib/core/plugin-registry.js')

function boot() {
  return createKernel({
    config: {
      providers: { test: { name: 'test', displayName: 'Test', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', models: [{ id: 'm', name: 'm', contextWindow: 1000, maxTokens: 100, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} }] } },
      defaultProvider: 'test',
      defaultModel: 'm',
    },
    resumeSessionPath: null,
  })
}
async function stop(ctx) {
  ctx.emit('dsc/exit')
  if (ctx.fiber !== null && ctx.fiber !== undefined) await ctx.fiber.dispose()
}

if (process.argv.includes('--phase=off')) {
  // 兼容层关着的那一轮必须在**独立进程**里跑：同一个进程里模块导入失败会被 ESM
  // 缓存住，之后就算注册了钩子也会原样重抛旧错误（不是产品缺陷，是测试写法）。
  console.log('真插件：兼容层关着时先告诉用户去开它')
  writePluginEnabled('dsh-compat', false)
  const ctx = await boot()
  const result = await mountBundlePlugins(ctx, profileDir)
  const problem = result.failures.map((item) => item.problem).join(' ')
  check('挂不上', result.failures.length > 0)
  check('说明缺什么包', problem.includes('@deepseek-ai/'), problem.slice(0, 200))
  check('并且指路：先启用 dsh 兼容层', problem.includes('dsh 兼容层'), problem.slice(0, 300))
  await stop(ctx)
  console.log(String.fromCharCode(10) + pass + ' PASS / ' + fail + ' FAIL')
  process.exit(fail === 0 ? 0 : 1)
}

console.log('真插件：兼容层关着时先告诉用户去开它（子进程跑，见下）')
{
  const { spawnSync } = await import('node:child_process')
  const child = spawnSync(process.execPath, [process.argv[1], '--phase=off'], {
    encoding: 'utf8',
    env: { ...process.env, DSC_REAL_HOME: root, DSC_PROFILE: 'cost' },
  })
  const lines = String(child.stdout).split(String.fromCharCode(10)).filter((line) => line.includes('PASS') || line.includes('FAIL'))
  for (const line of lines) {
    if (line.includes('PASS')) { pass += 1; console.log(line) }
    else { fail += 1; console.log(line) }
  }
  check('子进程跑完了（退出码 0）', child.status === 0, String(child.status) + ' ' + String(child.stderr).slice(0, 200))
}

console.log('真插件：兼容层开着时能装、能认出来自哪个包')
{
  writePluginEnabled('dsh-compat', true)
  const ctx = await boot()
  const result = await mountBundlePlugins(ctx, profileDir)
  const problem = result.failures.map((item) => item.problem).join(' ')
  check('挂上了（目录→入口、@deepseek-ai 两个包、ctx.get 都过了）', result.failures.length === 0, problem)
  const info = listPluginInfos().find((item) => item.name === 'cost-meter')
  check('插件中心认得出它叫 cost-meter', info !== undefined, JSON.stringify(listPluginInfos().map((i) => i.name)))
  check('插件中心认得出它来自组合包 dsh-cost-meter', info?.bundle === 'dsh-cost-meter', String(info?.bundle))
  check(
    '界面能力列得出来（platform:web，只列不加载）',
    (info?.clientCapabilities ?? []).includes('platform:web'),
    JSON.stringify(info?.clientCapabilities),
  )
  const ledger = join(root, '.dsc', 'storages', 'cost-meter', 'ledger.json')
  check('账本落在 Pneuma 的家里，不是 ~/.dsh', existsSync(ledger), ledger)
  await stop(ctx)
}

console.log('\n' + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
