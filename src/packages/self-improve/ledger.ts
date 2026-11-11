/**
 * 技能变更台账：`~/.dsc/skills/.ledger.jsonl`（每次技能落盘都追加一行，回滚靠它查）。
 *
 * 为什么要有一份台账：技能是会被「下一次的我」当成操作手册照做的文件，改错了不会当场报错，
 * 而是在几天后的一次执行里出事。所以每次变更都留一条「谁、什么时候、动了哪个技能、
 * 改前改后的内容指纹、原文件的副本在哪」，用户 `/skills-ledger rollback <id>` 就能退回去。
 *
 * 三条设计上的取舍：
 *   1. **台账本身不是闸门**：写台账失败不影响这次写入（日志级问题不该让功能瘫掉），
 *      但 `rollbackEntry` 反过来——它拿不到副本就明确报错，不许「假装回滚成功」。
 *   2. 指纹用 sha256 前 16 位：人要在 `/skills-ledger` 里看得懂，128 位已经足够拦住
 *      「文件被外面改过」这一类误判。
 *   3. 回滚本身也记一条台账。回滚不是「撤销历史」，而是又一次变更，历史链条不能断。
 *
 * @module dsc/core/learnings/ledger
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { archiveRoot, readUsage, skillsRoot, SKILL_FILE, writeUsage } from './skill-write.js'

/** 谁动的手：模型（工具调用）还是用户（命令 / 设置按钮 / 老化整理）。 */
export type LedgerActor = 'model' | 'user'

/** 一次变更的类型。`rollback` 是回滚本身记的那条。 */
export type LedgerAction = 'create' | 'patch' | 'write_file' | 'archive' | 'rollback'

/** 台账里的一行。 */
export interface LedgerEntry {
  id: string
  /** 毫秒时间戳（人看用 `tsText`，机器算用这个）。 */
  ts: number
  actor: LedgerActor
  action: LedgerAction
  skill: string
  /** 改前的 SKILL.md 内容指纹；技能不存在时是空内容的指纹。 */
  beforeHash: string
  /** 改后的指纹；归档这种「文件不在了」的动作是空内容的指纹。 */
  afterHash: string
  /** 改前那份原文件的副本文件名（在技能目录里，与 SKILL.md 同级）；没有副本就没有这个字段。 */
  backup?: string
  /** 一句话说明（给 `/skills-ledger` 看）。 */
  note?: string
}

/** 空内容的指纹：技能「本来不存在」与「存在但为空」在台账里必须能分开看。 */
export const EMPTY_HASH = hashText('')

/** 内容指纹：sha256 前 16 位。 */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** 文件指纹；文件不存在返回 {@link EMPTY_HASH}。 */
export function hashFileOf(file: string): string {
  try {
    return existsSync(file) ? hashText(readFileSync(file, 'utf8')) : EMPTY_HASH
  } catch {
    return EMPTY_HASH
  }
}

/** 台账文件路径。 */
export function ledgerFile(): string {
  return join(skillsRoot(), '.ledger.jsonl')
}

/** 某条台账对应的原文件副本路径（技能目录里，与 SKILL.md 同级）。 */
export function backupPathOf(entry: Pick<LedgerEntry, 'skill' | 'backup'>): string | null {
  if (entry.backup === undefined || entry.backup === '') return null
  return join(skillsRoot(), entry.skill, basename(entry.backup))
}

/** 短 id：8 位十六进制，够手打。 */
function newLedgerId(): string {
  return createHash('sha1').update(`${String(Date.now())}:${Math.random()}`).digest('hex').slice(0, 8)
}

/**
 * 追加一条台账。
 *
 * 用「读全文 + 追加 + tmp + rename」而不是 `appendFileSync`：这个文件同时被回滚与设置页读，
 * 追加写只保证一行不撕裂，不保证读的人看到的是完整行；整份重写的代价在几百行的量级完全不值一提。
 * 写失败直接抛给调用方——调用方（skill-write）会把它当成 `notice` 里的提醒而不是拒绝理由。
 */
