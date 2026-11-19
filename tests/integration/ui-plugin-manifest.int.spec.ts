/**
 * 启动清单与 bundle 发现的运行期行为（迁自 `scripts/ui-plugin-test.mjs` 的 [2][3][3b] 三段）。
 *
 * ## 被测的是什么
 *
 * - `@pneuma/runtime/core/ui-manifest`：地址形状（`pluginBundleUrl`）、短哈希（`shortHash`）、
 *   文件指纹（`artifactRev`）、拓扑排序（`orderUiPlugins`：成环 / 自指 / 重复 id 报错、
 *   `external` 指向本图另一条插件也是排序边）、整图（`composeUiBootGraph`：宿主身份、
 *   rev 对声明类变更敏感）。
 * - `@pneuma/runtime/core/ui-bundles`：清单读写（非法 id / 坏文件按空、缺文件进 problems、
 *   2.0 的目录自述 `bundle.json`、旧产物兜底）、路径守卫（`inside`）、bundle 取用、
 *   组合包的 `pneuma.client.external` 声明（`discoverPackageUiArtifacts`）。
 * - `@pneuma/runtime/core/ui-route` + `web-static`：`/plugins/` 路由的识别、内容寻址、
 *   方法（GET/HEAD/405）与穿越拒收——本机界面服务与远程控制共用这一份。
 *
 * ## 落位与隔离
 *
 * 夹具全部落在 `mkdtempSync` 的临时目录里，真实 `~/.dsc` 与 `lib/ui` 一个字节都不写。
 * `readUiPluginManifest` / `collectUiPluginArtifacts` 显式传夹具目录，不读默认产物位置。
 *
 * @module dsc/tests/integration/ui-plugin-manifest
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  artifactRev,
  composeUiBootGraph,
  orderUiPlugins,
  pluginBundleUrl,
  shortHash,
  type UiPluginRow,
} from '@pneuma/runtime/core/ui-manifest.js'
import {
  collectUiPluginArtifacts,
  discoverPackageUiArtifacts,
  readUiPluginBundle,
  readUiPluginManifest,
} from '@pneuma/runtime/core/ui-bundles.js'
import { inside } from '@pneuma/runtime/core/web-static.js'
import { isUiBundleRequest, resolveUiBundleRequest } from '@pneuma/runtime/core/ui-route.js'

/** 夹具总目录；失败现场留着翻，成功时 afterAll 删。 */
const WORK = mkdtempSync(join(tmpdir(), 'dsc-ui-manifest-'))

afterAll(() => {
  try {
    rmSync(WORK, { recursive: true, force: true })
  } catch {
    // 删不掉不影响结论：临时目录会被系统清。
  }
})

/** 造一个临时目录树；`files` 是相对路径 → 内容。 */
function makeTree(name: string, files: Record<string, string>): string {
  const dir = join(WORK, name)
  mkdirSync(dir, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const target = join(dir, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, body)
  }
  return dir
}

// ── [2] 启动清单 ──────────────────────────────────────────────────────────────
describe('启动清单：地址、短哈希、文件指纹', () => {
  test('地址形状正确', () => {
    expect(pluginBundleUrl('hello', 'abc')).toBe('plugins/hello/client.js?rev=abc')
  })
  test('id 会被编码', () => {
    expect(pluginBundleUrl('a b', 'abc')).toBe('plugins/a%20b/client.js?rev=abc')
  })
  test('短哈希 12 位', () => {
    expect(shortHash('x')).toHaveLength(12)
  })
  test('短哈希稳定', () => {
    expect(shortHash('a', 'b')).toBe(shortHash('a', 'b'))
  })
  test('短哈希随输入变化', () => {
    expect(shortHash('a', 'b')).not.toBe(shortHash('ab', ''))
  })

  const stat = { mtimeMs: 1000, ctimeMs: 2000, size: 30 }
  test('文件指纹稳定', () => {
    expect(artifactRev(stat)).toBe(artifactRev({ ...stat }))
  })
  test('大小变了版本就变', () => {
    expect(artifactRev(stat)).not.toBe(artifactRev({ ...stat, size: 31 }))
  })
  test('指纹取毫秒原值（同毫秒不同小数能分开，避免复查拿旧字节）', () => {
    expect(artifactRev({ ...stat, mtimeMs: 1000.5 })).not.toBe(artifactRev({ ...stat, mtimeMs: 1000.9 }))
  })
  test('可换摘要函数（宿主侧传 sha256 那份）', () => {
    expect(artifactRev(stat, (...parts) => parts.join('/'))).toContain('/')
  })
})

