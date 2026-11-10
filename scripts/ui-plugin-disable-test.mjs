/**
 * 「停用一个界面插件之后，界面上不许留残骸」的探针（2026-11-06 报障）。
 *
 * 现场：在插件中心停用「旁问（界面）」（`ui-ask`）之后，右侧栏「开始」页的旁问入口卡
 * 还在、已经开着的旁问页签还在。根因有两层，这一条分别压：
 *
 *   1. **入口卡与 chip 元数据硬编码在壳里**（`ui-dockkit/ui/dock.tsx` 的
 *      `GUIDE_ENTRIES` / `KIND_META`），插件在不在都照画；
 *   2. **页签报名没有生命周期**：`registerDockTab` 的撤销函数没人调，插件卸载后
 *      kind 元数据还挂在注册表里，页签体继续渲染已停用插件的组件。
 *
 * 四段：
 *   [1] 纯模型（真跑 `dock-model.ts`）：报名/撤销、入口卡列表、开页签的闸、撤销时清页签；
 *   [2] 真实产物（`lib/ui/plugins/ask/client.js`）：用受控 require 执行工厂，调它的
 *       `apply`，断言它真的报名了 ask + 入口卡，并在 cleanup 之后两份都不再有；
 *   [3] 接线（读源码）：dock 不再硬编码 ask；动作表与快捷键挂在会随插件卸载的槽组件上；
 *   [4] 宿主启停链路：停用内置界面单元会推新图（HMR 卸载这条），不是只改开关文件。
 *
 * 用法：pnpm run build && pnpm run build:ui && node scripts/ui-plugin-disable-test.mjs
 *
 * @module dsc/scripts/ui-plugin-disable-test
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const uiHalf = (id) => {
  for (const rel of ['src/packages/' + id + '/ui', 'src/packages/ui-' + id + '/ui']) {
    try {
      readdirSync(join(root, rel))
      return rel
    } catch {}
  }
  throw new Error('找不到界面半：' + id)
}

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log('  PASS  ' + name)
  else {
    failures += 1
    console.log('  FAIL  ' + name + (detail === '' ? '' : ' — ' + detail))
  }
}

const model = await import(new URL('../src/packages/ui-dockkit/ui/dock-model.ts', import.meta.url).href)
const { defaultSurface, dockGuideEntries, dockTabKinds, dockTabMeta, makeTab, openTab, registerDockTab, removeKindTabs } = model

/** 一张「刚报名」的 ask 元数据（与 ui-ask 真正交的那份同形；真产物在段 2 另测）。 */
const metaOf = (patch = {}) => ({
  kind: 'ask',
  label: '旁问',
  component: () => null,
  keepMounted: true,
  guide: { title: '旁问', description: '只读问答，不写主会话', tone: 'tone-ask', shortcut: 'Ctrl + Shift + K' },
  ...patch,
})

/** 往某一格里塞一张页签（与用户点开始页入口卡的结果同形）。 */
const withTab = (surface, kind) => {
  const pane = surface.panes[0]
  const tab = makeTab(kind)
  return {
    surface: {
      ...surface,
      panes: [{ ...pane, tabs: [...pane.tabs, tab], activeTabId: tab.id }],
    },
    tab,
  }
}
const kindsOf = (surface) => surface.panes.map((pane) => pane.tabs.map((tab) => tab.kind).join(',')).join(' | ')

