/**
 * 可写根 ACL 授权/回收（`sandbox/win/acl.ts`）的纯逻辑测试。
 *
 * ## 为什么整份用假 FFI
 *
 * `acl.ts` 的每一条判断都发生在「调 Win32 前后」：ACL 字节怎么解、三件套是否精确命中、
 * 失败时抛哪个 API、锁文件叫什么、`finally` 里 LocalFree 谁。这些都可以用一个记录参数、
 * 可写回出参槽、按地址登记内存的假 `BoundWin32` 验证，不必真的改本机目录的 ACL
 * （真改会把测试进程自己能写的地方也锁掉）。
 *
 * 假绑定严格照 `ffi.ts` 的接口形状：
 *   - `koffi.alloc('uintptr_t'|'uint32', 1)` → 带 `value` 的出参槽，`decode` 读回；
 *   - `koffi.alloc('uint8', n)` / `alloc('uint16', n)` → 真 Buffer；
 *   - `koffi.address(buffer)` → 稳定且互不相同的地址，并按地址登记内存，
 *     于是「把自己的 SID Buffer 地址塞进 EXPLICIT_ACCESS，再按地址取回」是通的；
 *   - `koffi.decode(数值地址, 'uint8', n)` → 读登记过的系统内存（ACL 字节）。
 *
 * 不读真实 `~/.dsc`、不调真实 Win32 API、不写盘。
 *
 * @module dsc/packages/sandbox/win/acl.spec
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  ACCESS_ALLOWED_ACE_TYPE,
  ACCESS_DENIED_ACE_TYPE,
  ACL_FIRST_ACE_OFFSET,
  ACL_REVISION,
  CONTAINER_INHERIT_ACE,
  DACL_SECURITY_INFORMATION,
  DENY_ACCESS,
  EXPLICIT_ACCESS_SIZE,
  FILE_DELETE_CHILD,
  FILE_GENERIC_EXECUTE,
  FILE_GENERIC_READ,
  GENERIC_READ,
  GENERIC_WRITE,
  GRANT_ACCESS,
  GRANT_MASK,
  LABEL_SECURITY_INFORMATION,
  LOCKFILE_EXCLUSIVE_LOCK,
  OBJECT_INHERIT_ACE,
  OPEN_ALWAYS,
  OVERLAPPED_SIZE,
  REVOKE_ACCESS,
  SE_FILE_OBJECT,
  SYSTEM_MANDATORY_LABEL_ACE_TYPE,
  SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
  WinLowLabelSid,
  WinWorldSid,
} from './abi.js'
import { Win32Error } from './ffi.js'
import type { BoundWin32 } from './ffi.js'
import { grantAccountAccess, grantWrite, revokeWrite, walkAces } from './acl.js'

const CAP_SID = 'S-1-5-7'
const EVERYONE = 'S-1-1-0'
const LOW_LABEL = 'S-1-16-4096'
const LOCK_DIR = 'C:\\Users\\me\\.dsc\\sandbox\\locks'
const TARGET = 'C:\\work\\repo'

/** 出参槽：acl.ts 只读写 `value`。 */
interface Slot {
  readonly kind: 'slot'
  readonly type: string
  value: number
}

/** 把 SID 串编码成 Win32 字节布局（Revision/SubAuthorityCount/Authority/SubAuthorities）。 */
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

/** 造一条 ACE（头 4 字节 + 掩码 4 字节 + 内联 SID）。 */
function makeAce(type: number, flags: number, mask: number, sid: Buffer | string): Buffer {
  const sidBytes = typeof sid === 'string' ? encodeSid(sid) : sid
  const ace = Buffer.alloc(8 + sidBytes.length)
  ace[0] = type
  ace[1] = flags
  ace.writeUInt16LE(ace.length, 2)
  ace.writeUInt32LE(mask >>> 0, 4)
  sidBytes.copy(ace, 8)
  return ace
}

/** 把若干 ACE 拼成一份 ACL（AclRevision/Sbz1/AclSize/AceCount）。 */
function makeAcl(aces: readonly Buffer[]): Buffer {
  const size = ACL_FIRST_ACE_OFFSET + aces.reduce((sum, ace) => sum + ace.length, 0)
  const acl = Buffer.alloc(size)
  acl[0] = ACL_REVISION
  acl[1] = 0
  acl.writeUInt16LE(size, 2)
  acl.writeUInt16LE(aces.length, 4)
  let offset = ACL_FIRST_ACE_OFFSET
  for (const ace of aces) {
    ace.copy(acl, offset)
    offset += ace.length
  }
  return acl
}

/** 精确命中三件套的 DACL：Allow 能力 SID(OI|CI) + Deny Everyone 删子项(仅 CI)。 */
function exactDacl(sid = CAP_SID): Buffer {
  return makeAcl([
    makeAce(ACCESS_ALLOWED_ACE_TYPE, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE, GRANT_MASK, sid),
    makeAce(ACCESS_DENIED_ACE_TYPE, CONTAINER_INHERIT_ACE, FILE_DELETE_CHILD, EVERYONE),
  ])
}

/** 精确命中的标签 SACL：Low + NO_WRITE_UP(OI|CI)。 */
function exactSacl(): Buffer {
  return makeAcl([
    makeAce(
      SYSTEM_MANDATORY_LABEL_ACE_TYPE,
      OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
      SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
      LOW_LABEL,
    ),
  ])
}

/** 账号分支的掩码（与 acl.ts 的 accountMask 同一表达式）。 */
const ACCOUNT_MASK = (FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | GRANT_MASK) >>> 0

/**
 * 造一份可按需配置的假绑定。
 *
 * `knobs` 在调用时读取（不是构造时快照），测试里直接改字段就能制造失败分支。
 * `heap` 是「系统内存」：ACL 字节与 API 分配的 SID 都按数值地址放进去。
 */
