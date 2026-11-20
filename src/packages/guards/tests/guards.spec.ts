/**
 * @pneuma/guards 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：这个包是守卫链的汇总壳，对外只有插件对象与 `guards` 服务，
 * 装配面不变量 + 「空链 defer / 注册的 deny 按 order 生效 / 退订后恢复」就是它全部的便宜可验面。
 * @module @pneuma/guards/tests
 */
import { readFileSync } from 'node:fs'
import type { ToolGuardInput } from '@pneuma/runtime/core/tool-guards.js'
import type { GuardService } from '@pneuma/runtime/services/types.js'
import { expect, test } from 'vitest'
import { guardsPlugin } from '../index.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 一次普通工具调用：守卫只读这几项，其余给最小值。 */
const input: ToolGuardInput = {
  toolName: 'bash',
  risk: 'exec',
  cwd: process.cwd(),
  args: {},
  signal: new AbortController().signal,
  sessionId: 'test-session',
  sessionPath: 'test-session.jsonl',
}

let service: GuardService | undefined

/** apply 只做 `ctx.provide`，把服务原样交回来就够。 */
function applied(): GuardService {
  if (service !== undefined) return service
  const fakeCtx = {
    provide: (_name: string, value: GuardService) => {
      service = value
    },
  }
  ;(guardsPlugin.apply as (ctx: unknown) => void)(fakeCtx)
  if (service === undefined) throw new Error('apply 没有 provide guards 服务')
  return service
}

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/guards', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toMatch(/^\s*-\s*id: guards\s*$/m)
  expect(patch).toContain("name: '@pneuma/guards'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  const pkg = JSON.parse(read('../package.json')) as {
    name: string
    type: string
    exports: Record<string, { default?: string } | string>
    pneuma: { bundle?: { patch?: string }; library?: boolean }
  }
  expect(pkg.name).toBe('@pneuma/guards')
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.']).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  expect(pkg.pneuma.bundle?.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma.library).not.toBe(true)
})

// 入口真能加载：直接 import 源码入口并检查插件对象的三件事。
test('入口能加载，插件名与 apply 对得上', () => {
  const pkg = JSON.parse(read('../package.json')) as { name: string }
  expect(typeof guardsPlugin).toBe('object')
  expect(typeof guardsPlugin.name).toBe('string')
  // 插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
  expect(guardsPlugin.name).toBe(pkg.name.slice('@pneuma/'.length))
  expect(guardsPlugin.name).toBe('guards')
  expect(guardsPlugin.provide).toBe('guards')
  expect(typeof guardsPlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

// 守卫链的实际语义：没人表态就 defer（工具照常执行）；有人 deny 就按 order 取第一位，
// 退订后恢复。这三条决定了「谁被拒、理由是谁给的」，比断言插件对象字段值钱。
test('空链 defer；注册的 deny 守卫按 order 抢先；退订后恢复 defer', async () => {
  const guards = applied()
  expect(await guards.gate(input)).toEqual({ action: 'defer' })

  // 后注册但 order 更小（10 < 30）：必须由它说话，顺序错了实现就会先问审批。
  const offLate = guards.register({ id: 'late', order: 30, decide: () => ({ action: 'defer' }) })
  const offEarly = guards.register({ id: 'early', order: 10, decide: () => ({ action: 'deny', reason: '早的这一位说了算' }) })
  expect(await guards.gate(input)).toEqual({ action: 'deny', reason: '早的这一位说了算' })

  offEarly()
  expect(await guards.gate(input)).toEqual({ action: 'defer' })
  offLate()
  expect(await guards.gate(input)).toEqual({ action: 'defer' })
})

// 服务面剩下的四样：观察者链、会话归属解析、chain 只读视图。它们各是一层转发，
// 断了不会报错、只会静默不生效（遮红不生效 = 密钥落日志），所以逐条钉住。
test('观察者链按 order 依次加工；退订后恢复原文', () => {
  const guards = applied()
  expect(guards.observe('read', 'plain')).toBe('plain')

  const offLate = guards.registerObserver({ id: 'late', order: 50, observe: (_tool, text) => `${text}|late` })
  const offEarly = guards.registerObserver({ id: 'early', order: 10, observe: (_tool, text) => `${text}|early` })
  // 小的先加工：先 early 再 late。
  expect(guards.observe('read', 'x')).toBe('x|early|late')

  offEarly()
  expect(guards.observe('read', 'x')).toBe('x|late')
  offLate()
  expect(guards.observe('read', 'x')).toBe('x')
})

test('会话归属解析：解析器把队友会话改写成归属会话，认不出时原样返回', () => {
  const guards = applied()
  const seen: string[] = []
  const off = guards.registerSessionResolver!('teammate', (sessionId) => {
    seen.push(sessionId)
    return sessionId === 'mate-session' ? { sessionId: 'owner-session', sessionPath: 'owner.jsonl', facts: { teammate: 'a' } } : undefined
  })

  expect(guards.resolveSession?.({ ...input, sessionId: 'mate-session' })).toMatchObject({
    sessionId: 'owner-session',
    sessionPath: 'owner.jsonl',
    teammate: 'a',
  })
  expect(guards.resolveSession?.({ ...input, sessionId: 'plain-session' })).toMatchObject({ sessionId: 'plain-session' })
  // 归属解析会跟跳：先解析 mate-session → owner-session，再对 owner-session 解析一次（原样）。
  expect(seen).toStrictEqual(['mate-session', 'owner-session', 'plain-session'])

  off()
  expect(guards.resolveSession?.({ ...input, sessionId: 'mate-session' })).toMatchObject({ sessionId: 'mate-session' })
})

test('chain 只读视图按 order 列出已注册的守卫', () => {
  const guards = applied()
  expect(Array.isArray(guards.chain)).toBe(true)
  const off = guards.register({ id: 'chain-check', order: 7, decide: () => ({ action: 'defer' }) })
  expect(guards.chain.map((guard) => guard.id)).toContain('chain-check')
  // 链上顺序是 order 升序。
  const orders = guards.chain.map((guard) => guard.order)
  expect(orders).toStrictEqual([...orders].sort((a, b) => a - b))
  off()
  expect(guards.chain.map((guard) => guard.id)).not.toContain('chain-check')
})
