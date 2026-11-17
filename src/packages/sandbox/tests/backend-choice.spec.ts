/**
 * sandbox 的「默认档切换 + 缓存目录白名单」机器自检（2026-11-11）。
 *
 * 两段：
 *   [后端选择] `resolveBackendChoice` 的六条规则（纯函数：平台与「受限令牌可不可用」都由入参给，
 *             不读 process、不装 koffi、不起宿主）；
 *   [缓存目录] `cacheRootCandidates` / `existingCacheRoots`：只留存在的、去重保序、缺环境变量跳过。
 *             存在性由注入的假 exists 判定，不碰真实文件系统。
 *
 * 缓存清单只给 Windows、清单内容也由 `join()` 与显式平台拼出来，所以断言里比路径时先把
 * 分隔符统一成 `/`：旧版用 `\\` 做前缀，Linux 上会因为 join 产出 `\\` 与 `/` 混排而假红。
 * 这是「Windows 专有行为不能写成跨平台期望」那一条的具体落点。
 *
 * @module @pneuma/sandbox/tests/backend-choice
 */
import { join } from 'node:path'
import { expect, test } from 'vitest'
import * as policy from '../policy.js'

/** 一份「什么条件都满足」的入参，每条用例只改需要改的那几项。 */
const ready: policy.BackendChoiceInput = {
  configured: 'policy',
  explicit: false,
  platform: 'win32',
  windowsTokenReady: true,
  mode: 'workspace-write',
}
const choose = (over: Partial<policy.BackendChoiceInput>): policy.BackendChoice =>
  policy.resolveBackendChoice({ ...ready, ...over })

/** 比较路径用：统一小写与分隔符，Windows 专属清单在任意宿主上都能按同一口径比。 */
const key = (path: string): string => path.toLowerCase().replace(/\\/g, '/')

// ── 后端选择：六条规则 ──────────────────────────────────────────────────────

test('rules 1: danger-full-access 永远 policy（哪怕显式选了受限令牌、后端也可用）', () => {
  expect(choose({ mode: 'danger-full-access' })).toEqual({ backend: 'policy' })
  expect(choose({ mode: 'danger-full-access', configured: 'windows-token', explicit: true, windowsTokenReady: true })).toEqual({
    backend: 'policy',
  })
})

test('rules 2: 显式 windows-token + 可用 → windows-token / explicit', () => {
  expect(choose({ configured: 'windows-token', explicit: true })).toEqual({
    backend: 'windows-token',
    reason: 'explicit',
  })
})

test('rules 2: 显式 windows-token + 不可用 → 回落 policy（不带 reason）', () => {
  expect(choose({ configured: 'windows-token', explicit: true, windowsTokenReady: false })).toEqual({
    backend: 'policy',
  })
})

test('rules 3: 默认 policy（未显式）+ win32 + 可用 → 自动启用 / auto', () => {
  expect(choose({ configured: 'policy', explicit: false, platform: 'win32', windowsTokenReady: true })).toEqual({
    backend: 'windows-token',
    reason: 'auto',
  })
})

test('rules 3/4: 默认 policy + 非 win32（哪怕后面传可用）→ policy', () => {
  for (const platform of ['linux', 'darwin', 'aix'] as const) {
    expect(choose({ platform, windowsTokenReady: true }), platform).toEqual({ backend: 'policy' })
  }
})

test('rules 3: 默认 policy + win32 但受限令牌不可用 → policy', () => {
  expect(choose({ windowsTokenReady: false })).toEqual({ backend: 'policy' })
})

test('rules 4: 用户显式选 policy → policy，不自动升（显式值相同、意思不同）', () => {
  expect(choose({ configured: 'policy', explicit: true, platform: 'win32', windowsTokenReady: true })).toEqual({
    backend: 'policy',
  })
})

