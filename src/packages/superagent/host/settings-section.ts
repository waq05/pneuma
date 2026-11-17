/**
 * DSC 宿主设置分区：把新树的「设置块 + 来源 kind」投影成 `packages/settings` 能画的分区。
 *
 * ## 为什么单独一个文件
 *
 * 平台设置页的控件声明（`SettingsSectionSpec`）是 DSC 专有接线：上游 dsh-superagent 的
 * 设置面是它自己的管理面板（`src/client/settings.tsx`），没有这份「宿主声明 + 宿主回调」的
 * 契约。所以 `createSettingsSection` 从旧入口搬出来单独放，`index.ts` 只做一行登记。
 *
 * ## 字段从哪来（全部现读运行期，不另存一份）
 *
 * - **执行 / 判定块**：`runtime.store.settings()` 里的 `executor.*` 与 `eval.*`；
 *   保存走 `runtime.settings.save('executor' | 'eval', ...)`（`app/settings.ts` 的乐观并发 +
 *   schema 校验 + 角色模型可用性检查都在那一层，本文件不自建第二条写路径）。
 * - **来源配置**：`runtime.sources.instances()` 列已装来源，每个 kind 的 `fields` 声明
 *   （`sources/github.ts`、`sources/feishu.ts`、第三方包自己的 kind）在这里翻成
 *   `SettingsField`，**字段类型一个不丢**：`rows` 原样过成记录表（列里 `pattern` / `optional` /
 *   `choose` / `refresh` 照搬），`fact` 原样过成只读事实行（`settings: 'deployment'` 标记保留）。
 *   label / hint 本来就是 `{zh,en}`，按宿主当前界面语言取一份，不再往本包词典里加一套重复词条。
 *   保存走 `runtime.settings.save('source:<id>', ...)`，配置 schema、账号检查与重启都由
 *   `app/settings.ts` / `app/setup.ts` 负责。
 * - **策略名单**：`kind.policy.fields`（`allowed` / `bots` / `syncChat`）走
 *   `runtime.settings.save('policy', ...)`；`allowed` 沿用旧键 `githubAllowed` / `feishuAllowed`。
 * - **部署事实**：`kind.facts(runtime.setup.deployment)` 只读。声明过同名字段（`type: 'fact'`）
 *   的直接落在那条控件上；没声明的（GitHub / 飞书的当前账号 / 机器人）补一条只读事实行。
 *   部署检查没过时值给空串让壳画占位，不编造读数。
 *
 * ## 键名为什么还叫 `maxWorkers` / `evalMode` / `githubRepository`
 *
 * 旧分区那批键与界面词典（`locale/ui.zh.json` 的 `field.<key>.label`）、「最近变更」的
 * 标签是同一套；新树同名语义的一对一映射继续用旧键，界面标签与历史行不会突然变成键名。
 * 新树独有的项用 `<来源>.<字段>` / `<来源>.policy.<字段>`，界面认不出时按键名显示。
 *
 * ## 不在本文件的东西
 *
 * 旧入口的 `repoPath` / `ticketTimeoutSeconds` / `confirmInferred` / `githubTokenEnv` 这些字段
 * 在新树里没有对应存储：仓库归属改由 GitHub 来源的 `repository` 配置决定、工单不再有超时与
 * 推断候选收件箱、令牌也不再落环境变量（改用 `gh`/`lark-cli` 的登录账号）。它们不在这里伪装成
 * 还能生效的开关。
 *
 * @module dsc/packages/superagent/host/settings-section
 */
import { join } from 'node:path'
import type { SettingsRowColumn, SettingsRowValue } from '@pneuma/runtime/contract.js'
import { hostT, hostUiLanguage } from '@pneuma/runtime/core/i18n.js'
import type { SettingsField, SettingsSectionSpec, SettingsValue, SettingsValues } from '@pneuma/runtime/services/types.js'
import type { Runtime } from '../app/runtime.js'
import { LIMITS } from '../core/limits.js'
import type { Settings as SettingsConfig } from '../core/policy.js'
import type { Deployment } from '../deployment.js'
import type { FieldSpec, Localized, SourceKind } from '../sources/kind.js'

