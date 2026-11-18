/**
 * 铁律 2：界面只调宿主协议白名单里有的方法。
 *
 * 扫描面（判定）：`src/packages/ui-<包名>/ui/` 下的 `.ts` / `.tsx`，以及
 * `desktop/electron/` 下的 `.ts`。
 * 判据：`.invoke('<字面量>'` 的方法名必须在 `src/core/host-methods.ts` 的
 * `INVOKABLE_METHODS` 里；ui 侧接收者是 `channel`，desktop 侧是 `protocol`。
 *
 * 豁免（设计 §Q2 明文）：
 * - `native.invoke` / `getHostNative().invoke`：`op` 受 `NativeOp` 联合类型编译期约束；
 * - `ipcRenderer.invoke`：那是 Electron 通道名，不在 `INVOKABLE_METHODS` 命名空间。
 *
 * 跨行链式（`.invoke` 单独起行）要向上回溯最近的成员表达式拿接收者；回溯不出来的一律
 * 进 `--stats` 的「归不出类」清单，不许静默丢。
 *
 * 动态调用（首参不是字面量）必须逐条登记在 `scripts/law/manual-confirm.json`
 * （`{file, line, reason, owner}`），新增未登记即违规；登记项对不上实际调用也算违规
 * （否则改了行号就静默放行）。动态调用的登记口径按设计 §Q2 的计数面
 * （`src/**` + `desktop/electron/**` + `ui-shell/src/**` + `remote-web/src/**`），
 * 因为那张表本身就是那份「10 处」清单的账本。
 *
 * 扫描面与计数口径见 docs/research/harness-engineering/numa/design/02-quality-cicd.md §Q2。
 *
 * @module scripts/law/rules/whitelist
 */

import { lineAt, maskComments, maskStringsAndComments } from '../mask.mjs'

const UI_FILE = /^src\/packages\/ui-[^/]+\/ui\//
const DESKTOP_FILE = /^desktop\/electron\//
/** 判定与计数分离：判定只看上面两个目录，登记与计数覆盖设计说的整个面。 */
const SCAN_ROOTS = [
  { dir: 'src', exts: ['.ts', '.tsx', '.mjs'] },
  { dir: 'desktop/electron', exts: ['.ts'] },
  { dir: 'ui-shell/src', exts: ['.ts', '.tsx', '.mjs'] },
  { dir: 'remote-web/src', exts: ['.ts', '.tsx', '.mjs'] },
]
const JUDGED_RECEIVERS = new Set(['channel', 'protocol'])
const EXEMPT_RECEIVERS = new Set(['native', 'ipcRenderer', 'getHostNative()'])
const REGISTRY_FILE = 'scripts/law/manual-confirm.json'
const WHITELIST_FILE = 'src/core/host-methods.ts'

/** 从 host-methods.ts 里读出 `INVOKABLE_METHODS` 的方法名集合（先实读定义再解析）。 */
function parseWhitelist(ctx) {
  const src = ctx.readFile(WHITELIST_FILE)
  const code = maskComments(src)
  const start = code.indexOf('export const INVOKABLE_METHODS')
  if (start < 0) throw new Error(`${WHITELIST_FILE}: 找不到 export const INVOKABLE_METHODS`)
  const open = code.indexOf('[', start)
  const close = code.indexOf('] as const', open)
  if (open < 0 || close < 0) throw new Error(`${WHITELIST_FILE}: INVOKABLE_METHODS 不是数组字面量，解析失败`)
  const methods = new Set([...code.slice(open + 1, close).matchAll(/'([^']*)'/g)].map((m) => m[1]))
  for (const name of methods) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error(`${WHITELIST_FILE}: 方法名 ${JSON.stringify(name)} 不合法`)
  }
  if (methods.size < 1) throw new Error(`${WHITELIST_FILE}: 一个方法名都没解析出来，疑似解析错`)
  return methods
}

/**
 * 取 `.invoke` 前面那个成员表达式的最后一段（`a.b.channel` → `channel`）；
 * 调用表达式保留 `()`（`getHostNative()`）；回溯不出来返回 null。
 */
