/**
 * profile 清单热更：`numa plugin add/remove` 之后不重启宿主就生效（迁自 `scripts/profile-hot-mount-test.mjs`）。
 *
 * ## 测的是哪一层
 *
 * 只有三块：组合包怎么读（`plugin-bundle`）、清单怎么合成行并挂载（`plugin-loader`）、
 * 轮询器发现清单变了怎么重算（`plugin-watch`）。不动进程、不起内核——一个裸 cordis
 * `Context` 就够，因为这几件事都不依赖会话、模型或界面。
 *
 * ## 与探针的两处差别（都是「换了平面」的必然结果）
 *
 * 1. 探针把 `lib/` 拷到临时目录再从那份拷贝里 import，所以 `APP_INSTALL_DIR` 指向夹具，
 *    夹具包也装在假的「应用安装目录」里。spec 里 import 的是 `src/**`（台账 D25 的硬规矩），
 *    `APP_INSTALL_DIR` 因此是仓库根——往那里塞夹具等于改构建产物。所以夹具包改成装在
 *    **profile 的 `node_modules`** 里：这正是 `numa plugin add` 的落点，加载器解包时
 *    profile 锚点排在应用锚点前面，不传 `appDir` 也解析得到。
 * 2. 探针靠 `mountAllExternalPlugins` 把 profile 这一路接进轮询器。那条路径还会扫
 *    `~/.dsc/plugins`、按 `config.yaml` 的 profile 挂应用自带行；spec 里直接走它的两个
 *    下游（`mountBundlePlugins` + `startPluginWatch(root, { profileDir })`），验的是同一个
 *    行为（第二次启动把 profile 这一路补上），但不会把整套应用行拖进一个裸 Context。
 *
 * ## 夹具包为什么是「往 globalThis 记一笔」的模块
 *
 * 只看 `mounted` 表分不清「卸了」和「从来没挂」：两件事在表里都是「不在」。所以夹具模块
 * 在 apply 时记一次、disposer 跑时记一次，`mounted` 表只用来判「还在不在这一代里」。
 *
 * ## 包名必须每次唯一
 *
 * `plugin-loader.ts:1710` 的 `resolvedDirs` 是**进程级**的：同一个包名在一次启动里解析出
 * 两个物理目录会直接抛错（生产语义：不能挂出两份服务实例）。integration 层 `retry: 1`
 * 会让失败用例再跑一遍，包名固定就会在第二轮先撞这条，把真正的失败原因盖掉。
 *
 * @module dsc/core/plugin-watch.int.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as bundleApi from '@pneuma/runtime/core/plugin-bundle.js'
import * as loader from '@pneuma/runtime/core/plugin-loader.js'
import * as registry from '@pneuma/runtime/core/plugin-registry.js'
import * as watchApi from '@pneuma/runtime/core/plugin-watch.js'

/** 夹具总目录：独立于集成层的临时 HOME，失败时留着翻。 */
const WORK = mkdtempSync(join(tmpdir(), 'dsc-plugin-watch-'))
/** profile 目录：`numa plugin add/remove` 改的那三份清单与装进来的包都在这一层。 */
const PROFILE = join(WORK, 'profile')

/** 夹具模块的信号记录：apply / disposer 各记一次。 */
interface WatchRecord {
  applied: Record<string, number>
  disposed: Record<string, number>
}

const RECORD: WatchRecord = { applied: {}, disposed: {} }
;(globalThis as unknown as { __PROFILE_HOT__?: WatchRecord }).__PROFILE_HOT__ = RECORD

/** 包名/行 id 的唯一后缀（理由见文件头）。 */
let serial = 0

/**
 * 取一个本次运行里没用过的名字。
 * @param base - 语义前缀（读报错时还要认得出来）
 * @returns `<base>-<序号>`
 */
function unique(base: string): string {
  serial += 1
  return `${base}-${String(serial)}`
}

/** 写文件，顺带把父目录建好。 */
function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

/**
 * 造一个装在 profile 里的自带包：清单 + 一份会往 `globalThis` 记信号的模块。
 * @param rowId - 行 id，同时用作包名后缀与信号键
 * @returns 包名（patch 行里写的就是它）
 */
