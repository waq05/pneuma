/**
 * 输入框草稿归属的确定性探针（0.6.70 修「新会话里写的半截话切走就没了」）。
 *
 * 用户报障：新建会话 → 在输入框写半截话 → 切到别的会话 → 再点「新会话」，话不见了。
 * 根因：草稿按会话 jsonl 路径分坑，而没落盘的新会话没有稳定身份（路径每次都换、切走即从
 * 侧栏消失）。修法：**没发过消息的会话按工作区分坑**（`new:<cwd>`），发出第一条消息后
 * 改按路径分坑、工作区那一格清空。
 *
 * 四段：
 *   [1] `draftScopeOf`：未落盘按工作区、已落盘按路径、缺 cwd 时的降级；
 *   [2] `carryDraft`：换会话搬运 + **用户那条路径的复现**（走一趟完整剧本）；
 *   [3] 反向对照：按旧口径（一律按路径）分坑，剧本里那半截话会丢——证明本探针不是空转；
 *   [4] 接线钉：壳的输入框用这套规则、宿主快照报 `sessionUnsaved`、契约里有这个字段。
 *
 * 运行：node scripts/ui-composer-draft-test.mjs（纯 Node 类型擦除直读 .ts，零依赖）
 *
 * @module dsc/scripts/ui-composer-draft-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const draft = await import(new URL('../ui-shell/src/plugins/composer/draft.ts', import.meta.url).href)
const { draftScopeOf, carryDraft, EMPTY_DRAFT } = draft

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
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

const CWD = 'D:\\dsc'
const scopeOf = (input) => draftScopeOf({ sessionPath: '', sessionId: '', cwd: CWD, unsaved: false, ...input })

console.log('[1] draftScopeOf：归属怎么算')
{
  const blank = scopeOf({ sessionPath: 'C:\\x\\a.jsonl', sessionId: 's1', unsaved: true })
  check('未落盘的新会话按工作区分坑', blank.key === `new:${CWD}`, blank.key)
  const saved = scopeOf({ sessionPath: 'C:\\x\\a.jsonl', sessionId: 's1', unsaved: false })
  check('已落盘的会话按路径分坑', saved.key === 'C:\\x\\a.jsonl', saved.key)
  check('归属带着会话 uuid 与落盘状态', saved.sessionId === 's1' && saved.unsaved === false, JSON.stringify(saved))
  const noCwd = scopeOf({ sessionPath: 'C:\\x\\a.jsonl', sessionId: 's1', unsaved: true, cwd: '' })
  check('拿不到 cwd 时退回按路径分坑（宁可分开也不混）', noCwd.key === 'C:\\x\\a.jsonl', noCwd.key)
  const other = scopeOf({ sessionPath: '', sessionId: 's2', unsaved: true, cwd: 'C:\\other' })
  check('另一个工作区是另一个坑', other.key === 'new:C:\\other', other.key)
}

console.log('[2] carryDraft：换会话时的搬运')
{
  const store = new Map()
  const a = scopeOf({ sessionPath: 'p\\A.jsonl', sessionId: 'sa' })
  const b = scopeOf({ sessionPath: 'p\\B.jsonl', sessionId: 'sb' })
  const first = carryDraft(store, a, b, { value: '在 A 里写的', history: ['旧输入'] })
  check('换到没写过草稿的会话：输入框清空', first.value === '' && first.history.length === 0, JSON.stringify(first))
  check('上一份草稿存进了它自己的坑', store.get('p\\A.jsonl')?.value === '在 A 里写的', JSON.stringify(store.get('p\\A.jsonl')))
  check('输入历史跟着一起存', store.get('p\\A.jsonl')?.history.join('|') === '旧输入', JSON.stringify(store.get('p\\A.jsonl')))
  const back = carryDraft(store, b, a, { value: '', history: [] })
  check('切回 A：草稿与历史原样回来', back.value === '在 A 里写的' && back.history.join('|') === '旧输入', JSON.stringify(back))
}

console.log('[3] 用户那条路径的剧本（新会话 → 写半截 → 切走 → 再点新会话）')
{
  const store = new Map()
  const blankA = scopeOf({ sessionPath: 'p\\blank-1.jsonl', sessionId: 'n1', unsaved: true })
  const blankB = scopeOf({ sessionPath: 'p\\blank-2.jsonl', sessionId: 'n2', unsaved: true })
  const savedB = scopeOf({ sessionPath: 'p\\B.jsonl', sessionId: 'sb' })
  check('两个「新会话」落在同一个坑（路径不同，坑相同）', blankA.key === blankB.key, `${blankA.key} / ${blankB.key}`)
  // ① 新会话里写半截话，切到别的会话
  const moved = carryDraft(store, blankA, savedB, { value: '半截话：这条应该留着', history: [] })
  check('切到别的会话：那一份存在工作区名下', store.get(`new:${CWD}`)?.value === '半截话：这条应该留着', JSON.stringify([...store]))
  check('切到别的会话：输入框换成了那个会话的草稿（空）', moved.value === '', JSON.stringify(moved))
  // ② 再点一次「新会话」（新的 uuid、新的路径，但同一个工作区）
  const again = carryDraft(store, savedB, blankB, { value: '', history: [] })
  check('再点新会话：半截话回来了（用户报障的那一条）', again.value === '半截话：这条应该留着', JSON.stringify(again))
  // ③ 在新会话里把它发出去 → 这条会话落盘 → 工作区那一格清掉
  const settled = scopeOf({ sessionPath: 'p\\blank-2.jsonl', sessionId: 'n2', unsaved: false })
  const afterSend = carryDraft(store, blankB, settled, { value: '', history: [] })
  check('发出第一条消息后：会话改按路径分坑', afterSend.value === '', JSON.stringify(afterSend))
  check('工作区那一格清空（下一 个新会话不会捡到刚发出去的话）', store.get(`new:${CWD}`)?.value === '', JSON.stringify(store.get(`new:${CWD}`)))
  const later = carryDraft(store, settled, scopeOf({ sessionPath: 'p\\blank-3.jsonl', sessionId: 'n3', unsaved: true }), { value: '', history: [] })
  check('之后的新会话拿到的是空白（不会重现已发出的话）', later.value === '', JSON.stringify(later))
  // ④ 换工作区互不串门
  const other = carryDraft(store, scopeOf({ sessionPath: '', sessionId: 'n9', unsaved: true, cwd: 'C:\\other' }), blankA, { value: '别的项目的草稿', history: [] })
  check('另一个工作区的新会话草稿各归各的', other.value === '', JSON.stringify(other))
  check('别的项目那份存进它自己的坑', store.get('new:C:\\other')?.value === '别的项目的草稿', JSON.stringify([...store.keys()]))
}

console.log('[4] 反向对照：按旧口径（一律按路径）分坑，剧本里那半截话会丢')
{
  const store = new Map()
  // 旧口径：key 就是路径（未落盘也一样）
  const old = (path) => ({ key: path, sessionId: '', unsaved: false })
  const blankA = old('p\\blank-1.jsonl')
  const blankB = old('p\\blank-2.jsonl')
  carryDraft(store, blankA, old('p\\B.jsonl'), { value: '半截话：这条应该留着', history: [] })
  const again = carryDraft(store, old('p\\B.jsonl'), blankB, { value: '', history: [] })
  check('旧口径下再点新会话：草稿丢了（本探针不是空转）', again.value === '', JSON.stringify(again))
  check('旧口径下那一份被存在已废弃的路径名下', store.get('p\\blank-1.jsonl')?.value === '半截话：这条应该留着', JSON.stringify([...store.keys()]))
}

console.log('[5] 接线钉：壳、宿主、契约三处')
{
  const composer = read('ui-shell/src/plugins/composer/ui.tsx')
  check('输入框用 draftScopeOf 算归属', composer.includes('draftScopeOf({'), '')
  check('输入框用 carryDraft 搬运（不再自己 set/get）', composer.includes('carryDraft(drafts.current'), '')
  check(
    '输入框不再按裸路径当草稿键（没有 draftKeyRef 那套）',
    !composer.includes('draftKeyRef') && !/drafts\.current\.set\(draftKey\b/.test(composer),
    '',
  )
  check('三个新选择器都接上了', ['readSessionId', 'readDraftCwd', 'readSessionUnsaved'].every((name) => composer.includes(`function ${name}(`)), '')
  const host = read('src/plugins/transcript.ts')
  check('宿主快照报 sessionUnsaved（按 messages 是否为空）', /sessionUnsaved:\s*ctx\.session\.current\(\)\.messages\.length === 0/.test(host), '')
  const contract = read('src/contract.ts')
  check('契约里声明了 sessionUnsaved 并写了为什么', /sessionUnsaved\?: boolean/.test(contract) && contract.includes('sessionUnsaved?: boolean'), '')
  check('draft.ts 是零依赖纯模块（不 import 任何东西）', !/^import /m.test(read('ui-shell/src/plugins/composer/draft.ts')), '')
  check('EMPTY_DRAFT 是空的那一份', EMPTY_DRAFT.value === '' && EMPTY_DRAFT.history.length === 0, JSON.stringify(EMPTY_DRAFT))
}

console.log(`\n输入框草稿：${String(passed)}/${String(passed + failures)} 通过`)
process.exit(failures === 0 ? 0 : 1)
