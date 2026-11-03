/**
 * 「点新会话要看得见一行」的静态探针（2026-11-03 报障）。
 *
 * 报障原话：点「新建会话」应该有新会话出现，切走要隐藏、输入框里的字要留着；
 * 当时的毛病是**什么行都不出现**（正文其实已经切到空会话了，侧栏一片安静）。
 *
 * 钉住四件事（缺一条就不是这个行为）：
 *   [1] 契约与宿主：`SessionSummary.unsaved`，`refresh()` 只给**当前**那条没落盘的会话补一行；
 *   [2] 落盘那一刻：`dsc/changed` 的补刷守卫不能把临时行当成“已经在列表里”而提前返回；
 *   [3] 界面：临时行只是一张回执——改名 / 置顶 / 归档 / 分叉 / 拖拽 / 右键菜单一律不给；
 *   [4] 点「新会话」时把所在工作区展开，别让回执被折叠挡住。
 *
 * 每条判据都配一条“弄脏副本必须红”，红不了就是空转。
 *
 * 跑法：node scripts/ui-sessions-unsaved-row-test.mjs
 *
 * @module dsc/scripts/ui-sessions-unsaved-row-test
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else {
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
    failures += 1
  }
}
const read = (part) => readFileSync(join(root, part), 'utf8')
const dirty = (hay, from, to) => hay.split(from).join(to)

const contract = read('src/contract/session.ts')
const host = read('src/plugins/session.ts')
const ui = read('ui-shell/src/plugins/sessions/ui.tsx')

// ── [1] 契约与宿主 ────────────────────────────────────────────────────────────────
const contractHasFlag = (s) => s.includes('unsaved?: boolean')
const hostAddsRow = (s) =>
  s.includes('!session.persisted') && s.includes('unsaved: true') && s.includes('listed.unshift(')
const hostOnlyCurrent = (s) => s.includes('item.id === session.filePath') && hostAddsRow(s)

check('[1] 契约里有 unsaved 标记', contractHasFlag(contract))
check('[1] 宿主 refresh() 给当前未落盘会话补一行', hostAddsRow(host))
check('[1] 补行只认当前这条（按 filePath 去重）', hostOnlyCurrent(host))
check('[1] 契约判据对脏副本必须红', !contractHasFlag(dirty(contract, 'unsaved?: boolean', 'unsaved?: string')))
check('[1] 补行判据对脏副本必须红', !hostAddsRow(dirty(host, 'listed.unshift(', 'listed.push(')))

// ── [2] 落盘那一刻的补刷守卫 ──────────────────────────────────────────────────────
const guardSkipsUnsaved = (s) => s.includes('item.unsaved !== true')
check('[2] 补刷守卫只认已落盘的那一行', guardSkipsUnsaved(host))
check('[2] 守卫判据对脏副本必须红', !guardSkipsUnsaved(dirty(host, 'item.unsaved !== true', 'true')))

// ── [3] 临时行是只读回执 ──────────────────────────────────────────────────────────
const readsFlag = (s) => s.includes('const unsaved = session.unsaved === true')
const noMenu = (s) => s.includes('if (unsaved) return')
const noPin = (s) => s.includes('unsaved ? (') && s.includes('<span className="row-slot" />')
const noArchive = (s) => s.includes('{unsaved ? null : archived ? (')
const noRename = (s) => s.includes('if (!archived && !unsaved)')
const noDrag = (s) => s.includes('session.unsaved !== true')

check('[3] 行组件认出临时行', readsFlag(ui))
check('[3] 临时行不弹右键菜单', noMenu(ui))
check('[3] 临时行不画图钉（占位撑住行首）', noPin(ui))
check('[3] 临时行不给归档钮', noArchive(ui))
check('[3] 临时行不给双击改名', noRename(ui))
check('[3] 临时行不参与拖拽', noDrag(ui))
check('[3] 行组件判据对脏副本必须红', !readsFlag(dirty(ui, 'session.unsaved === true', 'session.unsaved')))
check('[3] 菜单判据对脏副本必须红', !noMenu(dirty(ui, 'if (unsaved) return', 'if (false) return')))
check('[3] 归档钮判据对脏副本必须红', !noArchive(dirty(ui, '{unsaved ? null : archived ? (', '{archived ? (')))
check('[3] 拖拽判据对脏副本必须红', !noDrag(dirty(ui, 'session.unsaved !== true', 'true')))

// ── [4] 点名新建时要展开所在工作区 ────────────────────────────────────────────────
const expandsOnNew = (s) => s.includes('prefs.expansion[cwd] === false')
check('[4] 点「新会话」先展开所在工作区', expandsOnNew(ui))
check('[4] 展开判据对脏副本必须红', !expandsOnNew(dirty(ui, 'prefs.expansion[cwd] === false', 'false')))

// 删工作区时别把临时行交给归档（它的路径上没有文件，整批会失败）
const skipsUnsavedOnDelete = (s) => s.includes('const real = sessionsOfGroup.filter((session) => session.unsaved !== true)')
check('[4] 删工作区跳过临时行', skipsUnsavedOnDelete(ui))
check('[4] 跳过判据对脏副本必须红', !skipsUnsavedOnDelete(dirty(ui, 'session.unsaved !== true', 'true')))

// ── [5] 点会话当场高亮（2026-11-03），点「新会话」时撤掉还没落地的高亮 ──────────────
// 高亮只认快照里的 status.sessionPath 的话，用户点完要等宿主读盘 + 推帧（30–150ms）
// 才看到「有反应」。乐观值补这一拍；而新建会话时必须把它撤掉，否则侧栏会继续亮旧行。
const optimistic = (s) => s.includes('const shownPath = pendingOpen ?? currentPath') && s.includes('setPendingOpen(id ?? null)')
check('[5] 点会话当场高亮（乐观值优先，快照到了交还真值）', optimistic(ui))
check('[5] 新会话那一拍先撤掉旧高亮', ui.includes('setPendingOpen(id ?? null)'))
check('[5] 乐观高亮判据对脏副本必须红', !optimistic(dirty(ui, 'setPendingOpen(id ?? null)', 'if (id !== undefined) setPendingOpen(id)')))

console.log('─'.repeat(24))
if (failures === 0) {
  console.log('ui-sessions-unsaved-row-test：全部绿。')
  process.exit(0)
}
console.log(`ui-sessions-unsaved-row-test：${String(failures)} 处未过。`)
process.exit(1)
