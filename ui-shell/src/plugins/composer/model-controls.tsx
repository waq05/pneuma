/**
 * 模型 / 思考档位：底栏那两颗 chip 与它们各自的浮层（模型两级菜单、档位滑杆）。
 *
 * 为什么是 hook 而不是组件：这两颗 chip 与输入行本身咬着三处——底栏的 `barRef`（量栏宽决定
 * 端点前缀收不收）、附件的能力门（当前模型吃不吃图片）、错误行 `fault`。做成组件就得把这三样
 * 或它们的反向回调穿进穿出；做成 hook 则状态仍住在 `ComposerBox` 里，这次只是把代码挪了个
 * 文件——**不新增组件边界，重挂与状态生命周期一行没变**。
 *
 * 一切判定都走 `./model-picker` 那份纯逻辑（端点分组、当前模型的精确定位、档位清单恒含「默认」），
 * 这里只把结果画出来；探针读得了那份零依赖的 .ts，读不了 .tsx。
 *
 * 从 `composer/ui.tsx` 拆出来（2026-10-28，只搬不改）。
 *
 * @module dsc-ui-shell/plugins/composer/model-controls
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { IconBrain, IconCheck, IconChevronDown, IconChevronRight, IconPackage, useHostChannel, useHostSelector, type EffortLevel, type ModelChoiceView } from '@dsc/ui'
import { EffortSlider } from './effort-slider'
import {
  chooseFlyoutSide,
  clampShift,
  contextLabel,
  effortChoices,
  effortLabel,
  findCurrent,
  FLYOUT_WIDTH,
  groupModels,
  modelBadges,
  modelChipText,
  placeFlyout,
  providerHint,
  shouldShowProviderLevel,
  type FlyoutSide,
} from './model-picker'
import { readEffort, readModel, readProvider } from './surfaces'

/** DOM 原生键盘事件（`window.addEventListener` 用；React 的 KeyboardEvent 是另一个类型）。 */
type WindowKeyboardEvent = globalThis.KeyboardEvent

/** 这颗 hook 交回给输入区的东西。 */
export interface ModelControlsApi {
  /** 两颗 chip 与两张浮层（原样插在底栏 `.bar-right` 的开头）。 */
  node: ReactNode
  /** 当前模型吃不吃图片：附件那边的能力门。 */
  allowImage: boolean
  /** 把这两张浮层收掉（别的旋钮要打开时调）。 */
  close: () => void
  /** 底栏那一行：chip 收放端点前缀时要量栏宽。 */
  barRef: RefObject<HTMLDivElement | null>
}

export interface ModelControlsOptions {
  channel: ReturnType<typeof useHostChannel>
  /** 失败写进输入框下面那行。 */
  onFault: (text: string | null) => void
  /** 这两张浮层要打开时，先把另外三张收掉（互斥）。 */
  onTakeOver: () => void
}

