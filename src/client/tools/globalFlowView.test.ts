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
import { NOT_FETCHED, looksLikeZeroStandIn } from '../toolText.ts'
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
function payloadFixture(opts: { hkMissing?: boolean } = {}): GlobalFlowPayloadDto {
  // 成分 v2（顺序 = 展示顺序）：A股、港股、美国、日本、韩国
  const NAMES = ['A股', '港股', '美国', '日本', '韩国'] as const
  const ETFS = ['510300', '02800 盈富基金', 'SPY', 'EWJ', 'EWY'] as const
  const KEYS = ['cn', 'hk', 'us', 'jp', 'kr'] as const
  const CUR = ['CNY', 'HKD', 'USD', 'USD', 'USD'] as const
  const NATIVE = [106_350_374_372, 126_217_910_000, 822_272_781_554, 23_809_338_000, 24_336_961_000]
  const AUM_USD = [158_870_000_000, 160_832_784_000, 822_272_781_554, 23_809_338_000, 24_336_961_000]
  const MISSING_TEXT = '港股规模（02800 盈富基金）：腾讯 hk02800 本次取数失败 ⇒ 稍后重试即可；这一行不参与份额分母'
  const days = ['2026-10-08', '2026-10-09', '2026-10-12']
  // 每日的价格因子（各市场不同 ⇒ 份额变化与动量方向都不同）
  const FACTOR = [
    [1.02, 1.015, 1.0, 1.01, 1.007],
    [1.01, 1.008, 1.0, 1.005, 1.003],
    [1, 1, 1, 1, 1],
  ]
  /** 按"有值市场"归一的份额（与宿主同一口径） */
  const normalize = (vals: Array<number | null>): Array<number | null> => {
    const sum = vals.reduce((acc: number, v) => acc + (v ?? 0), 0)
    return vals.map((v) => (v === null ? null : v / sum))
  }
  const points = FACTOR.map((factors, i) => {
    const last = i === FACTOR.length - 1
    const missingHk = opts.hkMissing === true && last
    const aumUsd = AUM_USD.map((v, k) => (missingHk && k === 1 ? null : Math.round(v * factors[k])))
    return {
      day: days[i],
      origin: last ? ('observed' as const) : ('rebuilt' as const),
      aumUsd,
      share: normalize(aumUsd),
      partial: missingHk,
    }
  })
  const lastPoint = points[points.length - 1]
  const mk = (
    key: GlobalFlowMarketDto['key'],
    name: string,
    etf: string,
    share: number | null,
    missing: string | null,
    sizes: { native: number; usd: number; currency: 'USD' | 'CNY' | 'HKD' },
  ) => ({
    key,
    name,
    etf,
    aumSource: '公开源',
    currency: sizes.currency,
    benchmark: '基准',
    benchmarkSource: '腾讯日线',
    aumNative: share === null ? null : sizes.native,
    aumUsd: share === null ? null : sizes.usd,
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
    fx: { usdCny: 6.6936, usdHkd: 7.8473, at: Date.now(), source: '新浪 fx_susdcny / fx_susdhkd', note: null },
    markets: KEYS.map((key, k) =>
      mk(
        key,
        NAMES[k],
        ETFS[k],
        opts.hkMissing === true && key === 'hk' ? null : (lastPoint.share[k] as number),
        opts.hkMissing === true && key === 'hk' ? MISSING_TEXT : null,
        { native: NATIVE[k], usd: AUM_USD[k], currency: CUR[k] },
      ),
    ),
    totalUsd: AUM_USD.reduce((acc, v) => acc + v, 0),
    totalNote: null,
    rotation: { kind: 'rotation', fromKey: 'cn', toKey: 'us', maxAbsPp: 0.2, comparable: 5, window: 5, text: '从 A股 转向 美国（5 日份额 -0.11pp → +0.20pp）' },
    curve: { points, window: 180, observedDays: 1, rebuiltDays: 2, note: '曲线口径' },
    replay: { days, max: 2, note: '回放口径' },
    netFlow: { code: 'sh510300', label: '沪深300ETF（510300）主力净流入', days: 20, sumCny: 1_556_374_734, asOf: Date.now(), series: [], basis: '逐日 netamount 累加；单列，不参与份额/规模计算', miss: null },
    snapshot: { path: '/tmp/x/global-flow.json', days: 1, bytes: 1930, firstDay: '2026-10-12', lastDay: '2026-10-12', purged: [] },
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
  assert.equal(fmtPp(-0.00004), '0.00pp', '小于半个显示位的负值不许显示成 -0.00pp（负零看起来像错值）')
  assert.equal(fmtPp(-0.02), '-0.02pp', '真的负变化照常显示')
  assert.equal(fmtPp(null), NOT_FETCHED)
  assert.equal(fmtRank(2, 5), '2 / 5')
  assert.equal(fmtRank(null, 5), NOT_FETCHED)
  assert.equal(fmtCnyYi(1_556_374_734), '15.56 亿元')
  assert.equal(fmtCnyYi(null), NOT_FETCHED)
  assert.equal(fmtMomentum({ d20: 2, d60: null, d120: 9.9 }), '+2.0% / — / +9.9%', '某一口径样本不足 ⇒ 该格用「—」，不给 0')
  assert.equal(fmtMomentum(null), NOT_FETCHED, '整条动量没有 ⇒ 「未取到」')
})

test('完整载荷 ⇒ KPI（含 delta）/ 曲线 / 饼图 / 市场表 / 净流入单列全都渲染出来', () => {
  const payload = payloadFixture()
  const data = globalFlowToolData(payload, 0)
  const names = payload.markets.map((m) => m.name)
  assert.deepEqual(names, ['A股', '港股', '美国', '日本', '韩国'], '① 五市场名称与顺序逐字 = 需求 T-5')
  assert.ok((data.status ?? '').includes('北京时间'), `状态行要给数据时刻：${data.status}`)
  // 榜首 = 份额最大的那个（按夹具算，避免写死"某个市场一定第一"）
  const topIdx = payload.markets.reduce((best, m, i) => ((m.sharePct ?? -1) > (payload.markets[best].sharePct ?? -1) ? i : best), 0)
  assert.equal(data.kpi?.['规模榜首']?.text, `${names[topIdx]} ${(payload.markets[topIdx].sharePct as number).toFixed(2)}%`)
  assert.equal(data.kpi?.['规模榜首']?.delta, '五日 +0.20pp', 'KPI 行必须带 delta')
  assert.ok((data.kpi?.['五市场合计规模']?.text ?? '').includes('亿美元'))
  assert.equal(data.kpi?.['近五日轮动']?.text, payload.rotation.text, '轮动文案原样透传（视图不许改写口径）')
  assert.equal(data.curve?.series.length, 5, '五条份额曲线')
  assert.deepEqual(data.curve?.series.map((s) => s.name), names, '⑥ 曲线序列 = 五市场集合（顺序一致）')
  assert.deepEqual(data.pie?.slices.map((s) => s.label), names, '⑥ 饼图分块 = 五市场集合')
  assert.equal(data.market?.rows.length, 5, '市场表五行')
  assert.equal(data.market?.rows[0][0], 'A股', '第一行 = A股（需求列举顺序）')
  assert.equal(data.market?.rows[0][3], `${(payload.markets[0].sharePct as number).toFixed(2)}%`, '份额列')
  const prevShare = payload.curve.points[1].share[0] as number
  const nowShare = payload.curve.points[2].share[0] as number
  const dPp = (nowShare - prevShare) * 100
  assert.equal(data.market?.rows[0][4], `${dPp > 0 ? '+' : ''}${dPp.toFixed(2)}pp`, '份额变化列 =（本日 − 前一序列日）× 100')
  assert.ok((data.extras?.[0]?.title ?? '').includes('不参与份额计算'), 'A股净流入必须单列并写明不参与份额计算')
  assert.ok((data.extras?.[0]?.text ?? '').includes('15.56 亿元'))
  assert.deepEqual(data.boundary, ['数据源边界声明一'], '数据源附带的边界声明要透传')
  assert.equal(data.replay?.days[0], '2026-10-12', '回放第一天 = 最新一日（step 0）')
  // ⚠ 反向锁：整份视图模型里**不许再出现旧成分**（欧股 / 新兴市场 / 各自的代码）
  const dump = JSON.stringify(model0())
  for (const stale of ['欧股', '新兴市场', 'VGK', 'EEM']) {
    assert.equal(dump.includes(stale), false, `口径 v2 之后不许再出现旧成分「${stale}」`)
  }
  function model0(): unknown {
    return detailModel(cakeTool, data)
  }
})

test('某市场缺规模 ⇒ 该行「未取到」+ 行下原因；整表与饼图都不出现 0', () => {
  const payload = payloadFixture({ hkMissing: true })
  const data = globalFlowToolData(payload, 0)
  const model = detailModel(cakeTool, data)
  assert.equal(model.market.rows.length, 5, '缺数据的那一行也要在（不许整行消失）')
  const hkRow = model.market.rows[1]
  assert.deepEqual(hkRow.slice(2, 5), [NOT_FETCHED, NOT_FETCHED, NOT_FETCHED], `港股行必须是「${NOT_FETCHED}」：${JSON.stringify(hkRow)}`)
  assert.equal(hkRow[3], NOT_FETCHED)
  assert.ok((model.market.rowNotes[1] ?? '').includes('港股'), '行下必须给这一行的原因')
  // 判据自证非恒真（见 toolText.looksLikeZeroStandIn 的注释：手写锚定正则曾经恒真）
  assert.equal(looksLikeZeroStandIn('0.00 亿美元'), true)
  assert.equal(looksLikeZeroStandIn('未取到'), false)
  // 只扫「规模」「份额」两列（**不该为 0** 的列）；变化/动量列可以是真实的 0
  for (const row of model.market.rows) {
    for (const cell of row.slice(2, 4)) assert.equal(looksLikeZeroStandIn(cell), false, `规模/份额列不许用 0 顶替：${JSON.stringify(row)}`)
  }
  // 饼图里没有港股，且说明写明"不进饼图、不进分母"
  assert.deepEqual(model.pie.slices.map((s) => s.label), ['A股', '美国', '日本', '韩国'])
  assert.ok((model.pie.note ?? '').includes('港股'), `饼图要说明缺了谁：${model.pie.note}`)
  assert.ok(model.pie.slices.length > 0, '这一屏应当还有四块（先确认不是空集合，避免真空通过）')
  assert.equal(model.pie.slices.some((s) => (s.value ?? 0) === 0), false, '缺的那一块不许以 0 出现')
  // 份额合计仍按有值市场算（脚注给出）
  assert.ok(model.market.footnotes.join(' ').includes('100.00%'), `脚注要给合计：${model.market.footnotes.join(' ／ ')}`)
})

test('④ 边界声明：含「风险偏好代理 ≠ 真实跨境资金净流入」，且条目不许重复', () => {
  for (const [label, payload] of [['有数据', payloadFixture()], ['缺数据', payloadFixture({ hkMissing: true })]] as const) {
    const model = detailModel(cakeTool, globalFlowToolData(payload, 0))
    const lines = model.boundary.lines
    assert.ok(lines.length >= 8, `${label}：边界声明应当足够长（实际 ${lines.length} 条）`)
    assert.equal(new Set(lines).size, lines.length, `${label}：边界声明不许有重复条目（工具声明 + 数据源声明要各讲各的）`)
    const disclaimer = lines.filter((l) => l.includes('跨境资金净流入'))
    assert.equal(disclaimer.length, 1, `${label}：必须**恰好一条**免责（风险偏好代理 ≠ 真实跨境资金净流入），实际 ${disclaimer.length} 条`)
    assert.equal(disclaimer[0].includes('风险偏好代理，不是真实跨境资金净流入'), true, `需求要求的那句话要逐字可见：${disclaimer[0]}`)
    // 首条就是免责（读者最容易读到的位置）
    assert.equal(lines[0].includes('风险偏好代理，不是真实跨境资金净流入'), true, `免责应当在第一条：${lines[0]}`)
  }
})

test('② 规模单元格：A股 同时显示人民币原值与折算值；缺汇率时如实说明"未折算"', () => {
  const ok = globalFlowToolData(payloadFixture(), 0)
  // 成分 v2：下标 0 = A股、1 = 港股、2 = 美国 …（顺序是口径的一部分）
  const cn = ok.market?.rows[0] ?? []
  const hk = ok.market?.rows[1] ?? []
  const us = ok.market?.rows[2] ?? []
  assert.equal(cn[2].includes('亿元'), true, `A股 要显示人民币原值：${cn[2]}`)
  assert.equal(cn[2].includes('≈'), true, `A股 要显示折算关系：${cn[2]}`)
  assert.equal(cn[2].includes('亿美元'), true, `A股 要显示折美元值：${cn[2]}`)
  assert.equal(hk[2].includes('亿港元'), true, `港股 要显示港元原值：${hk[2]}`)
  assert.equal(hk[2].includes('≈'), true, `港股 要显示折算关系：${hk[2]}`)
  assert.equal(us[2].includes('亿美元'), true, '美元市场显示亿美元原值')
  // 缺汇率：原币值仍在，且明确"未折算" + 行级原因（这里挑 A股，人民币那条汇率缺）
  const noFx = payloadFixture()
  noFx.fx = { usdCny: null, usdHkd: 7.8473, at: Date.now(), source: '新浪 fx_susdcny / fx_susdhkd', note: '美元/人民币取数失败' }
  const last = noFx.curve.points.length - 1
  const pt = noFx.curve.points[last]
  pt.aumUsd = [null, pt.aumUsd[1], pt.aumUsd[2], pt.aumUsd[3], pt.aumUsd[4]]
  pt.share = [null, pt.share[1], pt.share[2], pt.share[3], pt.share[4]]
  // 缺一个市场 ⇒ 其余按"有值市场"重新归一（与宿主同一口径）
  const sum = pt.share.reduce((acc: number, v) => acc + (v ?? 0), 0)
  pt.share = pt.share.map((v) => (v === null ? null : v / sum))
  noFx.markets[0].aumUsd = null
  noFx.markets[0].sharePct = null
  const view = globalFlowToolData(noFx, 0)
  const row = view.market?.rows[0] ?? []
  assert.equal(row[2].includes('亿元'), true, `缺汇率时人民币原值仍要显示：${row[2]}`)
  assert.equal(row[2].includes('未折算'), true, `缺汇率时要写"未折算"：${row[2]}`)
  assert.equal(row[3], NOT_FETCHED, `缺汇率 ⇒ 份额「${NOT_FETCHED}」`)
  assert.notEqual(view.market?.rowNotes[0], null, '缺汇率时 A股 行必须有行级原因')
  assert.equal((view.market?.rowNotes[0] ?? '').includes('汇率'), true, `行级原因要说清是汇率：${view.market?.rowNotes[0]}`)
  assert.equal((view.market?.rowNotes[0] ?? '').includes('不进美元合计'), true, `行级原因要说清后果：${view.market?.rowNotes[0]}`)
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
  assert.equal(first.market?.rows[0][3], `${((payload.curve.points[2].share[0] as number) * 100).toFixed(2)}%`)
  assert.equal(last.market?.rows[0][3], `${((payload.curve.points[0].share[0] as number) * 100).toFixed(2)}%`, '历史帧用历史份额')
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
  assert.equal(failed.kpi.cells.length, 4, 'KPI 四格（否则下面的循环会真空通过）')
  for (const cell of failed.kpi.cells) {
    assert.equal(cell.text, NOT_FETCHED)
    assert.equal(cell.value, null)
  }
  assert.ok(failed.curve.empty.includes('网络错误'), failed.curve.empty)
})
