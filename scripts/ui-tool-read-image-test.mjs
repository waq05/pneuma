/**
 * `read_image` 工具卡的探针（差距清单 S4 的剩余项）。
 *
 * 三张专用卡那一批（read / search / todo）之后补的第四张：`read_image` 的判据、回执解析、
 * 展开体的现读路径与本地化。验法与 `scripts/ui-tool-views-test.mjs` 同一套，两层：
 *
 *   1. **真逻辑**：`read-image-model.ts` 零 import（没有 React、没有取词器），Node 的类型擦除
 *      直接把它载进来跑真代码——不是在这里复刻一份判据；
 *   2. **源码钉**：渲染体是 `.tsx`，Node 载不动 JSX，所以读源码断言判据、状态分支、导出名与
 *      可点性。这几条正好是「换个实现就会悄悄坏掉」的那几处。
 *
 * 四节：
 *   [1] 判据：名字 + 非空路径（`path` 与 `file_path` 都认）
 *   [2] 结果解析：真句子、带空格与括号的路径、CRLF、报错散文、undefined / 空串
 *   [3] 源码钉：模型零 import、字节不进契约、展开体走 `fs-read`、tooLarge / naturalWidth / 可点
 *   [4] 本地化：五个键两份字典都在、英文里没有汉字、渲染体里没有硬编码中文
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-tool-read-image-test.mjs
 * （`check:ui` 自动收录本目录下的 `*-test.mjs`，并统一补上同一个 `--import`）
 *
 * @module dsc/scripts/ui-tool-read-image-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

/** 界面半的落点：transcript 在宿主包里（`src/packages/ui-transcript/ui`）。 */
const TOOL_CARD = 'src/packages/ui-transcript/ui/tool-card'
const MODEL = `${TOOL_CARD}/read-image-model.ts`
const VIEW = `${TOOL_CARD}/read-image-view.tsx`
const ZH = 'src/packages/ui-transcript/locale/ui.zh.json'
const EN = 'src/packages/ui-transcript/locale/ui.en.json'

const zh = JSON.parse(read(ZH))
const en = JSON.parse(read(EN))

let passed = 0
let failures = 0
/** 记一条。`detail` 只在失败时打出来，省得整页都是数值。 */
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}

/** 源码压成一行：跨行断句的判据也读得出来（格式化不改变判据）。 */
const flat = (src) => src.replace(/\s+/g, ' ')

/** 剥注释（块注释与行注释）：几条「源码里有没有某件事」的断言只能看代码。 */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/**
 * 一行代码里还剩多少汉字（剥掉注释与正则字面量之后）。
 *
 * 与 `ui-tool-views-test.mjs` 同一个判据：本仓的界面文案必须走字典（`scripts/ui-locale-test.mjs`
 * 钉着），唯一允许写汉字的地方是**正则字面量**——它匹配的是宿主写进结果里的中文标记，不是
 * 要翻译的界面文字。
 */
const linesWithChinese = (rel) => {
  const hits = []
  // 先把块注释整段抹成空格（保留换行数，行号才对得上），再逐行剥行注释与正则字面量。
  const source = read(rel).replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  source.split('\n').forEach((line, index) => {
    const stripped = line
      .replace(/\/\/.*$/, '')
      .replace(/\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\])+\/[a-z]*/g, '')
    if (/[\u4e00-\u9fff]/.test(stripped)) hits.push(`${String(index + 1)}: ${line.trim().slice(0, 60)}`)
  })
  return hits
}

// ── [1] 判据 ─────────────────────────────────────────────────────────────────
const { readImageCallOf, readImageFactsOf } = await import(new URL(`../${MODEL}`, import.meta.url).href)
console.log('[1] 判据：名字是 read_image 且参数里有非空路径（path 与 file_path 都认）')

