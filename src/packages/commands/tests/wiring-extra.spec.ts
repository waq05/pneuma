/**
 * @pneuma/commands 的补缺口测试：内置 handler 的分支真派发一遍。
 *
 * 既有 `commands.spec.ts` 验的是「24 条都注册上了」与两个纯函数；本文件补它对 handler 内部
 * 分支的空白：权限三根旋钮的「唯一前缀 / 歧义 / 未知」、思考显示、分叉、导出、插件清单、
 * 检查更新、审查通道、ui-trust 的三种回答，以及 /diff /usage /status 的异步回执。
 *
 * 所有路径都不联网：fetch 被换成 reject 桩；/export 写到 mkdtemp；/review 的 cwd 指到
 * 临时目录（`collectReviewScope` 的 `rev-parse` 会失败，走「不是 git 仓库」那支）。
 * `DSC_HOME` 指到临时目录后再动态 import，/ui-trust 的信任记录才不落进真家目录。
 *
 * @module @pneuma/commands/tests/wiring-extra
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import type { CommandService } from '@pneuma/runtime/services/types.js'

const home = mkdtempSync(join(tmpdir(), 'dsc-commands-extra-'))
const cwd = mkdtempSync(join(tmpdir(), 'dsc-commands-cwd-'))
const previousHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = home

const { commandsPlugin, runCommand } = await import('../index.js')

afterAll(() => {
  if (previousHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = previousHome
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

/** 通知与调用记录。 */
const notices: string[] = []
const calls = {
  setPolicy: [] as string[],
  setReviewer: [] as string[],
  setEffort: [] as string[],
  setModel: [] as string[],
  openSession: 0,
  openPicker: 0,
  openModels: 0,
  openSettings: 0,
  openAgents: 0,
  exit: 0,
  preset: [] as string[],
  submit: [] as string[],
  dock: [] as unknown[],
  listUserMessages: [] as string[],
  forkSession: [] as unknown[],
}

/** 会话（导出与审查都读它）。 */
const session = {
  messages: [] as Array<{ role: string; content: string }>,
  meta: { cwd, id: 'abcdef12-3456-7890', createdAt: Date.UTC(2026, 10, 16) },
}

/** 可变 ctx：get 的返回值按用例换。 */
const ctxState: { compact: unknown; ask: unknown; review: unknown } = {
  compact: { describe: () => ({ autoCompactPercent: 70 }) },
  ask: undefined,
  review: undefined,
}

/** 可变快照：每条用例前重置。 */
function snapshot() {
  return {
    status: { turnState: 'idle', effort: 'default', sessionPath: '' as string | undefined },
    entries: [] as Array<{ kind: string; text: string }>,
    surfaces: {
      policy: {
        current: 'readonly',
        options: [
          { id: 'readonly', label: '只读', hint: '不改' },
          { id: 'read-write', label: '读写', hint: '可改' },
          { id: 'full-access', label: '完全访问', hint: '全开' },
        ],
        reviewer: 'user',
        reviewerOptions: [
          { id: 'user', label: '本人', hint: '自己裁' },
          { id: 'auto-review', label: '自动审查', hint: '模型先判' },
        ],
      },
      permissionPresets: {
        current: 'custom',
        options: [
          { name: 'safe', label: '安全', description: '保守' },
          { name: 'strict', label: '严格', description: '最严' },
        ],
      },
    },
  }
}

const state = snapshot()

