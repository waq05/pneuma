/**
 * 命令意图：一段命令「真正在跑什么」的共享判定。
 *
 * 为什么单独成文件：同一条命令在三个地方各判一次——审批面 `core/command-policy`、
 * 围栏面 `packages/sandbox/execpolicy`、灾难地板 `packages/approval-floor`。
 * 三处都要回答同一组事实：程序是谁、一级子命令是什么、脚本是不是藏在参数里、要不要联网、
 * 会写到哪些路径。以前这套判断各写一遍，同一段命令在三处的程序名都不一样
 * （`sudo ls` 在审批面是 `sudo`、在围栏面是 `ls`），「谁更严」于是变成偶然。
 * 这里统一**事实**，不替任何一方定档：三处各自保留自己的档位
 * （allow/ask/deny、allow/prompt/forbidden、deny/defer）。
 *
 * 但下面有几张表是「口径」而不是「事实」，改它们等于同时改三面的判定，别以为只影响一处：
 *   - `NETWORK_SUBCOMMANDS` 定「哪个子命令算联网」（`docker run` 算）；
 *   - `FULL_WRITE_HEADS` / `COPY_HEADS` / `MOVE_HEADS` / `CONTENT_HEADS` 定「哪个程序的哪些词元算写目标」
 *     （`cp` 只算最后一个词元）；
 *   - `WRITE_COMMAND_HEADS` 定「哪些程序的写目标判得清」，灾难地板按它判内联脚本能不能放行。
 *
 * 两个程序名是有意分开的，不是重复：
 *   - {@link CommandIntent.verb} 是「命令行第一个词是谁」，审批面按它判只读：
 *     `sudo ls` 不算只读（剥掉 sudo 就等于给提权后的任意命令开了免审批）；
 *   - {@link CommandIntent.effectiveVerb} 剥掉 sudo/env 这类包装，围栏面与地板按它判
 *     写目标、联网与关机：`sudo rm x` 真正动手的是 rm。
 * 把两者混成一个，要么让 `sudo ls` 免审批，要么让 `sudo rm` 逃掉写目标检查。
 *
 * 三处的优先级（守卫链按 order 从小到大，第一位给 deny 或 pass 的赢）：
 *   1. 灾难地板（order 5）：结构判不清、灾难命令、deny 名单 → 直接拒；
 *   2. 沙箱围栏（order 8）：写目标越界、网络开关关着时命中网络命令 → 直接拒；
 *   3. 审批面（order 30）：危险模式 → 弹卡问人，只读 → 放行。
 * 前两道比审批面严是**有意的**：可写根与网络开关是用户显式设的边界，不该被一张卡绕过去。
 * 所以「审批面说 ask、围栏说 forbidden」不是冲突，最终结果就是 forbidden；
 * 但围栏必须把审批面的结论写进拒绝理由（见 `packages/sandbox/execpolicy` 的 `approvalHint`），
 * 否则用户只会看到「没弹卡」，不知道是谁拦的、打开什么开关才能放行。
 *
 * @module dsc/core/command-intent
 */
import type { CommandSegment } from './command-policy.js'

/**
 * 剥掉之后才露出真程序的包装词。
 *
 * `exec` / `time` 只在地板原先的名单里，`sudo` / `env` 等在围栏面也有；
 * 这里取并集：多认一个包装只会让写目标与联网判定更全（更严），不会漏判。
 */
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'exec', 'env', 'nohup', 'time'])

/** 词元 → 程序名（去目录、去 `.exe`、小写）。 */
export function commandName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token
  return base.toLowerCase().replace(/\.exe$/, '')
}

/** 剥掉包装词与环境变量赋值之后的程序下标（-1 = 认不出）。 */
function headIndex(tokens: readonly string[]): number {
  let index = 0
  while (index < tokens.length && WRAPPERS.has(commandName(tokens[index]!))) index += 1
  // `env FOO=bar cmd`：跳过环境变量赋值
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1
  return index < tokens.length ? index : -1
}

/** 从真程序开始的词元（程序自己在 [0]）。 */
function effectiveArgv(tokens: readonly string[]): readonly string[] {
  const index = headIndex(tokens)
  return index < 0 ? [] : tokens.slice(index)
}

/** 真程序名（剥包装、去目录、去 `.exe`、小写）；认不出返回空串。 */
function effectiveVerbOf(tokens: readonly string[]): string {
  const index = headIndex(tokens)
  return index < 0 ? '' : commandName(tokens[index]!)
}

