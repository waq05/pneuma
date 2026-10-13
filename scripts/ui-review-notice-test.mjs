/**
 * 「文件更改预览」通知（宿主 file-review 插件在写盘前发的那段多行 diff 纯文本）
 * 的确定性探针。
 *
 * 三段：
 *   1. **纯解析**——横幅识别 / 头行三件（动作 / 路径 / 计数）/ 逐行四类判定 /
 *      说明行不当作 diff（模型按 Node 类型擦除直读
 *      `ui-shell/src/plugins/transcript/review-notice.ts`，不需要先 build）；
 *   2. **契约漂移钉**——壳看到的是宿主拼出来的**纯文本**，两边的字面量各持一份：
 *      探针直读宿主源文件，把壳常量与宿主模板逐字对上（漂了要红，否则界面上
 *      认不出这条通知，几十行 diff 又会走回居中的 `.entry-system`）；
 *   3. **壳侧接线钉**——对话流与轨迹页确实把这条通知交给卡片渲染（文本钉：
 *      它们是结构约定，不是可单位化的纯函数）。
 *
 * 运行：node scripts/ui-review-notice-test.mjs
 *
 * @module dsc/scripts/ui-review-notice-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const model = await import(
  new URL('../ui-shell/src/plugins/transcript/review-notice.ts', import.meta.url).href
)
const {
  REVIEW_NOTICE_BANNER,
  REVIEW_ACTION_TEXT,
  isReviewNotice,
  parseReviewNotice,
  reviewLineKindOf,
} = model

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let total = 0
let failures = 0
const check = (name, condition, detail) => {
  total += 1
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

/** 照宿主 renderReview 的拼法造一段预览文本（头行 + 正文行）。 */
const noticeText = (head, ...lines) => [head, ...lines].join('\n')
const HEAD = (verb, path, counts) => `${REVIEW_NOTICE_BANNER}${verb} ${path}（${counts}）`

console.log('[1] 横幅识别')
{
  const real = noticeText(HEAD('新建', 'E:/fallout4/自我介绍.md', '+76 行 / -0 行'), '@@ -0,0 +1,76 @@', '+# 标题')
  check('壳常量就是宿主那段前缀（含书名号与间隔点）', REVIEW_NOTICE_BANNER === '【文件更改预览·尚未落盘】', REVIEW_NOTICE_BANNER)
  check('真横幅被认出（前缀命中）', isReviewNotice(real) && parseReviewNotice(real) !== null)
  check('单行短通知不识别（「这一轮被中断」照旧走 .entry-system）', !isReviewNotice('这一轮被中断') && parseReviewNotice('这一轮被中断') === null)
  check('前缀差一个字也不识别', parseReviewNotice('【文件更改预览】新建 a.md（+1 行 / -0 行）') === null)
  check('前缀在中间不算（必须起头）', parseReviewNotice(`前面还有话 ${REVIEW_NOTICE_BANNER}新建 a.md（+1 行 / -0 行）`) === null)
  check('空正文不识别', parseReviewNotice('') === null)
}

