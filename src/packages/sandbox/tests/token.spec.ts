/**
 * 受限令牌构造（`sandbox/win/token.ts`）的纯逻辑测试。
 *
 * ## 为什么用假 BoundWin32 而不是真 koffi
 *
 * `token.ts` 的所有判断都在「调 API 前后」：SID 串怎么编码、GetTokenInformation
 * 的容量探长怎么读、SID_AND_ATTRIBUTES 数组怎么打包、EXPLICIT_ACCESS 的偏移与
 * 指针怎么写、失败时抛哪个 API。这些全部可以用一个记录参数、可写回出参槽的
 * 假绑定对象验证，不必触碰真令牌（碰了会把测试进程本身限制住）。
 *
 * 假绑定完全按 `ffi.ts` 的接口形状造：
 *   - `koffi.alloc('uintptr_t' | 'uint32', 1)` 返回带 `value` 的出参槽，`decode` 读回；
 *   - `koffi.alloc('uint8', n)` 返回真 Buffer，`decode(ptr, 'uint8', n)` 读它；
 *   - `koffi.address(buffer)` 返回稳定且互不相同的数值地址，并按地址登记内存，
 *     这样 token.ts 里「把 Buffer 地址塞进手工结构体，再按地址取回」的路径是通的。
 *
 * 不读真实 `~/.dsc`、不调真实 Win32 API、不写盘。
 *
 * @module dsc/packages/sandbox/tests/token.spec
 */
import { describe, expect, test, vi } from 'vitest'
import {
  CREATE_RESTRICTED_FLAGS,
  EA_OFFSETS,
  FILE_ALL_ACCESS,
  GRANT_ACCESS,
  PROCESS_QUERY_INFORMATION,
  SE_GROUP_INTEGRITY,
  SID_AND_ATTRIBUTES_SIZE,
  SID_MAX_BYTES,
  TOKEN_ACCESS,
  TRUSTEE_IS_SID,
  TRUSTEE_IS_UNKNOWN,
  TokenDefaultDacl,
  TokenGroups,
  TokenIntegrityLevel,
  WinLowLabelSid,
  WinWorldSid,
} from '../win/abi.js'
import { Win32Error } from '../win/ffi.js'
import type { BoundWin32 } from '../win/ffi.js'
import {
  buildRestrictedToken,
  packExplicitAccessSid,
  sidStringToBuffer,
  wellKnownSidBuffer,
} from '../win/token.js'

/** 出参槽的最小形状（token.ts 只读写 `value`）。 */
interface Slot {
  kind: 'slot'
  type: string
  value: number
}

/** 把 SID 串编码成字节（Revision/Authority/SubAuthority，与 Win32 布局一致）。 */
function encodeSid(sid: string): Buffer {
  const parts = sid.split('-')
  const revision = Number(parts[1] ?? 1)
  const authority = Number(parts[2] ?? 5)
  const subAuthorities = parts.slice(3).map((part) => Number(part))
  const buffer = Buffer.alloc(8 + subAuthorities.length * 4)
  buffer[0] = revision
  buffer[1] = subAuthorities.length
  buffer.writeUIntLE(authority, 2, 6)
  subAuthorities.forEach((value, index) => {
    buffer.writeUInt32LE(value >>> 0, 8 + index * 4)
  })
  return buffer
}

/**
 * 造一份可按需配置的假绑定。
 *
 * `knobs` 在调用时读取（不是构造时快照），测试里直接改字段即可制造失败分支。
 */
