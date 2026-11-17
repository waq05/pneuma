/**
 * 打包权限预设（沙箱 + 权限模式 + 审阅者三合一）的内核集成用例（原
 * `scripts/permission-presets-test.mjs`）。
 *
 * 预设把三根旋钮捆成一颗按钮：表是纯表（`permission-core/permission-presets.ts`），应用
 * 动作全在插件里（`permission-presets/index.ts`）。探针后半段用 20 多条源码文本断言钉
 * 插件的结构（「写口只调 setter」「不碰 answer」「quiet 时不发 notice」）。这一层换成行为：
 * 真内核里点一次 `use()`，看**会话权限三项真的变了**、**偏好默认值没被顺手改掉**、
 * **回执与审计真的落了一条**，再看沙箱插件缺席时**回执里真的那句「这一半没落地」**。
 *
 * 为什么这些比源码文本值钱：文本断言改个引号就假红、逻辑写坏只要字面量还在就假绿；
 * 「点了预设之后这个会话的沙箱/权限/审阅到底是多少」才是用户签字的那一份。
 *
 * ## 与 `tests/integration/session-permission-scope.int.spec.ts` 的分工
 *
 * 那份钉的是 `permission-core` 的按会话读写与两条写入口（`use` / `setDefault`）。
 * 这里钉的是预设表本身、派生显示名，以及「启动复算不再往对话里刷回执」（2026-10-28 报障）
 * 与审计口径——两份文件用的是同一套内核，但断言对象不重叠。
 *
 * ## 隔离
 *
 * HOME 由 integration 层的 `tests/setup/temp-home.ts` 提供。本文件**刻意不打开沙箱插件**
 * （harness 默认清单就关着它）：这样 `use('read-only')` 会走到「沙箱插件没开」那条支路，
 * 正是要断言的那一句。需要沙箱行为的用例在 `tests/integration/session-permissions.int.spec.ts`。
 *
 * @module dsc/packages/permission-presets/permission-presets.int.spec
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  BUILTIN_PERMISSION_PRESETS,
  CUSTOM_PERMISSION_PRESET,
  DEFAULT_PERMISSION_PRESET,
  derivedPresetLabel,
  findPermissionPreset,
  matchPermissionPreset,
} from '@pneuma/permission-core/permission-presets.js'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'
import { readAudit } from '../../core/audit.js'

/** 会话里权限三项的形状。 */
interface PermissionState {
  sandbox: string | null
  policy: string | null
  reviewer: string | null
}

/** 内核里本文件用到的服务面。 */
interface KernelSurface {
  on(event: 'dsc/notice', listener: (text: string) => void): () => void
  permissionPresets: {
    use(name: string): string
    setDefault(name: string): string
    readonly name: string
    readonly defaultName: string
    surface(): { current: string; defaultName: string; options: Array<{ name: string }> }
  }
  approval: { readonly policy: string; readonly reviewer: string; setPolicy(next: string): void; setReviewer(next: string): void }
  settings: {
    prefs(): Record<string, unknown>
    sections(): Array<{ id: string; fields: Array<{ key?: string; derivedLabelKey?: string; options?: unknown[] }> }>
    values(id: string): Promise<Record<string, unknown>>
  }
  session: { open(filePath?: string): Promise<void>; current(): { state(id: 'permissions'): PermissionState | undefined } }
}

let llm: FakeLLM
let kernel: BootedKernel
let surface: KernelSurface
/** 这一段时间里冒出来的 notice 正文（用完清空）。 */
let notices: string[] = []

beforeAll(async () => {
  llm = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  surface = kernel.ctx as unknown as KernelSurface
  surface.on('dsc/notice', (text) => {
    notices.push(text)
  })
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
})

/** 新开一条空会话：上一个用例改过的权限不会串到下一个。 */
async function freshSession(): Promise<void> {
  await surface.session.open(undefined)
  notices = []
}

/** 当前会话的权限三项。 */
function permissions(): PermissionState {
  return surface.session.current().state('permissions') ?? { sandbox: null, policy: null, reviewer: null }
}

