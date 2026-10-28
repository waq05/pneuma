/**
 * 分支控制（输入框上方那一行）：一颗钮显示当前分支，点开是「搜 / 切 / 新建」菜单。
 *
 * 读数来自宿主快照面 `surfaces.git`（宿主自己按节奏拍，壳只渲染），不是仓库时整行不画。
 * 写口（切 / 新建）走 `dock` 的写类 op，与暂存 / 提交同一档：过审批。
 *
 * 开关是受控的（`open` / `onOpenChange`）：输入区那几张浮层互斥，谁开谁关由父组件定；
 * 清单、搜索词、新建输入框这些只属于这张菜单的状态留在本组件里。
 *
 * 从 `composer/ui.tsx` 拆出来（2026-10-28，只搬不改）。
 *
 * @module dsc-ui-shell/plugins/composer/branch-menu
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { HUMAN_WAIT_TIMEOUT_MS, IconBranch, IconCheck, IconChevronDown, IconPlus, IconSearch, toastOk, useHostChannel, type GitSurface } from '@dsc/ui'
import { filteredBranches, wouldOverwrite, type GitBranchRow } from './git-branch'

/** `dock git-branches` 的回包（宿主 desktop-dock 的形状）。 */
interface GitBranchList {
  current: string
  detached: boolean
  branches: GitBranchRow[]
}

/** 菜单的输入：开关归父组件，读数与通道由调用方递进来。 */
export interface BranchMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  git: GitSurface
  channel: ReturnType<typeof useHostChannel>
  /** 失败写到输入框下面那行（那颗钮就在输入框上方，用户的眼睛在那儿）。 */
  onFault: (text: string | null) => void
}

