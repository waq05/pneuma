/**
 * sandbox 包级测试：policy.ts 的判定（默认值、白名单、档位拒写、受保护名、只读子路径）、
 * 包的装配形状，以及并进来的改动前预览（review.ts 的配置夹取与路径显示）。
 *
 * 路径判定改成表驱动：一组「档位 + 目标」对一组「放不放行 + 命中哪条规则 + 理由关键词」，
 * 这比逐条写死一个返回值清楚——拒的理由（rule）就是给模型看的那句话的依据，写错等于让人猜。
 * 平台口径显式传 `win32`，不让断言跟着宿主平台变。
 *
 * @module @pneuma/sandbox/tests
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { sandboxPlugin } from '../index.js'
import * as policy from '../policy.js'
import * as review from '../review.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const repo = fileURLToPath(new URL('../../../..', import.meta.url))
const win32 = process.platform === 'win32'
/** 仓库外的一个真实目录：用来验「根外拒写」，不碰 os.tmpdir 的临时文件。 */
let outside: string

beforeAll(() => {
  outside = mkdtempSync(join(tmpdir(), 'dsc-sandbox-outside-'))
})

afterAll(() => {
  rmSync(outside, { recursive: true, force: true })
})

const base: policy.PolicyInput = {
  mode: 'workspace-write',
  cwd: repo,
  tmpDir: join(repo, '.tmp'),
  dscHome: join(repo, '.dsc'),
  extraWritableRoots: [],
  readOnlySubpaths: [],
  networkAccess: false,
  win32,
}

test('默认配置 workspace-write、网络关；坏档位回落并记一条问题', () => {
  const { config } = policy.resolveSandboxConfig(undefined)
  expect([config.mode, config.networkAccess]).toEqual(['workspace-write', false])
  const bad = policy.resolveSandboxConfig({ mode: 'yolo' })
  expect(bad.config.mode).toBe('workspace-write')
  expect(bad.problems).toHaveLength(1)
})

test('白名单：精确域不放行子域，通配只放一层；条目归一后路径与中文域不收', () => {
  const cases = [
    { host: 'api.example.com', list: ['example.com'], allowed: false },
    { host: 'api.example.com', list: ['*.example.com'], allowed: true },
    { host: 'a.b.example.com', list: ['*.example.com'], allowed: false },
    { host: 'example.com', list: ['example.com'], allowed: true },
    { host: 'Example.COM.', list: ['example.com'], allowed: true },
  ] as const
  for (const one of cases) expect(policy.allowlistMatches(one.host, one.list), one.host).toBe(one.allowed)

  expect(policy.normalizeAllowlistEntry(' Example.COM. ')).toEqual({ ok: true, domain: 'example.com' })
  const rejects = ['https://x/y', '中文.中国', '', '*x.example.com'].map((raw) => policy.normalizeAllowlistEntry(raw).ok)
  expect(rejects).toEqual([false, false, false, false])
})

test('档位判定：只读档拒一切写，可写档放行根内、拒根外/受保护名/只读子路径', () => {
  const inside = policy.createPolicy({ ...base, mode: 'workspace-write' })
  const readOnly = policy.createPolicy({ ...base, mode: 'read-only' })
  const withReadonlySub = policy.createPolicy({ ...base, mode: 'workspace-write', readOnlySubpaths: [join(repo, 'src')] })
  const full = policy.createPolicy({ ...base, mode: 'danger-full-access' })

  const cases = [
    { name: '只读档写工作区文件', check: policy.checkWrite(readOnly, join(repo, 'package.json')), rule: 'mode-read-only' },
    { name: '可写档写工作区文件', check: policy.checkWrite(inside, join(repo, 'package.json')), rule: 'allowed' },
    { name: '可写档写根外', check: policy.checkWrite(inside, join(outside, 'outside.txt')), rule: 'outside-writable-roots' },
    { name: '可写档写 .env', check: policy.checkWrite(inside, join(repo, '.env')), rule: 'protected-metadata' },
    { name: '可写档写只读子路径', check: policy.checkWrite(withReadonlySub, join(repo, 'src', 'a.ts')), rule: 'read-only-subpath' },
    { name: '完全访问写工作区文件', check: policy.checkWrite(full, join(repo, 'package.json')), rule: 'allowed' },
  ] as const
  for (const one of cases) {
    expect(one.check.allowed, one.name).toBe(one.rule === 'allowed')
    expect(one.check.rule, one.name).toBe(one.rule)
    // 被拒时理由必须是非空中文：它就是回给模型的那句话。
    if (!one.check.allowed) expect(one.check.reason.length, one.name).toBeGreaterThan(0)
  }
})

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/sandbox', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toMatch(/^\s*-\s*id: sandbox\s*$/m)
  expect(patch).toContain("name: '@pneuma/sandbox'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  const pkg = JSON.parse(read('../package.json')) as {
    name: string
    type: string
    exports: Record<string, { default?: string } | string>
    pneuma: { bundle?: { patch?: string }; library?: boolean }
  }
  expect(pkg.name).toBe('@pneuma/sandbox')
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.']).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  expect(pkg.pneuma.bundle?.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma.library).not.toBe(true)
})

// 入口真能加载：直接 import 源码入口并检查插件对象的三件事。
test('入口能加载，插件名与 apply 对得上', () => {
  const pkg = JSON.parse(read('../package.json')) as { name: string }
  expect(typeof sandboxPlugin).toBe('object')
  expect(typeof sandboxPlugin.name).toBe('string')
  // 插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
  expect(sandboxPlugin.name).toBe(pkg.name.slice('@pneuma/'.length))
  expect(sandboxPlugin.name).toBe('sandbox')
  expect(typeof sandboxPlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

// 改动前预览（原 @pneuma/file-review）并进来时搬的配置断言。
test('配置解析：缺省值正确，越界夹到区间内', () => {
  expect(review.parseReviewConfig({})).toEqual({ enabled: true, maxLines: 120, contextLines: 3 })
  expect(review.parseReviewConfig({ maxLines: 99999 }).maxLines).toBe(review.REVIEW_RANGES.maxLines.max)
  expect(review.parseReviewConfig({ maxLines: 1 }).maxLines).toBe(review.REVIEW_RANGES.maxLines.min)
  expect(review.parseReviewConfig({ contextLines: -5 }).contextLines).toBe(0)
  expect(review.parseReviewConfig({ enabled: false }).enabled).toBe(false)
})

test('路径显示：工作目录内写相对路径，目录外保留绝对路径', () => {
  expect(review.displayPathOf('/w', '/w/src/a.ts')).toBe('src/a.ts')
  expect(review.displayPathOf('/w', '/other/a.ts')).toBe('/other/a.ts')
  // 工作目录就是目标本身时不算「外面」，仍按相对路径给（空串会被 relative 折成空）。
  expect(review.displayPathOf('/w', '/w')).toBe('/w')
})