/**
 * 审批面口径的词元：只剥 `env` 与 `VAR=value`，**不剥 sudo**。
 *
 * 这里刻意不认目录前缀（`/usr/bin/env` 不剥），与审批面原来的判定逐字一致：
 * 放松这一条会让 `env ls` 从「问人」变成「只读放行」。
 */
function verbArgv(tokens: readonly string[]): readonly string[] {
  let index = 0
  while (index < tokens.length && tokens[index]!.toLowerCase().replace(/\.exe$/, '') === 'env') index += 1
  const wrapped = index > 0
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1
  // 裸 `env`（后面没有命令）就是打印环境变量，仍然只读。
  if (wrapped && index >= tokens.length) return ['env']
  return tokens.slice(index)
}

// ---------------------------------------------------------------- 子命令

/** git 自己的「开关后面跟一个值」清单（审批面原来那份，另加 `--config`）。 */
const GIT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config',
])

/** 其余程序（npm / pnpm / docker …）的「开关后面跟一个值」清单。 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-c', '-C', '--git-dir', '--work-tree', '--namespace',
  '--dir', '--prefix', '--cwd', '--workspace', '-w',
  '--registry', '--config', '--userconfig', '--cache', '--reporter', '--filter',
])

/** 一个词元是不是开关（Windows 上 `/f` 这类也算，`/tmp/x` 算路径）。 */
function isFlag(token: string, win32: boolean): boolean {
  if (token === '-') return true
  if (token.startsWith('-')) return true
  if (win32 && /^\/[A-Za-z]{1,3}$/.test(token)) return true
  return false
}

/**
 * 取一级子命令（`git push` 的 push、`npm install` 的 install）：跳过开关与开关的值。
 *
 * 为什么不简单取「第一个不以 - 开头的词元」：`pnpm --dir . install` 的 `.`
 * 会先被当成子命令，于是整条命令被判成「不联网」——网络开关关着也能装包（2026-10-28 实测）。
 * git 单独一套开关清单，避免把 npm 的 `-w` 当成 git 的「带值开关」而跳过真子命令。
 */
function subcommandOf(tokens: readonly string[], win32: boolean, verb: string): string | undefined {
  const valueFlags = verb === 'git' ? GIT_VALUE_FLAGS : VALUE_FLAGS
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (isFlag(token, win32)) {
      if (valueFlags.has(token.toLowerCase())) index += 1
      continue
    }
    return token
  }
  return undefined
}

// ---------------------------------------------------------------- 写目标

// 下面四张表是「写命令 → 哪些词元算写目标」的共用口径：围栏按它判越界，
// 地板按它判内层脚本的写目标判不判得清。合起来加上 `dd` 就是地板用的写命令白名单。
/** 所有非开关词元都是「被改动的路径」（删/建/截断/写内容：源自己就动手了）。 */
const FULL_WRITE_HEADS = new Set([
  'rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri',
  'mkdir', 'md', 'new-item', 'ni', 'touch', 'truncate', 'tee', 'clear-content',
])

/** 只有**最后一个**非开关词元是写目标（源可能在可写根之外，只是读它）。 */
const COPY_HEADS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy', 'install'])

/** 源同样被改动（移走就是删掉），所以所有词元都算目标。 */
const MOVE_HEADS = new Set(['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rn'])

/** 写目标是 `-Path` 一类的值，没有就给第一个非开关词元。 */
const CONTENT_HEADS = new Set(['set-content', 'add-content', 'out-file', 'export-csv', 'export-clixml'])

/** `-Path` 这一族（写目标用的）。 */
const PATH_FLAGS = new Set(['-path', '-filepath', '-literalpath', '-file'])
/** `-Destination` 这一族。 */
const DEST_FLAGS = new Set(['-destination', '-dest'])

/**
 * 写命令白名单：这些程序写哪里，{@link writeTargetsOf} 能静态认出来。
 *
 * 用途只有一处：灾难地板拆出内联脚本后，判断「内层这条命令的写目标判不判得清」。
 * 不在名单里、又不是明确只读的程序（`find -delete` 的 `find`、`for` 循环、`Start-Process`
 * 二层壳、`Invoke-Expression`）一律按「判不出」拒——它们的写目标可能藏在循环体、参数
 * 或二层壳里，围栏只认命令行上的字面量，看不见这些形状。
 *
 * `dd` 的写目标是 `of=`，由 {@link writeTargetsOf} 单独收，所以不在上面四张表里。
 */
