/**
 * ops 插件的外壳自检：worker 能不能被 numa 独立驱动、七个只读工具的参数与渲染对不对。
 *
 * 钉住五件事：
 *   [1] 找得到 worker，并且**不依赖 dsh 的进程服务**就能跑通一次读；
 *   [2] read_files / stat / diff / read_table 四种返回形状都对得上（行号、修订、单元格）；
 *   [3] 只读模式下写类工具被 worker 当场拒（多一道闸，不靠调用方自觉）；
 *   [4] 工具层先过 numa 的读禁：`.env` 这类文件在到达 worker 之前就被拦下；
 *   [5] 渲染把「还有多少没显示 / 续读写法」写进结果，模型不会把半截当全文。
 *
 * 隔离：临时 HOME + 临时工作目录，真实 ~/.dsc 一个字节都不动。
 * 跑法：pnpm run build && node scripts/ops-test.mjs
 * 没装 dsh-ops 的机器上整条跳过（退出码 0，打印一句原因）。
 *
 * @module dsc/scripts/ops-test
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 隔离前先看真实家里有没有 dsh-ops：测试要的是「临时 HOME + 真 worker」，
 * 不是「两边都临时」。找到就把路径写进 DSC_OPS_WORKER，查找逻辑不用为测试开洞。
 */
const realHome = process.env.USERPROFILE ?? process.env.HOME ?? ''
const target = `${process.platform}-${process.arch}`
const workerName = process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker'
function findInstalledWorker() {
  if ((process.env.DSC_OPS_WORKER ?? '') !== '') return process.env.DSC_OPS_WORKER
  // 两处安装位置都看：设置页让人 npm install 的是 ~/.dsc/plugins，dsh 用户则在 profile 里。
  const pluginCopy = join(realHome, '.dsc', 'plugins', 'node_modules', 'dsh-ops', 'runtime', target, workerName)
  if (existsSync(pluginCopy)) return pluginCopy
  const profiles = join(realHome, '.dsh', 'profiles')
  let names = []
  try {
    names = readdirSync(profiles)
  } catch {
    return ''
  }
  for (const name of names) {
    const file = join(profiles, name, 'node_modules', 'dsh-ops', 'runtime', target, workerName)
    if (existsSync(file)) return file
  }
  return ''
}
const installed = findInstalledWorker()
if (installed !== '') process.env.DSC_OPS_WORKER = installed

const home = mkdtempSync(join(tmpdir(), 'dsc-ops-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log('  PASS ' + name)
  } else {
    fail += 1
    console.log('  FAIL ' + name + (extra === '' ? '' : ' — ' + extra))
  }
}

const { resolveOpsWorker, callOpsWorker } = await import('../lib/core/ops/worker.js')
const { createOpsTools } = await import('../lib/core/ops/tools.js')
const { renderInspect, renderTable, renderReadFiles, renderDiff } = await import('../lib/core/ops/render.js')

const found = resolveOpsWorker()
if (!found.ok) {
  console.log('跳过：' + found.reason)
  process.exit(0)
}
console.log('worker：' + found.file)
console.log('来源：' + found.source)

const work = join(home, 'work')
mkdirSync(work, { recursive: true })
const textFile = join(work, 'sample.txt')
writeFileSync(textFile, Array.from({ length: 30 }, (_, i) => 'line-' + String(i + 1)).join('\n') + '\n')
const csvFile = join(work, 'table.csv')
writeFileSync(csvFile, 'name,age\n"a, b",3\n"multi\nline",4\n')

const base = {
  file: found.file,
  cwd: work,
  scope: 'sess-ops-test',
  readOnly: true,
  timeoutMs: 20_000,
}

// ── [1] 独立读一次 ──────────────────────────────────────────────────────────
const inspected = await callOpsWorker({ ...base, tool: 'inspect_local_file', args: { path: textFile, offset: 1, limit: 3 } })
check('inspect 状态 completed', inspected.status === 'completed', JSON.stringify(inspected.error ?? inspected.status))
const firstThree = Array.isArray(inspected.items) ? inspected.items : []
check('inspect 给出 3 行且行号从 1 起', firstThree.length === 3 && firstThree[0]?.line === 1 && firstThree[2]?.line === 3)
check('inspect 回报总行数与续读位置', inspected.lineCount === 30 && inspected.nextOffset === 4)
check('inspect 回报修订号', typeof inspected.revision === 'string' && inspected.revision.length === 64)

