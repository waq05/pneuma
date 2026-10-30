/**
 * 「工具名是 null」白屏事故的探针（2026-10-30）。
 *
 * 现象：桌面窗口里那一页突然整块空白，诊断区写着
 * `shell.main / transcript.flow 在渲染时出错：Cannot read properties of null (reading 'toLowerCase')`。
 * 现场日志里躺着一条 `{"type":"tool","callId":null,"name":null,"text":"未知工具：null"}`。
 *
 * 链条：网关在某一片流里把 `id` / `function.name` 回成 `null` →
 * `core/llm.ts` 的合并分支只判了 `!== undefined && !== ''`，null 两道门都过 →
 * 把前面收到的好名字覆盖成 null → 日志写 null → 界面 `activityOf()` 对名字调
 * `.toLowerCase()` → 整个消息流条目崩掉、对话页白屏。
 *
 * 本探针钉四层，缺一层就还会白屏：
 *   [1] 合并层（`applyToolCallDelta`）：null 不许覆盖已有的名字/ID，参数也必须稳稳累积；
 *   [2] 回放层（`Transcript.replayHistory`）：老日志里的 null 读回来要修成空串，
 *       否则每次重开这个会话都会再崩一次；
 *   [3] 渲染纯函数（`activityOf` / `toolArgFields` / `liveToolDetail`）：名字不是字符串
 *       时给「不认识的工具」这一档，绝不抛异常；
 *   [4] 宿主与壳的源码里不再留裸的 `name.toLowerCase()` 入口（防回退的形态钉）。
 *
 * 跑法：先 `pnpm run build`（读 `lib/` 产物），再 `node scripts/ui-tool-name-null-test.mjs`。
 *
 * @module dsc/scripts/ui-tool-name-null-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    const tail = detail === undefined ? '' : `  <- ${String(detail)}`
    console.log(`FAIL  ${name}${tail}`)
  }
}
const throws = (fn) => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

const llm = await import('../lib/core/llm.js')
const { Transcript } = await import('../lib/adapter/transcript.js')
const groups = await import(new URL('../ui-shell/src/plugins/transcript/process-groups.ts', import.meta.url).href)
const argsMod = await import(new URL('../ui-shell/src/ui-primitives/tool-args.ts', import.meta.url).href)

// ── [1] 合并层 ────────────────────────────────────────────────────────────────
{
  console.log('[1] applyToolCallDelta：null 只是「这片没给」')
  const calls = new Map()
  const prepared = []
  const apply = (delta) => llm.applyToolCallDelta(calls, delta, (name) => prepared.push(name))

  apply({ index: 0, id: 'call_1', function: { name: 'run_code', arguments: '{"co' } })
  const first = calls.get(0)
  check('首发分片落名字与参数', first.name === 'run_code' && first.arguments === '{"co', JSON.stringify(first))
  check('首发分片通知一次「准备中」', prepared.length === 1 && prepared[0] === 'run_code', prepared.join(','))

  apply({ index: 0, id: null, function: { name: null, arguments: 'de": 1}' } })
  const merged = calls.get(0)
  check('null 名字不覆盖已收到的名字', merged.name === 'run_code', String(merged.name))
  check('null ID 不覆盖已收到的 ID', merged.id === 'call_1', String(merged.id))
  check('参数继续累积', merged.arguments === '{"code": 1}', merged.arguments)
  check('名字没变→不重复报「准备中」', prepared.length === 1, String(prepared.length))

  // 第一片就是 null：名字落成空串，绝不能落成 null（那是白屏的根）
  const blank = new Map()
  llm.applyToolCallDelta(blank, { index: 1, id: null, function: { name: null, arguments: null } })
  const empty = blank.get(1)
  check('首片全 null 时各字段是空串', empty.id === '' && empty.name === '' && empty.arguments === '', JSON.stringify(empty))
  check('空名字不报「准备中」', (() => {
    const seen = []
    llm.applyToolCallDelta(new Map(), { index: 2, function: { name: null } }, (n) => seen.push(n))
    return seen.length === 0
  })())

  // 类型不是字符串的脏值（数字、对象）同样当没给
  const dirty = new Map()
  llm.applyToolCallDelta(dirty, { index: 3, id: 42, function: { name: 7, arguments: ['x'] } })
  const junk = dirty.get(3)
  check('非字符串脏值不落进调用表', junk.id === '' && junk.name === '' && junk.arguments === '', JSON.stringify(junk))
}

// ── [2] 回放层 ────────────────────────────────────────────────────────────────
{
  console.log('[2] replayHistory：老日志里的 null 读回来修成空串')
  const transcript = new Transcript()
  transcript.replayHistory([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: null, type: 'function', function: { name: null, arguments: '{"code":"x"}' } }],
    },
    { role: 'tool', content: '未知工具：null', tool_call_id: null },
  ])
  const tool = transcript.entries.find((entry) => entry.kind === 'tool')
  check('回放出了一条工具条目', tool !== undefined)
  check('名字是空串不是 null', tool !== undefined && tool.call.name === '', String(tool?.call.name))
  check('callId 是空串不是 null', tool !== undefined && tool.call.callId === '', String(tool?.call.callId))
  check('参数原文保留', tool !== undefined && tool.call.argsText === '{"code":"x"}', String(tool?.call.argsText))
}

// ── [3] 渲染纯函数 ────────────────────────────────────────────────────────────
{
  console.log('[3] 渲染纯函数：名字不是字符串也不许抛')
  const { activityOf, liveToolDetail } = groups
  check('activityOf(null) 归「通用工具」', activityOf(null) === 'tools', activityOf(null))
  check('activityOf(undefined) 归「通用工具」', activityOf(undefined) === 'tools', activityOf(undefined))
  check('activityOf(空串) 归「通用工具」', activityOf('') === 'tools', activityOf(''))
  check('正常名字照旧归一', activityOf('Bash') === 'commands' && activityOf('read') === 'read')
  check('liveToolDetail 不抛', !throws(() => liveToolDetail('', '{"path":"a"}')))

  const { toolArgFields } = argsMod
  check('toolArgFields(null) 不抛', !throws(() => toolArgFields(null, '{}')))
  check('toolArgFields(null) 判成不改文件', toolArgFields(null, '{}').mutating === false)
  check('toolArgFields(空串) 判成不改文件', toolArgFields('', '{}').mutating === false)
  check('write 照旧判成改文件', toolArgFields('write', '{"path":"a","content":"b"}').mutating === true)
}

// ── [4] 形态钉：源码里不再有裸的入口 ─────────────────────────────────────────
{
  console.log('[4] 源码形态：名字先判类型再调字符串方法')
  const llmSource = read('src/core/llm.ts')
  check('合并函数逐字段判 typeof string', llmSource.includes("typeof call.function?.name === 'string'"))
  check('旧的两道 null 漏门已消失', !llmSource.includes("name !== undefined && name !== ''"))
  check('旧 ID 漏门已消失', !llmSource.includes("call.id !== undefined && call.id !== ''"))

  const adapterSource = read('src/adapter/transcript.ts')
  check('回放路径收窄名字类型', adapterSource.includes("typeof call.function.name === 'string'"))
  check('实时事件收窄名字类型', adapterSource.includes("typeof event.name === 'string'"))

  const groupsSource = read('ui-shell/src/plugins/transcript/process-groups.ts')
  check('activityOf 收 null/undefined', groupsSource.includes('name: string | null | undefined'))
  const argsSource = read('ui-shell/src/ui-primitives/tool-args.ts')
  check('toolArgFields 收 null/undefined', argsSource.includes('name: string | null | undefined'))
}

console.log('')
console.log(failures === 0 ? `全部通过（${String(passed)} 项）` : `${String(failures)} 项失败（通过 ${String(passed)} 项）`)
process.exit(failures === 0 ? 0 : 1)
