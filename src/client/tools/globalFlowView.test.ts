/**
 * 工具①「五市场蛋糕」的**视图映射**断言（纯函数层，无网络、无 DOM）。
 *
 * 这里用**手工构造的载荷**（形状与宿主 `globalFlow.ts` 的返回一致），只测"载荷 → 渲染模型"：
 *   · 数字格式化（含缺数据一律 `未取到` / `—`，不许出现 0 顶替）；
 *   · 缺一个市场 ⇒ 该行「未取到」+ 行下原因；整表不出现 0（构造用例）；
 *   · 回放：`step` 0 = 最新，换帧只换本地视图（**同一份载荷**，纯函数 ⇒ 不可能发请求）；
 *   · 轮动文案**原样透传**（宿主负责口径与措辞，视图不许改写/重算）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GlobalFlowMarketDto, GlobalFlowPayloadDto } from '../api.ts'
import { NOT_FETCHED } from '../toolText.ts'
import { cakeTool } from './cake.ts'
import { detailModel } from '../toolRegistry.ts'
import {
  fmtCnyYi,
  fmtMomentum,
  fmtPp,
  fmtRank,
  fmtSharePct,
  fmtUsd,
  globalFlowToolData,
  globalFlowToolPayload,
  pointIndexAt,
} from './globalFlowView.ts'

/** 手工载荷：五个市场，最后一天 2026-10-12；`eu` 可选地缺规模（构造用例） */
function payloadFixture(opts: { euMissing?: boolean } = {}): GlobalFlowPayloadDto {
  const days = ['2026-10-08', '2026-10-09', '2026-10-12']
  const shares = [
    [0.89, 0.03, 0.026, 0.018, 0.036],
    [0.892, 0.031, 0.026, 0.017, 0.034],
    [0.8917, 0.0317, 0.0258, 0.0172, 0.0336],
  ]
  // 缺欧股那一天：份额按"有值市场"重新归一（真实载荷就是这个口径），否则合计不会是 100%
  const lastShares = opts.euMissing ? [0.9209, null, 0.0266, 0.0178, 0.0347] : shares[2]
  const points = shares.map((s, i) => ({
    day: days[i],
    origin: i === days.length - 1 ? ('observed' as const) : ('rebuilt' as const),
    aumUsd: opts.euMissing && i === days.length - 1 ? [822_272_781_554, null, 23_809_338_000, 158_870_000_000, 30_961_800_000] : [822_272_781_554, 29_219_072_367, 23_809_338_000, 158_870_000_000, 30_961_800_000],
    share: i === days.length - 1 ? lastShares : s,
    partial: opts.euMissing && i === days.length - 1,
  }))
  const mk = (key: GlobalFlowMarketDto['key'], name: string, etf: string, share: number | null, missing: string | null) => ({
    key,
    name,
    etf,
    aumSource: '新浪',
    currency: 'USD' as const,
    benchmark: '基准',
    benchmarkSource: '腾讯日线',
    aumNative: share === null ? null : 1,
    aumUsd: share === null ? null : 1,
    sharePct: share === null ? null : share * 100,
    delta1Pp: 0.01,
    delta5Pp: 0.2,
    momentum: { d20: 2, d60: 3.7, d120: 9.9 },
    rank: 1,
    missing,
  })
  return {
    asOf: Date.UTC(2026, 9, 12, 13, 0, 0),
    day: '2026-10-12',
    source: 'live',
    fallbackDay: null,
    fx: { usdCny: 6.6936, at: Date.now(), source: '新浪 fx_susdcny（在岸人民币）', note: null },
    markets: [
      mk('us', '美股', 'SPY', opts.euMissing ? 0.9209 : 0.8917, null),
      mk('eu', '欧股', 'VGK', opts.euMissing ? null : 0.0317, opts.euMissing ? '欧股规模（VGK）：新浪 hq.sinajs.cn（gb_vgk）本次取数失败 ⇒ 稍后重试即可；这一行不参与份额分母' : null),
      mk('jp', '日股', 'EWJ', opts.euMissing ? 0.0266 : 0.0258, null),
      mk('cn', 'A股', '510300', opts.euMissing ? 0.0178 : 0.0172, null),
      mk('em', '新兴市场', 'EEM', opts.euMissing ? 0.0347 : 0.0336, null),
    ],
    totalUsd: 1_000_000_000_000,
    totalNote: null,
    rotation: { kind: 'rotation', fromKey: 'em', toKey: 'us', maxAbsPp: 0.2, comparable: 5, window: 5, text: '从 新兴市场 转向 美股（5 日份额 -0.11pp → +0.20pp）' },
    curve: { points, window: 180, observedDays: 1, rebuiltDays: 2, note: '曲线口径' },
    replay: { days, max: 2, note: '回放口径' },
    netFlow: { code: 'sh510300', label: '沪深300ETF（510300）主力净流入', days: 20, sumCny: 1_556_374_734, asOf: Date.now(), series: [], basis: '逐日 netamount 累加；单列，不参与份额/规模计算', miss: null },
    snapshot: { path: '/tmp/x/global-flow.json', days: 1, bytes: 1930, firstDay: '2026-10-12', lastDay: '2026-10-12' },
    notes: { kpi: 'KPI 口径', curve: '曲线口径', pie: '饼图口径', market: '市场表口径', boundary: '边界口径' },
    boundary: ['数据源边界声明一'],
    missing: [],
  }
}