/** 取本包自己的界面词典（本文件在 `host/` 下，包根是上一级）。 */
const t = hostT(join(import.meta.dirname, '..'))

/** 分区 id：与 `cordis.patch.yml` 的 `id`、`CONFIG_KEY`、界面页的 `SECTION_ID` 同一把钥匙。 */
const SECTION_ID = 'superagent'

/**
 * 旧分区键 → 新树来源配置键。
 *
 * 没列进来的字段用 `<来源>.<字段>`；列进来的保留旧键，界面词典与设置历史照旧能取到标签。
 */
const LEGACY_CONFIG_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  github: { repository: 'githubRepository' },
  feishu: { cli: 'feishuCli', chats: 'feishuChats', directMessages: 'feishuDirect' },
}
/** 旧分区键 → 新树来源开关：只有飞书在旧面板里有一格显式开关，GitHub 的开关是「仓库填没填」。 */
const LEGACY_ENABLED_KEYS: Readonly<Record<string, string>> = { feishu: 'feishuEnabled' }
/** 旧分区键 → 新树策略名单字段。 */
const LEGACY_POLICY_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  github: { allowed: 'githubAllowed' },
  feishu: { allowed: 'feishuAllowed' },
}
/** 角色模型的写法说明（与旧帮助文案同义，但值现在存成 `{provider, model}`）。 */
const MODEL_PLACEHOLDER = 'provider/model'
/** 模型写成 `provider/model` 之外的样子时给的单句提示（本包词典没有这条键，不硬塞进字典）。 */
const MODEL_FORMAT_ERROR = 'Write provider/model, for example deepseek/deepseek-chat'

/** 取一条新树声明的本地化文案；宿主语言由 `config.yaml` 的 `language:` 决定。 */
function localized(text: Localized): string {
  return hostUiLanguage() === 'en' ? text.en : text.zh
}

/** 某个来源的「启用」开关在分区里的键。 */
function enabledKeyOf(id: string): string {
  return LEGACY_ENABLED_KEYS[id] ?? `${id}.enabled`
}

/** 某个来源配置字段在分区里的键。 */
function configKeyOf(id: string, key: string): string {
  return LEGACY_CONFIG_KEYS[id]?.[key] ?? `${id}.${key}`
}

/** 某个来源策略字段在分区里的键。 */
function policyKeyOf(id: string, key: string): string {
  return LEGACY_POLICY_KEYS[id]?.[key] ?? `${id}.policy.${key}`
}

/** 把未知异常压成一行可读文本；zod 的报错取第一条 issue，别把整段 JSON 甩给用户。 */
function describe(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const issues = (error as { issues?: unknown }).issues
    if (Array.isArray(issues)) {
      const first = issues[0] as { message?: unknown } | undefined
      if (typeof first?.message === 'string' && first.message !== '') return first.message
    }
  }
  return error instanceof Error ? error.message : String(error)
}

/** 角色模型 → 设置面的一行文本；没配 = 空串（与旧分区一致）。 */
function roleModelText(model: SettingsConfig['eval']['model']): string {
  return model === null ? '' : `${model.provider}/${model.model}`
}

/** 设置面的一行文本 → 角色模型；空串 = 不配，格式不对按「不配」处理（旧入口同一取舍）。 */
function roleModelOf(text: string): SettingsConfig['eval']['model'] {
  if (text === '') return null
  const cut = text.lastIndexOf('/')
  if (cut <= 0 || cut === text.length - 1) return null
  const provider = text.slice(0, cut).trim()
  const model = text.slice(cut + 1).trim()
  return provider === '' || model === '' ? null : { provider, model }
}

/** 记录表（rows）的一列：字段声明 → 契约里的列声明（`choose` / `refresh` 只保留「有候选」这一位）。 */
type RowColumn = Extract<FieldSpec, { type: 'rows' }>['columns'][number]

