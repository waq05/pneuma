/**
 * 检查更新的单元测试（迁自 `scripts/update-check-test.mjs` 的 [1]–[5]）。
 *
 * ## 为什么这层要钉
 *
 * 「检查更新」是唯一一条会主动外连的功能，写错了不会崩，只会安静地不工作：仓名写错就是
 * 永久 404、版本比较退回字典序就是「0.6.9 > 0.6.10」、挑安装器挑到 portable 就是用户点
 * 了更新却什么都没换。所以分四段：版本比较边界、安装器挑选规则、真请求的形状与三种回包、
 * 偏好读档归一。
 *
 * ## 为什么不搬 [6]
 *
 * 原探针最后一段读 `settings/index.ts`、`contract.ts`、`native-bridge.ts`、
 * `desktop/electron/main/update.ts`、`main/index.ts` 的**源码字符串**（24 条）。按本批
 * 规矩源码文本断言一律不搬：改个缩进就红、留个字符串就绿。它要保的接线（按钮走
 * `fetchLatestRelease` + `pickInstaller`、桥放行两个原生操作、桌面主进程排期）没有行为
 * 接缝——要验只能起 Electron 真机，那是桌面层的事，不在这一层。删除清单见交付报告。
 *
 * ## 迁移差异
 *
 * - 桩 `globalThis.fetch` 的写法保留：这是被观测对象真实的出网口，比把 fetch 抽成依赖更
 *   接近现场（探针原话：看**真请求**的 URL / user-agent / accept）。
 * - 断言从 `check()` 换成 `test()` + `expect`；成功/失败两种返回用 `expectOk` / `expectError`
 *   收口，失败时给的是原探针那句人话错误，不是 `undefined`。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../tests/harness.js'

/** 临时主目录：`prefs` 的读写路径在 import 期由 `dscPath` 算定。 */
const home = tempHome('dsc-update-check-spec-')
/** `.dsc` 目录：偏好文件的落点。 */
const dscHome = process.env.DSC_HOME ?? join(home.home, '.dsc')
mkdirSync(dscHome, { recursive: true })

type UpdateModule = typeof import('./update-check.js')
type PrefsModule = typeof import('./prefs.js')
type ReleaseLookup = Awaited<ReturnType<UpdateModule['fetchLatestRelease']>>
type ReleaseInfo = Extract<ReleaseLookup, { ok: true }>['info']

let update: UpdateModule
let prefs: PrefsModule

/** 一次假的 fetch 调用记录。 */
interface FetchCall {
  url: string
  headers: Record<string, string>
  signal: AbortSignal | undefined
}

/**
 * 桩掉 `globalThis.fetch`：记下每次请求的 URL / 头 / 信号，按给定回包作答。
 *
 * 还原放在 `finally` 里，任何一条断言红了也不会让后面的用例看到一个假 fetch。
 */
function stubFetch(handler: (url: string) => unknown): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((url: unknown, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
    calls.push({ url: String(url), headers: init?.headers ?? {}, signal: init?.signal })
    return Promise.resolve(handler(String(url)))
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

/** 造一个 GitHub Releases 形状的回包。 */
const githubRelease = (tag: string, assets: unknown[] = []): unknown => ({
  tag_name: tag,
  html_url: `https://github.com/waq05/pneuma/releases/tag/${tag}`,
  assets,
})

/** 造一个 fetch 认的 Response 形状（只实现被测代码用到的那三项）。 */
const jsonResponse = (body: unknown, status = 200): unknown => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
})

/** 成功结果收口：失败时把原文那句人话抛出来，而不是让后续断言在 undefined 上红。 */
function expectOk(result: ReleaseLookup): { update: boolean; info: ReleaseInfo } {
  if (!result.ok) throw new Error(`期望检查成功，实际失败：${result.error}`)
  return result
}

/** 失败结果收口：给了成功反而说明「该红的地方绿了」，直接抛。 */
function expectError(result: ReleaseLookup): string {
  if (result.ok) throw new Error('期望检查失败，实际成功')
  return result.error
}

beforeAll(async () => {
  update = await import('./update-check.js')
  prefs = await import('./prefs.js')
})

afterAll(() => {
  home.restore()
})

describe('① compareVersions：v 前缀 / 段数不齐 / 坏值', () => {
  test('0.6.9 < 0.6.10（按数字段比，不是字典序）', () => {
    expect(update.compareVersions('0.6.9', '0.6.10')).toBeLessThan(0)
  })

  test('v 前缀容忍', () => {
    expect(update.compareVersions('v0.7.0', '0.6.67')).toBeGreaterThan(0)
  })

  test('段数不齐补零：0.6 == 0.6.0', () => {
    expect(update.compareVersions('0.6', '0.6.0')).toBe(0)
  })

  test('预发布后缀不影响数字段：0.7.0-rc.1 > 0.6.67', () => {
    expect(update.compareVersions('0.7.0-rc.1', '0.6.67')).toBeGreaterThan(0)
  })

  test('相同版本给 0', () => {
    expect(update.compareVersions('0.6.67', '0.6.67')).toBe(0)
  })

  test('认不出的版本号给 null（不编一个结论）', () => {
    expect(update.compareVersions('latest', '0.6.67')).toBeNull()
    expect(update.compareVersions('0.6.67', '')).toBeNull()
  })
})

