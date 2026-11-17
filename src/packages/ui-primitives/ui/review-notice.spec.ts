/**
 * 「文件更改预览」通知的纯解析（迁自 `scripts/ui-review-notice-test.mjs` 第 [1]–[4] 段）。
 *
 * 报障背景：宿主在写盘前发的那段多行 diff 纯文本被 `.entry-system` 居中成一坨；
 * 壳按正文前缀认出这条通知后切成「头行三件 + 逐行四类」，画成左对齐卡片。
 *
 * 为什么是行为测试：`review-notice.ts` 零 React、零 DOM，`isReviewNotice` /
 * `parseReviewNotice` / `reviewLineKindOf` 的真跑结果就是被测行为——横幅识别、
 * 头行三件（动作 / 路径 / 计数）、逐行四类判定、说明行不当作 diff。
 *
 * 不迁的部分（原探针第 [5]–[7] 段，见交付报告缺口清单）：
 *   - [5] 契约漂移钉（壳常量 == 宿主 `src/packages/sandbox/review.ts` 的字面量与头行模板）：
 *     宿主那段拼文本的代码没有可导入的字面量出口，改形状只能读源文件比对——归产物/契约批；
 *   - [6] 壳侧接线钉（对话流 case 'system' 分支、轨迹页、卡片交互、CSS 令牌）——渲染接线
 *     与样式，归组件渲染批；其中「头行形状」的行为面（横幅 + 动词 + 路径 + （计数）能被
 *     拆开）已由本文件第 2 组用例以真输入压住；
 *   - [7] 插件边界钉（两家都从 @dsc/ui-primitives 取、不许相对横穿）——源码文本钉。
 *
 * @module dsc-ui-primitives/ui/review-notice.spec
 */
import { describe, expect, test } from 'vitest'
import { REVIEW_ACTION_TEXT, REVIEW_NOTICE_BANNER, isReviewNotice, parseReviewNotice, reviewLineKindOf } from './review-notice.js'

/** 照宿主 renderReview 的拼法造一段预览文本（头行 + 正文行）。 */
const noticeText = (head: string, ...lines: string[]): string => [head, ...lines].join('\n')
/** 头行模板：`${前缀}${verb} ${path}（${counts}）`——与宿主逐字同形。 */
const HEAD = (verb: string, path: string, counts: string): string =>
  `${REVIEW_NOTICE_BANNER}${verb} ${path}（${counts}）`

describe('横幅识别', () => {
  const real = noticeText(HEAD('新建', 'E:/fallout4/自我介绍.md', '+76 行 / -0 行'), '@@ -0,0 +1,76 @@', '+# 标题')

  test('壳常量就是宿主那段前缀（含书名号与间隔点）', () => {
    expect(REVIEW_NOTICE_BANNER).toBe('【改动前预览·尚未落盘】')
  })

  test('真横幅被认出（前缀命中）', () => {
    expect(isReviewNotice(real)).toBe(true)
    expect(parseReviewNotice(real)).not.toBeNull()
  })

  test('单行短通知不识别（「这一轮被中断」照旧走 .entry-system）', () => {
    expect(isReviewNotice('这一轮被中断')).toBe(false)
    expect(parseReviewNotice('这一轮被中断')).toBeNull()
  })

  test('前缀差一个字也不识别', () => {
    expect(parseReviewNotice('【改动前预览】新建 a.md（+1 行 / -0 行）')).toBeNull()
  })

  test('前缀在中间不算（必须起头）', () => {
    expect(parseReviewNotice(`前面还有话 ${REVIEW_NOTICE_BANNER}新建 a.md（+1 行 / -0 行）`)).toBeNull()
  })

  test('空正文不识别', () => {
    expect(parseReviewNotice('')).toBeNull()
  })
})

describe('头行三件：动作 / 路径 / 计数', () => {
  const created = parseReviewNotice(
    noticeText(HEAD('新建', 'E:/fallout4/自我介绍.md', '+76 行 / -0 行'), '+# 标题'),
  )

  test('动作：新建 → create；路径原样取出（宿主已相对化，壳不二次改写）', () => {
    expect(created?.action).toBe('create')
    expect(created?.path).toBe('E:/fallout4/自我介绍.md')
  })

  test('计数：+76 行 / -0 行 → 两个数，计数原文一并留着（「原样显示」的出口）', () => {
    expect(created?.counts).toEqual({ added: 76, removed: 0 })
    expect(created?.countsText).toBe('+76 行 / -0 行')
  })

  test('头行原文留着（形状认不出时直接摆它）', () => {
    expect(created?.head).toBe(`${REVIEW_NOTICE_BANNER}新建 E:/fallout4/自我介绍.md（+76 行 / -0 行）`)
  })

  const updated = parseReviewNotice(noticeText(HEAD('修改', 'src/a.ts', '+3 行 / -2 行'), '-旧', '+新'))

  test('动作：修改 → update；计数：+3 行 / -2 行；动作文案表两档齐', () => {
    expect(updated?.action).toBe('update')
    expect(updated?.counts).toEqual({ added: 3, removed: 2 })
    expect(REVIEW_ACTION_TEXT.create).toBe('新建')
    expect(REVIEW_ACTION_TEXT.update).toBe('修改')
  })

  test('路径含全角括号时仍取最后一对括号当计数', () => {
    const paren = parseReviewNotice(noticeText(HEAD('修改', 'D:/项目（旧）/a.md', '+1 行 / -1 行'), '-x', '+y'))
    expect(paren?.path).toBe('D:/项目（旧）/a.md')
    expect(paren?.counts?.added).toBe(1)
  })

  const noDiff = parseReviewNotice(noticeText(HEAD('修改', 'a.ts', '逐行 diff 未给出'), '（改动区间过大，只给摘要）'))

  test('算不出 diff 时没有计数，但原文留着；动作/路径照常取到', () => {
    expect(noDiff?.counts).toBeNull()
    expect(noDiff?.countsText).toBe('逐行 diff 未给出')
    expect(noDiff?.action).toBe('update')
    expect(noDiff?.path).toBe('a.ts')
  })

  test('头行形状认不出：不返回 null（退回居中会把报障原样复活）', () => {
    const broken = parseReviewNotice(noticeText(`${REVIEW_NOTICE_BANNER}莫名其妙的一行`, '+x'))
    expect(broken).not.toBeNull()
    expect(broken?.action).toBeNull()
    expect(broken?.path).toBeNull()
    expect(broken?.counts).toBeNull()
    expect(broken?.head).toBe(`${REVIEW_NOTICE_BANNER}莫名其妙的一行`)
    expect(broken?.lines.map((line) => line.kind).join(',')).toBe('add')
  })
})

