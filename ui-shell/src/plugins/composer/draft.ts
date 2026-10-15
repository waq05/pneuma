/**
 * 输入框草稿的归属（0.6.70 修「新会话里打的字切走就没了」）。
 *
 * 用户报障：新建一个会话、在输入框里写了半截话，切到别的会话再回来（再点一次「新会话」），
 * 那半截话不见了。根因是草稿按**会话文件路径**分坑，而「新会话」在你发出第一条消息之前
 * 一直没落盘——它一旦不是当前会话，就既不进侧栏、也没有稳定的身份：再点「新会话」拿到的是
 * 另一个路径，草稿自然找不回来。
 *
 * 口径：**还没发过消息的会话，草稿记在它所在的工作区名下**（`new:<cwd>`）。这种会话彼此
 * 可以互换——它没有任何内容，换一个还是同一个「空会话」。发出第一条消息之后会话就落盘了，
 * 草稿改按会话路径分坑，工作区名下那一份同时清掉（那半截话已经交给这条会话了）。
 *
 * 纯函数（不 import React / 宿主）：换会话时的搬运规则由 `scripts/ui-composer-draft-test.mjs`
 * 逐条钉住。
 *
 * @module dsc-ui-shell/plugins/composer/draft
 */

/** 一份草稿：正文 + 本机的输入历史（上下键翻）。 */
export interface ComposerDraft {
  value: string
  history: readonly string[]
}

/** 空草稿（查不到就用它）。 */
export const EMPTY_DRAFT: ComposerDraft = { value: '', history: [] }

/** 草稿归属：一个 key（存档键）+ 这条会话的身份与「落没落盘」。 */
export interface DraftScope {
  /** 存档键：已落盘的会话是它的 jsonl 路径；还没发过消息的是 `new:<cwd>`。 */
  key: string
  /** 会话 uuid（宿主发的）。用来分辨「换了会话」与「同一条会话刚落盘」。 */
  sessionId: string
  /** 这条会话还没发过消息吗。 */
  unsaved: boolean
}

/**
 * 算一条会话的草稿归属。
 *
 * @param input.sessionPath 会话 jsonl 路径（宿主报的 `status.sessionPath`；没有给空串）
 * @param input.sessionId 会话 uuid
 * @param input.cwd 会话工作目录（新会话按它分坑）
 * @param input.unsaved 宿主报的「这条会话一条消息都还没发过」
 */
export function draftScopeOf(input: {
  sessionPath: string
  sessionId: string
  cwd: string
  unsaved: boolean
}): DraftScope {
  // 没落盘的会话：路径这会儿还可能变（同一个「新会话」每次点都是新路径），按工作区分坑。
  // 宿主没报 sessionId / cwd 的极早期帧：退回按路径分坑（宁可分开，也别把两条会话的草稿混了）。
  if (input.unsaved && input.cwd !== '') {
    return { key: `new:${input.cwd}`, sessionId: input.sessionId, unsaved: true }
  }
  return { key: input.sessionPath, sessionId: input.sessionId, unsaved: false }
}

/**
 * 换会话时搬运草稿：把上一份存进存档，返回该装进输入框的那一份。
 *
 * 三条规则：
 * - **同一个坑**（同一工作区的两个空会话互换）：草稿跟着走，不搬运也不清空；
 * - **同一条会话刚发出第一条消息**（未落盘 → 已落盘，sessionId 不变）：这份草稿已经归它了，
 *   不留在工作区名下（否则下一个新会话会捡到刚发出去的那句话），工作区那一格清空；
 * - **其余**（真的换了会话）：上一份存进它的坑，装下一份（没有就给空的）。
 *
 * @param store 草稿存档（就地更新）
 * @param previous 上一次的归属
 * @param next 这一次的归属
 * @param current 输入框此刻的内容（连同它的历史）
 */
export function carryDraft(
  store: Map<string, ComposerDraft>,
  previous: DraftScope,
  next: DraftScope,
  current: ComposerDraft,
): ComposerDraft {
  if (previous.key === next.key) return current
  const sameSessionSettled =
    previous.unsaved && !next.unsaved && previous.sessionId !== '' && previous.sessionId === next.sessionId
  if (sameSessionSettled) store.set(previous.key, EMPTY_DRAFT)
  else store.set(previous.key, current)
  return store.get(next.key) ?? EMPTY_DRAFT
}