console.log('[1] 纯模型：报名表决定「有没有这一种页签 / 这张入口卡」')
{
  // 基线：没人报名时，壳不该认识 ask（并且开不出这张页签）。
  check('基线：报名表里没有 ask', !dockTabKinds().some((meta) => meta.kind === 'ask'))
  check('基线：开始页入口卡列表里没有 ask', !dockGuideEntries().some((card) => card.tone === 'tone-ask'))
  const before = defaultSurface()
  check('基线：没报名的 kind 开不出页签（openTab 原样返回）', openTab(before, 'ask') === before)

  // 报名（= 插件 apply）→ 两份都出现，开得出页签。
  const off = registerDockTab(metaOf())
  check('报名后：可用页签类型里有 ask', dockTabKinds().some((meta) => meta.kind === 'ask'))
  const guide = dockGuideEntries().find((card) => card.tone === 'tone-ask')
  check('报名后：开始页入口卡里有 ask（文案与快捷键来自报名方）', guide !== undefined && guide.title === '旁问' && guide.shortcut === 'Ctrl + Shift + K')
  check('报名后：chip 元数据也来自报名方（label / keepMounted）', dockTabMeta('ask')?.label === '旁问' && dockTabMeta('ask')?.keepMounted === true)
  const opened = openTab(before, 'ask')
  check('报名后：openTab 开得出这张页签', opened !== before && opened.panes[0].tabs.some((tab) => tab.kind === 'ask'), kindsOf(opened))

  // 停用（= 插件卸载时调 cleanup）→ 两份都没了，再开就被拦。
  off()
  check('停用后：可用页签类型里没有 ask', !dockTabKinds().some((meta) => meta.kind === 'ask'))
  check('停用后：开始页入口卡列表里没有 ask', !dockGuideEntries().some((card) => card.tone === 'tone-ask'))
  check('停用后：再 openTab 被拦（不展开、不开壳）', openTab(opened, 'ask') === opened)
  check('停用后：页签体查不到元数据（壳画占位，不会继续渲染已停用的组件）', dockTabMeta('ask') === undefined)

  // 重装竞态（HMR）：旧的一份 cleanup 跑在新一份报名之后，不能把新的删掉。
  const first = registerDockTab(metaOf({ label: '旧' }))
  const second = registerDockTab(metaOf({ label: '新' }))
  first()
  check('热更换装：旧的 cleanup 不删新的那一份', dockTabMeta('ask')?.label === '新')
  second()
  check('热更换装：撤到零之后仍是「没有 ask」', dockTabMeta('ask') === undefined)
}

console.log('[2] 撤销同时清页签：不能留一张渲染不出内容的空壳')
{
  const off = registerDockTab(metaOf())
  // 现场形态：开始页 + 旁问两张页签，旁问是激活的那张。
  let { surface } = withTab(defaultSurface(), 'ask')
  const active = surface.panes[0].activeTabId
  const pruned = removeKindTabs(surface, 'ask')
  check('关掉旁问页签后只剩开始页', kindsOf(pruned) === 'guide', kindsOf(pruned))
  check('激活页签回到开始页', pruned.panes[0].tabs.some((tab) => tab.id === pruned.panes[0].activeTabId) && pruned.panes[0].activeTabId !== active)
  check('侧栏仍然展开（还有一张开始页，不该被顺手收起）', pruned.expanded === surface.expanded)

  // 一格只有旁问（入口卡把它换掉了那张）：撤掉要补一张开始页，并收起空栏。
  const only = {
    ...surface,
    panes: [{ ...surface.panes[0], tabs: surface.panes[0].tabs.filter((tab) => tab.kind === 'ask'), activeTabId: active }],
    expanded: true,
  }
  const emptied = removeKindTabs(only, 'ask')
  check('整格只有旁问：撤掉后补一张开始页', kindsOf(emptied) === 'guide', kindsOf(emptied))
  check('整格只有旁问：撤掉后栏不收起（停在开始页，方便接着开别的）', emptied.expanded === true)

  // 分栏两格各一张旁问：两格都补开始页，不能把另一格留空。
  const split = {
    ...surface,
    panes: [
      { id: 'p1', tabs: [makeTab('guide'), makeTab('ask')], activeTabId: '' },
      { id: 'p2', tabs: [makeTab('ask'), makeTab('terminal')], activeTabId: '' },
    ],
    activePaneId: 'p1',
    expanded: true,
  }
  const fixed = {
    ...split,
    panes: split.panes.map((pane) => ({ ...pane, activeTabId: pane.tabs[pane.tabs.length - 1].id })),
  }
  const afterSplit = removeKindTabs(fixed, 'ask')
  check('分栏：两格的旁问都撤掉，且都还有内容', afterSplit.panes.every((pane) => pane.tabs.length > 0) && kindsOf(afterSplit) === 'guide | terminal', kindsOf(afterSplit))
  off()
}

