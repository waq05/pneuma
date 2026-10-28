/**
 * 临时工具（gitignored）：把这次手机档改动**逐条反做**，得到「改前」源码，用来量改前几何做对照。
 * 用法：node desktop/shots/_mobile-before.mjs revert   # 反做到「改前」（先备份）
 *       node desktop/shots/_mobile-before.mjs restore  # 从备份恢复
 * 每条反做都要求**命中**（找不到就抛错），避免静默留半截。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const root = 'D:/dsc/'
const BACKUP = root + 'desktop/shots/_before-backup/'
const NL = '\r\n'
const FILES = [
  'ui-shell/src/ui-layout/app.tsx',
  'ui-shell/src/styles.css',
  'ui-shell/src/legacy/views.css',
  'ui-shell/src/plugins/composer/ui.tsx',
]

const j = (...lines) => lines.join(NL)
const mode = process.argv[2]

if (mode === 'restore') {
  for (const file of FILES) {
    copyFileSync(BACKUP + file.replace(/\//g, '__'), root + file)
  }
  console.log('已从备份恢复 4 个文件')
  process.exit(0)
}

mkdirSync(BACKUP, { recursive: true })
for (const file of FILES) copyFileSync(root + file, BACKUP + file.replace(/\//g, '__'))

/** 反做：把 from 换回 to。 */
const apply = (file, from, to) => {
  const path = root + file
  const text = readFileSync(path, 'utf8')
  if (!text.includes(from)) throw new Error(`反做没命中：${file} <- ${JSON.stringify(from.slice(0, 70))}`)
  writeFileSync(path, text.replace(from, to))
}

const A = 'ui-shell/src/ui-layout/app.tsx'
const S = 'ui-shell/src/styles.css'
const V = 'ui-shell/src/legacy/views.css'
const U = 'ui-shell/src/plugins/composer/ui.tsx'

// ── app.tsx ──────────────────────────────────────────────────────────────────
apply(A, j('  IconBolt,', '  IconChevronLeft,', '  IconChevronRight,'), j('  IconBolt,', '  IconChevronRight,'))

apply(
  A,
  j(
    '',
    '/**',
    ' * 窄屏（手机档）的断点——与 `styles.css` 窄屏段那个数**必须是同一个**。',
    ' *',
    ' * 桌面窗口最小宽 960（`desktop/electron/main/index.ts` 的 `minWidth`），永远碰不到这一档；',
    ' * 手机远程页伺服的是同一份壳产物，靠视口宽区分，没有 UA、没有宿主标志。',
    ' */',
    "const NARROW_QUERY = '(max-width: 860px)'",
    '',
    '/**',
    ' * 当下是不是窄屏。',
    ' *',
    ' * 为什么不进 hook：`narrow` 的 state **首帧**就要有值（手机上收起态整条侧栏不画，',
    ' * 晚一帧会先闪出一条 56px 窄栏再收掉），所以初始化时直接量一次。',
    ' */',
    'function isNarrowViewport(): boolean {',
    '  return (',
    "    typeof window !== 'undefined' &&",
    "    typeof window.matchMedia === 'function' &&",
    '    window.matchMedia(NARROW_QUERY).matches',
    '  )',
    '}',
    '',
  ),
  '',
)

apply(
  A,
  j(
    '  // 窄屏（手机档）**首帧**就要知道：收起态在手机上整条侧栏都不画（导航改挂顶栏右上角），',
    '  // 晚一帧会先闪出一条 56px 窄栏再收掉。所以初值就地量一次，不进 effect。',
    '  const [narrow, setNarrow] = useState<boolean>(() => isNarrowViewport())',
    '  // 手机上「侧栏收起」是常态（浏览器里没有 Ctrl+B，也没有桌面那种可拖宽的行内侧栏）：',
    '  // 存档里那份多半是桌面留下的 false，这里按窄屏兜一下，免得首帧先画一层抽屉再收。',
    '  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(',
    '    () => readStoredFlag(PANEL_KEYS.sidebarCollapsed) || isNarrowViewport(),',
    '  )',
  ),
  j('  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>', '    readStoredFlag(PANEL_KEYS.sidebarCollapsed),', '  )'),
)

