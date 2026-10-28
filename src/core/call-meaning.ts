/**
 * 一次调用「要干什么」的中文一句话——审批卡标题下面那行字。
 *
 * 为什么不在界面上现拼：卡上有两类调用，命令类给一段命令行原文，写类给一个路径。
 * 命令原文是给读得懂命令行的人看的；多数人只想知道「它要删我哪个目录」。
 *
 * 这张表是**确定性**的：同一句命令永远得到同一个说法，不调模型、不联网、不加延迟。
 * 认不出来的就直说「运行 xxx 命令」，不猜——用户是拿这句话决定点不点「允许」的，
 * 猜错比不说更糟。
 *
 * 只做「够判断」的解读，不做完整 shell 解析：切段与词元化直接借
 * `core/command-policy` 那一份（与判定危险命令用的是同一套切法），
 * 免得两处对「一段命令」的理解慢慢分叉。
 *
 * @module dsc/core/call-meaning
 */
import { splitSegments, type CommandSegment } from './command-policy.js'

/** 程序名 → 中文动作。键一律小写：去目录前缀、去 `.exe` 之后再查。 */
const PROGRAM_VERBS: Readonly<Record<string, string>> = {
  // 文件与目录
  rm: '删除',
  del: '删除',
  erase: '删除',
  'remove-item': '删除',
  ri: '删除',
  rd: '删除目录',
  rmdir: '删除目录',
  mkdir: '新建目录',
  md: '新建目录',
  'new-item': '新建',
  ni: '新建',
  touch: '新建空文件',
  cp: '复制',
  copy: '复制',
  'copy-item': '复制',
  cpi: '复制',
  xcopy: '复制',
  robocopy: '同步目录',
  mv: '移动',
  move: '移动',
  'move-item': '移动',
  mi: '移动',
  ren: '改名',
  rename: '改名',
  'rename-item': '改名',
  rn: '改名',
  'get-content': '读文件内容',
  gc: '读文件内容',
  cat: '读文件内容',
  type: '读文件内容',
  head: '读文件开头几行',
  tail: '读文件结尾几行',
  'set-content': '写文件内容',
  sc: '写文件内容',
  'out-file': '写文件内容',
  'add-content': '往文件追加内容',
  'clear-content': '清空文件内容',
  'select-string': '在文件里搜文本',
  sls: '在文件里搜文本',
  grep: '在文件里搜文本',
  findstr: '在文件里搜文本',
  'get-childitem': '列目录',
  gci: '列目录',
  ls: '列目录',
  dir: '列目录',
  tree: '列出目录树',
  'set-location': '切换目录',
  cd: '切换目录',
  pushd: '切换目录',
  pwd: '显示当前目录',
  // 网络
  curl: '发网络请求',
  wget: '下载文件',
  'invoke-webrequest': '发网络请求',
  'invoke-restmethod': '调接口',
  ssh: '连远程主机',
  scp: '在主机间拷文件',
  // 运行环境与构建
  node: '跑 Node 脚本',
  tsx: '跑 TypeScript 脚本',
  deno: '跑 Deno 脚本',
  bun: '跑 Bun 脚本',
  python: '跑 Python 脚本',
  python3: '跑 Python 脚本',
  py: '跑 Python 脚本',
  npx: '临时装一个包再跑它',
  pip: '装 Python 包',
  pip3: '装 Python 包',
  uv: '装 Python 包',
  tsc: '做类型检查',
  eslint: '检查代码风格',
  prettier: '格式化代码',
  cargo: '跑 Rust 构建',
  go: '跑 Go 构建',
  make: '按 Makefile 构建',
  msbuild: '构建 .NET 项目',
  dotnet: '跑 .NET 命令',
  // 进程与系统
  taskkill: '结束进程',
  'stop-process': '结束进程',
  'start-process': '启动程序',
  chmod: '改文件权限',
  chown: '改文件所有者',
  attrib: '改文件属性',
  icacls: '改文件访问权限',
  'get-process': '列进程',
  ps: '列进程',
  'get-service': '查服务状态',
  // 压缩
  tar: '打包或解包',
  zip: '压缩',
  unzip: '解压',
  '7z': '压缩或解压',
  'compress-archive': '压缩',
  'expand-archive': '解压',
  // 容器与集群
  docker: '操作容器',
  kubectl: '操作 Kubernetes 集群',
  // 输出与杂项
  echo: '输出一行文字',
  'write-output': '输出文字',
  'write-host': '输出文字',
  sleep: '等待一会',
  'start-sleep': '等待一会',
  'test-path': '判断文件是否存在',
  'set-environmentvariable': '改环境变量',
  // 再开一层解释器：真正干活的是它后面那段脚本
  pwsh: '用 PowerShell 跑一段脚本',
  powershell: '用 PowerShell 跑一段脚本',
  cmd: '用 cmd 跑一段脚本',
  bash: '用 bash 跑一段脚本',
  sh: '用 sh 跑一段脚本',
}

