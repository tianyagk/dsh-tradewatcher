/**
 * 美股周/月/年 K 的**聚合**与**拆股标记**断言（AUDIT-IMPL69）。
 *
 * 覆盖 Lead 指定的必败注入：
 *   ① 聚合正确性：跨周/月/年边界 + 含 null amount，逐根比 OHLC 与量额
 *      （注入：high/low 用末根代替 ⇒ 必败；量额取平均 ⇒ 必败）
 *   ② 口径文案必须出现「由日线聚合」与「未复权」（注入：删掉 ⇒ 必败）
 *   ③ 拆股检测：构造 4:1 拆股（499.23→129.04）⇒ 必须标记；普通暴跌不许被误标
 *      （注入：不标记 ⇒ 必败；注入：偷偷改价让曲线连续 ⇒ 必败）
 *   ④ 拆股日 → 聚合根的映射（图上标"哪一根"）
 *   ⑤ 自然周/月/年按**美东交易日日期**分组（纯日历算术，TZ 无关）
 *
 * 全部是纯函数，不联网、不写盘。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  US_AGG_NOTE,
  US_RAW_NOTE,
  US_SPLIT_MIN_MOVE,
  aggregateUsDaily,
  detectUsSplits,
  splitMarksOf,
  usAggCaliber,
  usBucketOf,
} from './usAggregate.ts'
import type { DayBar } from '../shared/model.ts'

const bar = (date: string, o: number, h: number, l: number, c: number, vol: number | null, amount?: number | null): DayBar =>
  ({ date, open: o, high: h, low: l, close: c, vol, pct: null, ...(amount === undefined ? {} : { amount }) })

/** 跨年/跨月/跨周的一小段日线（日期都已核对过星期：2026-12-31 周四、2027-01-01 周五休市、01-04 周一） */
const DAILY: DayBar[] = [
  bar('2026-12-30', 100, 108, 99, 104, 1000, 10_000), // 周三（周一起点 12-28，属于 2026 年 12 月）
  bar('2026-12-31', 104, 105, 103, 106, 2000, 20_000), // 周四（同一周、同一月、同一年）
  bar('2027-01-04', 106, 112, 105, 110, 3000, 30_000), // 周一（新的一周 / 新的月 / 新的年）
  bar('2027-01-05', 110, 111, 101, 102, 4000, 40_000), // 周二（同一周、同一月、同一年）
]

test('⑤ 分组键：自然周按周一起点、月/年按日历；纯字符串算术（与宿主时区无关）', () => {
  assert.equal(usBucketOf('2026-12-30', 'week'), '2026-12-28', '周三 → 该周周一')
  assert.equal(usBucketOf('2026-12-31', 'week'), '2026-12-28', '周四 → 同一周一')
  assert.equal(usBucketOf('2027-01-04', 'week'), '2027-01-04', '周一 → 自己')
  assert.equal(usBucketOf('2026-12-31', 'month'), '2026-12')
  assert.equal(usBucketOf('2027-01-04', 'month'), '2027-01')
  assert.equal(usBucketOf('2026-12-31', 'year'), '2026')
  assert.equal(usBucketOf('2027-01-04', 'year'), '2027')
  // 周日也算**上一周**（自然周 = 周一…周日）：2026-10-18 是周日
  assert.equal(usBucketOf('2026-10-18', 'week'), '2026-10-12')
  // 坏输入原样返回（不抛、不编造）
  assert.equal(usBucketOf('2026-13', 'week'), '2026-13')
})