export function useModelControls({ channel, onFault, onTakeOver }: ModelControlsOptions): ModelControlsApi {
  const model = useHostSelector(readModel)
  const effort = useHostSelector(readEffort)

  /**
   * 刚点下去、宿主还没确认的档位（乐观值）。
   *
   * 为什么要它：档位 chip 的读数取宿主快照，一次 setEffort 要走「界面 → 宿主 → 快照 → 回推」，
   * 几十到几百毫秒。这期间不垫一个乐观值，滑钮和文字会先弹回旧档、再跳到新档——用户说的
   * 「调档卡顿、不丝滑」多半就是这一下。快照回来对上就自动撤掉；没对上（掉线 / 宿主不认
   * 这一档）由下面的超时兜底，不让界面一直骗人。
   */
  const [pendingEffort, setPendingEffort] = useState<string | null>(null)
  // 乐观值对上宿主读数就撤（正常路径：一次往返，几十毫秒）。
  useEffect(() => {
    if (pendingEffort !== null && effort === pendingEffort) setPendingEffort(null)
  }, [effort, pendingEffort])
  // 兜底：宿主 1.5 秒没确认（掉线、旧宿主不认这个档位）就退回宿主读数，别让界面停在假状态。
  useEffect(() => {
    if (pendingEffort === null) return undefined
    const timer = setTimeout(() => setPendingEffort(null), 1500)
    return () => clearTimeout(timer)
  }, [pendingEffort])

  const [models, setModels] = useState<readonly ModelChoiceView[]>([])
  /** 模型菜单（两级：端点 → 悬浮飞出的模型列表）开没开。 */
  const [modelOpen, setModelOpen] = useState(false)
  /** 思考档位菜单开没开（与模型菜单是**两颗** chip、两张浮层，见 bar-right 的注释）。 */
  const [effortOpen, setEffortOpen] = useState(false)
  /**
   * 一级列表上**鼠标停着（或键盘焦点落着、或手指点过）的那个端点**：它决定飞出卡画谁家的
   * 模型。`null` = 没有飞出卡（刚展开时就是这样，对照 ZCode：不悬浮就只有一级那一列）。
   */
  const [hoverProvider, setHoverProvider] = useState<string | null>(null)
  /** 飞出卡相对面板的顶边与高度上限（量出来的，见 `placeFlyout`；写进 CSS 变量）。 */
  const [flyout, setFlyout] = useState<{ top: number; maxHeight: number } | null>(null)
  /** 飞出卡摆面板左边还是右边（量出来的，见 `chooseFlyoutSide`；两边都放不下就盖住面板）。 */
  const [flyoutSide, setFlyoutSide] = useState<FlyoutSide>('right')
  /** 模型 chip 上的端点前缀收没收掉（放不下就收，见下面那段量法）。 */
  const [dropPrefix, setDropPrefix] = useState(false)
  /** 面板整体横移多少（窄屏上 chip 落得太靠左时把面板推回正文列里，见 `clampShift`）。 */
  const [panelShift, setPanelShift] = useState(0)
  /**
   * 「该重量一次了」的计数器：窗口缩放、面板自身尺寸变化（`.flat` 264 与两级 320 两套宽度）
   * 都会撞它，那两个 `useLayoutEffect` 把它列进依赖，于是位置与挑边跟着重算。
   *
   * 为什么必须有：原来只在 `[modelOpen, models.length, twoLevel]` 变时量一次，量完就
   * 不再管——2026-10-27 实测 360px 视口下面板 left=-67（整块探到屏幕左侧外），而 320/430
   * 两个宽度都正常，说明就是「量过一次之后再也没重量」这一类时序问题。
   */
  const [measureTick, setMeasureTick] = useState(0)

  /** 模型面板本体（量飞出卡的挑边与夹高度都拿它当参照）。 */
  const modelPanelRef = useRef<HTMLDivElement | null>(null)
  /** 已经施加在面板上的横移量（量位置时要先把它减掉，见下面那个 `useLayoutEffect`）。 */
  const shiftRef = useRef(0)
  /** 飞出卡里当前模型那一行的滚动锚点（模型一多，勾可能落在滚动区外面）。 */
  const modelRows = useRef<HTMLDivElement | null>(null)
  /** 飞出卡本体（量它内容的自然高，定了才夹得准）。 */
  const flyoutCardRef = useRef<HTMLDivElement | null>(null)
  /** 输入行（量栏宽用：栏宽一变就要重新掂一次端点前缀放不放得下）。 */
  const barRef = useRef<HTMLDivElement | null>(null)
  const [barWidth, setBarWidth] = useState(0)
  useEffect(() => {
    const node = barRef.current
    if (node === null || typeof ResizeObserver === 'undefined') return undefined
    setBarWidth(node.clientWidth)
    const observer = new ResizeObserver(() => {
      setBarWidth(node.clientWidth)
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [])
  /** 模型 chip 本体（量端点前缀放不放得下用）。 */
  const modelChipRef = useRef<HTMLButtonElement | null>(null)
  // Esc 关这两张浮层（与遮罩点击同效；设置面板、确认框各自也拦 Esc，谁开着归谁）。
  useEffect(() => {
    if (!modelOpen && !effortOpen) return undefined
    const onKey = (event: WindowKeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setModelOpen(false)
      setEffortOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modelOpen, effortOpen])

  /**
   * 模型清单：挂载时取一次，**每次展开菜单再取一次**。
   *
   * 为什么不能只在挂载时取（旧版就是这么写的，注释还写着「静态数据」）：设置里加过端点、
   * 改过模型之后，这张清单就是旧的了——点开菜单看到的还是上一轮配置，当前模型甚至可能
   * 根本不在里面（0.6.71 报障）。这条读一次就回来的路上没有成本，重取的收益是「菜单里
   * 看到的永远是当下这份配置」。
   */
  useEffect(() => {
    let alive = true
    void channel
      .invoke<ModelChoiceView[]>('listModels')
      .then((list) => {
        if (alive) setModels(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        // 取不到就沿用上一次那一份（首次即空）：菜单会如实说「清单没取到」，不影响发消息。
      })
    return () => {
      alive = false
    }
  }, [channel, modelOpen])

  // ── 模型 / 思考档位（两颗 chip + 两张浮层）───────────────────────────────────
  // 一切判定都走 `./model-picker` 那份纯逻辑：端点分组、当前模型的精确定位、档位清单
  // （恒含「默认」）都在那里，探针逐条钉着；这里只把结果画出来。
  const groups = groupModels(models)
  const provider = useHostSelector(readProvider)
  const current = findCurrent(groups, provider, model)

  /**
   * 当前模型能不能吃图片。模型清单里查不到（`entry` 为 undefined）时**不拦**：
   * 清单没取到（老宿主 / 刚启动）时误伤，比放过去由宿主校验更糟。
   * 视频也要这道门：视频会抽成图片一起带给模型。
   */
  const imageInputAllowed = current.entry === undefined || current.entry.modalities.includes('image')

  const chip = modelChipText(groups, provider, model)
  const twoLevel = shouldShowProviderLevel(groups)
  /** 飞出卡画谁家的模型：鼠标停着的那一家；没停（或它没在了）就只有一级那一列。 */
  const hoveredGroup = groups.find((item) => item.provider === hoverProvider)
  const visibleModels = twoLevel
    ? (hoveredGroup?.models ?? [])
    : (groups[0]?.models ?? [])
  /**
   * 飞出卡渲染不渲染（也是「面板现在展示的是哪一级」的唯一真值）。
   *
   * `side === 'overlay'` 时它**盖住一级**，所以样式要据此把端点那一列藏起来——不藏的话
   * 卡片（它是透明的，为的是看着就是面板本来的样子）会让底下的端点行透上来，两列字叠在一起。
   */
  const flyoutShown = twoLevel && flyout !== null && hoveredGroup !== undefined
  // 档位清单：模型查得到就用它声明的，查不到给兜底——不锁死用户。
  // 「默认」不画进滑杆（2026-10-26 用户定的：它不是刻度上的位置，摆进去会被当成真实档位），
  // 所以这里先把它滤掉；滤完一档都不剩（模型没有思考开关）就退回单档 chip，不给浮层。
  const levelOptions = effortChoices(current.entry)
  const sliderLevels = levelOptions.filter((level): level is EffortLevel => level !== 'default')
  const switchEffort = sliderLevels.length > 0
  /** 界面显示哪个档位：乐观值优先（见 pendingEffort 的注释），宿主确认后回到宿主读数。 */
  const shownEffort = pendingEffort ?? effort
  const effortText = effortLabel(shownEffort)
  /**
   * 选档：只有这一处发请求（拖动中不发）。先落乐观值再发，界面不用等一个来回；
   * 宿主拒绝时把乐观值撤掉并把原因写进 chip 下面那行 fault。
   */
  const commitEffort = (level: EffortLevel): void => {
    setPendingEffort(level)
    onFault(null)
    // 第二个实参 quiet=true：滑杆调档不往对话里写「思考强度设为…」，也就少推一帧。
    void channel.invoke('setEffort', [level, true]).catch((reason: unknown) => {
      setPendingEffort(null)
      onFault(reason instanceof Error ? reason.message : String(reason))
    })
  }

  /**
   * 会裁掉浮层的那个祖先盒子的横向区间：往上找第一个 `overflow-x` 不是 `visible` 的（实测是
   * `.thread-main`）。为什么不用视口当判据：飞出卡越出它就被裁成半张，模型名前缀直接看不见。
   */
  const clipBoxOf = (el: HTMLElement): { left: number; right: number } => {
    let node: HTMLElement | null = el.parentElement
    while (node !== null) {
      if (getComputedStyle(node).overflowX !== 'visible') {
        const box = node.getBoundingClientRect()
        return { left: Math.max(0, box.left), right: Math.min(window.innerWidth, box.right) }
      }
      node = node.parentElement
    }
    return { left: 0, right: window.innerWidth }
  }

  /**
   * 悬浮（或 Tab 到、或点）一级某一行时：量一次面板与那一行的位置，决定飞出卡摆哪、多高。
   *
   * 为什么是量而不是 CSS：面板右缘对齐模型 chip，chip 宽度随模型名长短变、窗口宽度可拖，
   * 「两边各还剩多少」只有拿到 rect 才知道（ZCode 那边同样是 Radix 拿实测 rect 挑边）。
   * 量到的两个数写进 CSS 变量（`--flyout-top` / `--flyout-max`），样式只做展示。
   */
  const openFlyout = (providerName: string, row: HTMLElement | null): void => {
    setHoverProvider(providerName)
    const panel = modelPanelRef.current
    if (panel === null || row === null) return
    const panelBox = panel.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    setFlyoutSide(
      chooseFlyoutSide(
        { left: panelBox.left, right: panelBox.right },
        clipBoxOf(panel),
        FLYOUT_WIDTH,
      ),
    )
    // 高度上限先按面板本身给（卡片内容的自然高下一步在同一帧里量出来再修正）。
    setFlyout(
      placeFlyout(
        rowBox.top - panelBox.top,
        rowBox.bottom - panelBox.top,
        panelBox.height,
        Number.POSITIVE_INFINITY,
      ),
    )
  }

  /**
   * 飞出卡渲染出来之后，拿它内容的**自然高**把位置与上限修正一遍。
   *
   * 为什么必须修：`openFlyout` 那一步卡片还没进 DOM，只能用「无穷高」先占位，于是夹取退化成
   * 「对齐那一行」；卡片真高出来之后，靠近面板底部的那几行会把卡片推出面板底边——面板底边
   * 只离输入行 10px，推出去就盖住输入框。`useLayoutEffect` 在绘制前跑完，所以这一修不带闪烁。
   */
  useLayoutEffect(() => {
    if (hoverProvider === null) return
    const panel = modelPanelRef.current
    const card = flyoutCardRef.current
    if (panel === null || card === null) return
    const row = panel.querySelector<HTMLElement>(`[data-model-provider="${CSS.escape(hoverProvider)}"]`)
    if (row === null) return
    const panelBox = panel.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    const next = placeFlyout(
      rowBox.top - panelBox.top,
      rowBox.bottom - panelBox.top,
      panelBox.height,
      card.scrollHeight,
    )
    setFlyout((prev) =>
      prev !== null && prev.top === next.top && prev.maxHeight === next.maxHeight ? prev : next,
    )
  }, [hoverProvider, models.length, flyoutSide, measureTick])

  /**
   * 面板开着时盯着「会改变它位置的东西」：窗口缩放、面板自身宽高变化（两套宽度就在这儿切）。
   *
   * `ResizeObserver` 而不是只听 `resize`：面板从 `flat`（264）换成两级（320）时窗口没动，
   * 只有盒子变了，只听窗口事件接不到这一拍。
   */
  useLayoutEffect(() => {
    if (!modelOpen) return undefined
    const panel = modelPanelRef.current
    if (panel === null) return undefined
    const bump = (): void => {
      setMeasureTick((tick) => tick + 1)
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(bump)
    observer?.observe(panel)
    window.addEventListener('resize', bump)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', bump)
    }
  }, [modelOpen])

  /**
   * 面板开着的期间随时把它推回正文列里（窄屏输入行换行时 chip 可能贴在很左边）。
   *
   * `useLayoutEffect` 而不是 `useEffect`：推之前在绘制前算完，不然会先闪一帧「半张面板在视口外」。
   */
  useLayoutEffect(() => {
    if (!modelOpen) return
    const panel = modelPanelRef.current
    if (panel === null) return
    const box = panel.getBoundingClientRect()
    // 量到的是**已经平移过**的位置：先减掉已施加的量再夹，否则每一拍都会把上一拍的平移
    // 当成「现在放得下」，平移被自己抵消、面板在两帧之间来回跳（重量一开必现）。
    const raw = { left: box.left - shiftRef.current, right: box.right - shiftRef.current }
    const shift = clampShift(raw, clipBoxOf(panel))
    shiftRef.current = shift
    setPanelShift((prev) => (prev === shift ? prev : shift))
  }, [modelOpen, models.length, twoLevel, measureTick])

  /**
   * 展开模型菜单时把当前项滚进视野（照分支菜单同款）。
   *
   * 为什么必须有：模型一多，当前那一条可能落在滚动区外面——「打开菜单看得见自己选的是谁」
   * 正是这次要修的东西，光打勾不够（勾在屏幕外等于没打）。
   */
  useEffect(() => {
    if (!modelOpen) return
    if (hoverProvider === null) return
    modelRows.current?.querySelector<HTMLElement>('[data-model-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [modelOpen, hoverProvider, models.length])

  /**
   * 模型行（飞出卡与「只有一个端点」的扁铺面板**共用同一份渲染**，不写两遍）。
   *
   * 行里四样东西都有用：模型名（身份）、能力徽标（图/视频）、上下文（256k）、当前那条的勾。
   */
  const modelRowList = (choices: readonly ModelChoiceView[]): ReactNode => {
    if (choices.length === 0) {
      return (
        <div className="pop-item">
          <span className="name">{models.length === 0 ? '清单没取到' : '这个端点还没有模型'}</span>
        </div>
      )
    }
    return choices.map((choice) => {
      const on = current.entry?.value === choice.value
      return (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={on}
          key={choice.value}
          className={`pop-item model-picker-row${on ? ' on' : ''}`}
          title={choice.description}
          data-model-current={on ? 'true' : undefined}
          onClick={() => {
            setModelOpen(false)
            onFault(null)
            void channel.invoke('setModel', [choice.value]).catch((reason: unknown) => {
              onFault(reason instanceof Error ? reason.message : String(reason))
            })
          }}
        >
          <span className="name">{choice.model}</span>
          {modelBadges(choice).map((badge) => (
            <span className="pop-badge" key={badge}>
              {badge}
            </span>
          ))}
          <span className="ctx">{contextLabel(choice.contextWindow)}</span>
          {/* 勾**始终占着那一格**（不是当前行才长出来）：读数这一列的右边界由它撑着，
              上下一对齐才不会因为「多了一个勾」整体错开一格。 */}
          <span className="model-picker-check">{on ? <IconCheck size={14} className="check" /> : null}</span>
        </button>
      )
    })
  }

  /** 完整形态的签名：换模型 / 清单变了 / 栏宽变了，都要重新掂一次端点前缀放不放得下。 */
  const chipMeasureKey = `${chip.full}|${String(models.length)}|${String(barWidth)}`

  /**
   * 端点前缀放不下就**整段收掉**（对照 ZCode 的 `composer-provider-compact`）。
   *
   * 为什么必须有：`.composer-zone` 封顶 `--dsc-thread-max`（76ch ≈ 531px），左组三颗 +
   * 档位 chip + 发送键之后，留给模型 chip 的只有一百多像素；而 `端点/模型` 两段字按这个
   * 种子要 224px。硬塞的结果是**两段都被截**——实机走查截出来是 `Dee… deepseek…`，
   * 等于什么都没说（这恰恰是用户报的那件事）。
   *
   * 口径：**模型名是身份，端点是出处**。放不下就只留名字（端点在菜单里带勾、在悬浮说明
   * 与 `aria-label` 里也有全称）。量的是**完整形态**（前缀还在场时量一次），收掉之后不再
   * 重量，所以不会来回抖；换模型、清单变了、栏宽变了再给完整形态一次机会。
   *
   * 为什么用 `useLayoutEffect` 而不是 `useEffect`：这两条要在**同一帧内**跑完（先归位成
   * 完整形态、再量一次决定收不收），否则会先画出一帧「两段都截半」的丑样子。
   * 顺序也重要：**归位那条必须排在测量那条前面**——反过来的话两者会在同一拍里互相覆盖
   * （先设 true 再被设回 false），实机走查第一版就是这么失效的。
   */
  useLayoutEffect(() => {
    setDropPrefix(false)
  }, [chipMeasureKey])

  useLayoutEffect(() => {
    if (dropPrefix) return
    const node = modelChipRef.current
    const bar = barRef.current
    if (node === null || bar === null) return
    const cut = (selector: string): boolean => {
      const el = node.querySelector<HTMLElement>(selector)
      return el !== null && el.scrollWidth > el.clientWidth + 1
    }
    // 栏本身溢出了也算「这一行装不下」：那时收掉前缀能实打实腾出几十像素。
    const tight = cut('.model-name') || cut('.composer-model-provider') || bar.scrollWidth > bar.clientWidth + 1
    if (tight) setDropPrefix(true)
  }, [dropPrefix, chipMeasureKey])

  /** 打开设置面板的「模型」分区（菜单底部那一行的落点）。 */
  const openModelsSettings = (): void => {
    window.dispatchEvent(new CustomEvent('shell.settings.open', { detail: { section: 'models' } }))
  }

  return {
    node: (
      <>
                    {/* 模型 chip（对照 ZCode 的模型选择器）：只回答「用哪个模型」，点开是**两级**菜单
                        （一级端点、二级该端点的模型，两级各自给当前项打勾）。思考强度是它右边
                        **另一颗** chip——旧版把两件事塞进同一张浮层，于是「当前选的是哪个模型、
                        哪一档」都得点开才知道（0.6.71 报障）。两颗各带自己的浮层，与另三根旋钮
                        同一套互斥口径（开一根把其余全收掉）。 */}
                    <div className="model-anchor">
                      <button
                        type="button"
                        ref={modelChipRef}
                        className={`model-btn composer-model-chip${modelOpen ? ' open' : ''}`}
                        title={`模型：${chip.full}（点开换）`}
                        aria-haspopup="menu"
                        aria-expanded={modelOpen}
                        aria-label={`当前模型 ${chip.full}`}
                        data-composer-model={current.entry?.value ?? chip.full}
                        onClick={() => {
                          setModelOpen((open) => !open)
                          // 每次开都是「只有一级那一列」的干净态（上次悬浮停在哪家不该带过来）。
                          setHoverProvider(null)
                          setFlyout(null)
                          shiftRef.current = 0
                          setPanelShift(0)
                          setEffortOpen(false)
                          // 另外三根旋钮交给父组件收（互斥）。
                          onTakeOver()
                        }}
                      >
                        <IconPackage size={13} />
                        {chip.prefix === '' || dropPrefix ? null : (
                          <span className="composer-model-provider">{chip.prefix}</span>
                        )}
                        <span className="model-name">{chip.name}</span>
                        <IconChevronDown size={12} />
                      </button>
                      {modelOpen ? (
                        <>
                          <div
                            className="pop-mask"
                            onClick={() => {
                              setModelOpen(false)
                            }}
                          />
                          <div
                            className={`model-pop model-picker${twoLevel ? '' : ' flat'}`}
                            role="menu"
                            aria-label="选择模型"
                            ref={modelPanelRef}
                            data-flyout-side={flyoutShown ? flyoutSide : undefined}
                            style={
                              panelShift === 0 ? undefined : ({ transform: `translateX(${String(panelShift)}px)` } as CSSProperties)
                            }
                            onMouseLeave={() => {
                              // 指针离开整张面板（飞出卡也是它的子节点，所以移进卡片不算离开）：
                              // 收起飞出卡，回到「只有一级那一列」——对照 ZCode 不悬浮就没二级。
                              setHoverProvider(null)
                              setFlyout(null)
                            }}
                          >
                            {/* 当前模型不在清单里时先说清楚（端点配置改过、或这条会话记住的模型下线了）：
                                否则用户只看到一片「一条都不打勾」的清单，不知道是谁不对。 */}
                            {current.entry === undefined && model !== '' ? (
                              <div className="pop-item model-unknown" data-model-unknown="true">
                                <span className="name">当前：{model} —— 清单里没有这个模型</span>
                              </div>
                            ) : null}
                            <div className="model-picker-body">
                              {twoLevel ? (
                                <div
                                  className="model-providers"
                                  data-model-providers=""
                                  /* 滚过之后那一行的位置变了，重量一次卡片才还贴着它。 */
                                  onScroll={() => {
                                    if (hoverProvider === null) return
                                    const row =
                                      modelPanelRef.current?.querySelector<HTMLElement>(
                                        `[data-model-provider="${CSS.escape(hoverProvider)}"]`,
                                      ) ?? null
                                    openFlyout(hoverProvider, row)
                                  }}
                                >
                                  {groups.length === 0 ? (
                                    <div className="pop-item">
                                      <span className="name">清单没取到</span>
                                    </div>
                                  ) : (
                                    groups.map((group) => {
                                      const owns = current.group?.provider === group.provider
                                      const hint = providerHint(group, current)
                                      return (
                                        <button
                                          type="button"
                                          role="menuitem"
                                          aria-current={owns}
                                          key={group.provider}
                                          className={`pop-item provider-row${group.provider === hoverProvider ? ' on' : ''}`}
                                          data-model-provider={group.provider}
                                          data-provider-current={owns ? 'true' : undefined}
                                          title={
                                            hint === ''
                                              ? `${group.displayName} · ${String(group.models.length)} 个模型`
                                              : `${group.displayName} · 当前 ${hint}`
                                          }
                                          /* 悬浮即飞出（不延迟：一级就几个端点，抖动风险不值得一个计时器）；
                                             键盘 Tab 到与手指点一下都走同一条路——触摸屏没有悬浮，
                                             只认悬浮就等于手机上一级点不开二级。 */
                                          onMouseEnter={(event) => {
                                            openFlyout(group.provider, event.currentTarget)
                                          }}
                                          onFocus={(event) => {
                                            openFlyout(group.provider, event.currentTarget)
                                          }}
                                          onClick={(event) => {
                                            openFlyout(group.provider, event.currentTarget)
                                          }}
                                        >
                                          <span className="name">{group.displayName}</span>
                                          <span className="model-picker-check">{owns ? <IconCheck size={13} className="check" /> : null}</span>
                                          <IconChevronRight size={12} className="provider-arrow" />
                                        </button>
                                      )
                                    })
                                  )}
                                </div>
                              ) : (
                                modelRowList(visibleModels)
                              )}
                            </div>
                            {/* 飞出卡：**面板的子节点**而不是另挂一份浮层——`mouseleave` 认 DOM 层级，
                                所以鼠标从厂商行横穿到卡片上不会把卡片关掉，不需要任何延迟计时器。
                                「盖住」那一档（`overlay`）不进绝对定位，而是**就地占位**：端点列已经藏了，
                                卡片就是面板此刻的内容——面板自己会按它长高，`管理模型` 仍留在下面，
                                也不需要任何量出来的位置。 */}
                            {flyoutShown ? (
                              <div
                                className={`model-flyout${flyoutSide === 'overlay' ? ' model-flyout-inline' : ''}`}
                                data-model-flyout=""
                                data-side={flyoutSide}
                                style={
                                  flyoutSide === 'overlay'
                                    ? undefined
                                    : ({
                                        '--flyout-top': `${String(flyout.top)}px`,
                                        '--flyout-max': `${String(flyout.maxHeight)}px`,
                                        '--flyout-w': `${String(FLYOUT_WIDTH)}px`,
                                      } as CSSProperties)
                                }
                              >
                                <div
                                  className="model-flyout-card"
                                  role="menu"
                                  aria-label={`${hoveredGroup.displayName} 的模型`}
                                  ref={flyoutCardRef}
                                >
                                  <div className="model-picker-rows" data-model-rows="" ref={modelRows}>
                                    {modelRowList(visibleModels)}
                                  </div>
                                </div>
                              </div>
                            ) : null}
                            <button
                              type="button"
                              className="pop-item model-manage"
                              data-model-manage=""
                              onClick={() => {
                                setModelOpen(false)
                                openModelsSettings()
                              }}
                            >
                              <span className="name">管理模型</span>
                            </button>
                          </div>
                        </>
                      ) : null}
                    </div>

                    {/* 思考档位 chip：读数取 status.effort（**不依赖模型清单**），所以清单过期也不会
                        显示错；刚点下去那一小段用乐观值顶（见 pendingEffort），免得数字先弹回去再跳过来。
                        档位清单里不再摆「默认」（它不是刻度上的位置，见 ./effort-slider 的文件头）。
                        单档模型不给浮层、也不给箭头。 */}
                    {switchEffort ? (
                      <div className="model-anchor model-anchor-sheet">
                        <button
                          type="button"
                          className={`model-btn composer-effort-chip${effortOpen ? ' open' : ''}`}
                          title={`思考强度：${effortText}（点开换档）`}
                          aria-haspopup="menu"
                          aria-expanded={effortOpen}
                          aria-label={`当前思考强度 ${effortText}`}
                          data-composer-effort={shownEffort}
                          onClick={() => {
                            setEffortOpen((open) => !open)
                            setModelOpen(false)
                            // 另外三根旋钮交给父组件收（互斥）。
                            onTakeOver()
                          }}
                        >
                          <IconBrain size={13} />
                          <span className="model-name">{effortText}</span>
                          <IconChevronDown size={12} />
                        </button>
                        {effortOpen ? (
                          <>
                            <div
                              className="pop-mask"
                              onClick={() => {
                                setEffortOpen(false)
                              }}
                            />
                            {/* 滑杆卡（2026-10-26 换掉原来那一列按钮）：档位有顺序，滑杆把顺序画出来。
                                选完不关卡片：拖着扫档时关掉，等于每试一档都要重开一次。 */}
                            <div className="model-pop effort-pop" role="group" aria-label="思考强度">
                              <EffortSlider
                                levels={sliderLevels}
                                value={shownEffort}
                                note={
                                  current.entry === undefined && model !== ''
                                    ? '模型不在清单里，列的是它声明的全部档位'
                                    : null
                                }
                                onCommit={commitEffort}
                              />
                            </div>
                          </>
                        ) : null}
                      </div>
                    ) : (
                      <span
                        className="model-btn composer-effort-chip fixed"
                        title={`思考强度：${effortText}（这个模型没有可切换的档位）`}
                        data-composer-effort={effort}
                      >
                        <IconBrain size={13} />
                        <span className="model-name">{effortText}</span>
                      </span>
                    )}
      </>
    ),
    allowImage: imageInputAllowed,
    close: () => {
      setModelOpen(false)
      setEffortOpen(false)
    },
    barRef,
  }
}
