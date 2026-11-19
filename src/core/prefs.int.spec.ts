/**
 * 用户偏好（settings.json）的 remote 段：合法值 / 非法值回落或夹取 / 未知键不搬进来 / writePrefs 深合并
 * （迁自 `scripts/remote-host-test.mjs` 第 1 节）。
 *
 * ## 被测的是什么
 *
 * `readPrefs()` 把存档里 `remote` 段洗成可信值的规矩：
 *   - 没有文件 = 出厂默认（关着 + 17321 + 只绑本机 + push 关 + webhook 空）；
 *   - 类型不对不认（布尔才认布尔，非数字端口回落默认）；
 *   - 端口用**夹取**（80 → 1024，70000 → 65535），webhook 用**回落**（非 http(s) 一律空串 = 关）；
 *   - 未知键（remote 里的与顶层的）不往偏好里搬，写盘时还会被清掉（写的是校验过的那份）；
 *   - writePrefs 对 `remote` 深合并：只改端口不会把 enabled/lan 抹掉。
 *
 * ## 平面与隔离
 *
 * `prefs.ts` 的 `DSC_SETTINGS_JSON` 是模块顶层常量（`dscPath('settings.json')` =
 * `DSC_HOME/settings.json`，而 `DSC_HOME` 由 `process.env.DSC_HOME ?? homedir()/.dsc`
 * 在模块加载那一刻算定）。所以内核侧模块必须在 `tempHome()` 换好 HOME 之后动态
 * `import`（beforeAll 里），静态 import 会被提升到前面，按真实主目录算死路径。
 * 环境里若带 `DSC_HOME`（有人为多工作区并设过）也会把路径指去真实目录，一并删掉。
 *
 * @module dsc/core/prefs.int.spec
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../tests/harness.js'

/** 临时主目录：必须在任何内核模块被加载之前换好（理由见文件头）。 */
const home = tempHome('dsc-prefs-remote-')

// path-policy 的 DSC_HOME 优先读这个环境变量；继承到真实目录会把隔离整个击穿。
delete process.env['DSC_HOME']

afterAll(() => {
  home.restore()
})

type PrefsModule = typeof import('@pneuma/runtime/core/prefs.js')
let prefs: PrefsModule
let REMOTE_PORT_DEFAULT: number
let REMOTE_PORT_MIN: number
let REMOTE_PORT_MAX: number

beforeAll(async () => {
  prefs = await import('@pneuma/runtime/core/prefs.js')
  REMOTE_PORT_DEFAULT = prefs.REMOTE_PORT_DEFAULT
  REMOTE_PORT_MIN = prefs.REMOTE_PORT_MIN
  REMOTE_PORT_MAX = prefs.REMOTE_PORT_MAX
})

/** settings.json 的位置：tempHome 的 home 下的 `.dsc/settings.json`，与 DSC_SETTINGS_JSON 同址。 */
const settingsFile = join(home.home, '.dsc', 'settings.json')
const writeSettings = (doc: Record<string, unknown>): void => {
  // 探针开场就把 `.dsc` 建好；这里每次写之前确保目录在（临时 HOME 是空的）。
  mkdirSync(join(home.home, '.dsc'), { recursive: true })
  writeFileSync(settingsFile, `${JSON.stringify(doc)}\n`, 'utf8')
}

