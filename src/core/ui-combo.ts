/**
 * combo 的**宿主侧精确表**：一个批一条地址，地址即内容。
 *
 * 与参考实现同一形状（也是不解析请求的原因之一）：宿主在组图时把每个批的
 * 「URL → 惰性体」登记进表，路由只按 `pathname + search` 精确命中；**未登记的组合一律 404**。
 * 不做通用 combo 解析除了与参考实现同口径，还顺手焊死一条缝：请求里的 id 列表永远不会
 * 决定读哪些文件（否则 `??../../x/client.js` 就是一条任意文件读取），成员集合只能来自
 * `collectUiArtifactsForPlatform` 这唯一口子。
 *
 * 为什么保留「上一代」：批地址带 rev，插件重建后已经打开、还没刷新的页面手上还是旧批地址，
 * 它的下一次请求必须还能拿到旧字节（与单资源的旧一代同一纪律，见 `core/ui-route.ts` 头注释）。
 * 单资源的旧字节靠产物表里「当初服务过就留着」，批成员没有单资源记录——所以批体只能在换代时
 * 由宿主把上一代表整份留一代（内存里几百 KB，可接受）。
 *
 * @module dsc/core/ui-combo
 */

/** 一个批登记进表的东西：绝对路由 URL + 批 rev + 拼好的字节。 */
export interface UiComboBatchBody {
  /** 绝对路由地址（`/plugins/??…&rev=…`），不是图里那份 document-relative。 */
  url: string
  rev: string
  body: Buffer
}

/** 一次 combo 命中的结果。 */
export interface UiComboLookup {
  /** `current` = 当下这一代；`previous` = 刚被换掉的那一代。 */
  hit: 'current' | 'previous'
  size: number
  body: Buffer | null
}

/** 拼批体：成员字节顺序拼接。每段 bundle 自带 `;\n` 结尾，中间插一个换行纯属防御。 */
export function joinComboParts(parts: readonly Buffer[]): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    if (chunks.length > 0) chunks.push(Buffer.from('\n'))
    chunks.push(part)
  }
  return Buffer.concat(chunks)
}

/** 批与单资源共用的「当前代 + 上一代」表。 */
export class UiComboTable {
  private current = new Map<string, UiComboBatchBody>()
  private previous = new Map<string, UiComboBatchBody>()

  /**
   * 换上一代：旧的当前代整份挪进「上一代」（只留一代，与参考实现同口径），
   * 更早的那一代就此作废。
   */
  replace(batches: readonly UiComboBatchBody[]): void {
    this.previous = this.current
    this.current = new Map(batches.map((batch) => [batch.url, batch]))
  }

  /** 按精确 URL 查（缺地址就是未登记的组合）。 */
  lookup(url: string, wantBody: boolean): UiComboLookup | null {
    const current = this.current.get(url)
    if (current !== undefined) {
      return { hit: 'current', size: current.body.length, body: wantBody ? current.body : null }
    }
    const previous = this.previous.get(url)
    if (previous !== undefined) {
      return { hit: 'previous', size: previous.body.length, body: wantBody ? previous.body : null }
    }
    return null
  }

  /** 现在登记的批地址（诊断与探针读数）。 */
  urls(): { url: string; rev: string }[] {
    return [...this.current.values()].map((batch) => ({ url: batch.url, rev: batch.rev }))
  }
}