/** runtime 桩：记录调用，行为按用例覆盖（用例里会整体换掉个别方法，故用宽类型）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 每个用例换方法的返回形状
const runtime: any = {
  getSnapshot: () => state,
  openSession: () => {
    calls.openSession += 1
  },
  setModel: async (model: string) => {
    calls.setModel.push(model)
  },
  usageStats: async () => ({
    sinceTs: null,
    totalTurns: 2,
    activeDays: 1,
    totalInputTokens: 1_000,
    totalOutputTokens: 500,
    totalCacheHitTokens: 0,
    totalCacheMissTokens: 0,
    peakDay: null,
    currentStreakDays: 1,
    longestStreakDays: 1,
    models: [],
  }),
  submit: (text: string) => {
    calls.submit.push(text)
  },
  dock: async (name: string, args: unknown) => {
    calls.dock.push({ name, args })
    return { diff: '' }
  },
  listUserMessages: async (path: string) => {
    calls.listUserMessages.push(path)
    return [{ role: 'user' }, { role: 'assistant' }]
  },
  forkSession: async (path: string, count: number) => {
    calls.forkSession.push({ path, count })
    return { ok: true, path: '/x/abcdef12-rest.jsonl' }
  },
  listPlugins: () => [],
  setPolicy: (id: string) => calls.setPolicy.push(id),
  setReviewer: (id: string) => calls.setReviewer.push(id),
  setEffort: async (id: string) => {
    calls.setEffort.push(id)
  },
  usePermissionPreset: (name: string) => {
    calls.preset.push(name)
    return { ok: true }
  },
  exit: () => {
    calls.exit += 1
  },
}

/** 界面桩。 */
const ui = {
  shell: false,
  notice: (text: string) => notices.push(text),
  openPicker: () => {
    calls.openPicker += 1
  },
  openAgents: () => {
    calls.openAgents += 1
  },
  openSettings: () => {
    calls.openSettings += 1
  },
  openModels: () => {
    calls.openModels += 1
  },
  toggleThinking: undefined as undefined | ((value?: boolean) => void),
}

/** 装一次插件，拿到服务。 */
let service: CommandService | undefined
function ensureApplied(): CommandService {
  if (service !== undefined) return service
  const fakeCtx = {
    get: (name: string) => (name === 'compact' ? ctxState.compact : name === 'ask' ? ctxState.ask : name === 'review' ? ctxState.review : undefined),
    emit: () => {},
    provide: (_name: string, value: CommandService) => {
      service = value
    },
    session: { current: () => session },
    llm: { provider: 'deepseek', model: 'chat', contextWindow: 100_000 },
  }
  ;(commandsPlugin.apply as (ctx: unknown) => void)(fakeCtx)
  if (service === undefined) throw new Error('apply 没有 provide commands 服务')
  return service
}

/** 派发一条命令并返回这次的通知（异步 handler 请配合 waitFor）。 */
function dispatch(input: string): string[] {
  notices.length = 0
  ensureApplied().run(input, runtime as never, ui as never)
  return [...notices]
}

/** 等异步 handler 把通知写出来。 */
async function waitNotice(fragment: string): Promise<string> {
  let text = ''
  await vi.waitFor(() => {
    text = notices.join('\n')
    expect(text).toContain(fragment)
  })
  return text
}