const WRITE_COMMAND_HEADS: ReadonlySet<string> = new Set([
  ...FULL_WRITE_HEADS,
  ...COPY_HEADS,
  ...MOVE_HEADS,
  ...CONTENT_HEADS,
  'dd',
])

/**
 * 这个程序名在不在写命令白名单里（写目标能被 {@link writeTargetsOf} 认出来）。
 *
 * @param verb - 真程序名（{@link CommandIntent.effectiveVerb} 的口径，已小写、去 `.exe`）。
 */
export function isWriteCommandVerb(verb: string): boolean {
  return WRITE_COMMAND_HEADS.has(verb)
}

/** 重定向词元 → 写目标（`''` = 目标在下一个词元；null = 不是文件重定向）。 */
function redirectTarget(token: string): string | null {
  const match = /^(\d?>>?)(.*)$/.exec(token)
  if (match === null) return null
  const rest = match[2] ?? ''
  // `2>&1`、`>&2` 只是接文件描述符，不落盘
  if (rest.startsWith('&')) return null
  return rest
}

/**
 * 从一段命令里认出所有「会被写到的路径」。
 *
 * 认的是形状，不是语义：`rm`/`mv`/`Set-Content`/`>`/`dd of=` 这些齐了，
 * 但 `bash -c "rm x"` 里的写目标要靠 {@link inlineShellOf} 拆出内层再判——
 * 这正是策略围栏「拦得住工具调用、拦不住命令内部」的那一半。
 *
 * `cp`/`copy` 只算**最后一个**词元（源在可写根之外只是读它，算成写会误拒）；
 * `mv`/`rm` 算全部（源被移走或被删，同样是动手）。
 */
export function writeTargetsOf(segment: CommandSegment, win32: boolean): string[] {
  const tokens = segment.tokens
  const out: string[] = []
  const push = (value: string | undefined): void => {
    if (value === undefined) return
    const trimmed = value.trim()
    if (trimmed === '') return
    out.push(trimmed)
  }

  // 1) 重定向：`> x`、`>>x`、`1> x`；`2>&1` 不算
  for (let i = 0; i < tokens.length; i += 1) {
    const target = redirectTarget(tokens[i]!)
    if (target === null) continue
    push(target === '' ? tokens[i + 1] : target)
  }

  // 2) `dd` 的 `of=`（`if=` 是读）
  for (const token of tokens) {
    const match = /^of=(.+)$/i.exec(token)
    if (match !== null) push(match[1])
  }

  const head = effectiveVerbOf(tokens)
  if (head === '') return [...new Set(out)]

  // 3) 命令自身的词元（跳过程序名自己）
  const command = headIndex(tokens)
  const operands: string[] = []
  /** 已经用 `-Path`/`-Destination` 指名道姓说过目标了：位置参数不再当路径。 */
  let explicit = false
  for (let i = 0; i < tokens.length; i += 1) {
    if (i === command) continue
    const token = tokens[i]!
    const redirect = redirectTarget(token)
    if (redirect !== null) {
      // 目标已在第 1 步收过：下一个词元别再当操作数
      if (redirect === '') i += 1
      continue
    }
    if (/^of=/i.test(token)) continue
    if (isFlag(token, win32)) {
      const lowered = token.toLowerCase()
      const value = tokens[i + 1]
      if (value !== undefined && !isFlag(value, win32)) {
        if (DEST_FLAGS.has(lowered)) {
          push(value)
          explicit = true
          i += 1
          continue
        }
        if (PATH_FLAGS.has(lowered)) {
          // `cp -Path a -Destination b`：a 是源，不算写
          if (!COPY_HEADS.has(head)) {
            push(value)
            explicit = true
          }
          i += 1
          continue
        }
      }
      continue
    }
    operands.push(token)
  }

  // 开关已经指明了目标时，剩下的位置参数多半是别的东西的值（`-Value hello`、`-ItemType Directory`），
  // 一律不再当路径——宁可漏算一个写目标（还有审批卡兜底），也别凭空造出一个越界判断。
  if (explicit) return [...new Set(out)]

  if (COPY_HEADS.has(head)) {
    push(operands[operands.length - 1])
  } else if (MOVE_HEADS.has(head) || FULL_WRITE_HEADS.has(head)) {
    for (const operand of operands) push(operand)
  } else if (CONTENT_HEADS.has(head)) {
    // 只认位置参数里的第一个（`Set-Content x.txt -Value hello` 的 hello 不是路径）
    push(operands[0])
  }
  return [...new Set(out)]
}

