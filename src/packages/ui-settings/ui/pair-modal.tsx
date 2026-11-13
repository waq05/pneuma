/**
 * 手机连接弹窗（PairModal）——桌面渲染层 `PairModal.tsx` 的同构移植。
 *
 * 为什么非要这一份：设置分区动作 `regenerate-code` 的成功回执里带了
 * `data: PairShareData`（契约见 `src/contract.ts`），那份数据的用途就是**一直挂在屏幕上**
 * 让手机扫。旧界面据此弹窗；壳这一版一开始只读了回执里的 `notice`（「配对码已生成」），
 * 把 `data` 丢了——于是点「连接手机」只出一行说明，二维码与 8 位码根本不出现，
 * 看着就是「点了没反应」。这一份补上画的那一半。
 *
 * 五件事各占一块（与旧界面逐条对位）：
 *   - 二维码：内容就是 `data.url`，手机扫一下直接带着码进登录页；
 *   - 配对码：8 位明文 + 复制；
 *   - 可扫地址：`data.url` 用等宽字展示，也带一个复制；
 *   - 倒计时：到 `data.expiresAt` 归零，归零后二维码与码一起变灰禁用；
 *   - 重新生成：原地换一份新数据（不关弹窗），失败原因写在弹窗里。
 *
 * 为什么用 createPortal 挂到 `document.body`：设置面板那串祖先里既有 `overflow: hidden`
 * （`.settings`），又有 `backdrop-filter`（`.settings-mask`——它会把 fixed 定位的包含块
 * 从视口改成自己）。挂进面板，弹窗就得陪这两条规矩玩；挂到 body 上则与确认框那一档浮层
 * 完全一致：`.dsc-overlay` 走 `--dsc-z-modal`，压在设置面板的 `--dsc-z-backdrop` 之上。
 *
 * 样式复用 `legacy/views.css` 里现成的 `.pair-*` 一族（壳建壳时样式抄过来了，组件没跟过来）。
 *
 * @module dsc-ui-shell/plugins/settings/pair-modal
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import QRCode from 'qrcode'
import { IconClose, createT, readCssSolidColor, toastErr, toastOk, type PairShareData } from '@dsc/ui'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 重新生成的结果：要么一张新码，要么一句能直接显示在弹窗里的原因。 */
export type PairRegenerateResult = { ok: true; data: PairShareData } | { ok: false; error: string }

/** 二维码边长（px）：够手机在三十公分外对上焦，又不至于把弹窗撑成一张海报。 */
const QR_SIZE = 220

/** 倒计时的取样间隔：比一秒密一档，秒数才不会偶尔跳两格或停一拍。 */
const TICK_MS = 500

/** 弹窗里所有能聚焦的东西（按 DOM 顺序，也就是 Tab 顺序）。禁用的键不进焦点环。 */
function focusables(root: HTMLElement): HTMLElement[] {
  const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (item) => item.hasAttribute('disabled') === false,
  )
}

/**
 * 二维码深色块的颜色 = 当前主题的正文色，压在卡片底色上合成出不透明值。
 *
 * 读不出来（老内核给的写法认不出、样式表还没上）退回落色纯黑——宁可深色主题下看不清，
 * 也不要抛错把弹窗卡死。读法本身住在基元层（`readCssSolidColor`），旧界面那份手抄的
 * 解析已经没有必要再抄第二遍了。
 */
function qrColor(): string {
  return readCssSolidColor('--dsc-text-primary', '--dsc-bg-card', '#000000')
}