function makeWin32() {
  const addresses = new WeakMap<object, number>()
  const heap = new Map<number, Buffer>()
  let nextAddress = 0x10_0000
  let lastError = 0
  let pendingSid = ''

  const knobs = {
    failConvert: false,
    failWellKnown: false,
    failOpenProcess: false,
    failCreate: false,
    noLogonSid: false,
    /** 非 0 时让默认 DACL 的 PACL 指针指向这块假内存（用于走「已有 ACL」分支）。 */
    daclAclPointer: 0,
    processHandle: 0x2000,
    tokenHandle: 0x3000,
    accountToken: 0x9000,
    restrictedHandle: 0x4000,
    newAcl: 0x5000,
    rawSidPointer: 0x7000,
  }

  const allocSlot = (type: string): Slot => ({ kind: 'slot', type, value: 0 })

  const koffi = {
    load: vi.fn(),
    alloc: vi.fn((type: string, count: number) => {
      if (type === 'uintptr_t' || type === 'uint32') return allocSlot(type)
      return Buffer.alloc(count * (type === 'uint16' ? 2 : 1))
    }),
    decode: vi.fn((value: unknown, type: string, count?: number) => {
      if (type === 'uintptr_t' || type === 'uint32') return (value as Slot).value
      if (type === 'uint8') {
        const wanted = count ?? 0
        if (typeof value === 'number') {
          const memory = heap.get(value)
          return memory === undefined ? Buffer.alloc(wanted) : memory.subarray(0, wanted)
        }
        return Buffer.isBuffer(value) ? value.subarray(0, wanted) : Buffer.alloc(wanted)
      }
      return 0
    }),
    address: vi.fn((value: unknown) => {
      if (typeof value === 'number') return BigInt(value)
      const key = value as object
      let address = addresses.get(key)
      if (address === undefined) {
        address = nextAddress
        nextAddress += 0x1000
        addresses.set(key, address)
        heap.set(address, value as Buffer)
      }
      return BigInt(address)
    }),
    errno: vi.fn(() => 0),
  }

  const convertStringSidToSidW = vi.fn((name: Buffer, out: Slot) => {
    pendingSid = name.toString('utf16le').replace(/\0[\s\S]*$/, '')
    if (knobs.failConvert) {
      lastError = 1332
      return 0
    }
    out.value = knobs.rawSidPointer
    return 1
  })
  const getLengthSid = vi.fn(() => encodeSid(pendingSid).length)
  const copySid = vi.fn((length: number, destination: Buffer) => {
    encodeSid(pendingSid).copy(destination, 0, 0, length)
    return 1
  })
  const localFree = vi.fn(() => 0)

  const createWellKnownSid = vi.fn((kind: number, _domain: number, buffer: Buffer, cbSid: Buffer) => {
    if (knobs.failWellKnown) {
      lastError = 87
      return 0
    }
    const encoded = kind === WinWorldSid ? encodeSid('S-1-1-0') : encodeSid('S-1-16-4096')
    encoded.copy(buffer, 0)
    cbSid.writeUInt32LE(encoded.length, 0)
    return 1
  })

  const getTokenInformation = vi.fn(
    (
      _token: number,
      infoClass: number,
      buffer: Buffer | null,
      size: number,
      needed: Slot,
    ) => {
      if (infoClass === TokenGroups) {
        if (buffer === null || size === 0) {
          needed.value = 40
          return 0
        }
        const base = Number(koffi.address(buffer))
        buffer.fill(0)
        buffer.writeUInt32LE(1, 0)
        // 唯一的组条目：SID 指针指向本块偏移 24，属性带 SE_GROUP_LOGON_ID。
        buffer.writeBigUInt64LE(BigInt(base + 24), 8)
        buffer.writeUInt32LE(knobs.noLogonSid ? 0 : 0xc000_0007, 16)
        encodeSid('S-1-5-5-1').copy(buffer, 24)
        return 1
      }
      if (infoClass === TokenDefaultDacl) {
        if (buffer === null || size === 0) {
          needed.value = 8
          return 0
        }
        buffer.fill(0)
        buffer.writeBigUInt64LE(BigInt(knobs.daclAclPointer), 0)
        return 1
      }
      return 0
    },
  )

  const createRestrictedToken = vi.fn(
    (
      _token: number,
      _flags: number,
      _disableCount: number,
      _disableSids: number,
      _deleteCount: number,
      _deletePrivileges: number,
      _restrictingCount: number,
      _restrictingSids: Buffer,
      out: Slot,
    ) => {
      if (knobs.failCreate) {
        lastError = 5
        return 0
      }
      out.value = knobs.restrictedHandle
      return 1
    },
  )

  const setTokenInformation = vi.fn(
    (_token: number, _infoClass: number, _payload: Buffer, _length: number) => 1,
  )

  const setEntriesInAclW = vi.fn((_count: number, _entry: Buffer, _oldAcl: number, out: Slot) => {
    out.value = knobs.newAcl
    return 0
  })

  const openProcess = vi.fn(() => (knobs.failOpenProcess ? 0 : knobs.processHandle))

  const openProcessToken = vi.fn((_process: number, _access: number, out: Slot) => {
    out.value = knobs.tokenHandle
    return 1
  })

  const closeHandle = vi.fn((_handle: number) => 1)

  const bound = {
    koffi,
    getLastLastError: () => lastError,
    formatMessageW: () => 0,
    convertStringSidToSidW,
    getLengthSid,
    copySid,
    localFree,
    createWellKnownSid,
    getTokenInformation,
    createRestrictedToken,
    setTokenInformation,
    setEntriesInAclW,
    openProcess,
    openProcessToken,
    closeHandle,
  } as unknown as BoundWin32

  return {
    bound,
    knobs,
    heap,
    mocks: {
      convertStringSidToSidW,
      getLengthSid,
      copySid,
      localFree,
      createWellKnownSid,
      getTokenInformation,
      createRestrictedToken,
      setTokenInformation,
      setEntriesInAclW,
      openProcess,
      openProcessToken,
      closeHandle,
    },
  }
}