function columnOf(column: RowColumn): SettingsRowColumn {
  if (column.type === 'select') {
    return {
      key: column.key, label: localized(column.label), type: 'select',
      options: column.options.map(option => ({ value: option.value, label: localized(option.label) })),
    }
  }
  return {
    key: column.key, label: localized(column.label), type: 'text',
    ...(column.pattern === undefined ? {} : { pattern: column.pattern }),
    ...(column.optional === true ? { optional: true } : {}),
    ...(column.choose === undefined ? {} : { choose: true }),
    ...(column.refresh === undefined ? {} : { refresh: true }),
  }
}

/** 记录表（rows）字段的当前值 → 契约里的行表（列值统一转成字符串，缺格留空串）。 */
function rowsValueOf(field: FieldSpec, raw: unknown): SettingsRowValue[] {
  if (field.type !== 'rows') return []
  const rows = Array.isArray(raw) ? raw as Record<string, unknown>[] : []
  return rows.map(row => {
    const cells: SettingsRowValue = {}
    for (const column of field.columns) {
      const value = row[column.key]
      cells[column.key] = value === undefined || value === null ? '' : String(value)
    }
    return cells
  })
}

/** 控件值统一成 `SettingsValue`：下拉 / 文本是字符串，开关是布尔，数字是数字，记录表是行表。 */
function valueOf(field: FieldSpec, raw: unknown): SettingsValue {
  switch (field.type) {
    case 'switch': return raw === true
    case 'number': return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
    case 'rows': return rowsValueOf(field, raw)
    case 'fact': return ''
    case 'select': return typeof raw === 'string' ? raw : String(raw ?? '')
    case 'text': return typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw)
  }
}

/**
 * 行表的回写：界面给的行表 → 来源 schema 要的形状。
 *
 * 空行（表格控件「添加一行」先提交的占位）不算数据，丢掉；可选文本列空着不落键；下拉列没选时
 * 取第一个选项（schema 里的枚举列没有缺省值，空着必然被拒）。最终校验仍在 `Settings.save`。
 */
function rowsOfValue(field: FieldSpec, value: SettingsValue): Record<string, string>[] {
  if (field.type !== 'rows') return []
  const records = Array.isArray(value) ? value as SettingsRowValue[] : []
  const key = field.columns[0]?.key ?? 'id'
  const rows: Record<string, string>[] = []
  for (const record of records) {
    const row: Record<string, string> = {}
    for (const column of field.columns) {
      const raw = record[column.key]
      const cell = typeof raw === 'string' ? raw.trim() : ''
      if (cell === '' && column.type === 'text' && column.optional === true) continue
      row[column.key] = column.type === 'select' && cell === '' ? column.options[0]?.value ?? '' : cell
    }
    // 首列（行的键）空着 = 还没填的行，不写进配置。
    if ((row[key] ?? '') === '') continue
    rows.push(row)
  }
  return rows
}

/** 控件值 → 来源 schema 要的形状；数字不合法时原样交给 schema 拒绝，报错由 `Settings.save` 给。 */
function parseFieldValue(field: FieldSpec, value: SettingsValue): unknown {
  switch (field.type) {
    case 'switch': return value === true
    case 'number': return Number(value)
    case 'select': return String(value)
    case 'text': return String(value).trim()
    case 'rows': return rowsOfValue(field, value)
    // fact 字段只读，`sourceTargetOf` 不会把它交到这里。
    case 'fact': return ''
  }
}

/**
 * 一个来源字段声明 → 设置控件，**不丢字段类型**。
 *
 * 上游来源卡片的 `fields` 与设置契约的 `SettingsField` 是同一套形状（text / number / select /
 * switch / rows / fact），投影这一层只做本地化与键名映射：`rows` 原样过成记录表（列里的
 * `pattern` / `optional` / `choose` / `refresh` 照搬），`fact` 原样过成只读事实行
 * （`settings: 'deployment'` 标记保留）。所以第三方来源包只写一个 kind，设置页就自动多出
 * 对应的表格与只读事实——这正是 W10「加第三种来源」纵向切片要证明的扩展点。
 */
