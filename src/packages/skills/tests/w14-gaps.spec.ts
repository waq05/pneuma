/**
 * skills 的 w14 补测：刷新失败写进对话流、内置 HTTP 市场源回退旧缓存时把原因交出去。
 *
 * 技能文件铺在临时 `DSC_HOME` 下，`DSC_HOME` / `DSH_HOME` 都隔离；市场源是本机
 * `127.0.0.1:0` 起的小服务，不联网。其余装配面见 `wiring-extra.spec.ts`。
 *
 * @module dsc/packages/skills/tests/w14-gaps
 */
import type { Context } from '@deepseek-ai/cordis'
import { createServer as createHttpServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { SkillService } from '@pneuma/runtime/services/types.js'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'

const TMP = mkdtempSync(join(tmpdir(), 'dsc-skills-w14-'))
process.env['DSC_HOME'] = join(TMP, '.dsc')
process.env['HOME'] = TMP
process.env['USERPROFILE'] = TMP
// 技能发现根里还有 dshSkillsDir()（读 DSH_HOME）：不隔离就会扫到本机 ~/.dsh/skills。
process.env['DSH_HOME'] = join(TMP, '.dsh')
const DSH = join(TMP, '.dsc')
const SKILLS = join(DSH, 'skills')
const WORK = mkdtempSync(join(tmpdir(), 'dsc-skills-w14-cwd-'))
const SETTINGS_JSON = join(DSH, 'settings.json')
const SKILLS_JSON = join(DSH, 'skills.json')

type SkillsModule = typeof import('../index.js')
let skillsPlugin: SkillsModule['skillsPlugin']

interface CommandEntry {
  spec: { name: string }
  handler: (input: unknown) => unknown
}

interface Harness {
  tools: Map<string, ToolEntry>
  commands: Map<string, CommandEntry>
  service: SkillService
  transcript: string[]
  handlers: Map<string, Array<() => void>>
}

function writeSkill(dir: string, name: string): void {
  const target = join(dir, name)
  mkdirSync(target, { recursive: true })
  writeFileSync(
    join(target, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${name} 的技能`, '---', `正文：${name}`].join('\n'),
    'utf8',
  )
}

/** 挂插件；`brokenCommand` 时 `commands.register` 对这个命令名抛错（模拟注册表炸了）。 */
function mount(options: { brokenCommand?: string } = {}): Harness {
  const tools = new Map<string, ToolEntry>()
  const commands = new Map<string, CommandEntry>()
  const transcript: string[] = []
  const handlers = new Map<string, Array<() => void>>()
  let service: SkillService | undefined
  const ctx = {
    effect(fn: () => unknown) {
      const result = fn()
      return typeof result === 'function' ? result : () => undefined
    },
    tools: {
      register(entry: ToolEntry) {
        tools.set(entry.name, entry)
        return () => undefined
      },
    },
    commands: {
      register(spec: CommandEntry['spec'], handler: CommandEntry['handler']) {
        if (spec.name === options.brokenCommand) throw new Error('注册命令炸了')
        commands.set(spec.name, { spec, handler })
        return () => {
          commands.delete(spec.name)
        }
      },
    },
    transcript: { system: (text: string) => transcript.push(text) },
    session: { current: () => ({ meta: { cwd: WORK, id: 'skills-w14' } }) },
    provide(_name: string, value: SkillService) {
      service = value
    },
    on(event: string, handler: () => void) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => undefined
    },
    emit() {
      for (const handler of handlers.get('dsc/skills-changed') ?? []) handler()
    },
  }
  skillsPlugin.apply(ctx as unknown as Context, undefined)
  if (service === undefined) throw new Error('apply 没有 provide skills 服务')
  return { tools, commands, service, transcript, handlers }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** 起一个只服务市场索引的本地 HTTP 源（端口 0，不联网）。 */
async function startIndexServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer((req, res) => {
    if (/\.json(\?|$)/.test(req.url ?? '')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ name: 'http-skill', description: '本地源来的技能', path: 'http-skill.md' }]))
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('# http-skill\n\n本地源正文\n')
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  let closed = false
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: async () => {
      if (closed) return
      closed = true
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}

beforeAll(async () => {
  ;({ skillsPlugin } = await import('../index.js'))
})

beforeEach(() => {
  mkdirSync(SKILLS, { recursive: true })
  writeFileSync(SKILLS_JSON, JSON.stringify({ version: 1, disabled: [] }), 'utf8')
  writeFileSync(SETTINGS_JSON, JSON.stringify({ version: 1, marketSources: [] }), 'utf8')
  writeSkill(SKILLS, 'alpha')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  delete process.env['DSH_HOME']
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test('注册命令抛错：整个刷新失败写进对话流，目录已经算好的部分不丢', async () => {
  const harness = mount({ brokenCommand: 'alpha' })
  await waitFor(() => harness.transcript.length > 0)
  expect(harness.transcript.join('\n')).toContain('技能刷新失败：注册命令炸了')
  // 目录在 syncCommands 之前就写好了：刷新炸了也不该把已有的技能清单清空。
  expect(harness.service.catalogText()).toContain('`alpha`')
})

test('内置 HTTP 市场源：盘上有旧缓存、联网失败时回退旧条目并把失败原因交出去', async () => {
  const source = await startIndexServer()
  writeFileSync(
    SETTINGS_JSON,
    JSON.stringify({ version: 1, marketSources: [{ name: 'local-http', url: `${source.url}/index.json` }] }),
    'utf8',
  )
  const harness = mount()
  try {
    const first = await harness.service.browseMarket('local-http')
    expect(first.items.map((item) => item.name)).toEqual(['http-skill'])
    expect(first.error).toBeUndefined()

    // 断网后强制刷新：browseMarketSource 读盘上旧缓存回退，onFallback 把原因记进 fallbackReason。
    await source.close()
    const fallback = await harness.service.browseMarket('local-http', true)
    expect(fallback.items.map((item) => item.name)).toEqual(['http-skill'])
    expect(String(fallback.error)).not.toBe('')
  } finally {
    await source.close()
  }
})