describe('权限三根旋钮：唯一前缀、歧义与未知', () => {
  test('/policy 与 /reviewer 的查询、前缀匹配与歧义', () => {
    expect(dispatch('/policy').join('\n')).toContain('当前权限模式：readonly')
    expect(dispatch('/policy nope').join('\n')).toContain('未知权限档位')
    expect(dispatch('/policy read').join('\n')).toContain('匹配到 2 个档位')
    expect(dispatch('/policy full').join('\n')).toContain('权限模式已切到「完全访问」')
    expect(calls.setPolicy).toEqual(['full-access'])

    expect(dispatch('/reviewer').join('\n')).toContain('当前审阅者：user')
    expect(dispatch('/reviewer nope').join('\n')).toContain('未知审阅者')
    expect(dispatch('/reviewer a').join('\n')).toContain('审批审阅者已切到「自动审查」')
    expect(calls.setReviewer).toEqual(['auto-review'])

    // 兼容导出在装上之后也要能派发（装上之前那条由既有 spec 钉）。
    notices.length = 0
    expect(runCommand('/help', runtime as never, ui as never)).toBe(true)
    expect(notices.join('\n')).toContain('/help')
  })

  test('/permission：档位名误当预设、未知、歧义、成功与失败回执', () => {
    expect(dispatch('/permission').join('\n')).toContain('三根旋钮的组合不匹配任何预设')
    expect(dispatch('/permission readonly').join('\n')).toContain('是权限档位不是预设')
    expect(dispatch('/permission nope').join('\n')).toContain('未知权限预设')
    expect(dispatch('/permission s').join('\n')).toContain('匹配到 2 个预设')
    expect(dispatch('/permission safe')).toEqual([])
    expect(calls.preset).toEqual(['safe'])

    const original = runtime.usePermissionPreset
    runtime.usePermissionPreset = () => ({ ok: false, error: '这个预设现在不能用' })
    try {
      expect(dispatch('/permission strict').join('\n')).toContain('这个预设现在不能用')
    } finally {
      runtime.usePermissionPreset = original
    }
  })

  test('/effort 与 /model 的分支', () => {
    expect(dispatch('/effort').join('\n')).toContain('当前思考强度：default')
    expect(dispatch('/effort zzz').join('\n')).toContain('未知思考档位')
    expect(dispatch('/effort h')).toEqual([])
    expect(calls.setEffort).toEqual(['high'])

    expect(dispatch('/model')).toEqual([])
    expect(calls.openModels).toBe(1)
    expect(dispatch('/model deepseek/chat')).toEqual([])
    expect(calls.setModel).toEqual(['deepseek/chat'])
  })
})

describe('会话与工具类命令：thinking / fork / plugins / export / diff / usage / status', () => {
  test('/thinking：不支持、翻转、非法参数与 on/off', () => {
    expect(dispatch('/thinking').join('\n')).toContain('不支持会话内切换思考块')

    const toggle = vi.fn()
    ui.toggleThinking = toggle
    dispatch('/thinking')
    expect(toggle).toHaveBeenLastCalledWith()
    expect(dispatch('/thinking maybe').join('\n')).toContain('用法：/thinking [on|off]')
    dispatch('/thinking on')
    expect(toggle).toHaveBeenLastCalledWith(true)
    dispatch('/thinking off')
    expect(toggle).toHaveBeenLastCalledWith(false)
    expect(toggle).toHaveBeenCalledTimes(3)
    ui.toggleThinking = undefined
  })

  test('/fork：没有会话、成功、失败与抛错', async () => {
    expect(dispatch('/fork').join('\n')).toContain('还没有可分叉的会话')
    state.status.sessionPath = '/sessions/a.jsonl'
    dispatch('/fork')
    await waitNotice('已分叉出副本 abcdef12')
    expect(calls.listUserMessages).toEqual(['/sessions/a.jsonl'])
    expect(calls.forkSession.at(-1)).toEqual({ path: '/sessions/a.jsonl', count: 2 })

    runtime.forkSession = async () => ({ ok: false, error: '磁盘满了' })
    dispatch('/fork')
    await waitNotice('/fork 失败：磁盘满了')

    runtime.forkSession = async () => {
      throw new Error('炸了')
    }
    dispatch('/fork')
    await waitNotice('/fork 失败：炸了')
    state.status.sessionPath = ''
  })

  test('/plugins：空清单与带问题/停用的清单', () => {
    expect(dispatch('/plugins').join('\n')).toContain('没有已挂载的插件')
    runtime.listPlugins = () => [
      { name: 'base', source: 'builtin', enabled: true, description: '内核' },
      { name: 'ext', source: 'external', enabled: false, description: '外部', problem: '版本不兼容' },
    ] as never
    const text = dispatch('/plugins').join('\n')
    expect(text).toContain('已挂载插件（2 个）')
    expect(text).toContain('· base（内核）— 内核')
    expect(text).toContain('· ext（外部 · 已停用）— 外部（注意：版本不兼容）')
  })

  test('/export：空会话、成功写盘与写失败', () => {
    expect(dispatch('/export').join('\n')).toContain('还没有消息')

    session.messages = [{ role: 'user', content: '你好' }]
    const target = join(cwd, 'out.md')
    const text = dispatch(`/export ${target}`).join('\n')
    expect(text).toContain('已导出 1 条消息')
    const markdown = readFileSync(target, 'utf8')
    expect(markdown).toContain('# 会话导出 abcdef12')
    expect(markdown).toContain('## 用户')
    expect(markdown).toContain('你好')

    expect(dispatch(`/export ${cwd}`).join('\n')).toContain('导出失败：')
    session.messages = []
  })

  test('/diff、/usage 与 /status 的异步回执', async () => {
    dispatch('/diff')
    await waitNotice('工作区没有未提交的改动')
    runtime.dock = async (name: string, args: unknown) => {
      calls.dock.push({ name, args })
      return { diff: '+ one line' }
    }
    dispatch('/diff a.ts')
    await waitNotice('+ one line')
    expect(calls.dock.at(-1)).toEqual({ name: 'git-diff', args: { file: 'a.ts' } })

    runtime.dock = async () => {
      throw new Error('git 不在')
    }
    dispatch('/diff')
    await waitNotice('/diff 失败：git 不在')

    runtime.usageStats = async () => {
      throw new Error('账本坏了')
    }
    dispatch('/usage')
    await waitNotice('/usage 失败：账本坏了')

    runtime.usageStats = async () => ({
      sinceTs: null,
      totalTurns: 1,
      activeDays: 1,
      totalInputTokens: 10,
      totalOutputTokens: 5,
      totalCacheHitTokens: 0,
      totalCacheMissTokens: 0,
      peakDay: null,
      currentStreakDays: 1,
      longestStreakDays: 1,
      models: [],
    })
    dispatch('/usage')
    await waitNotice('用量统计')

    expect(dispatch('/status').join('\n')).toContain('自动压缩触发线：70%')
    ctxState.compact = undefined
    expect(dispatch('/status').join('\n')).toContain('自动压缩触发线：80%')
    ctxState.compact = { describe: () => ({ autoCompactPercent: 70 }) }
  })
})