test('rules 4: docker → policy（容器由 index.ts 自己的分支接）', () => {
  for (const explicit of [true, false]) {
    expect(choose({ configured: 'docker', explicit, windowsTokenReady: true }), String(explicit)).toEqual({
      backend: 'policy',
    })
  }
})

// ── 配置解析：explicitBackend 与 grantCacheRoots ────────────────────────────

test('resolveSandboxConfig：出厂默认 grantCacheRoots 开、explicitBackend 关', () => {
  expect(policy.DEFAULT_SANDBOX_CONFIG.grantCacheRoots).toBe(true)
  const empty = policy.resolveSandboxConfig(undefined)
  expect(empty.explicitBackend).toBe(false)
  expect(empty.config.grantCacheRoots).toBe(true)
  // 没写 backend 键就不算显式选过。
  expect(policy.resolveSandboxConfig({ mode: 'workspace-write' }).explicitBackend).toBe(false)
})

test('resolveSandboxConfig：出现过 backend 键即 explicitBackend=true（值坏掉也算，问题照报）', () => {
  const explicit = policy.resolveSandboxConfig({ backend: 'policy' })
  expect(explicit.explicitBackend).toBe(true)
  expect(explicit.config.backend).toBe('policy')

  const bad = policy.resolveSandboxConfig({ backend: 'nsjail' })
  // 键出现过就是用户表态过，坏值不该被自动档接管。
  expect(bad.explicitBackend).toBe(true)
  expect(bad.config.backend).toBe('policy')
  expect(bad.problems).toHaveLength(1)
})

test('resolveSandboxConfig：grantCacheRoots 只收 boolean，坏值进 problems 并保持默认开', () => {
  expect(policy.resolveSandboxConfig({ grantCacheRoots: false }).config.grantCacheRoots).toBe(false)
  const bad = policy.resolveSandboxConfig({ grantCacheRoots: 'yes' })
  expect(bad.config.grantCacheRoots).toBe(true)
  expect(bad.problems).toHaveLength(1)
  expect(bad.problems[0]).toMatch(/grantCacheRoots|缓存目录/)
})

// ── 缓存目录白名单 ──────────────────────────────────────────────────────────

const localAppData = 'C:\\Users\\me\\AppData\\Local'
const appData = 'C:\\Users\\me\\AppData\\Roaming'
const userProfile = 'C:\\Users\\me'
const baseEnv = { LOCALAPPDATA: localAppData, APPDATA: appData, USERPROFILE: userProfile }

test('cacheRootCandidates：Windows 十一个缓存子目录按清单顺序给出，非 Windows 给空', () => {
  expect(policy.cacheRootCandidates('win32', baseEnv)).toEqual([
    join(localAppData, 'npm-cache'),
    join(localAppData, 'pnpm', 'store'),
    join(userProfile, '.npm', '_cacache'),
    join(userProfile, '.cargo', 'registry', 'cache'),
    join(userProfile, '.cargo', 'registry', 'index'),
    join(userProfile, '.cargo', 'git', 'db'),
    join(localAppData, 'pip', 'Cache'),
    join(localAppData, 'Yarn', 'Cache'),
    join(userProfile, '.cache', 'pip'),
    join(userProfile, '.cache', 'uv'),
    join(userProfile, '.cache', 'pnpm'),
  ])
  expect(policy.cacheRootCandidates('linux', baseEnv)).toEqual([])
  expect(policy.cacheRootCandidates('darwin', baseEnv)).toEqual([])
})