/** 带目标的 git 子命令：只有它们后面那个词元值得写进卡片。 */
const GIT_TARGET_SUBS = new Set([
  'add',
  'checkout',
  'switch',
  'restore',
  'show',
  'blame',
  'diff',
  'rm',
  'clean',
  'log',
  'clone',
  'worktree',
])

/** 一次复制 / 移动的两个端点都要说（只报源不说去向，等于什么也没说）。 */
const TWO_END_VERBS = new Set(['复制', '移动'])

/** `python -m module`：跑的是模块，不是文件。 */
const PYTHON_HEADS = new Set(['python', 'python3', 'py'])

/** `git` 子命令 → 中文。表里没有的退回「用 Git 做版本控制」。 */
const GIT_VERBS: Readonly<Record<string, string>> = {
  status: '看 Git 状态',
  diff: '看 Git 改动',
  log: '看提交历史',
  add: '暂存改动',
  commit: '提交改动',
  push: '推送提交',
  pull: '拉取远端改动',
  fetch: '取远端更新',
  clone: '克隆仓库',
  checkout: '切换分支或文件',
  switch: '切换分支',
  branch: '操作分支',
  merge: '合并分支',
  rebase: '变基',
  reset: '回退提交',
  revert: '撤销一次提交',
  stash: '暂存还没提交的改动',
  tag: '操作标签',
  remote: '管理远端',
  show: '查看某一处提交',
  blame: '查每行是谁改的',
  init: '初始化仓库',
  restore: '恢复文件',
  clean: '删掉未跟踪的文件',
  worktree: '操作工作树',
}

/** 包管理器子命令（npm / pnpm / yarn 共用同一套说法）。 */
const PKG_VERBS: Readonly<Record<string, string>> = {
  install: '装依赖',
  i: '装依赖',
  add: '加依赖',
  ci: '按锁文件装依赖',
  remove: '卸依赖',
  rm: '卸依赖',
  uninstall: '卸依赖',
  update: '升级依赖',
  upgrade: '升级依赖',
  test: '跑测试',
  build: '构建',
  start: '启动项目',
}

/** 包装词：真正干活的是它们后面那个程序。 */
const WRAPPERS = new Set(['sudo', 'doas', 'nohup', 'env', 'command', 'time'])

/** 一句话最多多长（再长卡片就被撑成两行了）。 */
const MAX_LENGTH = 60

/** 目标路径最长显示多长：超了只留最后两级。 */
const MAX_TARGET = 42

/** 词元 → 程序名：去目录前缀、去 `.exe`、小写。 */
function programName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token
  return base.toLowerCase().replace(/\.exe$/, '')
}

/** 一个词元是不是开关（`-Recurse`、`--force`、Windows 上的 `/f`）。 */
function isFlag(token: string): boolean {
  return token.startsWith('-') || /^\/[A-Za-z]{1,3}$/.test(token)
}

/** `NAME=value` 形式的环境变量赋值（`env FOO=bar cmd` 里那一截）。 */
function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

/**
 * 路径缩短：只保留最后两级。
 *
 * 卡上的位置本来就窄，而「D:\dsc\src\plugins\approval.ts」和「…/plugins/approval.ts」
 * 对判断「它要动什么」没有差别。完整路径在参数摘要的悬浮提示里。
 */
function shortenTarget(value: string): string {
  // URL 不按斜杠切：`…/https:/example.com` 这种切法把协议弄没了，不如原样留着。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  if (value.length <= MAX_TARGET) return value
  const parts = value.split(/[\\/]/).filter((part) => part !== '')
  if (parts.length <= 2) return value
  return `…/${parts.slice(-2).join('/')}`
}

/** 取第一个不像开关的操作数（`-Path x` 取到的是 `x`）。 */
function firstOperand(tokens: readonly string[]): string | null {
  for (const token of tokens) {
    if (token === '' || isFlag(token) || isAssignment(token)) continue
    return token
  }
  return null
}

