/**
 * `@deepseek-ai/dsh-credentials` 的 Pneuma 实现（解析钩子按需顶替）。
 *
 * 这个包在插件眼里只是**名字的语法**：`credentialRef('DEEPSEEK_API_KEY')` 把
 * 一个环变量名包成带类型的引用，`credentialKey('provider','openai')` 拼出
 * `provider/openai` 这样的地址。真正的值住在宿主的凭据库里，插件拿不到也不需要。
 *
 * 所以这里只复刻语法与校验，不引入 dsh 的凭据服务（那套要 `ctx.credentials`，
 * Pneuma 的 key 走 `~/.dsc/credentials.yaml`，是另一条路）。
 *
 * @module dsc/core/dsh-compat/shims/credentials
 */

/** 凭据引用的合法形状：POSIX 环变量名。 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 凭据地址每一段的合法形状（小写字母开头的短横线名）。 */
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/

/** 凭据引用：一个环变量名的类型化写法（运行时就是字符串）。 */
export type CredentialRef = string

/** 凭据地址：`scope/id` 的类型化写法（运行时就是字符串）。 */
export type CredentialKey = string

/**
 * 把一个环变量名包成凭据引用。
 * @param value - 候选引用名
 * @returns 同一个字符串（类型上更窄）
 * @throws 形状不合语法时抛 TypeError
 */
export function credentialRef(value: string): CredentialRef {
  if (!isCredentialRefName(value)) {
    throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`)
  }
  return value
}

/**
 * 判断一个字符串能不能当凭据引用。
 * @param value - 候选名
 * @returns 合规给 true
 */
export function isCredentialRefName(value: string): boolean {
  return REF_PATTERN.test(value)
}

/**
 * 判断一个字符串能不能当凭据地址的一段。
 * @param value - 候选段
 * @returns 合规给 true
 */
export function isCredentialKeySegment(value: string): boolean {
  return KEY_SEGMENT_PATTERN.test(value)
}

/**
 * 拼一个凭据地址。
 * @param scope - 前半段（提供方）
 * @param id - 后半段（这条凭据的名字）
 * @returns `scope/id`
 * @throws 任一段不合语法时抛 TypeError
 */
export function credentialKey(scope: string, id: string): CredentialKey {
  if (!isCredentialKeySegment(scope) || !isCredentialKeySegment(id)) {
    throw new TypeError(`credential key "${scope}/${id}" must match ${String(KEY_SEGMENT_PATTERN)} on both sides`)
  }
  return `${scope}/${id}`
}

/**
 * 拆一个凭据地址。
 * @param value - `scope/id`
 * @returns 拆出来的两段
 * @throws 形状不对时抛 TypeError
 */
export function parseCredentialKey(value: string): CredentialKey {
  const [scope, id, ...rest] = value.split('/')
  if (scope === undefined || id === undefined || rest.length > 0) {
    throw new TypeError(`credential key "${value}" must be scope/id`)
  }
  return credentialKey(scope, id)
}

/**
 * 取凭据地址的前半段。
 * @param key - 凭据地址
 * @returns 提供方名
 */
export function credentialKeyScope(key: CredentialKey): string {
  return parseCredentialKey(key).split('/')[0] ?? ''
}

/**
 * 取凭据地址的后半段。
 * @param key - 凭据地址
 * @returns 凭据名
 */
export function credentialKeyId(key: CredentialKey): string {
  return parseCredentialKey(key).split('/')[1] ?? ''
}
