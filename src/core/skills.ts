/**
 * 技能发现与启停：`SKILL.md` 目录包 + 扁平 `.md`，格式对齐 dsh 的本地提供方。
 *
 * 发现根按 rank 排序，**小者赢重名**（项目的同名技能覆盖全局的）：
 *   100 `<cwd>/.dsc/skills`　200 `<cwd>/.agents/skills`　300 config.yaml 自定义
 *   350 `~/.agents/skills`（公共 Agent 目录，与 dsh 同一个位置）
 *   400 `~/.dsc/skills`　450 `$DSH_HOME/skills`（dsh 自己的全局技能，未设环境变量时 `~/.dsh/skills`）

 * 前两个是**项目**作用域，其余是**全局**作用域（契约里的 `scope`）：技能页按这个分组，
 * 与 dsh 设置页「全局技能 / 项目技能」两个页签同一个口径。
 *
 * 启停状态在 `~/.dsc/skills.json`（`{ version, disabled: string[] }`），
 * 停用即从模型目录和 `/技能名` 命令里消失，正文不会被删。
 *
 * @module dsc/core/skills
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import YAML from 'yaml'
import type { SkillInfoView, SkillSourceLabel } from '../contract.js'
import { dscPath } from './path-policy.js'

/** 用户级技能目录（技能中心的导入目标）。 */
export const DSC_SKILLS_DIR = dscPath('skills')

const SKILLS_JSON = dscPath('skills.json')

/** kebab-case 技能名（与 dsh 一致）。 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 一个技能的可摘要信息（正文按需另读）。 */
export interface SkillSummary {
  name: string
  description: string
  whenToUse?: string
  source: SkillSourceLabel
  /** 小 rank 赢得重名技能。 */
  rank: number
  /** SKILL.md 绝对路径；插件注册的虚拟技能没有。 */
  path?: string
  modelInvocable: boolean
  userInvocable: boolean
  /** true = 文件型技能（可启停、可编辑）。 */
  local: boolean
  problem?: string
  /** 全局 / 项目作用域（技能页的分组依据）。 */
  scope?: SkillScope
  /** 发现根目录（分组头显示「这些技能来自哪」）。 */
  root?: string
}

/** 技能的作用域：项目内发现根 vs 用户主目录下的全局根。 */
export type SkillScope = 'project' | 'global'

/** 完整技能（含正文）。 */
export interface SkillDefinition extends SkillSummary {
  content: string
}

/** 一个发现根。 */
export interface SkillRoot {
  dir: string
  source: SkillSourceLabel
  rank: number
  /** 这一根算项目技能还是全局技能（技能页按它分两组）。 */
  scope: SkillScope
}

/** 把 config.yaml 里写的目录展开成绝对路径（支持 `~`、`~/x` 与相对 cwd）。 */
export function expandSkillDir(raw: string, cwd: string): string {
  const trimmed = raw.trim().replace(/^["']|["']$/g, '')
  if (trimmed === '') return ''
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\\\')) return trimmed
  return resolve(cwd, trimmed)
}

/** 各发现根（自定义目录来自 config.yaml 的 `skills:` 段）。 */export function skillRoots(cwd: string, customDirs: readonly string[] = []): SkillRoot[] {
  const roots: SkillRoot[] = [
    { dir: join(cwd, '.dsc', 'skills'), source: 'project-dsc', rank: 100, scope: 'project' },
    { dir: join(cwd, '.agents', 'skills'), source: 'project-agents', rank: 200, scope: 'project' },
    ...customDirs.map((dir) => ({ dir, source: 'custom' as SkillSourceLabel, rank: 300, scope: 'global' as const })),
    // 公共 Agent 目录：dsh 设置页里那一组「公共 Agent」就是它（`~/.agents/skills`）。
    { dir: join(homedir(), '.agents', 'skills'), source: 'user-agents', rank: 350, scope: 'global' },
    { dir: DSC_SKILLS_DIR, source: 'user-dsc', rank: 400, scope: 'global' },
    { dir: dshSkillsDir(), source: 'user-dsh', rank: 450, scope: 'global' },
  ]
  return dedupeRoots(roots).filter((root) => existsSync(root.dir))
}

/** frontmatter + 正文解析结果。 */
export interface ParsedSkillFile {
  /** frontmatter 里的 name（非法或缺失时 undefined）。 */
  name?: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  content: string
  problem?: string
}

/** 拆 YAML frontmatter；没有 frontmatter 时整篇都是正文。 */
export function splitFrontmatter(text: string): { front: string; body: string } {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return { front: '', body: text }
  return { front: match[1] ?? '', body: text.slice(match[0].length) }
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value === 'true' || value === 'yes') return true
    if (value === 'false' || value === 'no') return false
  }
  return fallback
}

/** 解析一个技能文件（`disable-model-invocation` / `user-invocable` 缺省都为 true）。 */
export function parseSkillMarkdown(text: string): ParsedSkillFile {
  const { front, body } = splitFrontmatter(text)
  let doc: Record<string, unknown> = {}
  let problem: string | undefined
  if (front.trim() !== '') {
    try {
      doc = (YAML.parse(front) as Record<string, unknown>) ?? {}
    } catch (error) {
      problem = `frontmatter 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`
    }
  }
  const rawName = typeof doc.name === 'string' ? doc.name.trim() : ''
  const description = typeof doc.description === 'string' ? doc.description.trim() : ''
  const whenRaw = doc['when-to-use'] ?? doc.when_to_use ?? doc.whenToUse
  return {
    name: rawName === '' ? undefined : rawName,
    description,
    whenToUse: typeof whenRaw === 'string' && whenRaw.trim() !== '' ? whenRaw.trim() : undefined,
    modelInvocable: !asBoolean(doc['disable-model-invocation'], false),
    userInvocable: asBoolean(doc['user-invocable'], true),
    content: body.trim(),
    problem,
  }
}

