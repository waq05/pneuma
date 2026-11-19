process.on('unhandledRejection', () => {})

/**
 * 状态面板（页签行那颗胶囊点开的那张卡）的现场复验（2026-11-08 报障，2026-11-11 修活）。
 *
 * ## 三条要验的事
 *
 *   ① Git 区 / 清单区 / 进程区 / 团队区还在不在（造出脏仓库 + 任务清单 + 三位队友，看它们画不画）；
 *   ② 点「子智能体」一行，正文区只读运行记录打不打得开；
 *   ③ hover 任务行时底色有没有铺满到卡片右缘（量盒子，不靠眼睛）。
 *
 * ## 修了什么（修之前它是空转）
 *
 * 旧版量了卡片 / 行 / 内层按钮 / 列表 / 滚动区的左右缘，也数了四个区与只读记录，
 * 但一律 `console.log` 之后 `process.exit(0)`：量出什么都是绿的。现在每条读数都配判据：
 *
 *   1. **四个区都在**：`[data-sp-section]` 同时出现 `git / todo / agent / team`；
 *   2. **各区真的有内容**：Git 区文本报出「1 个文件」、清单区 ≥ 2 条任务、团队区 3 位队友；
 *   3. **任务行铺满**：任务行的右缘 = 列表右缘、宽度 = 列表宽（差 ≤ 1px）——这是「底色没铺满」
 *      的可量形式（底色铺的是行的 padding box，行比列表窄就会在右端留白）；
 *   4. **hover 底色真的出现**：鼠标压到任务行上之后，行自己的 `background-color` 由透明变成实底；
 *   5. **展开的详情不越行**：详情的右缘不超出行右缘，宽度至少是行宽减两侧内距（±2px）；
 *   6. **只读运行记录打得开**：点「子智能体」行之后 `.team-reader` 在场、正文区有子节点、
 *      记录里带着那位队友的名字。
 *
 * ## 负向自检
 *
 * `PROBE_MUTATE=fill` 给任务行加 `margin-right: 24px`（模拟「底色没铺满」）；
 * `PROBE_MUTATE=hover` 把行底色改成透明（模拟「hover 不上色」）。两种都会让对应判据当场红。
 *
 * 运行：node desktop/shots/_verify-status-rows.mjs
 * 产物：`_verify-status-rows-hover.png` / `_verify-status-rows-click.png`
 */
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  assert, connectCdp, finish, launchDesktop, makeHome, requireScene, sleep, teardown,
} from './_probe-kit.mjs'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const debugPort = 9351
const fakePort = 18997
const sessionId = 'status-rows-demo'