export function BranchMenu({ open, onOpenChange, git, channel, onFault }: BranchMenuProps): ReactNode {
  /** 分支清单：null = 还没读到（菜单里显示「正在读取分支…」）。每次展开都重读一次。 */
  const [branchList, setBranchList] = useState<GitBranchList | null>(null)
  const [branchQuery, setBranchQuery] = useState('')
  /** 有分支动作在跑（切换 / 新建）：期间整个菜单禁用，免得连点两下切两次。 */
  const [branchBusy, setBranchBusy] = useState(false)
  /** 「新建分支…」那一格展开没有（ZCode 用弹框，壳这边就地展开一格输入框）。 */
  const [branchCreateOpen, setBranchCreateOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const branchRows = useRef<HTMLDivElement | null>(null)

  /**
   * 分支菜单展开时读一次本地分支清单（`dock git-branches`，读类 op 直接放行）。
   *
   * 每次展开都重读（对照参考实现：切完再展开必须是新的那一份，不能复用上次的快照）。
   * 关掉菜单不清清单——下一次展开会立刻重读，清空只会闪一下「正在读取」。
   */
  useEffect(() => {
    if (!open) return undefined
    let alive = true
    setBranchQuery('')
    setBranchCreateOpen(false)
    setNewBranchName('')
    void channel
      .invoke<GitBranchList>('dock', ['git-branches', {}])
      .then((list) => {
        if (alive) setBranchList(list)
      })
      .catch((reason: unknown) => {
        if (!alive) return
        setBranchList(null)
        onFault(`读分支清单失败：${reason instanceof Error ? reason.message : String(reason)}`)
      })
    return () => {
      alive = false
    }
  }, [open, channel, git.branch])

  // 清单到手后把「当前分支」那一条滚进视野（参考实现同款）：分支多的仓库里，
  // 展开就看到自己在哪，不必自己找。`block: 'nearest'` 已在视野里就不动。
  useEffect(() => {
    if (!open || branchList === null) return
    const node = branchRows.current?.querySelector<HTMLElement>('[data-branch-current="true"]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [open, branchList])

  /**
   * 切分支：`dock git-checkout`（**写类 op，过审批**——切分支会把改动带过去或让 git 拒掉，
   * 所以与暂存 / 提交同一档，卡片上写着切到哪个分支）。
   *
   * 失败分两种，都往输入的 fault 行上写（那颗钮就在输入框上方，用户的眼睛在那儿）：
   *   - 审批被拒 / git 自己拒（工作树里有会被覆盖的改动）：git 的原文已经说清了是哪些文件，
   *     原样给出去，再补一句「往哪儿走」（先提交或暂存）。
   *   - 通道 / 参数层面的错：原文照给。
   */
  const switchBranch = (name: string): void => {
    setBranchBusy(true)
    onFault(null)
    // 菜单先收起来：接下来可能弹审批卡，卡才是这一刻该看的东西（菜单盖在卡上面会让人点不到）。
    onOpenChange(false)
    void channel
      .invoke('dock', ['git-checkout', { branch: name }], { timeoutMs: HUMAN_WAIT_TIMEOUT_MS })
      .then(() => {
        toastOk(`已切到分支「${name}」`)
      })
      .catch((reason: unknown) => {
        const text = reason instanceof Error ? reason.message : String(reason)
        onFault(wouldOverwrite(text) ? `${text}（先提交或暂存这些改动再切：右侧边栏「变更」页签可以提交）` : text)
      })
      .finally(() => {
        setBranchBusy(false)
      })
  }

  /** 新建分支并切过去：`dock git-branch-create`（同样是写类 op，过审批）。 */
  const createBranch = (): void => {
    const name = newBranchName.trim()
    if (name === '') return
    setBranchBusy(true)
    onFault(null)
    onOpenChange(false)
    void channel
      .invoke('dock', ['git-branch-create', { branch: name }], { timeoutMs: HUMAN_WAIT_TIMEOUT_MS })
      .then(() => {
        setBranchCreateOpen(false)
        setNewBranchName('')
        toastOk(`已新建并切到分支「${name}」`)
      })
      .catch((reason: unknown) => {
        onFault(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        setBranchBusy(false)
      })
  }

  // 读数来自宿主快照面 `surfaces.git`（宿主自己按节奏拍，壳只渲染），**不是仓库时整行不画**。
  // 写口（切 / 新建）走 `dock` 的写类 op，与暂存 / 提交同一档：过审批。
  return git.repo ? (
    <div className="composer-git">
      <div className="model-anchor">
        <button
          type="button"
          className={`model-btn git-btn${open ? ' open' : ''}`}
          data-tip={git.detached ? 'HEAD 已分离（不在任何分支上）；点开可以切回一个分支' : `当前分支：${git.branch}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            // 四张浮层互斥：开这一张由父组件把别的收掉（onOpenChange 里做）。
            onOpenChange(!open)
          }}
        >
          <IconBranch size={13} />
          <span className="git-branch-name">{git.branch}</span>
          <IconChevronDown size={12} />
        </button>
        {open ? (
          <>
            <div
              className="pop-mask"
              onClick={() => {
                onOpenChange(false)
              }}
            />
            <div className="model-pop git-pop" role="menu" aria-label="切换分支">
              <div className="pop-label">
                切换分支
                <span className="pop-note">
                  {branchList?.detached === true ? 'HEAD 已分离' : `当前 ${branchList?.current ?? git.branch}`}
                  {git.dirtyFileCount > 0 ? ` · ${String(git.dirtyFileCount)} 个文件已更改` : ''}
                </span>
              </div>
              <div className="git-search">
                <IconSearch size={13} />
                <input
                  type="text"
                  value={branchQuery}
                  placeholder="搜索分支…"
                  aria-label="搜索分支"
                  autoFocus
                  onChange={(event) => {
                    setBranchQuery(event.target.value)
                  }}
                />
              </div>
              <div className="model-list git-branch-list" ref={branchRows}>
                {branchList === null ? (
                  <div className="pop-item">
                    <span className="name">正在读取分支…</span>
                  </div>
                ) : filteredBranches(branchList.branches, branchQuery).length === 0 ? (
                  <div className="pop-item">
                    <span className="name">{branchQuery.trim() === '' ? '这个仓库还没有分支' : '没有匹配的分支'}</span>
                  </div>
                ) : (
                  filteredBranches(branchList.branches, branchQuery).map((row) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={row.current}
                      key={row.name}
                      className={`pop-item${row.current ? ' on' : ''}`}
                      title={row.current ? `${row.name}（当前分支）` : `切到 ${row.name}`}
                      disabled={row.current || branchBusy}
                      {...(row.current ? { 'data-branch-current': 'true' } : {})}
                      onClick={() => {
                        switchBranch(row.name)
                      }}
                    >
                      <IconBranch size={13} className="git-item-icon" />
                      <span className="name">{row.name}</span>
                      {row.current ? <IconCheck size={14} className="check" /> : null}
                    </button>
                  ))
                )}
              </div>
              <div className="git-foot">
                {branchCreateOpen ? (
                  <form
                    className="git-create"
                    onSubmit={(event) => {
                      event.preventDefault()
                      createBranch()
                    }}
                  >
                    <input
                      type="text"
                      value={newBranchName}
                      placeholder="新分支名，如 feat/xxx"
                      aria-label="新分支名"
                      autoFocus
                      disabled={branchBusy}
                      onChange={(event) => {
                        setNewBranchName(event.target.value)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          setBranchCreateOpen(false)
                        }
                      }}
                    />
                    <button type="submit" disabled={branchBusy || newBranchName.trim() === ''}>
                      创建并切换
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="git-foot-btn"
                    disabled={branchBusy}
                    onClick={() => {
                      setBranchCreateOpen(true)
                    }}
                  >
                    <IconPlus size={13} />
                    新建分支…
                  </button>
                )}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  ) : null
}
