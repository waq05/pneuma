/**
 * git 插件：把「当前工作区的分支 + 改动计数」登记成快照面（`surfaces.git`），并提供
 * `git` 服务（写类 op 落盘后催拍一拍，见 `desktop-dock` 的接线）。
 *
 * ## 为什么这片读数住在宿主
 *
 * 输入框上那颗分支钮（壳 `plugins/composer`）要**一直**显示当前分支，状态面板的
 * 「Git 工具」区也有同一行分支与改动数。界面自己各拉一次 `dock git-status` 的话，同一份
 * 读数就是每个组件一拍；宿主的快照面是「谁要谁来读」的那一处（与 goal / todos / plan
 * 这些面同一套）。
 *
 * 这一片是**轻读**：一条分支名 + 一条 `git status --porcelain -z`（只数条数）。状态面板
 * 那条重读（`stats: true`：还要每文件增删行数、未跟踪文件按内容数行）留在壳里按它自己
 * 更松的节奏走——两处要的东西本来就不同（这里要的是「哪个分支、脏不脏」）。
 *
 * ## 节奏与「没人看就不拍」
 *
 * 拍一拍按三档走（有改动 12s / 干净 30s / 不是仓库 60s），另有事件催拍：回合收工、换会话、
 * 写类 git op 落盘。但**只有界面真的连着时才拍**——快照的 `read()` 只在有人连着界面时发生
 * （`core/ui-events.ts`：没有连接就不造帧），所以「这一片最近被读过」就是「界面活着」的
 * 代理。CLI / TUI 会话里没人看这颗钮，每 12 秒跑一次 `git status` 是纯浪费 CPU。
 *
 * @module dsc/plugins/git
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { git, parsePorcelainZ, repoPrefix, toWorkspacePath } from '../core/git-exec.js'
import type { GitSurface } from '../contract.js'
import type { GitService } from '../services/types.js'

/** 空读数（不是仓库 / 还没读到）：界面按「整块不画」处理。 */
const EMPTY_GIT: GitSurface = { repo: false, branch: '', detached: false, dirtyFileCount: 0 }

/** 三档节奏（毫秒）：与状态面板同一套（有改动最勤，不是仓库最松）。 */
const POLL_DIRTY_MS = 12_000
const POLL_CLEAN_MS = 30_000
const POLL_IDLE_MS = 60_000
/**
 * 「界面还活着」的窗口（毫秒）：这么久没人读过这一片就不拍了。
 * 比最慢那一档（60s）短是故意的——窗口只用来判断「还有没有人要这个读数」，
 * 真正的节奏在 {@link POLL_DIRTY_MS} 那三档里。
 */
const INTEREST_MS = 20_000
/** 没界面时的巡检节拍（毫秒）：只问一句「有人来了吗」，不跑 git。 */
const IDLE_TICK_MS = 5_000

