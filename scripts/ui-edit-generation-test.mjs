/**
 * S7「同一轮重答一次，用户上次的展开选择应当失效」的自检（2026-11-10）。
 *
 * 现场：`editAndResend` 先 `rewindSession` 把这条用户消息之后的内容全截掉，再 `submit` 重发。
 * 新回答拿到的轮序号与原来相同，于是 `turnFoldKey`（`会话:turn:轮`）与这一轮里每一行、
 * 每个阶段组的键（`会话:r<轮>:…` / `会话:step:r<轮>:…`）全都一模一样——上一版摊开的思考、
 * 工具卡、阶段组会被新内容原封不动继承。
 *
 * 参考实现（dsh）给整轮的展开存档带上「回答代次」（`{turn, answerStep}`），重答就换一代，
 * 旧选择自然不命中；本仓的键里没有代次，就在重答这一拍把这一轮的存档清掉。四段：
 *   [1] 清了、清在哪：两句调用都在，且都夹在 rewindSession 与 submit 之间（`ok` 之后）
 *   [2] 键的形状对：整轮用精确键 + turnFoldKey，行/组用两条按轮前缀
 *   [3] 注释写清了为什么：上方 8 行内有「轮序号」「代次」（免得后人以为多余）
 *   [4] 失败不动存档：`if (result?.ok !== true)` 的分支里没有 foldMemory
 *   [5] 清法自证（跑真代码）：精确键不误伤 turn:10，前缀只扫本轮的 r1: / step:r1:
 *
 * 为什么主要靠源码钉：`ui/` 下的 TSX 在 Node 里 import 不了（React 与别名一堆），
 * 这条改动的判定点是「哪一句、在哪个位置、带什么键」，源码文本正好是唯一真值。
 * 第 5 段例外——`fold-state.ts` 是纯逻辑，能直接 import，所以顺手让真代码把清法演一遍。
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-edit-generation-test.mjs
 *
 * @module dsc/scripts/ui-edit-generation-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveUiHalf } from './_check-runner.mjs'

const UI = resolveUiHalf('transcript')
const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

const folds = await import(new URL('../' + UI + '/fold-state.ts', import.meta.url).href)
const { clearFold, clearFoldPrefix, readFold, turnFoldKey } = folds

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

const uiSrc = read(UI + '/ui.tsx')

/** `editAndResend` 的函数体：从函数声明到后面的 `const actions: FlowActions` 之前。 */
const start = uiSrc.indexOf('const editAndResend = (')
const end = uiSrc.indexOf('const actions: FlowActions =', start)
const body = start < 0 || end < 0 ? '' : uiSrc.slice(start, end)
check('定位到 editAndResend 的函数体', body.length > 400, start < 0 || end < 0 ? '没找到函数边界' : String(body.length))

console.log('[1] 清了、清在哪（rewindSession 之后、submit 之前）')
{
  const rewindAt = body.indexOf("channel.invoke<{ ok: boolean; error?: string }>('rewindSession'")
  const guardAt = body.indexOf('if (result?.ok !== true)')
  const clearAt = body.indexOf('foldMemory.clear(')
  const prefixesAt = body.indexOf('foldMemory.clearPrefixes(')
  const submitAt = body.indexOf("channel.invoke('submit'")

  check('四个定位点都找到了', rewindAt >= 0 && guardAt >= 0 && clearAt >= 0 && prefixesAt >= 0 && submitAt >= 0,
    JSON.stringify({ rewindAt, guardAt, clearAt, prefixesAt, submitAt }))
  check('整轮存档真的被清（foldMemory.clear( 在函数体里）', clearAt >= 0)
  check('行与阶段组的前缀真的被扫（foldMemory.clearPrefixes( 在函数体里）', prefixesAt >= 0)
  check('清整轮在 rewindSession 之后', rewindAt >= 0 && clearAt > rewindAt, `rewind=${String(rewindAt)} clear=${String(clearAt)}`)
  check('清整轮在 submit 之前', submitAt >= 0 && clearAt < submitAt, `clear=${String(clearAt)} submit=${String(submitAt)}`)
  check('扫前缀在 rewindSession 之后', rewindAt >= 0 && prefixesAt > rewindAt, `rewind=${String(rewindAt)} prefixes=${String(prefixesAt)}`)
  check('扫前缀在 submit 之前', submitAt >= 0 && prefixesAt < submitAt, `prefixes=${String(prefixesAt)} submit=${String(submitAt)}`)
  // 「ok 之后」这条单列：失败分支先 return，清存档不能跑到它前面（rewind 失败时那一轮还在，
  // 用户的选择仍然有效，动了就是把好端端的展开态平白抹掉）。
  check('清整轮在 ok 判定之后', guardAt >= 0 && clearAt > guardAt, `guard=${String(guardAt)} clear=${String(clearAt)}`)
  check('扫前缀在 ok 判定之后', guardAt >= 0 && prefixesAt > guardAt, `guard=${String(guardAt)} prefixes=${String(prefixesAt)}`)
  // 整轮那一格只能精确清：`turn:1` 当前缀会把 `turn:10` 一起清掉（第 5 段用真代码演一遍）。
  const clearLine = body.split('\n').find((line) => line.includes('foldMemory.clear(')) ?? ''
  check('整轮存档用的是精确键（那一行带 turnFoldKey）', clearLine.includes('turnFoldKey'), clearLine.trim())
  check('整轮存档那一行不是按前缀扫（turnFoldKey 不许出现在 clearPrefixes 里）',
    !clearLine.includes('clearPrefixes') && !body.includes('clearPrefixes([turnFoldKey'), clearLine.trim())
}

