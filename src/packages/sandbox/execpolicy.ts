/**
 * 沙箱命令策略（形制照 codex 的 execpolicy）：一条 shell 命令 → allow / prompt / forbidden。
 *
 * 与 `core/command-policy.ts` 的分工（两份东西长得像但判的不是一件事）：
 *   - `command-policy` 回答「这条命令危不危险、要不要问人」，它是**审批面**，
 *     结论是 allow/ask/deny，且 deny 是任何权限模式都翻不了的硬地板；
 *   - 本模块回答「这条命令会不会写到可写根之外 / 要不要联网」，它是**围栏面**，
 *     结论是 allow/prompt/forbidden，forbidden 只代表「沙箱不同意」。
 *   三处共用同一份「命令意图」（`core/command-intent.ts`：程序名、子命令、内联脚本、联网、写目标），
 *   切段也只有一份实现。优先级写在那个模块的注释里：地板 → 围栏 → 审批，前两道更严是有意的。
 *   围栏先拦下时要把审批面的结论写进理由（见 {@link approvalHint}），否则用户只看到「卡没弹」。
 *
 * 规则表是内置的：沙箱的策略值不值得让用户手写 DSL，先看有没有人真的想改；
 * 现在给的是 codex 那批机器级改动（计划任务、注册表、网络、ACL、引导）+
 * 一批明确只读的 allow 前缀。`allow` 不等于免审批卡——那是审批层的事（见插件注释）。
 *
 * 边界（老老实实写在这里）：这一层认得出**写在命令里的**写目标与网络命令，
 * 认不出「`node build.js` 里那行 fs.writeFile 写了哪」「子进程 curl 拉了哪个地址」。
 * 这就是 `enforcement: partial` 的准确含义。
 *
 * @module dsc/core/sandbox/execpolicy
 */
import { classifyCommand, splitSegments, type CommandSegment } from '../../core/command-policy.js'
import {
  commandName,
  innerShellCommand,
  isNetworkSegment,
  writeTargetsOf,
} from '../../core/command-intent.js'
import type { PathCheck } from './policy.js'

// 写目标、联网与内联脚本的判定在 core/command-intent.ts（三个判定面共用一份事实）；
// 这里保留同名导出，别处照旧 import。
export { innerShellCommand, isNetworkSegment, writeTargetsOf }

/** 一次命令判定的三种结论。 */
export type ExecDecision = 'allow' | 'prompt' | 'forbidden'

/** 一条命令前缀规则。 */
export interface ExecRule {
  /** 稳定名字（自检与诊断按它对号入座）。 */
  name: string
  decision: ExecDecision
  /** 词元前缀；末尾 `*` 吃掉剩余词元。 */
  pattern: readonly string[]
  /** 命中前缀之后还要满足的附加条件（表达「icacls 且带 /grant」这类）。 */
  requires?: (segment: CommandSegment) => boolean
  /** 给模型与用户看的中文理由。 */
  justification: string
}

/** 命中即 forbidden：机器级改动面（关掉它们等于关掉「改机器」这件事）。 */
const FORBIDDEN_RULES: readonly ExecRule[] = [
  {
    name: 'schtasks',
    decision: 'forbidden',
    pattern: ['schtasks'],
    justification: '计划任务能让任意命令常驻执行（后门面），沙箱里不做这件事',
  },
  {
    name: 'reg-write',
    decision: 'forbidden',
    pattern: ['reg', 'add'],
    justification: '写注册表是机器级改动，且常被用来做持久化',
  },
  {
    name: 'reg-delete',
    decision: 'forbidden',
    pattern: ['reg', 'delete'],
    justification: '删注册表键会破坏已装软件与系统设置',
  },
  {
    name: 'reg-import',
    decision: 'forbidden',
    pattern: ['reg', 'import'],
    justification: '导入注册表文件等于一次性写一批机器级配置，内容看不清',
  },
  {
    name: 'netsh',
    decision: 'forbidden',
    pattern: ['netsh'],
    justification: '改网络/防火墙配置属于机器级改动',
  },
  {
    name: 'bcdedit',
    decision: 'forbidden',
    pattern: ['bcdedit'],
    justification: '改引导配置，写错就开不了机',
  },
  {
    name: 'takeown',
    decision: 'forbidden',
    pattern: ['takeown'],
    justification: '抢占文件所有权是提权的前置动作',
  },
  {
    name: 'icacls-grant',
    decision: 'forbidden',
    pattern: ['icacls'],
    requires: (segment) => segment.tokens.some((token) => /^\/(grant|setowner|reset|inheritance)/i.test(token)),
    justification: '改文件 ACL / 把权限开给别的账号，等于把数据交出去（只读的 icacls 另说）',
  },
  {
    name: 'diskpart',
    decision: 'forbidden',
    pattern: ['diskpart'],
    justification: '分区级操作，数据不可恢复',
  },
  {
    name: 'vssadmin',
    decision: 'forbidden',
    pattern: ['vssadmin'],
    justification: '卷影副本是最后的回滚手段，删它等于把退路拆掉',
  },
  {
    name: 'wbadmin',
    decision: 'forbidden',
    pattern: ['wbadmin'],
    justification: '改备份与系统状态，写错就失去恢复能力',
  },
  {
    name: 'bootrec',
    decision: 'forbidden',
    pattern: ['bootrec'],
    justification: '改引导记录，写错就开不了机',
  },
]

