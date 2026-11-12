/**
 * `read_image` 工具卡的纯逻辑（差距清单 S4 的剩余项）：这次看的是哪张图、宿主回执里说它是什么
 * MIME、多少字节。
 *
 * 为什么这张卡只解析「元信息」、不碰图片本身：一张 6MB 的图 base64 之后约 8MB（`image-tool.ts:30-31`
 * 那条红线正是按这个比例定的），把字节塞进界面契约，等于每次会话快照都要驮着 8MB。所以这里只
 * 认两个读数——MIME 与字节数，够头行说一句 `PNG · 12.1 KB`（见 `read-image-view.tsx` 的
 * {@link ReadImageBadge}）；像素由展开体在挂载时按路径现读（走 `dock` 的 `fs-read`，
 * `src/packages/desktop-dock/index.ts:467-489`）。
 *
 * 两条判据与 read 卡同源（`read-model.ts:107`）：
 *   1. **名字是 `read_image`，且参数里真有非空路径**。只有名字对上、参数键却是别的，就回落通用卡：
 *      宁可少一张图片卡，也不画一张没有图可看的空壳；
 *   2. 结果只认宿主那句固定回执（`src/packages/tools-default/image-tool.ts:58` 的
 *      `已加载图片 <路径>（<mime>，<字节数> 字节），图在附件里。`）。工具抛错时结果是另一句散文
 *      （超 6MB、不是图片、路径被拦截），解析不出就返回 null——绝不猜成「0 字节」，
 *      那会让读者以为文件是空的。
 *
 * 中文标记只写成**正则字面量**：它匹配的是宿主写进结果里的字，不是要翻译的界面文案（与
 * `bash-view.tsx` 的 `/退出码 (\d+)/`、`read-model.ts:91` 的 `/共 (\d+) 行/` 同一条口径；
 * `scripts/ui-locale-test.mjs` 只查字符串字面量，不查正则）。
 *
 * 本文件**零 import**：探针（`scripts/ui-tool-read-image-test.mjs`）用 Node 的类型擦除直接载入
 * 它跑真代码，而不是在探针里复刻一份判据。
 *
 * @module dsc-ui-shell/plugins/transcript/tool-card/read-image-model
 */

/**
 * 走这张卡的工具名。
 *
 * 只认这一个名字：Pneuma 自己注册的就是它（`image-tool.ts:34`）。`look_at_image` 之类的名字
 * 本批不认——认了它，头行那条可点路径却出不来（`factory.tsx:729-730` 的 `fileTargetOf` 白名单里
 * 还没有它），那会变成半张卡；不认它就照旧走通用卡，一个字的信息都不丢。
 */
const READ_IMAGE_TOOL_NAME = 'read_image'

/** 一张图片卡要用到的参数：图片路径原文（可能相对会话工作目录）。 */
export interface ReadImageCall {
  /** 参数里的路径原文，已去掉首尾空白（相对路径由调用方按 cwd 拼绝对）。 */
  path: string
}

/** 结果回执里解析出来的两个读数。 */
export interface ReadImageFacts {
  /** 宿主认出来的 MIME（`image/png` / `image/svg+xml` …）。 */
  mime: string
  /** 文件字节数（宿主写的是 `stat.size`，这里是同一个数）。 */
  bytes: number
}

/**
 * 参数是不是一张图片卡：**名字对得上**且**参数里真有非空路径**。
 *
 * 两个参数名都认，理由与 `factory.tsx:724-735` 的 `fileTargetOf` 相同：Pneuma 自己注册的
 * `read_image` 用 `path`（`image-tool.ts:38`），dsh 那边的 `tool-fs` 用 `file_path`。同一个工具
 * 在两套装配下参数名不同，界面若只认一个，换一套装配这张卡就永远出不来。
 *
 * 顺序是 `file_path` 先、`path` 后，**与 `fileTargetOf` 逐字一致**：头行那条可点路径由它拼，
 * 展开体读哪张图由这里定，两个键同时出现却指向不同文件时（理论上不该有，但模型产出的 JSON
 * 谁也保不齐），顺序不一致就会出现「头行点开 A、卡里画的是 B」——一处写错两处打架。
 *
 * 半截 JSON（参数还在流式吐出来）、数组、非对象一律 null：取不到路径就当不是这一形态。
 *
 * @param name 工具名（宿主原样交来的）
 * @param argsText 模型产出的原始 arguments JSON 字符串
 * @returns 参数视图；不是这张卡的形态时 null（回落通用卡）
 */
export function readImageCallOf(name: string, argsText: string): ReadImageCall | null {
  if (name !== READ_IMAGE_TOOL_NAME) return null
  if (typeof argsText !== 'string' || argsText === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(argsText) as unknown
  } catch {
    // 参数还没吐完的半截 JSON：这一次取不到路径，判成不是这张卡。
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const args = parsed as Record<string, unknown>
  const raw = [args['file_path'], args['path']].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  )
  if (raw === undefined) return null
  return { path: raw.trim() }
}

