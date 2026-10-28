/**
 * 权限按会话隔离的内核级探针（2026-10-28）：用真 kernel + 真会话文件跑一遍
 * 「A 会话切只读 → B 会话不受影响 → 切回 A 还是只读」。
 *
 * 为什么单开一份：纯函数探针证明不了「插件读的是自己会话」。这里用临时 HOME，
 * 绝不碰真实 ~/.dsc；跑之前先 `pnpm run build`（读 lib/ 产物）。
 *
 * 运行：node scripts/session-permissions-kernel-test.mjs
 *
 * @module dsc/scripts/session-permissions-kernel-test
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-perm-kernel-'))
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

const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl: 'http://127.0.0.1:1',
        apiKey: 'k',
        models: [{ id: 'm', name: 'm', contextWindow: 100000, maxTokens: 500, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} }],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  },
  resumeSessionPath: null,
})

const sandbox = ctx.get('sandbox')
check('沙箱插件在（默认开）', sandbox !== undefined)

const a = ctx.session.current()
check('A 会话的初始权限模式是默认 auto-edit', ctx.approval.policy === 'auto-edit', ctx.approval.policy)
check('A 会话的初始沙箱档是 workspace-write', ctx.sandbox.mode === 'workspace-write', ctx.sandbox.mode)
check('A 会话第一次读就把三项钉进会话', a.state('permissions')?.policy === 'auto-edit' && a.state('permissions')?.sandbox === 'workspace-write')

ctx.permissionPresets.use('read-only')
// 出厂只读档 = 沙箱 read-only + 权限模式 auto-edit（对齐 dsh：沙箱兜住写，审批管要不要问）。
check('A 切只读后沙箱变 read-only', ctx.sandbox.mode === 'read-only', ctx.sandbox.mode)
check('A 的权限模式仍是 auto-edit（只读档的那一半是沙箱）', ctx.approval.policy === 'auto-edit', ctx.approval.policy)
check('A 的会话状态记下了只读', a.state('permissions')?.sandbox === 'read-only')

// 会话要有一条对话记录才落盘（2026-10-29：点「新会话」不再建文件），
// 后面按路径切回 A 才有东西可读。
a.appendUser('（探针）让 A 落盘')
await ctx.session.open(undefined, bDir)
const b = ctx.session.current()
check('换到 B 会话说的是 B 的会话', b.meta.cwd === bDir, b.meta.cwd)
check('B 仍是新的默认权限模式 auto-edit', ctx.approval.policy === 'auto-edit', ctx.approval.policy)
check('B 仍是新的默认沙箱 workspace-write', ctx.sandbox.mode === 'workspace-write', ctx.sandbox.mode)
check('B 的状态与 A 分开', b.state('permissions')?.sandbox === 'workspace-write' && a.state('permissions')?.sandbox === 'read-only')

ctx.permissionPresets.use('full-access')
check('B 切完全访问后权限模式与沙箱一起变', ctx.approval.policy === 'full-access' && ctx.sandbox.mode === 'danger-full-access', ctx.approval.policy + '/' + ctx.sandbox.mode)

// 会话状态是异步落盘的：等 A 的文件真的写出来再切回去。
const { existsSync } = await import('node:fs')
await new Promise((resolve) => setTimeout(resolve, 300))
check('A 的会话文件已落盘（切回去的前提）', existsSync(a.filePath), a.filePath)
await ctx.session.open(a.filePath)
check('切回 A 还是只读（会话自己的值）', ctx.approval.policy === 'auto-edit' && ctx.sandbox.mode === 'read-only', ctx.approval.policy + '/' + ctx.sandbox.mode)

// 改默认值不该动已经钉住的 A
ctx.settings.setPrefs({ defaultPolicy: 'readonly' })
check('改默认权限模式不动 A', ctx.approval.policy === 'auto-edit', ctx.approval.policy)

// 新会话拿新默认
const cDir = join(home, 'ws-c')
mkdirSync(cDir, { recursive: true })
await ctx.session.open(undefined, cDir)
check('新会话拿改过的默认值', ctx.approval.policy === 'readonly', ctx.approval.policy)

console.log('')
console.log('内核级权限隔离：' + String(failures === 0 ? '全部通过' : String(failures) + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
