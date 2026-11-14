/**
 * 「停用旁问（界面）」的真机走查（迁自 `scripts/ui-plugin-disable-e2e.mjs`，断言 1:1）：
 * 三张证据图 + 一组读数。
 *
 * 为什么要真机：入口卡、页签、快捷键、命令面板动作这四样的消失都发生在**真浏览器的那一帧**
 * ——纯 Node 探针只能压注册表与源码接线（见 `ui-plugin-disable-test.mjs`），压不到
 * 「宿主推了新图、页面把插件卸了、右侧栏跟着重画」这条链路。
 *
 * 与探针的差异：读数/截图落 tmpdir；「Electron 在 / 界面壳产物在」由 freshness 承担；
 * 「宿主起来 / 驱动写出读数」两道 gate 在 beforeAll。驱动报错时数据断言照跑（原探针同款：
 * 读不到就是红，gate 那条写明原因），不 skip。
 *
 * @module dsc/tests/e2e/ui-plugin-disable.e2e
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import {
  ROOT,
  electronUserData,
  freePort,
  mkdtempHome,
  probeFreshness,
  runElectronDriver,
  skipReason,
  startUiHost,
  stopHost,
  type UiHost,
} from './support/host.js'

const DRIVER = join(ROOT, 'scripts', '_ui-plugin-disable-main.cjs')
const ASK_CLIENT = join(ROOT, 'lib', 'ui', 'plugins', 'ask', 'client.js')

interface DisableResult {
  error?: string
  opened?: boolean
  console?: string[]
  initial?: { cards?: string[]; chips?: string[]; nav?: string[] }
  ask?: { openedTab?: boolean; cardsBefore?: string[]; chipsBefore?: string[]; toggle?: { on?: string; gone?: boolean }; chipsAfter?: string[]; bodyGone?: boolean; cardsAfter?: string[]; palette?: { rows?: string[]; empty?: boolean } }
  preview?: { label?: string; chipsBefore?: string[]; chipsAfter?: string[]; previewBodyGone?: boolean; filesStillThere?: boolean }
  files?: { opened?: boolean; chipsBefore?: string[]; chipsAfter?: string[]; bodyGone?: boolean; cardsAfter?: string[] }
  terminal?: { opened?: boolean; chipsBefore?: string[]; chipsAfter?: string[]; bodyGone?: boolean }
  browser?: { opened?: boolean; chipsBefore?: string[]; chipsAfter?: string[]; bodyGone?: boolean }
  plugins?: { navBefore?: string[]; navAfter?: string[]; pageGone?: boolean; chatBack?: boolean; blank?: boolean }
  final?: { cards?: string[]; chips?: string[]; nav?: string[] }
}

const fresh = probeFreshness()
if (!fresh.ok) console.warn(skipReason(fresh))

describe.skipIf(!fresh.ok)('ui-plugin-disable e2e：停用 ui-ask 之后右侧栏不留残骸（真机）', () => {
  const { home } = mkdtempHome('dsc-dock-disable-')
  const outDir = join(home, 'out')
  const shotBefore = join(outDir, 'dock-disable-before.png')
  const shotAfter = join(outDir, 'dock-disable-after.png')
  const shotPalette = join(outDir, 'dock-disable-palette.png')
  const shotEnd = join(outDir, 'dock-disable-all.png')
  const resultPath = join(outDir, 'dock-disable.json')

  let host: UiHost | null = null
  let parsed: DisableResult | null = null

  beforeAll(async () => {
    for (const file of [resultPath, shotBefore, shotAfter, shotPalette, shotEnd]) rmSync(file, { force: true })
    const port = await freePort()
    host = await startUiHost({
      label: 'dock-disable',
      envExtra: {
        HOME: home,
        USERPROFILE: home,
        DSC_HOME: join(home, '.dsc'),
        DSC_UI_PORT: String(port),
        // 这里验的是「停用 → 宿主换图 → 推一帧」，不是产物热更；关掉轮询少一份噪音。
        DSC_UI_HMR: '0',
      },
    })
    parsed = (await runElectronDriver({
      driver: DRIVER,
      url: host.url,
      resultPath,
      timeoutMs: 180_000,
      envExtra: {
        DSC_DISABLE_RESULT: resultPath,
        DSC_DISABLE_BEFORE: shotBefore,
        DSC_DISABLE_AFTER: shotAfter,
        DSC_DISABLE_PALETTE: shotPalette,
        DSC_DISABLE_END: shotEnd,
        DSC_DISABLE_USER_DATA: electronUserData(home),
      },
    })) as DisableResult
  }, 300_000)

  afterAll(async () => {
    await stopHost(host)
    if (parsed !== null && parsed.error === undefined) rmSync(home, { recursive: true, force: true })
  })

  const has = (list: string[] | undefined, text: string): boolean =>
    Array.isArray(list) && list.some((item) => String(item).includes(text))
  const none = (list: string[] | undefined, text: string): boolean =>
    Array.isArray(list) && list.every((item) => !String(item).includes(text))

  test('ask 产物在（lib/ui/plugins/ask/client.js）', () => {
    expect(existsSync(ASK_CLIENT), ASK_CLIENT).toBe(true)
  })
  test('走完了全程（驱动没有报错）', () => {
    expect(parsed?.error, String(parsed?.error ?? '')).toBeUndefined()
  })
  test('右侧栏打开了，停在开始页', () => {
    expect(parsed?.opened, String(parsed?.opened)).toBe(true)
  })
  test('停用前：开始页五张卡（含旁问）', () => {
    expect(has(parsed?.initial?.cards, '旁问') && parsed?.initial?.cards?.length === 5, JSON.stringify(parsed?.initial?.cards)).toBe(true)
  })
  test('停用前：页签条只有开始页', () => {
    expect(JSON.stringify(parsed?.initial?.chips), JSON.stringify(parsed?.initial?.chips)).toBe(JSON.stringify(['开始']))
  })
  test('停用前：侧栏有「技能 / 插件」两颗整页入口', () => {
    expect(has(parsed?.initial?.nav, '插件') && has(parsed?.initial?.nav, '技能'), JSON.stringify(parsed?.initial?.nav)).toBe(true)
  })

  // ── 1. 旁问：卡 + 页签 + 命令面板动作 ---------------------------------------
  test('旁问：停用前有入口卡、点卡开出了页签', () => {
    expect(
      parsed?.ask?.openedTab === true && has(parsed?.ask?.cardsBefore, '旁问') && has(parsed?.ask?.chipsBefore, '旁问'),
      JSON.stringify({ cards: parsed?.ask?.cardsBefore, chips: parsed?.ask?.chipsBefore }),
    ).toBe(true)
  })
  test('旁问：插件中心那一行开关开着，扳完被页面卸掉', () => {
    expect(parsed?.ask?.toggle?.on === 'true' && parsed?.ask?.toggle?.gone === true, JSON.stringify(parsed?.ask?.toggle)).toBe(true)
  })
  test('旁问：停用后页签被清掉', () => {
    expect(none(parsed?.ask?.chipsAfter, '旁问'), JSON.stringify(parsed?.ask?.chipsAfter)).toBe(true)
  })
  test('旁问：停用后页签体不再渲染（不是空壳）', () => {
    expect(parsed?.ask?.bodyGone, String(parsed?.ask?.bodyGone)).toBe(true)
  })
  test('旁问：停用后开始页入口卡消失', () => {
    expect(none(parsed?.ask?.cardsAfter, '旁问'), JSON.stringify(parsed?.ask?.cardsAfter)).toBe(true)
  })
  test('旁问：停用后命令面板搜「旁问」没有动作', () => {
    expect(none(parsed?.ask?.palette?.rows, '旁问') && parsed?.ask?.palette?.empty === true, JSON.stringify(parsed?.ask?.palette)).toBe(true)
  })
  test('旁问：停用后其余四张卡还在（不是整块清空）', () => {
    expect(parsed?.ask?.cardsAfter?.length, JSON.stringify(parsed?.ask?.cardsAfter)).toBe(4)
  })

  // ── 2. 预览 + 文件：两个 kind 各自被清，且互不牵连 ---------------------------
  test('预览：停用前点文件树里的一个文件，开出了预览页签', () => {
    expect(
      typeof parsed?.preview?.label === 'string' && parsed.preview.label !== '' && has(parsed?.preview?.chipsBefore, parsed.preview.label),
      JSON.stringify(parsed?.preview),
    ).toBe(true)
  })
  test('预览：停用后预览页签消失、页签体不再渲染', () => {
    expect(
      none(parsed?.preview?.chipsAfter, parsed?.preview?.label ?? '\u0000') && parsed?.preview?.previewBodyGone === true,
      JSON.stringify({ chips: parsed?.preview?.chipsAfter, gone: parsed?.preview?.previewBodyGone }),
    ).toBe(true)
  })
  test('预览：停用后文件页签仍在（只清自己那一种 kind）', () => {
    expect(
      parsed?.preview?.filesStillThere === true && has(parsed?.preview?.chipsAfter, '文件'),
      JSON.stringify(parsed?.preview?.chipsAfter),
    ).toBe(true)
  })
  test('文件：停用前有文件页签与文件树', () => {
    expect(parsed?.files?.opened === true && has(parsed?.files?.chipsBefore, '文件'), JSON.stringify(parsed?.files?.chipsBefore)).toBe(true)
  })
  test('文件：停用后页签被清掉、文件树不再渲染', () => {
    expect(
      none(parsed?.files?.chipsAfter, '文件') && parsed?.files?.bodyGone === true,
      JSON.stringify({ chips: parsed?.files?.chipsAfter, gone: parsed?.files?.bodyGone }),
    ).toBe(true)
  })
  test('文件：停用后开始页的「工作区文件 / Git 管理」两张卡一起消失', () => {
    expect(
      none(parsed?.files?.cardsAfter, '工作区文件') && none(parsed?.files?.cardsAfter, 'Git'),
      JSON.stringify(parsed?.files?.cardsAfter),
    ).toBe(true)
  })

  // ── 3. 终端 ---------------------------------------------------------------
  test('终端：停用前有终端页签', () => {
    expect(parsed?.terminal?.opened === true && has(parsed?.terminal?.chipsBefore, '终端'), JSON.stringify(parsed?.terminal?.chipsBefore)).toBe(true)
  })
  test('终端：停用后页签与页签体都没了', () => {
    expect(
      none(parsed?.terminal?.chipsAfter, '终端') && parsed?.terminal?.bodyGone === true,
      JSON.stringify({ chips: parsed?.terminal?.chipsAfter, gone: parsed?.terminal?.bodyGone }),
    ).toBe(true)
  })

  // ── 4. 浏览器 -------------------------------------------------------------
  test('浏览器：停用前有浏览器页签', () => {
    expect(parsed?.browser?.opened === true && has(parsed?.browser?.chipsBefore, '浏览器'), JSON.stringify(parsed?.browser?.chipsBefore)).toBe(true)
  })
  test('浏览器：停用后页签与页签体都没了', () => {
    expect(
      none(parsed?.browser?.chipsAfter, '浏览器') && parsed?.browser?.bodyGone === true,
      JSON.stringify({ chips: parsed?.browser?.chipsAfter, gone: parsed?.browser?.bodyGone }),
    ).toBe(true)
  })

  // ── 5. 插件中心整页：侧栏那颗钮（死钮） ------------------------------------
  test('插件中心：停用前侧栏有「插件」入口', () => {
    expect(has(parsed?.plugins?.navBefore, '插件'), JSON.stringify(parsed?.plugins?.navBefore)).toBe(true)
  })
  test('插件中心：停用后侧栏那颗「插件」钮消失', () => {
    expect(none(parsed?.plugins?.navAfter, '插件'), JSON.stringify(parsed?.plugins?.navAfter)).toBe(true)
  })
  test('插件中心：停用后主区回到对话页（不是空白）', () => {
    expect(
      parsed?.plugins?.pageGone === true && parsed?.plugins?.chatBack === true && parsed?.plugins?.blank === false,
      JSON.stringify({ pageGone: parsed?.plugins?.pageGone, chatBack: parsed?.plugins?.chatBack, blank: parsed?.plugins?.blank }),
    ).toBe(true)
  })
  test('插件中心：那颗钮消失了，但「技能」还在', () => {
    expect(has(parsed?.plugins?.navAfter, '技能'), JSON.stringify(parsed?.plugins?.navAfter)).toBe(true)
  })

  // ── 6. 总闸：五个被停用的插件都不许在这四处留名字 ---------------------------
  test('总闸：停用后「页签条 / 开始页入口卡 / 命令面板 / 侧栏导航钮」四处都没有残留', () => {
    const disabled = [
      { name: '旁问', chips: parsed?.ask?.chipsAfter, cards: parsed?.ask?.cardsAfter, palette: parsed?.ask?.palette?.rows },
      { name: '预览', chips: parsed?.preview?.chipsAfter, cards: parsed?.files?.cardsAfter, palette: null as string[] | null },
      { name: '文件', chips: parsed?.files?.chipsAfter, cards: parsed?.files?.cardsAfter, palette: null as string[] | null },
      { name: '终端', chips: parsed?.terminal?.chipsAfter, cards: null as string[] | null, palette: null as string[] | null },
      { name: '浏览器', chips: parsed?.browser?.chipsAfter, cards: null as string[] | null, palette: null as string[] | null },
    ]
    const residue: string[] = []
    for (const item of disabled) {
      if (item.chips !== null && item.chips !== undefined && has(item.chips, item.name)) residue.push(`${item.name}：页签条`)
      if (item.cards !== null && item.cards !== undefined && has(item.cards, item.name)) residue.push(`${item.name}：开始页入口卡`)
      if (item.palette !== null && item.palette !== undefined && has(item.palette, item.name)) residue.push(`${item.name}：命令面板动作`)
    }
    if (has(parsed?.plugins?.navAfter, '插件')) residue.push('插件中心：侧栏导航钮')
    expect(residue, residue.join('、')).toEqual([])
  })

  test('全部停用后：开始页不再有入口卡（面板类插件全关的诚实状态）', () => {
    expect(Array.isArray(parsed?.final?.cards) && parsed?.final?.cards?.length === 0, JSON.stringify(parsed?.final?.cards)).toBe(true)
  })
  test('全部停用后：页签条只剩开始页', () => {
    expect(JSON.stringify(parsed?.final?.chips), JSON.stringify(parsed?.final?.chips)).toBe(JSON.stringify(['开始']))
  })
  test('全部停用后：侧栏只剩「技能」（插件钮已随插件消失）', () => {
    expect(JSON.stringify(parsed?.final?.nav), JSON.stringify(parsed?.final?.nav)).toBe(JSON.stringify(['技能']))
  })
  test('全程页面没有 error/warning', () => {
    expect(Array.isArray(parsed?.console) && parsed?.console?.length === 0, JSON.stringify(parsed?.console).slice(0, 500)).toBe(true)
  })

  test('停用前截图在', () => {
    expect(existsSync(shotBefore), shotBefore).toBe(true)
  })
  test('停用后截图在', () => {
    expect(existsSync(shotAfter), shotAfter).toBe(true)
  })
  test('命令面板截图在', () => {
    expect(existsSync(shotPalette), shotPalette).toBe(true)
  })
  test('全部停用后的截图在', () => {
    expect(existsSync(shotEnd), shotEnd).toBe(true)
  })
})