function sourceFieldOf(key: string, field: FieldSpec): SettingsField {
  const label = localized(field.label)
  const hint = field.hint === undefined ? '' : localized(field.hint)
  const help = (extra?: Localized): { help?: string } => {
    const whole = [hint, extra === undefined ? '' : localized(extra)].filter(part => part !== '').join('；')
    return whole === '' ? {} : { help: whole }
  }
  switch (field.type) {
    case 'switch': return { type: 'switch', key, label, ...help() }
    case 'number': return { type: 'number', key, label, min: field.min, max: field.max, ...help() }
    case 'select': return { type: 'select', key, label, options: field.options.map(option => ({ value: option.value, label: localized(option.label) })), ...help() }
    case 'text': return { type: 'text', key, label, mono: true, ...help(field.choose) }
    case 'rows': return {
      type: 'rows', key, label, columns: field.columns.map(columnOf), ...help(),
      ...(field.advanced === true ? { advanced: true } : {}),
    }
    case 'fact': return {
      type: 'fact', key, label, ...help(),
      ...(field.settings === undefined ? {} : { settings: field.settings }),
      ...(field.advanced === true ? { advanced: true } : {}),
    }
  }
}

/** 执行 / 判定块的控件（键沿用旧分区那批，界面词典与设置历史照旧取得到标签）。 */
function blockFields(): SettingsField[] {
  return [
    {
      type: 'number', key: 'maxWorkers', label: t('field.maxWorkers.label'),
      min: LIMITS.maxWorkers.min, max: LIMITS.maxWorkers.max, step: 1, help: t('field.maxWorkers.help'),
    },
    {
      type: 'text', key: 'prepareCommand', label: t('field.prepareCommand.label'),
      placeholder: 'pnpm install', mono: true, help: t('field.prepareCommand.help'),
    },
    {
      type: 'select', key: 'evalMode', label: t('field.evalMode.label'), help: t('field.evalMode.help'),
      options: [
        { value: 'observe', label: t('field.evalMode.option.observe') },
        { value: 'auto', label: t('field.evalMode.option.auto') },
        { value: 'off', label: t('field.evalMode.option.off') },
      ],
    },
    {
      type: 'number', key: 'evalTimeoutSeconds', label: t('field.evalTimeoutSeconds.label'),
      min: LIMITS.evalTimeoutSeconds.min, max: LIMITS.evalTimeoutSeconds.max, step: 30, help: t('field.evalTimeoutSeconds.help'),
    },
    {
      type: 'text', key: 'assessorModel', label: t('field.assessorModel.label'),
      placeholder: MODEL_PLACEHOLDER, mono: true, help: t('field.assessorModel.help'),
    },
    {
      type: 'text', key: 'workerModel', label: t('field.workerModel.label'),
      placeholder: MODEL_PLACEHOLDER, mono: true, help: t('field.workerModel.help'),
    },
    {
      type: 'text', key: 'workerBlockedCommands', label: t('field.workerBlockedCommands.label'),
      // 新树的拦截按「命令名」匹配（`CommandNameSchema`），不接受带参数的正条命令，占位就写命令名。
      placeholder: 'npm, docker', mono: true, help: t('field.workerBlockedCommands.help'),
    },
  ]
}

/** 部署事实行的标签：取同名字段声明的标签，找不到就用键名。 */
function factLabel(kind: SourceKind, key: string): string {
  const field = kind.fields.find(item => item.key === key)
  return field === undefined ? key : localized(field.label)
}

/** 一个来源的部署事实（只读）：`字段键 → 文本`；部署检查没过或该 kind 没有事实时是空表。 */
function factsOf(kind: SourceKind, deployment: Deployment | undefined): Record<string, string> {
  const facts = kind.facts?.(deployment) ?? {}
  const text: Record<string, string> = {}
  for (const [key, fact] of Object.entries(facts)) text[key] = typeof fact === 'string' ? fact : localized(fact)
  return text
}

/** 声明过 `fact` 字段的键：这些键已按控件投影，不再补第二条只读事实行。 */
function declaredFactKeys(kind: SourceKind): Set<string> {
  return new Set(kind.fields.flatMap(field => field.type === 'fact' ? [field.key] : []))
}

