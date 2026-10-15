/**
 * 「换一份配置文件用」的确定性探针（0.6.70 设置 → 通用「配置文件」那一行的「更换」）。
 *
 * 用户要求：设置里那一行只显示路径 + 复制/打开，得能**换一份文件**来用。做法：路径记在
 * settings.json 的 `configFile`（空串 = 出厂那份 ~/.dsc/config.yaml），配置读取全部改走
 * `activeConfigFile()`；换文件走原生桥（`pickConfigFile` 取路径 → `setConfigFile` 落偏好），
 * 宿主那侧校验「绝对路径 / 读得了 / 能解析的 YAML / 有 providers」四道。
 *
 * 四段（真内核 + 临时 HOME）：
 *   [1] `activeConfigFile`：默认 / 换过 / 那份文件不见了（回落出厂，不是崩）；
 *   [2] 读写都落在活动那份上（含 .bak 备份），端点清单跟着换；
 *   [3] 宿主方法 `setConfigFile` 的四种拒绝与一次成功（真内核调 `ctx.settings`）；
 *   [4] 接线钉：两个原生 op 的形状、界面通道排除、壳那一行的动作与流程。
 *
 * 隔离：临时 HOME + 临时配置文件，真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm build && node scripts/config-file-switch-test.mjs
 *
 * @module dsc/scripts/config-file-switch-test
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'dsc-configfile-'))
process.env.HOME = home
process.env.USERPROFILE = home
const dsc = join(home, '.dsc')
mkdirSync(dsc, { recursive: true })
writeFileSync(
  join(dsc, 'plugins.json'),
  JSON.stringify({ version: 1, entries: [{ file: 'memory', config: { enabled: false } }] }, null, 2),
  'utf8',
)

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
const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

const store = await import('../lib/core/config-store.js')
const { activeConfigFile, invalidateActiveConfigFile, readConfigDoc, writeConfigDoc, DEFAULT_CONFIG_FILE, CREDENTIALS_FILE } = store

/** 写一份最小可用的模型配置。 */
const writeYaml = (path, providerName) => {
  writeFileSync(
    path,
    `default:\n  provider: ${providerName}\n  model: m\nproviders:\n  ${providerName}:\n    baseURL: http://127.0.0.1:1/v1\n    apiKeyEnv: K\n    models:\n      - id: m\n        name: m\n        contextWindow: 1000\n        maxTokens: 100\n`,
    'utf8',
  )
}
const settingsPath = join(dsc, 'settings.json')
const setPref = (configFile) => {
  const doc = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
  writeFileSync(settingsPath, `${JSON.stringify({ ...doc, configFile }, null, 2)}\n`, 'utf8')
  invalidateActiveConfigFile()
}

console.log('[1] activeConfigFile：默认 / 换过 / 文件不见了')
{
  invalidateActiveConfigFile()
  check('没换过就是出厂那份', activeConfigFile() === DEFAULT_CONFIG_FILE, activeConfigFile())
  check('出厂那份在 ~/.dsc 下', DEFAULT_CONFIG_FILE.endsWith(join('.dsc', 'config.yaml')), DEFAULT_CONFIG_FILE)
  const custom = join(home, 'my-config.yaml')
  writeYaml(custom, 'custom')
  setPref(custom)
  check('换过之后读的是那一份', activeConfigFile() === custom, activeConfigFile())
  setPref(join(home, 'gone.yaml'))
  check('那一份不见了就回落出厂那份（不崩、也不让端点空掉）', activeConfigFile() === DEFAULT_CONFIG_FILE, activeConfigFile())
  setPref('')
  check('空串 = 出厂那份', activeConfigFile() === DEFAULT_CONFIG_FILE, activeConfigFile())
  check('凭据库不跟着换（key 仍从 ~/.dsc 取）', CREDENTIALS_FILE.endsWith(join('.dsc', 'credentials.yaml')), CREDENTIALS_FILE)
}

console.log('[2] 读写都落在活动那份上')
{
  const custom = join(home, 'work-config.yaml')
  writeYaml(custom, 'work')
  setPref(custom)
  const doc = readConfigDoc()
  check('读出来的是活动那份的端点', Object.keys(doc.providers ?? {}).join(',') === 'work', JSON.stringify(Object.keys(doc.providers ?? {})))
  const view = store.readModelConfig()
  check('模型配置全貌的 configFile 就是活动那份', view.configFile === custom, view.configFile)
  check('端点清单跟着换', view.providers.map((entry) => entry.name).join(',') === 'work', JSON.stringify(view.providers.map((entry) => entry.name)))
  writeConfigDoc({ ...doc, temperature: 0.5 })
  check('写回也写在活动那份上（出厂那份没被动）', readFileSync(custom, 'utf8').includes('temperature: 0.5'), '')
  check('覆盖前备份成 .bak', existsSync(`${custom}.bak`), `${custom}.bak`)
  check('出厂那份没被创建/改写', !existsSync(DEFAULT_CONFIG_FILE), DEFAULT_CONFIG_FILE)
  setPref('')
}