/** 剩余毫秒 → `mm:ss`（向上取整，免得最后 0.4 秒就提前跳到 00:00）。 */
function clockText(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/**
 * 手机连接弹窗。
 *
 * @param props.data 宿主给的配对数据（码 / 可扫地址 / 过期时刻 / 手机可达性）
 * @param props.onRegenerate 再调一次同一个宿主动作，拿到新数据就原地替换
 * @param props.onEnableLan 「手机连不上」那一键：让宿主打开局域网访问（必要时连同远程控制开关）
 *   再加一张新码；老宿主没有这个动作时把原因写在弹窗里
 * @param props.onClose 关闭（X、Esc、点遮罩三条路都走它）
 */
export function PairModal(props: {
  data: PairShareData
  onRegenerate(): Promise<PairRegenerateResult>
  onEnableLan(): Promise<PairRegenerateResult>
  onClose(): void
}): ReactNode {
  const [share, setShare] = useState<PairShareData>(props.data)
  const [qr, setQr] = useState<string | null>(null)
  const [qrFailed, setQrFailed] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const card = useRef<HTMLDivElement>(null)
  // 关闭回调每次渲染都是新的箭头函数，事件监听只挂一次，所以走 ref 取最新那个
  const closing = useRef(props.onClose)
  closing.current = props.onClose

  // 宿主（或设置面板）换了一份数据就跟上：重新生成走的就是这条路
  useEffect(() => setShare(props.data), [props.data])

  // 每 0.5 秒取一次样，秒数才不会偶尔停一拍或跳两格。
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  const remaining = Math.max(0, share.expiresAt - now)
  const expired = remaining <= 0
  /**
   * 手机能不能扫开：老宿主不给这个字段，按「能」处理（那时也确实没有「只听本机」这条
   * 之外的可能）。`local` / `down` 两种状态下不画二维码——画一张手机必然打不开的图，
   * 等于把「扫这个码即可连接」这句话再骗一遍（2026-11-12 报障）。
   */
  const reach = share.reach ?? 'lan'
  const blocked = reach !== 'lan'

  // 画二维码。生成失败（地址长到库算不过来之类）只把这一格换成一句说明，
  // 配对码、地址、倒计时、重新生成照旧可用——弹窗不该因为一张图卡住。
  // 手机上打不开的地址不画：那一格留给引导块。
  useEffect(() => {
    let alive = true
    setQr(null)
    setQrFailed(false)
    if (blocked) return
    void QRCode.toDataURL(share.url, {
      width: QR_SIZE,
      margin: 1,
      // light 传全透明：露出卡片底色，深浅两套主题都不用各配一张图
      color: { dark: qrColor(), light: '#00000000' },
    }).then(
      (dataUrl) => {
        if (alive) setQr(dataUrl)
      },
      () => {
        if (alive) setQrFailed(true)
      },
    )
    return () => {
      alive = false
    }
  }, [share.url, blocked])

  // 焦点初落在弹窗内（落在卡本身而不是某颗按钮上，于是第一个 Tab 就去关闭钮），
  // 关掉时还给触发它的那颗按钮——与 platform/confirm 同一套。
  useEffect(() => {
    const last = document.activeElement instanceof HTMLElement ? document.activeElement : null
    card.current?.focus()
    return () => {
      if (last !== null && last.isConnected) last.focus()
    }
  }, [])

  // Esc 关闭 + Tab 在弹窗里绕圈。都挂在捕获阶段：压在弹窗下面的设置面板同样在
  // window 上听 Esc（冒泡段），不掐断传播的话关弹窗会连带把设置面板一起关掉。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closing.current()
        return
      }
      if (event.key !== 'Tab') return
      const box = card.current
      if (box === null) return
      const items = focusables(box)
      const first = items[0]
      const last = items[items.length - 1]
      if (first === undefined || last === undefined) {
        event.preventDefault()
        box.focus()
        return
      }
      const active = document.activeElement
      const inside = active instanceof HTMLElement && box.contains(active)
      // 到头就绕回另一头；焦点跑到背景页面上时也拽回来
      if (event.shiftKey === false && (inside === false || active === last)) {
        event.preventDefault()
        first.focus()
        return
      }
      if (event.shiftKey && (inside === false || active === first)) {
        event.preventDefault()
        last.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  /** 复制一段文本；回执与设置页 info 行的复制按钮同一套。 */
  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => toastOk(t('settings.pair.copied')),
      () => toastErr(t('settings.pair.copyFailed')),
    )
  }

  /**
   * 「重新生成」与「打开局域网访问」共用这一条：成功就原地换数据，失败原因留在弹窗里
   * （不关窗，用户还能再试一次）。
   */
  const run = (work: () => Promise<PairRegenerateResult>): void => {
    if (busy) return
    setBusy(true)
    setError('')
    void work().then((result) => {
      setBusy(false)
      if (result.ok === false) {
        setError(result.error)
        return
      }
      setShare(result.data)
      setNow(Date.now())
    })
  }

  /** 重新生成：新数据原地替换，失败原因留在弹窗里（不关窗，用户还能再试一次）。 */
  const regenerate = (): void => {
    run(props.onRegenerate)
  }

  /** 手机连不上时那一键：宿主去打开局域网访问、等服务在听、再返回一张新码。 */
  const enableLan = (): void => {
    run(props.onEnableLan)
  }

  return createPortal(
    <div
      className="dsc-overlay pair-modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div
        className="dsc-overlay__card pair-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pair-title"
        aria-describedby="pair-sub"
        tabIndex={-1}
        ref={card}
      >
        <div className="pair-head">
          <div className="pair-head-text">
            <h3 className="pair-title" id="pair-title">
              {t('settings.pair.title')}
            </h3>
            <p className="pair-sub" id="pair-sub">
              {t('settings.pair.subtitle')}
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            data-tip={t('settings.pair.closeTip')}
            aria-label={t('settings.pair.close')}
            onClick={props.onClose}
          >
            <IconClose size={16} />
          </button>
        </div>

        <div className={`pair-qr${blocked ? ' pair-qr-blocked' : ''}${expired ? ' expired' : ''}`}>
          {blocked ? (
            <div className="pair-qr-guide">
              <strong className="pair-qr-guide-title">
                {reach === 'down' ? t('settings.pair.downTitle') : t('settings.pair.localTitle')}
              </strong>
              <span className="pair-qr-guide-body">
                {reach === 'down' ? t('settings.pair.downBody') : t('settings.pair.localBody')}
              </span>
              <button type="button" className="btn-primary" disabled={busy} onClick={enableLan}>
                {busy
                  ? t('settings.pair.generating')
                  : reach === 'down'
                    ? t('settings.pair.openDown')
                    : t('settings.pair.openLan')}
              </button>
              <span className="pair-qr-guide-risk">{t('settings.pair.openLanRisk')}</span>
            </div>
          ) : null}
          {blocked === false && qr !== null && (
            <img className="pair-qr-img" src={qr} alt={t('settings.pair.qrAlt', { url: share.url })} />
          )}
          {blocked === false && qr === null && qrFailed === false && (
            <div className="pair-qr-hold">{t('settings.pair.qrPending')}</div>
          )}
          {blocked === false && qrFailed && <div className="pair-qr-hold">{t('settings.pair.qrFailed')}</div>}
        </div>

        <div className={`pair-code-row${expired ? ' expired' : ''}`}>
          <span className="pair-code mono">{share.code}</span>
          <button type="button" className="text-btn" disabled={expired} onClick={() => copy(share.code)}>
            {t('settings.pair.copy')}
          </button>
        </div>

        {/* 可扫地址：与上面那行配对码同一种版式（整行居中，`复制` 跟着地址走），
            长地址折行而不是截断——它是要照着输进手机的那串。 */}
        <div className="pair-url">
          <span className="mono pair-url-text">{share.url}</span>
          <button type="button" className="text-btn" disabled={expired} onClick={() => copy(share.url)}>
            {t('settings.pair.copy')}
          </button>
        </div>

        <div className={`pair-count${expired ? ' expired' : ''}`} role="status">
          {expired ? t('settings.pair.expired') : t('settings.pair.expiresIn', { time: clockText(remaining) })}
        </div>

        {error !== '' && <div className="settings-note error pair-error">{error}</div>}

        <div className="pair-actions">
          <button type="button" className="btn-primary" disabled={busy} onClick={regenerate}>
            {busy ? t('settings.pair.generating') : t('settings.pair.regenerate')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
