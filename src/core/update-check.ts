/**
 * 检查更新：从更新源拉最新一版的信息（版本号、发布页、发布资产），与本包版本比较。
 *
 * 更新源是一个返回 JSON 的 GET 地址，认两种回包：
 *   - GitHub Releases API（`…/releases/latest`）：取 `tag_name` / `html_url` / `assets[]`；
 *   - 自托管的简化回包 `{ "version": "0.6.18", "url": "https://…" }`（没有资产，只能打开发布页）。
 *
 * 这一层只做「问 + 比 + 挑」：最新版本、发布页地址、安装器资产。**下载与安装不在这里**
 * ——那要 Electron 主进程（落临时文件、起安装程序、退出应用），走原生桥的 `installUpdate`
 * （见 `desktop/electron/main/update.ts`）。宿主侧只用得上「有没有新版、能不能就地装」。
 *
 * @module dsc/core/update-check
 */
import { APP_USER_AGENT } from './request-attribution.js'
import { DSC_VERSION } from './version.js'

/**
 * 更新源地址：GitHub Releases API（0.6.50 首次对外发布时回填，「检查更新」自此启用）。
 *
 * 为什么写 `muse-code` 而不是新名 `pneuma`：**仓还没改名**——`waq05/pneuma` 现在返 404
 * （2026-10-14 实查：`/repos/waq05/pneuma` 与 `/releases/latest` 都是 404，而
 * `waq05/muse-code` 是 200，最新发布 v0.6.67 挂在那里）。写一个不存在的仓等于「检查更新」
 * 一上线就报 404。**仓库真改名之后把这一行同步改掉**（GitHub 对改过名的仓会 301 重定向，
 * 所以就算漏改也还能用一阵，但不是可以一直不管的理由）。
 *
 * 换自托管时给任意返回 `{version, url}` 的 JSON 地址即可。
 */
export const UPDATE_CHECK_URL = 'https://api.github.com/repos/waq05/muse-code/releases/latest'

/** fetch 的超时：更新源卡住也不能把设置动作挂死。 */
const TIMEOUT_MS = 10_000

/**
 * 按数字段比较两个 x.y.z 版本号（v 前缀容忍，段数不齐补零）。
 *
 * @returns 负 = a 更旧，0 = 相同，正 = a 更新；任一侧解析不出数字段返回 null
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (value: string): number[] | null => {
    const match = /^\s*v?(\d+(?:\.\d+)*)(?:[-+].*)?\s*$/.exec(value)
    if (match === null) return null
    return match[1].split('.').map((piece) => Number(piece))
  }
  const left = parse(a)
  const right = parse(b)
  if (left === null || right === null) return null
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0
    const r = right[index] ?? 0
    if (l !== r) return l - r
  }
  return 0
}

/** 一个发布资产（安装器）。`size` 认不出时给 0（界面按「大小未知」画）。 */
export interface ReleaseAsset {
  name: string
  url: string
  size: number
}

/** 更新源上最新一版的信息。 */
export interface ReleaseInfo {
  /** 源上报的版本号（GitHub 的 tag 带 `v` 前缀，原样保留）。 */
  version: string
  /** 发布页地址；源没给时是空串（那时只能报「有新版」，点不出去）。 */
  pageUrl: string
  /** 发布资产；简化回包里没有这一项，是空数组。 */
  assets: ReleaseAsset[]
}

/** 从回包的 `assets` 里抠出能下载的那几项；形状不对的一律跳过。 */
function parseAssets(value: unknown): ReleaseAsset[] {
  if (!Array.isArray(value)) return []
  const out: ReleaseAsset[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    const name = row['name']
    const url = row['browser_download_url'] ?? row['url']
    if (typeof name !== 'string' || name === '' || typeof url !== 'string' || url === '') continue
    const size = row['size']
    out.push({ name, url, size: typeof size === 'number' && Number.isFinite(size) ? size : 0 })
  }
  return out
}

/** 从回包 JSON 里抠出「最新版本号 + 发布页 + 资产」；认不出返回 null。 */
function parseRelease(body: unknown): ReleaseInfo | null {
  if (typeof body !== 'object' || body === null) return null
  const doc = body as Record<string, unknown>
  const version = doc['tag_name'] ?? doc['version']
  const url = doc['html_url'] ?? doc['url']
  if (typeof version !== 'string' || version === '') return null
  return { version, pageUrl: typeof url === 'string' ? url : '', assets: parseAssets(doc['assets']) }
}

/**
 * 安装器资产名的形状：现行名（`pneuma-setup-<版本>.exe`）与改名前的旧名
 * （`muse-code-setup-<版本>.exe`）都认——发布物里两种都在过，只认新名会让「就地更新」
 * 在老版本发出来的那一天找不到安装器。
 */