test('格式化：缺数据一律「未取到」/「—」，从不用 0 顶替', () => {
  assert.equal(fmtUsd(822_272_781_554), '8222.73 亿美元')
  assert.equal(fmtUsd(1_234_000_000_000), '1.23 万亿美元')
  assert.equal(fmtUsd(null), NOT_FETCHED, '没有值就是「未取到」')
  assert.equal(fmtUsd(Number.NaN), NOT_FETCHED, 'NaN 也算没有值')
  assert.equal(fmtSharePct(89.17), '89.17%')
  assert.equal(fmtSharePct(null), NOT_FETCHED)
  assert.equal(fmtPp(0.2), '+0.20pp')
  assert.equal(fmtPp(-0.11), '-0.11pp')
  assert.equal(fmtPp(0), '0.00pp', '真的 0（份额没变）是数据，照常显示')
  assert.equal(fmtPp(null), NOT_FETCHED)
  assert.equal(fmtRank(2, 5), '2 / 5')
  assert.equal(fmtRank(null, 5), NOT_FETCHED)
  assert.equal(fmtCnyYi(1_556_374_734), '15.56 亿元')
  assert.equal(fmtCnyYi(null), NOT_FETCHED)
  assert.equal(fmtMomentum({ d20: 2, d60: null, d120: 9.9 }), '+2.0% / — / +9.9%', '某一口径样本不足 ⇒ 该格用「—」，不给 0')
  assert.equal(fmtMomentum(null), NOT_FETCHED, '整条动量没有 ⇒ 「未取到」')
})

test('完整载荷 ⇒ KPI（含 delta）/ 曲线 / 饼图 / 市场表 / 净流入单列全都渲染出来', () => {
  const data = globalFlowToolData(payloadFixture(), 0)
  assert.ok((data.status ?? '').includes('北京时间'), `状态行要给数据时刻：${data.status}`)
  assert.equal(data.kpi?.['规模榜首']?.text, '美股 89.17%')
  assert.equal(data.kpi?.['规模榜首']?.delta, '五日 +0.20pp', 'KPI 行必须带 delta')
  assert.ok((data.kpi?.['五市场合计规模']?.text ?? '').includes('亿美元'))
  assert.equal(data.kpi?.['近五日轮动']?.text, '从 新兴市场 转向 美股（5 日份额 -0.11pp → +0.20pp）', '轮动文案原样透传（视图不许改写口径）')
  assert.equal(data.curve?.series.length, 5, '五条份额曲线')
  assert.deepEqual(data.pie?.slices.map((s) => s.label), ['美股', '欧股', '日股', 'A股', '新兴市场'])
  assert.equal(data.market?.rows.length, 5, '市场表五行')
  assert.equal(data.market?.rows[0][3], '89.17%', '份额列')
  assert.equal(data.market?.rows[0][4], '-0.03pp', '份额变化列（与前一序列日比：89.17% − 89.20%）')
  assert.ok((data.extras?.[0]?.title ?? '').includes('不参与份额计算'), 'A股净流入必须单列并写明不参与份额计算')
  assert.ok((data.extras?.[0]?.text ?? '').includes('15.56 亿元'))
  assert.deepEqual(data.boundary, ['数据源边界声明一'], '数据源附带的边界声明要透传')
  assert.equal(data.replay?.days[0], '2026-10-12', '回放第一天 = 最新一日（step 0）')
})