test('cacheRootCandidates：不再整目录放行 ~/.cargo、~/.cache、~/.npm（沙箱外执行点）', () => {
  const list = policy.cacheRootCandidates('win32', baseEnv).map(key)
  // 三个「整目录」都是可执行配置的家：cargo 的 config.toml/bin、npm 的 .npmrc、.cache 里的任意东西。
  for (const banned of [
    join(userProfile, '.cargo'),
    join(userProfile, '.cache'),
    join(userProfile, '.npm'),
    join(appData, 'npm-cache'),
  ]) {
    expect(list.includes(key(banned)), `不该出现整目录 ${banned}`).toBe(false)
  }
  // 收窄不是删掉：每个被收窄的目录都必须还有缓存子目录在里面。
  const inside = (parent: string): boolean => list.some((path) => path.startsWith(`${key(parent)}/`))
  expect(inside(join(userProfile, '.cargo')), '.cargo 还得留三个缓存子目录').toBe(true)
  expect(inside(join(userProfile, '.cache')), '.cache 至少还得留 pip / uv / pnpm').toBe(true)
  expect(inside(join(userProfile, '.npm')), '.npm 至少还得留 _cacache').toBe(true)
})

test('cacheRootCandidates：Cargo 只放行 registry/cache、registry/index、git/db（不放解包后的源码树）', () => {
  const list = policy.cacheRootCandidates('win32', baseEnv).map(key)
  // registry/src 与 git/checkouts 里是解包后的源码，`build.rs` 会在沙箱外的 cargo build 里执行；
  // 放行它们等于给沙箱留了一个「改了就会在沙箱外跑」的执行点。
  for (const banned of [
    join(userProfile, '.cargo', 'registry', 'src'),
    join(userProfile, '.cargo', 'registry'),
    join(userProfile, '.cargo', 'git', 'checkouts'),
    join(userProfile, '.cargo', 'git'),
  ]) {
    expect(list.includes(key(banned)), `不该出现 ${banned}`).toBe(false)
  }
  for (const required of [
    join(userProfile, '.cargo', 'registry', 'cache'),
    join(userProfile, '.cargo', 'registry', 'index'),
    join(userProfile, '.cargo', 'git', 'db'),
  ]) {
    expect(list).toContain(key(required))
  }
})

test('cacheRootCandidates：缺环境变量就跳过（空串也按缺处理）', () => {
  expect(policy.cacheRootCandidates('win32', {})).toEqual([])
  expect(policy.cacheRootCandidates('win32', { USERPROFILE: userProfile })).toEqual([
    join(userProfile, '.npm', '_cacache'),
    join(userProfile, '.cargo', 'registry', 'cache'),
    join(userProfile, '.cargo', 'registry', 'index'),
    join(userProfile, '.cargo', 'git', 'db'),
    join(userProfile, '.cache', 'pip'),
    join(userProfile, '.cache', 'uv'),
    join(userProfile, '.cache', 'pnpm'),
  ])
  expect(policy.cacheRootCandidates('win32', { USERPROFILE: '   ' })).toEqual([])
  // APPDATA 已经不再是来源（Windows 上 npm 缓存默认落在 LOCALAPPDATA）。
  expect(policy.cacheRootCandidates('win32', { APPDATA: appData })).toEqual([])
})

test('existingCacheRoots：只留真的存在的目录', () => {
  const existing = new Set([join(localAppData, 'npm-cache'), join(userProfile, '.cargo', 'registry', 'cache')])
  const asked: string[] = []
  const kept = policy.existingCacheRoots('win32', baseEnv, (path) => {
    asked.push(path)
    return existing.has(path)
  })
  expect(kept).toEqual([join(localAppData, 'npm-cache'), join(userProfile, '.cargo', 'registry', 'cache')])
  // 十一个候选都要问一次存在性，不能偷偷少问。
  expect(asked).toHaveLength(11)
})

test('existingCacheRoots：结果没有重复项（大小写不敏感去重）', () => {
  const kept = policy.existingCacheRoots('win32', baseEnv, () => true)
  expect(kept).toHaveLength(11)
  expect(new Set(kept.map((path) => path.toLowerCase())).size).toBe(kept.length)
})

test('existingCacheRoots：缺环境变量时直接空数组，不调用 exists', () => {
  const kept = policy.existingCacheRoots('win32', {}, () => {
    throw new Error('没有候选就不该问存在性')
  })
  expect(kept).toEqual([])
})