/** 一段命令的中文说法。 */
function phraseOfSegment(segment: CommandSegment): string {
  const tokens = segment.tokens
  let index = 0
  while (index < tokens.length && WRAPPERS.has(programName(tokens[index]!))) index += 1
  while (index < tokens.length && isAssignment(tokens[index]!)) index += 1
  const head = tokens[index]
  if (head === undefined) return '空命令'
  const name = programName(head)
  const rest = tokens.slice(index + 1)

  if (name === 'git') {
    const subIndex = rest.findIndex((token) => !isFlag(token))
    const sub = subIndex < 0 ? undefined : rest[subIndex]!
    const phrase = sub === undefined ? '用 Git 做版本控制' : (GIT_VERBS[sub] ?? `执行 git ${sub}`)
    // 只有「本来就对着一个路径/分支」的子命令才把操作数写上。
    // `git commit -m "修一处标点"` 的操作数是提交信息，写进卡片只会误导。
    const arg = sub === undefined || !GIT_TARGET_SUBS.has(sub) ? null : firstOperand(rest.slice(subIndex + 1))
    return arg === null ? phrase : `${phrase} ${shortenTarget(arg)}`
  }

  if (PYTHON_HEADS.has(name) && rest[0] === '-m') {
    const module = rest[1]
    return module === undefined ? '跑 Python 模块' : `跑 Python 模块 ${module}`
  }

  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'cnpm') {
    const subIndex = rest.findIndex((token) => !isFlag(token))
    const sub = subIndex < 0 ? undefined : rest[subIndex]!
    if (sub === undefined) return `跑 ${name} 包管理命令`
    if (sub === 'run') {
      const script = rest[subIndex + 1]
      return script === undefined ? '跑项目里定义的脚本' : `跑脚本 ${script}`
    }
    return `${name} ${PKG_VERBS[sub] ?? sub}`
  }

  const verb = PROGRAM_VERBS[name]
  if (verb === undefined) return `运行 ${name} 命令`
  const operands = operandsOf(rest)
  const first = operands[0]
  if (first === undefined) return verb
  if (TWO_END_VERBS.has(verb) && operands.length >= 2) {
    return `${verb} ${shortenTarget(first)} → ${shortenTarget(operands[1]!)}`
  }
  return `${verb} ${shortenTarget(first)}`
}

/** 取所有不像开关的操作数（最多三个：再往后都是边角参数）。 */
function operandsOf(tokens: readonly string[]): string[] {
  const out: string[] = []
  for (const token of tokens) {
    if (token === '' || isFlag(token) || isAssignment(token)) continue
    out.push(token)
    if (out.length >= 3) break
  }
  return out
}

/**
 * 一条命令的中文说法。
 *
 * @param command - 命令原文（可以是多行、带管道）
 * @returns 一句中文（可能被截断）；空命令给 null
 */
export function commandMeaning(command: string): string | null {
  const segments = splitSegments(command).filter((segment) => segment.tokens.length > 0)
  const first = segments[0]
  if (first === undefined) return null
  // 多段只细说第一段，其余报个数：管道里七八段的完整解读会变成一篇小作文，
  // 而用户此刻要判断的是「这一下要不要点允许」。
  const text = segments.length === 1 ? phraseOfSegment(first) : `${phraseOfSegment(first)}（共 ${segments.length} 段命令）`
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…` : text
}

/** 工具名 → 中文动作（命令类工具走 {@link commandMeaning}，不走这张表）。 */
const TOOL_VERBS: Readonly<Record<string, string>> = {
  write: '写文件',
  edit: '改文件',
  read: '读文件',
  glob: '按名字找文件',
  grep: '在文件里搜内容',
  run_code: '跑一段脚本',
  tool_call: '转调另一个工具',
  bash: '跑 shell 命令',
  pwsh: '跑 PowerShell 命令',
}

/**
 * 一次工具调用的中文说法：命令类解读命令，写类说清动哪个文件。
 *
 * @param input.toolName - 工具真名
 * @param input.command - 这次要跑的命令（命令类工具才有）
 * @param input.target - 这次要动的绝对路径（写类工具才有）
 * @returns 一句话；认不出来给 null（界面就不画那一行）
 */
export function callMeaning(input: {
  toolName: string
  command?: string | null
  target?: string | null
}): string | null {
  const command = input.command ?? null
  if (command !== null && command.trim() !== '') return commandMeaning(command)
  const verb = TOOL_VERBS[input.toolName]
  if (verb === undefined) return null
  const target = input.target ?? null
  return target === null || target === '' ? verb : `${verb} ${shortenTarget(target)}`
}