/** 抓取同步抛出的错误（用来断言 Win32Error 的 api 与错误码）。 */
function catchError(ripe: () => unknown): unknown {
  try {
    ripe()
  } catch (error) {
    return error
  }
  throw new Error('预期抛错，但没有抛')
}

describe('sidStringToBuffer', () => {
  test('SID 串按 UTF-16LE 且 NUL 收尾传入，返回 GetLengthSid 长度字节并释放系统 SID', () => {
    const world = makeWin32()
    const sid = sidStringToBuffer(world.bound, 'S-1-5-7')

    const name = world.mocks.convertStringSidToSidW.mock.calls[0]![0]
    expect(name).toHaveLength('S-1-5-7'.length * 2 + 2)
    expect(name.toString('utf16le')).toBe('S-1-5-7\0')

    expect(sid.equals(encodeSid('S-1-5-7'))).toBe(true)
    expect(world.mocks.copySid).toHaveBeenCalledWith(12, expect.any(Buffer), 0x7000)
    expect(world.mocks.localFree).toHaveBeenCalledWith(0x7000)
  })

  test('ConvertStringSidToSidW 返回 0 → 抛 Win32Error（api 与错误码来自 GetLastError）', () => {
    const world = makeWin32()
    world.knobs.failConvert = true

    const error = catchError(() => sidStringToBuffer(world.bound, 'S-1-5-7'))
    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'ConvertStringSidToSidW', win32Code: 1332 })
    expect(world.mocks.localFree).not.toHaveBeenCalled()
  })
})

describe('wellKnownSidBuffer', () => {
  test('cbSid 以 68 字节容量传入，回写实际长度；只返回有效的那段', () => {
    const world = makeWin32()
    const everyone = wellKnownSidBuffer(world.bound, WinWorldSid)

    const call = world.mocks.createWellKnownSid.mock.calls[0]!
    expect(call[0]).toBe(WinWorldSid)
    expect(call[1]).toBe(0)
    expect(call[2]).toHaveLength(SID_MAX_BYTES)
    const cbSid = call[3] as Buffer
    expect(cbSid.readUInt32LE(0)).toBe(12)
    expect(everyone).toHaveLength(12)
    expect(everyone.equals(encodeSid('S-1-1-0'))).toBe(true)

    expect(wellKnownSidBuffer(world.bound, WinLowLabelSid).equals(encodeSid('S-1-16-4096'))).toBe(true)
  })

  test('CreateWellKnownSid 返回 0 → 抛 Win32Error', () => {
    const world = makeWin32()
    world.knobs.failWellKnown = true

    const error = catchError(() => wellKnownSidBuffer(world.bound, WinWorldSid))
    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'CreateWellKnownSid', win32Code: 87 })
  })
})

describe('packExplicitAccessSid', () => {
  test('48 字节布局按 EA_OFFSETS 填：掩码/模式/继承/TrusteeForm/TrusteeType/指针', () => {
    const world = makeWin32()
    const sid = encodeSid('S-1-5-7')
    const entry = packExplicitAccessSid(world.bound, {
      mask: FILE_ALL_ACCESS,
      mode: GRANT_ACCESS,
      inheritance: 0,
      sid,
    })

    expect(entry).toHaveLength(48)
    expect(entry.readUInt32LE(EA_OFFSETS.grfAccessPermissions)).toBe(FILE_ALL_ACCESS)
    expect(entry.readUInt32LE(EA_OFFSETS.grfAccessMode)).toBe(GRANT_ACCESS)
    expect(entry.readUInt32LE(EA_OFFSETS.grfInheritance)).toBe(0)
    expect(entry.readUInt32LE(EA_OFFSETS.pMultipleTrustee)).toBe(0)
    expect(entry.readUInt32LE(EA_OFFSETS.MultipleTrusteeOperation)).toBe(0)
    expect(entry.readUInt32LE(EA_OFFSETS.TrusteeForm)).toBe(TRUSTEE_IS_SID)
    expect(entry.readUInt32LE(EA_OFFSETS.TrusteeType)).toBe(TRUSTEE_IS_UNKNOWN)

    // ptstrName 是 SID 的数值地址，不是字节本身。
    expect(Number(entry.readBigUInt64LE(EA_OFFSETS.ptstrName))).toBe(
      Number(world.bound.koffi.address(sid)),
    )
  })

  test('掩码按无符号 32 位写（-1 → 0xffffffff），不会因 int32 截断抛 RangeError', () => {
    const world = makeWin32()
    const entry = packExplicitAccessSid(world.bound, {
      mask: -1,
      mode: GRANT_ACCESS,
      inheritance: 0,
      sid: encodeSid('S-1-5-7'),
    })
    expect(entry.readUInt32LE(EA_OFFSETS.grfAccessPermissions)).toBe(0xffff_ffff)
  })
})

