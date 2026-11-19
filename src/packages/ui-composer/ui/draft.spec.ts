/**
 * 输入框草稿的归属与搬运（ui 层）。
 *
 * 来源（两个探针的行为段）：
 * - `scripts/ui-composer-draft-test.mjs` 第 [1][2][3][4] 段——归属怎么算、换会话搬运、
 *   用户报障的那条剧本（新会话 → 写半截 → 切走 → 再点新会话）、旧口径反向对照；
 * - `scripts/ui-composer-draft-store-test.mjs` 第 3 节——同坑不搬、刚落盘清空、跨坑搬走。
 *
 * `draft.ts` 纯函数、零 import，直接 import 跑的就是产品代码。
 *
 * 不迁的部分：两个探针的接线段（壳的 `ui.tsx` 用没用这套规则、宿主快照报 `sessionUnsaved`、
 * 契约字段、「存档住模块级」的写法钉）——渲染体 / 契约文本钉，无行为接缝，归组件渲染批，
 * 见交付报告的缺口清单。
 *
 * @module dsc-ui-composer/ui/draft.spec
 */
import { expect, test } from 'vitest'
import { carryDraft, draftScopeOf, EMPTY_DRAFT, type ComposerDraft, type DraftScope } from './draft.js'

const CWD = 'D:\\dsc'

/** 造一条归属：默认已落盘（有路径）；传 unsaved 就是「新会话」。 */
const scopeOf = (input: Partial<{ sessionPath: string; sessionId: string; cwd: string; unsaved: boolean }>): DraftScope =>
  draftScopeOf({ sessionPath: '', sessionId: '', cwd: CWD, unsaved: false, ...input })

// ── draftScopeOf：归属怎么算 ─────────────────────────────────────────────────

test('未落盘的新会话按工作区分坑（`new:<cwd>`）', () => {
  const blank = scopeOf({ sessionPath: 'C:\\x\\a.jsonl', sessionId: 's1', unsaved: true })
  expect(blank.key).toBe(`new:${CWD}`)
})

test('已落盘的会话按路径分坑，归属带着会话 uuid 与落盘状态', () => {
  const saved = scopeOf({ sessionPath: 'C:\\x\\a.jsonl', sessionId: 's1', unsaved: false })
  expect(saved.key).toBe('C:\\x\\a.jsonl')
  expect(saved.sessionId).toBe('s1')
  expect(saved.unsaved).toBe(false)
})

test('拿不到 cwd 时退回按路径分坑（宁可分开也不混）', () => {
  const noCwd = scopeOf({ sessionPath: 'C:\\x\\a.jsonl', sessionId: 's1', unsaved: true, cwd: '' })
  expect(noCwd.key).toBe('C:\\x\\a.jsonl')
})

test('另一个工作区是另一个坑', () => {
  expect(scopeOf({ sessionId: 's2', unsaved: true, cwd: 'C:\\other' }).key).toBe('new:C:\\other')
})

// ── carryDraft：换会话时的搬运 ───────────────────────────────────────────────

test('换到没写过草稿的会话：输入框清空，上一份草稿连同历史存进它自己的坑', () => {
  const store = new Map<string, ComposerDraft>()
  const a = scopeOf({ sessionPath: 'p\\A.jsonl', sessionId: 'sa' })
  const b = scopeOf({ sessionPath: 'p\\B.jsonl', sessionId: 'sb' })
  const first = carryDraft(store, a, b, { value: '在 A 里写的', history: ['旧输入'], attachments: [] })
  expect(first.value).toBe('')
  expect(first.history).toHaveLength(0)
  expect(store.get('p\\A.jsonl')?.value).toBe('在 A 里写的')
  expect(store.get('p\\A.jsonl')?.history.join('|')).toBe('旧输入')
})

test('切回 A：草稿与历史原样回来', () => {
  const store = new Map<string, ComposerDraft>()
  const a = scopeOf({ sessionPath: 'p\\A.jsonl', sessionId: 'sa' })
  const b = scopeOf({ sessionPath: 'p\\B.jsonl', sessionId: 'sb' })
  carryDraft(store, a, b, { value: '在 A 里写的', history: ['旧输入'], attachments: [] })
  const back = carryDraft(store, b, a, { value: '', history: [], attachments: [] })
  expect(back.value).toBe('在 A 里写的')
  expect(back.history.join('|')).toBe('旧输入')
})

// ── 用户报障的剧本：新会话 → 写半截 → 切走 → 再点新会话 ─────────────────────

test('两个「新会话」落在同一个坑（路径不同，坑相同）', () => {
  const blankA = scopeOf({ sessionPath: 'p\\blank-1.jsonl', sessionId: 'n1', unsaved: true })
  const blankB = scopeOf({ sessionPath: 'p\\blank-2.jsonl', sessionId: 'n2', unsaved: true })
  expect(blankA.key).toBe(blankB.key)
})

test('切走时半截话存进工作区名下；再点新会话：半截话回来了（用户报障的那一条）', () => {
  const store = new Map<string, ComposerDraft>()
  const blankA = scopeOf({ sessionPath: 'p\\blank-1.jsonl', sessionId: 'n1', unsaved: true })
  const blankB = scopeOf({ sessionPath: 'p\\blank-2.jsonl', sessionId: 'n2', unsaved: true })
  const savedB = scopeOf({ sessionPath: 'p\\B.jsonl', sessionId: 'sb' })
  // ① 新会话里写半截话，切到别的会话
  const moved = carryDraft(store, blankA, savedB, { value: '半截话：这条应该留着', history: [], attachments: [] })
  expect(store.get(`new:${CWD}`)?.value).toBe('半截话：这条应该留着')
  expect(moved.value).toBe('')
  // ② 再点一次「新会话」（新的 uuid、新的路径，但同一个工作区）
  const again = carryDraft(store, savedB, blankB, { value: '', history: [], attachments: [] })
  expect(again.value).toBe('半截话：这条应该留着')
})