function makePackage(rowId: string): string {
  const pkgName = `@pneuma/${rowId}`
  const source = [
    `export const name = ${JSON.stringify(rowId)}`,
    'export const inject = []',
    'export function apply() {',
    '  const state = (globalThis.__PROFILE_HOT__ = globalThis.__PROFILE_HOT__ ?? { applied: {}, disposed: {} })',
    `  state.applied[${JSON.stringify(rowId)}] = (state.applied[${JSON.stringify(rowId)}] ?? 0) + 1`,
    '  return () => {',
    `    state.disposed[${JSON.stringify(rowId)}] = (state.disposed[${JSON.stringify(rowId)}] ?? 0) + 1`,
    '  }',
    '}',
    '',
  ].join('\n')
  const dir = join(PROFILE, 'node_modules', ...pkgName.split('/'))
  writeText(join(dir, 'package.json'), `${JSON.stringify({ name: pkgName, version: '1.0.0', type: 'module' }, null, 2)}\n`)
  writeText(join(dir, 'index.js'), source)
  return pkgName
}

/** 写 profile 清单：`dsh.profile.bundles` 就是 `numa plugin add/remove` 改的那一行。 */
function writeProfile(bundles: string[]): void {
  // `type: module` 是夹具自己用的：profile 目录里的临时插件是 ESM，不写它 Node 会先按
  // CommonJS 解析一遍，多一条 MODULE_TYPELESS 警告，淹掉真正的失败。
  writeText(
    join(PROFILE, 'package.json'),
    `${JSON.stringify({ name: 'test-profile', type: 'module', dsh: { profile: { bundles } } }, null, 2)}\n`,
  )
}

/**
 * 造一个装在 profile 里的组合包。
 * @param name - 包名（决定目录）
 * @param patch - `pneuma.bundle.patch` 的原文（字符串或字符串数组）
 * @param files - 包目录里的其它文件
 * @returns 包名
 */
function writeBundle(name: string, patch: string | string[], files: Record<string, string> = {}): string {
  const dir = join(PROFILE, 'node_modules', ...name.split('/'))
  writeText(join(dir, 'package.json'), `${JSON.stringify({ name, version: '1.0.0', pneuma: { bundle: { patch } } }, null, 2)}\n`)
  for (const [file, text] of Object.entries(files)) writeText(join(dir, file), text)
  return name
}

/** 一个 insert 行块（YAML）。 */
function insertRow(rowId: string, pkgName: string): string {
  return `- insert:\n    - id: ${rowId}\n      name: '${pkgName}'\n`
}

/** 当前 root 上已挂载的行 id（走 loader 的公开读口，不自造一张表）。 */
function mountedIds(): string[] {
  return loader.listMountedPluginSources().map((item) => item.identity)
}

/** 插件中心那一条元数据（验「这一行记着来自哪个组合包」）。 */
function infoOf(id: string): ReturnType<typeof registry.listPluginInfos>[number] | undefined {
  return registry.listPluginInfos().find((item) => item.file === id)
}

/** 一个裸 Context：`mountBundlePlugins` 只在有告警时用 transcript 写一行。 */
function bareContext(): Context {
  const root = new Context()
  try {
    Object.defineProperty(root, 'transcript', { value: { system() {} }, configurable: true })
  } catch {
    // 拿不到就算了：夹具干净，走不到写 transcript 那一步。
  }
  return root
}

/** 一条轮询器的日志出口：不写 stderr，收进数组供断言。 */
function logs(): { info: string[]; warn: string[] } {
  return { info: [], warn: [] }
}

/** 等条件成立（真定时器那一段用）。 */
async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolveTick) => setTimeout(resolveTick, 50))
  }
}

/** 本文件创建的轮询器：每条用例结束都停掉，别把定时器留在进程里。 */
const handles: watchApi.PluginWatchHandle[] = []

/**
 * 造一个手动驱动的轮询器（轮询间隔拉到很远：这一段用 `pollNow` 保证时序可复现）。
 * @param root - 挂组合包的内核
 * @param sink - 日志收集器
 */
