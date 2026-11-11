/**
 * 功能包的共享测试工具：读清单、装插件、跑命令、断言注册。
 *
 * **为什么要有它**：批 1 与批 2 各自写了一份「假 ctx」，两份都只实现自己碰过的那几个面，
 * 第三个插件来了还得再抄一份，而且抄少一面就是 `undefined is not a function`。
 * 这里一次把常用面铺齐，插件测试只管断言，不管搭台。
 *
 * **为什么不做成运行时插件**：测试要在 CI 上跑，与宿主装配顺序无关；做成可停用的插件，
 * 等于给人一个「把测试关掉」的开关。
 *
 * 用法见 `src/packages/log/tests/log.test.mjs`：`mountPlugin('log', { config: { dir } })`。
 *
 * @module dsc/scripts/_testkit
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 仓库根。本文件在 `scripts/` 下一层。 */
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * 读一个功能包的清单与装配行。
 *
 * @param {string} id 包目录名（`src/packages/<id>/`）。
 * @returns {{ id: string, dir: string, pkg: object, patch: string }}
 */
export function readPackage(id) {
  const dir = join(root, 'src', 'packages', id)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  return { id, dir, pkg, patch }
}

/**
 * 从编译产物里取插件对象。
 *
 * 约定是 `<名字>Plugin` 导出（`logPlugin` / `doctorPlugin`），但外部包可能换名，
 * 所以按形状找：**有 `apply` 函数的对象**。找不到就抛，别让测试假装装上了。
 *
 * @param {string} id 包目录名。
 */
export async function loadPlugin(id) {
  const entry = pathToFileURL(join(root, 'lib', 'packages', id, 'index.js')).href
  const mod = await import(entry)
  for (const value of Object.values(mod)) {
    if (value !== null && typeof value === 'object' && typeof value.apply === 'function') {
      return { mod, plugin: value }
    }
  }
  throw new Error(`lib/packages/${id}/index.js 里没有带 apply 的导出`)
}

/**
 * 造一个「够用」的假 ctx。
 *
 * 铺的是插件最常碰的面：logger、provide/get、commands、settings、tools、surfaces、
 * waiting、transcript、effect。每个都记进 `captured`，测试从那儿取。
 *
 * @param {object} [seed] 要覆盖的服务面（例如给 `settings.modelConfig` 喂数据）。
 */
export function createFakeContext(seed = {}) {
  /** @type {{ exporters: any[], services: Record<string, any>, commands: Map<string, any>, sections: Map<string, any>, tools: Map<string, any>, notices: string[], prompts: any[], surfaces: Map<string, any>, waiting: Map<string, any> }} */
  const captured = {
    exporters: [],
    services: {},
    commands: new Map(),
    sections: new Map(),
    tools: new Map(),
    notices: [],
    prompts: [],
    surfaces: new Map(),
    waiting: new Map(),
  }

  const ctx = {
    logger: {
      buffer: [],
      exporter(exporter) {
        captured.exporters.push(exporter)
        return () => {
          const index = captured.exporters.indexOf(exporter)
          if (index >= 0) captured.exporters.splice(index, 1)
        }
      },
    },
    provide(name, service) {
      captured.services[name] = service
    },
    get(name) {
      return captured.services[name]
    },
    commands: {
      register(spec, handler) {
        captured.commands.set(spec.name, { spec, handler })
        return () => captured.commands.delete(spec.name)
      },
      specs() {
        return [...captured.commands.values()].map((entry) => entry.spec)
      },
    },
    settings: {
      registerSection(spec) {
        captured.sections.set(spec.id, spec)
        return () => captured.sections.delete(spec.id)
      },
      modelConfig() {
        throw new Error('测试没有提供 modelConfig 数据')
      },
    },
    tools: {
      register(entry) {
        captured.tools.set(entry.name, entry)
        return () => captured.tools.delete(entry.name)
      },
    },
    surfaces: {
      register(id, read) {
        captured.surfaces.set(id, read)
        return () => captured.surfaces.delete(id)
      },
    },
    waiting: {
      register(id, pending) {
        captured.waiting.set(id, pending)
        return () => captured.waiting.delete(id)
      },
    },
    prompt: {
      register(id, text, options) {
        captured.prompts.push({ id, text, options })
        return () => {}
      },
    },
    transcript: {
      system() {},
    },
    // `ctx.effect` 只登记清理动作；测试里不跑它，免得挂载时就把注册撤掉
    effect() {},
    ...seed,
  }

  return { ctx, captured }
}

/**
 * 装一个功能包：编译产物 + 假 ctx + `apply`。
 *
 * @param {string} id 包目录名。
 * @param {{ config?: object, seed?: object }} [options] `config` 原样当 apply 第二参。
 * @returns {Promise<{ plugin: any, ctx: any, captured: any, dispose: () => void }>}
 */