function makeWin32() {
  const addresses = new WeakMap<object, number>()
  const heap = new Map<number, Buffer>()
  let nextAddress = 0x10_0000
  let lastError = 0
  let pendingSid = ''
  let nextRawSid = 0x70_0000

  const knobs = {
    /** GetNamedSecurityInfoW 的返回值（0 = 成功）。 */
    getCode: 0,
    /** DACL / SACL / 安全描述符 系统指针。 */
    daclPointer: 0,
    saclPointer: 0,
    sdPointer: 0x99_0000,
    /** SetEntriesInAclW 的返回码（0 = 成功）。 */
    setEntriesCode: 0,
    newDaclPointer: 0x88_0000,
    /** SetNamedSecurityInfoW 的返回码（0 = 成功）。 */
    writeCode: 0,
    /** InitializeAcl / AddMandatoryAce 的返回（1 = 成功）。 */
    initAclCode: 1,
    addMandatoryAceCode: 1,
    /** CreateFileW 的返回值：0 / -1n / 正常句柄。 */
    createFile: 0x5000 as number | bigint,
    /** LockFileEx 的返回（1 = 成功）。 */
    lockCode: 1,
    lockThrows: false,
    unlockThrows: false,
    closeThrows: false,
    /** 等于这个地址的 LocalFree 会抛（验 finally 吞异常）。 */
    localFreeThrowsAt: null as number | null,
    failConvert: false,
    failWellKnown: false,
  }

  const koffi = {
    load: vi.fn(),
    alloc: vi.fn((type: string, count: number) => {
      if (type === 'uintptr_t' || type === 'uint32') {
        return { kind: 'slot', type, value: 0 } satisfies Slot
      }
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
    const bytes = encodeSid(pendingSid)
    const pointer = nextRawSid
    nextRawSid += 0x1000
    heap.set(pointer, bytes)
    out.value = pointer
    return 1
  })
  const getLengthSid = vi.fn((pointer: number) => heap.get(pointer)?.length ?? 0)
  const copySid = vi.fn((length: number, destination: Buffer, pointer: number) => {
    const bytes = heap.get(pointer)
    if (bytes === undefined) return 0
    bytes.copy(destination, 0, 0, length)
    return 1
  })
  const localFree = vi.fn((pointer: number) => {
    if (knobs.localFreeThrowsAt !== null && pointer === knobs.localFreeThrowsAt) {
      throw new Error('LocalFree 失败')
    }
    return 0
  })

  const createWellKnownSid = vi.fn((kind: number, _domain: number, buffer: Buffer, cbSid: Buffer) => {
    if (knobs.failWellKnown) {
      lastError = 87
      return 0
    }
    const encoded = encodeSid(kind === WinWorldSid ? EVERYONE : LOW_LABEL)
    encoded.copy(buffer, 0)
    cbSid.writeUInt32LE(encoded.length, 0)
    return 1
  })

  /** 登记一段「系统内存」，返回它在该内存里的地址。 */
  const place = (bytes: Buffer, address: number): number => {
    heap.set(address, bytes)
    return address
  }

  const createFileW = vi.fn(() => knobs.createFile)
  const lockFileEx = vi.fn(() => {
    if (knobs.lockThrows) throw new Error('LockFileEx 调用崩了')
    return knobs.lockCode
  })
  const unlockFileEx = vi.fn(() => {
    if (knobs.unlockThrows) throw new Error('UnlockFileEx 调用崩了')
    return 1
  })
  const closeHandle = vi.fn(() => {
    if (knobs.closeThrows) throw new Error('CloseHandle 调用崩了')
    return 1
  })

  const getNamedSecurityInfoW = vi.fn(
    (_name: Buffer, _type: number, _info: number, _owner: Slot, _group: Slot, dacl: Slot, sacl: Slot, sd: Slot) => {
      if (knobs.getCode !== 0) return knobs.getCode
      dacl.value = knobs.daclPointer
      sacl.value = knobs.saclPointer
      sd.value = knobs.sdPointer
      return 0
    },
  )

  const setEntriesInAclW = vi.fn((_count: number, _entries: Buffer, _oldAcl: number, out: Slot) => {
    if (knobs.setEntriesCode !== 0) return knobs.setEntriesCode
    out.value = knobs.newDaclPointer
    return 0
  })

  const initializeAcl = vi.fn(() => knobs.initAclCode)
  const addMandatoryAce = vi.fn(() => knobs.addMandatoryAceCode)
  const setNamedSecurityInfoW = vi.fn(() => knobs.writeCode)

  const bound = {
    koffi,
    getLastLastError: () => lastError,
    formatMessageW: () => 0,
    convertStringSidToSidW,
    getLengthSid,
    copySid,
    localFree,
    createWellKnownSid,
    createFileW,
    lockFileEx,
    unlockFileEx,
    closeHandle,
    getNamedSecurityInfoW,
    setEntriesInAclW,
    initializeAcl,
    addMandatoryAce,
    setNamedSecurityInfoW,
  } as unknown as BoundWin32

  return {
    bound,
    koffi,
    knobs,
    heap,
    place,
    mocks: {
      convertStringSidToSidW,
      getLengthSid,
      copySid,
      localFree,
      createWellKnownSid,
      createFileW,
      lockFileEx,
      unlockFileEx,
      closeHandle,
      getNamedSecurityInfoW,
      setEntriesInAclW,
      initializeAcl,
      addMandatoryAce,
      setNamedSecurityInfoW,
    },
  }
}

/** 抓同步抛出的错误（用来断言 Win32Error 的 api 与错误码）。 */
function catchError(ripe: () => unknown): unknown {
  try {
    ripe()
  } catch (error) {
    return error
  }
  throw new Error('预期抛错，但没有抛')
}

/** 期望的锁文件名：小写路径的 sha256 前 16 位 hex + `.lock`。 */
function expectedLockName(path: string): string {
  const hex = createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 16)
  return join(LOCK_DIR, `${hex}.lock`)
}

