/**
 * @pneuma/superagent 飞书来源图片下载的包级测试：key 配对 / 下载 / 越界路径 / 扩展名 / 字节上限 / 附件落盘。
 *
 * 上游 `tests/feishu-image.spec.ts` 的四条用例逐条转写，但落点按本仓「原生重写」调整：
 * 上游把图片交给 `ctx.attachments.saveImage()` 并返回 `ImageAttachmentRef`，本仓改为
 * `attachmentStore()` 的内容寻址附件仓库，返回 `AttachmentMeta`（`sha` / `kind` / `name` /
 * `mime` / `bytes` / `url` / `path`）。所以上游「交给 agent」的断言换成本仓等价断言：
 * 落盘字节与下载字节一致、附件元数据的类型与字节数正确；上游「先查模型是否支持图片」的
 * 用例在本层不成立（实现把模型路由检查移到执行器批，见 `sources/feishu-image.ts:46-47`），
 * 标成跳过并写明原因。
 *
 * 附件仓库换成临时目录（`setAttachmentStoreForTest`），不碰 `~/.dsc`；lark-cli 用假件
 * （`fixtures-commands.mjs`）在实现给的临时目录里写字节，不跑真 CLI。被测模块跑的是
 * `lib/` 构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/feishu-image
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, test } from 'node:test'
import { fakeCommands, queued } from './fixtures-commands.mjs'

const { admissionImageKeys, readAdmissionImage } =
  await import('../../../../lib/packages/superagent/sources/feishu-image.js')
const { AttachmentStore, MAX_IMAGE_BYTES, attachmentUrl, setAttachmentStoreForTest } =
  await import('../../../../lib/core/attachments.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

/** 一张最小 PNG：8 字节魔数 + 4 字节 IHDR 长度，足够让 `sniffMedia` 按魔数认成 image/png。 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
/** 来源 trigger 与消息文本：只有 `img_source` 是这条消息里的 key。 */
const source = { triggerId: 'source', chatId: 'oc_chat', messageId: 'om_source' }
const text = '![Image](img_source) Plan mode'
/** 本仓实现不读 `agent`（留给执行器批接入），传空对象即可。 */
const agent = {}
const signal = () => new AbortController().signal

let stateDir
let storeRoot
let store

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'admission-image-test-'))
  storeRoot = mkdtempSync(join(tmpdir(), 'admission-image-store-'))
  store = new AttachmentStore({ root: storeRoot })
  setAttachmentStoreForTest(store)
})

afterEach(() => {
  setAttachmentStoreForTest(null)
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(storeRoot, { recursive: true, force: true })
})

/** 假 lark-cli 下载：核对参数、在实现给的临时目录里写文件、返回 `saved_path`。 */
function downloadingLark({ name = 'image.png', bytes = PNG } = {}) {
  return async (args, cwd) => {
    assert.deepEqual(args, ['im', '+messages-resources-download', '--message-id', 'om_source',
      '--file-key', 'img_source', '--type', 'image', '--output', './image'], '下载参数要按来源消息与图片 key 拼')
    assert.ok(cwd.includes(stateDir), '下载要落在 stateDir 下的临时目录里，不能污染别处')
    const saved = join(cwd, name)
    await writeFile(saved, bytes)
    return { saved_path: saved }
  }
}

