/**
 * 原生桥的读面：桌面窗口里 preload 会挂一个 `window.dscNative`（一条极窄的原生能力通道：
 * 窗口控件区颜色、原生弹层深浅、系统对话框、通知、退出/重启…，规格见
 * `core/native-bridge.ts`，宿主与壳共用那一份）。浏览器与远程壳里**没有**这个对象——
 * 插件因此必须把"没有原生能力"当常态处理，而不是当异常。
 *
 * 为什么住基元包（E4 收尾）：`getHostNative` 原来是 `@dsc/ui`（`plugin-api.ts`）里实现的，
 * 而 `ui-layout` 的 appearance / review-pane / app 也要用它——于是「下面的包引 `@dsc/ui`、
 * `@dsc/ui` 又转出 `ui-layout`」，包间成环。桥的读面本质是平台层的东西（与 React/DOM
 * 打交道、不碰槽位与插件 API），下沉到基元包之后 `@dsc/ui` 只是把它转出，
 * `ui-layout` 从下面取，环没了。
 *
 * @module dsc-ui-shell/ui-primitives/native
 */
import { useMemo } from 'react'
import { NATIVE_BRIDGE_VERSION, type NativeEvent, type NativeOp } from '@dsc/ui-core'

/** 桥缺席时给插件的一句话（浏览器里就是这样：没有 Electron，也就没有原生桥）。 */
export const NATIVE_UNAVAILABLE = '这条能力来自桌面外壳的原生桥，浏览器里没有它'

/** 原生桥的调用面。 */
export interface HostNative {
  /** 桥在不在：桌面窗口里 true，浏览器 / 远程壳里 false。 */
  readonly available: boolean
  /** 桥的协议版本；缺席时 null。壳拿它跟自己的规格对一下，不一致可以在诊断区说明白。 */
  readonly version: number | null
  /**
   * 调一个原生操作。
   *
   * 桥缺席时返回**拒绝的 Promise**（而不是同步抛）：调用点因此可以统一写一个 try/catch，
   * 不必先判 available 再包一层。
   */
  invoke<T = unknown>(op: NativeOp, args?: readonly unknown[]): Promise<T>
  /**
   * 订阅桥推上来的事件（现在只有终端输出流）。
   *
   * 与 `invoke` 的取向不同：桥缺席时**返回一个空的退订函数**，不抛也不拒。
   * 理由是这类订阅都写在组件的 `useEffect` 里——"浏览器里没有终端"不该让插件崩，
   * 只该让它收不到东西（订阅本身没有"失败"这个语义）。
   */
  on(event: NativeEvent, listener: (data: unknown) => void): () => void
}

/** `window.dscNative` 在页面上的形状（preload 暴露的那个对象）。 */
interface NativeBridgeGlobal {
  version?: unknown
  call?: (op: string, args: unknown[]) => Promise<unknown>
  on?: (event: string, listener: (data: unknown) => void) => () => void
}

/** 读一次全局对象；形状不对就当桥不在（宁可降级，也不要调到一个半残的对象）。 */
function bridgeGlobal(): NativeBridgeGlobal | null {
  const value = (globalThis as { dscNative?: unknown }).dscNative
  if (value === null || typeof value !== 'object') return null
  const record = value as NativeBridgeGlobal
  return typeof record.call === 'function' ? record : null
}

/**
 * 取原生桥。插件这样用：
 *
 *     const native = useHostNative()
 *     if (!native.available) return <p>这条能力只在桌面版里有</p>
 *     await native.invoke('openPath', ['D:\\dsc'])
 *
 * 每次调用都重新读一遍全局对象：自检会在同一个页面里把桥拿掉再调一次（验证降级那条路），
 * 缓存下来就把结论钉死了。读一个对象引用是常数开销，不值得为它冒这个险。
 */
export function getHostNative(): HostNative {
  const bridge = bridgeGlobal()
  const listeners = bridge?.on
  return {
    available: bridge !== null,
    version: bridge === null ? null : typeof bridge.version === 'number' ? bridge.version : NATIVE_BRIDGE_VERSION,
    invoke<T = unknown>(op: NativeOp, args: readonly unknown[] = []): Promise<T> {
      if (bridge === null) return Promise.reject(new Error(NATIVE_UNAVAILABLE))
      return bridge.call!(op, [...args]) as Promise<T>
    },
    on(event: NativeEvent, listener: (data: unknown) => void): () => void {
      if (listeners === undefined) return () => undefined
      return listeners(event, listener)
    },
  }
}

/**
 * {@link getHostNative} 的 hook 形态（桥在页面生命周期内不会出现/消失，所以取一次就够）。
 * 需要"桥回来了要重画"的场景才用它，否则直接调 `getHostNative()` 更省。
 */
export function useHostNative(): HostNative {
  return useMemo(() => getHostNative(), [])
}