describe('walkAces：ACL 字节解析与非法尺寸', () => {
  test('不足一个 ACL 头（< 8 字节）直接返回空表', () => {
    expect(walkAces(new Uint8Array())).toEqual([])
    expect(walkAces(new Uint8Array(7))).toEqual([])
  })

  test('解出一条 Allow ACE：类型/flags/掩码/内联 SID 全部按字节给出', () => {
    const sid = encodeSid(CAP_SID)
    const acl = makeAcl([makeAce(ACCESS_ALLOWED_ACE_TYPE, 0x03, GRANT_MASK, sid)])
    const aces = walkAces(acl)

    expect(aces).toHaveLength(1)
    expect(aces[0]).toMatchObject({ type: ACCESS_ALLOWED_ACE_TYPE, flags: 0x03, mask: GRANT_MASK })
    expect(Buffer.from(aces[0]!.sid).equals(sid)).toBe(true)
  })

  test('按 AceSize 步进：多条 ACE 依次解开', () => {
    const acl = makeAcl([
      makeAce(ACCESS_ALLOWED_ACE_TYPE, 0x03, GRANT_MASK, CAP_SID),
      makeAce(ACCESS_DENIED_ACE_TYPE, CONTAINER_INHERIT_ACE, FILE_DELETE_CHILD, EVERYONE),
      makeAce(SYSTEM_MANDATORY_LABEL_ACE_TYPE, 0x03, SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, LOW_LABEL),
    ])
    expect(walkAces(acl).map((ace) => ace.type)).toEqual([
      ACCESS_ALLOWED_ACE_TYPE,
      ACCESS_DENIED_ACE_TYPE,
      SYSTEM_MANDATORY_LABEL_ACE_TYPE,
    ])
  })

  test('AceSize 小于最小 ACE（头 8 + 最短 SID 8）就停，不信任后面的字节', () => {
    const acl = makeAcl([makeAce(ACCESS_ALLOWED_ACE_TYPE, 0, GRANT_MASK, CAP_SID)])
    acl.writeUInt16LE(8, ACL_FIRST_ACE_OFFSET + 2) // 头部都装不下
    expect(walkAces(acl)).toEqual([])
  })

  test('AceSize 越过 ACL 尾就停（AclSize 与实际长度不符）', () => {
    const acl = makeAcl([makeAce(ACCESS_ALLOWED_ACE_TYPE, 0, GRANT_MASK, CAP_SID)])
    acl.writeUInt16LE(acl.length, ACL_FIRST_ACE_OFFSET + 2) // 比实际可用字节大
    expect(walkAces(acl)).toEqual([])
  })

  test('声明的子授权数装不进 AceSize 就停（长度字段不可信）', () => {
    const acl = makeAcl([makeAce(ACCESS_ALLOWED_ACE_TYPE, 0, GRANT_MASK, CAP_SID)])
    acl[ACL_FIRST_ACE_OFFSET + 9] = 4 // SubAuthorityCount 改成 4，但 AceSize 没变
    expect(walkAces(acl)).toEqual([])
  })

  test('AceCount 说有 ACE、但 ACL 只剩 8 字节头 → 没有 ACE 头可读，停', () => {
    const acl = Buffer.alloc(ACL_FIRST_ACE_OFFSET)
    acl[0] = ACL_REVISION
    acl.writeUInt16LE(ACL_FIRST_ACE_OFFSET, 2)
    acl.writeUInt16LE(1, 4)
    expect(walkAces(acl)).toEqual([])
  })
})

