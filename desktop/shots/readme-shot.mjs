// README 展示图：桌面端插件化界面壳的主界面留档。
//
// 与 chat-shots.ps1 同源（隔离 USERPROFILE/HOME + DSC_DESKTOP_USER_DATA），但改用 Node
// 拼种子会话——工具参数里全是引号和反斜杠，走 PowerShell 引号规则太容易写坏。
// 只用到落盘回放，所以不需要假 LLM 端点，整轮不联网。
//
// 用法：node desktop/shots/readme-shot.mjs
//   （前置：lib/ui/assets 壳产物 + desktop/out/main/index.js 已构建）

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

const shotsDir = 'D:\\dsc\\desktop\\shots'
const desktopDir = 'D:\\dsc\\desktop'
const electron = join(desktopDir, 'node_modules', 'electron', 'dist', 'electron.exe')
const iso = join(shotsDir, 'readme-home')
const dsc = join(iso, '.dsc')
const outPng = join(shotsDir, 'readme-desktop.png')

const now = Date.now()
const at = (minutesAgo, sec = 0) => now - minutesAgo * 60_000 + sec * 1000

// ── 隔离环境 ────────────────────────────────────────────────────────────────
mkdirSync(join(dsc, 'usage'), { recursive: true })
writeFileSync(
  join(dsc, 'config.yaml'),
  `default:
  provider: deepseek
  model: deepseek-chat
providers:
  deepseek:
    displayName: DeepSeek
    baseURL: https://api.deepseek.com/v1
    apiKeyEnv: DEEPSEEK_API_KEY
    models:
      - id: deepseek-chat
        name: DeepSeek Chat
        contextWindow: 128000
        maxTokens: 8192
  moonshot:
    displayName: Moonshot
    baseURL: https://api.moonshot.cn/v1
    apiKeyEnv: MOONSHOT_API_KEY
    models:
      - id: kimi-k2
        name: Kimi K2
        contextWindow: 256000
        maxTokens: 16384
`,
  'utf8',
)

const slugCwd = (cwd) => cwd.replace(/[\\/:]+/g, '-')
const seed = (cwd, id, lines) => {
  const dir = join(dsc, 'sessions', slugCwd(cwd))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  const stamped = lines.filter((line) => typeof line.ts === 'number').map((line) => line.ts)
  // 侧栏的相对时间读文件 mtime（updatedAt），列表排序也按它；meta.createdAt 只管
  // 「按创建时间」那一档。两个都跟种子里的事件时间对齐，别让五条全显示「刚刚」。
  const born = Math.min(...stamped)
  const rows = [{ type: 'meta', id, cwd, createdAt: born }, ...lines]
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8')
  const touch = new Date(Math.max(...stamped)) / 1000
  utimesSync(file, touch, touch)
  return file
}

// 会话列表的标题取首条用户消息（src/core/session.ts:981），所以每条首句都写成短句。
const user = (text, minutesAgo, sec) => ({ type: 'user', text, ts: at(minutesAgo, sec) })
const assistant = (text, reasoning, toolCalls, minutesAgo, sec) => ({
  type: 'assistant',
  text,
  reasoning,
  ...(toolCalls === undefined ? {} : { toolCalls }),
  ts: at(minutesAgo, sec),
})
const tool = (callId, name, text) => ({ type: 'tool', callId, name, text })

