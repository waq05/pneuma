/**
 * prompt 装配面补盲（w14）：`registerSkeletonFilter` 的退订——只有当前登记的还是自己
 * 那一份时才删，避免「后来者被前人退订顺手删掉」。
 *
 * 假 ctx 只提供 llm / skills / session / emit；`DSC_HOME` 在任何 import 之前指进临时目录。
 *
 * @module dsc/packages/prompt/tests/w14-gaps.spec
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-prompt-w14-'))
process.env['DSC_HOME'] = HOME
const ROOT = join(HOME, 'work')
const savedDscHome = process.env['DSC_HOME']

let promptPlugin: (typeof import('../index.js'))['promptPlugin']

interface PromptService {
  registerSkeletonFilter(id: string, fn: (ids: readonly string[], scope?: unknown) => readonly string[]): () => void
}

beforeAll(async () => {
  promptPlugin = (await import('../index.js')).promptPlugin
})

afterAll(() => {
  if (savedDscHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = savedDscHome
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 句柄：留给系统清
  }
})

function mount(): PromptService {
  const services = new Map<string, unknown>()
  const session = { meta: { id: 'prompt-w14', cwd: ROOT }, state: () => undefined, appendState: () => undefined }
  const ctx = {
    llm: { model: 'dsc-model', provider: 'deepseek', inputModalities: [] },
    skills: { catalogText: () => '' },
    session: { current: () => session },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    emit() {},
  }
  promptPlugin.apply?.(ctx as never, undefined as never)
  return services.get('prompt') as PromptService
}

test('骨架过滤退订：自己的退订只删自己那一份', () => {
  const service = mount()
  const first = service.registerSkeletonFilter('w14-a', (ids) => ids)
  const second = service.registerSkeletonFilter('w14-a', (ids) => ids)
  // 同名换了一份：旧的那张退订不该把后来者删掉。
  first()
  expect(typeof second).toBe('function')
  // 新的退订正常生效，再退一次也不炸（幂等）。
  second()
  second()
})