describe('withPathLock：锁文件、阻塞加锁与收尾（经 grantWrite 触发）', () => {
  const idempotent = () => {
    const world = makeWin32()
    world.knobs.daclPointer = world.place(exactDacl(), 0x90_0000)
    world.knobs.saclPointer = world.place(exactSacl(), 0x91_0000)
    return world
  }

  test('锁文件名 = 小写路径 sha256 前 16 位 + .lock；加锁参数与 OVERLAPPED 零块', () => {
    const world = idempotent()
    const outcome = grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR)

    expect(outcome).toEqual({ applied: false, detail: '三件套已在（幂等跳过，不重传播）' })
    const call = world.mocks.createFileW.mock.calls[0]! as unknown[]
    expect((call[0] as Buffer).toString('utf16le')).toBe(`${expectedLockName(TARGET)}\0`)
    expect(call[1]).toBe((GENERIC_READ | GENERIC_WRITE) >>> 0)
    expect(call[2]).toBe(3) // FILE_SHARE_READ | FILE_SHARE_WRITE
    expect(call[4]).toBe(OPEN_ALWAYS)
    expect(call[5]).toBe(0x80) // FILE_ATTRIBUTE_NORMAL

    const lock = world.mocks.lockFileEx.mock.calls[0]! as unknown[]
    expect(lock[0]).toBe(0x5000)
    expect(lock[1]).toBe(LOCKFILE_EXCLUSIVE_LOCK)
    expect(lock[5]).toBeInstanceOf(Buffer)
    expect((lock[5] as Buffer).length).toBe(OVERLAPPED_SIZE)
    expect((lock[5] as Buffer).every((byte) => byte === 0)).toBe(true)

    // 锁与句柄都由 finally 收掉
    expect(world.mocks.unlockFileEx).toHaveBeenCalledWith(0x5000, 0, 1, 0, expect.any(Buffer))
    expect(world.mocks.closeHandle).toHaveBeenCalledWith(0x5000)
  })

  test('正常句柄可以是 bigint（koffi 对 uintptr_t 的返回形态之一）', () => {
    const world = idempotent()
    world.knobs.createFile = 0x5000n
    expect(grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR).applied).toBe(false)
    expect((world.mocks.lockFileEx.mock.calls[0] as unknown[])[0]).toBe(0x5000)
  })

  test('CreateFileW 返回 0 → 抛 Win32Error，且不去加锁', () => {
    const world = idempotent()
    world.knobs.createFile = 0
    world.knobs.localFreeThrowsAt = null
    const error = catchError(() => grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR))

    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'CreateFileW(锁文件)' })
    expect(world.mocks.lockFileEx).not.toHaveBeenCalled()
    expect(world.mocks.closeHandle).not.toHaveBeenCalled()
  })

  test('CreateFileW 返回 INVALID_HANDLE_VALUE（18446744073709551615n）也按失败处理', () => {
    const world = idempotent()
    world.knobs.createFile = 0xffff_ffff_ffff_ffffn
    const error = catchError(() => grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR))

    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'CreateFileW(锁文件)' })
    expect(world.mocks.lockFileEx).not.toHaveBeenCalled()
  })

  test('LockFileEx 返回 0 → 抛 Win32Error，但 finally 仍解锁并关句柄', () => {
    const world = idempotent()
    world.knobs.lockCode = 0
    const error = catchError(() => grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR))

    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'LockFileEx' })
    expect(world.mocks.unlockFileEx).toHaveBeenCalled()
    expect(world.mocks.closeHandle).toHaveBeenCalledWith(0x5000)
  })

  test('LockFileEx 自己抛错也按失败返回（finally 照常收尾）', () => {
    const world = idempotent()
    world.knobs.lockThrows = true
    const error = catchError(() => grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/LockFileEx 调用崩了/)
    expect(world.mocks.closeHandle).toHaveBeenCalledWith(0x5000)
  })

  test('UnlockFileEx 抛错被吞：真实结果不受影响', () => {
    const world = idempotent()
    world.knobs.unlockThrows = true
    expect(grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR)).toMatchObject({ applied: false })
    expect(world.mocks.closeHandle).toHaveBeenCalledWith(0x5000)
  })

  test('CloseHandle 抛错被吞：真实结果不受影响', () => {
    const world = idempotent()
    world.knobs.closeThrows = true
    expect(grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR)).toMatchObject({ applied: false })
  })

  test('锁内工作抛错：错误照常冒出，锁与句柄已经收回', () => {
    const world = idempotent()
    // AclSize = 0 的坏 ACL：readAclBytes 抛普通 Error
    world.knobs.daclPointer = world.place(Buffer.from([2, 0, 0, 0, 0, 0, 0, 0]), 0x92_0000)

    const error = catchError(() => grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR))
    expect((error as Error).message).toMatch(/AclSize 不合法/)
    expect(world.mocks.unlockFileEx).toHaveBeenCalled()
    expect(world.mocks.closeHandle).toHaveBeenCalledWith(0x5000)
  })
})