describe('② pickInstaller：挑安装器', () => {
  /** 造一条资产（size 固定，避免夹具噪声）。 */
  const setup = (name: string): { name: string; url: string; size: number } => ({
    name,
    url: `https://example.test/${name}`,
    size: 100,
  })

  test('精确版本优先', () => {
    const exact = [setup('pneuma-setup-0.6.68.exe'), setup('pneuma-portable-0.6.68.exe')]
    expect(update.pickInstaller(exact, 'v0.6.68')?.name).toBe('pneuma-setup-0.6.68.exe')
  })

  test('tag 带 v、资产名不带 v 也认得出', () => {
    const exact = [setup('pneuma-setup-0.6.68.exe')]
    expect(update.pickInstaller(exact, '0.6.68')?.name).toBe('pneuma-setup-0.6.68.exe')
  })

  test('版本对不上时退而取任意 setup（发布名改了也能装）', () => {
    expect(update.pickInstaller([setup('pneuma-setup-0.6.60.exe')], 'v0.6.68')?.name).toBe('pneuma-setup-0.6.60.exe')
  })

  test('portable 不挑（就地更新要的是安装器）', () => {
    expect(update.pickInstaller([setup('pneuma-portable-0.6.68.exe')], 'v0.6.68')).toBeNull()
  })

  test('没有 setup 就给 null（调用方退回打开发布页）', () => {
    expect(update.pickInstaller([], 'v0.6.68')).toBeNull()
  })

  test('改名前的旧名也认（否则老版本那天就地更新找不到安装器）', () => {
    expect(update.pickInstaller([setup('muse-code-setup-0.6.67.exe')], 'v0.6.67')?.name).toBe('muse-code-setup-0.6.67.exe')
  })

  test('两种名字都在时现行名优先', () => {
    const both = [setup('muse-code-setup-0.6.68.exe'), setup('pneuma-setup-0.6.68.exe')]
    expect(update.pickInstaller(both, 'v0.6.68')?.name).toBe('pneuma-setup-0.6.68.exe')
  })

  test('别的产品的安装器不认（不误挑）', () => {
    expect(update.pickInstaller([setup('other-app-setup-1.0.0.exe')], 'v0.6.68')).toBeNull()
  })
})