// ── [2] 四种形状 ───────────────────────────────────────────────────────────
const many = await callOpsWorker({ ...base, tool: 'read_files', args: { files: [{ path: textFile, offset: 1, limit: 2 }, { path: csvFile }] } })
const manyItems = Array.isArray(many.items) ? many.items : []
check('read_files 交回两段', manyItems.length === 2)
check('read_files 每段自带行号与续读位置', manyItems[0]?.items?.length === 2 && manyItems[0]?.nextOffset === 3)

const st = await callOpsWorker({ ...base, tool: 'stat', args: { path: textFile } })
check('stat 报出字节数与行数', st.exists === true && st.lineCount === 30 && typeof st.bytes === 'number' && st.bytes > 0)
const missing = await callOpsWorker({ ...base, tool: 'stat', args: { path: join(work, 'nope.txt') } })
check('stat 对不存在的文件也正常收场', missing.status === 'completed' && missing.exists === false)

const diffed = await callOpsWorker({ ...base, tool: 'diff', args: { path: csvFile, content: 'name,age\n"a, b",5\n"multi\nline",4\n' } })
const diffItems = Array.isArray(diffed.items) ? diffed.items : []
check('diff 给出 -/+ 各一行', diffItems.length === 2 && diffItems[0]?.kind === 'remove' && diffItems[1]?.kind === 'add')
check('diff 标出改的是第 2 行', diffItems[0]?.line === 2)

const table = await callOpsWorker({ ...base, tool: 'read_table', args: { path: csvFile } })
check('read_table 认出两列表头', Array.isArray(table.columns) && table.columns.join('/') === 'name/age')
check('read_table 保留带引号的多行单元格', Array.isArray(table.items) && table.items.length === 2 && table.items[1]?.cells?.[0] === 'multi\nline')

// ── [3] 只读模式挡住写类 ───────────────────────────────────────────────────
const denied = await callOpsWorker({ ...base, tool: 'write_file', args: { path: join(work, 'x.txt'), content: 'x', expectedRevision: '0'.repeat(64) } })
check('只读模式下写类被拒', denied.error?.code === 'POLICY_DENIED' && denied.error?.reason === 'read-only', JSON.stringify(denied.error ?? denied.status))
check('被拒之后文件真的没落地', !existsSync(join(work, 'x.txt')))

// ── [4] 工具层读禁 ─────────────────────────────────────────────────────────
const tools = createOpsTools({ file: found.file, timeoutMs: 20_000, maxBytes: 128 * 1024 })
const inspectTool = tools.find((tool) => tool.name === 'ops_inspect_local_file')
const ctx = { cwd: work, signal: new AbortController().signal, sessionId: 'sess-ops-test', sessionPath: join(work, 's.jsonl') }
let blocked = ''
try {
  await inspectTool.run({ path: '.env' }, ctx)
} catch (error) {
  blocked = error instanceof Error ? error.message : String(error)
}
check('密钥文件在到达 worker 之前就被拦下', blocked.includes('禁止读取'), blocked)

// ── [5] 渲染与续读提示 ─────────────────────────────────────────────────────
const renderedInspect = renderInspect(inspected, { path: textFile, view: 'text' })
check('渲染带行号与正文', renderedInspect.includes('1\tline-1') && renderedInspect.includes('3\tline-3'))
check('渲染写出还有多少行、怎么续读', renderedInspect.includes('共 30 行') && renderedInspect.includes('offset=4'))

const renderedTable = renderTable(table, { path: csvFile })
check('表格渲染列出列名', renderedTable.includes('2 列：name / age'))
check('表格渲染行号在左', renderedTable.includes('1\t["a, b","3"]'))

const renderedMany = renderReadFiles(many)
check('多文件渲染给每段一个文件头', (renderedMany.match(/文件：/g) ?? []).length === 2)
const allRead = await callOpsWorker({ ...base, tool: 'read_files', args: { files: [{ path: csvFile }] } })
check('全读完之后不再谎报「还有没读完」', !renderReadFiles(allRead).includes('没读完'), renderReadFiles(allRead))