describe('偏好（settings.json 的 remote 段）', () => {
  test('没有 settings.json 时 remote 是「关着 + 默认端口 17321 + 只绑本机」', () => {
    rmSync(settingsFile, { force: true })
    const remote = prefs.readPrefs().remote
    expect({ enabled: remote.enabled, port: remote.port, lan: remote.lan }).toEqual({
      enabled: false,
      port: REMOTE_PORT_DEFAULT,
      lan: false,
    })
  })

  test('合法值原样读出来', () => {
    writeSettings({ remote: { enabled: true, port: 20000, lan: true } })
    const remote = prefs.readPrefs().remote
    expect({ enabled: remote.enabled, port: remote.port, lan: remote.lan }).toEqual({
      enabled: true,
      port: 20000,
      lan: true,
    })
  })

  test('非法类型回落默认（不是布尔/数字一律不认）', () => {
    writeSettings({ remote: { enabled: 'yes', port: '不是数字', lan: 1 } })
    const remote = prefs.readPrefs().remote
    expect({ enabled: remote.enabled, port: remote.port, lan: remote.lan }).toEqual({
      enabled: false,
      port: REMOTE_PORT_DEFAULT,
      lan: false,
    })
  })

  // 标题里的 1024 / 65535 是收集期写死的渲染值（REMOTE_PORT_MIN / REMOTE_PORT_MAX），
  // 断言体里仍用常量比对——test 回调执行时 beforeAll 已经把常量拿到了。
  test('端口 80 夹到下限 1024', () => {
    writeSettings({ remote: { port: 80 } })
    expect(prefs.readPrefs().remote.port).toBe(REMOTE_PORT_MIN)
  })

  test('端口 70000 夹到上限 65535', () => {
    writeSettings({ remote: { port: 70000 } })
    expect(prefs.readPrefs().remote.port).toBe(REMOTE_PORT_MAX)
  })

  test('remote 里的未知键不搬进偏好，认识的键照读', () => {
    writeSettings({ remote: { unknownKey: '不认识', port: 18000 } })
    expect('unknownKey' in prefs.readPrefs().remote).toBe(false)
    expect(prefs.readPrefs().remote.port).toBe(18000)
  })

  test('顶层未知键也不进偏好', () => {
    writeSettings({ remote: { unknownKey: '不认识', port: 18000 }, weird: 'x' })
    expect('weird' in prefs.readPrefs()).toBe(false)
  })

  test('writePrefs 深合并 remote：只改端口不会把开关与 lan 抹掉', () => {
    // 探针只传三个键（JS 不查必填）：TS 下按 RemotePrefs 断言，缺的 push / notifyWebhook
    // 由 writePrefs 的深合并用 current 补齐，运行时行为与探针一致。
    prefs.writePrefs({ remote: { enabled: true, port: 19000, lan: true } as import('@pneuma/runtime/core/prefs.js').RemotePrefs })
    prefs.writePrefs({ remote: { ...prefs.readPrefs().remote, port: 19001 } })
    const remote = prefs.readPrefs().remote
    expect({ port: remote.port, enabled: remote.enabled, lan: remote.lan }).toEqual({
      port: 19001,
      enabled: true,
      lan: true,
    })
  })

  test('写盘会把 remote 里的未知键清掉（写的是校验过的那份）', () => {
    writeSettings({ remote: { enabled: true, port: 19002, lan: false, unknownKey: 'x' } })
    prefs.writePrefs({ remote: { ...prefs.readPrefs().remote, lan: true } })
    expect(readFileSync(settingsFile, 'utf8').includes('unknownKey')).toBe(false)
  })

  test('没有 settings.json 时 push 是关的、notifyWebhook 是空串', () => {
    rmSync(settingsFile, { force: true })
    const remote = prefs.readPrefs().remote
    expect(remote.push).toBe(false)
    expect(remote.notifyWebhook).toBe('')
  })

  test('合法的 push 与带占位符的 http(s) 地址原样读出来（地址两端空白被去掉）', () => {
    writeSettings({ remote: { push: true, notifyWebhook: '  https://api.day.app/KEY/{title}/{body}?url={url}  ' } })
    const remote = prefs.readPrefs().remote
    expect(remote.push).toBe(true)
    expect(remote.notifyWebhook).toBe('https://api.day.app/KEY/{title}/{body}?url={url}')
  })

  test('push 只认真正的布尔（"yes" 不算开），没占位符的 https 地址照收', () => {
    writeSettings({ remote: { push: 'yes', notifyWebhook: 'https://ntfy.sh/我的主题' } })
    const remote = prefs.readPrefs().remote
    expect(remote.push).toBe(false)
    expect(remote.notifyWebhook).toBe('https://ntfy.sh/我的主题')
  })

  for (const bad of ['javascript:alert(1)', 'ftp://example.com/hook', 'example.com/hook', '   ', 42, null, {}]) {
    test(`非法的 notifyWebhook（${JSON.stringify(bad)}）回落空串 = 关掉`, () => {
      writeSettings({ remote: { notifyWebhook: bad } })
      expect(prefs.readPrefs().remote.notifyWebhook).toBe('')
    })
  }
})