describe('grantWrite：三件套的精确命中与写入', () => {
  test('三件套逐字节命中时幂等跳过：不写盘、不碰 EXPLICIT_ACCESS', () => {
    const world = makeWin32()
    world.knobs.daclPointer = world.place(exactDacl(), 0x90_0000)
    world.knobs.saclPointer = world.place(exactSacl(), 0x91_0000)

    const outcome = grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR)

    expect(outcome.applied).toBe(false)
    expect(world.mocks.setEntriesInAclW).not.toHaveBeenCalled()
    expect(world.mocks.initializeAcl).not.toHaveBeenCalled()
    expect(world.mocks.setNamedSecurityInfoW).not.toHaveBeenCalled()
    // 描述符只 LocalFree 一次（SID 那只由 sidStringToBuffer 自己释放）
    expect(world.mocks.localFree.mock.calls.map((call) => call[0])).toContain(0x99_0000)
  })

  test('未命中时一次写齐：两条 EXPLICIT_ACCESS + 空 ACL 上加 Low 标签 + 单次 SetNamedSecurityInfoW', () => {
    const world = makeWin32()
    world.knobs.daclPointer = world.place(makeAcl([]), 0x90_0000)
    world.knobs.saclPointer = world.place(makeAcl([]), 0x91_0000)

    const outcome = grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR)

    expect(outcome).toEqual({
      applied: true,
      detail: '已打三件套（Allow 能力 SID + Deny Everyone 删子项 + Low 标签）',
    })

    // 两条 EXPLICIT_ACCESS 在同一个 96 字节块里
    const merge = world.mocks.setEntriesInAclW.mock.calls[0]! as unknown[]
    expect(merge[0]).toBe(2)
    const entries = merge[1] as Buffer
    expect(entries).toHaveLength(EXPLICIT_ACCESS_SIZE * 2)
    expect(merge[2]).toBe(0x90_0000)

    const allow = entries.subarray(0, EXPLICIT_ACCESS_SIZE)
    expect(allow.readUInt32LE(0)).toBe(GRANT_MASK)
    expect(allow.readUInt32LE(4)).toBe(GRANT_ACCESS)
    expect(allow.readUInt32LE(8)).toBe(OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)
    expect(world.heap.get(Number(allow.readBigUInt64LE(40)))!.equals(encodeSid(CAP_SID))).toBe(true)

    const deny = entries.subarray(EXPLICIT_ACCESS_SIZE)
    expect(deny.readUInt32LE(0)).toBe(FILE_DELETE_CHILD)
    expect(deny.readUInt32LE(4)).toBe(DENY_ACCESS)
    expect(deny.readUInt32LE(8)).toBe(CONTAINER_INHERIT_ACE)
    expect(world.heap.get(Number(deny.readBigUInt64LE(40)))!.equals(encodeSid(EVERYONE))).toBe(true)

    // 标签 ACL：InitializeAcl 建的块与 AddMandatoryAce 用的是同一块
    const init = world.mocks.initializeAcl.mock.calls[0]! as unknown[]
    const labelBuffer = init[0] as Buffer
    expect(init[1]).toBe(labelBuffer.length)
    expect(init[2]).toBe(ACL_REVISION)
    const label = world.mocks.addMandatoryAce.mock.calls[0]! as unknown[]
    expect(label[0]).toBe(labelBuffer)
    expect(label[1]).toBe(ACL_REVISION)
    expect(label[2]).toBe(OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)
    expect(label[3]).toBe(SYSTEM_MANDATORY_LABEL_NO_WRITE_UP)
    expect((label[4] as Buffer).equals(encodeSid(LOW_LABEL))).toBe(true)

    // 单次写：DACL 用合并后的新 ACL，SACL 用刚造的标签 ACL 地址
    const write = world.mocks.setNamedSecurityInfoW.mock.calls[0]! as unknown[]
    expect(write[1]).toBe(SE_FILE_OBJECT)
    expect(write[2]).toBe(DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION)
    expect(write[3]).toBe(0)
    expect(write[4]).toBe(0)
    expect(write[5]).toBe(world.knobs.newDaclPointer)
    expect(write[6]).toBe(Number(world.koffi.address(labelBuffer)))
  })

  test('三件套任一不精确（flags/掩码/SID 长度或值/少一条）都按未命中重打', () => {
    const variants: Array<[string, () => { dacl: Buffer; sacl: Buffer }]> = [
      [
        'Allow 少 OI',
        () => ({
          dacl: makeAcl([
            makeAce(ACCESS_ALLOWED_ACE_TYPE, CONTAINER_INHERIT_ACE, GRANT_MASK, CAP_SID),
            makeAce(ACCESS_DENIED_ACE_TYPE, CONTAINER_INHERIT_ACE, FILE_DELETE_CHILD, EVERYONE),
          ]),
          sacl: exactSacl(),
        }),
      ],
      [
        'Allow 掩码不对',
        () => ({
          dacl: makeAcl([
            makeAce(ACCESS_ALLOWED_ACE_TYPE, 0x03, GRANT_MASK ^ 0x40, CAP_SID),
            makeAce(ACCESS_DENIED_ACE_TYPE, CONTAINER_INHERIT_ACE, FILE_DELETE_CHILD, EVERYONE),
          ]),
          sacl: exactSacl(),
        }),
      ],
      [
        'Allow SID 长度不同',
        () => ({
          dacl: makeAcl([
            makeAce(ACCESS_ALLOWED_ACE_TYPE, 0x03, GRANT_MASK, `${CAP_SID}-1`),
            makeAce(ACCESS_DENIED_ACE_TYPE, CONTAINER_INHERIT_ACE, FILE_DELETE_CHILD, EVERYONE),
          ]),
          sacl: exactSacl(),
        }),
      ],
      [
        'Allow SID 同长不同值',
        () => ({
          dacl: makeAcl([
            makeAce(ACCESS_ALLOWED_ACE_TYPE, 0x03, GRANT_MASK, 'S-1-5-8'),
            makeAce(ACCESS_DENIED_ACE_TYPE, CONTAINER_INHERIT_ACE, FILE_DELETE_CHILD, EVERYONE),
          ]),
          sacl: exactSacl(),
        }),
      ],
      [
        'Deny 带了 OI',
        () => ({
          dacl: makeAcl([
            makeAce(ACCESS_ALLOWED_ACE_TYPE, 0x03, GRANT_MASK, CAP_SID),
            makeAce(ACCESS_DENIED_ACE_TYPE, 0x03, FILE_DELETE_CHILD, EVERYONE),
          ]),
          sacl: exactSacl(),
        }),
      ],
      [
        'Deny 掩码不对',
        () => ({
          dacl: makeAcl([
            makeAce(ACCESS_ALLOWED_ACE_TYPE, 0x03, GRANT_MASK, CAP_SID),
            makeAce(ACCESS_DENIED_ACE_TYPE, CONTAINER_INHERIT_ACE, FILE_DELETE_CHILD + 1, EVERYONE),
          ]),
          sacl: exactSacl(),
        }),
      ],
      [
        '没有 Deny',
        () => ({
          dacl: makeAcl([makeAce(ACCESS_ALLOWED_ACE_TYPE, 0x03, GRANT_MASK, CAP_SID)]),
          sacl: exactSacl(),
        }),
      ],
      [
        '能力 SID 那条是 Deny',
        () => ({
          dacl: makeAcl([
            makeAce(ACCESS_DENIED_ACE_TYPE, 0x03, GRANT_MASK, CAP_SID),
            makeAce(ACCESS_DENIED_ACE_TYPE, CONTAINER_INHERIT_ACE, FILE_DELETE_CHILD, EVERYONE),
          ]),
          sacl: exactSacl(),
        }),
      ],
      [
        'Everyone 那条是 Allow',
        () => ({
          dacl: makeAcl([
            makeAce(ACCESS_ALLOWED_ACE_TYPE, 0x03, GRANT_MASK, CAP_SID),
            makeAce(ACCESS_ALLOWED_ACE_TYPE, CONTAINER_INHERIT_ACE, FILE_DELETE_CHILD, EVERYONE),
          ]),
          sacl: exactSacl(),
        }),
      ],
      [
        '标签类型不对',
        () => ({
          dacl: exactDacl(),
          sacl: makeAcl([
            makeAce(0x12, 0x03, SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, LOW_LABEL),
          ]),
        }),
      ],
      [
        '标签 flags 不对',
        () => ({
          dacl: exactDacl(),
          sacl: makeAcl([
            makeAce(SYSTEM_MANDATORY_LABEL_ACE_TYPE, CONTAINER_INHERIT_ACE, SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, LOW_LABEL),
          ]),
        }),
      ],
      [
        '标签掩码不对',
        () => ({
          dacl: exactDacl(),
          sacl: makeAcl([
            makeAce(SYSTEM_MANDATORY_LABEL_ACE_TYPE, 0x03, 0, LOW_LABEL),
          ]),
        }),
      ],
      [
        '标签 SID 不对',
        () => ({
          dacl: exactDacl(),
          sacl: makeAcl([
            makeAce(SYSTEM_MANDATORY_LABEL_ACE_TYPE, 0x03, SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, 'S-1-16-8192'),
          ]),
        }),
      ],
    ]

    for (const [name, build] of variants) {
      const world = makeWin32()
      const { dacl, sacl } = build()
      world.knobs.daclPointer = world.place(dacl, 0x90_0000)
      world.knobs.saclPointer = world.place(sacl, 0x91_0000)
      // 只验「走到了写入」：细节由上一个用例钉住
      expect(grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR).applied, name).toBe(true)
      expect(world.mocks.setNamedSecurityInfoW, name).toHaveBeenCalledTimes(1)
    }
  })

  test('NULL DACL / NULL SACL 都不算命中（不能把「没有 ACL」当成精确命中）', () => {
    for (const pointer of ['dacl', 'sacl'] as const) {
      const world = makeWin32()
      world.knobs.daclPointer = pointer === 'dacl' ? 0 : world.place(exactDacl(), 0x90_0000)
      world.knobs.saclPointer = pointer === 'sacl' ? 0 : world.place(exactSacl(), 0x91_0000)
      expect(grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR).applied).toBe(true)
    }
  })

  test('GetNamedSecurityInfoW 返回非 0 → 抛 Win32Error，且不进入 finally 的释放', () => {
    const world = makeWin32()
    world.knobs.getCode = 5
    const error = catchError(() => grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR))

    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'GetNamedSecurityInfoW(三件套)', win32Code: 5 })
    expect(world.mocks.setEntriesInAclW).not.toHaveBeenCalled()
    // finally 都还没建立：描述符槽没值，不该 LocalFree
    expect(world.mocks.localFree.mock.calls.map((call) => call[0])).not.toContain(0x99_0000)
  })

  test('ACL 头的 AclSize 非法 → 明确抛错，不拿坏指针继续 SetEntriesInAclW', () => {
    const world = makeWin32()
    world.knobs.daclPointer = world.place(Buffer.from([2, 0, 1, 0, 0, 0, 0, 0]), 0x90_0000)
    world.knobs.saclPointer = world.place(exactSacl(), 0x91_0000)

    const error = catchError(() => grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR))
    expect((error as Error).message).toMatch(/AclSize 不合法（1）/)
    expect(world.mocks.setEntriesInAclW).not.toHaveBeenCalled()
  })

  test('SetEntriesInAclW(三件套) 返回非 0 → 抛 Win32Error（api 名带用途）', () => {
    const world = makeWin32()
    world.knobs.daclPointer = world.place(makeAcl([]), 0x90_0000)
    world.knobs.saclPointer = world.place(makeAcl([]), 0x91_0000)
    world.knobs.setEntriesCode = 87
    const error = catchError(() => grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR))

    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'SetEntriesInAclW(三件套)', win32Code: 87 })
    expect(world.mocks.initializeAcl).not.toHaveBeenCalled()
    expect(world.mocks.localFree.mock.calls.map((call) => call[0])).toContain(0x99_0000)
  })

  test('InitializeAcl 返回 0 → 抛 Win32Error（api 直接点名）', () => {
    const world = makeWin32()
    world.knobs.daclPointer = world.place(makeAcl([]), 0x90_0000)
    world.knobs.saclPointer = world.place(makeAcl([]), 0x91_0000)
    world.knobs.initAclCode = 0
    const error = catchError(() => grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR))

    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'InitializeAcl' })
    expect(world.mocks.addMandatoryAce).not.toHaveBeenCalled()
  })

  test('AddMandatoryAce 返回 0 → 抛 Win32Error，且没写盘', () => {
    const world = makeWin32()
    world.knobs.daclPointer = world.place(makeAcl([]), 0x90_0000)
    world.knobs.saclPointer = world.place(makeAcl([]), 0x91_0000)
    world.knobs.addMandatoryAceCode = 0
    const error = catchError(() => grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR))

    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'AddMandatoryAce' })
    expect(world.mocks.setNamedSecurityInfoW).not.toHaveBeenCalled()
  })

  test('SetNamedSecurityInfoW(三件套) 返回非 0 → 抛 Win32Error', () => {
    const world = makeWin32()
    world.knobs.daclPointer = world.place(makeAcl([]), 0x90_0000)
    world.knobs.saclPointer = world.place(makeAcl([]), 0x91_0000)
    world.knobs.writeCode = 5
    const error = catchError(() => grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR))

    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'SetNamedSecurityInfoW(三件套)', win32Code: 5 })
    expect(world.mocks.localFree.mock.calls.map((call) => call[0])).toContain(0x99_0000)
  })

  test('安全描述符指针为 0 时不调 LocalFree（NULL 不是可释放对象）', () => {
    const world = makeWin32()
    world.knobs.daclPointer = world.place(exactDacl(), 0x90_0000)
    world.knobs.saclPointer = world.place(exactSacl(), 0x91_0000)
    world.knobs.sdPointer = 0
    expect(grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR).applied).toBe(false)
    expect(world.mocks.localFree.mock.calls.map((call) => call[0])).not.toContain(0)
  })

  test('LocalFree 描述符抛错被吞：授权结果照常返回', () => {
    const world = makeWin32()
    world.knobs.daclPointer = world.place(exactDacl(), 0x90_0000)
    world.knobs.saclPointer = world.place(exactSacl(), 0x91_0000)
    world.knobs.localFreeThrowsAt = 0x99_0000
    expect(grantWrite(world.bound, TARGET, CAP_SID, LOCK_DIR).applied).toBe(false)
  })
})