// ── [6] diff 的 offset 是 0 起，分页要说出来 ────────────────────────────────
const content = 'name,age\n"a, b",5\n"multi\nline",4\n'
const pageFirst = await callOpsWorker({ ...base, tool: 'diff', args: { path: csvFile, content, offset: 0, limit: 1 } })
check('diff offset=0 从第一条差异起', pageFirst.items?.[0]?.kind === 'remove', JSON.stringify(pageFirst.items?.[0]))
const pageSecond = await callOpsWorker({ ...base, tool: 'diff', args: { path: csvFile, content, offset: 1, limit: 1 } })
check('diff offset=1 跳过第一条', pageSecond.items?.[0]?.kind === 'add', JSON.stringify(pageSecond.items?.[0]))
const renderedPage = renderDiff(pageFirst, { path: csvFile })
check('分页 diff 写出「不完整」与续读位置', renderedPage.includes('不完整') && renderedPage.includes('offset=1'), renderedPage)

// ── [7] hex 视图不拿文本行数冒充十六进制行 ─────────────────────────────────
const hexed = await callOpsWorker({ ...base, tool: 'inspect_local_file', args: { path: textFile, view: 'hex', limit: 4 } })
const renderedHex = renderInspect(hexed, { path: textFile, view: 'hex' })
check('hex 渲染报字节数、不报「共 30 行」', renderedHex.includes('字节') && !renderedHex.includes('共 30 行'), renderedHex)


// ── [8] 写类六件：修订锚、预演、先读后写 ───────────────────────────────────
const writable = Object.fromEntries(
  createOpsTools({ file: found.file, timeoutMs: 20_000, maxBytes: 128 * 1024, readOnly: () => false })
    .map((tool) => [tool.name, tool]),
)
const rwFile = join(work, 'rw.txt')
const dryWrite = await writable.ops_write_file.run({ path: rwFile, content: 'x\n', dryRun: true }, ctx)
check('整写预演不落盘、且写明是预演', !existsSync(rwFile) && dryWrite.includes('预演'), dryWrite)
await writable.ops_write_file.run({ path: rwFile, content: 'a\nb\nc\n' }, ctx)
check('整写落地', readFileSync(rwFile, 'utf8') === 'a\nb\nc\n')

const unread = join(work, 'unread.txt')
writeFileSync(unread, 'old\n')
let unreadError = ''
try {
  await writable.ops_write_file.run({ path: unread, content: 'new\n' }, ctx)
} catch (error) {
  unreadError = error instanceof Error ? error.message : String(error)
}
check('没读过就整写会被拒', unreadError.includes('读'), unreadError)
await writable.ops_inspect_local_file.run({ path: unread }, ctx)
await writable.ops_write_file.run({ path: unread, content: 'new\n' }, ctx)
check('用过 ops 读过之后可以整写', readFileSync(unread, 'utf8') === 'new\n')

await writable.ops_edit_file.run(
  { path: rwFile, edits: [{ oldText: 'a', newText: 'A' }, { oldText: 'c', newText: 'C' }] },
  ctx,
)
check('同一个文件多处替换一次生效', readFileSync(rwFile, 'utf8') === 'A\nb\nC\n')
const dryEdit = await writable.ops_edit_file.run(
  { path: rwFile, edits: [{ oldText: 'b', newText: 'B' }], dryRun: true },
  ctx,
)
check('编辑预演不改盘', dryEdit.includes('预演') && readFileSync(rwFile, 'utf8') === 'A\nb\nC\n')

const copied = join(work, 'copied.txt')
await writable.ops_copy.run({ path: rwFile, to: copied }, ctx)
check('复制落地', readFileSync(copied, 'utf8') === 'A\nb\nC\n')
let copyError = ''
try {
  await writable.ops_copy.run({ path: rwFile, to: copied }, ctx)
} catch (error) {
  copyError = error instanceof Error ? error.message : String(error)
}
check('目标已存在时复制被拒（不悄悄覆盖）', copyError !== '', copyError)

const moved = join(work, 'moved.txt')
await writable.ops_move.run({ path: copied, to: moved }, ctx)
check('移动落地且源没了', existsSync(moved) && !existsSync(copied))
await writable.ops_remove.run({ path: moved }, ctx)
check('删除落地', !existsSync(moved))