/** 部署事实在分区里的键：事实值没有同名控件时用它补一条只读行。 */
function factKeyOf(id: string, key: string): string {
  return `${id}.deployment.${key}`
}

/** 已装来源的控件：启用开关 + kind 的配置字段 + 策略字段 + 没声明成控件的部署事实。 */
function sourceFields(runtime: Runtime): SettingsField[] {
  const settings = runtime.store.settings()
  const deployment = runtime.setup.configured() ? runtime.setup.deployment : undefined
  const fields: SettingsField[] = []
  for (const instance of runtime.sources.instances(settings)) {
    const kind = runtime.sources.kind(instance.id)
    if (kind === undefined) continue
    fields.push({ type: 'switch', key: enabledKeyOf(instance.id), label: localized(kind.title), help: localized(kind.description) })
    // 配置字段原样投影：text / number / select / switch / rows / fact 六支一个不丢。
    for (const field of kind.fields) fields.push(sourceFieldOf(configKeyOf(instance.id, field.key), field))
    for (const field of kind.policy?.fields ?? []) fields.push(sourceFieldOf(policyKeyOf(instance.id, field.key), field))
    // kind 只给了事实值、没声明同名字段时（GitHub / 飞书的部署事实就是这样），补一条只读事实行。
    const declared = declaredFactKeys(kind)
    for (const [key, text] of Object.entries(factsOf(kind, deployment))) {
      if (declared.has(key) || text === '') continue
      fields.push({ type: 'fact', key: factKeyOf(instance.id, key), label: factLabel(kind, key), settings: 'deployment' })
    }
  }
  return fields
}

/** 执行 / 判定块的当前值。 */
function blockValues(settings: SettingsConfig): SettingsValues {
  return {
    maxWorkers: settings.executor.maxWorkers,
    prepareCommand: settings.executor.prepare,
    evalMode: settings.eval.mode,
    evalTimeoutSeconds: settings.eval.timeoutSeconds,
    assessorModel: roleModelText(settings.eval.model),
    workerModel: roleModelText(settings.executor.model),
    workerBlockedCommands: settings.executor.blockedCommands.join(', '),
  }
}

/** 已装来源（配置 + 策略名单 + 部署事实）的当前值。 */
function sourceValues(runtime: Runtime): SettingsValues {
  const settings = runtime.store.settings()
  const deployment = runtime.setup.configured() ? runtime.setup.deployment : undefined
  const values: SettingsValues = {}
  for (const instance of runtime.sources.instances(settings)) {
    const kind = runtime.sources.kind(instance.id)
    if (kind === undefined) continue
    values[enabledKeyOf(instance.id)] = instance.enabled
    const config = instance.config as Record<string, unknown>
    const facts = factsOf(kind, deployment)
    const declared = declaredFactKeys(kind)
    for (const field of kind.fields) {
      // 声明过的 fact 字段：值来自部署检查结果；取不到给空串，界面画占位。
      values[configKeyOf(instance.id, field.key)] = field.type === 'fact' ? facts[field.key] ?? '' : valueOf(field, config[field.key])
    }
    const part = runtime.sources.policyPart(instance.id) as Record<string, unknown> | undefined
    for (const field of kind.policy?.fields ?? []) values[policyKeyOf(instance.id, field.key)] = valueOf(field, part?.[field.key])
    for (const [key, text] of Object.entries(facts)) if (!declared.has(key)) values[factKeyOf(instance.id, key)] = text
  }
  return values
}

/** 来源设置要去动哪一格：开关 / 配置字段 / 策略字段。 */
type SourceTarget =
  | { area: 'enabled'; id: string }
  | { area: 'config'; id: string; field: FieldSpec }
  | { area: 'policy'; id: string; field: FieldSpec }