const home = makeHome({
  shots,
  name: '_verify-status-rows-home',
  dirs: ['sessions/demo', 'usage', 'team/boards', 'team/inbox', 'agents', 'sessions/.teammates/demo'],
  config: [
    'default:', '  provider: fake', '  model: fake-rows', 'providers:', '  fake:',
    '    displayName: 自检假端点',
    `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
    '    apiKeyEnv: DSC_FAKE_KEY',
    '    models:', '      - id: fake-rows', '        name: Fake Rows',
    '        contextWindow: 128000', '        maxTokens: 4096', '',
  ].join('\n'),
})
const dsc = home.dsc
const work = home.work

// 脏仓库：一次提交之后改一个文件，git-status 才会报「1 个文件」。
execSync('git init -q && git config user.email t@t && git config user.name t && echo a > a.txt && git add . && git commit -qm init', { cwd: work })
writeFileSync(join(work, 'a.txt'), 'changed\n')

writeFileSync(join(dsc, 'plugins.json'), `${JSON.stringify({ version: 1, entries: [{ file: 'subagent', disabled: false, config: {} }] }, null, 2)}\n`)

const now = Date.now()
const sessionFile = join(dsc, 'sessions', 'demo', `${sessionId}.jsonl`)
writeFileSync(sessionFile, [
  { type: 'meta', id: sessionId, cwd: work, createdAt: now - 60000 },
  { type: 'user', text: '把这次拆成两条任务。', ts: now - 50000 },
  {
    type: 'state',
    id: 'todos',
    payload: [
      { id: 't1', content: '拆开成员区与任务区', status: 'in_progress' },
      { id: 't2', content: '补一条回归探针', status: 'pending' },
    ],
  },
  { type: 'assistant', text: '好，任务已上板。', reasoning: '', ts: now - 40000 },
].map((line) => JSON.stringify(line)).join('\n') + '\n')

const mateFile = (name) => join(dsc, 'sessions', '.teammates', 'demo', `${name}.jsonl`)
for (const name of ['explorer-1', 'sub-a', 'team-b']) {
  writeFileSync(mateFile(name), [
    { type: 'meta', id: `${name}-session`, cwd: work, createdAt: now - 30000 },
    { type: 'user', text: '看看工具注册那条线。', ts: now - 29000 },
    { type: 'assistant', text: '结论：工具注册在 tools-default。', reasoning: '', ts: now - 20000 },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n')
}
writeFileSync(join(dsc, 'team', 'roster.json'), `${JSON.stringify({
  teammates: ['explorer-1', 'sub-a', 'team-b'].map((name, index) => ({
    name, role: 'explorer', state: 'idle', task: '读一遍工具注册链路',
    file: mateFile(name), cwd: work, parent: 'lead', depth: 1, rounds: 2,
    startedAt: now - 30000 + index, finishedAt: now - 20000, sessionId,
  })),
}, null, 2)}\n`)
writeFileSync(join(dsc, 'team', 'boards', `${sessionId}.json`), `${JSON.stringify({
  version: 1,
  revision: 1,
  tasks: [{
    id: 't1',
    subject: '交互演示：认领后一句话汇报',
    description: '这是一条演示任务，用来观察「队友 + 共享任务板」的协作链路。要求：认领本任务的队友，认领成功后只回一句话，内容包含你的队友名、本任务 id、当前状态（应为 in_progress）。不要读文件，不要改代码，不要做其他事。',
    status: 'completed', owner: 'lead', blockedBy: [], writeScopes: [],
    createdAt: now - 25000, updatedAt: now - 20000,
  }],
}, null, 2)}\n`)

const desktop = launchDesktop({
  root,
  home: home.home,
  dsc,
  userData: home.userData,
  debugPort,
  extraEnv: { DSC_RESUME_SESSION: sessionFile },
})

let cdp = null
try {
  cdp = await connectCdp({ port: debugPort, log: desktop.log })
  const { evaluate, send: cdpSend } = cdp

  const booted = await requireScene(evaluate, {
    name: '状态胶囊上屏（启动图退场）',
    timeoutMs: 40000,
    script: `
      const splash = document.getElementById('boot-splash') !== null
      return { ok: !splash && document.querySelector('.topbar .tabs .sp-host .sp-mini') !== null, splash }
    `,
  })
  if (!booted.ok) {
    teardown([{ close: () => cdp?.close() }, desktop, home])
    finish('_verify-status-rows')
  }

  // 启动图退场 + 数据轮询到齐（名册 3 秒 / 任务板 5 秒 / git 12 秒档）。
  await sleep(14000)
  const opened = await evaluate(`
    document.querySelector('.topbar .tabs .sp-host .sp-mini')?.click()
    await new Promise((r) => setTimeout(r, 900))
    for (const id of ['git', 'todo', 'agent', 'team']) document.querySelector('[data-sp-section-trigger="' + id + '"]')?.click()
    await new Promise((r) => setTimeout(r, 900))
    return {
      sections: [...document.querySelectorAll('[data-sp-section]')].map((node) => node.getAttribute('data-sp-section')),
      panelPresent: document.querySelector('.topbar .tabs .sp-host .sp') !== null,
      text: (document.querySelector('.topbar .tabs .sp-host .sp')?.textContent ?? '').trim(),
    }
  `)
  assert('面板打开且四个区都挂了 DOM', opened.panelPresent === true
    && ['git', 'todo', 'agent', 'team'].every((id) => opened.sections.includes(id)),
  JSON.stringify(opened.sections))
  assert('Git 区报出脏仓库（1 个文件）', /1 个文件/.test(opened.text), opened.text.slice(0, 120))
  assert('清单区有 2 条任务', opened.text.includes('拆开成员区与任务区') && opened.text.includes('补一条回归探针'), opened.text.slice(0, 200))
  assert('团队区 3 位队友都在', (opened.text.match(/explorer-1|sub-a|team-b/g) ?? []).length >= 3, opened.text.slice(0, 200))

  // 负向自检：把「底色没铺满」「hover 不上色」两种坏法注入回去，用来证明下面两条判据真会红。
  const mutate = process.env.PROBE_MUTATE ?? ''
  if (mutate === 'fill' || mutate === 'hover') {
    await evaluate(`
      const style = document.createElement('style')
      style.textContent = ${JSON.stringify(mutate === 'fill'
        ? '.sp-row { margin-right: 24px !important; }'
        : '.sp-row:hover { background: transparent !important; }')}
      document.head.appendChild(style)
      await new Promise((r) => setTimeout(r, 300))
      return true
    `)
    console.log(`负向自检：已注入 ${mutate === 'fill' ? '行右缩进 24px' : 'hover 透明'}（对应判据应当红）`)
  }

  const measures = await evaluate(`
    const host = document.querySelector('.topbar .tabs .sp-host')
    const sp = host.querySelector('.sp')
    const card = sp.getBoundingClientRect()
    const pick = (selector) => {
      const node = document.querySelector(selector)
      if (node === null) return null
      const box = node.getBoundingClientRect()
      return { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) }
    }
    const row = document.querySelector('[data-sp-section="team"] .sp-row')
    const list = document.querySelector('[data-sp-section="team"] .sp-list')
    const scroll = document.querySelector('[data-sp-section="team"] .sp-section-scroll')
    return {
      card: { left: Math.round(card.left), right: Math.round(card.right), width: Math.round(card.width) },
      sections: [...document.querySelectorAll('[data-sp-section]')].map((n) => n.getAttribute('data-sp-section')),
      row: row === null ? null : pick('[data-sp-section="team"] .sp-row'),
      rowOpen: pick('[data-sp-section="team"] .sp-row .sp-row-open'),
      detail: pick('[data-sp-section="team"] .sp-task-detail'),
      list: list === null ? null : { right: Math.round(list.getBoundingClientRect().right), width: Math.round(list.getBoundingClientRect().width) },
      scroll: scroll === null ? null : { right: Math.round(scroll.getBoundingClientRect().right), width: Math.round(scroll.getBoundingClientRect().width), paddingRight: getComputedStyle(scroll).paddingRight },
      rowBg: row === null ? null : getComputedStyle(row).backgroundColor,
      rowMarginRight: row === null ? null : getComputedStyle(row).marginRight,
      teamRows: document.querySelectorAll('[data-sp-section="team"] .sp-row').length,
      taskRows: document.querySelectorAll('[data-sp-section="team"] .sp-row-task').length,
    }
  `)
  console.log('measures', JSON.stringify(measures, null, 1))

  // ① 任务行必须铺满列表宽（底色铺的是行的 padding box，行比列表窄就在右端留白）。
  const rowFillOk = measures.row !== null && measures.list !== null
    && Math.abs(measures.row.right - measures.list.right) <= 1
    && Math.abs(measures.row.width - measures.list.width) <= 1
  assert('任务行的右缘与宽度都跟列表一致（底色铺满到卡片右缘）', rowFillOk,
    `row=${JSON.stringify(measures.row)} list=${JSON.stringify(measures.list)}`)
  assert('团队区确实有任务行可量（不是空列表）', measures.taskRows >= 1 && measures.teamRows >= 1,
    `task=${String(measures.taskRows)} 行=${String(measures.teamRows)}`)

  // ② hover 前读一次底色，鼠标压上去再读一次。
  const beforeBg = await evaluate(`
    const row = document.querySelector('[data-sp-section="team"] .sp-row')
    return row === null ? null : getComputedStyle(row).backgroundColor
  `)
  const hoverPoint = await evaluate(`
    const row = document.querySelector('[data-sp-section="team"] .sp-row')
    if (row === null) return null
    const box = row.getBoundingClientRect()
    return { x: Math.round((box.left + box.right) / 2), y: Math.round(box.top + 8) }
  `)
  if (hoverPoint !== null) {
    await cdpSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverPoint.x, y: hoverPoint.y })
    await sleep(500)
  }
  const afterBg = await evaluate(`
    const row = document.querySelector('[data-sp-section="team"] .sp-row')
    if (row === null) return null
    const box = row.getBoundingClientRect()
    return {
      bg: getComputedStyle(row).backgroundColor,
      hovered: row.matches(':hover'),
      left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width),
    }
  `)
  const transparent = (value) => value === null || value === undefined
    || value === 'rgba(0, 0, 0, 0)' || value === 'transparent'
  assert('鼠标真的压在任务行上（不然底色变化无从谈起）', afterBg?.hovered === true, JSON.stringify(afterBg))
  assert('hover 底色从透明变成实底', transparent(beforeBg) && !transparent(afterBg?.bg),
    `前 ${String(beforeBg)} → 后 ${String(afterBg?.bg)}`)
  assert('hover 之后行仍然铺满到右缘（没有缩进去）',
    afterBg !== null && (measures.list === null || Math.abs(afterBg.right - measures.list.right) <= 1),
    JSON.stringify(afterBg))

  const hoverShot = await cdpSend('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, '_verify-status-rows-hover.png'), Buffer.from(hoverShot.data, 'base64'))

  // ③ 展开任务详情：用户报的「底色没铺满」出现在详情展开时。
  const detailInfo = await evaluate(`
    const open = document.querySelector('[data-sp-section="team"] .sp-row [data-sp-task]')
    open?.click()
    await new Promise((r) => setTimeout(r, 600))
    const row = document.querySelector('[data-sp-section="team"] .sp-row')
    const detail = row?.querySelector('.sp-task-detail')
    const card = document.querySelector('.topbar .tabs .sp-host .sp').getBoundingClientRect()
    if (detail === null || detail === undefined) return { present: false }
    const rowBox = row.getBoundingClientRect()
    const detailBox = detail.getBoundingClientRect()
    return {
      present: true,
      cardRight: Math.round(card.right),
      rowRight: Math.round(rowBox.right),
      rowWidth: Math.round(rowBox.width),
      detailRight: Math.round(detailBox.right),
      detailWidth: Math.round(detailBox.width),
      detailPaddingRight: getComputedStyle(detail).paddingRight,
      detailFlexBasis: getComputedStyle(detail).flexBasis,
      visible: detail.offsetParent !== null,
    }
  `)
  console.log('detail', JSON.stringify(detailInfo, null, 1))
  assert('任务详情展开后在场且可见', detailInfo.present === true && detailInfo.visible === true, JSON.stringify(detailInfo))
  assert('详情不越出行右缘（差 > 1px 就是铺出界）',
    detailInfo.present === true && detailInfo.detailRight <= detailInfo.rowRight + 1,
    `detailRight=${String(detailInfo.detailRight)} rowRight=${String(detailInfo.rowRight)}`)
  assert('详情宽度只比行少两侧内距（行内 8 + 8 = 16px，容差 2px）',
    detailInfo.present === true && (detailInfo.rowWidth - detailInfo.detailWidth) >= 8
    && (detailInfo.rowWidth - detailInfo.detailWidth) <= 18,
    `${String(detailInfo.rowWidth)} − ${String(detailInfo.detailWidth)} = ${String(detailInfo.rowWidth - detailInfo.detailWidth)}`)

  // ④ 点子智能体第一行：正文区该出现只读运行记录。
  const clicked = await evaluate(`
    const row = document.querySelector('[data-sp-section="agent"] .sp-row [data-sp-agent]')
    if (row === null) return { found: false }
    row.click()
    await new Promise((r) => setTimeout(r, 1800))
    const reader = document.querySelector('.team-reader')
    return {
      found: true,
      reader: reader !== null,
      readerText: (reader?.textContent ?? '').trim().slice(0, 200),
      threadChildren: (document.querySelector('[data-thread-area]')?.children.length ?? -1),
    }
  `)
  console.log('click', JSON.stringify(clicked, null, 1))
  assert('「子智能体」区有一行可点', clicked.found === true, JSON.stringify(clicked))
  assert('点开之后正文区出现只读运行记录（.team-reader）', clicked.reader === true, JSON.stringify(clicked))
  assert('正文区确实有内容（[data-thread-area] 子节点 ≥ 1）', clicked.threadChildren >= 1, `子节点 ${String(clicked.threadChildren)}`)
  assert('只读记录里带着那位队友的名字', /explorer|sub-a|team-b/.test(clicked.readerText), clicked.readerText.slice(0, 80))

  const clickShot = await cdpSend('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, '_verify-status-rows-click.png'), Buffer.from(clickShot.data, 'base64'))
  assert('两张证据截图都落盘了', (hoverShot.data ?? '').length > 1000 && (clickShot.data ?? '').length > 1000,
    `${String((hoverShot.data ?? '').length)} / ${String((clickShot.data ?? '').length)} 字节`)
} finally {
  if (process.env.PROBE_KEEP_HOME === '1') home.cleanup = () => {}
  teardown([{ close: () => cdp?.close() }, desktop, home])
  await sleep(300)
}

finish('_verify-status-rows')