describe('启动清单：拓扑排序与整图', () => {
  const rows = [
    { id: 'c', rev: 'r3', inject: ['b'] },
    { id: 'a', rev: 'r1' },
    { id: 'b', rev: 'r2', inject: ['a'] },
  ]

  test('拓扑排序：被依赖的在前', () => {
    expect(orderUiPlugins(rows).map((row) => row.id).join(',')).toBe('a,b,c')
  })

  test('成环报错，消息里列出环上成员', () => {
    const cycle = (): unknown[] =>
      orderUiPlugins([
        { id: 'x', rev: 'r', inject: ['y'] },
        { id: 'y', rev: 'r', inject: ['x'] },
      ])
    expect(cycle).toThrow(/x -> y -> x/)
  })

  test('自己 inject 自己报错', () => {
    expect(() => orderUiPlugins([{ id: 'x', rev: 'r', inject: ['x'] }])).toThrow()
  })

  test('清单里两个 id 相同报错（不能静默少装一个）', () => {
    expect(() =>
      orderUiPlugins([
        { id: 'x', rev: 'r1' },
        { id: 'x', rev: 'r2' },
      ]),
    ).toThrow()
  })

  test('启动图带宿主身份、条目按依赖排序、地址带内容锚', () => {
    const graph = composeUiBootGraph({ name: 'Pneuma', version: '9.9.9' }, rows)
    expect(graph.host.name).toBe('Pneuma')
    expect(graph.host.version).toBe('9.9.9')
    expect(graph.entries.map((entry) => entry.id).join(',')).toBe('a,b,c')
    expect(graph.entries[0]?.url.startsWith('plugins/a/client.js?rev=r1')).toBe(true)
  })

  test('启动图 rev 稳定', () => {
    const graph = composeUiBootGraph({ name: 'Pneuma', version: '9.9.9' }, rows)
    expect(composeUiBootGraph({ name: 'x', version: 'y' }, rows).rev).toBe(graph.rev)
  })

  test('插件版本变了整图 rev 就变', () => {
    const withR9 = composeUiBootGraph({ name: 'x', version: 'y' }, [{ id: 'a', rev: 'r9' }])
    const withR1 = composeUiBootGraph({ name: 'x', version: 'y' }, [{ id: 'a', rev: 'r1' }])
    expect(withR9.rev).not.toBe(withR1.rev)
  })

  test('只改声明（不动 bundle）整图 rev 也变', () => {
    const immediate = composeUiBootGraph({ name: 'x', version: 'y' }, [{ id: 'a', rev: 'r', immediately: true }])
    const plain = composeUiBootGraph({ name: 'x', version: 'y' }, [{ id: 'a', rev: 'r' }])
    expect(immediate.rev).not.toBe(plain.rev)
  })

  test('改 external 声明整图 rev 也变', () => {
    const withExternal = composeUiBootGraph({ name: 'x', version: 'y' }, [{ id: 'a', rev: 'r', external: ['react-dom'] }])
    const plain = composeUiBootGraph({ name: 'x', version: 'y' }, [{ id: 'a', rev: 'r' }])
    expect(withExternal.rev).not.toBe(plain.rev)
  })

  test('external 指向图里另一条插件时，提供者排在消费者前面', () => {
    const ordered = orderUiPlugins([
      { id: 'consumer', rev: 'r', external: ['provider/client'] },
      { id: 'provider', rev: 'r' },
    ])
    expect(ordered.map((row) => row.id).join(',')).toBe('provider,consumer')
  })

  test('external 指向平台种子（图里没有这条）不影响排序', () => {
    const ordered = orderUiPlugins([
      { id: 'a', rev: 'r', external: ['react'] },
      { id: 'b', rev: 'r' },
    ])
    expect(ordered.map((row) => row.id).join(',')).toBe('a,b')
  })
})