/** 明确只读/构建类：允许在沙箱内直接跑（真正免不免审批卡由审批层决定）。 */
const ALLOW_RULES: readonly ExecRule[] = [
  { name: 'git-status', decision: 'allow', pattern: ['git', 'status'], justification: '看仓库状态，只读' },
  { name: 'git-diff', decision: 'allow', pattern: ['git', 'diff'], justification: '看改动内容，只读' },
  { name: 'git-log', decision: 'allow', pattern: ['git', 'log'], justification: '看提交历史，只读' },
  { name: 'list-posix', decision: 'allow', pattern: ['ls'], justification: '列目录，只读' },
  { name: 'list-win', decision: 'allow', pattern: ['dir'], justification: '列目录，只读' },
  { name: 'pnpm-build', decision: 'allow', pattern: ['pnpm', 'run', 'build'], justification: '构建工作区，产物落在工作区内' },
  { name: 'pnpm-test', decision: 'allow', pattern: ['pnpm', 'test'], justification: '跑测试' },
]

/** 内置规则表（forbidden 在前，匹配时先看它们）。 */
export const BUILTIN_EXEC_RULES: readonly ExecRule[] = [...FORBIDDEN_RULES, ...ALLOW_RULES]

// ---------------------------------------------------------------- 词元工具

/** 前缀匹配：`pattern` 是段词元的前缀，末尾 `*` 表示后面随便。 */
function matchExecRule(rule: ExecRule, segment: CommandSegment): boolean {
  if (segment.tokens.length === 0) return false
  for (let i = 0; i < rule.pattern.length; i += 1) {
    const want = rule.pattern[i]!
    if (want === '*') break
    const got = segment.tokens[i]
    if (got === undefined) return false
    if (commandName(got) !== want.toLowerCase()) return false
  }
  return rule.requires === undefined ? true : rule.requires(segment)
}

// ---------------------------------------------------------------- 判定入口

/**
 * 把命令摊平成待判定的段：外层照旧保留（它的重定向还得看），
 * 认得出的内层脚本再拆一次（最多两层，够覆盖 `powershell -Command "sh -c ..."` 这种叠法）。
 */
function expandSegments(command: string, win32: boolean, depth = 0): CommandSegment[] {
  const out: CommandSegment[] = []
  for (const segment of splitSegments(command)) {
    if (depth < 4) {
      const inner = innerShellCommand(segment, win32)
      if (inner !== null && inner.trim() !== '') out.push(...expandSegments(inner, win32, depth + 1))
    }
    out.push(segment)
  }
  return out
}

export interface ExecOptions {
  /** 网络开关：关时命中网络命令 → forbidden。 */
  networkAccess: boolean
  /** 写目标判定（由路径策略提供，认不出来时保守拒）。 */
  checkWrite: (raw: string) => PathCheck
  /** 规则表（默认内置；自检里可换一份）。 */
  rules?: readonly ExecRule[]
  /** Windows 口径（默认取当前平台）。 */
  win32?: boolean
}

/** 一次命令判定的完整结果。 */
export interface ExecVerdict {
  decision: ExecDecision
  /** 定案的那条：内置规则名 / `network-off` / `write-target` / `default`。 */
  rule: string
  reason: string
  /** 认出来的写目标（原文，未绝对化）。 */
  writeTargets: readonly string[]
  /** 这条命令里有没有网络动作。 */
  network: boolean
}

