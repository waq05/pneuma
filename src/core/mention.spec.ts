/**
 * @ 文件提及补全的纯逻辑测试。
 *
 * 为什么这组用例值得钉：光标定位、候选排序、路径回填三件事全是「差一位/差一名」的
 * 错误——不会抛异常，只表现成「@ 补全不弹」「排出来的第一条不是我要的文件」「插入后
 * 光标卡在路径中间」。所以每条用例都用确定的字符串与确定的光标位置，断言 token、
 * start/end、caret 与返回顺序。
 *
 * `collectWorkspaceFiles` 走注入的 lister（不读真实磁盘、不依赖仓库内容），因此结果
 * 可确定；真实 fs 兜底路径与「每根最小配额」那两条分支没有覆盖，见交付报告。
 *
 * @module dsc/core/mention.spec
 */
import { basename, resolve } from 'node:path'
import { expect, test } from 'vitest'
import {
  SKIP_DIR_NAMES,
  WALK_MAX_DEPTH,
  WALK_MAX_FILES,
  collectWorkspaceFiles,
  insertMention,
  mentionQueryAt,
  rankMentionCandidates,
} from './mention.js'
import type { DirLister } from './mention.js'

/** 一个假的目录树：键是目录名（取 basename），值是这一层的条目。 */
type FakeTree = Record<string, { name: string; dir: boolean }[]>

/**
 * 造一个注入用的列举器，并记录被问过哪些目录。
 *
 * 为什么按 basename 作键：遍历传进来的是 `join(root, rel)` 的绝对路径，而测试要跨
 * Windows / Linux 跑同一个夹具，只有最后一段是平台无关的。
 */
function fakeLister(tree: FakeTree): { lister: DirLister; calls: string[] } {
  const calls: string[] = []
  const lister: DirLister = async (dir) => {
    const key = basename(dir)
    calls.push(key)
    const entries = tree[key]
    if (entries === undefined) throw new Error(`夹具里没有这个目录：${dir}`)
    return { entries }
  }
  return { lister, calls }
}

// ── mentionQueryAt ──────────────────────────────────────────────────────────

test('光标在词尾时取到 @ 后的整段 token，start 指向 @ 本身', () => {
  // start 是回填时的替换起点；指向 token 而不是 @ 会留下一个孤零零的 @。
  expect(mentionQueryAt('看下 @src/core', 12)).toEqual({ token: 'src/core', start: 3, end: 12 })
})

test('文本开头的 @ 也算提及', () => {
  // 新起一行直接敲 @ 是最常见用法；要求前面必须有空白会把开头这条判掉。
  expect(mentionQueryAt('@readme.md', 10)).toEqual({ token: 'readme.md', start: 0, end: 10 })
})

test('邮箱里的 @ 不触发', () => {
  // `a@b.com` 的 @ 前是文字；不判这条，用户每打一个邮箱就会弹出补全面板。
  expect(mentionQueryAt('a@b.com', 7)).toBeNull()
})

test('路径中间的 @ 不触发（前面不是空白）', () => {
  // 例如复制来的 `/tmp/@scope/pkg`；@ 前是斜杠，不是用户想提及文件。
  expect(mentionQueryAt('/@x', 3)).toBeNull()
})

test('token 中间有空格时返回 null', () => {
  // 空白是 token 的边界；允许空格会把后面整段正文吸进 token。
  expect(mentionQueryAt('@src file', 9)).toBeNull()
})

test('光标前的 @ 与光标之间有换行时返回 null', () => {
  // 换行同样是边界；跨行的「提及」只会是误判。
  expect(mentionQueryAt('@ab\ncd', 5)).toBeNull()
})

test('@ 前是换行时仍触发（换行算空白）', () => {
  // 与上一条互为边界：换行在 @ 之前是合法边界，在 @ 与光标之间才是阻断。
  expect(mentionQueryAt('第一行\n@abc', 8)).toEqual({ token: 'abc', start: 4, end: 8 })
})

test('@ 后面还没敲字符时 token 是空串', () => {
  // 补全面板要在这时就弹出「全部候选」，所以空 token 是合法查询而不是 null。
  expect(mentionQueryAt('@', 1)).toEqual({ token: '', start: 0, end: 1 })
})

test('多个 @ 时取离光标最近的那个', () => {
  // 拿第一个 @ 会让「@a @bc」把光标定位到已经写完的前一个提及上。
  expect(mentionQueryAt('@a @bc', 6)).toEqual({ token: 'bc', start: 3, end: 6 })
})

