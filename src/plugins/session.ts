/**
 * session 插件：provide `session` 服务（当前会话 + 列表缓存 + 会话库操作）。
 * 逻辑迁自 v2 adapter/core-runtime 的初始会话/openSessionNow/refreshSessions 段。
 * 会话切换与错误提示走 dsc/session-open、dsc/notice 事件（避免与 transcript 循环依赖）。
 *
 * 列表操作（归档、恢复、永久删除、改名、置顶、分叉）只动磁盘文件与
 * `sessions/meta.json` sidecar，不碰 jsonl 本体，也不改当前会话的状态机。
 *
 * @module dsc/plugins/session
 */
import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import {
  Session,
  archiveSession,
  archivedRoot,
  countTrashFiles,
  forkSession,
  listArchivedSessions,
  listSessions,
  loadLastSessionPath,
  purgeSession,
  readUserMessages,
  restoreSession,
  saveLastSession,
  trashRoot,
} from '../core/session.js'
import { patchSessionMeta } from '../core/session-meta.js'
import { uuidOf, type SessionListItem } from '../core/session.js'
import { errText } from '../adapter/transcript.js'
import type {
  ArchivedPage,
  SessionForkResult,
  SessionOpenPayload,
  SessionService,
  SessionSummary,
  SettingsMutation,
} from '../services/types.js'

export interface SessionPluginOptions {
  cwd?: string
  /** 'auto' = last-session 指针；路径 = 指定 jsonl；null = 新建。 */
  resumeSessionPath?: string | null
}

