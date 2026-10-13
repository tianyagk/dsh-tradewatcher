/**
 * 用户把前一日的整场读成"今天横盘"。日期不能省。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cacheNoteOf, lastSuccessNote, nonSessionNote, staleReasonOf, staleVisibleOf, stamp } from './chartNote.ts'

const trend = (labels: string[], extra: Record<string, unknown> = {}) => ({
  kind: 'trend' as const,
  trend: { points: labels.map((label) => ({ label })), ...extra },
})

test('E1：降级复用一律写成「上次成功数据（MM-DD HH:mm）」，三种入口同一句话', () => {
  const live = trend(['2026-10-09 09:30', '2026-10-09 14:55'])
  const fallback = cacheNoteOf({ ...live, fallback: true })
  const stale = cacheNoteOf({ ...live, trend: { ...live.trend, staleAt: 1790000000000 } })
  assert.equal(fallback, ' · 上次成功数据（10-09 14:55）')
  assert.equal(stale, fallback, '刷新失败与 LKG 兜底必须同一句话（此前是两种说法）')
  assert.ok(!fallback.includes('本次刷新失败'), '「本次刷新失败」这种说法已删除')
})

test('E1：K 线兜底也必须带日期（事故源：没日期就被读成今天）', () => {
  const kline = {
    kind: 'kline' as const,
    kline: { bars: [{ t: Date.parse('2026-10-08T15:00:00+08:00') }] },
    fallback: true,
  }
  const note = cacheNoteOf(kline)
  assert.match(note, /上次成功数据（10-08 \d\d:\d\d）/, `K 线兜底要带日期：${note}`)
  // 日线档只有日期（没有时间）⇒ 只给到天，不编时间
  const daily = cacheNoteOf({ kind: 'kline', kline: { days: [{ date: '2026-10-08' }] }, fallback: true })
  assert.equal(daily, ' · 上次成功数据（10-08）')
})

test('E1：日期不可知时退到短形（仍能与"新鲜数据"区分）', () => {
  assert.equal(lastSuccessNote({ kind: 'trend', trend: { points: [] } }), ' · 上次成功数据')
  assert.equal(lastSuccessNote({ kind: 'kline', kline: { bars: [] } }), ' · 上次成功数据')
})

test('P1-2：不是今天的数据必须写出来（节假日上游回节前那天的分时）', () => {
  const expired = cacheNoteOf({ kind: 'trend', trend: { points: [{ label: '2026-10-01 09:30' }], sessionDay: '2026-10-01' } })
  assert.equal(expired, ' · 非当日数据（10-01）')
  assert.equal(nonSessionNote('2026-10-01'), ' · 非当日数据（10-01）')
  // 是今天 ⇒ 什么都不写
  assert.equal(cacheNoteOf({ kind: 'trend', trend: { points: [{ label: '2026-10-09 10:00' }] } }), '')
})

test('其它两种口径各自独立：定稿缓存 / 本地缓存不写成"上次成功数据"', () => {
  assert.equal(cacheNoteOf({ kind: 'trend', trend: { points: [], cached: true } }), ' · 休市定稿缓存（未回源）')
  assert.equal(cacheNoteOf({ kind: 'kline', kline: { bars: [{ t: 1 }] }, fromCache: true }), ' · 本地缓存')
  assert.equal(cacheNoteOf({ kind: 'unavailable' }), '', '拿不到数据时不给缓存口径')
  assert.equal(cacheNoteOf(null), '')
})

test('stamp：脚注时间一律 MM-DD HH:mm（北京时间，补零；不用 toLocaleString 的默认输出）', () => {
  // ⚠ 旧写法是 `new Date(2026, 9, 9, 9, 5)`（**本地**构造）+ 期望本地渲染 ⇒ 任何时区都过，
  // 于是"脚注按浏览器时区显示"这个缺陷也被锁成了契约（R5）。
  // 现在输入是固定 epoch（北京 09:05 ⇒ 01:05Z），期望值是固定字面量，双时区轮里都一样。
  assert.equal(stamp(Date.parse('2026-10-09T09:05:00+08:00')), '10-09 09:05')
  assert.equal(stamp(Date.parse('2026-10-09T00:05:00+08:00')), '10-09 00:05', '刚过北京零点不得翻到前一天/后一天')
})

test('D4：宿主自标降级的 K 线也必须走同一句（不许再出现「缓存数据（上游暂不可用）」）', () => {
  const note = cacheNoteOf({ kind: 'kline', kline: { stale: true, days: [{ date: '2026-10-08' }] } })
  assert.equal(note, ' · 上次成功数据（10-08）')
  assert.ok(!note.includes('上游暂不可用'), '旧说法已删除')
})

/**
 * v0.63.0（task-13）：宿主给的 `staleReason`（降级复用的**具体原因**）**替换**那句通用的
 * 「· 上次成功数据（MM-DD HH:mm）」——同一处文案的替换，不新增第二行（用户要求减少常驻提示）。
 */
