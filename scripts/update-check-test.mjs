/**
 * 检查更新的确定性探针。
 *
 * 三层：
 *   [1] 纯逻辑：compareVersions 的边界（v 前缀、段数不齐、坏值）
 *   [2] 纯逻辑：pickInstaller 的挑选规则（精确版本 > 任意 setup > 不挑 portable > null）
 *   [3] 真发请求：桩掉 globalThis.fetch，看**真请求**（URL / user-agent / accept）
 *       与三种回包的解析（GitHub 形状、自托管形状、坏回包），以及版本比较的结论
 *   [4] 薄包装：checkForUpdate 的 notice / data 口径（设置页按钮与 /update 命令走它）
 *   [5] 偏好：updateCheck 的读档归一（缺键 / 坏值 → 每次启动；off / daily 照读）
 *   [6] 形态钉：宿主「关于」分区的分出口、桌面主进程的接线、契约里的结构化载荷
 *
 * 为什么从 `lib/` 取而不是直读 `.ts`：`update-check.ts` 有**运行期**依赖
 * （`request-attribution` 的 APP_USER_AGENT、`version` 的 DSC_VERSION），
 * 直读 `.ts` 时那些 `./x.js` 说明符在源码树里解析不到。所以先 `pnpm build` 再跑本探针
 * （与 remote-host-test 同一取向）。
 *
 * 运行：node scripts/update-check-test.mjs
 *
 * @module dsc/scripts/update-check-test
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

// 偏好读写的位置按 homedir 算，所以必须在 import 核心之前换掉 HOME / USERPROFILE。
const home = join(tmpdir(), `dsc-update-check-${Date.now().toString(36)}`)
mkdirSync(join(home, '.dsc'), { recursive: true })
process.env.HOME = home
process.env.USERPROFILE = home

const { compareVersions, fetchLatestRelease, pickInstaller, checkForUpdate, UPDATE_CHECK_URL } = await import(
  '../lib/core/update-check.js'
)
const { readPrefs, writePrefs, UPDATE_CHECK_MODES } = await import('../lib/core/prefs.js')

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

/** 一次假的 fetch：记下请求，按给定回包作答。 */
function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}), signal: init?.signal })
    return handler(String(url))
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** 造一个 GitHub Releases 形状的回包。 */
const githubRelease = (tag, assets = []) => ({
  tag_name: tag,
  html_url: `https://github.com/waq05/pneuma/releases/tag/${tag}`,
  assets,
})

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: () => Promise.resolve(body),
})

console.log('[1] compareVersions：v 前缀 / 段数不齐 / 坏值')
{
  check('0.6.9 < 0.6.10（按数字段比，不是字典序）', compareVersions('0.6.9', '0.6.10') < 0)
  check('v 前缀容忍', compareVersions('v0.7.0', '0.6.67') > 0)
  check('段数不齐补零：0.6 == 0.6.0', compareVersions('0.6', '0.6.0') === 0)
  check('预发布后缀不影响数字段：0.7.0-rc.1 > 0.6.67', compareVersions('0.7.0-rc.1', '0.6.67') > 0)
  check('相同版本给 0', compareVersions('0.6.67', '0.6.67') === 0)
  check('认不出的版本号给 null（不编一个结论）', compareVersions('latest', '0.6.67') === null && compareVersions('0.6.67', '') === null)
}

console.log('[2] pickInstaller：挑安装器')
{
  const setup = (name) => ({ name, url: `https://example.test/${name}`, size: 100 })
  const exact = [setup('pneuma-setup-0.6.68.exe'), setup('pneuma-portable-0.6.68.exe')]
  check('精确版本优先', pickInstaller(exact, 'v0.6.68')?.name === 'pneuma-setup-0.6.68.exe', pickInstaller(exact, 'v0.6.68')?.name)
  check('tag 带 v、资产名不带 v 也认得出', pickInstaller(exact, '0.6.68')?.name === 'pneuma-setup-0.6.68.exe')
  const older = [setup('pneuma-setup-0.6.60.exe')]
  check('版本对不上时退而取任意 setup（发布名改了也能装）', pickInstaller(older, 'v0.6.68')?.name === 'pneuma-setup-0.6.60.exe')
  check('portable 不挑（就地更新要的是安装器）', pickInstaller([setup('pneuma-portable-0.6.68.exe')], 'v0.6.68') === null)
  check('没有 setup 就给 null（调用方退回打开发布页）', pickInstaller([], 'v0.6.68') === null)
  // 改名期：现行发布物上挂的还是旧名（2026-10-14 实查 v0.6.67 的资产是 muse-code-setup-*.exe）。
  const legacy = [setup('muse-code-setup-0.6.67.exe')]
  check('改名前的旧名也认（否则老版本那天就地更新找不到安装器）', pickInstaller(legacy, 'v0.6.67')?.name === 'muse-code-setup-0.6.67.exe')
  const both = [setup('muse-code-setup-0.6.68.exe'), setup('pneuma-setup-0.6.68.exe')]
  check('两种名字都在时现行名优先', pickInstaller(both, 'v0.6.68')?.name === 'pneuma-setup-0.6.68.exe', pickInstaller(both, 'v0.6.68')?.name)
  check('别的产品的安装器不认（不误挑）', pickInstaller([setup('other-app-setup-1.0.0.exe')], 'v0.6.68') === null)
}