// ── [3] bundle 发现 ───────────────────────────────────────────────────────────
describe('bundle 发现：清单读写与缺文件', () => {
  /** 夹具目录与收集结果（beforeAll 造一次，多个用例复用）。 */
  let dir = ''
  let collected: ReturnType<typeof collectUiPluginArtifacts>
  let demo: { id: string; rev: string; file: string } | undefined

  beforeAll(() => {
    dir = makeTree('plugins', {
      'manifest.json': JSON.stringify({
        version: 1,
        apiVersion: '2.0.0',
        plugins: [
          { id: 'demo', file: 'client.js', platform: 'web' },
          { id: '@scope/name', file: 'client.js', platform: 'web' },
          { id: 'tui-only', file: 'client.js', platform: 'tui' },
          { id: 'gone', file: 'client.js', platform: 'web' },
          { id: '../evil', file: 'client.js', platform: 'web' },
          { id: 'badfile', file: '../up.js', platform: 'web' },
        ],
      }),
      'demo/client.js': 'module.exports={apply(){}}',
      '@scope/name/client.js': 'module.exports={apply(){}}',
    })
    collected = collectUiPluginArtifacts(dir, 'web')
    demo = collected.entries.find((entry) => entry.id === 'demo')
  })

  test('清单里非法 id 被丢掉', () => {
    const manifest = readUiPluginManifest(dir)
    expect(manifest.some((entry) => entry.id.includes('evil'))).toBe(false)
  })
  test('文件名带路径分隔符的被丢掉', () => {
    const manifest = readUiPluginManifest(dir)
    expect(manifest.some((entry) => entry.id === 'badfile')).toBe(false)
  })
  test('清单保留合法项', () => {
    const manifest = readUiPluginManifest(dir)
    expect(manifest.some((entry) => entry.id === 'demo')).toBe(true)
    expect(manifest.some((entry) => entry.id === 'gone')).toBe(true)
  })
  test('作用域名形状的 id（@scope/name）保留', () => {
    const manifest = readUiPluginManifest(dir)
    expect(manifest.some((entry) => entry.id === '@scope/name')).toBe(true)
  })

  test('只收 web 载体的插件', () => {
    expect(collected.entries.some((entry) => entry.id === 'tui-only')).toBe(false)
  })
  test('缺文件的进 problems 而不是静默', () => {
    expect(collected.problems.some((line) => line.includes('gone'))).toBe(true)
  })
  test('收到的条目带 12 位版本', () => {
    expect(demo, JSON.stringify(collected.entries.map((entry) => entry.id))).toBeDefined()
    expect(demo?.rev).toHaveLength(12)
  })

  test('路径守卫：目录内为真', () => {
    expect(inside(dir, join(dir, 'demo', 'client.js'))).toBe(true)
  })
  test('路径守卫：跳出去为假', () => {
    expect(inside(dir, join(dir, '..', 'x'))).toBe(false)
  })
  test('取 bundle 命中', () => {
    expect((readUiPluginBundle('demo', 'client.js', dir) ?? Buffer.alloc(0)).length).toBeGreaterThan(0)
  })
  test('取 bundle 挡住路径逃逸', () => {
    expect(readUiPluginBundle('../evil', 'client.js', dir)).toBeNull()
  })
  test('取 bundle 挡住文件名逃逸', () => {
    expect(readUiPluginBundle('demo', '../up.js', dir)).toBeNull()
  })
  test('清单文件坏了按空处理', () => {
    expect(readUiPluginManifest(makeTree('bad', { 'manifest.json': '{oops' }))).toHaveLength(0)
  })
  test('清单不存在按空处理', () => {
    expect(readUiPluginManifest(join(WORK, 'nope'))).toHaveLength(0)
  })

  test('路由前缀识别', () => {
    expect(isUiBundleRequest('/plugins/demo/client.js')).toBe(true)
    expect(isUiBundleRequest('/api/boot')).toBe(false)
  })
  test('路由解析命中 200', () => {
    const hit = resolveUiBundleRequest('/plugins/demo/client.js', demo?.rev ?? '', dir)
    expect(hit.status).toBe(200)
    expect((hit.body?.length ?? 0)).toBeGreaterThan(0)
  })
  test('命中带不可变缓存', () => {
    const hit = resolveUiBundleRequest('/plugins/demo/client.js', demo?.rev ?? '', dir)
    expect(String(hit.headers?.['cache-control'] ?? '')).toContain('immutable')
  })
  test('缺 rev 一律 404（地址不带指纹就不是内容寻址地址）', () => {
    expect(resolveUiBundleRequest('/plugins/demo/client.js', null, dir).status).toBe(404)
  })
  test('给了错 rev 就 404', () => {
    expect(resolveUiBundleRequest('/plugins/demo/client.js', 'deadbeef', dir).status).toBe(404)
  })
  test('非 GET/HEAD 回 405 并带 Allow', () => {
    expect(resolveUiBundleRequest('/plugins/demo/client.js', demo?.rev ?? '', dir, 'POST').status).toBe(405)
  })
  test('HEAD 复用 GET 的头但不给体', () => {
    const head = resolveUiBundleRequest('/plugins/demo/client.js', demo?.rev ?? '', dir, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.body).toBeUndefined()
    expect(head.headers?.['content-length']).toBeDefined()
  })
  test('多段 id（@scope/name）能按内容寻址取到', () => {
    const scoped = collected.entries.find((entry) => entry.id === '@scope/name')
    expect(scoped).toBeDefined()
    expect(resolveUiBundleRequest('/plugins/@scope/name/client.js', scoped?.rev ?? '', dir).status).toBe(200)
  })
  test('目录外的 id 404', () => {
    expect(resolveUiBundleRequest('/plugins/%2E%2E/manifest.json', null, dir).status).toBe(404)
  })
  test('文件名带斜杠 404', () => {
    expect(resolveUiBundleRequest('/plugins/demo/a/b.js', null, dir).status).toBe(404)
  })
  test('未知插件 404', () => {
    expect(resolveUiBundleRequest('/plugins/nope/client.js', null, dir).status).toBe(404)
  })
})

