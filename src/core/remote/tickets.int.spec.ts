/**
 * 一次性 WS 票据：取走即焚、过期作废、认不出的票给 null（迁自 `scripts/remote-host-test.mjs` 第 3 节）。
 *
 * ## 被测的是什么
 *
 * `TicketStore`：浏览器先拿设备 token 换一张 30 秒就死的票（HTTP），再用票升级 WS。
 * `redeem` 是「取走即焚」——同一张票第二次必然 null；过期（TTL 之后）也 null；
 * 从来没签发过的票同样 null。过期路径用注入的假钟走通，不等 30 秒。
 *
 * ## 隔离
 *
 * TicketStore 全在内存里，不落盘；这里仍按 integration 层惯例换好临时 HOME 再加载内核侧
 * 模块（时序要求见 prefs.int.spec 文件头）。
 *
 * @module dsc/core/remote/tickets.int.spec
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../../tests/harness.js'

/** 临时主目录：必须在任何内核模块被加载之前换好（理由见 prefs.int.spec 文件头）。 */
const home = tempHome('dsc-remote-tickets-')

delete process.env['DSC_HOME']

afterAll(() => {
  home.restore()
})

type TicketsModule = typeof import('@pneuma/runtime/core/remote/tickets.js')
let mod: TicketsModule

beforeAll(async () => {
  mod = await import('@pneuma/runtime/core/remote/tickets.js')
})

describe('一次性 WS 票据', () => {
  test('票据第一次用得通，并带回是哪台设备换的', () => {
    const tickets = new mod.TicketStore()
    const ticket = tickets.issue('device-1')
    expect(tickets.redeem(ticket)?.deviceId).toBe('device-1')
  })

  test('同一张票据第二次用不通（一次性）', () => {
    const tickets = new mod.TicketStore()
    const ticket = tickets.issue('device-1')
    tickets.redeem(ticket)
    expect(tickets.redeem(ticket)).toBeNull()
  })

  test('认不出的票据用不通', () => {
    const tickets = new mod.TicketStore()
    expect(tickets.redeem('随便一张')).toBeNull()
  })

  test('过期的票据用不通', () => {
    let ticketClock = 0
    const slowTickets = new mod.TicketStore(mod.TICKET_TTL_MS, () => ticketClock)
    const oldTicket = slowTickets.issue('device-2')
    ticketClock += mod.TICKET_TTL_MS + 1
    expect(slowTickets.redeem(oldTicket)).toBeNull()
  })
})