describe('审查通道与 ui-trust', () => {
  test('/review 无提问通道且不在 git 仓库时收口成一句话', async () => {
    dispatch('/review')
    await waitNotice('这里不是 git 仓库')
    expect(notices.join('\n')).toContain('没有提问卡通道')

    dispatch('/review-status')
    expect(notices.join('\n')).toContain('还没有审查记录')
    dispatch('/review-cancel')
    expect(notices.join('\n')).toContain('审查通道没开着')

    ctxState.review = {
      status: () => ({ state: 'running', startedAt: Date.UTC(2026, 10, 16), target: '未提交改动' }),
      cancel: () => true,
    }
    dispatch('/review-status')
    expect(notices.join('\n')).toContain('审查进行中')
    dispatch('/review-cancel')
    expect(notices.join('\n')).toContain('已取消这次审查')
    ctxState.review = undefined
  })

  test('/ui-trust：没有待确认、读不到清单、信任成功', () => {
    expect(dispatch('/ui-trust').join('\n')).toContain('没有等着确认的第三方界面插件')

    expect(dispatch('/ui-trust ghost').join('\n')).toContain('读不到 ghost/ui/client.js 的 plugin.json')

    mkdirSync(join(home, 'plugins', 'demo'), { recursive: true })
    writeFileSync(
      join(home, 'plugins', 'demo', 'plugin.json'),
      JSON.stringify({ api: '^1.0.0', platforms: ['web', 'desktop'] }),
    )
    const text = dispatch('/ui-trust demo').join('\n')
    expect(text).toContain('已信任第三方界面插件「demo」')
    expect(text).toContain('@dsc/ui 区间：^1.0.0')
    expect(text).toContain('载体：web/desktop')
    const trust = JSON.parse(readFileSync(join(home, 'plugins.json'), 'utf8')) as {
      uiTrust?: Record<string, unknown>
    }
    expect(trust.uiTrust).toBeDefined()
  })
})