describe('bundle 发现：2.0 目录自述（每个目录自己的 bundle.json 就是清单）', () => {
  let fromDirs: ReturnType<typeof collectUiPluginArtifacts>

  beforeAll(() => {
    const byDirs = makeTree('bundle-dirs', {
      // 根清单只写壳契约版本；即使它还留着旧的 plugins 数组，也**不再当清单用**
      'manifest.json': JSON.stringify({
        version: 1,
        apiVersion: '2.0.0',
        plugins: [{ id: 'ghost', file: 'client.js', platform: 'web' }],
      }),
      'alpha/bundle.json': JSON.stringify({ apiVersion: '2.0.0', file: 'client.js', platforms: ['web'], api: '^2.0.0' }),
      'alpha/client.js': 'module.exports={apply(){}}',
      'beta/bundle.json': JSON.stringify({
        apiVersion: '2.0.0',
        file: 'client.js',
        platforms: ['web', 'tui'],
        inject: ['alpha'],
      }),
      'beta/client.js': 'module.exports={apply(){}}',
      'ghost/client.js': 'module.exports={apply(){}}',
    })
    fromDirs = collectUiPluginArtifacts(byDirs, 'web')
  })

  test('每个目录自己的 bundle.json 就是清单（不读中央数组）', () => {
    expect(
      fromDirs.entries.map((entry) => entry.id).sort().join(','),
      `${fromDirs.entries.map((entry) => entry.id).join(',')} | ${fromDirs.problems.join(' | ')}`,
    ).toBe('alpha,beta')
  })
  test('中央数组里那条不会再被装载（构建已不写它）', () => {
    expect(fromDirs.entries.some((entry) => entry.id === 'ghost')).toBe(false)
  })
  test('声明了两个载体的产物在 web 视图里有一条', () => {
    expect(fromDirs.entries.filter((entry) => entry.id === 'beta')).toHaveLength(1)
  })
  test('同一个目录在 tui 视图里也有一条（同一份 code 两行）', () => {
    const byDirs = join(WORK, 'bundle-dirs')
    expect(collectUiPluginArtifacts(byDirs, 'tui').entries.some((entry) => entry.id === 'beta')).toBe(true)
  })
  test('根清单的 apiVersion 仍是门禁依据', () => {
    expect(fromDirs.apiVersion).toBe('2.0.0')
  })

  test('旧产物（只有中央数组）仍能装，但会被点名「没有 bundle.json」', () => {
    const legacy = makeTree('legacy-manifest', {
      'manifest.json': JSON.stringify({
        version: 1,
        apiVersion: '2.0.0',
        plugins: [{ id: 'old', file: 'client.js', platform: 'web' }],
      }),
      'old/client.js': 'module.exports={apply(){}}',
    })
    const fromLegacy = collectUiPluginArtifacts(legacy, 'web')
    expect(fromLegacy.entries.some((entry) => entry.id === 'old')).toBe(true)
    expect(fromLegacy.problems.some((line) => line.includes('old') && line.includes('bundle.json'))).toBe(true)
  })
})