/** 按键反查它属于哪个来源的哪一格（字段清单现读，不另存一份映射）。 */
function sourceTargetOf(runtime: Runtime, key: string): SourceTarget | undefined {
  const settings = runtime.store.settings()
  for (const instance of runtime.sources.instances(settings)) {
    const kind = runtime.sources.kind(instance.id)
    if (kind === undefined) continue
    if (key === enabledKeyOf(instance.id)) return { area: 'enabled', id: instance.id }
    for (const field of kind.fields) {
      if (field.type === 'fact') continue
      if (key === configKeyOf(instance.id, field.key)) return { area: 'config', id: instance.id, field }
    }
    for (const field of kind.policy?.fields ?? []) {
      if (key === policyKeyOf(instance.id, field.key)) return { area: 'policy', id: instance.id, field }
    }
  }
  return undefined
}

/** 保存一个设置块：新值由调用方给全块，schema / 并发 / 重启在 `Settings.save` 那一层。 */
async function saveBlock(runtime: Runtime, block: 'eval' | 'executor', change: Record<string, unknown>): Promise<string | void> {
  const current = runtime.settings.block(block)
  try {
    await runtime.settings.save(block, { ...(current.value as Record<string, unknown>), ...change }, current.revision, 'panel')
    return
  } catch (error) {
    return describe(error)
  }
}

/** 保存一个来源块（开关或一格配置）。 */
async function saveSource(runtime: Runtime, id: string, revision: number, value: { enabled: boolean; config: Record<string, unknown> }): Promise<string | void> {
  try {
    await runtime.settings.save(`source:${id}`, value, revision, 'panel')
    return
  } catch (error) {
    return describe(error)
  }
}

/** 保存一处来源设置：开关 / 配置字段 / 策略字段。 */
async function saveSourceSetting(runtime: Runtime, target: SourceTarget, value: SettingsValue): Promise<string | void> {
  const id = target.id
  const block = runtime.settings.block(`source:${id}`)
  const current = block.value as { enabled: boolean; config: Record<string, unknown> }
  if (target.area === 'enabled') return saveSource(runtime, id, block.revision, { enabled: value === true, config: current.config })
  if (target.area === 'config') {
    const parsed = parseFieldValue(target.field, value)
    return saveSource(runtime, id, block.revision, { enabled: current.enabled, config: { ...current.config, [target.field.key]: parsed } })
  }
  const policyBlock = runtime.settings.block('policy')
  const policy = policyBlock.value as SettingsConfig['policy']
  const part = (runtime.sources.policyPart(id) ?? { allowed: [] }) as Record<string, unknown>
  const parsed = parseFieldValue(target.field, value)
  try {
    await runtime.settings.save('policy', { ...policy, sources: { ...policy.sources, [id]: { ...part, [target.field.key]: parsed } } }, policyBlock.revision, 'panel')
    return
  } catch (error) {
    return describe(error)
  }
}

/** 角色模型（判定 / worker）保存：空串 = 不配；格式不对给一句提示，不静默清空。 */
async function saveRoleModel(runtime: Runtime, block: 'eval' | 'executor', value: SettingsValue): Promise<string | void> {
  const text = String(value).trim()
  const model = roleModelOf(text)
  if (text !== '' && model === null) return MODEL_FORMAT_ERROR
  return saveBlock(runtime, block, { model })
}

/**
 * 调分区自己的 save（与设置页同一个函数，返回字符串 = 被拒原因）。
 *
 * 旧入口的这份函数只服务主会话工具；新树主会话改读 `Settings.view()/block()` 并直接调
 * `Settings.save`（`app/tools/main.ts:270-286`、`app/resources.ts:70-72`），所以这里保留给
 * 「只有分区声明、没有运行期」的老式调用方，不改变校验路径。
 */
export async function saveSettingOf(section: SettingsSectionSpec, key: string, value: SettingsValue): Promise<string | void> {
  const save = section.save
  if (save === undefined) return '这个设置分区没有保存入口'
  try {
    const result = await save(key, value)
    return typeof result === 'string' ? result : undefined
  } catch (error) {
    // 契约里「抛错 = 失败原因」，调用方要的是一句话，不是一段堆栈。
    return describe(error)
  }
}