console.log('[3] 真实产物：ask 的 client.js 报名了页签与入口卡，cleanup 之后一起消失')
{
  const bundle = join(root, 'lib', 'ui', 'plugins', 'ask', 'client.js')
  if (!existsSync(bundle)) {
    console.log('  SKIP  产物不在（先跑 pnpm run build:ui）：' + bundle)
  } else {
    // 受控 require：插件只拿平台种子里的那几样。这里把 @dsc/ui 的 registerDockTab
    // 接到**真的**报名表上，于是「产物调的」与「壳读的」是同一份。
    const captured = []
    const stub = (spec) => {
      if (spec === 'react' || spec === 'react-dom') return new Proxy({}, { get: () => () => null })
      if (spec === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: {} }
      if (spec === '@dsc/ui-primitives') return new Proxy({}, { get: () => () => null })
      if (spec === '@dsc/ui') {
        return new Proxy(
          {
            createT: () => (key) => key,
            defineUiPlugin: (module) => module,
            registerDockTab: (meta) => {
              captured.push(meta)
              return registerDockTab(meta)
            },
          },
          { get: (target, prop) => (prop in target ? target[prop] : () => null) },
        )
      }
      throw new Error('测试桩不认识的模块：' + spec)
    }
    globalThis.__DSC_UI_FACTORIES__ = {}
    // eslint-disable-next-line no-new-func
    new Function(readFileSync(bundle, 'utf8'))()
    const factory = globalThis.__DSC_UI_FACTORIES__['ask']
    check('产物注册了 ask 工厂', typeof factory === 'function')
    const module_ = { exports: {} }
    factory(stub, module_, module_.exports)
    const plugin = module_.exports.default ?? module_.exports
    check('产物导出 apply', typeof plugin.apply === 'function')

    const slots = []
    const ui = {
      id: 'ask',
      slots: {
        register: (slot, options) => {
          slots.push({ slot, id: options.id })
          return () => undefined
        },
      },
      host: {},
      runtime: {},
      provide: () => undefined,
      consume: () => undefined,
    }
    const cleanup = plugin.apply(ui)
    const meta = captured.find((item) => item.kind === 'ask')
    check('产物报名了 ask 页签（label / keepMounted）', meta !== undefined && meta.label === 'ask.tab.label' && meta.keepMounted === true, JSON.stringify(meta?.label))
    check('产物一并交了开始页入口卡（标题 / 说明 / 色调 / 快捷键）',
      meta?.guide?.tone === 'tone-ask' && meta?.guide?.shortcut === 'Ctrl + Shift + K' && meta?.guide?.title === 'ask.tab.label' && meta?.guide?.description === 'ask.guide.desc',
      JSON.stringify(meta?.guide))
    check('产物把浮钮 / 快捷键 / 动作表挂在 shell.header（卸载即走的槽）', slots.some((item) => item.slot === 'shell.header'))
    check('apply 交回撤销函数（页签报名有生命周期）', typeof cleanup === 'function')
    check('装上之后报名表里有 ask', dockTabMeta('ask') !== undefined)
    if (typeof cleanup === 'function') cleanup()
    check('cleanup 之后报名表里没有 ask', dockTabMeta('ask') === undefined)
    check('cleanup 之后开始页入口卡里没有 ask', !dockGuideEntries().some((card) => card.tone === 'tone-ask'))
  }
}

