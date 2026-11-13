/**
 * GitHub 的写出面：往 Issue / PR 里发评论，或者回到行内 review 讨论里回一句。
 *
 * 两条不能省的细节：
 *
 * 1. **每条回复带一个 HTML 标记**（`<!-- dsh-superagent:<消息 id> -->`）。回复是「至少一次」投递：
 *    网络超时后重发、进程重启后补发，都可能把同一句话贴两遍。先按标记查一遍自己发过的评论，
 *    查到就算已发（`github-channel.ts:34-37`）。
 * 2. **永久发不出去的地方要认出来**，不能一直重试：410（永久删除）与「403 + locked」说明这个
 *    会话再也收不了话，返回 `'gone'` 让出站队列丢弃；404 不在此列——私有仓库临时失去权限时
 *    GitHub 也回 404，重试才有机会成功（`github-channel.ts:13-16`）。
 *
 * 没搬的是 `githubLink`（`github-channel.ts:46-52`）对双语标签的拼装：DSC 没有 `ChannelLinks`
 * 这个概念，本文件只回 `{ url, review }`，标签由界面层自己按语言挑——`review` 就是它挑标签用的
 * 那一位。缺了它的后果只是界面文案要写一次，不影响投递。
 *
 * @module dsc/packages/superagent/adapters/github/channel
 */
import { z } from 'zod'
import type { OutboundMessage } from '../../core/ports.js'
import { GithubError, validItems, type GithubApi } from './api.js'
import { githubAddress, githubPage, sameName } from './trigger.js'

const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), in_reply_to_id: z.number().nullish(), user: z.looseObject({ login: z.string() }).nullish(),
})

/** 永久收不了话：已删除（410）或已锁定（403 + locked）。404 故意不在里面，见文件头（`github-channel.ts:13-15`）。 */
const gone = (error: unknown): boolean => error instanceof GithubError
  && (error.code === 410 || (error.code === 403 && /locked/i.test(error.message)))

/** 读目标评论时可以当「不在了」的状态；410 与 404 都行（`github-channel.ts:16`）。 */
const missing = (error: unknown): boolean => error instanceof GithubError && (error.code === 404 || error.code === 410)

/**
 * 发一条评论或 review 讨论的回复（`github-channel.ts:18-45`）。
 *
 * 目标地址带 `url` 且指向 review 讨论时，回到讨论里；那条评论已经被删了（410/404）就退回
 * PR 顶层评论——比整条消息发不出去强。
 *
 * @param api - 已绑定仓库的客户端
 * @param message - 出站消息；`channel.address.number` 是目标编号
 * @param login - 机器人自己的登录名，用来认「这条标记是我发的」
 * @returns `'sent'` 已发（含「之前已发过」），`'gone'` 这个会话永久收不了话
 */
export async function sendGithub(api: GithubApi, message: OutboundMessage, login: string): Promise<'sent' | 'gone'> {
  const number = Number(message.channel.address['number'])
  if (!number) throw new Error('Missing GitHub reply target')
  try {
    // 保留的 Trigger URL 也能路由「线程概念出现之前就排队的回复」（`github-channel.ts:24-25`）。
    const address = githubAddress(message.channel.address['url'] ?? '', api.repository)
    let rootId: number | undefined
    if (address?.pr && address.discussion && address.number === number) {
      // 目标行内评论被删时退回 PR 顶层评论。
      const source = await api.get<unknown>(`pulls/comments/${String(address.discussion)}`)
        .then((value) => CommentSchema.parse(value), (error: unknown) => {
          if (missing(error)) return undefined
          throw error
        })
      rootId = source ? source.in_reply_to_id ?? source.id : undefined
    }
    const path = rootId === undefined ? `issues/${String(number)}/comments` : `pulls/${String(number)}/comments`
    const marker = `<!-- dsh-superagent:${message.id} -->`
    const mine = (comment: z.infer<typeof CommentSchema>): boolean => sameName(comment.user?.login ?? '', login)
      && (rootId === undefined || comment.in_reply_to_id === rootId) && (comment.body ?? '').includes(marker)
    const existing = validItems(CommentSchema, await api.slurp<unknown>(path))
    if (existing.some(mine)) return 'sent'
    const target = rootId === undefined ? path : `${path}/${String(rootId)}/replies`
    await api.post(target, { body: `${message.text}\n\n${marker}` })
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}

/**
 * 一个回复地址对应的网页链接（`github-channel.ts:46-52` 的地址部分）。
 *
 * `review: true` 表示地址指向 review 讨论，界面据此把标签写成「GitHub #N 的 review 讨论」而不是
 * 「GitHub #N」；标签的两种语言文案留在界面层，本层不判断语言。
 */
export function githubLink(address: Record<string, string>, repository: string): { url: string; review: boolean } {
  const number = address['number'] ?? ''
  const review = repository !== '' && githubAddress(address['url'] ?? '', repository)?.discussion !== undefined
  return { url: address['url'] ?? (repository !== '' ? githubPage(repository, Number(number)) : ''), review }
}
