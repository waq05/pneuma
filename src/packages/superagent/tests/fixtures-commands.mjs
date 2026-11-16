/**
 * 来源读取测试共用的 `Commands` 假件：按调用次序喂数据，不跑真 gh / lark-cli。
 *
 * 为什么不用真 `Commands`（`infra/commands.ts`）：它是 `execFile` 的子进程封装，被测函数
 * 只通过 `api` / `pages` / `lark` / `withSignal` 这几个成员读写外部世界；用对象字面量把
 * 这些成员换成「队列里的下一条数据」，测试才不联网、不读部署凭据。假件只实现被测函数
 * 用到的成员，`gh` / `run` 一律抛错——万一哪天实现绕过 `api` / `lark` 直接跑子进程，
 * 这里立刻失败，而不是悄悄连网。
 *
 * 路径口径照真 `Commands.path`：GitHub API 的 `path` 会拼成 `repos/<repository>/<path>`，
 * 所以断言里的路径与上游 `vi.spyOn(commands, 'gh')` 看到的 `['api', 'repos/...']` 同形。
 *
 * @module @pneuma/superagent/tests/fixtures-commands
 */

/**
 * 把一串响应做成按次序返回的处理函数。
 *
 * - 值是 `Error` 实例：抛出它（模拟 CLI 失败）；
 * - 值是函数：把调用实参原样传给它（模拟「写盘再返回 saved_path」这类有副作用的响应）；
 * - 其它值：原样返回。
 *
 * 响应不够用时抛错，避免「少准备了一条数据」被误读成被测逻辑的失败。
 */
export function queued(...responses) {
  const queue = [...responses]
  return async (...args) => {
    if (queue.length === 0) throw new Error('测试假件没有更多响应了')
    const next = queue.shift()
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(...args) : next
  }
}

/**
 * 造一个 `Commands` 假件。
 *
 * @param {object} [options]
 * @param {string} [options.repository] 仓库名，拼进 GitHub API 路径。
 * @param {(path: string, flags: string[]) => unknown} [options.api] `api` 的数据来源。
 * @param {(path: string) => unknown[]} [options.pages] `pages` 的数据来源（元素级 schema 由调用方校验）。
 * @param {(args: string[], cwd?: string) => unknown} [options.lark] `lark` 的数据来源。
 */
export function fakeCommands({ repository = 'acme/widgets', api, pages, lark } = {}) {
  const calls = { api: [], pages: [], lark: [], gh: [], run: [] }
  const deployment = { repository, github: { cli: 'gh' }, feishu: { cli: 'lark-cli' } }
  const absolute = (path) => `repos/${repository}/${path}`
  const commands = {
    calls,
    repository,
    deployment,
    /** 真 `Commands.withSignal` 返回叠了信号的新实例；假件不关心信号，原样返回自己。 */
    withSignal() {
      return commands
    },
    async api(schemaOrPath, ...rest) {
      if (typeof schemaOrPath === 'string') {
        calls.api.push([absolute(schemaOrPath), ...rest])
        return api(schemaOrPath, rest)
      }
      const [path = '', ...flags] = rest
      calls.api.push([absolute(path), ...flags])
      return schemaOrPath.parse(await api(path, flags))
    },
    async pages(item, path, tally) {
      calls.pages.push([absolute(path)])
      const rows = await pages(path)
      const parsed = rows.flatMap((row) => {
        const result = item.safeParse(row)
        return result.success ? [result.data] : []
      })
      if (tally) tally.skipped += rows.length - parsed.length
      return parsed
    },
    async lark(args, cwd) {
      calls.lark.push({ args, cwd })
      return lark(args, cwd)
    },
    async gh(args) {
      calls.gh.push(args)
      throw new Error('测试假件不执行 gh 子进程')
    },
    async run(program, args, cwd) {
      calls.run.push({ program, args, cwd })
      throw new Error('测试假件不执行子进程')
    },
  }
  return commands
}