apply(
  A,
  j(
    '  // 只在**跨进窄屏**那一刻收一次：收不收的决定权随后仍在用户手里（Ctrl+B / 窄栏 logo）。',
    '  //',
    '  // 这一档同时喂给 `narrow`：手机上收起态整条侧栏不画、导航（会话/插件）改挂顶栏右上角、',
    '  // 正文页签行也换一副（render 里三处 `narrow` 分支都读它）。',
    '  useEffect(() => {',
    '    const query = window.matchMedia(NARROW_QUERY)',
    '    const apply = (): void => {',
    '      setNarrow(query.matches)',
    '      if (query.matches) setSidebarCollapsed(true)',
  ),
  j(
    '  // 只在**跨进窄屏**那一刻收一次：收不收的决定权随后仍在用户手里（Ctrl+B / 窄栏 logo）。',
    '  useEffect(() => {',
    "    const query = window.matchMedia('(max-width: 860px)')",
    '    const apply = (): void => {',
    '      if (query.matches) setSidebarCollapsed(true)',
  ),
)

apply(
  A,
  j(
    '          {/* 收起态：56px 图标窄栏（旧界面的 rail 分支），壳替插件画导航。',
    "              手机档整条侧栏都不给（CSS 那条 `.app[data-rail='1'] > .sidebar`），窄栏也就不必",
    '              画；导航的两颗（会话 / 插件）这时挂在顶栏右上角（见下面的 topbar-nav 那组）。 */}',
    '          {sidebarCollapsed && !narrow ? <SidebarRail onExpand={toggleSidebar} /> : null}',
  ),
  j(
    '          {/* 收起态：56px 图标窄栏（旧界面的 rail 分支），壳替插件画导航。 */}',
    '          {sidebarCollapsed ? <SidebarRail onExpand={toggleSidebar} /> : null}',
  ),
)

apply(
  A,
  j(
    '        {/* 手机档拉出抽屉时垫在下面的一层：点它收回。桌面档不渲染（侧栏是行内的，点哪儿',
    '            都不该把它收掉）。z-index 由 CSS 给（39，侧栏是 40）——所以它压得住正文，',
    '            压不住侧栏本身。 */}',
    '        {narrow && !sidebarCollapsed ? (',
    '          <div className="sidebar-scrim" onClick={toggleSidebar} aria-hidden="true" />',
    '        ) : null}',
    '',
  ),
  '',
)

apply(
  A,
  j(
    '                  {/* 右簇：工作区打开组（在资源管理器打开 + 更多打开方式）。手机档由 CSS 藏掉',
    '                      （没有原生桥，点了只会报「这条能力来自桌面外壳」）。 */}',
    '                  <SlotOutlet slots={slots} slot={SLOT.header} />',
    '                  {/* 手机档的导航（原窄栏那六颗里留下的两颗）：会话＝拉出侧栏抽屉',
    '                      （会话列表/搜索/新建会话都在里面，原来只能靠展开侧栏才看得到），',
    '                      插件＝插件中心整页。其余四颗（展开、新会话、技能、工作目录、设置）',
    '                      手机上都不给：抽屉一拉就有，设置入口则按 2026-10-15 的决定整去掉。 */}',
    '                  {narrow ? (',
    '                    <>',
    '                      <button',
    '                        type="button"',
    "                        className={`icon-btn topbar-nav-btn${page === 'plugins' ? ' on' : ''}`}",
    '                        data-tip="插件"',
    '                        aria-label="插件"',
    "                        aria-pressed={page === 'plugins'}",
    '                        onClick={() => {',
    "                          setShellPage(page === 'plugins' ? null : 'plugins')",
    '                        }}',
    '                      >',
    '                        <IconPuzzle size={16} />',
    '                      </button>',
    '                      <button',
    '                        type="button"',
    '                        className="icon-btn topbar-nav-btn"',
    '                        data-tip="会话"',
    '                        aria-label="会话"',
    '                        onClick={toggleSidebar}',
    '                      >',
    '                        <IconSidebar size={16} />',
    '                      </button>',
    '                    </>',
    '                  ) : null}',
  ),
  j(
    '                  {/* 右簇：工作区打开组（在资源管理器打开 + 更多打开方式） */}',
    '                  <SlotOutlet slots={slots} slot={SLOT.header} />',
  ),
)

apply(
  A,
  j(
    '                {/* 对话 / 轨迹页签（旧界面顶栏第二行同款）：两张脸共用正文位，',
    '                    页签是显式入口——另一个入口是会话右键菜单的「查看轨迹」。',
    '                    手机档不给这两颗页签（那 36px 让给正文），但轨迹页还有三个入口',
    '                    （会话右键菜单、工具卡的「在轨迹中查看」药丸两处），切过去得有回头路：',
    '                    这时那一行只画一颗「← 对话」。 */}',
    '                {narrow ? (',
    "                  threadView === 'trace' ? (",
    '                    <nav className="tabs" aria-label="正文区视图">',
    '                      <button',
    '                        type="button"',
    '                        onClick={() => {',
    "                          setThreadView('chat')",
    '                        }}',
    '                      >',
    '                        <IconChevronLeft size={14} />',
    '                        对话',
    '                      </button>',
    '                    </nav>',
    '                  ) : null',
    '                ) : (',
  ),
  j(
    '                {/* 对话 / 轨迹页签（旧界面顶栏第二行同款）：两张脸共用正文位，',
    '                    页签是显式入口——另一个入口是会话右键菜单的「查看轨迹」。 */}',
  ),
)