function manualWatch(root: Context, sink: { info: string[]; warn: string[] }): watchApi.PluginWatchHandle {
  const handle = watchApi.createPluginWatch({
    root,
    profileDir: PROFILE,
    pollIntervalMs: 600000,
    debounceMs: 120,
    logger: { info: (line) => sink.info.push(line), warn: (line) => sink.warn.push(line) },
  })
  handles.push(handle)
  return handle
}

beforeAll(() => {
  mkdirSync(PROFILE, { recursive: true })
})

afterAll(() => {
  // 轮询器的定时器都 unref 过，但不显式停掉它们会在下一次读夹具时留下旧基线。
  for (const handle of handles.splice(0)) handle.stop()
  // 成功时删掉夹具；失败现场留着（与 harness 的临时 HOME 同一个约定）。
  try {
    rmSync(WORK, { recursive: true, force: true })
  } catch {
    // 删不掉不影响结论：临时目录会被系统清。
  }
})

describe('① 起内核就挂上：profile 里列的组合包，行跟着挂起来', () => {
  /** 第一个夹具包的行 id 与包名。 */
  const rowId = unique('probe-a')
  const pkgName = `@pneuma/${rowId}`
  const bundleName = unique('@probe/one')
  /** 这一轮挂载的结果（失败清单与挂上的行）。 */
  let mounted: Awaited<ReturnType<typeof loader.mountBundlePlugins>>

  beforeAll(async () => {
    makePackage(rowId)
    writeBundle(bundleName, './cordis.patch.yml', { 'cordis.patch.yml': insertRow(rowId, pkgName) })
    writeProfile([bundleName])
    mounted = await loader.mountBundlePlugins(bareContext(), PROFILE)
  })

  test('profile 里的包装上了，没有失败', () => {
    expect(mounted.failures).toEqual([])
    expect(mounted.rows).toEqual([rowId])
    expect(mountedIds()).toContain(rowId)
  })

  test('这一行真的 apply 过一次（不是只登记在表里）', () => {
    expect(RECORD.applied[rowId]).toBe(1)
  })

  test('这一行记着来源组合包（插件中心据此分组）', () => {
    expect(infoOf(rowId)?.bundle).toBe(bundleName.slice('@probe/'.length))
  })
})

describe('② 加包不重启：追加第二个包，一轮后挂上', () => {
  /** 第一个包的行 id 与包名。 */
  const firstRow = unique('probe-a')
  const firstPkg = `@pneuma/${firstRow}`
  /** 第一个包的组合包名。 */
  const firstBundle = unique('@probe/one')
  /** 第二个包。 */
  const secondRow = unique('probe-b')
  const secondPkg = `@pneuma/${secondRow}`
  const secondBundle = unique('@probe/two')
  /** 日志与轮询器。 */
  const sink = logs()
  let handle: watchApi.PluginWatchHandle

  beforeAll(async () => {
    makePackage(firstRow)
    writeBundle(firstBundle, './cordis.patch.yml', { 'cordis.patch.yml': insertRow(firstRow, firstPkg) })
    writeProfile([firstBundle])
    const root = bareContext()
    await loader.mountBundlePlugins(root, PROFILE)
    handle = manualWatch(root, sink)
    await handle.pollNow()
  })

  test('清单没动时一轮扫描不重算（也不写日志）', () => {
    expect(sink.info).toEqual([])
    expect(sink.warn).toEqual([])
  })

  test('追加第二个包之后：第二个行挂上，第一个仍在（没重启宿主）', async () => {
    makePackage(secondRow)
    writeBundle(secondBundle, './cordis.patch.yml', { 'cordis.patch.yml': insertRow(secondRow, secondPkg) })
    writeProfile([firstBundle, secondBundle])
    await handle.pollNow()
    expect(mountedIds()).toContain(secondRow)
    expect(mountedIds()).toContain(firstRow)
    expect(RECORD.applied[secondRow]).toBe(1)
  })

  test('日志说清「清单变了」与「挂了 1 行 / 卸了 0 行」', () => {
    expect(sink.info).toContain('[plugin-watch] profile 清单变了，重算组合包')
    expect(sink.info).toContain('[plugin-watch] 挂了 1 行 / 卸了 0 行')
  })
})

