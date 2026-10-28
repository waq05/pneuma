/**
 * 行操作（图钉前置 + 右键菜单）与团队面板（移除队友）实机用例的追加种子：
 * 在 ui-seed.mjs 的基础上（ui-home 重建、会话与配置），补齐这两条链路要的数据——
 *   - 第二条会话：会话行要有两行才好验证图钉切换与右键菜单；
 *   - subagent 插件开关（plugins.json）：官方可开关插件默认不挂，团队面板要有名册就得挂；
 *   - 名册两条（别的 sessionId，落进「其它会话的队友」折叠组）+ explorer-1 的伪造
 *     运行记录文件与租约（移除用例要验证文件一并删除）。
 *
 * 只写 desktop/shots/ui-home，真实 ~/.dsc 一个字节都不写。
 * 用法：node desktop/shots/ui-row-team-seed.mjs（先跑 ui-seed.mjs）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = 'D:\\dsc\\desktop\\shots\\ui-home'

// ── 第二条会话（无折叠行依赖，一句话即可）──
const id2 = '8ae4c2d1-0000-4b33-9c55-00000000a117'
const records2 = [
  { type: 'meta', id: id2, cwd: 'D:\\dsc', createdAt: Date.now() - 300_000 },
  { type: 'user', text: '第二条种子会话：验证行首图钉与右键菜单。', ts: Date.now() - 290_000 },
  { type: 'assistant', text: '收到，这条会话只做侧栏行操作的靶子。', ts: Date.now() - 288_000 },
]
const sessionDir = join(home, '.dsc', 'sessions', 'D-dsc')
mkdirSync(sessionDir, { recursive: true })
writeFileSync(join(sessionDir, `${id2}.jsonl`), `${records2.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')

// ── subagent 插件开关（默认不挂，团队面板要有名册就得挂）──
writeFileSync(
  join(home, '.dsc', 'plugins.json'),
  `${JSON.stringify({ version: 1, entries: [{ file: 'subagent', disabled: false, config: {} }] }, null, 2)}\n`,
  'utf8',
)

// ── 名册：两个「其它会话」的收工队友 ──
const mateRoot = join(home, '.dsc', 'sessions', '.teammates')
mkdirSync(mateRoot, { recursive: true })
const mateFile = join(mateRoot, 'explorer-1.jsonl')
const mateRecords = [
  { type: 'meta', id: 'mate-explorer-1', cwd: 'D:\\dsc', createdAt: Date.now() - 200_000 },
  { type: 'user', text: '帮我把仓库里的 TODO 扫一遍', ts: Date.now() - 190_000 },
  { type: 'assistant', text: '扫完了：3 个文件里有 5 条 TODO，清单如下……', ts: Date.now() - 120_000 },
]
writeFileSync(mateFile, `${mateRecords.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
writeFileSync(`${mateFile}.lock`, `${JSON.stringify({ pid: 424242, birth: 0, at: Date.now() })}\n`, 'utf8')

const roster = {
  teammates: [
    {
      name: 'explorer-1',
      role: 'explorer',
      state: 'idle',
      task: '把仓库里的 TODO 扫一遍并汇总成清单',
      file: mateFile,
      cwd: 'D:\\dsc',
      parent: 'lead',
      depth: 0,
      rounds: 3,
      startedAt: Date.now() - 200_000,
      sessionId: 'aaaa1111-2222-3333-4444-555566667777',
      finishedAt: Date.now() - 100_000,
    },
    {
      name: 'explorer-2',
      role: 'explorer',
      state: 'stopped',
      task: '梳理 desktop/ 的目录结构（被用户停掉的那次）',
      file: join(mateRoot, 'explorer-2.jsonl'),
      cwd: 'D:\\dsc',
      parent: 'lead',
      depth: 0,
      rounds: 1,
      startedAt: Date.now() - 400_000,
      sessionId: 'bbbb9999-8888-7777-6666-555544443333',
      finishedAt: Date.now() - 350_000,
    },
  ],
}
mkdirSync(join(home, '.dsc', 'team'), { recursive: true })
writeFileSync(join(home, '.dsc', 'team', 'roster.json'), `${JSON.stringify(roster, null, 2)}\n`, 'utf8')

console.log(`追加种子完成：${home}`)
console.log(`第二会话：${join(sessionDir, `${id2}.jsonl`)}`)
