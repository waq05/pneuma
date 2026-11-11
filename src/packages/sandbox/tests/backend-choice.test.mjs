/** sandbox 的「默认档切换 + 缓存目录白名单」机器自检（2026-11-11）。
 *
 * 两段：
 *   [后端选择] `resolveBackendChoice` 的六条规则（纯函数：平台与「受限令牌可不可用」都由入参给，
 *             不读 process、不装 koffi、不起宿主）；
 *   [缓存目录] `cacheRootCandidates` / `existingCacheRoots`：只留存在的、去重保序、缺环境变量跳过。
 *             存在性由注入的假 exists 判定，不碰真实文件系统。
 *
 * 读 lib/ 产物，先 pnpm run build。单独跑：node src/packages/sandbox/tests/backend-choice.test.mjs
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'

const policy = await import(new URL('../../../../lib/packages/sandbox/policy.js', import.meta.url).href)

let pass = 0
let fail = 0
const check = (label, fn) => {
  try {
    fn()
    pass += 1
    console.log(`PASS  ${label}`)
  } catch (error) {
    fail += 1
    console.log(`FAIL  ${label} → ${error.message}`)
  }
}

/** 一份「什么条件都满足」的入参，每条用例只改需要改的那几项。 */
const ready = {
  configured: 'policy',
  explicit: false,
  platform: 'win32',
  windowsTokenReady: true,
  mode: 'workspace-write',
}
const choose = (over) => policy.resolveBackendChoice({ ...ready, ...over })

// ── 后端选择：六条规则 ──────────────────────────────────────────────────────

check('rules 1: danger-full-access 永远 policy（哪怕显式选了受限令牌、后端也可用）', () => {
  assert.deepEqual(choose({ mode: 'danger-full-access' }), { backend: 'policy' })
  assert.deepEqual(
    choose({ mode: 'danger-full-access', configured: 'windows-token', explicit: true, windowsTokenReady: true }),
    { backend: 'policy' },
  )
})

check('rules 2: 显式 windows-token + 可用 → windows-token / explicit', () => {
  assert.deepEqual(choose({ configured: 'windows-token', explicit: true }), {
    backend: 'windows-token',
    reason: 'explicit',
  })
})

check('rules 2: 显式 windows-token + 不可用 → 回落 policy（不带 reason）', () => {
  assert.deepEqual(choose({ configured: 'windows-token', explicit: true, windowsTokenReady: false }), {
    backend: 'policy',
  })
})

check('rules 3: 默认 policy（未显式）+ win32 + 可用 → 自动启用 / auto', () => {
  assert.deepEqual(choose({ configured: 'policy', explicit: false, platform: 'win32', windowsTokenReady: true }), {
    backend: 'windows-token',
    reason: 'auto',
  })
})

check('rules 3/4: 默认 policy + 非 win32（哪怕后面传可用）→ policy', () => {
  for (const platform of ['linux', 'darwin', 'aix']) {
    assert.deepEqual(choose({ platform, windowsTokenReady: true }), { backend: 'policy' }, platform)
  }
})

check('rules 3: 默认 policy + win32 但受限令牌不可用 → policy', () => {
  assert.deepEqual(choose({ windowsTokenReady: false }), { backend: 'policy' })
})

check('rules 4: 用户显式选 policy → policy，不自动升（显式值相同、意思不同）', () => {
  assert.deepEqual(
    choose({ configured: 'policy', explicit: true, platform: 'win32', windowsTokenReady: true }),
    { backend: 'policy' },
  )
})

check('rules 4: docker → policy（容器由 index.ts 自己的分支接）', () => {
  for (const explicit of [true, false]) {
    assert.deepEqual(choose({ configured: 'docker', explicit, windowsTokenReady: true }), { backend: 'policy' }, String(explicit))
  }
})

// ── 配置解析：explicitBackend 与 grantCacheRoots ────────────────────────────

check('resolveSandboxConfig：出厂默认 grantCacheRoots 开、explicitBackend 关', () => {
  assert.equal(policy.DEFAULT_SANDBOX_CONFIG.grantCacheRoots, true)
  const empty = policy.resolveSandboxConfig(undefined)
  assert.equal(empty.explicitBackend, false)
  assert.equal(empty.config.grantCacheRoots, true)
  const noKey = policy.resolveSandboxConfig({ mode: 'workspace-write' })
  assert.equal(noKey.explicitBackend, false, '没写 backend 键就不算显式选过')
})