function memberReceiver(code, dotIndex) {
  let i = dotIndex - 1
  while (i >= 0 && /\s/.test(code[i])) i--
  if (i >= 0 && code[i] === '?') i-- // 可选链 `channel?.invoke`
  if (i < 0) return null
  const end = i
  let parens = 0
  while (i >= 0) {
    const c = code[i]
    if (c === ')') {
      parens++
      i--
      continue
    }
    if (c === '(') {
      parens--
      if (parens < 0) break
      i--
      continue
    }
    if (parens > 0) {
      i--
      continue
    }
    if (/[A-Za-z0-9_$.]/.test(c)) {
      i--
      continue
    }
    break
  }
  const text = code.slice(i + 1, end + 1).trim()
  if (text === '') return null
  let depth = 0
  let cut = 0
  for (let k = 0; k < text.length; k++) {
    const c = text[k]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === '.' && depth === 0) cut = k + 1
  }
  let core = text.slice(cut)
  if (core.endsWith(')')) {
    let d = 0
    let k = core.length - 1
    for (; k >= 0; k--) {
      if (core[k] === ')') d++
      else if (core[k] === '(') {
        d--
        if (d === 0) break
      }
    }
    core = core.slice(0, k)
    const dot = core.lastIndexOf('.')
    if (dot >= 0) core = core.slice(dot + 1)
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(core)) return null
    return `${core}()`
  }
  const dot = core.lastIndexOf('.')
  if (dot >= 0) core = core.slice(dot + 1)
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(core) ? core : null
}

/** 取首参：返回 { name } 或者 { dynamic: true }。模板串带 `${` 也算动态。 */
function firstArg(code, openParen) {
  let a = openParen + 1
  while (a < code.length && /\s/.test(code[a])) a++
  const quote = code[a]
  if (quote !== "'" && quote !== '"' && quote !== '`') return { dynamic: true }
  let end = a + 1
  while (end < code.length) {
    if (code[end] === '\\') {
      end += 2
      continue
    }
    if (code[end] === quote) break
    end++
  }
  const raw = code.slice(a + 1, end)
  if (quote === '`' && raw.includes('${')) return { dynamic: true }
  return { name: raw }
}

/** 在遮罩过注释与字符串的代码里定位 `.invoke[<泛型>](...)`，首参名称回原文取。 */
function findInvokes(src, file) {
  const code = maskStringsAndComments(src)
  const re = /\.invoke\b/g
  const calls = []
  let m
  while ((m = re.exec(code))) {
    let j = m.index + m[0].length
    while (j < code.length && /\s/.test(code[j])) j++
    if (code[j] === '<') {
      let depth = 0
      for (; j < code.length; j++) {
        if (code[j] === '<') depth++
        else if (code[j] === '>') {
          depth--
          if (depth === 0) {
            j++
            break
          }
        }
      }
      while (j < code.length && /\s/.test(code[j])) j++
    }
    if (code[j] !== '(') continue // `.invoke.bind(...)`、`x.invoke = ...` 不是调用
    // 遮罩把字符串内容抹了但长度没变，所以同一个下标在原文里就是那个首参。
    const arg = firstArg(src, j)
    calls.push({
      file,
      line: lineAt(src, m.index),
      receiver: memberReceiver(code, m.index),
      name: arg.name ?? null,
      dynamic: arg.dynamic === true,
    })
  }
  return calls
}