export const sessionPlugin: Plugin.Object<SessionPluginOptions> = {
  name: 'session',
  provide: 'session',
  apply(ctx, options) {
    // 宿主启动目录：只是**兜底**（会话自己带 cwd，见 `open` 的说明与 core/session 的 meta.cwd）。
    const startupCwd = options.cwd ?? process.cwd()

    // ---- 初始会话（同步确定；resume 失败回退新会话并记 startupNote） ----
    let session: Session
    let startupNote: string | null = null
    const resume = options.resumeSessionPath ?? null
    const pointer = resume === 'auto' ? loadLastSessionPath() : resume
    // 指针可能指向一个从没发过消息、因此没在磁盘上留过文件的会话：这种情况安静地开新会话
    const resumePath = pointer !== null && existsSync(pointer) ? pointer : null
    try {
      session = resumePath !== null ? Session.load(resumePath) : Session.create(startupCwd)
    } catch (error) {
      session = Session.create(startupCwd)
      startupNote = `恢复会话失败（${errText(error)}），已开新会话`
    }
    saveLastSession(session)
    const resumedStartup = startupNote === null && resumePath !== null

    // ---- 会话列表缓存 ----
    let sessions: SessionSummary[] = []
    let loading = false

    const service: SessionService = {
      current() {
        return session
      },
      get sessions() {
        return sessions
      },
      get loading() {
        return loading
      },
      get resumedStartup() {
        return resumedStartup
      },
      get startupNote() {
        return startupNote
      },
      async open(filePath?: string, cwd?: string) {
        // 已经在看这条会话：no-op（对齐 dsh 的会话实例常驻 + openState 短路）。
        // 重开一遍不是无害的刷新——它会重建 Session（加载时的中断修复给还在跑的回合
        // 补「结果未知」合成件），紧接着把正在跑的 agent 的会话顶掉，日志里同一 callId
        // 就可能留下两条结果。点击自己正在看的会话要老老实实什么都不做。
        if (filePath !== undefined && filePath === session.filePath) return
        // 目录是会话自己的数据（写进 jsonl 的 meta 行），所以在这里挑一个新目录
        // **不需要**重启宿主——与 dsh 同一形状：目录跟着会话走，进程目录只是兜底。
        // 只有新建会话（没给 filePath）时才看它；给了 filePath 时忽略（那条会话
        // 的目录是它出生时写下的，改不了也不该改）。
        let dir: string | null = null
        if (filePath === undefined) {
          // 界面指了目录就必须先过「可用」这一关（不合法当场抛，界面拿得到原因）；
          // 没指 = 落在你正在看的这条会话的目录里（dsh 的「当前工作区」口径），
          // 而不是宿主进程碰巧启动时的那个目录。
          dir =
            cwd !== undefined && cwd !== ''
              ? usableDir(cwd)
              : session.meta.cwd !== ''
                ? session.meta.cwd
                : startupCwd
        }
        try {
          // 常驻 agent 还攥着这条会话（后台回合在跑/刚切走没多久）：直接复用那个
          // 实例——再 Session.load 一遍既拿不到写租约（agent 正攥着），又会造出
          // 同一文件的两个内存副本。0.6.48 常驻多 agent 的关键接缝。
          const next =
            filePath === undefined
              ? Session.create(dir ?? startupCwd)
              : (ctx.get('agent')?.sessionFor(filePath) ?? Session.load(filePath))
          session = next
          saveLastSession(session)
          ctx.emit('dsc/session-open', { session: next, filePath } satisfies SessionOpenPayload)
        } catch (error) {
          ctx.emit('dsc/notice', `会话打开失败：${errText(error)}`)
        }
        ctx.emit('dsc/changed')
      },
      async refresh() {
        loading = true
        ctx.emit('dsc/changed')
        try {
          // 归档区的会话也进这份缓存：侧栏的「筛选会话」要能原地在活动区与归档区之间切，
          // 由面板按 archivedAt 决定显示哪些。归档相关的写操作仍只认活动区路径。
          const listed = [
            ...listSessions().map((item) => toSummary(item)),
            ...listArchivedSessions().map((item) => toSummary(item, item.archivedAt ?? item.updatedAt)),
          ]
          // 还没发过消息的当前会话：给它一行看得见的回执（点「新会话」不该像没反应）。
          //
          // 只补**当前**这一条：它一旦不是当前会话就既没内容也没稳定身份，列表里不该留着
          // ——这正是 2026-10-29 那次「点几次堆几行」要的结果。当时删的是“补行”，真正
          // 的病灶（每次新建都在磁盘上建空壳文件）已经由 `Session` 的 pendingState 修掉
          // （`src/core/session.ts` 的 write()），所以这行可以回来了。
          if (!session.persisted && !listed.some((item) => item.id === session.filePath)) {
            listed.unshift({
              id: session.filePath,
              cwd: session.meta.cwd,
              createdAt: session.meta.createdAt,
              updatedAt: session.meta.createdAt,
              unsaved: true,
            })
          }
          sessions = listed
        } catch (error) {
          ctx.emit('dsc/notice', `会话列表读取失败：${errText(error)}`)
        }
        loading = false
        ctx.emit('dsc/changed')
      },

      // ── 会话库操作（归档 / 恢复 / 删除 / 改名 / 置顶 / 分叉） ──────────────
      async archive(paths) {
        const blocked = paths.filter((path) => path === session.filePath)
        if (blocked.length > 0) return { ok: false, error: '当前打开的会话不能归档，先切到别的会话' }
        const agent = ctx.get('agent')
        const done: string[] = []
        const failed: string[] = []
        for (const path of paths) {
          // 重试收敛：上次批量归档半途而废时，已归档的（在归档区里，或已从原位置挪走）
          // 跳过不算失败也不重复报错
          if (path.startsWith(archivedRoot() + '\\') || path.startsWith(archivedRoot() + '/')) continue
          if (!existsSync(path)) continue
          try {
            // 常驻 agent 先收摊再挪文件（对齐 dsh 的 stopActivity）：后台在跑的会话
            // 握着打开的写流，直接 rename 是原生 EPERM，整批跟着炸。
            await agent?.stop(path)
            archiveSession(path)
            done.push(path)
          } catch (error) {
            failed.push(`${basename(path)}（${errText(error)}）`)
          }
        }
        // 挪走文件之后必须自己重扫一次列表缓存（refresh 会发 dsc/changed，宿主据此推
        // 快照，侧栏与选择器读的就是这份缓存）：漏了这一步，归档成功的会话仍按活动区
        // 留在侧栏，组菜单的「删除工作区」看着像没生效（0.6.49 报障）。失败一半也要扫，
        // 已经挪走的那部分同样不该再出现在活动区列表里。
        if (done.length > 0) await service.refresh()

        if (failed.length > 0) {
          return { ok: false, error: `已归档 ${done.length} 个，${failed.length} 个失败：${failed.join('；')}` }
        }
        if (done.length === 0) return { ok: true, notice: '没有要归档的会话（可能已经都在归档区）' }
        return { ok: true, notice: `已归档 ${done.length} 个会话（设置 → 归档 里可以恢复）` }
      },

      archived(): ArchivedPage {
        try {
          return {
            items: listArchivedSessions().map((item) => ({
              path: item.path,
              cwd: item.cwd,
              ...(item.title !== undefined ? { title: item.title } : {}),
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              archivedAt: item.archivedAt ?? item.updatedAt,
            })),
            trashDir: trashRoot(),
            trashCount: countTrashFiles(),
          }
        } catch (error) {
          ctx.emit('dsc/notice', `归档列表读取失败：${errText(error)}`)
          return { items: [], trashDir: trashRoot(), trashCount: 0 }
        }
      },

      restore(paths) {
        try {
          for (const path of paths) restoreSession(path)
          return { ok: true, notice: `已恢复 ${paths.length} 个会话` }
        } catch (error) {
          return { ok: false, error: errText(error) }
        }
      },

      async purge(paths) {
        if (paths.some((path) => path === session.filePath)) {
          return { ok: false, error: '当前打开的会话不能删除，先切到别的会话' }
        }
        // 常驻 agent 先收摊再挪文件（与归档同一套，0.6.48 的口径）：切走没多久的会话还在
        // 「空闲保留」的名册里（见 agent.ts 的 rememberIdle），它攥着这个 jsonl 的写入流，
        // 直接 rename 在 Windows 上是原生 EPERM。
        const agent = ctx.get('agent')
        for (const path of paths) await agent?.stop(path)
        try {
          for (const path of paths) purgeSession(path)
          return { ok: true, notice: `已删除 ${paths.length} 个会话（进了回收站，30 天后自动清空）` }
        } catch (error) {
          return { ok: false, error: errText(error) }
        }
      },

      rename(path, title) {
        const name = title.replace(/\s+/g, ' ').trim().slice(0, 60)
        if (name === '') return { ok: false, error: '会话名字不能是空的' }
        try {
          patchSessionMeta(uuidOf(path), { title: name })
          return { ok: true, notice: `已改名为「${name}」` }
        } catch (error) {
          return { ok: false, error: errText(error) }
        }
      },

      setPinned(path, pinned) {
        try {
          patchSessionMeta(uuidOf(path), { pinnedAt: pinned ? Date.now() : null })
          return { ok: true, notice: pinned ? '已置顶这个会话' : '已取消置顶' }
        } catch (error) {
          return { ok: false, error: errText(error) }
        }
      },

      userMessages(path) {
        try {
          return readUserMessages(path)
        } catch (error) {
          ctx.emit('dsc/notice', `读取会话消息失败：${errText(error)}`)
          return []
        }
      },

      fork(path, index): SessionForkResult {
        try {
          return { ok: true, path: forkSession(path, index) }
        } catch (error) {
          return { ok: false, error: errText(error) }
        }
      },

      rewind(path, keep, text): SettingsMutation {
        // 只认当前会话：截断后的历史要由**常驻的那个 agent** 接着用，别的会话没有承接者
        // （硬截了文件却没人重放，等于把界面和模型看到的东西拆成两半）。
        if (path !== session.filePath) {
          return { ok: false, error: '只能改当前会话里的消息：先切到那条会话再编辑' }
        }
        // 回合还在跑：这一轮的工具调用与结果正按老历史往下写，此时截断会让它在半截
        // 历史上继续跑（工具结果对不上前面的调用）。界面那颗钮本来就是灰的，这里再挡一道。
        if (ctx.get('agent')?.isRunning(path) === true) {
          return { ok: false, error: '这一轮还在跑：等它结束或打断之后再改' }
        }
        const resident = ctx.get('agent')?.sessionFor(path)
        try {
          if (resident !== undefined) {
            if (!resident.rewindToUser(keep)) return { ok: false, error: '这条消息已经不在会话里了（可能刚改过），刷新后再试' }
          } else {
            // 当前会话却没有常驻 agent（极端情形：agent 刚在别处收摊了）。拿一份临时副本
            // 改完就关，日志照样落盘，界面这边由下面的 session-open 重新读回。
            const temp: Session = Session.load(path)
            try {
              if (!temp.rewindToUser(keep)) return { ok: false, error: '这条消息已经不在会话里了（可能刚改过），刷新后再试' }
            } finally {
              temp.close()
            }
          }
        } catch (error) {
          return { ok: false, error: errText(error) }
        }
        // 改的是第一条消息（keep = 0）时，侧栏标题得跟着换：标题的展示链是
        // 用户改名 → 自动生成 → 首条用户消息，而自动生成那份还记着被作废的那句话。
        // 只清自动生成的（用户手动改过的名字不动），下一条重扫就会按新的首条消息重算。
        if (keep === 0) {
          // 改过的那句话就是新的「第一句」：直接拿它当自动标题（与列表从首条用户消息
          // 派生同一条口径：压成一行的前 60 字）。界面没给文字时退回「清掉自动标题」，
          // 下一次成功起标题会覆盖它。
          const derived = text === undefined ? '' : text.replace(/\s+/g, ' ').trim().slice(0, 60)
          try {
            patchSessionMeta(uuidOf(path), { autoTitle: derived === '' ? null : derived })
          } catch {
            // 写不进只是标题暂时旧着，不值得让整次编辑失败
          }
        }
        // 转录层按截断后的历史重建：与「打开会话」走同一条事件，`open()` 的那条
        // 「已经在看这条就 no-op」短路在这里不适用（我们就是要它重放一遍）。
        ctx.emit('dsc/session-open', { session, filePath: path } satisfies SessionOpenPayload)
        ctx.emit('dsc/changed')
        return { ok: true }
      },
    }

    /**
     * 第一条消息落地后把新会话补进列表缓存。
     *
     * 为什么需要：新会话在说话之前不落盘，列表里那一行是宿主动态补的临时行（`unsaved`），
     * 「文件刚出现」与「列表缓存下一次重扫」之间有一段落差——那段里侧栏没有这条会话，
     * 用户会以为自己的会话没保存。标题生成那条路（session-title.ts）
     * 也会 refresh，但要等一次模型请求，失败就永远补不上。
     *
     * 只认「当前会话第一次真正落盘」这一种情形：命中缓存直接返回，其它会话的
     * 写盘由归档 / 分叉那些显式动作自己刷新。
     */
    let refreshedFor: string | null = null
    ctx.on('dsc/changed', () => {
      // 临时行（unsaved）不算“已经在列表里”：第一句话发出去之后正是要把它换成扫盘的真行。
      if (sessions.some((item) => item.id === session.filePath && item.unsaved !== true)) return
      if (!existsSync(session.filePath)) return
      // 同一条路径只补刷一次：文件在但扫盘没有它（升级前留下的零消息文件）时，
      // 刷新会再发 dsc/changed，没有这道闸就成死循环。
      if (refreshedFor === session.filePath) return
      refreshedFor = session.filePath
      void service.refresh()
    })
    ctx.on('dsc/exit', () => session.close())
    ctx.provide('session', service)
  },
}

