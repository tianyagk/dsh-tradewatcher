/**
 * 「该周期未取到」这块的**文案纪律**（AUDIT-BK-AGG §C）。
 *
 * 用户截图里的症状：同一句缺失原因被渲染了**两遍** —— 一遍在带底色的 `tw-hint` 块里、
 * 一遍又作为一行纯文本（`payload.missing[0].note`）。同一件事说两遍不会让人更明白，
 * 只会让"到底是哪儿出错"更难找。
 *
 * 两条判据（都配反例注入）：
 *   ⑤ 同一句原因**只出现一次**（`unavailableBlockOf` 是唯一来源；注入：恢复第二处 ⇒ 必败）；
 *   ④ 聚合来源只落在**口径行一处**（不新增浮层/第二行；注入：客户端再写一遍 ⇒ 必败）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { unavailableBlockOf } from './chartCache.ts'
import type { MissingField } from '../shared/model.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
/** 剥注释（注释里会**提到**旧写法，不能当成违规） */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 出现次数（判"同一句只说一遍"用它，比 includes 强：后者抓不到重复） */
const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1

const note = '板块指数没有可用的日线源：腾讯 K 线不覆盖板块码（90.BK*），东财是唯一链路而它这次也没给出数据'
const missing: MissingField[] = [{ what: '周K', why: 'transient', note }]

test('⑤ 同一句缺失原因只渲染一次（注入：恢复"纯文本第二处" ⇒ 必败）', () => {
  const block = unavailableBlockOf(missing)
  assert.equal(block.headline, '该周期未取到')
  assert.equal(countOf(block.reason, note), 1, `原因只能出现一次（实际：${block.reason}）`)
  // 整块只有两行文字：固定短句 + 那一句原因（没有第三行再来一遍 note）
  const visibleLines = [block.headline, block.reason]
  assert.equal(visibleLines.filter((x) => x !== '').length, 2, '这块只有两行')
  assert.equal(countOf(visibleLines.join('\n'), note), 1)

  // 空 missing（宿主没给原因）时不能编一句出来
  const empty = unavailableBlockOf([])
  assert.equal(empty.headline, '该周期未取到')
  assert.equal(empty.reason, '')

  // 反例注入：旧布局 = 带底色的块 + 一行纯文本（同一句 note 出现两遍）⇒ 判据必败
  const legacyLines = [block.reason, missing[0].note]
  assert.throws(
    () => assert.equal(countOf(legacyLines.join('\n'), note), 1, '反例上：重复渲染必须被计数抓到'),
    /反例上/,
    '⚠ 反例注入（恢复第二处）必须失败',
  )
})

test('⑤ 接线：抽屉里那块只用 `unavailableBlockOf` 的结论，第二处纯文本已删除', () => {
  const src = strip(read('QuoteDrawer.tsx'))
  const at = src.indexOf("payload.kind === 'unavailable'")
  assert.ok(at > 0, '抽屉里必须有 unavailable 分支')
  const end = src.indexOf("payload.kind === 'trend'", at)
  const branch = src.slice(at, end < 0 ? src.length : end)
  assert.ok(branch.includes('unavailableBlockOf(payload.missing)'), '原因的唯一来源是纯函数')
  assert.equal(countOf(branch, '}, block.reason)'), 1, '可见文本**只渲染一次**（旧实现的第二处已删）')
  assert.equal(countOf(branch, "'aria-label': block.reason"), 1, '读屏标签复用同一句（不是第二行文字）')
  assert.equal(countOf(branch, 'missing[0]?.note'), 0, '旧实现那行纯文本必须删掉（它就是第二处）')
  assert.equal(countOf(branch, 'm.note'), 0, '分支里不许再直接渲染 `m.note`（原因只在 block.reason 里）')
})

test('④ 聚合来源只落在口径行一处：客户端不自己写，也不新增浮层', () => {
  const src = strip(read('QuoteDrawer.tsx'))
  // 口径行只读宿主给的 `aggregated.note`，并且只拼进**那一行**一次
  assert.equal(countOf(src, 'k.aggregated.note'), 1, `聚合来源只读一处（实际 ${countOf(src, 'k.aggregated.note')}）`)
  assert.equal(countOf(src, '${aggNote}'), 1, '口径行必须把聚合来源拼进同一行，且只拼一次')
  // 客户端**不许**自己造这句话（否则就会出现第二种写法/第二处）
  assert.equal(countOf(src, '由日线聚合'), 0, '「由日线聚合」只能来自宿主 `aggregated.note`（单一来源）')
  // 反例注入：再写一行（浮层或第二条文案）⇒ 计数必败
  const duplicated = `${src}\nconst extra = k.aggregated.note`
  assert.throws(
    () => assert.equal(countOf(duplicated, 'k.aggregated.note'), 1, '反例上：多一处必须被计数抓到'),
    /反例上/,
    '⚠ 反例注入（新增第二处/浮层）必须失败',
  )
})