const SETUP_NAME = /^(?:pneuma|muse-code)-setup-.*\.exe$/i

/**
 * 从发布资产里挑出安装器。
 *
 * 排序后取第一个，优先级：**现行名 + 精确版本** → 现行名 + 任意版本 → 旧名 + 精确版本 →
 * 旧名 + 任意版本 → 没有就 null。挑不到安装器时调用方退回「打开发布页」。
 *
 * 为什么不挑 portable：portable 是绿色版，就地「更新」它等于换一个 exe，用户原来的安装
 * 目录不会被覆盖；setup 才是安装器。
 *
 * @param assets 发布资产
 * @param version 源上报的版本号（可能带 `v` 前缀，两种写法都试）
 */
export function pickInstaller(assets: readonly ReleaseAsset[], version: string): ReleaseAsset | null {
  const setups = assets.filter((asset) => SETUP_NAME.test(asset.name))
  const bare = version.replace(/^v/i, '').toLowerCase()
  const rank = (asset: ReleaseAsset): number => {
    const name = asset.name.toLowerCase()
    const current = name.startsWith('pneuma-setup-')
    const exact = name === `pneuma-setup-${bare}.exe` || name === `muse-code-setup-${bare}.exe`
    return (current ? 0 : 2) + (exact ? 0 : 1)
  }
  return [...setups].sort((left, right) => rank(left) - rank(right))[0] ?? null
}

/** 一次检查的结果：连不上 / 回包认不出 → `{ ok: false, error }`（错误就是给用户看的那句话）。 */
export type ReleaseLookup = { ok: true; update: boolean; info: ReleaseInfo } | { ok: false; error: string }

/**
 * 拉一次最新版并跟本包版本比。
 *
 * @param current - 本地版本（缺省 {@link DSC_VERSION}）
 * @param sourceUrl - 覆盖 {@link UPDATE_CHECK_URL}（探针/测试缝；缺省先看
 * `DSC_UPDATE_CHECK_URL` 环境变量（命令电池与走查的假更新源走它），再回落常量）
 */
export async function fetchLatestRelease(
  current: string = DSC_VERSION,
  sourceUrl: string = process.env['DSC_UPDATE_CHECK_URL'] ?? UPDATE_CHECK_URL,
): Promise<ReleaseLookup> {
  if (sourceUrl === '') {
    return { ok: false, error: '更新源还没配置：发布后把 Releases 地址填进 src/core/update-check.ts 的 UPDATE_CHECK_URL' }
  }
  let response: Response
  try {
    response = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        accept: 'application/vnd.github+json, application/json',
        // GitHub API 对没有 User-Agent 的请求会返 403——这一条不是礼貌，是能不能问到的前提。
        'user-agent': APP_USER_AGENT,
      },
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `检查失败：连不上更新源（${reason}）` }
  }
  if (!response.ok) {
    return { ok: false, error: `检查失败：更新源返回 ${response.status}（地址没配对或发布页还不存在）` }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, error: '检查失败：更新源回的不是 JSON' }
  }
  const release = parseRelease(body)
  if (release === null) {
    return { ok: false, error: '检查失败：更新源回包里认不出版本号（要 tag_name 或 version 字段）' }
  }
  const comparison = compareVersions(release.version, current)
  if (comparison === null) {
    return { ok: false, error: `检查失败：版本号认不出（源=${release.version}，本地=${current}）` }
  }
  return { ok: true, update: comparison > 0, info: release }
}

/**
 * 跑一次检查，按设置动作回执的口径返回：
 *   - 未配置 / 失败 → `{ ok: false, error }`（错误就是给用户看的那句话）；
 *   - 已是最新 → `{ ok: true, notice }`；
 *   - 有新版 → `{ ok: true, notice, data: { kind: 'url', url } }`，桌面端据此打开发布页。
 *
 * 设置页那颗「检查更新」按钮还想要「能不能就地装」，所以那边直接调
 * {@link fetchLatestRelease} + {@link pickInstaller}，不走这个薄包装。
 */
export async function checkForUpdate(
  current: string = DSC_VERSION,
  sourceUrl: string = process.env['DSC_UPDATE_CHECK_URL'] ?? UPDATE_CHECK_URL,
): Promise<{ ok: true; notice: string; data?: { kind: 'url'; url: string } } | { ok: false; error: string }> {
  const result = await fetchLatestRelease(current, sourceUrl)
  if (!result.ok) return result
  if (!result.update) return { ok: true, notice: `已是最新（${current}）` }
  return {
    ok: true,
    notice: `发现新版 ${result.info.version}（当前 ${current}）`,
    data: result.info.pageUrl === '' ? undefined : { kind: 'url', url: result.info.pageUrl },
  }
}