{
  const viaPath = readImageCallOf('read_image', '{"path":"shot.png"}')
  check('read_image + path → 一张图片卡', viaPath !== null && viaPath.path === 'shot.png', viaPath)
  const viaFile = readImageCallOf('read_image', '{"file_path":"C:\\\\work\\\\a.png"}')
  check('read_image + file_path（dsh 那边的参数名）→ 也是一张图片卡', viaFile !== null && viaFile.path === 'C:\\work\\a.png', viaFile)
  check('空串 path → 不是这张卡', readImageCallOf('read_image', '{"path":""}') === null)
  check('空白 path → 不是这张卡', readImageCallOf('read_image', '{"path":"   "}') === null)
  check('名字不是 read_image → 不是这张卡', readImageCallOf('read', '{"path":"shot.png"}') === null)
  check('半截 JSON（流式参数）→ 不抛，判成不是这张卡', readImageCallOf('read_image', '{"path":') === null)
  check('参数是数组 → 不是这张卡', readImageCallOf('read_image', '[]') === null)
  check('两个参数名都没给 → 不是这张卡', readImageCallOf('read_image', '{"file":"a.png"}') === null)
}

// ── [2] 结果解析 ─────────────────────────────────────────────────────────────
console.log('[2] 结果解析：只认宿主那句固定回执，认不出就是 null（不猜 0 字节）')

{
  const real = readImageFactsOf('已加载图片 D:\\work\\shot.png（image/png，12345 字节），图在附件里。')
  check('真句子 → { image/png, 12345 }', real?.mime === 'image/png' && real?.bytes === 12345, real)

  const spaced = readImageFactsOf('已加载图片 D:\\my work\\a (1).png（image/png，4096 字节），图在附件里。')
  check('路径带空格与括号也解析得对', spaced?.mime === 'image/png' && spaced?.bytes === 4096, spaced)

  const crlf = readImageFactsOf('已加载图片 D:\\work\\shot.png（image/svg+xml，321 字节），图在附件里。\r\n')
  check('CRLF 行尾不影响解析', crlf?.mime === 'image/svg+xml' && crlf?.bytes === 321, crlf)

  check('报错散文 → null（不能画成「看了一张 0 字节的图」）', readImageFactsOf('这张图有 7MB，超过 6MB 上限；先压缩或缩小再看') === null)
  check('「只接受图片」那句散文里的全角括号不会被当回执', readImageFactsOf('read_image 只接受图片（png/jpg/gif/webp/bmp/svg）；文本文件请用 shell 命令读') === null)
  check('undefined → null（还在跑）', readImageFactsOf(undefined) === null)
  check('空串 → null', readImageFactsOf('') === null)
  check('字节数不是十进制整数 → null', readImageFactsOf('已加载图片 D:\\a.png（image/png，1e3 字节），图在附件里。') === null)
}

// ── [3] 源码钉 ───────────────────────────────────────────────────────────────
console.log('[3] 源码钉：模型零 import、字节不进契约、展开体现读一次、四种状态与可点性')