describe('buildRestrictedToken — workspace-write 默认分支', () => {
  test('限制列表 = 登录 SID + Everyone + 两个能力 SID；完整性降 Low；默认 DACL 授第一个能力 SID', () => {
    const world = makeWin32()
    const { mocks, knobs, heap } = world

    const token = buildRestrictedToken(world.bound, {
      mode: 'workspace-write',
      rootSids: ['S-1-5-7', 'S-1-5-8'],
    })

    // 1) 基底令牌来自当前进程（OpenProcess + OpenProcessToken）。
    expect(mocks.openProcess).toHaveBeenCalledWith(PROCESS_QUERY_INFORMATION, 0, process.pid)
    expect(mocks.openProcessToken).toHaveBeenCalledWith(knobs.processHandle, TOKEN_ACCESS, expect.anything())

    // 2) CreateRestrictedToken：禁用/删权限两组为空，限制列表 4 条。
    const create = mocks.createRestrictedToken.mock.calls[0]!
    expect(create[0]).toBe(knobs.tokenHandle)
    expect(create[1]).toBe(CREATE_RESTRICTED_FLAGS)
    expect(create[2]).toBe(0)
    expect(create[3]).toBe(0)
    expect(create[4]).toBe(0)
    expect(create[5]).toBe(0)
    expect(create[6]).toBe(4)

    const packed = create[7] as Buffer
    expect(packed).toHaveLength(4 * SID_AND_ATTRIBUTES_SIZE)
    const pointers: number[] = []
    for (let index = 0; index < 4; index += 1) {
      const at = index * SID_AND_ATTRIBUTES_SIZE
      pointers.push(Number(packed.readBigUInt64LE(at)))
      expect(packed.readUInt32LE(at + 8)).toBe(0)
    }
    expect(pointers.every((pointer) => pointer > 0)).toBe(true)
    expect(new Set(pointers).size).toBe(4)

    // 第三条/第四条（能力 SID）分别是 S-1-5-7、S-1-5-8。
    expect(heap.get(pointers[2]!)!.equals(encodeSid('S-1-5-7'))).toBe(true)
    expect(heap.get(pointers[3]!)!.equals(encodeSid('S-1-5-8'))).toBe(true)

    // 3) 完整性标签：{Sid 指针, SE_GROUP_INTEGRITY}，载荷长度 8 + SID 长度。
    const integrity = mocks.setTokenInformation.mock.calls.find((call) => call[1] === TokenIntegrityLevel)!
    expect(integrity[0]).toBe(knobs.restrictedHandle)
    const label = integrity[2] as Buffer
    expect(integrity[3]).toBe(8 + encodeSid('S-1-16-4096').length)
    expect(label.readUInt32LE(8)).toBe(SE_GROUP_INTEGRITY)
    expect(heap.get(Number(label.readBigUInt64LE(0)))!.equals(encodeSid('S-1-16-4096'))).toBe(true)

    // 4) 默认 DACL：GRANT_ACCESS + FILE_ALL_ACCESS，trustee 是第一个能力 SID（不是 Everyone）。
    const acl = mocks.setEntriesInAclW.mock.calls[0]!
    expect(acl[0]).toBe(1)
    expect(acl[2]).toBe(0)
    const ace = acl[1] as Buffer
    expect(ace.readUInt32LE(EA_OFFSETS.grfAccessPermissions)).toBe(FILE_ALL_ACCESS)
    expect(ace.readUInt32LE(EA_OFFSETS.grfAccessMode)).toBe(GRANT_ACCESS)
    expect(heap.get(Number(ace.readBigUInt64LE(EA_OFFSETS.ptstrName)))!.equals(encodeSid('S-1-5-7'))).toBe(
      true,
    )

    const daclSet = mocks.setTokenInformation.mock.calls.find((call) => call[1] === TokenDefaultDacl)!
    expect(daclSet[0]).toBe(knobs.restrictedHandle)
    expect((daclSet[2] as Buffer).readBigUInt64LE(0)).toBe(BigInt(knobs.newAcl))

    expect(token.handle).toBe(knobs.restrictedHandle)
  })

  test('dispose 依次关闭受限令牌、基底令牌与进程句柄', () => {
    const world = makeWin32()
    const token = buildRestrictedToken(world.bound, { mode: 'workspace-write', rootSids: [] })
    token.dispose()

    const closed = world.mocks.closeHandle.mock.calls.map((call) => call[0])
    expect(closed).toStrictEqual([world.knobs.restrictedHandle, world.knobs.tokenHandle, world.knobs.processHandle])
  })

  test('OpenProcess 失败 → 抛 Win32Error（fail-closed，不回落未受限 spawn）', () => {
    const world = makeWin32()
    world.knobs.failOpenProcess = true

    const error = catchError(() => buildRestrictedToken(world.bound, { mode: 'workspace-write', rootSids: [] }))
    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'OpenProcess' })
    expect(world.mocks.createRestrictedToken).not.toHaveBeenCalled()
  })

  test('CreateRestrictedToken 失败 → 抛 Win32Error', () => {
    const world = makeWin32()
    world.knobs.failCreate = true

    const error = catchError(() => buildRestrictedToken(world.bound, { mode: 'workspace-write', rootSids: [] }))
    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'CreateRestrictedToken', win32Code: 5 })
  })
})