console.log('[3] fetchLatestRelease：真请求的形状 + 三种回包')
{
  const assets = [
    { name: 'pneuma-setup-0.6.68.exe', browser_download_url: 'https://example.test/setup.exe', size: 123 },
    { name: 'notes.txt', browser_download_url: 'https://example.test/notes.txt' },
  ]
  const stub = stubFetch(() => jsonResponse(githubRelease('v0.6.68', assets)))
  const result = await fetchLatestRelease('0.6.67', 'https://api.github.com/repos/waq05/pneuma/releases/latest')
  check('请求带 user-agent（GitHub API 缺它会返 403）', /^pneuma\//.test(String(stub.calls[0]?.headers['user-agent'] ?? '')), JSON.stringify(stub.calls[0]?.headers))
  check('请求带 accept（认 GitHub 的媒体类型）', String(stub.calls[0]?.headers.accept ?? '').includes('application/vnd.github+json'))
  check('请求带超时信号', stub.calls[0]?.signal !== undefined)
  check('有新版：update 为真', result.ok === true && result.update === true, JSON.stringify(result))
  check('版本号原样带回（含 v 前缀）', result.info.version === 'v0.6.68')
  check('发布页带回', result.info.pageUrl === 'https://github.com/waq05/pneuma/releases/tag/v0.6.68')
  check('资产解析出下载地址', result.info.assets[0]?.url === 'https://example.test/setup.exe')
  check('资产缺 size 时给 0（不编数）', result.info.assets[1]?.size === 0)
  stub.restore()

  const same = stubFetch(() => jsonResponse(githubRelease('v0.6.67')))
  check('同版本：update 为假', (await fetchLatestRelease('0.6.67', 'https://x.test')).update === false)
  same.restore()

  const older = stubFetch(() => jsonResponse(githubRelease('v0.6.10')))
  check('源比本地旧：update 为假（不提示降级）', (await fetchLatestRelease('0.6.67', 'https://x.test')).update === false)
  older.restore()

  const selfHosted = stubFetch(() => jsonResponse({ version: '0.7.0', url: 'https://example.test/dl' }))
  const plain = await fetchLatestRelease('0.6.67', 'https://example.test/latest.json')
  check('自托管形状也认（{version, url}）', plain.ok === true && plain.info.version === '0.7.0')
  check('自托管回包没有 assets：给空数组', Array.isArray(plain.info.assets) && plain.info.assets.length === 0)
  selfHosted.restore()

  const bad = stubFetch(() => jsonResponse({ nope: 1 }))
  check('认不出版本号：ok 为假且带一句人话', (await fetchLatestRelease('0.6.67', 'https://x.test')).ok === false)
  bad.restore()

  const http500 = stubFetch(() => jsonResponse({}, 500))
  const failed = await fetchLatestRelease('0.6.67', 'https://x.test')
  check('非 2xx：报出状态码', failed.ok === false && failed.error.includes('500'), failed.error)
  http500.restore()

  const unreachable = stubFetch(() => {
    throw new Error('connect ECONNREFUSED')
  })
  const down = await fetchLatestRelease('0.6.67', 'https://x.test')
  check('连不上：如实说是连不上', down.ok === false && down.error.includes('连不上'), down.error)
  unreachable.restore()

  check('更新源常量指向 Releases API', /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(UPDATE_CHECK_URL), UPDATE_CHECK_URL)
  // 仓名必须是本项目用过的名字之一：写一个不存在的仓，「检查更新」一上线就报 404
  // （2026-10-14 就是这么发现的——源写成新名 pneuma，而仓当时还叫 muse-code）。
  check('仓名是本项目用过的名字（不写不存在的仓）', /\/(?:pneuma|muse-code)\/releases\/latest$/.test(UPDATE_CHECK_URL), UPDATE_CHECK_URL)
}

console.log('[4] checkForUpdate：薄包装的 notice / data 口径')
{
  const stub = stubFetch(() => jsonResponse(githubRelease('v0.6.68')))
  const found = await checkForUpdate('0.6.67', 'https://x.test')
  check('有新版：notice 说清两边版本', found.ok === true && found.notice.includes('0.6.68') && found.notice.includes('0.6.67'), found.notice)
  check('有新版：data 给发布页（设置页按钮据此打开浏览器）', found.data?.kind === 'url' && found.data.url.includes('releases/tag'))
  stub.restore()

  const same = stubFetch(() => jsonResponse(githubRelease('v0.6.67')))
  const latest = await checkForUpdate('0.6.67', 'https://x.test')
  check('已最新：不给 data（界面不该开浏览器）', latest.ok === true && latest.data === undefined, JSON.stringify(latest))
  same.restore()

  const stub2 = stubFetch(() => jsonResponse({ version: '0.7.0' }))
  const noPage = await checkForUpdate('0.6.67', 'https://x.test')
  check('有新版但源没给地址：data 缺省（而不是给个空串）', noPage.ok === true && noPage.data === undefined, JSON.stringify(noPage))
  stub2.restore()
}

console.log('[5] 偏好：updateCheck 的读档归一')
{
  check('三档表就是 launch / daily / off', JSON.stringify([...UPDATE_CHECK_MODES]) === JSON.stringify(['launch', 'daily', 'off']))
  check('没有 settings.json 时默认每次启动', readPrefs().updateCheck === 'launch', readPrefs().updateCheck)
  const file = join(home, '.dsc', 'settings.json')
  for (const value of ['off', 'daily', 'launch']) {
    writeFileSync(file, JSON.stringify({ updateCheck: value }))
    check(`显式写了 ${value} 就照读`, readPrefs().updateCheck === value, readPrefs().updateCheck)
  }
  writeFileSync(file, JSON.stringify({ updateCheck: 'every-hour' }))
  check('认不出的档位回落每次启动（不静默变成不检查）', readPrefs().updateCheck === 'launch', readPrefs().updateCheck)
  writeFileSync(file, JSON.stringify({ updateCheck: 7 }))
  check('类型不对也回落每次启动', readPrefs().updateCheck === 'launch', readPrefs().updateCheck)
  writePrefs({ updateCheck: 'daily' })
  check('writePrefs 能落盘（设置页改档位走它）', JSON.parse(readFileSync(file, 'utf8')).updateCheck === 'daily')
}

console.log('[6] 形态钉：宿主分出口 / 桌面接线 / 契约载荷')
{
  const settings = read('src/plugins/settings.ts')
  check('关于分区有 updateCheck 这个 select', settings.includes("key: 'updateCheck'") && settings.includes('UPDATE_CHECK_OPTIONS'))
  check('关于分区回读 updateCheck 当前值', /values: \(\) => \(\{ updateCheck: prefs\.updateCheck \}\)/.test(settings))
  check('写入走 savePrefs 落 settings.json', /savePrefs\(\{ updateCheck: mode \}\)/.test(settings))
  check('检查更新按钮用 fetchLatestRelease + pickInstaller 分出口', settings.includes('fetchLatestRelease()') && settings.includes('pickInstaller(result.info.assets'))
  check('挑得出安装器给 kind:update，挑不出才给 kind:url', settings.includes("kind: 'update', version: result.info.version") && settings.includes("kind: 'url'"))

  const contract = read('src/contract.ts')
  check('契约里有 UpdateShareData（kind:update + version）', /interface UpdateShareData \{[\s\S]{0,200}?kind: 'update'/.test(contract))
  check('SettingsMutationOk 的载荷含 UpdateShareData', /data\?: PairShareData \| LinkShareData \| UpdateShareData/.test(contract))

  const bridge = read('src/core/native-bridge.ts')
  check('桥放行 checkUpdate', /'checkUpdate'/.test(bridge) && /checkUpdate: \[\]/.test(bridge))
  check('桥放行 installUpdate', /'installUpdate'/.test(bridge) && /installUpdate: \[\]/.test(bridge))
  check('桥有 update-status 事件', /'update-status'/.test(bridge))
  check('桥有 update-progress 事件', /'update-progress'/.test(bridge))

  const desktop = read('desktop/electron/main/update.ts')
  check('桌面主进程复用 core 的 pickInstaller（不另抄一份挑法）', desktop.includes('pickInstaller'))
  // 开发态 app.getVersion() 读的是 Electron 自己的版本（44.x），比任何真版本都大 → 永远「已最新」。
  // 真机验收第一次就是这么撞上的，所以本地版本必须读自己的 package.json。
  check('本地版本读自己的 package.json（不用 app.getVersion 当主来源）', desktop.includes('function localVersion()') && /join\(__dirname, '\.\.', '\.\.', 'package\.json'\)/.test(desktop))
  check('桌面主进程现读 settings.json 的 updateCheck', desktop.includes("doc['updateCheck']") || desktop.includes('doc.updateCheck'))
  check('下载地址只从自己拉到的资产里挑', desktop.includes('asset.url') && !desktop.includes('installUpdate(url'))
  check('装完启动安装程序并退出应用', desktop.includes('shell.openPath(file)') && desktop.includes('deps?.quit()'))

  const main = read('desktop/electron/main/index.ts')
  check('主进程登记两个原生操作', main.includes('checkUpdate: () => ensureChecked()') && main.includes('installUpdate: () => installNow()'))
  check('主进程上电时排期', /startUpdateChecks\(\{ window: \(\) => mainWindow, quit: quitApp \}\)/.test(main))
  check('退出时停掉定时器', main.includes('stopUpdateChecks()'))
}

rmSync(home, { recursive: true, force: true })

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