const repDir = join(work, 'rep')
mkdirSync(repDir, { recursive: true })
writeFileSync(join(repDir, 'x.md'), 'foo foo\n')
const repDry = await writable.ops_replace.run({ path: repDir, pattern: 'foo', replacement: 'bar', dryRun: true }, ctx)
check('整目录替换预演不动盘', repDry.includes('预演') && readFileSync(join(repDir, 'x.md'), 'utf8') === 'foo foo\n', repDry)
const repRun = await writable.ops_replace.run({ path: repDir, pattern: 'foo', replacement: 'bar' }, ctx)
check('整目录替换生效并回报处数', readFileSync(join(repDir, 'x.md'), 'utf8') === 'bar bar\n' && repRun.includes('2 处'), repRun)

// ── [9] 修订锚真的能挡并发覆盖（显式传旧版本） ─────────────────────────────
const staleRevision = (await callOpsWorker({ ...base, tool: 'stat', args: { path: rwFile } })).revision
await writable.ops_write_file.run({ path: rwFile, content: 'A2\nb\nC\n' }, ctx)
let conflict = ''
try {
  await writable.ops_write_file.run({ path: rwFile, content: 'nope\n', expectedRevision: staleRevision }, ctx)
} catch (error) {
  conflict = error instanceof Error ? error.message : String(error)
}
check('显式旧版本被 REVISION_CONFLICT 挡住', conflict.includes('REVISION_CONFLICT'), conflict)
check('被挡之后内容一个字节没变', readFileSync(rwFile, 'utf8') === 'A2\nb\nC\n')

// ── [10] 复制/移动的写目标会按 to 过闸（gateAs） ────────────────────────────
const gated = writable.ops_copy.gateAs?.({ path: rwFile, to: 'relative-dest.txt' }, work)
check('gateAs 把 path 换成写目标 to', gated !== undefined && gated.args.path === join(work, 'relative-dest.txt'), JSON.stringify(gated))
check('复制/移动不再宣称支持 dryRun', writable.ops_copy.parameters.properties.dryRun === undefined && writable.ops_move.parameters.properties.dryRun === undefined && writable.ops_remove.parameters.properties.dryRun === undefined)
check('replace 回执按文件数+处数分开说', repRun.includes('改动 1 个文件') && repRun.includes('共替换 2 处'), repRun)


// ── [11] 审批卡的「将做的改动」认得 ops 写类 ────────────────────────────────
const { approvalDiffOf } = await import('../lib/packages/approval/index.js')
const preview = (toolName, args) => approvalDiffOf({ toolName, args, cwd: work, argsSummary: '' })
const beforeText = readFileSync(rwFile, 'utf8')
const writePrev = await preview('ops_write_file', { path: rwFile, content: 'X\nb\nC\n' })
check('整写预览给出 +/- 行数', writePrev?.added === 1 && writePrev?.removed === 1, JSON.stringify(writePrev))
const multiPrev = await preview('ops_edit_file', {
  path: rwFile,
  edits: [{ oldText: 'A2', newText: 'A3' }, { oldText: 'C', newText: 'D' }],
})
check('多处替换预览把两处都算进去', multiPrev?.added === 2 && multiPrev?.removed === 2, JSON.stringify(multiPrev))
const missPrev = await preview('ops_edit_file', { path: rwFile, edits: [{ oldText: '不存在的内容', newText: 'x' }] })
check('多处替换预览能报 missing', missPrev?.mismatch === 'missing')
const replacePrev = await preview('ops_replace', { path: rwFile, pattern: 'b', replacement: 'B' })
check('单文件整处替换能预览', replacePrev?.added === 1 && replacePrev?.removed === 1, JSON.stringify(replacePrev))
const copyPrev = await preview('ops_copy', { path: rwFile, to: join(work, 'fresh-copy.txt') })
check('复制预览按「新增」画目标', copyPrev?.status === 'added' && copyPrev.path === join(work, 'fresh-copy.txt'), JSON.stringify(copyPrev))
const removePrev = await preview('ops_remove', { path: rwFile })
check('删除预览按整篇删除画', removePrev?.status === 'deleted' && (removePrev?.removed ?? 0) > 0, JSON.stringify(removePrev))
const dirPrev = await preview('ops_replace', { path: work, pattern: 'b', replacement: 'B' })
check('目录替换不硬推演（退回参数摘要）', dirPrev === null)
check('预览不改动磁盘', readFileSync(rwFile, 'utf8') === beforeText)

console.log('\n' + String(pass) + ' PASS / ' + String(fail) + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