// 主角会话：两轮，覆盖「思考行 + 读工具卡 + 编辑工具卡 + 代码块回复」。
const heroSeed = seed(
  'D:\\code\\acme-console',
  '3f7c1a90-4b2e-4d18-9a55-6c1d2e8f4a73',
  [
    user('把订单导出改成流式写盘，别再整表读进内存', 14, 12),
    assistant(
      '先看现在的实现和调用点。',
      '导出入口在 src/export/orders.ts，确认它是不是一次性拼完整张表再写盘；顺手看一眼调用点，别改完签名对不上。',
      [{ id: 'call_read_1', name: 'read', arguments: '{"path":"src/export/orders.ts"}' }],
      14,
      26,
    ),
    tool(
      'call_read_1',
      'read',
      [
        'export async function exportOrders(query: OrderQuery, file: string) {',
        '  const rows = await db.query(query)',
        "  const csv = [HEADER, ...rows.map(toCsv)].join('\\n')",
        "  await writeFile(file, csv, 'utf8')",
        '  return rows.length',
        '}',
        '',
        '// src/jobs/nightly.ts:64',
        "await exportOrders({ from: dayStart }, 'out/orders.csv')",
      ].join('\n'),
    ),
    assistant(
      '确认了：现在是整表拼完再 `writeFile`，20 万行的内存峰值就堆在这一次拼接上。\n\n调用点只有夜间任务那一处，换实现不用动签名。',
      '',
      undefined,
      14,
      41,
    ),
    user('好，改吧；改完把测试也跑一遍', 12, 5),
    assistant(
      '表头单独先写一行，数据按批 `write`，背压交给 `drain`。',
      '',
      [
        {
          id: 'call_edit_1',
          name: 'edit',
          arguments:
            '{"path":"src/export/orders.ts","oldString":"const csv = [HEADER, ...rows.map(toCsv)].join(\'\\\\n\')\\n  await writeFile(file, csv, \'utf8\')","newString":"const out = createWriteStream(file)\\n  out.write(HEADER + \'\\\\n\')\\n  for await (const batch of batches(query, 500)) {\\n    if (!out.write(batch.map(toCsv).join(\'\\\\n\') + \'\\\\n\')) await once(out, \'drain\')\\n  }\\n  await new Promise((done) => out.end(done))"}',
        },
      ],
      12,
      22,
    ),
    tool(
      'call_edit_1',
      'edit',
      [
        "- const csv = [HEADER, ...rows.map(toCsv)].join('\\n')",
        "- await writeFile(file, csv, 'utf8')",
        "+ const out = createWriteStream(file)",
        "+ out.write(HEADER + '\\n')",
        '+ for await (const batch of batches(query, 500)) {',
        "+   if (!out.write(batch.map(toCsv).join('\\n') + '\\n')) await once(out, 'drain')",
        '+ }',
        '+ await new Promise((done) => out.end(done))',
        '',
        '1 处替换',
      ].join('\n'),
    ),
    assistant(
      [
        '改完了，两处都收干净：',
        '',
        '- 数据不再在内存里拼成整张表，按 500 行一批写，慢消费者靠 `drain` 挡回去',
        '- 半截文件的路径也处理了：出错时 `out.destroy()`，不留只写了一半的 csv',
        '- 原有测试全绿；另补两个用例：空结果只写表头、超过一批时不丢行',
        '',
        '```ts',
        'const out = createWriteStream(file)',
        "out.write(HEADER + '\\n')",
        'for await (const batch of batches(query, 500)) {',
        '  await writeBatch(out, batch)   // 写不动就等 drain',
        '}',
        'await new Promise((done) => out.end(done))',
        '```',
      ].join('\n'),
      '',
      undefined,
      11,
      48,
    ),
  ],
)

// 同一工作区的另外两条（把侧栏列表填满）
seed('D:\\code\\acme-console', 'a81d6c04-2f57-4e0b-8c31-5d9b7a2e6f10', [
  user('补一下 CI 里 electron 二进制的下载步骤', 90, 0),
  assistant(
    '打包机上没有 electronDist 指的那份，构建前补一次 install.js 就行。',
    '',
    undefined,
    89,
    30,
  ),
])
seed('D:\\code\\acme-console', 'c4e97b12-6a3d-4f28-b5e0-7c1a9d3e5b82', [
  user('设置页拆成左右两栏，左边端点右边详情', 300, 0),
  assistant('拆完窄窗口下右栏要能收到下面，先按 960 的断点做。', '', undefined, 298, 40),
])

// 另一个工作区（侧栏出现第二个目录分组）
seed('D:\\code\\libs\\ui-kit', 'e29b4d76-8c15-4a93-9f42-1b8e6c0d7a35', [
  user('表格虚拟滚动在 1 万行下还是卡', 1500, 0),
  assistant('滚动事件里每帧都在算行高，先把它挪到 rAF 里。', '', undefined, 1498, 12),
])
seed('D:\\code\\libs\\ui-kit', 'f60c8a31-5d79-4b64-8e27-3a4f9b1c6d08', [
  user('暗色主题下边框对比度再提一点', 2900, 0),
  assistant('边框令牌从 8% 提到 14% 白，卡片层次清楚了。', '', undefined, 2898, 55),
])