describe('逐行四类判定（unified diff 的写法本身，不解析语义）', () => {
  test('四类前缀：@@ → hunk、+ → add、- → remove、空格 → context、空行 → context', () => {
    expect(reviewLineKindOf('@@ -0,0 +1,76 @@')).toBe('hunk')
    expect(reviewLineKindOf('+# 标题')).toBe('add')
    expect(reviewLineKindOf('-旧的一行')).toBe('remove')
    expect(reviewLineKindOf(' 没变的一行')).toBe('context')
    expect(reviewLineKindOf('')).toBe('context')
  })

  test('带空格前缀的说明行文本仍是 context（前缀说了算）', () => {
    expect(reviewLineKindOf(' （这不是说明行，是文件里的原文）')).toBe('context')
  })

  test('整段：头行之后的四类行按序判出，行文本原样（含 + 前缀）', () => {
    const body = parseReviewNotice(
      noticeText(HEAD('新建', 'E:/a.md', '+2 行 / -0 行'), '@@ -0,0 +1,2 @@', '+第一行', '+第二行'),
    )
    expect(body?.lines.map((line) => line.kind).join(',')).toBe('hunk,add,add')
    expect(body?.lines[1]?.text).toBe('+第一行')
  })

  test('增删混排的顺序与种类都对', () => {
    const mixed = parseReviewNotice(
      noticeText(HEAD('修改', 'a.ts', '+1 行 / -1 行'), '@@ -1,3 +1,3 @@', ' 上下文', '-旧行', '+新行'),
    )
    expect(mixed?.lines.map((line) => line.kind).join(',')).toBe('hunk,context,remove,add')
  })
})

describe('说明行不当作 diff（不染红/绿）', () => {
  test('「内容与磁盘上现在这份完全一样」→ note', () => {
    const identical = parseReviewNotice(
      noticeText(HEAD('修改', 'a.ts', '+0 行 / -0 行'), '（内容与磁盘上现在这份完全一样，这次写入不会改动任何一行）'),
    )
    expect(identical?.lines).toHaveLength(1)
    expect(identical?.lines[0]?.kind).toBe('note')
  })

  test('「算不出逐行差异」的整句括号说明 → note', () => {
    const oversize = parseReviewNotice(
      noticeText(
        HEAD('修改', 'a.ts', '逐行 diff 未给出'),
        '（改动区间过大（约 3000 行 vs 3000 行），只给摘要；从第 12 行起开始不一样：删 3 行、加 3 行）',
      ),
    )
    expect(oversize?.lines[0]?.kind).toBe('note')
  })

  test('截断说明（`…（` 起头）→ note', () => {
    const truncation = parseReviewNotice(
      noticeText(
        HEAD('新建', 'a.md', '+76 行 / -0 行'),
        '@@ -0,0 +1,76 @@',
        '+x',
        '…（这份预览只显示前 120 行，还有 56 行未显示；把设置里「一条预览最多显示几行」调大可以看全）',
      ),
    )
    expect(truncation?.lines[2]?.kind).toBe('note')
  })

  test('「上下文行数设为 0」→ note', () => {
    const ctxZero = parseReviewNotice(
      noticeText(HEAD('修改', 'a.ts', '+1 行 / -0 行'), '@@ -1 +1,2 @@', '+x', '（上下文行数设为 0，只列改动本身）'),
    )
    expect(ctxZero?.lines[2]?.kind).toBe('note')
  })

  test('尾注（不带括号的普通说明）也落在 note，不会误判成 diff', () => {
    const tailNote = parseReviewNotice(
      noticeText(HEAD('修改', 'a.ts', '+1 行 / -0 行'), '@@ -1 +1,2 @@', '+x', '这次不会落盘（审批策略是「仅查看」）'),
    )
    expect(tailNote?.lines[2]?.kind).toBe('note')
  })

  test('`-（旧）` / `+（新）` 按前缀判成 remove/add（不因为正文是括号就变说明行）', () => {
    const parenAdd = parseReviewNotice(noticeText(HEAD('修改', 'a.ts', '+1 行 / -1 行'), '-（旧）', '+（新）'))
    expect(parenAdd?.lines.map((line) => line.kind).join(',')).toBe('remove,add')
  })
})