test('@ 前是制表符也算边界', () => {
  expect(mentionQueryAt('\t@abc', 5)).toEqual({ token: 'abc', start: 1, end: 5 })
})

test('token 长度 64 仍触发', () => {
  // 上限是「再长就把整段文字吸进来」的保险；64 是边界内。
  const text = `@${'a'.repeat(64)}`
  expect(mentionQueryAt(text, text.length)?.token).toHaveLength(64)
})

test('token 长度 65 返回 null', () => {
  // 与上一条成对：长过上限就不该弹出面板，否则粘一份长文进输入框也会触发补全。
  const text = `@${'a'.repeat(65)}`
  expect(mentionQueryAt(text, text.length)).toBeNull()
})

test('光标越界时夹到文本末尾，负数夹到开头', () => {
  // 编辑器的光标位置来自 DOM selection，偶发越界；夹取后按正常规则算而不是抛错。
  expect(mentionQueryAt('x @abc', 999)).toEqual({ token: 'abc', start: 2, end: 6 })
  expect(mentionQueryAt('x @abc', -5)).toBeNull()
})

test('文本里没有 @ 时返回 null', () => {
  expect(mentionQueryAt('普通文本', 4)).toBeNull()
})

// ── insertMention ───────────────────────────────────────────────────────────

test('选中候选后把 @token 换成 @路径并补一个尾随空格', () => {
  // 尾随空格是为了让用户接着打正文；光标落在空格之后（caret 6 + '@path ' 长度）。
  expect(insertMention('hi @sr', { token: 'sr', start: 3, end: 6 }, 'src/a.ts')).toEqual({
    text: 'hi @src/a.ts ',
    caret: 13,
  })
})

test('token 后面还有正文时保留后半段', () => {
  // 在句子中间提及文件是常态；只拼接前半段会把后面的字吃掉。
  const result = insertMention('hi @sr more', { token: 'sr', start: 3, end: 6 }, 'src/a.ts')
  expect(result.text).toBe('hi @src/a.ts  more')
  expect(result.caret).toBe(13)
})

test('只有孤零零一个 @ 时也能回填', () => {
  // 空 token 查询下用户直接回车选第一条，走的就是这条路径。
  expect(insertMention('@', { token: '', start: 0, end: 1 }, 'a.ts')).toEqual({ text: '@a.ts ', caret: 6 })
})

test('路径里的斜杠与点原样插入，不做转义', () => {
  // 路径是给人看的相对路径，转义过的形式反而认不出。
  expect(insertMention('@x', { token: 'x', start: 0, end: 2 }, 'src/core/a.ts').text).toBe('@src/core/a.ts ')
})

// ── rankMentionCandidates ───────────────────────────────────────────────────

test('空 token 时按路径深度与文件名长度给前列（浅目录优先）', () => {
  // 刚敲下 @ 时的默认顺序就是它；深目录排前面会让常用文件一次都进不了可见列表。
  expect(rankMentionCandidates(['a/b/c.ts', 'x.ts'], '')).toEqual(['x.ts', 'a/b/c.ts'])
})

test('文件名前缀命中的排第一', () => {
  // 「我打 reda 就是要 redact.ts」；前缀命中排在文件名字符串包含之前。
  expect(rankMentionCandidates(['src/user-redact.ts', 'src/redact.ts'], 'reda')).toEqual([
    'src/redact.ts',
    'src/user-redact.ts',
  ])
})

test('排序大小写不敏感', () => {
  // 用户不会在意文件名大小写；按大写打就不出候选是明显的可用性缺陷。
  expect(rankMentionCandidates(['src/README.md', 'src/other.md'], 'readme')).toEqual(['src/README.md'])
})

test('文件名命中排在「仅路径命中」之前', () => {
  expect(rankMentionCandidates(['src/redact/util.ts', 'src/util-redact.ts'], 'redact')).toEqual([
    'src/util-redact.ts',
    'src/redact/util.ts',
  ])
})

test('没有命中的文件不出现在结果里', () => {
  expect(rankMentionCandidates(['src/a.ts', 'src/b.ts'], 'zzz')).toEqual([])
})

test('limit 截断结果条数', () => {
  const files = Array.from({ length: 20 }, (_, index) => `d${String(index)}/f${String(index)}.ts`)
  expect(rankMentionCandidates(files, '', 3)).toHaveLength(3)
})