describe('③ fetchLatestRelease：真请求的形状 + 三种回包', () => {
  /** 一次 GitHub 形状的回包素材：一条安装器、一条缺 size 的杂项。 */
  const assets = [
    { name: 'pneuma-setup-0.6.68.exe', browser_download_url: 'https://example.test/setup.exe', size: 123 },
    { name: 'notes.txt', browser_download_url: 'https://example.test/notes.txt' },
  ]

  test('请求带 user-agent（GitHub API 缺它会返 403）、accept 与超时信号', async () => {
    const stub = stubFetch(() => jsonResponse(githubRelease('v0.6.68', assets)))
    try {
      await update.fetchLatestRelease('0.6.67', 'https://api.github.com/repos/waq05/pneuma/releases/latest')
      expect(String(stub.calls[0]?.headers['user-agent'] ?? '')).toMatch(/^pneuma\//)
      expect(String(stub.calls[0]?.headers.accept ?? '')).toContain('application/vnd.github+json')
      expect(stub.calls[0]?.signal).toBeDefined()
    } finally {
      stub.restore()
    }
  })

  test('有新版：update 为真，版本号原样带回（含 v 前缀）', async () => {
    const stub = stubFetch(() => jsonResponse(githubRelease('v0.6.68', assets)))
    try {
      const result = expectOk(await update.fetchLatestRelease('0.6.67', 'https://x.test'))
      expect(result.update).toBe(true)
      expect(result.info.version).toBe('v0.6.68')
    } finally {
      stub.restore()
    }
  })

  test('发布页带回，资产解析出下载地址', async () => {
    const stub = stubFetch(() => jsonResponse(githubRelease('v0.6.68', assets)))
    try {
      const { info } = expectOk(await update.fetchLatestRelease('0.6.67', 'https://x.test'))
      expect(info.pageUrl).toBe('https://github.com/waq05/pneuma/releases/tag/v0.6.68')
      expect(info.assets[0]?.url).toBe('https://example.test/setup.exe')
    } finally {
      stub.restore()
    }
  })

  test('资产缺 size 时给 0（不编数）', async () => {
    const stub = stubFetch(() => jsonResponse(githubRelease('v0.6.68', assets)))
    try {
      const { info } = expectOk(await update.fetchLatestRelease('0.6.67', 'https://x.test'))
      expect(info.assets[1]?.size).toBe(0)
    } finally {
      stub.restore()
    }
  })

  test('同版本 / 源比本地旧：update 都为假（不提示降级）', async () => {
    const same = stubFetch(() => jsonResponse(githubRelease('v0.6.67')))
    try {
      expect(expectOk(await update.fetchLatestRelease('0.6.67', 'https://x.test')).update).toBe(false)
    } finally {
      same.restore()
    }
    const older = stubFetch(() => jsonResponse(githubRelease('v0.6.10')))
    try {
      expect(expectOk(await update.fetchLatestRelease('0.6.67', 'https://x.test')).update).toBe(false)
    } finally {
      older.restore()
    }
  })

  test('自托管形状也认（{version, url}），没有 assets 时给空数组', async () => {
    const stub = stubFetch(() => jsonResponse({ version: '0.7.0', url: 'https://example.test/dl' }))
    try {
      const { info } = expectOk(await update.fetchLatestRelease('0.6.67', 'https://example.test/latest.json'))
      expect(info.version).toBe('0.7.0')
      expect(info.assets).toEqual([])
    } finally {
      stub.restore()
    }
  })

  test('认不出版本号：ok 为假且带一句人话', async () => {
    const stub = stubFetch(() => jsonResponse({ nope: 1 }))
    try {
      expect(expectError(await update.fetchLatestRelease('0.6.67', 'https://x.test'))).toContain('认不出版本号')
    } finally {
      stub.restore()
    }
  })

  test('非 2xx：报出状态码', async () => {
    const stub = stubFetch(() => jsonResponse({}, 500))
    try {
      expect(expectError(await update.fetchLatestRelease('0.6.67', 'https://x.test'))).toContain('500')
    } finally {
      stub.restore()
    }
  })

  test('连不上：如实说是连不上', async () => {
    const stub = stubFetch(() => {
      throw new Error('connect ECONNREFUSED')
    })
    try {
      expect(expectError(await update.fetchLatestRelease('0.6.67', 'https://x.test'))).toContain('连不上')
    } finally {
      stub.restore()
    }
  })

  test('更新源常量指向 Releases API，且仓名是本项目用过的名字', () => {
    expect(update.UPDATE_CHECK_URL).toMatch(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/latest$/)
    // 仓名写一个不存在的，「检查更新」一上线就报 404（2026-10-14 就是这么发现的）。
    expect(update.UPDATE_CHECK_URL).toMatch(/\/(?:pneuma|muse-code)\/releases\/latest$/)
  })
})

describe('④ checkForUpdate：薄包装的 notice / data 口径', () => {
  test('有新版：notice 说清两边版本，data 给发布页', async () => {
    const stub = stubFetch(() => jsonResponse(githubRelease('v0.6.68')))
    try {
      const found = await update.checkForUpdate('0.6.67', 'https://x.test')
      if (!found.ok) throw new Error(`期望成功：${found.error}`)
      expect(found.notice).toContain('0.6.68')
      expect(found.notice).toContain('0.6.67')
      expect(found.data?.kind).toBe('url')
      expect(found.data?.url).toContain('releases/tag')
    } finally {
      stub.restore()
    }
  })

  test('已最新：不给 data（界面不该开浏览器）', async () => {
    const stub = stubFetch(() => jsonResponse(githubRelease('v0.6.67')))
    try {
      const latest = await update.checkForUpdate('0.6.67', 'https://x.test')
      if (!latest.ok) throw new Error(`期望成功：${latest.error}`)
      expect(latest.data).toBeUndefined()
    } finally {
      stub.restore()
    }
  })

  test('有新版但源没给地址：data 缺省（而不是给个空串）', async () => {
    const stub = stubFetch(() => jsonResponse({ version: '0.7.0' }))
    try {
      const noPage = await update.checkForUpdate('0.6.67', 'https://x.test')
      if (!noPage.ok) throw new Error(`期望成功：${noPage.error}`)
      expect(noPage.data).toBeUndefined()
    } finally {
      stub.restore()
    }
  })
})

describe('⑤ 偏好：updateCheck 的读档归一', () => {
  /** 偏好文件路径（`prefs` 模块自己算的那个）。 */
  const file = join(dscHome, 'settings.json')

  test('三档表就是 launch / daily / off', () => {
    expect([...prefs.UPDATE_CHECK_MODES]).toEqual(['launch', 'daily', 'off'])
  })

  test('没有 settings.json 时默认每次启动', () => {
    expect(prefs.readPrefs().updateCheck).toBe('launch')
  })

  test('显式写了哪一档就读哪一档', () => {
    for (const value of ['off', 'daily', 'launch']) {
      writeFileSync(file, JSON.stringify({ updateCheck: value }))
      expect(prefs.readPrefs().updateCheck).toBe(value)
    }
  })

  test('认不出的档位回落每次启动（不静默变成不检查）', () => {
    writeFileSync(file, JSON.stringify({ updateCheck: 'every-hour' }))
    expect(prefs.readPrefs().updateCheck).toBe('launch')
  })

  test('类型不对也回落每次启动', () => {
    writeFileSync(file, JSON.stringify({ updateCheck: 7 }))
    expect(prefs.readPrefs().updateCheck).toBe('launch')
  })

  test('writePrefs 能落盘（设置页改档位走它）', () => {
    prefs.writePrefs({ updateCheck: 'daily' })
    expect((JSON.parse(readFileSync(file, 'utf8')) as { updateCheck?: string }).updateCheck).toBe('daily')
  })
})