// ── [3b] 组合包声明 external（pneuma.client.external） ─────────────────────────
describe('组合包的 external 声明', () => {
  let report: ReturnType<typeof discoverPackageUiArtifacts>

  beforeAll(() => {
    const profileDir = join(WORK, 'profile-external')
    /** 造一个已装进 profile 的组合包（一个包两半：package.json 的 pneuma.client 是声明处）。 */
    const makePackage = (name: string, client: Record<string, unknown>): string => {
      const pkgDir = join(profileDir, 'node_modules', ...name.split('/'))
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'client.js'), 'module.exports={apply(){}}', 'utf8')
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          exports: { './client': './client.js' },
          pneuma: { client: { platform: 'pneuma', api: '^2.0.0', ...client } },
        }),
        'utf8',
      )
      return pkgDir
    }
    makePackage('@demo/two-halves', { external: ['@tanstack/react-virtual', '@demo/provider/client'] })
    makePackage('@demo/provider', {})
    makePackage('@demo/bad-external', { external: 'react' })
    makePackage('@demo/mixed-external', { external: ['react', 42] })
    report = discoverPackageUiArtifacts(profileDir, '2.0.0', new Set<string>())
  })

  test('声明了 external 的组合包，行上带着这个字段', () => {
    const row = report.entries.find((entry) => entry.id === '@demo/two-halves')
    expect(JSON.stringify(row?.external)).toBe(JSON.stringify(['@tanstack/react-virtual', '@demo/provider/client']))
  })

  test('启动图条目带着 external（校验在装载器那一侧做）', () => {
    const graph = composeUiBootGraph(
      { name: 'Pneuma', version: '0.0.0-spec' },
      report.entries as unknown as Array<UiPluginRow & { rev: string }>,
    )
    const entry = graph.entries.find((item) => item.id === '@demo/two-halves')
    expect(entry?.external?.includes('@tanstack/react-virtual')).toBe(true)
  })

  test('external 不是数组：记一条问题、当没声明处理', () => {
    const bad = report.entries.find((item) => item.id === '@demo/bad-external')
    expect(bad?.external).toBeUndefined()
    expect(report.problems.some((line) => line.includes('@demo/bad-external') && line.includes('pneuma.client.external'))).toBe(true)
  })

  test('external 里混了非字符串：留下合法的、丢掉坏的', () => {
    const mixed = report.entries.find((item) => item.id === '@demo/mixed-external')
    expect(JSON.stringify(mixed?.external)).toBe(JSON.stringify(['react']))
  })
})