test('① 周K 聚合：跨周边界成两根；OHLC = 首/极值/极值/末；量额 = 求和', () => {
  const weeks = aggregateUsDaily(DAILY, 'week')
  assert.equal(weeks.length, 2, `跨周边界必须分成 2 根（实得 ${weeks.length}）`)
  const [w1, w2] = weeks
  // 第一周：12-30 + 12-31；date 取该周**首个交易日**（稳定键，便于按日期合并缓存）
  assert.equal(w1.date, '2026-12-30')
  assert.equal(w1.from, '2026-12-30')
  assert.equal(w1.to, '2026-12-31')
  assert.equal(w1.open, 100, 'open = 首根 open')
  assert.equal(w1.close, 106, 'close = 末根 close')
  assert.equal(w1.high, 108, 'high = 区间最高（首根 108 高于末根 105）')
  assert.equal(w1.low, 99, 'low = 区间最低（首根 99 低于末根 103）')
  assert.equal(w1.vol, 3000, 'vol = 求和（不是平均 1500）')
  assert.equal(w1.amount, 30_000, 'amount = 求和（不是平均 15_000）')
  assert.equal(w1.sessions, 2)
  // 反例（必败形状）：把 high/low 用**末根**代替、把量额取**平均** —— 下面三条会抓住
  assert.notEqual(w1.high, 105, 'high 若取末根（105）⇒ 这条红')
  assert.notEqual(w1.low, 103, 'low 若取末根（103）⇒ 这条红')
  assert.notEqual(w1.vol, 1500, 'vol 若取平均（1500）⇒ 这条红')
  assert.notEqual(w1.amount, 15_000, 'amount 若取平均（15000）⇒ 这条红')
  // 第二周只有 01-04/01-05
  assert.equal(w2.date, '2027-01-04')
  assert.equal(w2.open, 106)
  assert.equal(w2.close, 102)
  assert.equal(w2.high, 112)
  assert.equal(w2.low, 101)
  assert.equal(w2.vol, 7000)
  // pct 相对上一根聚合收盘
  assert.equal(w1.pct, null, '首根没有可比的上一根 ⇒ null')
  assert.equal(w2.pct, Math.round(((102 - 106) / 106) * 10000) / 100)
})

test('①b 月K / 年K 聚合：跨月跨年各成一根；null amount ⇒ 该根 amount 为 null（不 0 顶替）', () => {
  const months = aggregateUsDaily(DAILY, 'month')
  assert.equal(months.length, 2, '12 月与 1 月各一根')
  assert.equal(months[0].date, '2026-12-30')
  assert.equal(months[0].close, 106)
  assert.equal(months[1].date, '2027-01-04')
  assert.equal(months[1].close, 102)
  const years = aggregateUsDaily(DAILY, 'year')
  assert.equal(years.length, 2, '2026 与 2027 各一根')
  assert.equal(years[0].close, 106)
  assert.equal(years[1].open, 106)

  // amount 缺失：同一根里有一日没有 amount ⇒ 该根 amount 必须是 **null**
  const withNull = [bar('2026-12-30', 100, 105, 99, 104, 1000, 10_000), bar('2026-12-31', 104, 108, 103, 106, 2000, null)]
  const one = aggregateUsDaily(withNull, 'week')[0]
  assert.equal(one.amount, null, '任一日缺失 ⇒ 整根 null（不把 null 当 0 相加）')
  assert.notEqual(one.amount, 0)
  assert.equal(one.vol, 3000, 'vol 仍照常求和（它没有缺失）')
  // vol 缺失同理
  const volNull = aggregateUsDaily([bar('2026-12-30', 100, 105, 99, 104, null, 10), bar('2026-12-31', 104, 108, 103, 106, 2000, 20)], 'week')[0]
  assert.equal(volNull.vol, null)
  assert.equal(volNull.amount, 30)
})

