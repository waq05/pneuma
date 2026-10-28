/**
 * 输入区草稿「进程内留得住」的探针。
 *
 * 报障现场：新会话里打了一半的话，去侧栏的「技能 / 插件」页看一眼再回来，话没了。
 * 根因是草稿只存在组件的 useRef 里，输入区随页面切换被卸载重挂，state 一没就全空。
 * 用户 2026-10-29 明确「先不做跨重启」，所以存档只放在模块级 Map 里。
 *
 * 三组断言：
 *   [1] 源码钉：存档是模块级常量，组件只 useRef 过去；组件里不再 new Map。
 *   [2] 源码钉：有「随打随存」的 effect，且它声明在「换会话搬运」那段之前
 *       （effect 按声明顺序跑，顺序反了旧正文会被写进新会话那一格）。
 *   [3] 行为：draft.ts 的搬运规则没被这次改动带坏（同坑不搬、跨坑搬走）。
 *
 * 用法：node scripts/ui-composer-draft-store-test.mjs
 *
 * @module dsc/scripts/ui-composer-draft-store-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
// 源码统一换成 LF：仓库里部分文件是 CRLF，按位置比较不能因为换行符误判。
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, root)), 'utf8').replace(/\r\n/g, '\n')
const modUrl = (rel) => new URL(rel, root).href

let failures = 0
let passes = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    passes += 1
    console.log('PASS  ' + label)
    return
  }
  failures += 1
  console.log('FAIL  ' + label + (extra === '' ? '' : ' — ' + extra))
}

const composer = read('ui-shell/src/plugins/composer/ui.tsx')

console.log('1. 源码钉：存档住模块级，组件只借用')
{
  check('模块级 DRAFT_STORE 存在', /^const DRAFT_STORE = new Map</m.test(composer))
  check('组件用 useRef(DRAFT_STORE) 而不是自建一份', composer.includes('useRef(DRAFT_STORE)'))
  check(
    '组件里不再 new Map<string, ComposerDraft>()',
    !composer.includes('useRef(new Map<string, ComposerDraft>())'),
  )
  check('存档键沿用 draft.ts 的归属规则', composer.includes('draftScopeOf({'))
}

console.log('2. 源码钉：随打随存，且排在换会话搬运之前')
{
  const saveAt = composer.indexOf('DRAFT_STORE.set(key, { value: text')
  const carryAt = composer.indexOf('const next = carryDraft(drafts.current')
  check('有随打随存的 effect', saveAt > 0, String(saveAt))
  check('它在换会话那一段之前声明', saveAt > 0 && carryAt > 0 && saveAt < carryAt, `${String(saveAt)} vs ${String(carryAt)}`)
  check('挂回来时会捡回存档（只捡一次）', composer.includes('const restored = useRef(false)') && composer.includes('DRAFT_STORE.get(key)'))
  check('存档里存的是正文 + 历史 + 附件', composer.includes('{ value: text, history: history.current, attachments }'))
}

console.log('3. 行为：draft.ts 的搬运规则没被带坏')
{
  const { carryDraft, draftScopeOf, EMPTY_DRAFT } = await import(modUrl('ui-shell/src/plugins/composer/draft.ts'))
  const unsaved = draftScopeOf({ sessionPath: '', sessionId: 's1', cwd: 'D:/w', unsaved: true })
  check('未落盘按工作区归类', unsaved.key === 'new:D:/w', unsaved.key)
  const same = draftScopeOf({ sessionPath: '', sessionId: 's1', cwd: 'D:/w', unsaved: true })
  const store = new Map()
  const stay = carryDraft(store, unsaved, same, { value: '半截话', history: ['旧'], attachments: [] })
  check('同一个坑：草稿跟着走，不搬运', stay.value === '半截话' && store.size === 0)
  const settled = draftScopeOf({ sessionPath: 'a.jsonl', sessionId: 's1', cwd: 'D:/w', unsaved: false })
  const moved = carryDraft(store, unsaved, settled, { value: '半截话', history: [], attachments: [] })
  check('刚落盘：工作区那一格清空、新会话拿到空草稿', store.get('new:D:/w') === EMPTY_DRAFT && moved.value === '', JSON.stringify([...store.keys()]))
  const other = draftScopeOf({ sessionPath: 'b.jsonl', sessionId: 's2', cwd: 'D:/w', unsaved: false })
  const store2 = new Map([['a.jsonl', { value: 'A 的半截话', history: [], attachments: [] }]])
  // 离开 A 时输入框里是 A 的正文（组件里 text 就是这份草稿），切到 B 后是空的。
  const left = carryDraft(store2, settled, other, { value: 'A 的半截话', history: [], attachments: [] })
  check('换到别的会话：装进来的是那条会话自己的草稿（没写过就是空）', left.value === '')
  const backAgain = carryDraft(store2, other, settled, { value: '', history: [], attachments: [] })
  check('切回原会话：那份草稿还在', backAgain.value === 'A 的半截话', backAgain.value)
}

console.log('')
console.log(failures === 0 ? `ALL PASS ${String(passes)} 项` : `FAIL ${String(failures)} 项 / 共 ${String(passes + failures)} 项`)
process.exit(failures === 0 ? 0 : 1)