describe('③ 删包真卸：清单去掉谁，谁的行下来；整份 profile 被删也不许抛', () => {
  /** 两个包的行 id / 包名 / 组合包名。 */
  const keepRow = unique('probe-b')
  const keepPkg = `@pneuma/${keepRow}`
  const keepBundle = unique('@probe/two')
  const goneRow = unique('probe-a')
  const gonePkg = `@pneuma/${goneRow}`
  const goneBundle = unique('@probe/one')
  /** 日志与轮询器。 */
  const sink = logs()
  let handle: watchApi.PluginWatchHandle

  beforeAll(async () => {
    makePackage(keepRow)
    makePackage(goneRow)
    writeBundle(keepBundle, './cordis.patch.yml', { 'cordis.patch.yml': insertRow(keepRow, keepPkg) })
    writeBundle(goneBundle, './cordis.patch.yml', { 'cordis.patch.yml': insertRow(goneRow, gonePkg) })
    writeProfile([goneBundle, keepBundle])
    const root = bareContext()
    await loader.mountBundlePlugins(root, PROFILE)
    handle = manualWatch(root, sink)
    await handle.pollNow()
  })

  test('删掉的包：行从 mounted 表里消失，且 disposer 真跑过', async () => {
    writeProfile([keepBundle])
    await handle.pollNow()
    expect(mountedIds()).not.toContain(goneRow)
    expect(RECORD.disposed[goneRow]).toBe(1)
    expect(mountedIds()).toContain(keepRow)
  })

  test('日志说清「挂了 0 行 / 卸了 1 行」', () => {
    expect(sink.info).toContain('[plugin-watch] 挂了 0 行 / 卸了 1 行')
  })

  test('整份 profile 被删（package.json 不见了）也不抛，挂过的行全卸掉', async () => {
    rmSync(join(PROFILE, 'package.json'), { force: true })
    await expect(handle.pollNow()).resolves.toBeUndefined()
    expect(mountedIds()).not.toContain(keepRow)
  })
})

describe('③b profile 自己那层 patch：删掉一条 insert，那一行也下来', () => {
  /** 一个包的行 id 与包名（profile 自己那层另有独立的一行）。 */
  const rowId = unique('probe-b')
  const pkgName = `@pneuma/${rowId}`
  const bundleName = unique('@probe/two')
  /** profile 自己那层 patch 插的行 id。 */
  const patchRow = unique('probe-patch')
  /** 日志与轮询器。 */
  const sink = logs()
  let handle: watchApi.PluginWatchHandle

  beforeAll(async () => {
    makePackage(rowId)
    writeBundle(bundleName, './cordis.patch.yml', { 'cordis.patch.yml': insertRow(rowId, pkgName) })
    writeProfile([bundleName])
    writeText(
      join(PROFILE, 'extra', 'plugin.js'),
      `export function apply() { const g = (globalThis.__PROFILE_HOT__ ??= { applied: {}, disposed: {} }); (g.applied ??= {})[${JSON.stringify(patchRow)}] = (g.applied[${JSON.stringify(patchRow)}] ?? 0) + 1 }\n`,
    )
    writeText(join(PROFILE, 'cordis.patch.yml'), insertRow(patchRow, './extra/plugin.js'))
    const root = bareContext()
    await loader.mountBundlePlugins(root, PROFILE)
    handle = manualWatch(root, sink)
    await handle.pollNow()
  })

  test('profile 自己那层 patch 插的行挂上了', () => {
    expect(mountedIds()).toContain(patchRow)
  })

  test('它没有包归属（不是哪个组合包给的）', () => {
    expect(infoOf(patchRow)?.bundle).toBeUndefined()
  })

  test('删掉那条 insert 后那一行也下来，同一份 profile 里别的行不受影响', async () => {
    rmSync(join(PROFILE, 'cordis.patch.yml'), { force: true })
    await handle.pollNow()
    expect(mountedIds()).not.toContain(patchRow)
    expect(mountedIds()).toContain(rowId)
  })
})