const REAL_REASON = '回源未取到新数据 ⇒ 改用本地缓存的 800 根已完成 bar；不可信的最后一根已丢弃（原因：未完成 bar 已超过 60s TTL ⇒ 回源重取；但文件里有 801 根，丢掉不可信的最后一根后仍有 800 根 ≥ 10 ⇒ 降级采用（不回源成功也照用））'

test('task-13：有 staleReason ⇒ 用它替换通用句；没有 ⇒ 保持原句（同一处，不新增第二行）', () => {
  const withReason = { kind: 'kline' as const, kline: { stale: true, days: [{ date: '2026-10-09' }], staleReason: REAL_REASON } }
  const note = lastSuccessNote(withReason)
  // ① 用的是宿主那句话（首段），不是通用句
  assert.equal(note, ` · ${staleVisibleOf(REAL_REASON)}`, '必须用 staleReason 派生出的那句')
  assert.equal(note.includes('上次成功数据'), false, '有具体原因时**不再**说那句通用的')
  assert.ok(note.includes('回源未取到新数据') && note.includes('已完成 bar'), `要点明"用了缓存"（实际 ${note}）`)
  // ⚠ 只断言"提到了最后一根被丢掉"，**不锁 host 的具体措辞**（那句话属于宿主，措辞可能微调）
  assert.ok(/最后一根/.test(note), `要点明最后一根的处理（实际 ${note}）`)
  // ② 常驻仍是一行：派生句要短（真实那句截断后 46 字；通用句 20 字上下）
  assert.ok(note.length <= 80, `常驻一行（≤80 字），实际 ${note.length} 字：${note}`)
  // ③ 完整原文仍在 payload 里（长解释不丢，只是不进常驻可见）
  assert.equal(withReason.kline.staleReason, REAL_REASON, 'payload 里的完整原因必须保持原样')
  // ④ 不许引入新的解释词
  assert.equal(note.includes('降级缓存'), false, '不许出现"降级缓存"这类新增解释词（只复用 host 给的那句）')
  // ⑤ 没有 staleReason ⇒ 与以前完全一致（含日期、含短形）
  assert.equal(lastSuccessNote({ kind: 'kline', kline: { stale: true, days: [{ date: '2026-10-09' }] } }), ' · 上次成功数据（10-09）')
  assert.equal(lastSuccessNote({ kind: 'kline', kline: { stale: true } }), ' · 上次成功数据')
  // 分时档没有这个字段 ⇒ 原句（本次不动分时）
  assert.equal(lastSuccessNote({ kind: 'trend', trend: { staleAt: 1, points: [{ label: '2026-10-12 14:30' }] } }), ' · 上次成功数据（10-12 14:30）')
  // 空串/空白不算"有原因"（避免渲染出" · "这种空提示）
  assert.equal(lastSuccessNote({ kind: 'kline', kline: { stale: true, staleReason: '   ' } }), ' · 上次成功数据')
})

test('task-13 反例注入：改回"永远用通用文案" ⇒ 上面那条断言必须失败', () => {
  const broken = (p: { kind: string; kline?: { days?: Array<{ date: string }>; staleReason?: string } }): string => {
    // 反例：忽略 staleReason，永远给通用句（= 修改前的行为）
    const own = p.kline?.days?.[p.kline.days.length - 1]?.date
    return own === undefined ? ' · 上次成功数据' : ` · 上次成功数据（${own.slice(5)}）`
  }
  const payload = { kind: 'kline' as const, kline: { days: [{ date: '2026-10-09' }], staleReason: REAL_REASON } }
  assert.equal(broken(payload), ' · 上次成功数据（10-09）', '反例的样子：具体原因被忽略')
  assert.notEqual(broken(payload), ` · ${staleVisibleOf(REAL_REASON)}`, '⚠ 反例与真实现必须不同 ⇒ 断言必然抓住它')
  assert.throws(
    () => assert.equal(broken(payload), ` · ${staleVisibleOf(REAL_REASON)}`, '反例上"必须用具体原因"必须失败'),
    /反例上/,
    '⚠ 反例注入（改回永远用通用文案）必须让断言失败',
  )
  // 兜底：真实现确实读的是 payload 里那个字段（不是别的同名字段）
  assert.equal(lastSuccessNote({ kind: 'kline', kline: { stale: true, staleReason: '甲（乙）' } }), ' · 甲', '按第一个全角括号截断')
  assert.equal(staleReasonOf({ kind: 'trend', trend: { points: [] } }), null, '分时档不取这个字段')
})