describe('grantAccountAccess：账号读写执行 ACE', () => {
  const accountDacl = (flags = 0x03, mask = ACCOUNT_MASK, sid = CAP_SID) =>
    makeAcl([makeAce(ACCESS_ALLOWED_ACE_TYPE, flags, mask, sid)])

  test('精确命中即幂等跳过：不合并、不写盘', () => {
    const world = makeWin32()
    world.knobs.daclPointer = world.place(accountDacl(), 0x90_0000)

    const outcome = grantAccountAccess(world.bound, TARGET, CAP_SID, LOCK_DIR)
    expect(outcome).toEqual({ applied: false, detail: '账号 ACE 已在（幂等跳过）' })
    expect(world.mocks.setEntriesInAclW).not.toHaveBeenCalled()
    expect(world.mocks.setNamedSecurityInfoW).not.toHaveBeenCalled()
  })

  test('没有 DACL 时也从零建：掩码 = 读+执行+写删，OI|CI，单条 EXPLICIT_ACCESS', () => {
    const world = makeWin32()
    world.knobs.daclPointer = 0

    const outcome = grantAccountAccess(world.bound, TARGET, CAP_SID, LOCK_DIR)
    expect(outcome).toEqual({ applied: true, detail: '已补账号读写执行 ACE' })

    const merge = world.mocks.setEntriesInAclW.mock.calls[0]! as unknown[]
    expect(merge[0]).toBe(1)
    expect(merge[2]).toBe(0) // oldAcl = NULL
    const entry = merge[1] as Buffer
    expect(entry.readUInt32LE(0)).toBe(ACCOUNT_MASK)
    expect(entry.readUInt32LE(4)).toBe(GRANT_ACCESS)
    expect(entry.readUInt32LE(8)).toBe(OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)
    expect(world.heap.get(Number(entry.readBigUInt64LE(40)))!.equals(encodeSid(CAP_SID))).toBe(true)

    const write = world.mocks.setNamedSecurityInfoW.mock.calls[0]! as unknown[]
    expect(write[2]).toBe(DACL_SECURITY_INFORMATION)
    expect(write[5]).toBe(world.knobs.newDaclPointer)
    expect(write[6]).toBe(0)
  })

  test('同 SID 但 flags / 掩码 / 类型不精确，或换了个 SID → 仍要补一条新的', () => {
    const dacls = [
      accountDacl(OBJECT_INHERIT_ACE),
      accountDacl(0x03, ACCOUNT_MASK ^ 1),
      makeAcl([makeAce(ACCESS_DENIED_ACE_TYPE, 0x03, ACCOUNT_MASK, CAP_SID)]),
      accountDacl(0x03, ACCOUNT_MASK, 'S-1-5-8'),
    ]
    for (const dacl of dacls) {
      const world = makeWin32()
      world.knobs.daclPointer = world.place(dacl, 0x90_0000)
      expect(grantAccountAccess(world.bound, TARGET, CAP_SID, LOCK_DIR).applied).toBe(true)
    }
  })

  test('GetNamedSecurityInfoW(账号授权) 失败 → 抛 Win32Error，且不释放描述符', () => {
    const world = makeWin32()
    world.knobs.getCode = 5
    const error = catchError(() => grantAccountAccess(world.bound, TARGET, CAP_SID, LOCK_DIR))

    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'GetNamedSecurityInfoW(账号授权)', win32Code: 5 })
    expect(world.mocks.localFree.mock.calls.map((call) => call[0])).not.toContain(0x99_0000)
  })

  test('SetEntriesInAclW(账号授权) 失败 → 抛 Win32Error，描述符已释放', () => {
    const world = makeWin32()
    world.knobs.daclPointer = 0
    world.knobs.setEntriesCode = 87
    const error = catchError(() => grantAccountAccess(world.bound, TARGET, CAP_SID, LOCK_DIR))

    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'SetEntriesInAclW(账号授权)', win32Code: 87 })
    expect(world.mocks.localFree.mock.calls.map((call) => call[0])).toContain(0x99_0000)
  })

  test('SetNamedSecurityInfoW(账号授权) 失败 → 抛 Win32Error', () => {
    const world = makeWin32()
    world.knobs.daclPointer = 0
    world.knobs.writeCode = 5
    const error = catchError(() => grantAccountAccess(world.bound, TARGET, CAP_SID, LOCK_DIR))

    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'SetNamedSecurityInfoW(账号授权)', win32Code: 5 })
  })

  test('描述符为空（0）也会调 LocalFree，抛错被吞', () => {
    const world = makeWin32()
    world.knobs.daclPointer = 0
    world.knobs.sdPointer = 0
    world.knobs.localFreeThrowsAt = null
    expect(grantAccountAccess(world.bound, TARGET, CAP_SID, LOCK_DIR).applied).toBe(true)
    expect(world.mocks.localFree.mock.calls.map((call) => call[0])).toContain(0)

    const throwing = makeWin32()
    throwing.knobs.daclPointer = 0
    throwing.knobs.sdPointer = 0
    throwing.knobs.localFreeThrowsAt = 0
    expect(grantAccountAccess(throwing.bound, TARGET, CAP_SID, LOCK_DIR).applied).toBe(true)
  })
})

