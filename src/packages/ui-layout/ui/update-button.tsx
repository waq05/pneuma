/**
 * 品牌行右缘的更新按钮：**只在真有新版时出现**（侧栏左上角 `Pneuma` 右边那一颗）。
 *
 * ## 谁在问更新
 *
 * 检查与下载都在桌面主进程（`desktop/electron/main/update.ts`）——它才够得着网络与安装程序。
 * 这里只做两件事：挂载时问一次当前状态（`checkUpdate`），之后订阅 `update-status`。
 * **两件都要**：事件是「之后的变化」，错过开机那一次（那时页面还没建好）就再也没有了。
 *
 * ## 点击之后
 *
 * 调 `installUpdate`：主进程下载安装器（进度经 `update-progress` 推上来，按钮就地显示百分比）
 * → 启动安装程序 → 退出本应用。所以按钮在这条链上要能表达三种状态：可点、正在下、下完等退出。
 *
 * 浏览器页签与远程页面里没有原生桥（`native.available === false`），整块不渲染——
 * 「检查更新」是桌面端的事，那些形态里连主进程都没有。
 *
 * @module dsc-ui-shell/update-button
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useHostNative } from '@dsc/ui-primitives'

/** 主进程推上来的更新状态（形状与 `NATIVE_EVENTS` 的 `update-status` 一致）。 */
interface UpdateStatusView {
  status: 'idle' | 'checking' | 'latest' | 'available' | 'error'
  version?: string
  pageUrl?: string
  assetName?: string
  size?: number
  error?: string
}

/** 下载进度（`update-progress`）。 */
interface UpdateProgressView {
  received: number
  total: number
  percent: number | null
}

/** 体积读数：MB 一位小数；不到 1MB 给 KB。未知（0）给空串。 */
function sizeText(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) return ''
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function UpdateButton(): ReactNode {
  const native = useHostNative()
  const [status, setStatus] = useState<UpdateStatusView | null>(null)
  const [percent, setPercent] = useState<number | null>(null)
  const [installing, setInstalling] = useState(false)
  const [fault, setFault] = useState('')

  useEffect(() => {
    if (!native.available) return undefined
    let alive = true
    void native
      .invoke<UpdateStatusView>('checkUpdate')
      .then((value) => {
        if (alive) setStatus(value)
      })
      .catch(() => {
        // 问不到就不显示按钮：这一条只在桌面窗口里成立，失败不该在品牌行留个红点。
      })
    const offStatus = native.on('update-status', (data) => {
      setStatus(data as UpdateStatusView)
      // 状态一换（例如「有新版」变成别的）就把上一轮的失败话术清掉，别让旧错挂在新状态上。
      setFault('')
    })
    const offProgress = native.on('update-progress', (data) => {
      const progress = data as UpdateProgressView
      setPercent(progress.percent)
    })
    return () => {
      alive = false
      offStatus()
      offProgress()
    }
  }, [native])

  if (!native.available || status === null || status.status !== 'available') return null

  const version = status.version ?? ''
  const size = sizeText(status.size)
  const tip =
    fault !== ''
      ? fault
      : installing
        ? percent === null
          ? '正在下载安装包…'
          : `正在下载安装包… ${String(percent)}%`
        : `发现新版本${version === '' ? '' : ` ${version}`}${size === '' ? '' : `（${size}）`}，点击下载并安装。`

  return (
    <button
      type="button"
      className="update-btn"
      data-update-version={version}
      data-tip={tip}
      title={tip}
      disabled={installing}
      onClick={() => {
        setFault('')
        setInstalling(true)
        void native
          .invoke<{ ok: boolean; error?: string }>('installUpdate')
          .then((result) => {
            if (result.ok) return
            // 下载或起安装程序失败：按钮退回可点，并把原因挂在 tooltip 上（这一行没有放提示条的地方）。
            setFault(result.error ?? '更新失败')
            setInstalling(false)
          })
          .catch((error: unknown) => {
            setFault(`更新失败：${error instanceof Error ? error.message : String(error)}`)
            setInstalling(false)
          })
      }}
    >
      {installing ? (percent === null ? '更新中' : `${String(percent)}%`) : '更新'}
    </button>
  )
}