test('某市场缺规模 ⇒ 该行「未取到」+ 行下原因；整表与饼图都不出现 0', () => {
  const payload = payloadFixture({ euMissing: true })
  const data = globalFlowToolData(payload, 0)
  const model = detailModel(cakeTool, data)
  assert.equal(model.market.rows.length, 5, '缺数据的那一行也要在（不许整行消失）')
  const euRow = model.market.rows[1]
  assert.deepEqual(euRow.slice(2, 5), [NOT_FETCHED, NOT_FETCHED, NOT_FETCHED], `欧股行必须是「${NOT_FETCHED}」：${JSON.stringify(euRow)}`)
  assert.equal(euRow[3], NOT_FETCHED)
  assert.ok((model.market.rowNotes[1] ?? '').includes('欧股'), '行下必须给这一行的原因')
  for (const row of model.market.rows) {
    for (const cell of row) assert.equal(/^[+-]?0(\.0+)?\s*%?$/.test(cell.trim()), false, `整表不许用 0 顶替：${JSON.stringify(row)}`)
  }
  // 饼图里没有欧股，且说明写明"不进饼图、不进分母"
  assert.deepEqual(model.pie.slices.map((s) => s.label), ['美股', '日股', 'A股', '新兴市场'])
  assert.ok((model.pie.note ?? '').includes('欧股'), `饼图要说明缺了谁：${model.pie.note}`)
  assert.equal(model.pie.slices.some((s) => (s.value ?? 0) === 0), false, '缺的那一块不许以 0 出现')
  // 份额合计仍按有值市场算（脚注给出）
  assert.ok(model.market.footnotes.join(' ').includes('100.00%'), `脚注要给合计：${model.market.footnotes.join(' ／ ')}`)
})

test('回放：step 0 = 最新，越大越早；换帧只换本地视图（同一份载荷，纯函数）', () => {
  const payload = payloadFixture()
  assert.equal(pointIndexAt(3, 0), 2, 'step 0 ⇒ 最后一个点')
  assert.equal(pointIndexAt(3, 2), 0, 'step 2 ⇒ 最早那个点')
  assert.equal(pointIndexAt(3, 99), 0, '越界夹到 0（不抛、不乱取）')
  const first = globalFlowToolData(payload, 0)
  const last = globalFlowToolData(payload, 2)
  assert.equal(first.pie?.center, '2026-10-12')
  assert.equal(last.pie?.center, '2026-10-08', '换帧就是换那一天')
  assert.equal(first.market?.rows[0][3], '89.17%')
  assert.equal(last.market?.rows[0][3], '89.00%', '历史帧用历史份额')
  assert.equal(last.market?.rows[0][5], '不适用（回放日）', '回放历史日不给动量（上游只留当下横截面）')
  // 同一份载荷从没被改动（纯函数）——两张视图都在，且原载荷的曲线长度不变
  assert.equal(payload.curve.points.length, 3)

  const handle = globalFlowToolPayload(payload)
  assert.equal(handle.replayMax, 2, '回放步数 = 天数 - 1')
  assert.equal(handle.at(1).pie?.center, '2026-10-09')
})

test('取数失败（页面拿不到载荷）⇒ 原因是传入的原文，且不编任何数字', () => {
  const data = globalFlowToolData(payloadFixture(), 0)
  void data
  const failed = detailModel(cakeTool, { status: `${NOT_FETCHED}：网络错误: fetch failed`, why: '网络错误: fetch failed' })
  assert.ok(failed.status.includes('网络错误'), failed.status)
  for (const cell of failed.kpi.cells) {
    assert.equal(cell.text, NOT_FETCHED)
    assert.equal(cell.value, null)
  }
  assert.ok(failed.curve.empty.includes('网络错误'), failed.curve.empty)
})