/** 读并解析一个技能文件（名字取 frontmatter，非法则退回文件名/目录名）。 */
export function loadSkillFile(
  filePath: string,
  source: SkillSourceLabel,
  rank: number,
  fallbackName: string,
): SkillDefinition {
  const parsed = parseSkillMarkdown(readFileSync(filePath, 'utf8'))
  const candidate = parsed.name ?? fallbackName
  const legal = NAME_PATTERN.test(candidate)
  const name = legal ? candidate : fallbackName
  const nameProblem = legal
    ? undefined
    : `名字「${candidate}」不是 kebab-case（小写字母数字用短横线相连），按 ${fallbackName} 处理`
  return {
    name,
    description:
      parsed.description === ''
        ? `${fallbackName}（frontmatter 没写 description，模型只能凭名字猜）`
        : parsed.description,
    whenToUse: parsed.whenToUse,
    source,
    rank,
    path: filePath,
    modelInvocable: parsed.modelInvocable,
    userInvocable: parsed.userInvocable,
    local: true,
    problem:
      parsed.problem !== undefined
        ? `${parsed.problem}${nameProblem !== undefined ? `；${nameProblem}` : ''}`
        : nameProblem,
    content: parsed.content,
  }
}

/**
 * dsh 自己的全局技能目录：`$DSH_HOME/skills`，没设环境变量时 `~/.dsh/skills`。
 *
 * 为什么读它：用户在 dsh 里攒下的全局技能（本机 7 个）没必要搬一份进来。
 * 如果 `DSH_HOME` 被指到 Pneuma 自己的家目录（`~/.dsc`），这根与 `user-dsc` 是同一个目录，
 * 调用方会用 {@link dedupeRoots} 去掉重复，不会把同一批技能扫两遍。
 */
export function dshSkillsDir(): string {
  const home = (process.env.DSH_HOME ?? '').trim()
  if (home !== '') return join(home, 'skills')
  return join(homedir(), '.dsh', 'skills')
}

/** 按目录去重（同一个目录被两条根指向时保留 rank 小的那条）。 */
function dedupeRoots(roots: readonly SkillRoot[]): SkillRoot[] {
  const seen = new Set<string>()
  const kept: SkillRoot[] = []
  for (const root of [...roots].sort((a, b) => a.rank - b.rank)) {
    const key = resolve(root.dir).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(root)
  }
  return kept
}

/** 扫一个发现根（只认顶层 `<name>/SKILL.md` 与顶层 `<name>.md`，与 dsh 一致不做递归）。 */
export function scanSkillRoot(root: SkillRoot): SkillDefinition[] {
  const found: SkillDefinition[] = []
  for (const entry of readdirSync(root.dir, { withFileTypes: true })) {
    const full = join(root.dir, entry.name)
    if (entry.isDirectory()) {
      const skillFile = join(full, 'SKILL.md')
      if (existsSync(skillFile)) found.push(loadSkillFile(skillFile, root.source, root.rank, entry.name))
      continue
    }
    if (!entry.name.endsWith('.md') || entry.name.toLowerCase() === 'readme.md') continue
    found.push(loadSkillFile(full, root.source, root.rank, basename(entry.name, '.md')))
  }
  // 作用域与来源目录由根决定，技能文件自己说了不算。
  return found.map((skill) => ({ ...skill, scope: root.scope, root: root.dir }))
}

/** 被停用的技能名集合。 */
export function readDisabledSkills(): Set<string> {
  if (!existsSync(SKILLS_JSON)) return new Set()
  try {
    const doc = JSON.parse(readFileSync(SKILLS_JSON, 'utf8')) as { disabled?: unknown }
    return new Set(
      Array.isArray(doc.disabled)
        ? doc.disabled.filter((entry): entry is string => typeof entry === 'string')
        : [],
    )
  } catch {
    return new Set()
  }
}

/** 写启停状态；返回写盘后的停用集合。 */
export function writeSkillEnabled(name: string, enabled: boolean): Set<string> {
  const disabled = readDisabledSkills()
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  mkdirSync(dirname(SKILLS_JSON), { recursive: true })
  writeFileSync(SKILLS_JSON, `${JSON.stringify({ version: 1, disabled: [...disabled].sort() }, null, 2)}\n`, 'utf8')
  return disabled
}

/** 投影成 UI 视图（技能中心与设置分区共用）。 */
export function toSkillInfoView(summary: SkillSummary, disabled: ReadonlySet<string>): SkillInfoView {
  return {
    name: summary.name,
    description: summary.description,
    whenToUse: summary.whenToUse,
    source: summary.source,
    path: summary.path,
    enabled: !disabled.has(summary.name),
    modelInvocable: summary.modelInvocable,
    userInvocable: summary.userInvocable,
    toggleable: summary.local,
    problem: summary.problem,
    scope: summary.scope ?? 'global',
    root: summary.root,
  }
}
