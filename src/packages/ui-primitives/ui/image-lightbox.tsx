/**
 * 贴图放大浮层：输入框上方那排待发贴图，点一下开大图，点遮罩或按 Esc 关。
 *
 * 为什么需要自己画这一层：待发贴图是用户当场贴/拖进来的本地文件，界面手上只有
 * dataURL（`data:image/png;base64,…`）。浏览器禁止页面顶层导航到 `data:` 地址，所以
 * 「外面套一个 `<a target="_blank">` 点开」这条路走不通；dataURL 也没有文件路径，
 * 交给系统图片查看器同样没门。旧界面本来就有这个浮层，移植到壳的时候只把样式留下了
 * （`.img-lightbox`，见 `ui-shell/src/legacy/views.css`），组件本身没搬过来——所以缩略图
 * 就只剩缩略图。这里把组件补回来，视觉仍用那一份现成样式，不新造一套。
 *
 * 已发消息里的贴图不走这里：那些是宿主的同源地址（`/api/attachments/<sha>`），
 * 普通链接就能开。
 *
 * @module dsc-ui-shell/ui-primitives/image-lightbox
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function ImageLightbox(props: { src: string; alt: string; onClose(): void }): ReactNode {
  const { onClose } = props
  /**
   * 打开时焦点所在的节点。关闭（卸载）时还回去，键盘用户不会因为看了一眼大图
   * 就被扔回页面开头。
   */
  const opener = useRef<Element | null>(null)

  useEffect(() => {
    opener.current = document.activeElement
    return () => {
      const node = opener.current
      // 只在那个节点还在文档里时还：附件可能在上传失败 / 会话切换时已经被移除，
      // 往一个脱离文档的节点上 focus 不会有任何效果，反倒让人以为焦点丢了。
      if (node instanceof HTMLElement && node.isConnected) node.focus()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  // 挂到 body：输入区祖先里有 `overflow: hidden` 与圆角，浮层留在里面会被裁掉。
  return createPortal(
    <div
      className="img-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="放大查看贴图"
      onClick={onClose}
    >
      {/* 图片本身不拦事件：点图、点遮罩都关（与旧界面「点任意处关」一致）。 */}
      <img src={props.src} alt={props.alt} />
    </div>,
    document.body,
  )
}