/**
 * `dock` 的 `fs-read` 回执里这张卡用得上的字段（形状见 `packages/desktop-dock/index.ts:467-489`）。
 *
 * 为什么放在模型这一侧、而不是渲染体里就地解构：这几个字段决定「画图还是画一句说明」，
 * 是**纯判断**，放进模型才能让探针对它跑真代码（渲染体是 JSX，Node 载不动）。
 * 全是可选的：这份数据跨进程来，字段缺了要当成「读不到」而不是让整张卡崩掉。
 */
export interface DockFsRead {
  kind?: string
  tooLarge?: boolean
  mime?: string
  base64?: string
}

/**
 * 展开体的四种状态。
 *
 * 用判别联合而不是几个布尔量：`loading` 与 `unavailable` 是两个相反的结论，各存一个 flag 就有
 * 了「两个都为真」这种画不出来的组合。
 */
export type ImageState =
  | { kind: 'loading' }
  | { kind: 'tooLarge' }
  | { kind: 'unavailable' }
  | { kind: 'image'; mime: string; base64: string }

/**
 * 回执 → 状态。三条判据的顺序有讲究：
 *
 *  1. `tooLarge` 先判：超过 5MB 时宿主回的就是 `base64: ''`（`desktop-dock/index.ts:475`），
 *     若先判 base64 为空，用户会看到「读不到」而不是「太大了」——这两句话的下一步完全不同；
 *  2. 再看 `kind`：文本、PDF、二进制都从这条 op 回来，它们不是图片；
 *  3. 最后才认 MIME 与 base64。缺一个就当读不到，不拿 `image/png` 之类去兜底猜一个。
 *
 * @param raw - `fs-read` 的回执（跨进程来的未校验数据）
 * @returns 展开体该画哪一种状态
 */
export function stateOfRead(raw: DockFsRead): ImageState {
  if (raw.tooLarge === true) return { kind: 'tooLarge' }
  if (raw.kind !== 'image') return { kind: 'unavailable' }
  if (typeof raw.mime !== 'string' || raw.mime === '') return { kind: 'unavailable' }
  if (typeof raw.base64 !== 'string' || raw.base64 === '') return { kind: 'unavailable' }
  return { kind: 'image', mime: raw.mime, base64: raw.base64 }
}

/**
 * 宿主回执的形状（`image-tool.ts:58`）。
 *
 * 为什么不「先贪婪吃掉一条路径再回退着切分」：路径里可能有空格、ASCII 括号（`D:\my work\a (1).png`）、
 * 反斜杠、甚至全角字符，从路径一侧找边界只能靠猜，猜错就把 MIME 或字节数读成别的。这里反过来，
 * 锚在**宿主自己写的固定标记**上：开头认死 `已加载图片 `，然后从全角 `（` 起认
 * 「MIME + 全角逗号 + 十进制数字 + ` 字节）`」这一段。全角括号与全角逗号是宿主的分隔符，
 * 路径里几乎不会出现，所以路径长什么样都不影响解析。
 *
 * 开头的 `已加载图片 ` 不能省：工具抛错时的散文（`read_image 只接受图片（png/jpg…）`）里也有
 * 全角括号，没有这个锚就可能把一句报错读成一次成功。
 */
const RESULT_RE = /^已加载图片 [\s\S]*（([^，（）]+)，(\d+) 字节）/

/**
 * 把 `read_image` 的结果原文解析成 `{ mime, bytes }`。
 *
 * 只认整句固定回执，不做「找找看有没有像 MIME 的片段」这种宽松匹配：结果文本在工具失败时是
 * 散文，宽松匹配会把报错里提到的路径或数字当成一次成功的读数，那比不显示更糟。
 *
 * @param resultText 工具结果原文（可能是 undefined：还在跑）
 * @returns 两个读数；形状对不上时 null
 */
export function readImageFactsOf(resultText: string | undefined): ReadImageFacts | null {
  if (typeof resultText !== 'string') return null
  // CRLF 与首尾空白先抹掉：回执是单行，行尾的 `\r\n` 不该影响 `^` 锚。
  const text = resultText.trim()
  if (text === '') return null
  const hit = RESULT_RE.exec(text)
  if (hit === null) return null
  const mime = (hit[1] ?? '').trim()
  const digits = hit[2] ?? ''
  const bytes = Number(digits)
  // 宿主写的一定是十进制整数（`stat.size`）。判 `/^\d+$/` 而不是 `Number.isFinite`：
  // `1e3`、`12.5` 这种也「有限」，但那说明这一行不是那份回执。
  if (mime === '' || !/^\d+$/.test(digits) || !Number.isSafeInteger(bytes) || bytes < 0) return null
  return { mime, bytes }
}