describe('④ patch 字符串数组：一个包声明两份 patch 文件，按顺序叠', () => {
  /** 三层夹具：a.yml 插一行、b.yml 插另一行。 */
  const rowC = unique('probe-c')
  const rowD = unique('probe-d')
  const bundleName = unique('@probe/three')
  /** 日志与轮询器。 */
  const sink = logs()
  let handle: watchApi.PluginWatchHandle

  beforeAll(async () => {
    makePackage(rowC)
    makePackage(rowD)
    writeBundle(bundleName, ['./a.yml', './b.yml'], {
      'a.yml': insertRow(rowC, `@pneuma/${rowC}`),
      'b.yml': insertRow(rowD, `@pneuma/${rowD}`),
    })
    writeProfile([bundleName])
    const root = bareContext()
    await loader.mountBundlePlugins(root, PROFILE)
    handle = manualWatch(root, sink)
    await handle.pollNow()
  })

  test('两层插的行都挂上了', () => {
    expect(mountedIds()).toContain(rowC)
    expect(mountedIds()).toContain(rowD)
  })

  test('两层插的行都记着同一个来源组合包', () => {
    const short = bundleName.slice('@probe/'.length)
    expect(infoOf(rowC)?.bundle).toBe(short)
    expect(infoOf(rowD)?.bundle).toBe(short)
  })

  test('readBundle：数组两层都读出来，标签带文件名（诊断分得清是哪一份）', () => {
    const dir = writeUnit('two-layers', { pneuma: { bundle: { patch: ['./a.yml', './b.yml'] } } }, {
      'a.yml': '- insert:\n    - id: x\n',
      'b.yml': '- insert:\n    - id: y\n',
    })
    const info = bundleApi.readBundle(dir)
    if (info === null) throw new Error('readBundle 没读出夹具包')
    expect(info.patch).toHaveLength(2)
    expect(info.warnings).toEqual([])
    expect(info.patch[0]?.label).toContain('a.yml')
    expect(info.patch[1]?.label).toContain('b.yml')
  })

  test('readBundle：数组里的非字符串项跳过，其余照收，告警说清是第几项', () => {
    const dir = writeUnit('mixed-layers', { pneuma: { bundle: { patch: ['./a.yml', 42] } } }, {
      'a.yml': '- insert:\n    - id: x\n',
    })
    const info = bundleApi.readBundle(dir)
    if (info === null) throw new Error('readBundle 没读出夹具包')
    expect(info.patch).toHaveLength(1)
    expect(info.warnings).toHaveLength(1)
    expect(String(info.warnings[0])).toContain('第 2 项')
  })

  test('readBundle：空数组 = 没声明，也不告警', () => {
    const dir = writeUnit('empty-layers', { pneuma: { bundle: { patch: [] } } })
    const info = bundleApi.readBundle(dir)
    if (info === null) throw new Error('readBundle 没读出夹具包')
    expect(info.patch).toHaveLength(0)
    expect(info.warnings).toEqual([])
  })

  test('readBundle：字符串写法照旧，单层标签不变', () => {
    const dir = writeUnit('single-layer', { pneuma: { bundle: { patch: './cordis.patch.yml' } } }, {
      'cordis.patch.yml': '- insert:\n    - id: x\n',
    })
    const info = bundleApi.readBundle(dir)
    if (info === null) throw new Error('readBundle 没读出夹具包')
    expect(info.patch).toHaveLength(1)
    expect(info.patch[0]?.label).toBe('single-layer v1.0.0')
  })
})

/** 在夹具目录里造一个独立包目录（`readBundle` 的读盘口径单独钉一遍）。 */
function writeUnit(name: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = join(WORK, 'units', name)
  for (const [file, text] of Object.entries(files)) writeText(join(dir, file), text)
  writeText(join(dir, 'package.json'), `${JSON.stringify({ name, version: '1.0.0', ...manifest }, null, 2)}\n`)
  return dir
}