/**
 * 界面指名的目录必须真的能用：绝对路径 + 存在 + 是目录。
 *
 * 为什么要当场抛而不是回落启动目录：这颗钮的语义是「在**这个**目录里开会话」
 * （界面上的悬浮说明就这么写的）。悄悄落到别处，用户只会以为界面坏了。
 * 一句话能直接看的原因，界面转成一条 toast 就够了。
 *
 * @returns 规范化后的绝对路径（尾部斜杠、分隔符统一），交给 `Session.create`。
 */
function usableDir(dir: string): string {
  let isDir = false
  if (isAbsolute(dir)) {
    try {
      isDir = statSync(dir).isDirectory()
    } catch {
      isDir = false
    }
  }
  if (!isDir) throw new Error(`工作目录不可用：${dir}（要一个存在的绝对路径）`)
  return resolve(dir)
}

/** 会话库扫描结果 → 侧栏与选择器用的一行；传 archivedAt 表示它来自归档区。 */
function toSummary(item: SessionListItem, archivedAt?: number): SessionSummary {
  return {
    id: item.path,
    cwd: item.cwd,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(item.pinnedAt !== undefined ? { pinnedAt: item.pinnedAt } : {}),
    ...(archivedAt !== undefined ? { archivedAt } : {}),
  }
}

