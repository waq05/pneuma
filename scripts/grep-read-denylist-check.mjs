/**
 * P0-9 探针：`grep` 必须和 `read` 共用同一份「这个文件能不能读」的判定。
 *
 * 审查报告（docs/code-review/2026-11-09/06-tools-security.md:432-455）指出的活口：
 * `read` 第一件事是 `readBlockReason(file)`，`grep` 却只判大小与 `\0` 就 `fs.readFile`
 * 全文扫——一条 `grep({ pattern: "KEY", path: "." })` 能把 `.env`、`id_rsa` 的正文印进对话，
 * 而它的 `risk: 'read'` 让审批、沙箱、地板三道守卫全部 defer，连卡都不弹。
 *
 * 本探针钉六件事：
 *   [1] 目录搜索：`.env`、`*.pem` 的内容一个字都不出现，`normal.txt` 照常命中；
 *   [2] 结果里写明「跳过了几个受保护文件」，不能静默回一句「无匹配」；
 *   [3] 单文件搜索：`path: ".env"` 整条报错并给出原因（与 `read` 同一句话）；
 *   [4] 正常文件、子目录照旧能搜到（不误伤）；
 *   [5] 目录列举（`glob`）只给名字、不返回内容——这是现有设计，列名字不算读内容；
 *   [6] `edit` 同样整条拒：`.env` 上的 edit 不返回任何原文、也不落盘，普通文件照常改。
 *
 * 跑法：`node scripts/grep-read-denylist-check.mjs`
 * 不需要先 build：Node 24 默认擦除类型，直接加载 `src` 里的 `.ts` 源码。源码按 TS 的
 * NodeNext 写法把相对导入写成 `.js`（构建后才是真 `.js`），这里注册一个同步解析钩子，
 * 在 `.js` 不存在时回退到同名 `.ts`，测的就是刚改过的源码而不是旧 `lib` 产物。
 *
 * @module dsc/scripts/grep-read-denylist-check
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.endsWith('.js') && context.parentURL !== undefined) {
        return nextResolve(new URL(specifier.slice(0, -3) + '.ts', context.parentURL).href, context)
      }
      throw error
    }
  },
})

const search = await import(new URL('../src/packages/tools-default/search-tools.ts', import.meta.url).href)
// 内置 read/write/edit 的真实实现在 core（tools-default/index.ts:14 从
// `@pneuma/runtime/core/tools/fs-tools.js` 引入），这里一并按源码加载。
const fsTools = await import(new URL('../src/core/tools/fs-tools.ts', import.meta.url).href)

let passed = 0
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

const root = await mkdtemp(join(tmpdir(), 'dsc-grep-denylist-'))
const ctx = { cwd: root, signal: new AbortController().signal, sessionId: 'grep-read-denylist-check' }
const write = async (rel, text) => {
  const file = join(root, rel)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, text, 'utf8')
}
const grep = async (pattern, extra = {}) => String(await search.grepTool.run({ pattern, ...extra }, ctx))

const ENV_SECRET = 'SECRET_ENV_VALUE'
const PEM_SECRET = 'PEM_PRIVATE_MATERIAL'

try {
  await write('.env', `MODE=dev\nAPI_KEY=${ENV_SECRET}\n`)
  await write('a.pem', `-----BEGIN PRIVATE KEY-----\nAPI_KEY=${PEM_SECRET}\n-----END PRIVATE KEY-----\n`)
  await write('normal.txt', 'API_KEY=normal-ok\n')
  await write('sub/deep.txt', 'API_KEY=sub-ok\n')
  await write('only-protected/.env', `API_KEY=${ENV_SECRET}\n`)

  console.log('[1] 目录搜索：受保护文件的内容不出现，正常文件照常命中')
  const out = await grep('API_KEY')
  check('.env 的内容没被读出来', !out.includes(ENV_SECRET), out)
  check('私钥的内容没被读出来', !out.includes(PEM_SECRET), out)
  check('normal.txt 照常命中', out.includes('normal.txt:1: API_KEY=normal-ok'), out)
  check('子目录里的正常文件也命中', out.includes('sub/deep.txt:1: API_KEY=sub-ok'), out)

  console.log('[2] 跳过要计数、要说明，不能静默')
  // 目录里共有 3 个受保护文件：.env、a.pem、only-protected/.env（遍历会进子目录）。
  check('结果里写明跳过了 3 个受保护文件', out.includes('已跳过 3 个受保护文件'), out)
  check('结果里点名了 .env 与 a.pem', out.includes('.env') && out.includes('a.pem'), out)
  check('结果里说明了原因（路径护栏/凭据）', out.includes('拒读') || out.includes('受保护'), out)

  console.log('[3] 单文件搜索：受保护文件整条报错，不是静默空结果')
  let blockedMessage = ''
  try {
    await search.grepTool.run({ pattern: 'API_KEY', path: '.env' }, ctx)
  } catch (error) {
    blockedMessage = error instanceof Error ? error.message : String(error)
  }
  check('path 指向 .env 时抛错', blockedMessage !== '', blockedMessage)
  check('报错说清了原因（禁止读取）', blockedMessage.includes('禁止读取'), blockedMessage)

  console.log('[4] 正常文件不误伤')
  const single = await grep('API_KEY', { path: 'normal.txt' })
  check('单文件 grep 正常文件仍然工作', single.includes('normal.txt:1: API_KEY=normal-ok'), single)
  const only = await grep('API_KEY', { path: 'only-protected' })
  check('全是受保护文件时不说「文件不存在」', only.includes('无匹配') && only.includes('已跳过 1 个受保护文件'), only)

  console.log('[5] 目录列举：只给名字，不给内容')
  const names = String(await search.globTool.run({ pattern: '**' }, ctx))
  check('glob 能列出 .env 这个文件名', names.includes('.env'), names)
  check('glob 不返回任何文件内容', !names.includes(ENV_SECRET) && !names.includes(PEM_SECRET), names)

  console.log('[6] edit：受保护文件整条拒，普通文件照常改')
  let editResult = ''
  let editMessage = ''
  try {
    const edited = await fsTools.editTool.run({ path: '.env', old: 'MODE=dev', new: 'MODE=prod' }, ctx)
    editResult = JSON.stringify(edited)
  } catch (error) {
    editMessage = error instanceof Error ? error.message : String(error)
  }
  check('edit .env 被整条拒（与 read 同一句）', editMessage.includes('禁止读取'), editResult || editMessage)
  check('edit 的返回里不含密钥原文', !editResult.includes(ENV_SECRET) && !editMessage.includes(ENV_SECRET), editResult || editMessage)
  const envAfter = await readFile(join(root, '.env'), 'utf8')
  check('被拒后 .env 没有被改', envAfter.includes('MODE=dev') && envAfter.includes(ENV_SECRET), envAfter)

  const normalEdit = await fsTools.editTool.run({ path: 'normal.txt', old: 'normal-ok', new: 'normal-edited' }, ctx)
  check('普通文件 edit 仍然工作', String(normalEdit.text ?? '').includes('已编辑'), JSON.stringify(normalEdit))
  const normalAfter = await readFile(join(root, 'normal.txt'), 'utf8')
  check('普通文件确实改成了', normalAfter.includes('normal-edited'), normalAfter)

  // 顺带钉住 write 的现状：已存在的 .env 没有 read 台账，被「先读后写」挡住（不是本次新增的闸）。
  let writeMessage = ''
  try {
    await fsTools.writeTool.run({ path: '.env', content: 'overwritten' }, ctx)
  } catch (error) {
    writeMessage = error instanceof Error ? error.message : String(error)
  }
  check('write 覆盖 .env 被「先读后写」挡住', writeMessage.includes('没读过'), writeMessage)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('')
console.log(`PASS ${String(passed)} / FAIL ${String(failures)}`)
if (failures > 0) process.exitCode = 1