apply(
  A,
  j(
    '                      轨迹',
    '                    </button>',
    '                  </nav>',
    '                )}',
  ),
  j('                      轨迹', '                    </button>', '                  </nav>'),
)

// ── styles.css ───────────────────────────────────────────────────────────────
apply(
  S,
  j(
    '  /* 输入**文字区**最小高 40（ZCode 的可编辑区 `min-h-10`）：旧值只有一行行高 18 +',
    '     上下内距 = 30px，一行字贴着边，点内边距那圈等于没点到（2026-10-15 报障：',
    '     手机上点输入框老是点空、顺手摸到旁边的按钮）。手机上再放宽到 44（见 560 档）。 */',
    '  --dsc-input-box-h: 40px;',
  ),
  '',
)

apply(
  S,
  j(
    '',
    '/* 页签行里带图标的那颗（手机档的「← 对话」返回钮，legacy 那两颗是纯文字、不吃这条）：',
    '   图标与文字之间给一点气口，否则 14px 的箭头会贴着第一个字。 */',
    '.topbar .tabs button {',
    '  gap: 6px;',
    '}',
  ),
  '',
)

apply(
  S,
  j(
    '   - 侧栏展开态变成浮层（盖在正文上）：390px 宽的屏幕上，行内的 300px 侧栏会把',
    '     对话挤到不可读；**收起态整条侧栏也不给**（2026-10-15 起）——原来那 56px 窄栏上的',
    '     六颗导航（展开 / 新会话 / 技能 / 插件 / 工作目录 / 设置）改成顶栏右上角两颗',
    '     （会话 = 拉出这条浮层、插件），窄栏与它的按钮在手机上一起退役；',
  ),
  j(
    '   - 侧栏展开态变成浮层（盖在正文上）：390px 宽的屏幕上，行内的 300px 侧栏会把',
    '     对话挤到不可读；收起态仍是行内的 56px 窄栏（壳画的导航还在）；',
  ),
)

apply(
  S,
  j(
    '  /* 手机上收起态整条侧栏不占位：正文直接拿全宽，顶上也没有那条 56px 竖栏。',
    '     用 display 而不是不渲染——插件画的会话列表留在 DOM 里，拉出抽屉时状态（搜索词、',
    '     分组展开）不丢；窄栏按钮那边则由壳复用同一份 narrow 判定不渲染（见 app.tsx）。 */',
    "  .app[data-rail='1'] > .sidebar {",
    '    display: none;',
    '  }',
    '  /* 拉出抽屉时垫在正文上的一层：点它收回。四方向写死不用 `inset` 简写——',
    '     简写要进文件末尾那条老内核兜底的清单（`@supports not (inset: 0)` 点了五张遮罩），',
    '     这里避开就少一个要同步的门。 */',
    '  .sidebar-scrim {',
    '    position: absolute;',
    '    top: 0;',
    '    right: 0;',
    '    bottom: 0;',
    '    left: 0;',
    '    z-index: 39;',
    '  }',
  ),
  '',
)

apply(
  S,
  j(
    '  /* 这个组调的是宿主原生桥（openWorkspace）：在文件管理器 / 终端 / VS Code 里打开、',
    '     复制工作区路径。手机浏览器里没有原生桥，点了只会弹一句「这条能力来自桌面外壳的原生桥」——',
    '     顶栏右上角的位置要留给会话与插件两颗，这一组整块收掉（2026-10-15 报障）。 */',
    '  .ws-open {',
    '    display: none;',
    '  }',
    '  /* 抽屉页脚那颗「设置」也不给：手机上的设置页版式是崩的（两栏挤成一栏、正文竖排一个字',
    '     一行，2026-10-15 截图），既然不给入口就别留这一颗。上面那行「今日总用量」是只读读数，',
    '     留着。 */',
    '  .sidebar-footer .row-btn {',
    '    display: none;',
    '  }',
  ),
  '',
)