describe('⑤ 接上轮询：装配路径先起，宿主启动路径后到', () => {
  /** 已有的两个包（装配路径挂上的）与新加的那个包。 */
  const rowC = unique('probe-c')
  const rowD = unique('probe-d')
  const bundleThree = unique('@probe/three')
  const rowE = unique('probe-e')
  const bundleFour = unique('@probe/four')
  /** 两次拿到的轮询器句柄。 */
  let first: watchApi.PluginWatchHandle
  let second: watchApi.PluginWatchHandle

  beforeAll(async () => {
    // 这一段验「真定时器」：把进程里那个单例放出来。
    delete process.env['DSC_HOT']
    makePackage(rowC)
    makePackage(rowD)
    writeBundle(bundleThree, ['./a.yml', './b.yml'], {
      'a.yml': insertRow(rowC, `@pneuma/${rowC}`),
      'b.yml': insertRow(rowD, `@pneuma/${rowD}`),
    })
    writeProfile([bundleThree])

    const root = bareContext()
    // 第一次：只有行/库包两路（模拟装配路径先拉起轮询器，那时还不知道 profile 在哪）。
    first = watchApi.startPluginWatch(root)
    // 宿主启动路径后到：它带 profileDir，应该把清单这一路补上，而不是另起一个轮询器。
    await loader.mountBundlePlugins(root, PROFILE)
    second = watchApi.startPluginWatch(root, { profileDir: PROFILE })
  })

  afterAll(() => {
    watchApi.stopPluginWatch()
  })

  test('二次启动返回同一个轮询器（没有重建）', () => {
    expect(second).toBe(first)
  })

  test('root 上组合包的行都挂上了', () => {
    expect(mountedIds()).toContain(rowC)
    expect(mountedIds()).toContain(rowD)
  })

  test('补上的那一路上真的在跑：新装一个包，等一轮之后挂上', async () => {
    makePackage(rowE)
    writeBundle(bundleFour, './cordis.patch.yml', { 'cordis.patch.yml': insertRow(rowE, `@pneuma/${rowE}`) })
    writeProfile([bundleThree, bundleFour])
    // 默认 1000ms 一轮 + 200ms 去抖：留 5 秒，慢机器也够（原来是固定 3.2 秒）。
    const mounted = await until(() => mountedIds().includes(rowE), 5000)
    expect(mounted).toBe(true)
    expect(RECORD.applied[rowE]).toBe(1)
  })
})

describe('⑥ 装包/卸包时通知界面换图（dsc/ui-graph-dirty）', () => {
  /** 已有的两个包与新装的那个包。 */
  const rowC = unique('probe-c')
  const rowD = unique('probe-d')
  const bundleThree = unique('@probe/three')
  const rowF = unique('probe-f')
  const bundleFive = unique('@probe/five')
  /** 收到的换图通知（只关心次数）。 */
  const signals: number[] = []
  let handle: watchApi.PluginWatchHandle

  beforeAll(async () => {
    makePackage(rowC)
    makePackage(rowD)
    writeBundle(bundleThree, ['./a.yml', './b.yml'], {
      'a.yml': insertRow(rowC, `@pneuma/${rowC}`),
      'b.yml': insertRow(rowD, `@pneuma/${rowD}`),
    })
    writeProfile([bundleThree])
    const root = bareContext()
    root.on('dsc/ui-graph-dirty', () => signals.push(1))
    await loader.mountBundlePlugins(root, PROFILE)
    handle = manualWatch(root, logs())
  })

  test('清单没动时不发换图通知', async () => {
    await handle.pollNow()
    expect(signals).toHaveLength(0)
  })

  test('装上带界面半边的包之后通知一次', async () => {
    makePackage(rowF)
    writeBundle(bundleFive, './cordis.patch.yml', { 'cordis.patch.yml': insertRow(rowF, `@pneuma/${rowF}`) })
    writeProfile([bundleThree, bundleFive])
    await handle.pollNow()
    expect(signals).toHaveLength(1)
    expect(mountedIds()).toContain(rowF)
  })

  test('卸包之后又通知一次', async () => {
    writeProfile([bundleThree])
    await handle.pollNow()
    expect(signals).toHaveLength(2)
    expect(mountedIds()).not.toContain(rowF)
  })

  test('两轮都没变化就不再打扰界面', async () => {
    await handle.pollNow()
    expect(signals).toHaveLength(2)
  })
})
