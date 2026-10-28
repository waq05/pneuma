/**
 * 模型 / 思考档位 / 协作模式「按会话」的内核级探针（2026-10-28，与权限同一批）。
 *
 * 跑法：pnpm run build && node scripts/session-model-kernel-test.mjs
 * 临时 HOME，不碰真实 ~/.dsc。
 *
 * @module dsc/scripts/session-model-kernel-test
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-model-kernel-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log('  ok  ' + label)
    return
  }
  failures += 1
  console.log('FAIL  ' + label + (extra === '' ? '' : '  <- ' + extra))
}

const { createKernel } = await import(new URL('../lib/host/kernel.js', import.meta.url).href)
const aDir = join(home, 'ws-a')
const bDir = join(home, 'ws-b')
mkdirSync(aDir, { recursive: true })
mkdirSync(bDir, { recursive: true })

const model = (id, contextWindow, thinkingLevels) => ({ id, name: id, contextWindow, maxTokens: 500, modalities: ['text'], thinkingLevels, thinkingParam: 'thinking', effortMap: {} })
const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl: 'http://127.0.0.1:1',
        apiKey: 'k',
        models: [model('m1', 100000, []), model('m2', 200000, ['low', 'high'])],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm1',
  },
  resumeSessionPath: null,
})

const a = ctx.session.current()
// 会话要有一条对话记录才落盘（2026-10-29：点「新会话」不再建文件），
// 后面按路径切回 A 才有东西可读。
a.appendUser('（探针）让 A 落盘')
check('A 初始模型是配置默认 m1', ctx.llm.model === 'm1', ctx.llm.model)
check('A 初始档位是默认', ctx.llm.effort === 'default', ctx.llm.effort)

await ctx.session.open(undefined, bDir)
const b = ctx.session.current()
// 同 A：B 也要有一条对话记录才会落盘，后面按路径切回 B 才有东西可读。
b.appendUser('（探针）让 B 落盘')
check('B 初始模型是 m1', ctx.llm.model === 'm1', ctx.llm.model)

await ctx.session.open(a.filePath)
// A 的文件还没落盘时 open 会失败，回到 B；先等 A 写出来
await new Promise((resolve) => setTimeout(resolve, 300))
if (!existsSync(a.filePath)) {
  console.log('FAIL  A 会话文件没落盘，后续用例无法继续')
  process.exit(1)
}
await ctx.session.open(a.filePath)
check('切回 A 仍是 m1', ctx.llm.model === 'm1', ctx.llm.model)

// A 换模型 + 档位
ctx.llm.setModel('test', 'm2')
ctx.llm.setEffort('high')
check('A 换成 m2', ctx.llm.model === 'm2', ctx.llm.model)
check('A 档位 high', ctx.llm.effort === 'high', ctx.llm.effort)
check('A 的上下文窗口跟着模型变 200k', ctx.llm.contextWindow === 200000, String(ctx.llm.contextWindow))

// 状态条目是异步落盘的：切走之前等它写出来，否则重开读到的是旧文件。
await new Promise((resolve) => setTimeout(resolve, 300))
await ctx.session.open(b.filePath)
check('B 仍是 m1（模型按会话隔离）', ctx.llm.model === 'm1', ctx.llm.model)
check('B 仍是 default 档位', ctx.llm.effort === 'default', ctx.llm.effort)
check('B 的窗口仍是 100k', ctx.llm.contextWindow === 100000, String(ctx.llm.contextWindow))

// 协作模式同样按会话
ctx.mode.setMode('plan')
check('B 切到计划模式', ctx.mode.mode === 'plan', ctx.mode.mode)
await new Promise((resolve) => setTimeout(resolve, 300))
await ctx.session.open(a.filePath)
check('A 仍是执行模式（模式按会话隔离）', ctx.mode.mode === 'build', ctx.mode.mode)
check('A 的模型仍是 m2', ctx.llm.model === 'm2', ctx.llm.model)
check('A 的档位仍是 high', ctx.llm.effort === 'high', ctx.llm.effort)
check('A 的模式守卫读自己的会话', ctx.mode.modeFor(a.meta.id) === 'build')

// 用量记账取的是发起会话的模型（重开 A 之后用当前那个实例，别拿启动时的旧对象）
check('A 的用量按 m2 记账', ctx.llm.modelOf(ctx.session.current()) === 'm2', ctx.llm.modelOf(ctx.session.current()))
await ctx.session.open(b.filePath)
check('B 重开后按 m1 记账', ctx.llm.modelOf(ctx.session.current()) === 'm1', ctx.llm.modelOf(ctx.session.current()))
check('B 的模式守卫读自己的会话', ctx.mode.modeFor(b.meta.id) === 'plan', ctx.mode.modeFor(b.meta.id))
await ctx.session.open(a.filePath)
check('再切回 A 仍是 m2', ctx.llm.modelOf(ctx.session.current()) === 'm2', ctx.llm.modelOf(ctx.session.current()))

console.log('')
console.log('内核级模型/档位/模式隔离：' + String(failures === 0 ? '全部通过' : String(failures) + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