export const gitPlugin: Plugin.Object = {
  name: 'git',
  inject: ['session', 'surfaces'],
  provide: 'git',
  apply(ctx) {
    let cache: GitSurface = EMPTY_GIT
    /** 这一片最后一次被快照读走的时刻（0 = 从没有人读过 = 没有界面连着）。 */
    let lastReadAt = 0
    /** 最后一次真跑过 git 的时刻（0 = 还没跑过）：用来判断手上的读数过没过期。 */
    let fetchedAt = 0
    let timer: NodeJS.Timeout | null = null
    /** 定时器已排到哪个时刻：催拍与定时器相遇时只跑一次，不重排到更晚。 */
    let dueAt = 0
    /** 一拍还在跑时不再起第二拍（git 慢的时候）。 */
    let busy = false

    const schedule = (ms: number): void => {
      const at = Date.now() + ms
      if (timer !== null && at >= dueAt) return
      if (timer !== null) clearTimeout(timer)
      dueAt = at
      timer = setTimeout(() => {
        timer = null
        void tick()
      }, ms)
    }

    /** 读一拍：分支名 + 改动条数。读不动（不是仓库 / git 不在 / 目录没了）按空读数记。 */
    const read = async (): Promise<void> => {
      const cwd = ctx.session.current().meta.cwd
      let next: GitSurface
      try {
        // 先问一句「这儿是不是仓库」：不然「不是仓库」与「空仓库（还没提交过）」
        // 是同一种失败（`rev-parse --abbrev-ref HEAD` 两边都报错），分不开。
        await git(cwd, ['rev-parse', '--git-dir'], 5000)
        const head = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
          .then((out) => out.trim())
          .catch(() => '')
        const detached = head === 'HEAD'
        const branch = detached
          ? await git(cwd, ['rev-parse', '--short', 'HEAD']).then((out) => out.trim()).catch(() => 'HEAD')
          : head === ''
            ? '(无提交)'
            : head
        const prefix = await repoPrefix(cwd)
        const porcelain = await git(cwd, ['status', '--porcelain=v1', '-z'])
        // 条数按**工作目录内**算（与「变更」页签、状态面板那条读同一个口径）：
        // 仓库根在会话工作目录之上时，别把外面的改动数进来。
        const dirtyFileCount = parsePorcelainZ(porcelain).filter(
          (entry) => toWorkspacePath(entry.file, prefix) !== null,
        ).length
        next = { repo: true, branch, detached, dirtyFileCount }
      } catch {
        next = EMPTY_GIT
      }
      const changed = !sameGit(cache, next)
      cache = next
      fetchedAt = Date.now()
      // 读数变了就推一帧：界面读的是快照（不是推事件），不广播的话这颗钮要等到
      // 下一次别的原因引起的推帧才更新。
      if (changed) ctx.emit('dsc/changed')
      schedule(next.repo === false ? POLL_IDLE_MS : next.dirtyFileCount > 0 ? POLL_DIRTY_MS : POLL_CLEAN_MS)
    }

    const tick = async (): Promise<void> => {
      if (busy) return
      // 没人读过这一片（没有界面连着）：只留一条便宜的巡检，不跑 git。
      if (Date.now() - lastReadAt > INTEREST_MS) {
        schedule(IDLE_TICK_MS)
        return
      }
      busy = true
      try {
        await read()
      } finally {
        busy = false
      }
    }

    /** 催拍：写类 op 落了盘 / 回合收工 / 换了会话，立刻重取（界面正盯着的那一刻）。 */
    const refresh = (): void => {
      schedule(0)
    }

    const service: GitService = {
      snapshot(): GitSurface {
        return cache
      },
      refresh,
    }
    ctx.provide('git', service)

    // 界面要的那一片：读的时候**顺便记一笔「有人要」**（这就是上面 INTEREST_MS 的判据），
    // 并且按需补一拍——两种情况必须当场拍，不能等下一个巡检：
    //   1. 这一片第一次被读（界面刚连上）：这一拍决定那颗钮**出不出现**，等 5 秒的巡检
    //      就是「打开窗口后半天没有这颗钮」（实机走查抓到的正是这一条）；
    //   2. 读数已经过期（停过一阵又有人来读）：慢档那一档（30s）之后回来的一帧说明
    //      「界面又来要了」，此刻手上的值已经过时。
    ctx.surfaces.register('git', (): GitSurface => {
      const now = Date.now()
      const first = lastReadAt === 0
      lastReadAt = now
      if (first || now - fetchedAt > POLL_CLEAN_MS) schedule(0)
      return cache
    })

    // 三处催拍：回合收工（这一轮可能落了文件/切了分支）、换会话（换了工作区）、
    // 以及写类 git op 自己调 refresh()（那条在 desktop-dock 里）。
    ctx.on('dsc/turn-end', refresh)
    ctx.on('dsc/session-open', refresh)
  },
}

/** 两份读数是不是同一份（变了才推帧，免得干净仓库每 30 秒白推一帧）。 */
function sameGit(left: GitSurface, right: GitSurface): boolean {
  return (
    left.repo === right.repo &&
    left.branch === right.branch &&
    left.detached === right.detached &&
    left.dirtyFileCount === right.dirtyFileCount
  )
}