describe('① 出厂预设表：名字、顺序、三项取值', () => {
  test('顺序固定：read-only → workspace → full-access → auto-review', () => {
    expect(BUILTIN_PERMISSION_PRESETS.map((preset) => preset.name)).toEqual([
      'read-only',
      'workspace',
      'full-access',
      'auto-review',
    ])
  })

  test('新会话默认档是 workspace；custom 常量就是字符串 custom', () => {
    expect(DEFAULT_PERMISSION_PRESET).toBe('workspace')
    expect(CUSTOM_PERMISSION_PRESET).toBe('custom')
  })

  test('四档的三项取值各自对上契约（read-only / workspace / full-access / auto-review）', () => {
    const byName = new Map(BUILTIN_PERMISSION_PRESETS.map((preset) => [preset.name, preset]))
    expect(byName.get('read-only')).toMatchObject({ sandbox: 'read-only', policy: 'auto-edit', reviewer: 'user' })
    expect(byName.get('workspace')).toMatchObject({
      sandbox: 'workspace-write',
      policy: 'auto-edit',
      reviewer: 'user',
    })
    expect(byName.get('full-access')).toMatchObject({
      sandbox: 'danger-full-access',
      policy: 'full-access',
      reviewer: 'user',
    })
    expect(byName.get('auto-review')).toMatchObject({
      sandbox: 'danger-full-access',
      policy: 'full-access',
      reviewer: 'auto-review',
    })
  })

  test('四档都标了 builtin，都有 label 与 description（界面要画）', () => {
    expect(BUILTIN_PERMISSION_PRESETS.every((preset) => preset.builtin === true)).toBe(true)
    expect(BUILTIN_PERMISSION_PRESETS.every((preset) => preset.label.length > 0 && preset.description.length > 0)).toBe(
      true,
    )
  })

  test('三项组合两两不同（否则匹配有歧义）', () => {
    const triples = new Set(
      BUILTIN_PERMISSION_PRESETS.map((preset) => `${preset.sandbox}|${preset.policy}|${preset.reviewer}`),
    )
    expect(triples.size).toBe(BUILTIN_PERMISSION_PRESETS.length)
  })
})

describe('② matchPermissionPreset：三项全等才命中', () => {
  test('三项全等命中 workspace，每档都能被自己那组取值命回原名', () => {
    expect(matchPermissionPreset('workspace-write', 'auto-edit', 'user')).toBe('workspace')
    for (const preset of BUILTIN_PERMISSION_PRESETS) {
      expect(matchPermissionPreset(preset.sandbox, preset.policy, preset.reviewer)).toBe(preset.name)
    }
  })

  test('任意一项不同就落回 custom', () => {
    expect(matchPermissionPreset('read-only', 'readonly', 'user')).toBe(CUSTOM_PERMISSION_PRESET)
    expect(matchPermissionPreset('workspace-write', 'readonly', 'user')).toBe(CUSTOM_PERMISSION_PRESET)
    expect(matchPermissionPreset('workspace-write', 'auto-edit', 'auto-review')).toBe(CUSTOM_PERMISSION_PRESET)
  })
})

describe('③ findPermissionPreset：认不出返回 null', () => {
  test('custom 是推导状态、不是可选项；未知名字也返回 null', () => {
    expect(findPermissionPreset(CUSTOM_PERMISSION_PRESET)).toBeNull()
    expect(findPermissionPreset('nope')).toBeNull()
    expect(findPermissionPreset('')).toBeNull()
    expect(findPermissionPreset('auto-review')?.name).toBe('auto-review')
  })
})

describe('④ use()：真内核里点了之后到底变了什么', () => {
  test('切到 full-access：会话三项一起落，拿到一句回执', async () => {
    await freshSession()
    const notice = surface.permissionPresets.use('full-access')
    expect(notice).toContain('权限预设切到')
    expect(permissions()).toMatchObject({ policy: 'full-access', reviewer: 'user' })
    expect(surface.approval.policy).toBe('full-access')
    expect(surface.approval.reviewer).toBe('user')
  })

  test('沙箱插件没开时明说「这一半没落地」（用户不该以为自己已被围起来）', async () => {
    await freshSession()
    const notice = surface.permissionPresets.use('read-only')
    expect(notice).toContain('沙箱插件没开')
    expect(notice).toContain('没落地')
    // 权限模式那一半照旧生效。
    expect(permissions().policy).toBe('auto-edit')
  })

  test('再点一次同一个预设：回执说「三项取值没变」', async () => {
    await freshSession()
    surface.permissionPresets.use('full-access')
    const again = surface.permissionPresets.use('full-access')
    expect(again).toContain('三项取值没变')
  })

  test('不认识的预设名当场抛错；custom 被专门点名为「拼出来的状态」', async () => {
    await freshSession()
    expect(() => surface.permissionPresets.use('nope')).toThrow(/没有名为「nope」的权限预设/)
    expect(() => surface.permissionPresets.use('custom')).toThrow(/不是可选预设/)
  })

  test('用户点预设会发一条 dsc/notice 回执（setter 已静音，回执由这里给）', async () => {
    await freshSession()
    surface.permissionPresets.use('full-access')
    expect(notices.some((text) => text.includes('权限预设切到'))).toBe(true)
  })
})

