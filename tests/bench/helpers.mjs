/**
 * 性能基准的公共设施：临时 HOME、假 SSE 端点、内核启停、结果协议。
 *
 * ## 为什么不用 `tests/harness.ts`
 *
 * 基准必须跑在 plain node（设计 §4.2）：用 tsx/vitest 转译会让 TS 编译开销混进测量值，
 * 同一台机器上「改一行注释」都能让结果漂几十毫秒。所以这里只以**构建产物** `lib/**`
 * 为被测对象，跑前必须先 `pnpm run build`；lib 旧了测到的是旧代码。
 *
 * 这里刻意不 import harness：harness 是 TS，入口依赖 Vite 的 `@pneuma/runtime → src`
 * 别名；plain node 走的是 `lib/` 的相对路径与 `lib/node_modules/@pneuma/*` 的再导出桩。
 * 两套入口各自成立，混用会把「测的是 src 还是 lib」这件事重新搅乱。
 *
 * ## 隔离口径照抄 harness
 *
 * - `HOME` / `USERPROFILE` 同时指向临时目录（POSIX 认前者、Windows 认后者）；
 * - 删掉继承的 `DSC_HOME`：它一旦指向真实目录，内核会往开发者自己的 `~/.dsc` 写会话；
 * - `plugins.json` 三件套：关长期记忆（回合结束会多发一次模型请求）、关 OS 沙箱
 *   （Windows 上会 spawn PowerShell）、关会话标题（多发一次标题请求）；
 * - `config.yaml` 给一个模型名，插件按它找路由。
 *
 * 临时目录**不删**：红了要留着看会话日志与锁文件，删掉等于毁掉现场。
 *
 * ## 结果协议
 *
 * 每条基准只测一次，向 stdout 打一行 `BENCH_RESULT {json}`；`run.mjs` 负责跑 7 次、
 * 取中位数、与基线比较。基准自己失败时打 `BENCH_ERROR` 到 stderr 并以非 0 退出。
 *
 * @module tests/bench/helpers
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 本目录与仓库根：`lib/**` 的相对入口都从这里算。 */
export const BENCH_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(BENCH_DIR, '..', '..')

/** 结果行前缀。解析方只认这一行，插件往 stdout 打的日志不会污染结果。 */
const RESULT_PREFIX = 'BENCH_RESULT '

/** 把一个 `lib/` 下的相对路径变成可直接 `import()` 的 file URL。 */
export function libUrl(relativePath) {
  return pathToFileURL(join(REPO_ROOT, 'lib', relativePath)).href
}

/**
 * 建临时主目录并把进程的 HOME 指过去。
 *
 * 必须在 import 任何 `lib/**` 之前调用：`core/path-policy.ts` 的 `DSC_HOME` 是模块顶层
 * 常量，由 `homedir()` 一次算定。先 import 再改 HOME，模块里已经记下真实主目录了。
 */
export function createTempHome(prefix = 'dsc-bench-') {
  const home = mkdtempSync(join(tmpdir(), prefix))
  process.env.HOME = home
  process.env.USERPROFILE = home
  // 继承的 DSC_HOME 会让隔离整个失效，且失效时不会报错——只是安静地写真实目录。
  delete process.env.DSC_HOME
  return home
}

/**
 * 铺一份最小隔离主目录；三件套的理由见文件头。
 *
 * 只在文件不存在时写：基准将来若要预置清单，调用方先写、这里不覆盖。
 */
export function prepareHome(home) {
  const dscHome = process.env.DSC_HOME ?? join(home, '.dsc')
  mkdirSync(dscHome, { recursive: true })
  const pluginsFile = join(dscHome, 'plugins.json')
  if (!existsSync(pluginsFile)) {
    writeFileSync(
      pluginsFile,
      `${JSON.stringify(
        {
          version: 1,
          entries: [
            { file: 'memory', config: { enabled: false } },
            { file: 'sandbox', disabled: true },
            { file: 'session-title', disabled: true },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  }
  const configFile = join(dscHome, 'config.yaml')
  if (!existsSync(configFile)) writeFileSync(configFile, 'model:\n  name: test\n', 'utf8')
}

/** 基准用的供应商配置：形状与 harness/defaultKernelConfig 一致。 */
export function testConfig(baseUrl) {
  return {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl,
        apiKey: 'k',
        models: [
          {
            id: 'm',
            name: 'm',
            contextWindow: 100000,
            maxTokens: 500,
            modalities: ['text'],
            thinkingLevels: [],
            thinkingParam: 'none',
            effortMap: {},
          },
        ],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  }
}

/** 起真内核；调用方负责 `disposeKernel`。surface 默认 none，不挂 ink / host-stdio / remote 行。 */
export async function bootKernel(baseUrl, surface = 'none') {
  const { createKernel } = await import(libUrl('host/kernel.js'))
  return createKernel({
    config: testConfig(baseUrl),
    resumeSessionPath: null,
    surface,
  })
}

/**
 * 卸内核：先发应用层收尾事件，再逐个卸载插件 fiber。
 *
 * 不卸载时定时器、监听器、子进程会把进程钉住——基准进程本来就要退出，但 B1/B3 跑完
 * 立刻退出会带走未落盘的会话写流，下一次读到的基线现场就不完整。
 */
export async function disposeKernel(ctx) {
  try {
    ctx.emit('dsc/exit')
  } catch {
    // 装配不完整时这一步失败只会掩盖真正的问题；基准只关心测量值已拿到。
  }
  for (const plugin of [...ctx.registry.keys()]) {
    try {
      ctx.registry.delete(plugin)
    } catch {
      // 同上：卸载失败不该改写基准结果。
    }
  }
}

/**
 * 起一个只回一段 SSE 的假端点；B2 与 B3 共用。
 *
 * 帧序与 harness 的 `sseBody` 同口径：正文增量 → finish_reason → usage 空 choices →
 * `[DONE]`。少 `[DONE]` 时 `streamChat` 会等空闲超时，基准不是红是卡住。
 */
export async function startSSEServer(options = {}) {
  const content = options.content ?? '基准应答'
  const sockets = new Set()
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('startSSEServer：listen 后拿不到端口')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolveClose) => server.close(resolveClose))
    },
  }
}

/** 打一行机器可读结果；字段与 `run.mjs` 的解析口径一一对应。 */
export function emitResult(result) {
  console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`)
}

/** 基准失败：写 stderr 并置非 0 退出码，交给调用方在 finally 里收尾。 */
export function fail(message) {
  console.error(`BENCH_ERROR ${message}`)
  process.exitCode = 1
}

/** 跑一次同步子进程并取回结果；run.mjs 的 spawnSync 封装。 */
export function runBenchChild(file, cwd, timeoutMs) {
  const result = spawnSync(process.execPath, [join(BENCH_DIR, file)], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    throw new Error(`退出码 ${String(result.status)}：${output.slice(0, 2000)}`)
  }
  const line = (result.stdout ?? '').split(/\r?\n/).find((entry) => entry.startsWith(RESULT_PREFIX))
  if (line === undefined) throw new Error(`没有输出 ${RESULT_PREFIX.trim()} 结果行：${(result.stdout ?? '').slice(0, 2000)}`)
  return JSON.parse(line.slice(RESULT_PREFIX.length))
}