describe('buildRestrictedToken — read-only / 账号令牌分支', () => {
  test('accountToken 分支不打开当前进程令牌；限制列表只有登录 SID + Everyone；DACL 退回 Everyone', () => {
    const world = makeWin32()
    const { mocks, knobs, heap } = world

    const token = buildRestrictedToken(world.bound, {
      mode: 'read-only',
      rootSids: ['S-1-5-7'],
      accountToken: knobs.accountToken,
    })

    expect(mocks.openProcess).not.toHaveBeenCalled()
    expect(mocks.openProcessToken).not.toHaveBeenCalled()

    const create = mocks.createRestrictedToken.mock.calls[0]!
    expect(create[0]).toBe(knobs.accountToken)
    expect(create[6]).toBe(2)
    const packed = create[7] as Buffer
    expect(packed).toHaveLength(2 * SID_AND_ATTRIBUTES_SIZE)

    const ace = mocks.setEntriesInAclW.mock.calls[0]![1] as Buffer
    expect(heap.get(Number(ace.readBigUInt64LE(EA_OFFSETS.ptstrName)))!.equals(encodeSid('S-1-1-0'))).toBe(
      true,
    )

    expect(token.handle).toBe(knobs.restrictedHandle)
    token.dispose()
    const closed = mocks.closeHandle.mock.calls.map((call) => call[0])
    expect(closed).toStrictEqual([knobs.restrictedHandle, knobs.accountToken])
    expect(closed).not.toContain(knobs.processHandle)
  })

  test('令牌组里没有登录会话 SID → 明确抛错，不能静默少保活组', () => {
    const world = makeWin32()
    world.knobs.noLogonSid = true

    const error = catchError(() => buildRestrictedToken(world.bound, { mode: 'read-only', rootSids: [] }))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/找不到登录会话 SID/)
    expect(world.mocks.createRestrictedToken).not.toHaveBeenCalled()
  })

  test('已有默认 DACL 但 ACL 头尺寸非法 → 抛错（不拿坏指针继续 SetEntriesInAclW）', () => {
    const world = makeWin32()
    // AclSize（偏移 2 的 uint16）= 0 < 8：ACL 头都不完整。
    world.knobs.daclAclPointer = 0x90_0000
    world.heap.set(0x90_0000, Buffer.from([2, 0, 0, 0, 0, 0, 0, 0]))

    const error = catchError(() => buildRestrictedToken(world.bound, { mode: 'read-only', rootSids: [] }))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/ACL 头尺寸不合法/)
    expect(world.mocks.setEntriesInAclW).not.toHaveBeenCalled()
  })
})