test('② 口径文案：必须同时出现「由日线聚合」与「未复权」；无拆股/有拆股两种都写清', () => {
  const clean = usAggCaliber('week', [])
  assert.ok(clean.includes('由日线聚合'), `必须写明聚合来源（实得 ${clean}）`)
  assert.ok(clean.includes('未复权'), `必须写明未复权（实得 ${clean}）`)
  assert.ok(clean.includes('未检测到'), '没有断层时也要说清"未检测到"，别让人以为没查')
  assert.ok(clean.includes('周K'))
  const dirty = usAggCaliber('month', detectUsSplits([bar('2020-08-28', 1, 1, 1, 499.23, 1, 1), bar('2020-08-31', 1, 1, 1, 129.04, 1, 1)]))
  assert.ok(dirty.includes('检测到 1 处疑似拆股/合股'), `拆股计数必须进文案（实得 ${dirty}）`)
  assert.ok(dirty.includes('月K'))
  // 目录级反例：常量本身也要带这两句（防止有人只改文案不改常量）
  assert.ok(US_AGG_NOTE.includes('由日线聚合'))
  assert.ok(US_RAW_NOTE.includes('未复权'))
})

test('③ 拆股检测：4:1 拆股必须标记；普通暴跌/暴涨不许被误标；不伪造调整', () => {
  const aapl = [bar('2020-08-28', 499, 500, 498, 499.23, 1000, 1), bar('2020-08-31', 129, 130, 128, 129.04, 2000, 2)]
  const splits = detectUsSplits(aapl)
  assert.equal(splits.length, 1, `4:1 拆股必须被检出（实得 ${splits.length}）`)
  assert.equal(splits[0].day, '2020-08-31')
  assert.equal(splits[0].label, '4:1 拆股')
  assert.ok(Math.abs(splits[0].factor - 129.04 / 499.23) < 1e-9)
  // 反例（必败形状）：不标记 ⇒ 上面的 length===1 立刻红

  // 普通暴跌 -30%（100 → 70）：变动幅度够大，但比值 0.7 不接近任何常见拆合股比 ⇒ **不许**标拆股
  const crash = [bar('2026-10-15', 100, 100, 69, 100, 1, 1), bar('2026-10-16', 70, 70, 69, 70, 1, 1)]
  assert.deepEqual(detectUsSplits(crash), [], '普通暴跌不许被标成拆股')
  assert.ok(Math.abs(0.7 - 1) > US_SPLIT_MIN_MOVE, '构造生效：跌幅确实超过阈值，排除它的只有"比值不匹配"')
  // 普通上涨 +5%
  assert.deepEqual(detectUsSplits([bar('2026-10-15', 100, 100, 100, 100, 1, 1), bar('2026-10-16', 105, 105, 105, 105, 1, 1)]), [])

  // 反例：偷偷改价让曲线"连续" ⇒ 聚合结果里 close 必须仍是原始价（129.04），不是被抹平后的数
  const agg = aggregateUsDaily(aapl, 'week')
  const last = agg[agg.length - 1]
  assert.equal(last.close, 129.04, '⚠ 不许改价：聚合只归并，不做隐形复权')
  assert.notEqual(last.close, 499.23 / 4)
})

test('④ 拆股日 → 聚合根的映射：图上要标"哪一根"', () => {
  const daily = [
    bar('2020-08-24', 1, 1, 1, 480, 1, 1), // 周一
    bar('2020-08-28', 1, 1, 1, 499.23, 1, 1), // 周五
    bar('2020-08-31', 1, 1, 1, 129.04, 1, 1), // 下周一（断层）
  ]
  const weeks = aggregateUsDaily(daily, 'week')
  const splits = detectUsSplits(daily)
  const marks = splitMarksOf(splits, weeks)
  assert.equal(marks.length, 1)
  assert.equal(marks[0].day, '2020-08-31')
  assert.equal(marks[0].date, '2020-08-31', '断层那一周的第一根是 08-31 ⇒ 标记落在它上面')
  assert.equal(marks[0].label, '4:1 拆股')
  // 旧缓存没有 from/to 时退化成同日匹配（不静默丢标记）
  const legacy = splitMarksOf(splits, [{ date: '2020-08-31' }, { date: '2020-08-24' }])
  assert.equal(legacy[0].date, '2020-08-31')
})