test('保留来源消息配对、把图片提交成附件并删除临时文件', async () => {
  const commands = fakeCommands({ lark: downloadingLark() })
  assert.deepEqual(admissionImageKeys('![Image](img_source) {"image_key":"img_second"} img_source'),
    ['img_source', 'img_second'], '图片 key 去重后按出现顺序取')

  const result = await readAdmissionImage(agent, commands, source, text, 'img_source', stateDir, signal())
  const sha = createHash('sha256').update(PNG).digest('hex')
  assert.equal(result.source_message_id, 'om_source', '附件要留住来源消息 ID')
  assert.equal(result.image_key, 'img_source')
  assert.partialDeepStrictEqual(result.image, {
    sha, kind: 'image', name: 'img_source.png', mime: 'image/png', bytes: PNG.length,
  }, '附件元数据要按下载到的类型与字节数落盘')
  assert.equal(result.image.url, attachmentUrl(sha, 'img_source.png'))
  assert.equal(result.image.path, store.pathOf(sha))
  assert.deepEqual(store.read(sha), PNG, '落盘的字节要与下载到的完全一致')
  assert.equal(store.stat(sha).size, PNG.length)
  assert.deepEqual(await readdir(stateDir), [], '临时下载目录要清干净，stateDir 里不留文件')
  passed += 1
})

test('下载前拒绝不属于来源消息的图片 key', async () => {
  const commands = fakeCommands({ lark: () => { throw new Error('不该发起下载') } })
  await assert.rejects(readAdmissionImage(agent, commands, source, text, '../img_other', stateDir, signal()),
    /source message/, '任意 key 在下载之前就要拒掉')
  assert.equal(commands.calls.lark.length, 0, '被拒的 key 不能触碰 lark-cli')
  assert.deepEqual(await readdir(storeRoot), [], '一个附件都不该落盘')
  passed += 1
})

test('下载前拒绝不支持图片输入的模型（跳过：本仓该层没有模型路由）', { skip: true }, () => {
  // 上游在此处用 agent.ctx 的 llm.resolveModelInfo 判断 inputModalities 是否含 image。
  // 本仓 feishu-image.ts 已删掉这段（46-47 行注释：SourceAgent 是过渡的不透明值，拿不到模型路由，
  // 检查移到执行器批接入时再做），所以「text-only 模型拒绝下载」在本层没有可断言的入口。
})

test('附件仓库拒收与下载失败都不返回图片，并清掉临时文件', async () => {
  setAttachmentStoreForTest({ save() { throw new Error('Invalid image bytes') } })
  const refused = fakeCommands({ lark: downloadingLark() })
  await assert.rejects(readAdmissionImage(agent, refused, source, text, 'img_source', stateDir, signal()),
    /Invalid image/, '附件仓库拒收要原样往上抛')
  assert.deepEqual(await readdir(stateDir), [], '拒收后临时文件也要清掉')

  setAttachmentStoreForTest(store)
  const failed = fakeCommands({ lark: queued(new Error('Resource permission denied')) })
  await assert.rejects(readAdmissionImage(agent, failed, source, text, 'img_source', stateDir, signal()),
    /permission denied/, '下载失败要原样往上抛')
  assert.deepEqual(await readdir(stateDir), [], '下载失败后临时文件也要清掉')
  passed += 1
})

test('拒绝越界输出路径、超限文件与不支持的扩展名', async () => {
  const outside = join(stateDir, 'outside.png')
  await writeFile(outside, PNG)
  const commands = fakeCommands({
    lark: queued(
      async () => ({ saved_path: outside }),
      downloadingLark({ name: 'image.png', bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1, 0) }),
      downloadingLark({ name: 'image.svg', bytes: PNG }),
    ),
  })
  await assert.rejects(readAdmissionImage(agent, commands, source, text, 'img_source', stateDir, signal()),
    /outside/, '下载结果跑到临时目录之外要拒掉')
  await assert.rejects(readAdmissionImage(agent, commands, source, text, 'img_source', stateDir, signal()),
    /byte limit/, '超过单图字节上限要拒掉')
  await assert.rejects(readAdmissionImage(agent, commands, source, text, 'img_source', stateDir, signal()),
    /supported/, '扩展名不是 PNG/JPEG/WebP/GIF 要拒掉')
  assert.deepEqual(await readdir(storeRoot), [], '这三次都该在落盘之前失败')
  assert.deepEqual((await readdir(stateDir)).sort(), ['outside.png'], 'stateDir 里只剩测试自己写的那个文件')
  passed += 1
})
