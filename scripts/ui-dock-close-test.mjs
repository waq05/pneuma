/**
 * 右侧栏「收不收栏」的探针（2026-10-27 报障 + 2026-10-28 报障）。
 *
 * 10-27 现场：只开着「开始」一张页签时，点它旁边的 ✕ 没反应——closeTab 当时只补一张
 * 新 guide（id 换了、画出来一样），栏也不收。
 * 10-28 现场：「旁问」与「开始」两张页签都开着，关掉「旁问」，整块栏跟着收起。
 * 根因是修 10-27 时把口径定成了「整块栏只剩 guide 就收起」——它把旁边那张还开着的
 * 「开始」一起算了「没有真内容」。
 *
 * 这一条只压纯模型（ui-shell/src/ui-dockkit/dock-model.ts，零 React、零 DOM）：
 *   [1] 单格只剩 guide → 关掉就收起，guide 留着当下次展开的落地页；
 *   [2] 单格还有真内容 → 关一张照旧留栏（不能把用户正在看的终端一起收走）；
 *   [3] 「开始」+「旁问」，关掉「旁问」→ 栏留着，「开始」还在（10-28 报障本体）；
 *   [4] 分栏里清空一格、另一格还有门面 → 只补门面、不收起；
 *   [5] 负向自证：把「收起」那一条从模型里拿掉就必红（直接比 expanded）。
 *
 * 用法：node scripts/ui-dock-close-test.mjs
 *
 * @module dsc/scripts/ui-dock-close-test
 */
const model = await import(new URL('../ui-shell/src/ui-dockkit/dock-model.ts', import.meta.url).href)
const { defaultSurface, makeTab, closeTab, setExpanded, splitPane } = model

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) console.log('PASS  ' + label)
  else {
    failures += 1
    console.log('FAIL  ' + label + (extra === '' ? '' : ' — ' + extra))
  }
}

/** 往某一格里塞一张指定 kind 的页签并激活它。 */
const addTab = (surface, paneId, kind, patch = {}) => {
  const tab = { ...makeTab(kind), ...patch }
  return {
    ...surface,
    panes: surface.panes.map((entry) =>
      entry.id === paneId ? { ...entry, tabs: [...entry.tabs, tab], activeTabId: tab.id } : entry,
    ),
    _tab: tab,
  }
}

const kinds = (surface, paneIndex = 0) => surface.panes[paneIndex].tabs.map((tab) => tab.kind).join(',')

console.log('1. 单格只剩「开始」：关掉 = 收起侧栏')
{
  const surface = setExpanded(defaultSurface(), true)
  const guide = surface.panes[0].tabs[0]
  const closed = closeTab(surface, guide.id)
  check('关掉唯一的 guide 后侧栏收起', closed.expanded === false, JSON.stringify({ expanded: closed.expanded }))
  check('栏架子还在（一格）', closed.panes.length === 1, String(closed.panes.length))
  check('补的是一张新的「开始」门面', closed.panes[0].tabs.length === 1 && closed.panes[0].tabs[0].kind === 'guide', JSON.stringify(closed.panes[0].tabs))
  check('旧 guide 的 id 已经不在', closed.panes[0].tabs[0].id !== guide.id)
}

console.log('2. 单格还有真内容：关一张不收栏')
{
  let surface = setExpanded(defaultSurface(), true)
  const paneId = surface.panes[0].id
  surface = addTab(surface, paneId, 'terminal')
  const terminal = surface._tab
  surface = addTab(surface, paneId, 'browser')
  const browser = surface._tab
  const closed = closeTab(surface, browser.id)
  check('还有终端在，侧栏照旧展开', closed.expanded === true)
  check('终端还在、activate 到它', closed.panes[0].tabs.some((tab) => tab.id === terminal.id) && closed.panes[0].activeTabId === terminal.id)
  check('没有多塞一张 guide（原来那张还在，只一）', closed.panes[0].tabs.filter((tab) => tab.kind === 'guide').length === 1, JSON.stringify(closed.panes[0].tabs.map((t) => t.kind)))
}

console.log('3. 「开始」+「旁问」：关掉「旁问」，栏留着、开始页还在（10-28 报障）')
{
  let surface = setExpanded(defaultSurface(), true)
  const guide = surface.panes[0].tabs[0]
  surface = addTab(surface, surface.panes[0].id, 'ask')
  const ask = surface._tab
  check('关之前两张：开始 + 旁问', kinds(surface) === 'guide,ask', kinds(surface))
  const closed = closeTab(surface, ask.id)
  check('关掉「旁问」后侧栏仍展开', closed.expanded === true, JSON.stringify({ expanded: closed.expanded }))
  check('「开始」还在、且被激活', closed.panes[0].tabs.length === 1 && closed.panes[0].tabs[0].id === guide.id && closed.panes[0].activeTabId === guide.id, kinds(closed))
}

console.log('4. 分栏：清空一格、另一格只剩门面 → 只补门面、不收栏')
{
  let surface = setExpanded(defaultSurface(), true)
  const left = surface.panes[0].id
  surface = addTab(surface, left, 'terminal')
  const term = surface._tab
  surface = splitPane(surface, left) // 终端搬去右格，左格补 guide
  const right = surface.panes[1].id
  check('分栏成立（两格）', surface.panes.length === 2, String(surface.panes.length))
  const closed = closeTab(surface, term.id)
  check('栏还开着（另一格还有门面）', closed.expanded === true, JSON.stringify({ expanded: closed.expanded }))
  check('两格都还在', closed.panes.length === 2, String(closed.panes.length))
  check('清空的那格补 guide', closed.panes.some((pane) => pane.id === right && pane.tabs.length === 1 && pane.tabs[0].kind === 'guide'), JSON.stringify(closed.panes.map((p) => p.tabs.map((t) => t.kind))))
}

console.log('5. 负向自证：展开态没被误改成收起（真内容在）')
{
  let surface = setExpanded(defaultSurface(), true)
  const left = surface.panes[0].id
  surface = addTab(surface, left, 'terminal')
  const a = surface._tab
  surface = addTab(surface, left, 'files')
  const b = surface._tab
  const closed = closeTab(surface, a.id)
  check('关掉两张里的第一张，侧栏仍展开', closed.expanded === true)
  check('剩的那张还在且被激活', closed.panes[0].tabs.some((tab) => tab.id === b.id) && closed.panes[0].activeTabId === b.id)
}

console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