// ---------------------------------------------------------------- 网络命令

/** 一级词元就是网络工具的。 */
const NETWORK_HEADS = new Set([
  'curl', 'wget', 'iwr', 'invoke-webrequest', 'irm', 'invoke-restmethod',
  'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'ssh', 'scp', 'sftp', 'rsync',
  'test-netconnection', 'resolve-dnsname', 'gh',
])

/** 「程序 + 子命令」形态的网络动作（共用口径：改这张表等于同时改三面的联网判定）。 */
const NETWORK_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(['install', 'i', 'ci', 'add', 'create', 'update', 'publish', 'dlx', 'exec', 'x']),
  npx: new Set(['*']),
  pnpm: new Set(['install', 'i', 'add', 'update', 'publish', 'dlx', 'create', 'exec']),
  yarn: new Set(['install', 'add', 'upgrade', 'publish', 'dlx', 'create']),
  git: new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule', 'archive']),
  pip: new Set(['install', 'download']),
  pip3: new Set(['install', 'download']),
  cargo: new Set(['install', 'add', 'update', 'publish', 'login']),
  go: new Set(['get', 'install']),
  docker: new Set(['pull', 'push', 'login', 'run', 'build']),
  dotnet: new Set(['restore', 'add', 'nuget', 'tool']),
  apt: new Set(['install', 'update', 'upgrade']),
  'apt-get': new Set(['install', 'update', 'upgrade']),
  yum: new Set(['install', 'update']),
  dnf: new Set(['install', 'update']),
  apk: new Set(['add', 'update']),
  brew: new Set(['install', 'update', 'upgrade']),
  choco: new Set(['install', 'upgrade']),
  winget: new Set(['install', 'upgrade', 'search']),
  scoop: new Set(['install', 'update']),
  nuget: new Set(['install', 'restore']),
}

/**
 * 这一段要不要联网。
 *
 * @param segment - 一段命令（`splitSegments` 的产物）。
 * @param win32 - Windows 口径（`/x` 算开关）。
 */
export function isNetworkSegment(segment: CommandSegment, win32 = process.platform === 'win32'): boolean {
  const tokens = segment.tokens
  const head = effectiveVerbOf(tokens)
  if (head === '') return false
  if (NETWORK_HEADS.has(head)) return true
  const subs = NETWORK_SUBCOMMANDS[head]
  if (subs === undefined) return false
  if (subs.has('*')) return true
  const sub = subcommandOf(effectiveArgv(tokens), win32, head)
  if (sub === undefined) return false
  return subs.has(commandName(sub))
}

// ---------------------------------------------------------------- 内联脚本

/** 认得出的「把命令写在参数里」的 shell：它们后面那段要再拆一次判。 */
const INLINE_SHELL_HEADS = new Set(['powershell', 'pwsh', 'cmd', 'sh', 'bash', 'zsh', 'dash', 'ksh'])

/** 内层命令的开关名（按平台各自习惯，两边都认，宽进严出）。 */
const INLINE_FLAGS = new Set(['-command', '--command', '-c', '/c', '/k', '-encodedcommand', '-enc'])

/** 这些开关后面的内容是编码过的，拆出来也是一串 base64，不能当明文命令判。 */
const ENCODED_INLINE_FLAGS = new Set(['-encodedcommand', '-enc'])

/** 一段命令里「脚本写在参数里」的形态。 */
export interface InlineShell {
  /** 外层 shell 名（powershell / cmd / bash …，已剥包装词）。 */
  head: string
  /** 命中开关的原文（小写：`-command` / `/c` / `-c`）。 */
  flag: string
  /** 开关后面的脚本原文（词元按空格拼回，引号在词元化时已剥）。 */
  command: string
  /** 内层脚本能不能静态判：`-EncodedCommand` / `-enc` 为 false。 */
  parseable: boolean
}

/**
 * 这一段是不是「跑一段写在参数里的脚本」：是的话把那段脚本原文交出来。
 *
 * 为什么必须拆：`powershell -Command "Set-Content -Path C:\outside\x -Value y"` 的写目标
 * 藏在引号里，只看外层这一个词元（`powershell`）什么都看不出来——这是最常见的绕过写法。
 * 只认开关后面的那段（`sh -c rm x` 这种没加引号的按空格拼回去），认不出就不猜。
 * 编码过的命令照样返回，但 `parseable: false`，调用方必须按「判不出」处理。
 *
 * @returns 内层脚本；不是这种形态返回 null。
 */