console.log('[2] 头行三件：动作 / 路径 / 计数')
{
  const created = parseReviewNotice(noticeText(HEAD('新建', 'E:/fallout4/自我介绍.md', '+76 行 / -0 行'), '+# 标题'))
  check('动作：新建 → create', created.action === 'create', JSON.stringify(created.action))
  check('路径原样取出（宿主已相对化，壳不二次改写）', created.path === 'E:/fallout4/自我介绍.md', created.path)
  check('计数：+76 行 / -0 行 → 两个数', created.counts !== null && created.counts.added === 76 && created.counts.removed === 0, JSON.stringify(created.counts))
  check('计数原文一并留着（「原样显示」的出口）', created.countsText === '+76 行 / -0 行', created.countsText)
  check('头行原文留着（形状认不出时直接摆它）', created.head === `${REVIEW_NOTICE_BANNER}新建 E:/fallout4/自我介绍.md（+76 行 / -0 行）`, created.head)

  const updated = parseReviewNotice(noticeText(HEAD('修改', 'src/a.ts', '+3 行 / -2 行'), '-旧', '+新'))
  check('动作：修改 → update', updated.action === 'update')
  check('计数：+3 行 / -2 行', updated.counts?.added === 3 && updated.counts.removed === 2, JSON.stringify(updated.counts))
  check('动作文案表两档齐', REVIEW_ACTION_TEXT.create === '新建' && REVIEW_ACTION_TEXT.update === '修改')

  // 路径里带全角括号：头行的计数取**最后一对**括号，别把路径里的括号当计数
  const paren = parseReviewNotice(noticeText(HEAD('修改', 'D:/项目（旧）/a.md', '+1 行 / -1 行'), '-x', '+y'))
  check('路径含全角括号时仍取最后一对括号当计数', paren.path === 'D:/项目（旧）/a.md' && paren.counts?.added === 1, `${String(paren.path)} ${JSON.stringify(paren.counts)}`)

  const noDiff = parseReviewNotice(noticeText(HEAD('修改', 'a.ts', '逐行 diff 未给出'), '（改动区间过大，只给摘要）'))
  check('算不出 diff 时没有计数，但原文留着', noDiff.counts === null && noDiff.countsText === '逐行 diff 未给出', JSON.stringify(noDiff.countsText))
  check('算不出 diff 时动作/路径照常取到', noDiff.action === 'update' && noDiff.path === 'a.ts')

  const broken = parseReviewNotice(noticeText(`${REVIEW_NOTICE_BANNER}莫名其妙的一行`, '+x'))
  check('头行形状认不出：不返回 null（退回居中会把报障原样复活）', broken !== null)
  check('头行认不出时三件给 null、head 原样带、正文照常分类', broken.action === null && broken.path === null && broken.counts === null && broken.head === `${REVIEW_NOTICE_BANNER}莫名其妙的一行` && broken.lines.length === 1 && broken.lines[0].kind === 'add', JSON.stringify(broken))
}

console.log('[3] 逐行四类判定（unified diff 的写法本身，不解析语义）')
{
  check('@@ 开头 → hunk', reviewLineKindOf('@@ -0,0 +1,76 @@') === 'hunk')
  check('+ 开头 → add', reviewLineKindOf('+# 标题') === 'add')
  check('- 开头 → remove', reviewLineKindOf('-旧的一行') === 'remove')
  check('空格开头 → context', reviewLineKindOf(' 没变的一行') === 'context')
  check('空行 → context（不是说明行）', reviewLineKindOf('') === 'context')
  // 上下文行与说明行都以「（」起头时，**前缀**才是判据：上下文行有一个空格前缀
  check('带空格前缀的说明行文本仍是 context（前缀说了算）', reviewLineKindOf(' （这不是说明行，是文件里的原文）') === 'context')

  const body = parseReviewNotice(
    noticeText(
      HEAD('新建', 'E:/a.md', '+2 行 / -0 行'),
      '@@ -0,0 +1,2 @@',
      '+第一行',
      '+第二行',
    ),
  )
  check('整段：头行之后的四类行按序判出', body.lines.map((line) => line.kind).join(',') === 'hunk,add,add', body.lines.map((line) => line.kind).join(','))
  check('行文本原样（含 `+` 前缀，渲染时不再加工）', body.lines[1].text === '+第一行', body.lines[1].text)

  const mixed = parseReviewNotice(
    noticeText(
      HEAD('修改', 'a.ts', '+1 行 / -1 行'),
      '@@ -1,3 +1,3 @@',
      ' 上下文',
      '-旧行',
      '+新行',
    ),
  )
  check('增删混排的顺序与种类都对', mixed.lines.map((line) => line.kind).join(',') === 'hunk,context,remove,add', mixed.lines.map((line) => line.kind).join(','))
}