describe('⑤ 派生显示名：命中预设留空，拼出来的组合读作「AI 审查」/「自定义」', () => {
  test('规则按审阅者一位决定', () => {
    expect(derivedPresetLabel('auto-review')).toBe('AI 审查')
    expect(derivedPresetLabel('user')).toBe('自定义')
  })

  test('派生名不进预设表（表里查不到它）', () => {
    expect(BUILTIN_PERMISSION_PRESETS.every((preset) => preset.label !== 'AI 审查' && preset.label !== '自定义')).toBe(
      true,
    )
  })

  test('设置页只有「权限预设」一个下拉，且声明了派生显示名的键', async () => {
    const general = surface.settings.sections().find((section) => section.id === 'general')
    const keys = (general?.fields ?? []).map((field) => field.key)
    const presetField = (general?.fields ?? []).find((field) => field.key === 'permissionPreset')
    expect(presetField?.derivedLabelKey).toBe('permissionPresetName')
    expect(presetField?.options).toHaveLength(BUILTIN_PERMISSION_PRESETS.length)
    // 两个单旋钮与「权限预设」重复，2026-11-06 从设置页移除。
    expect(keys).not.toContain('policy')
    expect(keys).not.toContain('reviewer')
  })

  test('拼出来的组合：审阅者是 AI 复核读作「AI 审查」，本人审读作「自定义」', async () => {
    await freshSession()
    surface.permissionPresets.use('full-access')
    // 拼出预设外的组合：full-access 的沙箱 + readonly 权限模式不是任何一档。
    surface.approval.setPolicy('readonly')
    surface.approval.setReviewer('user')
    expect(surface.permissionPresets.name).toBe(CUSTOM_PERMISSION_PRESET)
    expect((await surface.settings.values('general')).permissionPresetName).toBe('自定义')
    surface.approval.setReviewer('auto-review')
    expect((await surface.settings.values('general')).permissionPresetName).toBe('AI 审查')
  })
})

describe('⑥ 启动复算不写对话，用户动手才有回执；审计照记', () => {
  test('切会话时补钉权限不往对话里发回执', async () => {
    await freshSession()
    // 2026-10-28 报障：新会话一进来就刷四五条「权限模式切换为…」。
    await surface.session.open(undefined)
    expect(notices.filter((text) => text.includes('权限'))).toEqual([])
    // 但缺的项确实被钉住了（静默不等于没生效）。
    expect(permissions().policy).toBeDefined()
    expect(permissions().reviewer).toBeDefined()
  })

  test('setPolicy / setReviewer 不再往对话里写切换提示，但各记一条 mode-change 审计', async () => {
    await freshSession()
    const before = readAudit(500).filter((record) => record.kind === 'mode-change').length
    surface.approval.setPolicy('full-access')
    surface.approval.setReviewer('auto-review')
    expect(notices.filter((text) => text.includes('权限模式切换为') || text.includes('审批审阅者切换为'))).toEqual([])
    const after = readAudit(500).filter((record) => record.kind === 'mode-change')
    expect(after.length - before).toBe(2)
    // readAudit 是「最新在前」，所以新造的两条在数组头部。
    const added = after.slice(0, after.length - before).map((record) => record.reason)
    expect(added).toEqual(expect.arrayContaining([expect.stringContaining('权限模式 → full-access')]))
    expect(added).toEqual(expect.arrayContaining([expect.stringContaining('审批审阅者 → auto-review')]))
  })
})