export function inlineShellOf(segment: CommandSegment, win32 = process.platform === 'win32'): InlineShell | null {
  const tokens = segment.tokens
  const head = effectiveVerbOf(tokens)
  if (!INLINE_SHELL_HEADS.has(head)) return null
  const start = headIndex(tokens)
  for (let i = start + 1; i < tokens.length; i += 1) {
    const token = tokens[i]!
    const lowered = token.toLowerCase()
    if (INLINE_FLAGS.has(lowered)) {
      const rest = tokens.slice(i + 1)
      // 开关后面没有脚本：跑不出东西，但语义上是「判不出」，不能返回 null 让调用方当成
      // 「这不是内联形态」——那样 `bash -c` 会从地板的硬拒降成一张审批卡（2026-11-09 复审）。
      if (rest.length === 0) return { head, flag: lowered, command: '', parseable: false }
      return { head, flag: lowered, command: rest.join(' '), parseable: !ENCODED_INLINE_FLAGS.has(lowered) }
    }
    // `sh -c'rm -rf /'` 这种写法在词元化之后 `-c` 会和脚本粘成一个词元，所以还要按前缀认一次。
    if (lowered.startsWith('-c') && lowered.length > 2 && !/^-[a-z]+$/.test(lowered)) {
      const rest = tokens.slice(i + 1)
      const glued = token.slice(2)
      return {
        head,
        flag: '-c',
        command: [glued, ...rest].filter((part) => part !== '').join(' '),
        parseable: true,
      }
    }
  }
  return null
}

/**
 * 内层脚本原文（`powershell -Command "..."`、`sh -c ...`）：不是这种形态或编码过就返回 null。
 *
 * 保留这个入口是因为沙箱的 `expandSegments` 原来就按它递归；编码命令不能递归，
 * 否则 base64 会被当成一条明文命令再判一遍，等于把「看不清」洗成「看着没事」。
 */
export function innerShellCommand(segment: CommandSegment, win32: boolean): string | null {
  const inline = inlineShellOf(segment, win32)
  return inline === null || !inline.parseable ? null : inline.command
}

// ---------------------------------------------------------------- 判定入口

/** 一段命令的意图（只陈述事实，不含任何档位）。 */
export interface CommandIntent {
  /** 命令行第一个词（只剥 `env`/`VAR=`，不剥 sudo）：审批面按它判只读。 */
  verb: string
  /** 真正动手的程序（剥 sudo/env 等包装、去目录、去 `.exe`）：围栏面按它判写目标与联网。 */
  effectiveVerb: string
  /** 从 {@link verb} 开始的词元（程序自己在 [0]）。 */
  argv: readonly string[]
  /** 从 {@link effectiveVerb} 开始的词元（程序自己在 [0]）。 */
  effectiveArgv: readonly string[]
  /** 一级子命令（git 的 push、npm 的 install）；没有就是 undefined。 */
  subcommand: string | undefined
  /** 「脚本写在参数里」的形态；不是这种形态为 null。 */
  inline: InlineShell | null
  /** 要不要联网。 */
  network: boolean
  /** 会被写到的路径（原文，未绝对化）。 */
  targets: readonly string[]
}

/**
 * 判一段命令的意图。
 *
 * 这是三个判定面共用的一份「事实」：审批面拿 `verb`/`argv`/`subcommand` 判只读，
 * 围栏面拿 `effectiveVerb`/`network`/`targets` 判围栏，地板拿 `inline` 判「能不能看清」。
 * 各自怎么定档仍然写在各处，这里不替任何一方做决定。
 *
 * @param segment - 一段命令（`splitSegments` 的产物）。
 * @param win32 - Windows 口径（`/x` 算开关）。
 */
export function commandIntent(segment: CommandSegment, win32 = process.platform === 'win32'): CommandIntent {
  const tokens = segment.tokens
  const argv = verbArgv(tokens)
  const effective = effectiveArgv(tokens)
  const verb = argv[0] === undefined ? '' : argv[0].toLowerCase().replace(/\.exe$/, '')
  const effectiveVerb = effective[0] === undefined ? '' : commandName(effective[0])
  return {
    verb,
    effectiveVerb,
    argv,
    effectiveArgv: effective,
    subcommand: effectiveVerb === '' ? undefined : subcommandOf(effective, win32, effectiveVerb),
    inline: inlineShellOf(segment, win32),
    network: isNetworkSegment(segment, win32),
    targets: writeTargetsOf(segment, win32),
  }
}
