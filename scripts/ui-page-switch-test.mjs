/**
 * 主区整页切换的回归探针（2026-11-17 修 BUG-0002：侧栏「技能 / 插件」点了不换页）。
 *
 * 根因（`src/packages/ui-sessions/ui/ui.tsx` 的 `usePageEntryAvailable`）：它把「这一页在不在」
 * 算成一个布尔存进 `useState`，而这个布尔是按**当时的** entryId 算的。切页那一帧 entryId
 * 刚从 `''` 换成 `'skills'`，state 里还是上一个 entryId 的答案（`''` 谁都匹配不上 →
 * 恒为 false），下面那条守卫
 *
 *     if (page !== null && !pageEntry) setShellPage(null)
 *
 * 就把它当成「这页的插件被停用了」，当场把人踢回对话页——点几次都没反应。
 *
 * 判据分两层：
 *   - 结构：这个 hook 必须**存帧**、每次渲染现算；不许再把布尔缓存进 state。
 *   - 口径：侧栏写的页键必须等于页包自己认的 `PAGE`，否则守卫按包 id 判「在不在」永远对不上。
 *
 * 每条判据都配一条「脏副本必须红」：把源码换回修前的写法，判据必须失败——不失败就说明
 * 这条判据在空转。
 *
 * 跑法：node scripts/ui-page-switch-test.mjs
 *
 * @module dsc/scripts/ui-page-switch-test
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`  ok  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

const read = (rel) => readFileSync(join(root, rel), 'utf8')
const sessions = read('src/packages/ui-sessions/ui/ui.tsx')

/** 取出 `function usePageEntryAvailable` 的整个函数体（到同缩进的 `}` 为止）。 */
function hookBody(source) {
  const start = source.indexOf('function usePageEntryAvailable')
  if (start < 0) return null
  const open = source.indexOf('{', start)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return null
}

const body = hookBody(sessions)

console.log('── 1. 可用性 hook 存帧、现算（不能缓存布尔）')
check('找得到 usePageEntryAvailable', body !== null)
if (body !== null) {
  check(
    '存的是启动图帧（useState(() => channel.getPluginsFrame())）',
    /useState\(\(\)\s*=>\s*channel\.getPluginsFrame\(\)\)/.test(body),
    body.slice(0, 160).replace(/\s+/g, ' '),
  )
  check(
    '不再把布尔缓存进 state（没有 useState(read)）',
    !/useState(<boolean>)?\(\s*read\s*\)/.test(body),
    '仍然在缓存按旧 entryId 算出的布尔',
  )
  check('在不在是每次渲染现算的（frame.graph.entries.some）', /entries\.some\(/.test(body))
  check('首帧之前当作「在」（frame === null 时返回 true）', /frame === null\)\s*return true/.test(body))
}

console.log('')
console.log('── 2. 守卫还在（插件被停用时要退回对话页）')
check(
  'page 非空且这页没人报名时调 setShellPage(null)',
  /if \(page !== null && !pageEntry\) setShellPage\(null\)/.test(sessions),
)

console.log('')
console.log('── 3. 页键与页包自己的 PAGE 同口径')
const pagePackages = ['ui-plugins', 'ui-skills', 'ui-superagent']
const pages = []
for (const id of pagePackages) {
  const source = read(`src/packages/${id}/ui/ui.tsx`)
  const found = /const PAGE = '([^']+)'/.exec(source)
  check(`${id} 声明了 PAGE`, found !== null)
  if (found !== null) pages.push(found[1])
  check(`${id} 把页注册进 shell.page 槽`, /slots\.register\('shell\.page'/.test(source))
}
const layout = read('src/packages/ui-layout/ui/app.tsx')
/** 侧栏/顶栏那些入口写的字面量（`setShellPage(page === 'x' ? null : 'x')` 的写法）。 */
const literals = new Set()
for (const source of [sessions, layout]) {
  for (const match of source.matchAll(/setShellPage\(page === '([^']+)'/g)) literals.add(match[1])
}
check('侧栏/顶栏至少有一个整页入口', literals.size > 0, [...literals].join('、'))
check(
  '每个入口写的页键都是某个页包的 PAGE',
  [...literals].every((name) => pages.includes(name)),
  `入口=${[...literals].join('、')}；页包 PAGE=${pages.join('、')}`,
)

console.log('')
console.log('── 4. 脏副本必须红（证明上面的判据不是空转）')
if (body !== null) {
  const dirty = sessions.replace(body, `
  const read = (): boolean => {
    const frame = channel.getPluginsFrame()
    return frame === null ? true : frame.graph.entries.some((entry) => entry.id === entryId)
  }
  const [available, setAvailable] = useState<boolean>(read)
  useEffect(() => {
    setAvailable(read())
  }, [channel, entryId])
  return available
`)
  const dirtyBody = hookBody(dirty)
  const dirtyWouldPass =
    dirtyBody !== null &&
    /useState\(\(\)\s*=>\s*channel\.getPluginsFrame\(\)\)/.test(dirtyBody) &&
    !/useState(<boolean>)?\(\s*read\s*\)/.test(dirtyBody)
  check('把布尔缓存写法换回去之后，判据 1 会红', dirtyBody !== null && !dirtyWouldPass)
}

console.log('')
console.log(`── 小结：${String(pass)} 通过 / ${String(fail)} 失败`)
process.exit(fail === 0 ? 0 : 1)