test('发出第一条消息后：会话改按路径分坑、工作区那一格清空（下一个新会话不会捡到刚发出去的话）', () => {
  const store = new Map<string, ComposerDraft>()
  const blankB = scopeOf({ sessionPath: 'p\\blank-2.jsonl', sessionId: 'n2', unsaved: true })
  const savedB = scopeOf({ sessionPath: 'p\\B.jsonl', sessionId: 'sb' })
  carryDraft(store, scopeOf({ sessionPath: 'p\\blank-1.jsonl', sessionId: 'n1', unsaved: true }), savedB, {
    value: '半截话：这条应该留着',
    history: [],
    attachments: [],
  })
  carryDraft(store, savedB, blankB, { value: '', history: [], attachments: [] })
  // ③ 在新会话里把它发出去 → 这条会话落盘（sessionId 不变、unsaved 翻 false）
  const settled = scopeOf({ sessionPath: 'p\\blank-2.jsonl', sessionId: 'n2', unsaved: false })
  const afterSend = carryDraft(store, blankB, settled, { value: '', history: [], attachments: [] })
  expect(afterSend.value).toBe('')
  expect(store.get(`new:${CWD}`)?.value).toBe('')
  const later = carryDraft(store, settled, scopeOf({ sessionPath: 'p\\blank-3.jsonl', sessionId: 'n3', unsaved: true }), {
    value: '',
    history: [],
    attachments: [],
  })
  expect(later.value).toBe('')
})

test('换工作区互不串门：别的项目的新会话草稿各归各的', () => {
  const store = new Map<string, ComposerDraft>()
  const blankA = scopeOf({ sessionPath: 'p\\blank-1.jsonl', sessionId: 'n1', unsaved: true })
  const other = carryDraft(
    store,
    scopeOf({ sessionPath: '', sessionId: 'n9', unsaved: true, cwd: 'C:\\other' }),
    blankA,
    { value: '别的项目的草稿', history: [], attachments: [] },
  )
  expect(other.value).toBe('')
  expect(store.get('new:C:\\other')?.value).toBe('别的项目的草稿')
})

// ── 反向对照：按旧口径（一律按路径）分坑，剧本里那半截话会丢 ─────────────────

test('旧口径下再点新会话：草稿丢了（这套归属规则不是空转）', () => {
  const store = new Map<string, ComposerDraft>()
  // 旧口径：key 就是路径（未落盘也一样）。
  const old = (path: string): DraftScope => ({ key: path, sessionId: '', unsaved: false })
  carryDraft(store, old('p\\blank-1.jsonl'), old('p\\B.jsonl'), {
    value: '半截话：这条应该留着',
    history: [],
    attachments: [],
  })
  const again = carryDraft(store, old('p\\B.jsonl'), old('p\\blank-2.jsonl'), { value: '', history: [], attachments: [] })
  expect(again.value).toBe('')
  expect(store.get('p\\blank-1.jsonl')?.value).toBe('半截话：这条应该留着')
})

// ── 存档键的三条搬运规则（迁自 ui-composer-draft-store-test 第 3 节） ─────────

test('同一个坑：草稿跟着走，不搬运', () => {
  const store = new Map<string, ComposerDraft>()
  const unsaved = draftScopeOf({ sessionPath: '', sessionId: 's1', cwd: 'D:/w', unsaved: true })
  const same = draftScopeOf({ sessionPath: '', sessionId: 's1', cwd: 'D:/w', unsaved: true })
  const stay = carryDraft(store, unsaved, same, { value: '半截话', history: ['旧'], attachments: [] })
  expect(stay.value).toBe('半截话')
  expect(store.size).toBe(0)
})

test('刚落盘：工作区那一格清成空草稿、新会话拿到空草稿', () => {
  const store = new Map<string, ComposerDraft>()
  const unsaved = draftScopeOf({ sessionPath: '', sessionId: 's1', cwd: 'D:/w', unsaved: true })
  const settled = draftScopeOf({ sessionPath: 'a.jsonl', sessionId: 's1', cwd: 'D:/w', unsaved: false })
  const moved = carryDraft(store, unsaved, settled, { value: '半截话', history: [], attachments: [] })
  expect(store.get('new:D:/w')).toEqual(EMPTY_DRAFT)
  expect(moved.value).toBe('')
})

test('换到别的会话：装进来的是那条会话自己的草稿（没写过就是空）；切回原会话：那份草稿还在', () => {
  const store = new Map<string, ComposerDraft>([
    ['a.jsonl', { value: 'A 的半截话', history: [], attachments: [] }],
  ])
  const settled = draftScopeOf({ sessionPath: 'a.jsonl', sessionId: 's1', cwd: 'D:/w', unsaved: false })
  const other = draftScopeOf({ sessionPath: 'b.jsonl', sessionId: 's2', cwd: 'D:/w', unsaved: false })
  // 离开 A 时输入框里是 A 的正文（组件里 text 就是这份草稿），切到 B 后是空的。
  const left = carryDraft(store, settled, other, { value: 'A 的半截话', history: [], attachments: [] })
  expect(left.value).toBe('')
  const backAgain = carryDraft(store, other, settled, { value: '', history: [], attachments: [] })
  expect(backAgain.value).toBe('A 的半截话')
})

test('EMPTY_DRAFT 是空的那一份', () => {
  expect(EMPTY_DRAFT).toEqual({ value: '', history: [], attachments: [] })
})
