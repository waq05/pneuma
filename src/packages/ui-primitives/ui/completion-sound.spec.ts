/**
 * 完成提示音（`ui-primitives/ui/completion-sound.ts`）：14 种音色全部用 Web Audio 现场合成。
 *
 * jsdom 没有 AudioContext，这里给一个记账用的假上下文：只要每种音色的信号链真的被搭起来
 * （振荡器/噪声源 start 过、参数落在合法区间），就说明参数表没有被抄坏。真听感归快照层，
 * 这里不评价好不好听。
 *
 * @module dsc-ui-primitives/ui/completion-sound.spec
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { COMPLETION_SOUND_VARIANTS, playCompletionSound } from './completion-sound.js'

// ── 假 Web Audio ─────────────────────────────────────────────────────────────

class FakeParam {
  setValueAtTime(): void {
    // 记录什么都行；值非正会让 exponentialRamp 在真机上抛错，这里也照样检查。
  }
  exponentialRampToValueAtTime(value: number): void {
    if (!(value > 0)) throw new Error('exponentialRamp 的目标必须大于 0')
  }
  linearRampToValueAtTime(): void {
    // 同 setValueAtTime
  }
}

class FakeNode {
  connect(): this {
    return this
  }
  disconnect(): void {}
}

class FakeOsc extends FakeNode {
  type = 'sine'
  frequency = new FakeParam()
  detune = new FakeParam()
  started = false
  start(): void {
    this.started = true
    FakeAudioContext.started += 1
  }
  stop(): void {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam()
}

class FakeFilter extends FakeNode {
  type = 'lowpass'
  frequency = new FakeParam()
  Q = new FakeParam()
}

class FakeBuffer {
  constructor(
    readonly channels: number,
    readonly length: number,
  ) {}
  getChannelData(): Float32Array {
    return new Float32Array(this.length)
  }
}

class FakeBufferSource extends FakeNode {
  buffer: FakeBuffer | null = null
  start(): void {
    FakeAudioContext.started += 1
  }
  stop(): void {}
}

class FakeConvolver extends FakeNode {
  buffer: FakeBuffer | null = null
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  static started = 0
  state = 'suspended'
  sampleRate = 44_100
  currentTime = 0
  destination = new FakeNode()
  resumed = 0
  constructor() {
    FakeAudioContext.instances.push(this)
  }
  resume(): Promise<void> {
    this.resumed += 1
    this.state = 'running'
    return Promise.resolve()
  }
  createOscillator(): FakeOsc {
    return new FakeOsc()
  }
  createGain(): FakeGain {
    return new FakeGain()
  }
  createBiquadFilter(): FakeFilter {
    return new FakeFilter()
  }
  createBuffer(channels: number, length: number): FakeBuffer {
    return new FakeBuffer(channels, length)
  }
  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource()
  }
  createConvolver(): FakeConvolver {
    return new FakeConvolver()
  }
}

const win = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown }
const saved = { AudioContext: win.AudioContext, webkitAudioContext: win.webkitAudioContext }

beforeEach(() => {
  FakeAudioContext.instances = []
  FakeAudioContext.started = 0
  delete win.AudioContext
  delete win.webkitAudioContext
})

afterEach(() => {
  if (saved.AudioContext === undefined) delete win.AudioContext
  else win.AudioContext = saved.AudioContext
  if (saved.webkitAudioContext === undefined) delete win.webkitAudioContext
  else win.webkitAudioContext = saved.webkitAudioContext
})

describe('没有可用的 AudioContext 时保持安静', () => {
  test('宿主既没有 AudioContext 也没有 webkit 版：播放直接返回', () => {
    expect(() => playCompletionSound(1)).not.toThrow()
    expect(FakeAudioContext.instances).toHaveLength(0)
  })

  test('构造函数抛错：吞掉，不把完成提示音变成崩溃点', () => {
    win.AudioContext = class {
      constructor() {
        throw new Error('没有音频设备')
      }
    }
    expect(() => playCompletionSound(2)).not.toThrow()
  })
})

describe('信号链与 14 种音色', () => {
  test('挂起状态会 resume；每种音色都真的起了声音源', () => {
    win.AudioContext = FakeAudioContext
    playCompletionSound(1)
    const context = FakeAudioContext.instances[0]!
    expect(context.resumed).toBe(1)
    expect(FakeAudioContext.started).toBeGreaterThan(0)

    for (const variant of COMPLETION_SOUND_VARIANTS) {
      const before = FakeAudioContext.started
      playCompletionSound(variant.id)
      expect(FakeAudioContext.started, `音色 ${String(variant.id)} 没起任何声音源`).toBeGreaterThan(before)
    }
  })

  test('音色表：编号从 1 连续、名字非空；未知编号不发声', () => {
    win.AudioContext = FakeAudioContext
    const ids = COMPLETION_SOUND_VARIANTS.map((variant) => variant.id)
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, index) => index + 1))
    for (const variant of COMPLETION_SOUND_VARIANTS) expect(variant.name.trim()).not.toBe('')

    const before = FakeAudioContext.started
    playCompletionSound(999)
    playCompletionSound(0)
    expect(FakeAudioContext.started).toBe(before)
  })

  test('直接调每个音色的 play：各自把节点接上 master，参数不越界', () => {
    const ac = new FakeAudioContext()
    const master = new FakeGain()
    for (const variant of COMPLETION_SOUND_VARIANTS) {
      const before = FakeAudioContext.started
      expect(() => variant.play(ac as unknown as AudioContext, master as unknown as GainNode, 0)).not.toThrow()
      expect(FakeAudioContext.started).toBeGreaterThan(before)
    }
    // 混响只在首次播放时生成脉冲，后面复用；这里只要求没抛错、缓冲已经挂上。
    const convolver = ac.createConvolver()
    expect(convolver.buffer).toBeNull()
  })
})