test('默认上限是 12 条', () => {
  // 面板一屏就这么多行；多给的候选只是白白遍历和传输。
  const files = Array.from({ length: 20 }, (_, index) => `d${String(index)}/f${String(index)}.ts`)
  expect(rankMentionCandidates(files, '')).toHaveLength(12)
})

test('同分时按路径字典序，顺序稳定', () => {
  // 排序不稳定会让候选在每次按键后乱跳，用户点不中想点的那条。
  expect(rankMentionCandidates(['b/x.ts', 'a/x.ts'], '')).toEqual(['a/x.ts', 'b/x.ts'])
})

test('返回原始大小写的路径，不是比较用的全小写副本', () => {
  // 返回小写路径会让插入正文的 @ 提及与真实文件名大小写不符，Linux 上直接找不到文件。
  expect(rankMentionCandidates(['src/README.md'], 'readme')).toEqual(['src/README.md'])
})

test('Windows 反斜杠路径取文件名同样有效', () => {
  // 词法层就按 `\` 也当分隔符处理，补全才能跨平台一致。
  expect(rankMentionCandidates(['src\\x.ts'], 'x')).toEqual(['src\\x.ts'])
})

// ── 常量 ────────────────────────────────────────────────────────────────────

test('遍历会剪掉依赖与构建产物目录', () => {
  // 清单里全是 node_modules 时补全等于不可用；这几个名字是最低要求。
  expect(SKIP_DIR_NAMES.has('node_modules')).toBe(true)
  expect(SKIP_DIR_NAMES.has('.git')).toBe(true)
  expect(SKIP_DIR_NAMES.has('dist')).toBe(true)
  expect(SKIP_DIR_NAMES.has('Cache')).toBe(true)
})

test('遍历预算上限固定为 4000 个文件、6 层深', () => {
  // 这两个数是「超大仓库不把补全拖死」的兜底；改了要连注释一起改，所以在这里钉一次。
  expect(WALK_MAX_FILES).toBe(4000)
  expect(WALK_MAX_DEPTH).toBe(6)
})

// ── collectWorkspaceFiles（注入 lister，不读真实磁盘） ─────────────────────

test('旧签名：不传 root 时返回相对当前目录的路径', () => {
  // TUI 的既有调用是 `collectWorkspaceFiles(lister)`；这条行为不能被多根改造改掉。
  const { lister } = fakeLister({ '.': [{ name: 'a.ts', dir: false }, { name: 'src', dir: true }], src: [{ name: 'b.ts', dir: false }] })
  return expect(collectWorkspaceFiles(lister)).resolves.toEqual(['a.ts', 'src/b.ts'])
})

test('旧签名：传 root 时结果带 root 前缀', () => {
  // root 前缀让 TUI 里的路径与真实相对路径对得上。
  const { lister } = fakeLister({ proj: [{ name: 'a.ts', dir: false }] })
  return expect(collectWorkspaceFiles(lister, 'proj')).resolves.toEqual(['proj/a.ts'])
})

test('新签名单根：path 与 label 都是相对路径（主根沿用旧行为）', async () => {
  // 主根不前缀是兼容性要求：插进正文的路径必须与以前逐字一致，否则旧会话里的 @ 提及失效。
  const { lister } = fakeLister({ 'proj-main': [{ name: 'a.ts', dir: false }] })
  const entries = await collectWorkspaceFiles(resolve('proj-main'), { lister })
  expect(entries).toHaveLength(1)
  expect(entries[0]?.path).toBe('a.ts')
  expect(entries[0]?.label).toBe('a.ts')
})

test('新签名多根：第二个根的 label 带根名前缀，path 是绝对路径', () => {
  // 非主根必须给绝对路径：工具要能直接打开它，而「相对哪个根」在正文里说不清。
  const { lister } = fakeLister({
    'proj-a': [{ name: 'a.ts', dir: false }],
    'proj-b': [{ name: 'b.ts', dir: false }],
  })
  return expect(collectWorkspaceFiles([resolve('proj-a'), resolve('proj-b')], { lister })).resolves.toEqual([
    { path: 'a.ts', root: resolve('proj-a'), label: 'a.ts' },
    { path: resolve('proj-b', 'b.ts'), root: resolve('proj-b'), label: 'proj-b/b.ts' },
  ])
})

test('嵌套的根只遍历外层一次，同一批文件不列两遍', () => {
  // 授权集合按这份清单给；重复列出会让同一文件在候选里出现两次（两种路径）。
  const { lister } = fakeLister({
    outer: [{ name: 'top.ts', dir: false }, { name: 'inner', dir: true }],
    inner: [{ name: 'deep.ts', dir: false }],
  })
  return expect(collectWorkspaceFiles([resolve('outer'), resolve('outer/inner')], { lister })).resolves.toHaveLength(2)
})