{
  const model = read(MODEL)
  const view = read(VIEW)
  const viewCode = code(view)

  check('模型零 import（探针能直接载入跑真代码）', (model.match(/^import /gm) ?? []).length === 0)
  check('模型里没有 data:image（图片字节不许进界面契约）', !model.includes('data:image'))
  check('展开体按路径现读：走 dock 的 fs-read', flat(viewCode).includes("['fs-read'"))
  check('tooLarge 单独一支（超 5MB 说「太大」，不说「读不到」）', viewCode.includes('tooLarge') && viewCode.includes("t('transcript.tool.imageTooLarge')"))
  check('尺寸取自 naturalWidth / naturalHeight（图自己报，不猜）', viewCode.includes('naturalWidth') && viewCode.includes('naturalHeight'))
  check('两个导出名都在', viewCode.includes('export function ReadImageBadge') && viewCode.includes('export function ReadImageBody'))
  check('图片可点：role="button" + tabIndex + Enter/Space', viewCode.includes('role="button"') && viewCode.includes('tabIndex={0}') && viewCode.includes("event.key !== 'Enter'"))
  check('点图开右侧预览页签（setDockPreview）', viewCode.includes('setDockPreview({ path: absPath, cwd })'))
  // 「读盘只在 effect 里」要真的判位置：只数 invoke 出现一次、且那一次落在 useEffect 的回调里
  // （原先那条「useEffect 的下标小于 fs-read 的下标」两个下标都在同一段代码里，等于没说清）。
  // 泛型调用写的是 `.invoke<DockFsRead>(`，所以不能只认 `.invoke(`。
  const invokeCount = (viewCode.match(/\.invoke[<(]/g) ?? []).length
  check('渲染体只有一处 invoke（一次挂载只读一次盘）', invokeCount === 1, String(invokeCount))
  const effectStart = viewCode.indexOf('useEffect(() => {')
  const effectEnd = viewCode.indexOf('}, [absPath')
  check(
    '那一次 invoke 就在 useEffect 的回调里（不在渲染函数体里）',
    effectStart !== -1 && effectEnd > effectStart && viewCode.slice(effectStart, effectEnd).includes("['fs-read'"),
    JSON.stringify({ effectStart, effectEnd }),
  )
  check('「落定」只认 done / failed（被拒与被中断都不读盘）', viewCode.includes("call.status === 'done' || call.status === 'failed'"))
  check('解不出来的图退回「读不到」，不留破碎图标', viewCode.includes('onError=') && viewCode.includes("setState({ kind: 'unavailable' })"))
}

// ── [2b] 回执 → 状态 ─────────────────────────────────────────────────────────
console.log('[2b] 回执 → 状态：太大 / 不是图片 / 缺字段 / 正常，四种状态的判法跑真代码')

{
  const { stateOfRead } = await import(new URL(`../${MODEL}`, import.meta.url).href)
  check('tooLarge 先判（超 5MB 说「太大」，即使 base64 是空串）', stateOfRead({ kind: 'image', tooLarge: true, mime: 'image/png', base64: '' }).kind === 'tooLarge')
  check('kind 不是 image（文本 / PDF / 二进制）→ 读不到', stateOfRead({ kind: 'text', tooLarge: false }).kind === 'unavailable')
  check('缺 mime → 读不到（不拿 image/png 去猜）', stateOfRead({ kind: 'image', base64: 'AAAA' }).kind === 'unavailable')
  check('base64 是空串 → 读不到', stateOfRead({ kind: 'image', mime: 'image/png', base64: '' }).kind === 'unavailable')
  const ok = stateOfRead({ kind: 'image', tooLarge: false, mime: 'image/png', base64: 'AAAA' })
  check('正常回执 → image 状态，带出 mime 与 base64', ok.kind === 'image' && ok.mime === 'image/png' && ok.base64 === 'AAAA', ok)
  check('空对象（跨进程缺字段）→ 读不到，不抛', stateOfRead({}).kind === 'unavailable')
}

// ── [4] 本地化（源码钉）─────────────────────────────────────────────────────
console.log('[4] 本地化：五个键两份字典都在、英文里没有汉字、渲染体里没有硬编码中文')

{
  const keys = [
    'transcript.tool.imageMeta',
    'transcript.tool.imageDims',
    'transcript.tool.imageLoading',
    'transcript.tool.imageTooLarge',
    'transcript.tool.imageUnavailable',
  ]
  for (const key of keys) {
    check(`字典里有 ${key}（中文）`, typeof zh[key] === 'string' && zh[key].trim() !== '')
    check(`字典里有 ${key}（英文）`, typeof en[key] === 'string' && en[key].trim() !== '')
  }
  const cjkInEn = keys.filter((key) => /[\u4e00-\u9fff]/.test(en[key] ?? ''))
  check('英文译本里没有汉字', cjkInEn.length === 0, cjkInEn.join('、'))
  const view = read(VIEW)
  const unused = keys.filter((key) => !view.includes(`t('${key}'`))
  check('五个键都被渲染体用上（字典里不留闲置键）', unused.length === 0, unused.join('、'))
  const hits = linesWithChinese(VIEW)
  check('read-image-view.tsx 里没有硬编码中文（注释与正则除外）', hits.length === 0, hits.slice(0, 3).join(' / '))
  // 正则里那句中文是宿主写进结果的标记，不是界面文案：钉一条「它还在」，删了解析就静默失效。
  check('回执解析规则还在（已加载图片 …（mime，N 字节））', read(MODEL).includes('已加载图片'))
}

const total = passed + failures
console.log('')
console.log(failures === 0 ? `全部通过（${String(total)} 项）` : `${String(failures)} 项失败 / ${String(total)} 项`)
process.exit(failures === 0 ? 0 : 1)