console.log('[2] 键的形状对（整轮 `…:turn:轮`，行 `…:r<轮>:`，组 `…:step:r<轮>:`）')
{
  check('行前缀是 `${sid}:r${String(keep)}:`', body.includes('`${sid}:r${String(keep)}:`'))
  check('阶段组前缀是 `${sid}:step:r${String(keep)}:`', body.includes('`${sid}:step:r${String(keep)}:`'))
  // 两条前缀必须同一批交出去：分两次调用会在中间留出「行清了、组没清」的窗口。
  check('两条前缀在同一次 clearPrefixes 调用里',
    /foldMemory\.clearPrefixes\(\[\s*`\$\{sid\}:r\$\{String\(keep\)\}:`\s*,\s*`\$\{sid\}:step:r\$\{String\(keep\)\}:`\s*,?\s*\]\)/.test(body))
  check('轮序号取 keep（这条消息之前的人打用户消息数）', body.includes('turnFoldKey(sid || null, keep)'), '')
  // 键形状与 fold-state.ts 的真实现对齐——前缀拼错了不会报错，只会静默清不掉。
  const foldStateSrc = read(UI + '/fold-state.ts')
  check(
    '前缀形状与真实的键对得上（fold-state.ts 的注释口径）',
    foldStateSrc.includes('会话id:r<轮>:<类型>:<序号>') && foldStateSrc.includes('会话id:step:r<轮>:'),
  )
  check('整轮键是 `会话:turn:轮`（turnFoldKey 的真实现没变）', turnFoldKey('s', 3) === 's:turn:3' && turnFoldKey(null, 3) === ':turn:3')
  check('sid 与会话 id 同一口径（sessionId ?? \'\'，与渲染层的键对齐）', body.includes("const sid = sessionId ?? ''"))
}

console.log('[3] 注释写清了为什么（免得后人当成多余的一句）')
{
  const clearAt = body.indexOf('foldMemory.clear(')
  const above = clearAt < 0 ? '' : body.slice(0, clearAt).split('\n').slice(-9, -1).join('\n')
  check('清存档上方 8 行内提到「轮序号」', above.includes('轮序号'), above.trim().slice(-120))
  check('清存档上方 8 行内提到「代次」（说明这是代次的近似）', above.includes('代次'), above.trim().slice(-120))
  check('注释点明「重答后轮序号不变」（键会一模一样的原因）', /轮序号不变|轮序号与原来相同/.test(above))
}

console.log('[4] 失败不动存档（rewind 失败时那一轮还在，用户的选择还有效）')
{
  const guardAt = body.indexOf('if (result?.ok !== true)')
  const branch = guardAt < 0 ? '' : (body.slice(guardAt).match(/if \(result\?\.ok !== true\) \{([\s\S]{0,400}?)\n {8}\}/) ?? [])[1] ?? ''
  check('取到 ok 失败分支的正文', branch.length > 0, branch.trim())
  check('失败分支里有 toastErr + return', branch.includes('toastErr(') && branch.includes('return'))
  check('失败分支里没有 foldMemory（失败当场收手）', !branch.includes('foldMemory'), branch.trim())
}

console.log('[5] 清法自证（真代码）：精确键不误伤 turn:10，前缀只扫本轮的 r1:/step:r1:')
{
  // 造一份「第 1 轮 + 第 10 轮」的存档：清第 1 轮时第 10 轮必须一条不少。
  const keys = ['s:turn:1', 's:turn:10', 's:r1:think:0', 's:r10:think:0', 's:step:r1:think:0', 's:step:r10:think:0']
  const { writeFold } = folds
  for (const key of keys) writeFold(key, true)
  const nobody = (key) => readFold(key, false) === false

  clearFold(turnFoldKey('s', 1))
  check('清之后整轮那一格回到兜底（readFold 见不到存档）', !readFold('s:turn:1', false))
  check('精确键不误伤第 10 轮（turn:10 仍是展开）', readFold('s:turn:10', false) === true)
  // 反证：如果照前缀清整轮，turn:10 会被一起清掉——这就是必须用 clear 的理由。
  const removed = clearFoldPrefix(['s:turn:1'])
  check('反证：`turn:1` 当前缀会连 turn:10 一起清（所以整轮必须精确清）', removed === 1 && nobody('s:turn:10'))

  // 行与组：前缀 `s:r1:` 不匹配 `s:r10:`（冒号挡住了位数），只扫本轮。
  for (const key of keys) writeFold(key, true)
  clearFoldPrefix(['s:r1:', 's:step:r1:'])
  check('第 1 轮的行存档被清（r1:think:0）', nobody('s:r1:think:0'))
  check('第 1 轮的阶段组存档被清（step:r1:think:0）', nobody('s:step:r1:think:0'))
  check('第 10 轮的行存档没被误伤（r10:think:0）', readFold('s:r10:think:0', false) === true)
  check('第 10 轮的阶段组存档没被误伤（step:r10:think:0）', readFold('s:step:r10:think:0', false) === true)
  // 收尾：把这批探针键抹干净，免得同进程里别的段读到脏存档（本探针不共享，稳妥起见）。
  clearFoldPrefix(['s:turn:', 's:r', 's:step:'])
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