export async function mountPlugin(id, options = {}) {
  const { plugin } = await loadPlugin(id)
  const { ctx, captured } = createFakeContext(options.seed ?? {})
  const dispose = plugin.apply(ctx, options.config ?? {})
  return {
    plugin,
    ctx,
    captured,
    dispose: () => {
      // 卸载失败不该把测试结果盖掉：记一条提示就够
      try {
        if (typeof dispose === 'function') dispose()
      } catch (error) {
        console.warn(`dispose 抛错（已忽略）：${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

/**
 * 断言某个服务面注册了指定名字。
 *
 * @param {any} captured `mountPlugin` 的返回值。
 * @param {'commands'|'sections'|'tools'|'surfaces'|'waiting'} area 哪个 registry。
 * @param {string} name 注册名。
 */
export function expectRegistered(captured, area, name) {
  const registry = captured[area]
  assert.ok(registry instanceof Map, `${area} 不是 registry`)
  assert.ok(registry.has(name), `${area} 里没有注册 ${name}（现有：${[...registry.keys()].join(', ') || '空'}）`)
  return registry.get(name)
}

/**
 * 跑一条命令，收集它 notice 出来的文字。
 *
 * `ui` 只给 `notice`：命令处理函数里 `ui` 的其他方法在测试中不可用，用到就会抛——
 * 这是有意的，免得悄悄放过一条没测到的分支。
 *
 * @param {any} captured `mountPlugin` 的返回值。
 * @param {string} name 命令名（不带 `/`）。
 * @param {string[]} [args] 参数。
 * @returns {Promise<string[]>} notice 过的每一行。
 */
export async function runCommand(captured, name, args = []) {
  const entry = captured.commands.get(name)
  assert.ok(entry, `命令 /${name} 没注册`)
  captured.notices.length = 0
  const ui = {
    notice(text) {
      captured.notices.push(String(text))
    },
  }
  await entry.handler({ args, runtime: undefined, ui })
  return captured.notices
}

/** 等一个宏任务，给「处理函数是 async、结果晚一拍」的场景用。 */
export function tick(ms = 0) {
  return new Promise((resolveTick) => setTimeout(resolveTick, ms))
}

/**
 * 重放一份会话 JSONL，返回它恢复出来的会话状态。
 *
 * **为什么这么做**：会话日志是本仓最值钱的现场（一次 bug 的完整来龙去脉都在里面），
 * 但在此之前没有任何东西断言「同一份日志重放之后状态还是那个状态」。改一个状态键的
 * 写入顺序、改一处恢复逻辑，都只能靠人肉开界面看。
 *
 * 三个必须注意的点：
 *
 * 1. **`DSC_HOME` 要在 import 内核之前设好**。`core/session.ts` 有模块级 `const` 直接
 *    调用 `dscPath()`，模块加载那一刻就把路径定死了——之后再改环境变量没用。
 * 2. **fixture 的 `cwd` 会被改写成本机临时目录**。写死 `D:\\w` 的 fixture 在 Linux CI
 *    上根本打不开；会话的目录是它自己的数据，换一台机器就该换成那台机器的真实目录。
 * 3. **必须 `dispose`**。内核会挂一堆插件与定时器，不卸载测试进程不退出。
 *
 * @param {string} fixture 会话 JSONL 的绝对路径。
 * @param {{ stateKeys?: string[], settleMs?: number }} [options] 要导出哪些状态键、等多久让重放落定。
 * @returns {Promise<Record<string, unknown>>} `键 → 重放后的值`。
 */
export async function replaySession(fixture, options = {}) {
  const keys = options.stateKeys ?? ['permissions', 'mode', 'preset', 'todos', 'plan', 'plans']
  const settleMs = options.settleMs ?? 300
  const home = mkdtempSync(join(tmpdir(), 'dsc-replay-'))
  const previous = process.env['DSC_HOME']
  process.env['DSC_HOME'] = join(home, '.dsc')
  let kernel
  try {
    // 复制一份并改写 meta 的 cwd：fixture 本身不带「哪台机器」的信息
    const lines = readFileSync(fixture, 'utf8').split('\n').filter((line) => line.trim() !== '')
    const meta = JSON.parse(lines[0])
    meta.cwd = tmpdir()
    const replayFile = join(home, 'replay.jsonl')
    writeFileSync(replayFile, [JSON.stringify(meta), ...lines.slice(1)].join('\n') + '\n', 'utf8')

    const { createKernel } = await import(pathToFileURL(join(root, 'lib', 'host', 'kernel.js')).href)
    kernel = await createKernel({ config: {}, resumeSessionPath: replayFile })
    await tick(settleMs)
    const session = kernel.session.current()
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of keys) out[key] = session.state(key)
    return out
  } finally {
    if (kernel !== undefined) {
      try {
        kernel.dispose()
      } catch {
        // 卸载失败不影响已读到的状态
      }
    }
    if (previous === undefined) delete process.env['DSC_HOME']
    else process.env['DSC_HOME'] = previous
    rmSync(home, { recursive: true, force: true })
  }
}

/**
 * 快照比对：把一次输出钉成文件，下次跑必须一模一样。
 *
 * 与「断返回值」的分工：快照适合盯**格式**（一段渲染、一条落盘记录的字段形状），
 * 一处无意的字段改名会让它红，而断言具体某个值反而盯不住。
 *
 * @param {string} file 快照文件的绝对路径（建议放在包内 `tests/__snapshots__/`）。
 * @param {unknown} actual 要钉住的值（会被 `JSON.stringify(_, null, 2)`）。
 * @param {{ update?: boolean }} [options] `update` 缺省读环境变量 `UPDATE_SNAPSHOTS=1`。
 */
export function snapshotJson(file, actual, options = {}) {
  const update = options.update ?? process.env['UPDATE_SNAPSHOTS'] === '1'
  const text = `${JSON.stringify(actual, null, 2)}\n`
  if (!existsSync(file)) {
    if (!update) {
      assert.fail(`快照文件不存在：${file}\n首次生成请跑：UPDATE_SNAPSHOTS=1 node --test ...`)
    }
    const dir = dirname(file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(file, text, 'utf8')
    return
  }
  if (update) {
    writeFileSync(file, text, 'utf8')
    return
  }
  const expected = readFileSync(file, 'utf8')
  assert.equal(text, expected, `快照不一致：${file}\n确认改动符合预期后跑 UPDATE_SNAPSHOTS=1 刷新`)
}