/**
 * 把分区的字段投影成「键 / 标题 / 类型 / 当前值 / 说明」。
 *
 * 与旧入口同一份形状：工具侧要「先看现场再改」，`fields()` 只有声明、当前值在 `values()`，
 * 两样必须一起给。没键的字段（info / button / fact）跳过——它们不是可保存的设置项。
 */
export function settingsViewOf(section: SettingsSectionSpec): { key: string; label: string; type: string; value: unknown; help?: string }[] {
  const values = section.values() as SettingsValues
  const fields: { key: string; label: string; type: string; value: unknown; help?: string }[] = []
  for (const field of section.fields()) {
    // info / button 没有键；fact 有键但只读，都不是可保存的设置项。
    if (!('key' in field)) continue
    if (field.type === 'fact') continue
    const type = field.type === 'number' ? 'number' : field.type === 'switch' ? 'boolean' : field.type === 'rows' ? 'list' : 'text'
    const options = field.type === 'select' ? `可选值：${field.options.map(option => option.value).join(' / ')}` : ''
    const own = field.help ?? ''
    const help = [own, options].filter(part => part !== '').join('；')
    fields.push({ key: field.key, label: field.label, type, value: values[field.key], ...(help === '' ? {} : { help }) })
  }
  return fields
}

/**
 * 建 DSC 设置分区。
 *
 * 分区对象只拿运行期（设置块、来源注册表、部署检查都在里面）：`values()` / `fields()` /
 * `save()` 每次现读，保存完立刻生效，与旧分区「现读 plugins.json」是同一条规矩。
 *
 * @param runtime - 插件入口建好的运行期（`runtime.ready` 之后登记，见 `index.ts`）
 */
export function createSettingsSection(runtime: Runtime): SettingsSectionSpec {
  return {
    id: SECTION_ID,
    title: t('section.title'),
    subtitle: t('section.subtitle'),
    // 排在「定时任务」（32）、「子代理」（29）之后：都属于「让别的智能体替你干活」那一类。
    order: 39,
    fields(): SettingsField[] {
      return [...blockFields(), ...sourceFields(runtime)]
    },
    values(): SettingsValues {
      return { ...blockValues(runtime.store.settings()), ...sourceValues(runtime) }
    },
    async save(key: string, value: SettingsValue): Promise<string | void> {
      switch (key) {
        case 'maxWorkers': {
          const number = Number(value)
          if (!Number.isFinite(number)) return t('save.maxWorkersBad')
          const clamped = Math.min(LIMITS.maxWorkers.max, Math.max(LIMITS.maxWorkers.min, Math.round(number)))
          return saveBlock(runtime, 'executor', { maxWorkers: clamped })
        }
        case 'prepareCommand': {
          const text = String(value).trim()
          if (text.length > LIMITS.prepareCommand) return t('save.prepareCommandTooLong')
          return saveBlock(runtime, 'executor', { prepare: text })
        }
        case 'workerBlockedCommands': {
          // 与旧分区同一种整理：逗号分隔、去空白、去重。
          const names = [...new Set(String(value).split(',').map(name => name.trim()).filter(name => name !== ''))]
          return saveBlock(runtime, 'executor', { blockedCommands: names })
        }
        case 'workerModel': return saveRoleModel(runtime, 'executor', value)
        case 'assessorModel': return saveRoleModel(runtime, 'eval', value)
        case 'evalMode': {
          const mode = String(value)
          if (mode !== 'off' && mode !== 'observe' && mode !== 'auto') return t('save.evalModeBad')
          return saveBlock(runtime, 'eval', { mode })
        }
        case 'evalTimeoutSeconds': {
          const number = Number(value)
          if (!Number.isFinite(number)) return t('save.evalTimeoutBad')
          const clamped = Math.min(LIMITS.evalTimeoutSeconds.max, Math.max(LIMITS.evalTimeoutSeconds.min, Math.round(number)))
          return saveBlock(runtime, 'eval', { timeoutSeconds: clamped })
        }
        default: break
      }
      const target = sourceTargetOf(runtime, key)
      if (target === undefined) return t('save.unknownKey', { key })
      return saveSourceSetting(runtime, target, value)
    },
  }
}
