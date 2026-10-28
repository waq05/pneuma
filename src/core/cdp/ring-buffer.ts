/**
 * 定长环形缓冲：满了丢最旧的，条数上限变了就把内容搬过去。
 *
 * 用在浏览器的控制台与网络事件缓冲上——`plugins/browser.ts` 那台自管 Chrome 两个桶，
 * `plugins/dock-browser.ts` 每台侧栏视图各两个桶。两处原先各抄了一份，抄的那份
 * 少了 `resize`；这里按完整版留住：用户改个设置不该把已经攒下的现状丢光。
 *
 * 只放数据结构，不放「什么算一条事件」——那是 {@link module:dsc/core/cdp/report} 的事。
 *
 * @module dsc/core/cdp/ring-buffer
 */

export class RingBuffer<T> {
  private items: T[] = []

  constructor(private capacity: number) {}

  /** 当前条数。 */
  get size(): number {
    return this.items.length
  }

  push(item: T): void {
    this.items.push(item)
    if (this.capacity > 0 && this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity)
    }
  }

  /** 按条件找一条（网络条目要按 requestId 回填状态）。 */
  find(predicate: (item: T) => boolean): T | undefined {
    return this.items.find(predicate)
  }

  toArray(): T[] {
    return [...this.items]
  }

  clear(): void {
    this.items = []
  }

  /** 容量变了：先换上限再截断，已经攒下的内容不会被清掉。 */
  resize(capacity: number): void {
    this.capacity = capacity
    if (capacity > 0 && this.items.length > capacity) this.items.splice(0, this.items.length - capacity)
  }
}
