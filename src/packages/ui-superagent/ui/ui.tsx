/**
 * 内置界面单元：Super Agent 的界面半——侧栏一行入口 + 主区一个整页。
 *
 * 三件事：
 *
 * 1. 往 `shell.sidebar` 报一行（`order 2` = 排在 `sessions.list` 的 `order 1` 之后），
 *    右侧读 `counts.needsYou` 画徽标，为 0 时不画；
 * 2. 往 `shell.page` 报一页（`order 30` = 排在 plugins 的 10、skills 的 20 之后），
 *    页里照插件中心那套外壳类名（`.plugins` / `.plugins-inner` / `.plugins-head`）排版；
 * 3. 页内三页签：发布 / 工单 / 设置（详情从工单页进）。页签状态在 `./state.ts` 的
 *    模块级信号里，整页卸载（`ui-layout/ui/app.tsx:477`）后不会跳回第一页。
 *
 * 快照面缺席（宿主插件默认关着）时画「未启动」的一面板话，不白屏、不假数字 0；
 * 宿主建库失败时把 `problem.code` / `problem.detail` 原样摊出来。
 *
 * 停用本插件时主区不会自动回对话页（只有 `plugins` 有特判，`ui-sessions/ui/ui.tsx:210-213`），
 * 这是 `docs/superagent/spike-sidebar.md` 待确认 4 记下的已知代价。
 *
 * @module dsc-ui-shell/superagent/superagent
 */
import type { ReactNode } from 'react'
import { IconBolt, createT, defineUiPlugin, setShellPage, useShellPage } from '@dsc/ui'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'
import { PublishPage } from './publish'
import { SettingsPage } from './settings'
import { TicketsPage } from './tickets'
import {
  closeTicket,
  setSuperagentTab,
  useNeedsYou,
  useSelectedTicket,
  useSuperagent,
  useSuperagentTab,
} from './state'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 这一页在 page-state 里的 id（侧栏入口与页条目约定同一个值）。 */
const PAGE = 'superagent'

/** 侧栏徽标的内联样式：壳里没有通用的计数徽标原语（spike 里查过），只能自绘一格。 */
const BADGE_STYLE = {
  marginLeft: 'auto',
  minWidth: 18,
  height: 18,
  padding: '0 5px',
  borderRadius: '999px',
  background: 'var(--dsc-accent)',
  color: 'var(--dsc-text-on-accent)',
  fontSize: 'var(--dsc-fs-caption)',
  lineHeight: '18px',
  textAlign: 'center',
  fontVariantNumeric: 'tabular-nums',
} as const

export default defineUiPlugin({
  name: t('superagent.plugin.name'),
  apply(ui) {
    // order 2：排在「会话列表」（`sessions.list`，order 1）之后；写 0 会跑到「新会话」按钮上面。
    ui.slots.register('shell.sidebar', { id: 'superagent.entry', order: 2 }, EntryRow)
    // order 30：现有两页是 plugins 10、skills 20，本页接在它们后面。
    ui.slots.register('shell.page', { id: 'superagent.page', order: 30 }, Page)
  },
})

/**
 * 侧栏那一行：点一下把主区切成 Super Agent 的「工单」页。
 *
 * 收起来的语义沿用壳里的开关（再点一次回对话页）——只在**已经停在工单列表**时才收：
 * 停在发布 / 设置 / 工单详情时先回工单列表，否则「点入口去工单」这件事会变成关页面。
 * 选中态用壳现成的 `.nav-item.on`，并把 `aria-pressed` 跟上（只靠颜色说话，读屏用户听不出）。
 */
function EntryRow(): ReactNode {
  const page = useShellPage()
  const tab = useSuperagentTab()
  const selected = useSelectedTicket()
  const needsYou = useNeedsYou()
  return (
    <div className="sidebar-nav">
      <button
        type="button"
        className={`nav-item${page === PAGE ? ' on' : ''}`}
        aria-pressed={page === PAGE}
        onClick={() => {
          if (page !== PAGE) {
            setShellPage(PAGE)
            setSuperagentTab('tickets')
            closeTicket()
            return
          }
          if (tab !== 'tickets' || selected !== null) {
            setSuperagentTab('tickets')
            closeTicket()
            return
          }
          setShellPage(null)
        }}
      >
        <IconBolt size={15} /> {t('superagent.entry')}
        {needsYou > 0 ? (
          <span style={BADGE_STYLE} aria-label={t('superagent.entry.badgeAria', { count: needsYou })}>
            {needsYou}
          </span>
        ) : null}
      </button>
    </div>
  )
}

/**
 * 页条目：`shell.page` 槽把每一页都挂着，只有当前页是自己时才渲染。
 *
 * 为什么不在 `apply` 里就判断：页的切换是运行期状态（`useShellPage` 订阅的），
 * 注册那一刻还不知道用户会停在哪一页，所以比对必须放在组件体里。
 */
function Page(): ReactNode {
  const page = useShellPage()
  return page === PAGE ? <PageBody /> : null
}

/** 页体：页头 + 页签行 + 当前页。 */
function PageBody(): ReactNode {
  const surface = useSuperagent()
  const tab = useSuperagentTab()
  return (
    <div className="plugins">
      <div className="plugins-inner">
        <div className="plugins-head">
          <div>
            <h1>{t('superagent.page.title')}</h1>
            <p>{t('superagent.page.lead')}</p>
          </div>
        </div>

        <div className="skills-tabs" role="tablist" aria-label={t('superagent.tabs.aria')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'publish'}
            className={tab === 'publish' ? 'on' : ''}
            onClick={() => {
              setSuperagentTab('publish')
            }}
          >
            {t('superagent.tab.publish')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'tickets'}
            className={tab === 'tickets' ? 'on' : ''}
            onClick={() => {
              setSuperagentTab('tickets')
            }}
          >
            {t('superagent.tab.tickets')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'settings'}
            className={tab === 'settings' ? 'on' : ''}
            onClick={() => {
              setSuperagentTab('settings')
            }}
          >
            {t('superagent.tab.settings')}
          </button>
        </div>

        <div role="tabpanel">
          {surface === null ? (
            // 宿主插件默认关着：这一格整个缺席。给一句能操作的，别画成空白页。
            <div className="plugins-empty">{t('superagent.state.missing')}</div>
          ) : tab === 'settings' ? (
            // 设置分区在 `apply` 里就登记了，运行期没起来也能改（改仓库路径正是为了让它能起来）。
            <SettingsPage />
          ) : surface.ready !== true ? (
            <div className="settings-note error">
              {surface.problem === null
                ? t('superagent.state.notReady')
                : t('superagent.state.problem', {
                    code: surface.problem.code === '' ? '?' : surface.problem.code,
                    detail: surface.problem.detail,
                  })}
            </div>
          ) : tab === 'publish' ? (
            <PublishPage surface={surface} />
          ) : (
            <TicketsPage surface={surface} />
          )}
        </div>
      </div>
    </div>
  )
}
