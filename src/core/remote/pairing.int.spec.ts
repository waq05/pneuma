/**
 * 配对码与设备 token：正确码换 token、码有效期半小时、错码 5 次锁 1 小时、过期码、
 * 明文码与明文 token 都不落盘、码一次性、吊销（迁自 `scripts/remote-host-test.mjs` 第 2 节）。
 *
 * ## 被测的是什么
 *
 * `RemotePairing` 的三条硬规矩（pairing.ts 文件头）：
 *   - 明文码 / 明文 token 永不落盘（pending.json 只有盐与 sha256 哈希，devices.json 只有
 *     tokenHash 与设备名）；
 *   - 码一次性：配对成功当场作废；`replace:true` 发新码时旧码也当场作废（桌面「重新生成」）；
 *   - 错码限速：同一张码连错 5 次锁 1 小时，锁住期间连对的码也不放行（429）；
 *   - 时效：码半小时（CODE_TTL_MS = 1800000），锁 1 小时（CODE_LOCK_MS = 3600000）——
 *     两件事彼此独立，用注入的假钟把过期路径走通；
 *   - 吊销：按 token 吊销把设备带回来（服务端据此断开连接），按 deviceId 逐台吊销
 *     （设置页每台一个「吊销」按钮），吊销不存在的 id 给 null 不报错。
 *
 * ## 隔离
 *
 * 每个场景一个独立数据目录（`join(home, 'pairing*')`），真实 `~/.dsc` 一个字节不写；
 * pairing 模块在 `tempHome()` 换好 HOME 之后才动态加载（时序要求见 prefs.int.spec 文件头）。
 *
 * @module dsc/core/remote/pairing.int.spec
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../../tests/harness.js'

/** 临时主目录：必须在任何内核模块被加载之前换好（理由见 prefs.int.spec 文件头）。 */
const home = tempHome('dsc-remote-pairing-')

delete process.env['DSC_HOME']

afterAll(() => {
  home.restore()
})

type PairingModule = typeof import('@pneuma/runtime/core/remote/pairing.js')
/** 配对结果：成功给 token，失败给 HTTP 状态码与一句话（判别联合，`ok === true` 收窄）。 */
type PairOutcome = import('@pneuma/runtime/core/remote/pairing.js').PairOutcome
let mod: PairingModule

beforeAll(async () => {
  mod = await import('@pneuma/runtime/core/remote/pairing.js')
})

/** 探针的主场景：一张码从签发到配对到吊销的完整生命周期（用例之间按序推进）。 */
const pairDir = join(home.home, 'pairing')
let pairing: InstanceType<PairingModule['RemotePairing']>
let devicePairing: InstanceType<PairingModule['RemotePairing']>
let issued: { code: string; expiresAt: number } | null
let replaced: { code: string; expiresAt: number } | null
let relock: { code: string; expiresAt: number } | null
let paired: PairOutcome

beforeAll(async () => {
  mod = await import('@pneuma/runtime/core/remote/pairing.js')
  pairing = new mod.RemotePairing({ dir: pairDir })
  // 逐台吊销场景用独立目录，与主场景互不踩（探针同款块级 scope）。
  devicePairing = new mod.RemotePairing({ dir: join(home.home, 'pairing-devices') })
})

