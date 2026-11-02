/**
 * 会话目标的落盘口径（2026-11-02 报障「目标点 ✕ 清空后，重启又回来」）。
 *
 * 病灶：清空走 `goals.clearByUser()` 之后快照是 null，旧版 `persist()` 见 null 就跳过
 * 写日志——jsonl 里最后一条 goal 记录仍是清空前那份，重启重放又把它读回来。
 *
 * 这个电池验三件事（前两件读源码，第三件真跑一遍日志重放）：
 *   1. `persist()` 不再有「空目标就不写」的守卫；
 *   2. `SessionStateMap.goal` 的类型允许 null（存储层要有「已清空」这种表示）；
 *   3. 一份「先有目标、后来清空」的 jsonl，`Session.load` 重放之后读到的是 null
 *      （对照组：只有目标、没有清空记录的那份要读得回来）。
 *
 * 运行：node scripts/goal-persist-test.mjs（先 pnpm build——第三段要真内核的会话层）
 *
 * @module dsc/scripts/goal-persist-test
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

console.log('[1] 落盘函数：空目标也要写一条')
{
  const goal = read('src/plugins/goal.ts')
  const start = goal.indexOf('const persist = ')
  const body = start < 0 ? '' : goal.slice(start, start + 400)
  check('persist 里直接 appendState（不再有 null 守卫）', body.includes("appendState('goal', goals.snapshot)"))
  check('负向：不许再出现「快照非空才写」的写法', !goal.includes('if (snapshot !== null) ctx.session.current().appendState'))
  check('清空这个动作仍是 clearByUser（语义没换）', goal.includes("action === 'clear'") && goal.includes('goals.clearByUser()'))
}

console.log('[2] 存储类型：goal 允许 null')
{
  const session = read('src/core/session.ts')
  check('SessionStateMap 里 goal 是 GoalSnapshot | null', /goal: GoalSnapshot \| null/.test(session))
  // 老日志的兼容分支（`{ type: 'goal'; goal }`）不参与这条判断，只认清空这条新写法。
  check('注释写明了 null = 用户清空过', session.includes('用户在目标条上点 ✕ 清空时'))
}

console.log('[3] 日志重放：清空之后读到 null')
{
  const { Session } = await import('../lib/core/session.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsc-goal-persist-'))
  const cwd = join(dir, 'work')
  const snapshot = {
    id: 'goal-test',
    revision: 1,
    objective: '把目标清空这件事记住',
    phase: 'active',
    maxRounds: 8,
    rounds: 0,
  }
  const write = (name, records) => {
    const file = join(dir, `${name}.jsonl`)
    const lines = [
      { type: 'meta', id: name, cwd, createdAt: Date.now() },
      ...records,
    ]
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
    return file
  }

  const kept = Session.load(write('kept', [{ type: 'state', id: 'goal', payload: snapshot }]), true)
  const restored = kept.state('goal')
  check(
    '对照组：日志里最后一条是目标，恢复得回来',
    restored !== null && typeof restored === 'object' && restored.objective === snapshot.objective,
    JSON.stringify(restored),
  )

  const cleared = Session.load(
    write('cleared', [
      { type: 'state', id: 'goal', payload: snapshot },
      { type: 'state', id: 'goal', payload: null },
    ]),
    true,
  )
  check('清空之后再恢复读到 null（重启不会把它带回来）', cleared.state('goal') === null, JSON.stringify(cleared.state('goal')))

  // 清空之后又建了新目标：最后一条生效，读到的是新目标（日志只追加、不回头改）。
  const again = Session.load(
    write('again', [
      { type: 'state', id: 'goal', payload: snapshot },
      { type: 'state', id: 'goal', payload: null },
      { type: 'state', id: 'goal', payload: { ...snapshot, id: 'goal-second', objective: '新目标' } },
    ]),
    true,
  )
  check('清空后新建的目标照常生效（最后一条赢）', again.state('goal')?.objective === '新目标', JSON.stringify(again.state('goal')))
}

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 项失败`)
process.exit(failures === 0 ? 0 : 1)