describe('revokeWrite：只摘 Allow ACE，保留 Low 标签', () => {
  const allowAcl = () => makeAcl([makeAce(ACCESS_ALLOWED_ACE_TYPE, 0x03, GRANT_MASK, CAP_SID)])

  test('命中能力 SID 时用 REVOKE_ACCESS 单条合并并写回 DACL', () => {
    const world = makeWin32()
    world.knobs.daclPointer = world.place(allowAcl(), 0x90_0000)

    const outcome = revokeWrite(world.bound, TARGET, CAP_SID, LOCK_DIR)
    expect(outcome).toEqual({ applied: true, detail: '已摘除能力 ACE（Low 标签保留）' })

    const merge = world.mocks.setEntriesInAclW.mock.calls[0]! as unknown[]
    expect(merge[0]).toBe(1)
    expect(merge[2]).toBe(0x90_0000)
    const entry = merge[1] as Buffer
    expect(entry.readUInt32LE(0)).toBe(0)
    expect(entry.readUInt32LE(4)).toBe(REVOKE_ACCESS)
    expect(entry.readUInt32LE(8)).toBe(0)

    const write = world.mocks.setNamedSecurityInfoW.mock.calls[0]! as unknown[]
    expect(write[2]).toBe(DACL_SECURITY_INFORMATION)
    expect(write[5]).toBe(world.knobs.newDaclPointer)
    expect(write[6]).toBe(0)
  })

  test('SID 不在（同类型但别的 SID）→ 幂等跳过', () => {
    const world = makeWin32()
    world.knobs.daclPointer = world.place(
      makeAcl([makeAce(ACCESS_ALLOWED_ACE_TYPE, 0x03, GRANT_MASK, 'S-1-5-8')]),
      0x90_0000,
    )
    expect(revokeWrite(world.bound, TARGET, CAP_SID, LOCK_DIR)).toEqual({
      applied: false,
      detail: '授权本就不在（幂等跳过）',
    })
    expect(world.mocks.setEntriesInAclW).not.toHaveBeenCalled()
  })

  test('同样的 SID 但类型是 Deny → 不算「授权还在」', () => {
    const world = makeWin32()
    world.knobs.daclPointer = world.place(
      makeAcl([makeAce(ACCESS_DENIED_ACE_TYPE, 0x03, GRANT_MASK, CAP_SID)]),
      0x90_0000,
    )
    expect(revokeWrite(world.bound, TARGET, CAP_SID, LOCK_DIR).applied).toBe(false)
  })

  test('NULL DACL 按「授权不在」处理', () => {
    const world = makeWin32()
    world.knobs.daclPointer = 0
    expect(revokeWrite(world.bound, TARGET, CAP_SID, LOCK_DIR).applied).toBe(false)
  })

  test('GetNamedSecurityInfoW(回收) 失败 → 抛 Win32Error', () => {
    const world = makeWin32()
    world.knobs.getCode = 5
    const error = catchError(() => revokeWrite(world.bound, TARGET, CAP_SID, LOCK_DIR))

    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'GetNamedSecurityInfoW(回收)', win32Code: 5 })
    expect(world.mocks.localFree.mock.calls.map((call) => call[0])).not.toContain(0x99_0000)
  })

  test('SetEntriesInAclW(回收) 失败 → 抛 Win32Error，描述符已释放', () => {
    const world = makeWin32()
    world.knobs.daclPointer = world.place(allowAcl(), 0x90_0000)
    world.knobs.setEntriesCode = 87
    const error = catchError(() => revokeWrite(world.bound, TARGET, CAP_SID, LOCK_DIR))

    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'SetEntriesInAclW(回收)', win32Code: 87 })
    expect(world.mocks.localFree.mock.calls.map((call) => call[0])).toContain(0x99_0000)
  })

  test('SetNamedSecurityInfoW(回收) 失败 → 抛 Win32Error', () => {
    const world = makeWin32()
    world.knobs.daclPointer = world.place(allowAcl(), 0x90_0000)
    world.knobs.writeCode = 5
    const error = catchError(() => revokeWrite(world.bound, TARGET, CAP_SID, LOCK_DIR))

    expect(error).toBeInstanceOf(Win32Error)
    expect(error).toMatchObject({ api: 'SetNamedSecurityInfoW(回收)', win32Code: 5 })
  })

  test('描述符指针为 0 时不 LocalFree；LocalFree 抛错被吞', () => {
    const zero = makeWin32()
    zero.knobs.daclPointer = world0(zero)
    zero.knobs.sdPointer = 0
    expect(revokeWrite(zero.bound, TARGET, CAP_SID, LOCK_DIR).applied).toBe(true)
    expect(zero.mocks.localFree.mock.calls.map((call) => call[0])).not.toContain(0)

    const throwing = makeWin32()
    throwing.knobs.daclPointer = world0(throwing)
    throwing.knobs.localFreeThrowsAt = 0x99_0000
    expect(revokeWrite(throwing.bound, TARGET, CAP_SID, LOCK_DIR).applied).toBe(true)
  })
})

/** 把一份可撤销的 ACL 放进给定世界的堆里，返回地址（小工具，避免重复 0x90_0000）。 */
function world0(world: ReturnType<typeof makeWin32>): number {
  return world.place(
    makeAcl([makeAce(ACCESS_ALLOWED_ACE_TYPE, 0x03, GRANT_MASK, CAP_SID)]),
    0x90_0000,
  )
}