describe('配对码与设备 token', () => {
  // 标题里的 8 是收集期写死的渲染值（CODE_LENGTH），断言体仍用常量比对。
  test('发出来的码是 8 位', () => {
    issued = pairing.issueCode()
    expect(issued).not.toBeNull()
    expect(issued?.code.length).toBe(mod.CODE_LENGTH)
  })

  test('码里只有无歧义字符（没有 O/0/I/1/l）', () => {
    expect(issued).not.toBeNull()
    for (const char of issued?.code ?? '') {
      expect(mod.CODE_ALPHABET.includes(char), `字符 ${char} 不在字母表里`).toBe(true)
    }
  })

  test('已经有一张没用的码时不再签发第二张', () => {
    expect(pairing.issueCode()).toBeNull()
  })

  // replace：桌面「连接手机」弹窗与它的「重新生成」走这条。旧码的明文只在上一张弹窗上、
  // 宿主重画不出来，所以界面上要一直看得见一张有效码就只能换新的，且旧码必须当场作废。
  test('replace:true 时已有活码也照发新码', () => {
    replaced = pairing.issueCode({ replace: true })
    expect(replaced).not.toBeNull()
    expect(replaced?.code).not.toBe(issued?.code)
  })

  test('replace 之后旧码当场作废（401）', () => {
    const outcome = pairing.verifyCode(issued?.code ?? '', '我的手机')
    expect(outcome.ok).toBe(false)
  })

  test('pending.json 里没有明文码（只有盐与哈希）', () => {
    const pendingText = readFileSync(join(pairDir, 'pending.json'), 'utf8')
    expect(pendingText.includes(issued?.code ?? '')).toBe(false)
  })

  test('pending.json 里存的是 sha256（64 位十六进制）', () => {
    const pendingText = readFileSync(join(pairDir, 'pending.json'), 'utf8')
    expect(/"hash": "[0-9a-f]{64}"/.test(pendingText)).toBe(true)
  })

  test('错码返回 401', () => {
    const wrong = pairing.verifyCode('ZZZZZZZZ', '我的手机')
    expect(wrong.ok).toBe(false)
    if (wrong.ok === false) expect(wrong.status).toBe(401)
  })

  test('配对失败的文案里没有「1 小时有效」这种码时效口径（码已改半小时）', () => {
    const wrong = pairing.verifyCode('ZZZZZZZZ', '我的手机')
    expect(wrong.ok).toBe(false)
    if (wrong.ok === false) expect(wrong.error.includes('1 小时')).toBe(false)
  })

  test('连错 5 次之后锁 1 小时：连对的码也进不来（429）', () => {
    for (let i = 1; i < mod.MAX_CODE_ATTEMPTS; i += 1) pairing.verifyCode('ZZZZZZZZ', '我的手机')
    const locked = pairing.verifyCode(issued?.code ?? '', '我的手机')
    expect(locked.ok).toBe(false)
    if (locked.ok === false) expect(locked.status).toBe(429)
  })

  test('锁码的 429 文案仍写「已锁 1 小时」（锁的时长没变）', () => {
    const locked = pairing.verifyCode(issued?.code ?? '', '我的手机')
    expect(locked.ok).toBe(false)
    if (locked.ok === false) expect(locked.error.includes('已锁 1 小时')).toBe(true)
  })

  test('被锁的码不算「没用过」：还能再发一张新的', () => {
    relock = pairing.issueCode()
    expect(relock).not.toBeNull()
    expect(relock?.code).not.toBe(issued?.code)
  })

  test('对的码换到设备 token', () => {
    paired = pairing.verifyCode(relock?.code ?? '', '我的手机')
    expect(paired.ok).toBe(true)
    if (paired.ok === true) expect(paired.token.length).toBeGreaterThanOrEqual(32)
  })

  test('同一个码不能再用第二次（一次性）', () => {
    expect(pairing.verifyCode(relock?.code ?? '', '我的手机').ok).toBe(false)
  })

  test('devices.json 里没有明文 token', () => {
    const devicesText = readFileSync(join(pairDir, 'devices.json'), 'utf8')
    expect(paired.ok).toBe(true)
    expect(devicesText.includes(paired.ok === true ? paired.token : '')).toBe(false)
  })

  test('devices.json 里有 token 的 sha256 与设备名', () => {
    const devicesText = readFileSync(join(pairDir, 'devices.json'), 'utf8')
    expect(/"tokenHash": "[0-9a-f]{64}"/.test(devicesText)).toBe(true)
    expect(devicesText.includes('我的手机')).toBe(true)
  })

  test('token 验得过，并带回设备名', () => {
    const seen = paired.ok === true ? pairing.verifyToken(paired.token) : null
    expect(seen).not.toBeNull()
    expect(seen?.name).toBe('我的手机')
  })

  test('认不出的 token 给 null', () => {
    expect(pairing.verifyToken('不存在的 token')).toBeNull()
  })

  test('吊销时把被吊销的设备带回来（服务端据此断开它的连接）', () => {
    const revoked = paired.ok === true ? pairing.revoke(paired.token) : null
    expect(revoked?.deviceId).toBe(paired.ok === true ? paired.deviceId : '')
  })

  test('吊销之后就认不出了', () => {
    expect(pairing.verifyToken(paired.ok === true ? paired.token : '')).toBeNull()
  })

  test('吊销一个不认识的 token 给 null', () => {
    expect(pairing.revoke('不存在的 token')).toBeNull()
  })

  // 逐台吊销：设置页上每台设备一个「吊销」按钮走这条（只有 deviceId，没有 token）。
  // 四条断言依赖同一个实例（beforeAll 构造）与同一对设备，按探针块内的顺序拆成四个用例。
  let phoneA: PairOutcome
  let phoneB: PairOutcome

  test('devices() 给出 deviceId / name / createdAt / lastSeenAt（设备清单每台两行要用它）', () => {
    const codeA = devicePairing.issueCode()
    phoneA = devicePairing.verifyCode(codeA?.code ?? '', '手机 A')
    const codeB = devicePairing.issueCode()
    phoneB = devicePairing.verifyCode(codeB?.code ?? '', '手机 B')
    expect(phoneA.ok).toBe(true)
    expect(phoneB.ok).toBe(true)
    const listed = devicePairing.devices()
    expect(listed.length).toBe(2)
    for (const device of listed) {
      expect(typeof device.deviceId).toBe('string')
      expect(device.deviceId).not.toBe('')
      expect(typeof device.name).toBe('string')
      expect(typeof device.createdAt).toBe('number')
      expect(typeof device.lastSeenAt).toBe('number')
    }
  })

  test('单独吊销一台：返回被吊销那台，清单少一台，另一台照旧', () => {
    const gone = devicePairing.revokeDevice(phoneA.ok === true ? phoneA.deviceId : '')
    expect(gone?.deviceId).toBe(phoneA.ok === true ? phoneA.deviceId : '')
    expect(devicePairing.devices().length).toBe(1)
    expect(devicePairing.devices()[0]?.deviceId).toBe(phoneB.ok === true ? phoneB.deviceId : '')
  })

  test('被吊销那台的 token 认不出，另一台照常能用', () => {
    expect(devicePairing.verifyToken(phoneA.ok === true ? phoneA.token : '')).toBeNull()
    expect(devicePairing.verifyToken(phoneB.ok === true ? phoneB.token : '')?.deviceId).toBe(
      phoneB.ok === true ? phoneB.deviceId : '',
    )
  })

  test('吊销一个不存在的 deviceId 给 null（重复吊销不报错）', () => {
    expect(devicePairing.revokeDevice('没有这台设备')).toBeNull()
    expect(devicePairing.revokeDevice('')).toBeNull()
  })

  // 过期：注入假钟，码有效半小时
  test('码的有效期是半小时（CODE_TTL_MS = 1800000）', () => {
    let clock = 1_000_000
    const timeMachine = new mod.RemotePairing({ dir: join(home.home, 'pairing-expire'), now: () => clock })
    const expiring = timeMachine.issueCode()
    expect(mod.CODE_TTL_MS).toBe(1_800_000)
    expect(expiring).not.toBeNull()
    expect(expiring !== null ? expiring.expiresAt - clock : 0).toBe(mod.CODE_TTL_MS)
    clock += mod.CODE_TTL_MS + 1
    const expired = timeMachine.verifyCode(expiring?.code ?? '', '旧手机')
    expect(expired.ok).toBe(false)
    if (expired.ok === false) expect(expired.status).toBe(401)
  })

  test('锁码时长没跟着码改：连错超限照旧锁 1 小时（CODE_LOCK_MS = 3600000）', () => {
    expect(mod.CODE_LOCK_MS).toBe(3_600_000)
  })
})