apply(
  S,
  j(
    '/* 输入行落成**两行**。390px 实测：`+ 权限档 模式档` + 模型 + 发送五颗挤在 286px 里，',
    '   左组被压到 154px 宽、chip 里的字竖着排（「自定义」一个字一行），整行还溢出 10px。',
    '   第一版靠 `flex-wrap` 自己撞出两行（右组一整个被顶到第二行、还被 `margin-left: auto`',
    '   推到右缘，跟第一行对不齐）；2026-10-15 报障后改成**显式两行**：',
    '   第一行 = `+ 权限 模式`，第二行 = `模型 档位 … 发送`（发送贴本行右缘，拇指位）。',
    '   两行都收矮：底栏内距 2/8 → 2/6、行距 6 → 4、发送键 34 → 32（`--dsc-send`），',
    '   合计 ≈78px → ≈70px。文字区同时放宽到 44px（`--dsc-input-box-h`）。 */',
  ),
  j(
    '/* 输入行改成两行。390px 实测：`+ 权限档 模式档` + 模型 + 发送五颗挤在 286px 里，',
    '   左组被压到 154px 宽、chip 里的字竖着排（「自定义」一个字一行），整行还溢出 10px。',
    '   现在左组一行、右组换行贴右，两侧都 min-width:0，挤到极限时裁字而不是换行。 */',
  ),
)

apply(
  S,
  j(
    '  /* 手机上这张卡片里两个高度值各动一点：文字区 40 → 44（点得中）、发送键 34 → 32',
    '     （跟第一行那排 28 高的 chip 挨得更近，两行看着一样高）。 */',
    '  .composer {',
    '    --dsc-input-box-h: 44px;',
    '    --dsc-send: 32px;',
    '  }',
    '  .composer-bar {',
    '    /* gap 从 12 收到 8（原本单列在「composer 工具行」那一节，挪进来一起看）。 */',
    '    gap: 8px;',
    '    flex-wrap: wrap;',
    '    padding: 2px 8px 6px;',
    '    row-gap: 4px;',
    '  }',
    '  /* 右组整行占第二行（`flex-basis: 100%` 把它钉在下一行，不再靠「挤不挤得下」撞运气），',
    '     组内 `margin-left: auto` 一并去掉——贴左对齐第一行那颗 `+`。 */',
    '  .composer-bar .bar-right {',
    '    flex: 1 1 100%;',
    '    margin-left: 0;',
    '  }',
    '  /* 发送键推到第二行右缘：它原来在组尾、跟两颗 chip 挨着，换行后落在两行之间的缝里',
    '     （截图里那颗钮看着比两行都高半头就是这么来的）。 */',
    '  .composer-bar .send-btn {',
    '    margin-left: auto;',
    '  }',
  ),
  j(
    '  .composer-bar {',
    '    /* gap 从 12 收到 8（原本单列在「composer 工具行」那一节，挪进来一起看）。 */',
    '    gap: 8px;',
    '    flex-wrap: wrap;',
    '    row-gap: 6px;',
    '  }',
  ),
)

// ── views.css ────────────────────────────────────────────────────────────────
apply(
  V,
  j(
    '  /* 文字区最小高（壳里 `--dsc-input-box-h`：桌面 40、手机 44，ZCode 的 min-h-10 同款）。',
    '     只有一行字时它把框撑到点得中的高度——自动增高那条（ui.tsx 里量 scrollHeight 写',
    '     行内 height）不受影响：内容矮时行内高度更小，min-height 兜住；内容长过它才长个儿。 */',
    '  min-height: var(--dsc-input-box-h, 40px);',
  ),
  '',
)

// ── composer ui.tsx ──────────────────────────────────────────────────────────
apply(
  U,
  j(
    '        // 点框内那圈内边距、或输入区与底栏之间的缝，也算「点输入框」：文字区上面那条',
    '        // 10px 内边距原来点了什么都不发生，手指会再往旁边那颗钮上摸一次——手机上这就是',
    '        // 误触的来源（2026-10-15 报障）。命中按钮与浮层时不动：它们自己管自己，',
    '        // 抢焦点会把刚点开的菜单收掉。文字区本身不用管（原生就聚焦）。',
    '        onClick={(event) => {',
    '          const target = event.target as HTMLElement | null',
    "          if (target !== null && target.closest('button, textarea, input, .model-pop, .pop-mask') !== null) return",
    '          area.current?.focus()',
    '        }}',
  ),
  '',
)

console.log('已反做：4 个文件回到「改前」')
console.log(execFileSync('git', ['diff', '--stat', '--', ...FILES], { cwd: root, encoding: 'utf8' }))