console.log('[4] 说明行不当作 diff（不染红/绿）')
{
  const identical = parseReviewNotice(
    noticeText(HEAD('修改', 'a.ts', '+0 行 / -0 行'), '（内容与磁盘上现在这份完全一样，这次写入不会改动任何一行）'),
  )
  check('「内容与磁盘上现在这份完全一样」→ note', identical.lines.length === 1 && identical.lines[0].kind === 'note', JSON.stringify(identical.lines))

  const oversize = parseReviewNotice(
    noticeText(HEAD('修改', 'a.ts', '逐行 diff 未给出'), '（改动区间过大（约 3000 行 vs 3000 行），只给摘要；从第 12 行起开始不一样：删 3 行、加 3 行）'),
  )
  check('「算不出逐行差异」的整句括号说明 → note', oversize.lines[0].kind === 'note')

  const truncation = parseReviewNotice(
    noticeText(HEAD('新建', 'a.md', '+76 行 / -0 行'), '@@ -0,0 +1,76 @@', '+x', '…（这份预览只显示前 120 行，还有 56 行未显示；把设置里「一条预览最多显示几行」调大可以看全）'),
  )
  check('截断说明（`…（` 起头）→ note', truncation.lines[2].kind === 'note', JSON.stringify(truncation.lines[2]))

  const ctxZero = parseReviewNotice(
    noticeText(HEAD('修改', 'a.ts', '+1 行 / -0 行'), '@@ -1 +1,2 @@', '+x', '（上下文行数设为 0，只列改动本身）'),
  )
  check('「上下文行数设为 0」→ note', ctxZero.lines[2].kind === 'note')

  // renderReview 的 note 参数（例如审批策略说明）是**不带括号**的整行说明
  const tailNote = parseReviewNotice(
    noticeText(HEAD('修改', 'a.ts', '+1 行 / -0 行'), '@@ -1 +1,2 @@', '+x', '这次不会落盘（审批策略是「仅查看」）'),
  )
  check('尾注（不带括号的普通说明）也落在 note，不会误判成 diff', tailNote.lines[2].kind === 'note', JSON.stringify(tailNote.lines[2]))

  // 反面：真的 diff 行即使内容是中文括号，也必须按前缀判成 add/remove
  const parenAdd = parseReviewNotice(noticeText(HEAD('修改', 'a.ts', '+1 行 / -1 行'), '-（旧）', '+（新）'))
  check('`-（旧）` / `+（新）` 按前缀判成 remove/add（不因为正文是括号就变说明行）', parenAdd.lines.map((line) => line.kind).join(',') === 'remove,add', parenAdd.lines.map((line) => line.kind).join(','))
}