console.log('[3] 宿主方法 setConfigFile：四种拒绝 + 一次成功（真内核）')
{
  const { createKernel } = await import('../lib/host/kernel.js')
  const ctx = await createKernel({
    config: { providers: {}, defaultProvider: '', defaultModel: '' },
    resumeSessionPath: null,
  })
  const bad = (label, path, expect) => {
    const result = ctx.settings.setConfigFile(path)
    check(label, result.ok === false && String(result.error).includes(expect), JSON.stringify(result))
  }
  bad('相对路径被拒', 'relative.yaml', '绝对路径')
  bad('不存在的文件被拒', join(home, 'nope.yaml'), '读不了')
  const notYaml = join(home, 'broken.yaml')
  writeFileSync(notYaml, 'providers: [\n  - 这不是合法 YAML\n', 'utf8')
  bad('解析不出内容被拒（不是 YAML / 空文件）', notYaml, '解析不出任何内容')
  const noProviders = join(home, 'noprov.yaml')
  writeFileSync(noProviders, 'hello: world\n', 'utf8')
  bad('没有 providers 段被拒', noProviders, '没有 providers 段')
  const rejectedPref = JSON.parse(readFileSync(settingsPath, 'utf8')).configFile ?? ''
  check('被拒之后偏好没动（拒绝是干净的）', rejectedPref === '', JSON.stringify(rejectedPref))

  const good = join(home, 'good.yaml')
  writeYaml(good, 'good')
  const ok = ctx.settings.setConfigFile(good)
  check('合法文件换得成', ok.ok === true && String(ok.notice).includes(good), JSON.stringify(ok))
  check('偏好落盘了', JSON.parse(readFileSync(settingsPath, 'utf8')).configFile === good, readFileSync(settingsPath, 'utf8').slice(0, 120))
  check('活动配置立刻变成那一份（不用重启）', activeConfigFile() === good, activeConfigFile())
  check('运行期端点清单也跟着热更（reloadLive）', Object.keys(readConfigDoc().providers ?? {}).join(',') === 'good', JSON.stringify(Object.keys(readConfigDoc().providers ?? {})))
  const reset = ctx.settings.setConfigFile('')
  check('空串 = 恢复出厂那份', reset.ok === true && activeConfigFile() === DEFAULT_CONFIG_FILE, JSON.stringify(reset))
  check('恢复之后偏好也清空', (JSON.parse(readFileSync(settingsPath, 'utf8')).configFile ?? '') === '', '')
}

console.log('[4] 接线钉：原生桥 / 界面通道 / 壳那一行')
{
  const bridge = read('src/core/native-bridge.ts')
  check('原生桥放行 setConfigFile 与 pickConfigFile', /'setConfigFile'/.test(bridge) && /'pickConfigFile'/.test(bridge), '')
  check('setConfigFile 收一条路径（MAX_PATH）', /setConfigFile: \[\{ shape: \{ kind: 'string', max: MAX_PATH \} \}\]/.test(bridge), '')
  check('pickConfigFile 不收任何实参', /pickConfigFile: \[\]/.test(bridge), '')
  check('桥的协议版本没涨（加操作不涨，改语义才涨）', /NATIVE_BRIDGE_VERSION = 3/.test(bridge), '')
  const uiMethods = read('src/core/ui-methods.ts')
  check('界面通道排除 setConfigFile（写类入口只走桥）', /'setConfigFile',/.test(uiMethods), '')
  const contract = read('src/contract.ts')
  check('契约里有 setConfigFile 与信息行动作类型', /setConfigFile\(path: string\): Promise<SettingsMutation>/.test(contract) && /export interface SettingsInfoAction/.test(contract), '')
  const hostMethods = read('src/core/host-methods.ts')
  check('宿主方法白名单里有它', /'setConfigFile',/.test(hostMethods), '')
  const plugin = read('src/plugins/settings.ts')
  check('通用分区那一行声明了「更换」动作', /id: 'switch-config-file'/.test(plugin) && /id: 'reset-config-file'/.test(plugin), '')
  check('那一行显示的是活动路径（不是写死的常量）', /label: '配置文件',\r?\n\s*text: activeConfigFile\(\)/.test(plugin), '')
  const shell = read('ui-shell/src/plugins/settings/ui.tsx')
  check('壳画信息行的行内动作', /field\.actions\?\.map\(/.test(shell), '')
  check('壳只认这两个 id（认不出的整条跳过）', /action\.id !== 'switch-config-file' && action\.id !== 'reset-config-file'/.test(shell), '')
  check('壳的流程：先取路径（取消就什么都不做）再让宿主换', /pickConfigFile/.test(shell) && /invoke<SettingsMutation>\('setConfigFile'/.test(shell), '')
  check('换完之后重取分区清单（路径与「恢复默认」跟着变）', /onConfigFileChanged\?\.\(\)/.test(shell), '')
  const main = read('desktop/electron/main/index.ts')
  check('主进程实现了两条 op 与文件对话框', /setConfigFile: \(\[path\]\)/.test(main) && /async function pickConfigFile/.test(main), '')
  check('对话框的后缀过滤写死在主进程（页面递不进来）', /extensions: \['yaml', 'yml', 'json'\]/.test(main), '')
}

console.log(`\n换配置文件：${String(passed)}/${String(passed + failures)} 通过`)
process.exit(failures === 0 ? 0 : 1)