export function appendLedger(entry: Omit<LedgerEntry, 'id' | 'ts'> & { id?: string; ts?: number }): LedgerEntry {
  const file = ledgerFile()
  mkdirSync(dirname(file), { recursive: true })
  const record: LedgerEntry = {
    id: entry.id ?? newLedgerId(),
    ts: entry.ts ?? Date.now(),
    actor: entry.actor,
    action: entry.action,
    skill: entry.skill,
    beforeHash: entry.beforeHash,
    afterHash: entry.afterHash,
    ...(entry.backup === undefined ? {} : { backup: entry.backup }),
    ...(entry.note === undefined ? {} : { note: entry.note }),
  }
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const head = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${head}${JSON.stringify(record)}\n`, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件已经不在了：忽略
    }
    throw error
  }
  return record
}

function parseEntry(line: string): LedgerEntry | null {
  let doc: unknown
  try {
    doc = JSON.parse(line)
  } catch {
    return null
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null
  const raw = doc as Record<string, unknown>
  const actions: readonly string[] = ['create', 'patch', 'write_file', 'archive', 'rollback']
  const id = typeof raw.id === 'string' ? raw.id : ''
  const skill = typeof raw.skill === 'string' ? raw.skill : ''
  const action = raw.action
  if (id === '' || skill === '' || typeof action !== 'string' || !actions.includes(action)) return null
  const ts = Number(raw.ts)
  return {
    id,
    ts: Number.isFinite(ts) ? Math.trunc(ts) : 0,
    actor: raw.actor === 'model' ? 'model' : 'user',
    action: action as LedgerAction,
    skill,
    beforeHash: typeof raw.beforeHash === 'string' ? raw.beforeHash : '',
    afterHash: typeof raw.afterHash === 'string' ? raw.afterHash : '',
    ...(typeof raw.backup === 'string' && raw.backup !== '' ? { backup: raw.backup } : {}),
    ...(typeof raw.note === 'string' && raw.note !== '' ? { note: raw.note } : {}),
  }
}

/** 读台账，新的在前；坏行跳过。`limit` 只取最近若干条。 */
export function readLedger(limit?: number): LedgerEntry[] {
  const file = ledgerFile()
  if (!existsSync(file)) return []
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: LedgerEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const parsed = parseEntry(line)
    if (parsed !== null) out.push(parsed)
  }
  out.sort((a, b) => b.ts - a.ts)
  const trimmed = limit === undefined || limit <= 0 ? out : out.slice(0, limit)
  return trimmed
}

/** 按 id 找一条。 */
export function findLedgerEntry(id: string): LedgerEntry | undefined {
  return readLedger().find((entry) => entry.id === id)
}

/** 台账里某个技能最新的一条非回滚变更（self-improve 自检探针钉住；插件侧暂无调用方）。 */
export function lastChangeOf(skill: string): LedgerEntry | undefined {
  return readLedger().find((entry) => entry.skill === skill && entry.action !== 'rollback')
}

/** 台账一行在命令里的显示文案。 */
export function formatLedgerEntry(entry: LedgerEntry): string {
  const when = new Date(entry.ts).toLocaleString('zh-CN', { hour12: false })
  const backup = entry.backup === undefined ? '' : ` · 副本 ${entry.backup}`
  return `[${entry.id}] ${when} · ${entry.actor} · ${entry.action} · ${entry.skill} · ${entry.beforeHash}→${entry.afterHash}${backup}${entry.note === undefined ? '' : ` · ${entry.note}`}`
}

/** 回滚结果。 */
export interface RollbackResult {
  ok: boolean
  error: string
  /** 成功时给用户看的一句话。 */
  notice: string
}

/** 原子写一个文本文件（tmp + rename）：回滚恢复也用这条路径，保证不会写出一份半截文件。 */
function atomicWriteText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // 忽略
    }
    throw error
  }
}

/**
 * 按改前指纹在归档区里认出技能那一份。
 *
 * 归档目录名带时间戳（`<名字>-20261111…`），光看名字认不出「是哪一次搬走的」，
 * 只能按内容指纹对号：`curateSkills` / `archiveSkill` 现在都会把真实指纹记进台账，
 * 回滚就靠它把这份和那一条对上。
 */
function findArchivedByHash(skill: string, beforeHash: string): string | null {
  const root = archiveRoot()
  if (!existsSync(root)) return null
  let names: string[] = []
  try {
    names = readdirSync(root).sort()
  } catch {
    return null
  }
  const prefix = `${skill}-`
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      const file = join(dir, SKILL_FILE)
      if (!existsSync(file)) continue
      if (hashText(readFileSync(file, 'utf8')) === beforeHash) return dir
    } catch {
      // 这一份读不出来就跳过去看下一份
    }
  }
  return null
}

/**
 * 回滚一条变更：把 SKILL.md 恢复成那条变更改之前的内容。
 *
 * 四种情况分开处理：
 *   - 台账里记了副本（patch / write_file）→ 用副本内容盖回去，写完核对指纹对不对；
 *   - `archive` 且记了真实指纹 → 去归档区按指纹找到那一份，整目录搬回技能目录，
 *     顺便把使用台账的档位改回 `active`（否则文件回来了，目录里照样看不到它）；
 *   - `create` 且没有副本（文件本来不存在）→ 把整个技能目录搬进 `.archive/`，**绝不删**；
 *   - 其余（副本丢了、旧版归档没记指纹、动作没有可恢复的语义）→ 明确报错，不许假装成功。
 *
 * @param id - 台账 id。
 * @param now - 回滚那条台账的时间戳（自检要造历史时用）。
 */
export function rollbackEntry(id: string, now = Date.now()): RollbackResult {
  const entry = findLedgerEntry(id)
  if (entry === undefined) return { ok: false, error: `台账里没有 id 为 ${id} 的记录（/skills-ledger 看清单）`, notice: '' }
  const skillMd = join(skillsRoot(), entry.skill, SKILL_FILE)
  const currentHash = hashFileOf(skillMd)
  const backup = backupPathOf(entry)

  if (backup !== null && existsSync(backup)) {
    let original = ''
    try {
      original = readFileSync(backup, 'utf8')
    } catch (error) {
      return { ok: false, error: `副本读不出来：${error instanceof Error ? error.message : String(error)}`, notice: '' }
    }
    if (hashText(original) !== entry.beforeHash) {
      return { ok: false, error: `副本内容与台账记的改前指纹对不上（${hashText(original)} ≠ ${entry.beforeHash}），这次不回滚`, notice: '' }
    }
    try {
      atomicWriteText(skillMd, original)
    } catch (error) {
      return { ok: false, error: `恢复失败：${error instanceof Error ? error.message : String(error)}`, notice: '' }
    }
    appendLedger({
      actor: 'user',
      action: 'rollback',
      skill: entry.skill,
      beforeHash: currentHash,
      afterHash: entry.beforeHash,
      backup: basename(backup),
      note: `回滚 ${entry.id}（${entry.action}）`,
      ts: now,
    })
    return { ok: true, error: '', notice: `已把 ${entry.skill}/SKILL.md 还原成 ${entry.id} 之前的内容（${entry.beforeHash}）` }
  }

  if (entry.action === 'archive' && entry.beforeHash !== EMPTY_HASH) {
    const dir = join(skillsRoot(), entry.skill)
    if (existsSync(dir)) {
      return { ok: false, error: `技能 ${entry.skill} 的目录又出现了（${dir}），不覆盖它：要恢复请先把它挪开`, notice: '' }
    }
    const archived = findArchivedByHash(entry.skill, entry.beforeHash)
    if (archived === null) {
      return {
        ok: false,
        error: `归档区里找不到内容指纹为 ${entry.beforeHash} 的 ${entry.skill}（可能被手动改过或搬走），回滚不了`,
        notice: '',
      }
    }
    try {
      mkdirSync(skillsRoot(), { recursive: true })
      renameSync(archived, dir)
    } catch (error) {
      return { ok: false, error: `从归档区搬回来失败：${error instanceof Error ? error.message : String(error)}`, notice: '' }
    }
    // 文件回来了，档位也要跟着回来：还挂着 archived 的话，它照样进不了模型可见目录。
    try {
      const doc = readUsage()
      const record = doc.skills[entry.skill]
      if (record !== undefined) {
        record.state = 'active'
        record.archivedAt = null
        writeUsage(doc)
      }
    } catch {
      // 档位没改回来不影响文件已经回来这件事：下一次命中也会把它拉回 active
    }
    appendLedger({
      actor: 'user',
      action: 'rollback',
      skill: entry.skill,
      beforeHash: EMPTY_HASH,
      afterHash: entry.beforeHash,
      note: `回滚 ${entry.id}（archive）：从归档区 ${basename(archived)} 搬回技能目录`,
      ts: now,
    })
    return { ok: true, error: '', notice: `已把 ${entry.skill} 从归档区搬回 ${dir}（内容指纹 ${entry.beforeHash}）` }
  }

  if (entry.action === 'archive') {
    return {
      ok: false,
      error: '这条归档记录没有改前指纹（旧版只记了空 hash），认不出归档区里是哪一份：去 .archive/ 里按目录名手动搬回',
      notice: '',
    }
  }

  if (entry.action === 'create' && entry.beforeHash === EMPTY_HASH) {
    const dir = join(skillsRoot(), entry.skill)
    if (!existsSync(dir)) return { ok: false, error: `技能 ${entry.skill} 已经不在了，没什么可回滚`, notice: '' }
    const target = join(archiveRoot(), `${entry.skill}-${String(Math.floor(now / 1000))}-rollback`)
    try {
      mkdirSync(archiveRoot(), { recursive: true })
      renameSync(dir, target)
    } catch (error) {
      return { ok: false, error: `搬进归档区失败：${error instanceof Error ? error.message : String(error)}`, notice: '' }
    }
    appendLedger({
      actor: 'user',
      action: 'rollback',
      skill: entry.skill,
      beforeHash: currentHash,
      afterHash: EMPTY_HASH,
      note: `回滚 ${entry.id}：这个技能是那次 create 建出来的，已整目录搬进归档区`,
      ts: now,
    })
    return { ok: true, error: '', notice: `已把 ${entry.skill} 整个目录搬进归档区 ${target}（只搬不删，要恢复就把它搬回来）` }
  }

  return {
    ok: false,
    error: `这条记录没有可用的副本（${entry.backup === undefined ? '台账里没记副本' : `副本 ${entry.backup} 不见了`}），回滚不了`,
    notice: '',
  }
}

/** 台账文件多大（设置页显示与「该整理了」这类判断用）。 */
export function ledgerSize(): number {
  const file = ledgerFile()
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').length : 0
  } catch {
    return 0
  }
}

/** 把一个文件复制成 `<原名>.bak.<秒级时间戳>`，返回副本文件名；失败返回空串。 */
export function copyToBackup(file: string, now = Date.now()): string {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const backup = `${basename(file)}.bak.${String(Math.floor(now / 1000))}`
    copyFileSync(file, join(dirname(file), backup))
    return backup
  } catch {
    // 留不下副本也得继续往下走：副本是保险，不是这条规矩的全部
    return ''
  }
}