console.log('[4] 接线：dock 不再硬编码 ask；入口都挂在会随插件卸载的地方')
{
  const dock = read('src/packages/ui-dockkit/ui/dock.tsx')
  const dockModel = read('src/packages/ui-dockkit/ui/dock-model.ts')
  const dockState = read('src/packages/ui-dockkit/ui/dock-state.ts')
  const ask = read(uiHalf('ask') + '/ui.tsx')
  const state = read(uiHalf('ask') + '/store.ts')
  const palette = read(uiHalf('palette') + '/ui.tsx')

  check('dock.tsx 里没有 ask 字面量（标题 / 图标 / 入口卡都由报名表给）', !dock.includes("'ask'"))
  check('dock.tsx 不再有 KIND_META / GUIDE_ENTRIES 两张硬编码表', !/const KIND_META/.test(dock) && !/const GUIDE_ENTRIES/.test(dock))
  check('dock.tsx 的 chip 与入口卡都读报名表', dock.includes('dockTabMeta(') && dock.includes('useDockGuideEntries()'))
  check('guide 自己也走报名（页签体没有按 kind 的分叉）', /registerDockTab\(\{[\s\S]{0,160}?kind: 'guide'/.test(dock) && !/tab\.kind === 'guide'/.test(dock))
  check('dock-model 的 openTab 挡住没报名的 kind', /kind !== 'guide' && dockTabMeta\(kind\) === undefined/.test(dockModel))
  check('dock-state 在撤销报名时清掉已开页签并落盘', dockState.includes('subscribeDockKinds(') && dockState.includes('pruneDockKind(') && dockState.includes('saveSurfaces(surfaces)'))
  check('dock-state 的开页签入口都先问报名表', ['preview', 'patch', 'browser', 'subagent', 'work-output'].every((kind) => dockState.includes("hasDockKind('" + kind + "')")))

  // 入口卡与两条动作：卡在 apply 里报名；动作与快捷键挂在 header 槽组件（卸载即走）。
  check('ask 在 apply 里报名页签 + 入口卡', /const offTab = registerDockTab\(\{/.test(ask) && /guide: \{/.test(ask))
  check('ask 的 apply 交回页签报名的撤销函数', /return offTab/.test(ask))
  // `\s*`：这条登记在 2026-11-10 加 `children`（选区浮层那条槽）之后被拆成了多行，
  // 断言要钉的是「挂在 shell.header 上」这件事，不是它在源码里占几行。
  check('浮钮 / 快捷键 / 动作表挂在 shell.header', /ui\.slots\.register\(\s*'shell\.header'/.test(ask))
  check('两条命令面板动作只在槽组件里登记（apply 里没有）', /id: 'ask\.open'/.test(ask) && /id: 'ask\.selection'/.test(ask) && !/ui\.slots[\s\S]{0,200}id: 'ask\.open'/.test(ask))
  check('动作表的 effect 交回注销函数（组件卸载即从面板消失）', /return actions\.register\('ask', \[/.test(ask))
  check('Ctrl+Shift+K 的监听在同一个组件的 effect 里（卸载即摘）', /window\.addEventListener\('keydown', onKey\)[\s\S]{0,120}?removeEventListener\('keydown', onKey\)/.test(ask))
  check('命令面板不硬编码 ask 动作（只读动作表）', !palette.includes("'ask'"))
  check('store 的旁问状态在插件重装后才重建（不是壳的常驻状态）', ask.includes('subscribeAsk') && state.includes('export function subscribeAsk('))

  // 文案：入口卡的说明两句都在（中英各一份，缺一条 locale 闸会红）。
  const zh = JSON.parse(read('src/packages/ui-ask/locale/ui.zh.json'))
  const en = JSON.parse(read('src/packages/ui-ask/locale/ui.en.json'))
  check('入口卡文案中英都有', typeof zh['ask.guide.desc'] === 'string' && typeof en['ask.guide.desc'] === 'string')
  check('壳的字典里不再有旁问的键（文案归插件）', !read('src/packages/ui-dockkit/locale/ui.zh.json').includes('dockkit.guide.ask') && !read('src/packages/ui-dockkit/locale/ui.zh.json').includes('dockkit.kind.ask'))
}

console.log('[5] 宿主启停链路：停用内置界面单元真的会卸载页面里那一条')
{
  const runtime = read('src/packages/runtime/index.ts')
  const hmr = read('src/packages/ui-boot/ui/hmr.ts')
  const boot = read('src/packages/ui-boot/ui/boot.ts')
  const bundles = read('src/core/ui-bundles.ts')

  check('停用内置界面单元后推「图变了」', /ctx\.emit\('dsc\/ui-plugins-changed', \{ file, enabled \}\)/.test(runtime))
  check('产物表按开关把停用的单元滤出启动图', /readEnabledPlugins\(this\.entries\.map\(\(entry\) => builtinSwitchKey\(entry\.id\)\)\)/.test(bundles))
  check('页面按新图卸载「不在图里」的插件', /if \(plugin\.state !== 'loaded' \|\| targetIds\.has\(id\)\) continue/.test(hmr) && /options\.session\.uninstall\(id\)/.test(hmr))
  check('卸载走 cordis 纤维（插件注册的 effect 一起回收）', /dispose = \(\) => \{[\s\S]{0,80}?cordis\.unmount\(entry\.id\)/.test(boot))
}

console.log('[6] 总闸：任何界面插件的 apply 都要把页签报名交回装载器')
{
  // 这一条是这类 bug（停用插件后界面留残骸）的长期闸门，判据落在**真实产物**上：
  // 把每份 client.js 的工厂跑起来、调它的 apply，只要它报名了页签，就必须交回一个
  // 撤销函数；调用之后报名表里不许再有它报过的那些 kind。
  //
  // 为什么不做文本断言：`apply` 里多写一个 `return` 与少写一个在源码里长得差不多，
  // 只有真跑一遍才知道「插件卸载时壳到底能不能把这一种页签忘掉」。
  const builtDir = join(root, 'lib', 'ui', 'plugins')
  const bundles = existsSync(builtDir)
    ? readdirSync(builtDir)
        .filter((name) => existsSync(join(builtDir, name, 'client.js')))
        .filter((name) => readFileSync(join(builtDir, name, 'client.js'), 'utf8').includes('registerDockTab('))
        .sort()
    : []
  check('产物里至少有 ask / files / preview / status / team / browser / terminal 这几种会报名页签的插件', bundles.length >= 7, bundles.join(','))

  /** 最小的模块级信号：ask 的 store 与 files 的 tree-store 在模块顶层就会建一份。 */
  const createSignal = (initial) => {
    let value = initial
    const listeners = new Set()
    return {
      get: () => value,
      set: (next) => {
        if (Object.is(next, value)) return
        value = next
        for (const listener of [...listeners]) listener()
      },
      notify: () => {
        for (const listener of [...listeners]) listener()
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
  }

  /** 受控 require：@dsc/ui 交**真的**报名表，其余给能跑通模块顶层的桩。 */
  const stubFor = (captured) => (spec) => {
    if (spec === 'react' || spec === 'react-dom' || spec === 'react-dom/client') {
      return new Proxy({}, { get: () => () => null })
    }
    if (spec === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: {} }
    if (spec === '@dsc/ui') {
      return new Proxy(
        {
          ACTIONS_SERVICE: 'actions',
          createT: () => (key) => key,
          createSignal,
          defineUiPlugin: (module) => module,
          registerDockTab: (meta) => {
            captured.push(meta)
            return registerDockTab(meta)
          },
          // 文件链接的落地函数：预览插件在 apply 里登记它，并且**存下它交回的注销函数**，
          // 撤销时再调一次。真实壳里这条经 `@dsc/ui` 整包转出（实现在 `@dsc/ui-primitives`
          // 的 markdown 那条），交回的是一枚函数；桩这里漏了它的话，兜底那条「怎么取都能
          // 调用」返回 null，插件撤销时就报 `offFileLink is not a function`——那是桩不齐，
          // 不是插件没交撤销（下面的断言要测的正是「交没交」）。
          registerFileLinkOpener: () => () => undefined,
          // 浏览器插件在 apply 里就订阅原生事件：桥缺席时给一份「不可用」的桩，
          // 与浏览器里跑真实壳时的形状一致（available=false，on 返回退订函数）。
          getHostNative: () => ({ available: false, on: () => () => undefined, invoke: async () => null }),
        },
        { get: (target, prop) => (prop in target ? target[prop] : () => null) },
      )
    }
    // 其余种子包（基元、槽位、dockkit、runtime、xterm…）在 apply 期只当值被引用，
    // 组件渲染才真正用到；给一层「怎么取都能调用」的桩就够跑 apply 了。
    return new Proxy({}, { get: () => () => null })
  }

  /**
   * 审计一份产物：跑 apply → 看它报了什么 kind → 看它有没有交回撤销 → 撤销后是否清零。
   * @returns {{ kinds: string[], cleanup: unknown, problems: string[] }}
   */
  const audit = (id, source) => {
    const captured = []
    const problems = []
    let cleanup
    try {
      globalThis.__DSC_UI_FACTORIES__ = {}
      // eslint-disable-next-line no-new-func
      new Function(source)()
      const factory = globalThis.__DSC_UI_FACTORIES__[id]
      if (typeof factory !== 'function') return { kinds: [], cleanup, problems: [id + '：产物没注册工厂'] }
      const module_ = { exports: {} }
      factory(stubFor(captured), module_, module_.exports)
      const plugin = module_.exports.default ?? module_.exports
      if (typeof plugin?.apply !== 'function') return { kinds: [], cleanup, problems: [id + '：没导出 apply'] }
      const ui = {
        id,
        slots: { register: () => () => undefined },
        host: {},
        runtime: {},
        provide: () => undefined,
        consume: () => undefined,
      }
      cleanup = plugin.apply(ui)
      const kinds = captured.map((meta) => meta.kind)
      if (kinds.length === 0) return { kinds, cleanup, problems }
      if (typeof cleanup !== 'function') {
        problems.push(id + '：报名了 ' + kinds.join('/') + ' 却没有交回撤销函数')
        return { kinds, cleanup, problems }
      }
      cleanup()
      for (const kind of kinds) {
        if (dockTabMeta(kind) !== undefined) problems.push(id + '：撤销之后 ' + kind + ' 还留在报名表里')
      }
    } catch (error) {
      problems.push(id + '：跑 apply 时抛错（' + (error instanceof Error ? error.message : String(error)) + '）')
    }
    return { kinds: captured.map((meta) => meta.kind), cleanup, problems }
  }

  const problems = []
  let checked = 0
  let kindCount = 0
  for (const id of bundles) {
    const result = audit(id, readFileSync(join(builtDir, id, 'client.js'), 'utf8'))
    if (result.kinds.length === 0 && result.problems.length === 0) continue
    if (result.kinds.length > 0) {
      checked += 1
      kindCount += result.kinds.length
    }
    problems.push(...result.problems)
  }
  check('跑到了足够多的插件（≥7）', checked >= 7, String(checked))
  check('共覆盖到 9 种页签 kind（文件/Git/预览/补丁/终端/浏览器/输出/子智能体/旁问）', kindCount >= 9, String(kindCount))
  check('每个报名页签的插件都把撤销交回来了', problems.length === 0, problems.join('；'))

  // 负向自证：伪造一份「报名了却不交撤销」的产物，审计必须抓得到（这条闸门不是空转的）。
  const rotten = `(globalThis.__DSC_UI_FACTORIES__ ??= {})["rotten"] = function (require, module, exports) {
    const ui = require("@dsc/ui")
    exports.default = ui.defineUiPlugin({ apply() { ui.registerDockTab({ kind: "rotten", label: "x", component: () => null }) } })
  }`
  const bad = audit('rotten', rotten)
  check('负向自证：漏交撤销的产物会被这条闸门抓住', bad.problems.some((line) => line.includes('没有交回撤销函数')), JSON.stringify(bad.problems))
}

console.log(failures === 0 ? '\n全部通过' : '\n' + String(failures) + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