check('resolveSandboxConfig：出现过 backend 键即 explicitBackend=true（值坏掉也算，问题照报）', () => {
  const explicit = policy.resolveSandboxConfig({ backend: 'policy' })
  assert.equal(explicit.explicitBackend, true)
  assert.equal(explicit.config.backend, 'policy')

  const bad = policy.resolveSandboxConfig({ backend: 'nsjail' })
  assert.equal(bad.explicitBackend, true, '键出现过就是用户表态过，坏值不该被自动档接管')
  assert.equal(bad.config.backend, 'policy')
  assert.equal(bad.problems.length, 1)
})

check('resolveSandboxConfig：grantCacheRoots 只收 boolean，坏值进 problems 并保持默认开', () => {
  assert.equal(policy.resolveSandboxConfig({ grantCacheRoots: false }).config.grantCacheRoots, false)
  const bad = policy.resolveSandboxConfig({ grantCacheRoots: 'yes' })
  assert.equal(bad.config.grantCacheRoots, true, '坏值回落默认值（开）')
  assert.equal(bad.problems.length, 1)
  assert.match(bad.problems[0], /grantCacheRoots|缓存目录/)
})

// ── 缓存目录白名单 ──────────────────────────────────────────────────────────

const localAppData = 'C:\\Users\\me\\AppData\\Local'
const appData = 'C:\\Users\\me\\AppData\\Roaming'
const userProfile = 'C:\\Users\\me'
const baseEnv = { LOCALAPPDATA: localAppData, APPDATA: appData, USERPROFILE: userProfile }

check('cacheRootCandidates：Windows 八条候选按清单顺序给出，非 Windows 给空', () => {
  assert.deepEqual(policy.cacheRootCandidates('win32', baseEnv), [
    join(localAppData, 'npm-cache'),
    join(localAppData, 'pnpm', 'store'),
    join(appData, 'npm-cache'),
    join(userProfile, '.npm'),
    join(userProfile, '.cargo'),
    join(userProfile, '.cache'),
    join(localAppData, 'pip', 'Cache'),
    join(localAppData, 'Yarn', 'Cache'),
  ])
  assert.deepEqual(policy.cacheRootCandidates('linux', baseEnv), [])
  assert.deepEqual(policy.cacheRootCandidates('darwin', baseEnv), [])
})

check('cacheRootCandidates：缺环境变量就跳过（空串也按缺处理）', () => {
  assert.deepEqual(policy.cacheRootCandidates('win32', {}), [])
  assert.deepEqual(policy.cacheRootCandidates('win32', { USERPROFILE: userProfile }), [
    join(userProfile, '.npm'),
    join(userProfile, '.cargo'),
    join(userProfile, '.cache'),
  ])
  assert.deepEqual(policy.cacheRootCandidates('win32', { USERPROFILE: '   ' }), [])
})

check('existingCacheRoots：只留真的存在的目录', () => {
  const existing = new Set([join(localAppData, 'npm-cache'), join(userProfile, '.cargo')])
  const asked = []
  const kept = policy.existingCacheRoots('win32', baseEnv, (path) => {
    asked.push(path)
    return existing.has(path)
  })
  assert.deepEqual(kept, [join(localAppData, 'npm-cache'), join(userProfile, '.cargo')])
  assert.equal(asked.length, 8, '八个候选都要问一次存在性，不能偷偷少问')
})

check('existingCacheRoots：去重保序（LOCALAPPDATA 与 APPDATA 指到同一处时只留一条）', () => {
  const kept = policy.existingCacheRoots(
    'win32',
    { LOCALAPPDATA: localAppData, APPDATA: localAppData, USERPROFILE: userProfile },
    (path) => path.startsWith(localAppData),
  )
  // 候选顺序：npm-cache、pnpm\store、npm-cache（重复）、pip\Cache、Yarn\Cache……
  // 重复的那条必须落在第一次出现的位置上，不能把后面的提前。
  assert.deepEqual(kept, [
    join(localAppData, 'npm-cache'),
    join(localAppData, 'pnpm', 'store'),
    join(localAppData, 'pip', 'Cache'),
    join(localAppData, 'Yarn', 'Cache'),
  ])
  assert.equal(new Set(kept.map((path) => path.toLowerCase())).size, kept.length, '不许有重复项')
})

check('existingCacheRoots：缺环境变量时直接空数组，不调用 exists', () => {
  const kept = policy.existingCacheRoots('win32', {}, () => {
    throw new Error('没有候选就不该问存在性')
  })
  assert.deepEqual(kept, [])
})

console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