/**
 * 围栏先拦下时，把审批面的结论作为提示带出来。
 *
 * 为什么要有：`git push --force` 在审批面是「问人」，在网络关的沙箱里是硬拒。
 * 策略上沙箱更严是对的——网络开关是显式关掉的，不该被一张卡绕过去（见
 * `packages/sandbox/index.ts` 的 `ASKABLE_RULES`）；但用户只看到「沙箱拒绝」，
 * 会以为审批面也拒了。这里把另一面的结论一并写进理由，**只改文案，不改任何判定**。
 *
 * 文案为什么不说死「会弹卡」（2026-11-09 复审）：这一层既拿不到当前权限档，也没把已授权规则
 * 传进去，答不了「到底弹不弹」。「仅查看」档与无人值守子代理会把 ask 直接拒
 * （`packages/approval/index.ts:1318-1327`），有 allow 前缀规则时又根本不弹卡；
 * 写死「会弹卡问人」在这两种情况下都是错的。所以只说审批面要不要人工确认。
 */
function approvalHint(command: string): string {
  const verdict = classifyCommand(command)
  if (verdict.decision === 'allow') return '（审批面把这条命令判为只读，会直接放行）'
  if (verdict.decision === 'deny') return '（审批面同样会拒这条命令）'
  return '（这条命令在审批面需要人工确认；是否真的弹卡取决于当前权限档与已授权规则）'
}

/**
 * 判一条命令。
 *
 * 逐段判（`|`、`;`、`&&` 切开），任何一段 forbidden 就是整条 forbidden；
 * 全部只读放行才是 allow；其余是 prompt（交审批卡）。
 * 顺序：内置 forbidden 规则 → 网络开关 → 写目标归属 → allow 规则。
 * 带重定向/变量/子 shell 的段不给走 allow 规则（照 codex 那条「结构不可验证就不放行」）。
 * 内层脚本（`powershell -Command "..."`、`sh -c ...`）会再拆一层一起判——
 * 不拆的话写目标藏在引号里，等于没有围栏。
 */
export function evaluateCommand(command: string, options: ExecOptions): ExecVerdict {
  const rules = options.rules ?? BUILTIN_EXEC_RULES
  const win32 = options.win32 ?? process.platform === 'win32'
  const segments = expandSegments(command, win32)
  const writeTargets: string[] = []
  let network = false
  let decision: ExecDecision = 'allow'
  const loose: string[] = []

  for (const segment of segments) {
    if (segment.tokens.length === 0) continue

    const forbidden = rules.find((rule) => rule.decision === 'forbidden' && matchExecRule(rule, segment))
    if (forbidden !== undefined) {
      return {
        decision: 'forbidden',
        rule: forbidden.name,
        reason: `命令规则「${forbidden.name}」禁止这一段：${forbidden.justification}`,
        writeTargets,
        network,
      }
    }

    if (isNetworkSegment(segment, win32)) {
      network = true
      if (!options.networkAccess) {
        return {
          decision: 'forbidden',
          rule: 'network-off',
          reason: `这一段要联网（${segment.raw.trim()}），而沙箱的网络开关是关的${approvalHint(command)}；要放行先打开网络开关`,
          writeTargets,
          network,
        }
      }
    }

    for (const target of writeTargetsOf(segment, win32)) {
      writeTargets.push(target)
      const check = options.checkWrite(target)
      if (!check.allowed) {
        return {
          decision: 'forbidden',
          rule: `write-target:${check.rule}`,
          reason: `命令里的写目标落不住：${check.reason}${approvalHint(command)}`,
          writeTargets,
          network,
        }
      }
    }

    const allowed = !segment.ruleUnfriendly && rules.some((rule) => rule.decision === 'allow' && matchExecRule(rule, segment))
    if (!allowed) {
      decision = 'prompt'
      loose.push(segment.raw.trim())
    }
  }

  if (decision === 'allow') {
    return { decision: 'allow', rule: 'allow-rule', reason: '各段都命中放行规则（只读/构建）', writeTargets, network }
  }
  const shown = loose.slice(0, 3).join('；')
  return {
    decision: 'prompt',
    rule: 'default',
    reason: `没命中沙箱的放行规则，按默认交给审批卡：${shown}`,
    writeTargets,
    network,
  }
}
