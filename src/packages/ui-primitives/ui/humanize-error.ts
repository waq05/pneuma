/**
 * 错误文案的"人话层"（2026-10-25，P0-3）。
 *
 * 现状：全仓 90 处 `失败：${text(error)}`、74 处 `toastErr(...)`，用户看到的是
 * "读取归档失败：Error: connect ECONNREFUSED 127.0.0.1:17321"——工程语言，没有下一步。
 *
 * 这一层只做三件事，**不改错误的流转**（原文照旧要留）：
 *   1. `title`：发生了什么（用户视角，一句话）；
 *   2. `hint`：下一步能做什么（一句，命令式）；
 *   3. `detail`：原文整串——诊断、复制、报障用它，不塞进界面主文案。
 *
 * 为什么按模式匹配而不是按错误类型：宿主与原生桥返回的常常是 `{ ok:false, error:string }`
 * 或者被 `String()` 过一道的字符串，类型信息早没了；能认的只有字样。规则按"先具体后笼统"排，
 * 每一条都解释了它对应哪种真实故障。
 *
 * @module dsc-ui-shell/ui-primitives/humanize-error
 */

/** 一条错误的三个面向。 */
export interface HumanError {
  /** 发生了什么（用户视角）。 */
  title: string
  /** 下一步做什么。 */
  hint: string
  /** 原始文本，给诊断与复制用。 */
  detail: string
}

/** 把任意抛出来的值压成一行原文。 */
function rawText(input: unknown): string {
  if (typeof input === 'string') return input.trim()
  if (input instanceof Error) return `${input.name}: ${input.message}`.trim()
  if (input === null || input === undefined) return ''
  // 宿主偶尔把错误包成对象扔过来（`{ ok:false, error:{ code, message } }`）：
  // `String()` 会把它压成 "[object Object]"，诊断时等于什么都没留——先试 JSON。
  if (typeof input === 'object') {
    try {
      const json = JSON.stringify(input)
      if (typeof json === 'string' && json !== '{}') return json.slice(0, 800)
    } catch {
      // 循环引用之类的：退回 String，至少别抛。
    }
  }
  try {
    return String(input).trim()
  } catch {
    return ''
  }
}

/** 规则表：命中第一条就停。`match` 对**小写**原文做测试。 */
const RULES: readonly { match: RegExp; title: string; hint: string }[] = [
  {
    // 本机界面走的是 http://127.0.0.1:<port> 的 SSE + invoke；宿主没起来或端口变了就撞这条。
    match: /econnrefused|econnreset|failed to fetch|fetch failed|networkerror|network error|load failed/,
    title: '连不上宿主',
    hint: '确认 Pneuma 还开着；宿主重启过就刷新这个页面。',
  },
  {
    match: /etimedout|timed? ?out|abort(ed)?|timeout/,
    title: '等太久了，请求被掐断',
    hint: '再试一次；一直这样的话把模型服务换一个再试。',
  },
  {
    // 原生桥（openWorkspace / openPath / pickDirectory）走的是 shell.openPath，路径不在就这条。
    match: /enoent|no such file|not exist|cannot find the path|找不到/,
    title: '这个路径不存在了',
    hint: '确认目录还在，或者重新选一次工作区。',
  },
  {
    match: /eacces|eperm|permission denied|access is denied|没有权限/,
    title: '系统不允许这一步',
    hint: '换个有写权限的目录，或者用管理员身份重开一次。',
  },
  {
    // 模型服务那几家在 key 不对时给的是 401/403，中文文案常常只剩一句"unauthorized"。
    match: /401|403|unauthorized|invalid api key|api key/,
    title: '凭据不对或过期',
    hint: '到设置 → 模型里重新填一次 key，再点"测试连接"。',
  },
  {
    match: /429|rate limit|too many requests|频繁/,
    title: '请求太频繁，被服务方限流了',
    hint: '等十几秒再发；连续撞就把并发降下来。',
  },
  {
    match: /404|not found|没有找到/,
    title: '对方没有这个东西',
    hint: '核对一下名字或地址；版本对不上时先在设置里刷新一次清单。',
  },
  {
    match: /413|too large|payload|超过(大小|上限)/,
    title: '这一份太大了',
    hint: '换小一点的文件，或者先压缩再试。',
  },
  {
    match: /500|502|503|504|internal server error|bad gateway/,
    title: '对方服务自己出错了',
    hint: '过一会儿再试；一直这样就是服务方的问题，不是你操作错了。',
  },
]

/** 把一行错误翻成「发生了什么 / 下一步 / 原文」。 */
export function humanizeError(input: unknown, fallback = '这一步没有完成'): HumanError {
  const detail = rawText(input)
  const lower = detail.toLowerCase()
  for (const rule of RULES) {
    if (rule.match.test(lower)) return { title: rule.title, hint: rule.hint, detail }
  }
  // 没命中规则：原文第一句当标题（去掉 "Error:" 前缀），细节留在 detail 里。
  const firstLine = (detail.split(/\r?\n/)[0] ?? '').replace(/^error:\s*/i, '').trim()
  return {
    title: firstLine === '' ? fallback : firstLine,
    hint: '再试一次；还不行就把这段原文发出来，好定位。',
    detail,
  }
}

/** toast / 单行提示用：标题 + 下一步，一句话说完。 */
export function humanErrorLine(input: unknown, fallback?: string): string {
  const { title, hint } = humanizeError(input, fallback)
  return `${title}——${hint}`
}

/** 内联错误行用：标题 + 下一步，原文另外给 `detail`（调用方塞进 title 属性）。 */
export function humanErrorText(input: unknown, fallback?: string): { text: string; detail: string } {
  const { title, hint, detail } = humanizeError(input, fallback)
  return { text: `${title}。${hint}`, detail }
}