console.log('[5] 契约漂移钉：壳常量 == 宿主 src/plugins/file-review.ts 的字面量')
{
  const host = read('src/plugins/file-review.ts')
  check('宿主里存在壳认的那个前缀', host.includes(REVIEW_NOTICE_BANNER), `宿主里找不到 ${REVIEW_NOTICE_BANNER}`)
  // 头行模板：`${前缀}${verb} ${displayPath}（${counts}）`——壳的解析正则按这个形状写
  const headTemplate = '`' + REVIEW_NOTICE_BANNER + '${verb} ${preview.displayPath}（${counts}）`'
  check('宿主头行模板与壳的解析形状逐字一致（动词 + 空格 + 路径 + （计数））', host.includes(headTemplate), headTemplate)
  // 计数模板：`+N 行 / -M 行`（壳把它解析成两个数）；算不出时那句中文也是壳的兜底档
  check('宿主计数模板是「+N 行 / -M 行」', host.includes('`+${String(diff.added)} 行 / -${String(diff.removed)} 行`'))
  check('宿主「算不出逐行差异」的兜底文案在（壳不在时不该让解析器崩）', host.includes('逐行 diff 未给出'))
  // 说明行的两种起头：`（…）` 与截断说明的 `…（…）`——壳的分类器按这两个前缀认 note
  check('宿主「内容一致」说明仍在（`（` 起头 → note）', host.includes('（内容与磁盘上现在这份完全一样，这次写入不会改动任何一行）'))
  check('宿主截断说明仍是 `…（` 起头', host.includes('…（这份预览只显示前 '))
  // 版本纪律的另一半：壳侧那份字面量只能在这一处（多抄一份就会漂）。数之前先剔注释——
  // 注释里举例是说明，不算第二份字面量；代码里的第二份才算。
  const shellModule = read('ui-shell/src/plugins/transcript/review-notice.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
  check('壳侧的横幅字面量只在 review-notice.ts 里定义一次', shellModule.split(REVIEW_NOTICE_BANNER).length - 1 === 1)
}

console.log('[6] 壳侧接线钉（文本钉：结构约定）')
{
  const chat = read('ui-shell/src/plugins/transcript/ui.tsx')
  const trace = read('ui-shell/src/plugins/trace/ui.tsx')
  const card = read('ui-shell/src/plugins/transcript/review-notice-card.tsx')
  const css = read('ui-shell/src/legacy/views.css')

  check('对话流的 system 分支先问 parseReviewNotice，认出就走卡片', /case 'system': \{[\s\S]{0,600}?parseReviewNotice\(entry\.text\)[\s\S]{0,400}?<ReviewNoticeCard/.test(chat))
  check('认不出仍走 .entry-system（一行短通知的观感不变）', /notice === null \? \(\s*<div className="entry-system">\{entry\.text\}<\/div>/.test(chat))
  check('轨迹页同样认这条通知（system 步骤走同一张卡）', trace.includes('parseReviewNotice(text)') && trace.includes('<ReviewNoticeCard notice={notice} cwd="" />'))
  check('轨迹页划选 diff 不误开检查器（.entry-review 进了忽略表）', trace.includes('.tool-body, .entry-review, [data-trace-open]'))
  check('卡片渲染复用既有计数样式（.changes-counts / changes-added / changes-removed / .diff-badge）', card.includes('className="changes-counts"') && card.includes('className="changes-added"') && card.includes('className="changes-removed"') && card.includes("'diff-badge'"))

  check('卡片左对齐（stretch，不居中）', /\.entry-review \{[\s\S]{0,200}?align-self: stretch/.test(css))
  check('diff 块等宽 + 限高滚动', /\.entry-review-diff \{[\s\S]{0,300}?max-height: 260px;[\s\S]{0,100}?overflow: auto/.test(css) && /\.entry-review-diff \{[\s\S]{0,200}?font-family: var\(--dsc-font-mono\)/.test(css))
  check('增行绿 / 删行红 / hunk 弱化（data-kind 三档齐）', css.includes(".entry-review-line[data-kind='add']") && css.includes(".entry-review-line[data-kind='remove']") && css.includes(".entry-review-line[data-kind='hunk']"))
  check('说明行中性（不染红绿）', /\.entry-review-line\[data-kind='note'\] \{\s*color: var\(--dsc-text-quaternary\)/.test(css))
  // 令牌纪律：这段新样式里不许出现硬编码色值（十六进制 / rgb()）
  const block = /\/\* ── 写前预览通知[\s\S]*?\n\/\* 轨迹页里的同一张卡/.exec(css)?.[0] ?? ''
  check('新样式区块找得到（从注释起头到轨迹页那一段）', block !== '')
  check('样式不硬编码颜色（全走 --dsc-* 令牌）', block !== '' && !/#[0-9a-fA-F]{3,8}\b/.test(block) && !/\brgba?\(/.test(block), block.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g)?.join(',') ?? '')
}

console.log('')
console.log(`通过 ${String(total - failures)}/${String(total)}`)
process.exit(failures === 0 ? 0 : 1)