test('遍历跳过依赖、构建产物与点开头目录', () => {
  // 点开头目录（.mimosa/.zcode）与 node_modules 在字典序上排在源码前面，不剪枝就会
  // 把名额吃满，源码一条都收不进来。
  const { lister, calls } = fakeLister({
    'skip-root': [
      { name: 'node_modules', dir: true },
      { name: 'dist', dir: true },
      { name: '.cache', dir: true },
      { name: 'src', dir: true },
    ],
    src: [{ name: 'a.ts', dir: false }],
  })
  return collectWorkspaceFiles(resolve('skip-root'), { lister }).then((entries) => {
    expect(entries.map((entry) => entry.path)).toEqual(['src/a.ts'])
    expect(calls).not.toContain('node_modules')
    expect(calls).not.toContain('dist')
    expect(calls).not.toContain('.cache')
  })
})

test('某层列举失败只跳过那一层，其余目录照常返回', () => {
  // 权限不足的目录不该让整份补全清单失败——那会让 @ 完全不可用。
  const { lister } = fakeLister({
    'broken-root': [{ name: 'bad', dir: true }, { name: 'ok.ts', dir: false }],
  })
  return expect(collectWorkspaceFiles(resolve('broken-root'), { lister })).resolves.toHaveLength(1)
})

test('深度超过上限的目录不再进入', () => {
  // 深链目录（构建缓存里常见）会把 4000 条配额全吃掉；上限 6 层是兜底。
  const tree: FakeTree = { 'deep-root': [{ name: 'f0.ts', dir: false }, { name: 'd1', dir: true }] }
  for (let depth = 1; depth <= 7; depth += 1) {
    tree[`d${String(depth)}`] = [
      { name: `f${String(depth)}.ts`, dir: false },
      ...(depth < 7 ? [{ name: `d${String(depth + 1)}`, dir: true }] : []),
    ]
  }
  const { lister } = fakeLister(tree)
  return collectWorkspaceFiles(resolve('deep-root'), { lister }).then((entries) => {
    const paths = entries.map((entry) => entry.path)
    expect(paths).toContain('d1/d2/d3/d4/d5/d6/f6.ts')
    expect(paths.some((path) => path.endsWith('f7.ts'))).toBe(false)
    expect(paths).toHaveLength(7)
  })
})

test('文件总数被总预算截住', () => {
  // 共用预算是「多根加起来也不超限」的保证；漏了它，一个巨根就能让补全卡住。
  const big = Array.from({ length: WALK_MAX_FILES + 1000 }, (_, index) => ({ name: `f${String(index)}.ts`, dir: false }))
  const { lister } = fakeLister({ big })
  return expect(collectWorkspaceFiles(resolve('big'), { lister })).resolves.toHaveLength(WALK_MAX_FILES)
})

test('主根顶层目录名与额外根撞名时，额外根的前缀带上父目录名', () => {
  // 主根里的 proj/README.md 与另一个也叫 proj 的根，label 会拼成同一个字符串；
  // 用户点哪条都分不清，所以撞名时必须加父目录名区分。
  const { lister } = fakeLister({
    main: [{ name: 'proj', dir: true }],
    proj: [{ name: 'x.ts', dir: false }],
  })
  return collectWorkspaceFiles([resolve('main'), resolve('a/proj')], { lister }).then((entries) => {
    expect(entries.map((entry) => entry.label)).toEqual(['proj/x.ts', 'a-proj/x.ts'])
  })
})

test('两个额外根同名时各自加父目录名前缀', () => {
  // 两个根都叫 proj：只用根名做前缀会得到两条一模一样的 label。
  const { lister } = fakeLister({
    'main2': [{ name: 'top.ts', dir: false }],
    proj: [{ name: 'z.ts', dir: false }],
  })
  return collectWorkspaceFiles([resolve('main2'), resolve('x/proj'), resolve('y/proj')], { lister }).then((entries) => {
    expect(entries.map((entry) => entry.label)).toEqual(['top.ts', 'x-proj/z.ts', 'y-proj/z.ts'])
  })
})

test('没有任何根时返回空清单', () => {
  const { lister } = fakeLister({})
  return expect(collectWorkspaceFiles([], { lister })).resolves.toEqual([])
})