/** 读登记表；文件不存在按空表（自测临时仓库就是这种情况），坏了退 2。 */
function readRegistry(ctx) {
  let raw
  try {
    raw = ctx.readFile(REGISTRY_FILE)
  } catch {
    return { entries: [], present: false }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${REGISTRY_FILE}: JSON 解析失败（${error instanceof Error ? error.message : String(error)}）`)
  }
  const entries = Array.isArray(parsed) ? parsed : parsed?.entries
  if (!Array.isArray(entries)) throw new Error(`${REGISTRY_FILE}: 缺 entries 数组`)
  for (const entry of entries) {
    if (typeof entry?.file !== 'string' || entry.file === '') throw new Error(`${REGISTRY_FILE}: 有条目缺 file`)
    if (!Number.isInteger(entry.line) || entry.line < 1) throw new Error(`${REGISTRY_FILE}: ${entry.file} 缺合法 line`)
    if (typeof entry.reason !== 'string' || entry.reason === '') throw new Error(`${REGISTRY_FILE}: ${entry.file} 缺 reason`)
    if (typeof entry.owner !== 'string' || entry.owner === '') throw new Error(`${REGISTRY_FILE}: ${entry.file} 缺 owner`)
  }
  return { entries, present: true }
}

function listScanFiles(ctx) {
  const files = []
  const seen = new Set()
  for (const { dir, exts } of SCAN_ROOTS) {
    for (const file of ctx.listFiles(dir, { exts })) {
      if (seen.has(file)) continue
      seen.add(file)
      files.push(file)
    }
  }
  return files
}

function check(ctx) {
  const methods = parseWhitelist(ctx)
  const registry = readRegistry(ctx)
  const violations = []
  const stats = {
    filesScanned: 0,
    whitelistMethods: methods.size,
    total: 0,
    byReceiver: {},
    exempt: {},
    dynamic: 0,
    dynamicCalls: [],
    unclassified: 0,
    unclassifiedCalls: [],
    scope: { uiFiles: 0, desktopFiles: 0, judgedCalls: 0 },
    registry: { present: registry.present, entries: registry.entries.length, matched: 0 },
  }
  const matchedEntries = new Set()

  for (const file of listScanFiles(ctx)) {
    stats.filesScanned++
    const src = ctx.readFile(file)
    const isUi = UI_FILE.test(file)
    const isDesktop = DESKTOP_FILE.test(file)
    const judged = isUi || isDesktop
    if (isUi) stats.scope.uiFiles++
    if (isDesktop) stats.scope.desktopFiles++
    for (const call of findInvokes(src, file)) {
      stats.total++
      if (call.dynamic) {
        stats.dynamic++
        stats.dynamicCalls.push({ file: call.file, line: call.line, receiver: call.receiver })
        const match = registry.entries.find((entry) => entry.file === call.file && entry.line === call.line)
        if (match) matchedEntries.add(`${match.file}:${match.line}`)
        else {
          violations.push({
            file: call.file,
            line: call.line,
            message: `动态调用未登记（首参不是字面量）：${call.receiver ?? '?'}.invoke(...)，请登记到 ${REGISTRY_FILE}`,
          })
        }
      } else if (call.receiver === null) {
        stats.unclassified++
        stats.unclassifiedCalls.push({ file: call.file, line: call.line })
      } else {
        stats.byReceiver[call.receiver] = (stats.byReceiver[call.receiver] ?? 0) + 1
        if (!judged) continue
        if (!JUDGED_RECEIVERS.has(call.receiver)) continue
        stats.scope.judgedCalls++
        if (!methods.has(call.name)) {
          violations.push({
            file: call.file,
            line: call.line,
            message: `${call.receiver}.invoke('${call.name}')：协议没这个方法，加白名单或改用现有方法`,
          })
        }
      }
    }
  }

  for (const entry of registry.entries) {
    const key = `${entry.file}:${entry.line}`
    if (!matchedEntries.has(key)) {
      violations.push({
        file: entry.file,
        line: entry.line,
        message: `登记项没有对应的动态调用（行号漂移或调用已删），更新 ${REGISTRY_FILE}`,
      })
    }
  }
  stats.registry.matched = matchedEntries.size

  const partitionSum =
    Object.values(stats.byReceiver).reduce((sum, n) => sum + n, 0) + stats.dynamic + stats.unclassified
  stats.partitionSum = partitionSum
  stats.exempt = Object.fromEntries(
    Object.entries(stats.byReceiver).filter(([receiver]) => EXEMPT_RECEIVERS.has(receiver)),
  )
  return { violations, stats }
}

export default {
  id: 'whitelist',
  title: '界面只调 INVOKABLE_METHODS 白名单里的方法',
  severity: 'error',
  check,
}