// ── 预跑脚本：打开主角会话、筛掉真实工作区、展开最后一轮、滚到那一轮的开头 ──
const mineCwds = ['D:\\code\\acme-console', 'D:\\code\\libs\\ui-kit']
const preScript = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = pred(); if (v) return v; await wait(120); }
    return null;
  };
  const mine = ${JSON.stringify(mineCwds)};
  await waitFor(() => {
    const root = document.querySelector('#root');
    return root !== null && root.children.length > 0;
  }, 18000);
  await wait(1200);
  await window.dsc.invoke('openSession', [${JSON.stringify(heroSeed)}]);
  await wait(3500);

  // 侧栏的工作区列表来自主进程读的真实 ~/.dsc/desktop.json（app.getPath('home')
  // 走 Windows 已知文件夹 API，不认 USERPROFILE），里面是这台机器的真实目录。
  // 演示图只留本脚本播种的工作区：不含我的工作区的分组整块隐藏。
  let hiddenGroups = 0;
  for (const group of Array.from(document.querySelectorAll('.group'))) {
    const rows = Array.from(group.querySelectorAll('.group-row'));
    const keep = rows.some((row) => mine.includes((row.getAttribute('data-tip') || '').split(' · ')[0]));
    if (!keep && rows.length > 0) {
      group.style.setProperty('display', 'none', 'important');
      hiddenGroups += 1;
    }
  }

  // 定稿轮的过程区默认收起（思考与工具调用），演示图展开最后一轮，让工具卡露出来
  const folds = Array.from(document.querySelectorAll('.turn-fold'));
  const last = folds[folds.length - 1];
  if (last !== undefined) { last.click(); await wait(1800); }

  // 滚到最后一轮的开头，整轮完整可见。展开是 0fr→1fr 过渡，落点会随后续布局漂移，
  // 所以滚两次、中间留一拍。
  const chat = document.querySelector('.chat');
  const round = document.querySelector('[data-round="1"]');
  const align = () => {
    if (chat === null || round === null) return;
    const top = round.getBoundingClientRect().top - chat.getBoundingClientRect().top + chat.scrollTop;
    chat.scrollTop = Math.max(0, Math.round(top - 16));
  };
  align();
  await wait(700);
  align();
  await wait(700);
  return {
    rounds: document.querySelectorAll('[data-round]').length,
    toolCards: document.querySelectorAll('.tool-card').length,
    hiddenGroups,
    groupLabels: Array.from(document.querySelectorAll('.group-row')).filter((row) => row.style.display !== 'none').map((row) => (row.getAttribute('data-tip') || '').split(' · ')[0]),
    composer: document.querySelector('.composer') === null ? null : document.querySelector('.composer').innerText.replace(/\\n+/g, ' | '),
  };
})()`

// ── 跑 electron ─────────────────────────────────────────────────────────────
// 两条隔离都必要：
//   · USERPROFILE/HOME 换掉宿主读的 ~/.dsc（宿主自己 os.homedir()，认这两个变量）；
//   · DSC_DESKTOP_STATE 换掉主进程的工作目录记忆文件——`app.getPath('home')` 走
//     Windows 已知文件夹 API，**不认 USERPROFILE**，不换就会读到这台机器真实的工作区
//     列表（截图里会漏出真实目录名），也会真写用户的记忆文件。
// apiKeyEnv 指向的环境变量必须真有值，否则端点在宿主眼里是「无可用」，模型 chip 会退成
// 「未知模型」。值本身是假的——整轮不连网，只走落盘回放。
// 记一份**空**的工作区记忆：不给 lastCwd，主进程就退回 `app.getPath('home')` 拉宿主
// （那份目录一定存在）。这里要是写个磁盘上不存在的 cwd，`utilityProcess.fork` 的 cwd
// 校验会直接失败，宿主起不来——症状是「宿主进程未运行」，页面照样截图但全是空的。
const statePath = join(iso, '.dsc', 'desktop.json')
mkdirSync(join(iso, '.dsc'), { recursive: true })
writeFileSync(statePath, JSON.stringify({ recentCwds: [] }), 'utf8')

rmSync(outPng, { force: true })
const child = spawn(electron, ['out\\main\\index.js'], {
  cwd: desktopDir,
  env: {
    ...process.env,
    USERPROFILE: iso,
    HOME: iso,
    DSC_DESKTOP_STATE: statePath,
    DEEPSEEK_API_KEY: 'sk-demo-not-a-real-key',
    MOONSHOT_API_KEY: 'sk-demo-not-a-real-key',
    DSC_DESKTOP_USER_DATA: join(iso, 'electron-userdata'),
    DSC_DESKTOP_SHOT_TOPMOST: '1',
    DSC_DESKTOP_SHOT: outPng,
    DSC_DESKTOP_SHOT_DELAY: '30000',
    DSC_DESKTOP_SHOT_EVAL_LEAD: '23000',
    DSC_DESKTOP_SHOT_EVAL: preScript,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let log = ''
const collect = (buf) => {
  log += buf.toString('utf8')
}
child.stdout.on('data', collect)
child.stderr.on('data', collect)

const deadline = Date.now() + 90_000
while (Date.now() < deadline) {
  if (existsSync(outPng) || child.exitCode !== null) break
  await new Promise((r) => setTimeout(r, 700))
}
spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))

const interesting = log
  .split(/\r?\n/)
  .filter((line) => /预跑脚本|已写出|截图失败|页面加载失败|Error/.test(line))
  .slice(0, 8)
writeFileSync(join(shotsDir, 'readme-desktop.log'), log, 'utf8')
console.log(interesting.join('\n'))
console.log(
  existsSync(outPng) ? `OK ${outPng} ${readFileSync(outPng).length} bytes` : 'FAILED 没有产出 PNG',
)
