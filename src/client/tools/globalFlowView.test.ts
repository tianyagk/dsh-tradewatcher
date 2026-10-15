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
import { factCoverageProblems } from '../toolFacts.ts'
import { detailModel } from '../toolRegistry.ts'
import {
  cakeTemperature,
  flowBarsAt,
  fmtCnyYi,
  fmtMomentum,
  liquiditySupport,
  stressVerdict,
  temperatureLabel,
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
  /** 每日五市场偏好分（夹具；真实载荷由宿主按 55/30/15 权重算出） */
  const PREF = [
    [0.40, 0.45, 0.50, 0.55, 0.60],
    [0.42, 0.44, 0.52, 0.54, 0.58],
    [0.44, 0.43, 0.54, 0.53, 0.56],
  ]
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
      // 偏好分（0–1）：夹具给确定性值 —— 蛋糕温度 = 它的均值 × 100（与权重同源）
      pref: PREF[i],
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
    k = 0,
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
    // 偏好分：与份额同源（夹具里给一个稳定值；真实载荷由宿主按 55/30/15 算出）
    pref: share === null ? null : 0.5 + k * 0.05,
    prefSource: '偏好分口径（夹具）',
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
        k,
      ),
    ),
    totalUsd: AUM_USD.reduce((acc, v) => acc + v, 0),
    totalNote: null,
    // 宏观两档（真实读数夹具）：7 条自采样历史 ⇒ 5 日变化/较上日/支持度/判定都能算
    macro: {
      us10y: { value: 5.156, at: Date.UTC(2026, 9, 12, 0, 15, 0), history: [4.98, 5.01, 5.04, 5.09, 5.12, 5.14, 5.15], samples: 8, source: '新浪 globalbd_us10yt（24 小时品种；GBK 源，需 Referer）' },
      dxy: { value: 102.1343, at: Date.UTC(2026, 9, 12, 12, 15, 0), history: [101.9, 102.0, 101.95, 102.05, 102.1, 102.08, 102.12], samples: 8, source: '新浪 DINIW（24 小时品种）' },
      notes: [],
    },
    rotation: { kind: 'rotation', fromKey: 'cn', toKey: 'us', maxAbsPp: 0.2, comparable: 5, window: 5, text: '从 A股 转向 美国（5 日份额 -0.11pp → +0.20pp）' },
    curve: { points, window: 365, windowOptions: [90, 180, 365], observedDays: 1, rebuiltDays: 2, note: '曲线口径' },
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
  // ── 宏观四块（用户口径 v0.86.0）──────────────────────────────────────────────
  const temp = data.kpi?.['蛋糕温度']
  // 期望值直接由**载荷自己的偏好分**推出来 ⇒ 这条断言同时证明"温度与偏好分同源、没有另算一份"
  const prefsNow = (payload.curve.points[2].pref ?? []).filter((v): v is number => v !== null)
  const expectTemp = (prefsNow.reduce((a, b) => a + b, 0) / prefsNow.length) * 100
  assert.equal(temp?.value, expectTemp, `蛋糕温度 = 五市场偏好分均值 × 100（实得 ${temp?.value}）`)
  assert.equal(temp?.text, `${expectTemp.toFixed(0)}（平衡）`, '蛋糕温度带状态词')
  assert.ok((temp?.source ?? '').includes('自定口径'), '自定口径必须写明「自定口径」')
  assert.ok((temp?.source ?? '').includes('与参考版不可比'), '不得声称与参考版可比')
  assert.ok((temp?.delta ?? '').includes('较上日'), `磁贴要带较上日 delta：${temp?.delta}`)
  const liq = data.kpi?.['流动性支持度']
  assert.ok((liq?.delta ?? '').includes('较上日'), `支持度要带较上日 delta：${liq?.delta}`)
  assert.ok((liq?.source ?? '').includes('自定口径：流动性支持度 = 5 − 2.5'), '支持度公式必须写进悬停口径')
  assert.ok((liq?.source ?? '').includes('美元指数与美债 10Y 的变化方向'), '支持度输入必须写清')
  assert.ok((liq?.source ?? '').includes('压力是否已传导'), '判定规则必须写进悬停')
  const us10 = data.kpi?.['美国十年期国债收益率']
  assert.equal(us10?.value, 5.156, '美国 10Y = 真实读数（未取到才 null）')
  assert.ok((us10?.delta ?? '').includes('bp'), `10Y 的较上日要以 bp 表示：${us10?.delta}`)
  assert.ok((us10?.source ?? '').includes('新浪 globalbd_us10yt'), '来源必须进悬停')
  assert.ok((us10?.source ?? '').includes('不套 A 股休市冻结'), '24 小时品种口径必须写进悬停')
  const dxy = data.kpi?.['广义美元指数']
  assert.equal(dxy?.value, 102.1343, '广义美元指数 = 真实读数')
  assert.ok((dxy?.source ?? '').includes('新浪 DINIW'), '来源必须进悬停')
  assert.ok((dxy?.source ?? '').includes('不套 A 股休市冻结'), '24 小时品种口径必须写进悬停')
  // 旧四块**不许丢**：搬到状态行的悬停详情里
  const detail = data.statusDetail ?? ''
  for (const kept of ['旧四块（保留）', '偏好榜首', '五市场合计规模', '近五日轮动', '数据时刻']) {
    assert.ok(detail.includes(kept), `旧四块的事实「${kept}」必须能在悬停里读到：${detail.slice(0, 120)}`)
  }
  assert.equal(data.curve?.series.length, 5, '五条份额曲线')
  assert.deepEqual(data.curve?.series.map((s) => s.name), names, '⑥ 曲线序列 = 五市场集合（顺序一致）')
  assert.deepEqual(data.pie?.slices.map((s) => s.label), names, '⑥ 饼图分块 = 五市场集合')
  assert.equal(data.market?.rows.length, 5, '市场表五行')
  assert.equal(data.market?.rows[0][0], 'A股', '第一行 = A股（需求列举顺序）')
  assert.equal(data.market?.rows[0][3], `${(payload.markets[0].sharePct as number).toFixed(2)}%`, '份额列')
  const prevShare = payload.curve.points[1].share[0] as number
  const nowShare = payload.curve.points[2].share[0] as number
  const dPp = (nowShare - prevShare) * 100
  assert.equal(/^0\.\d{2}$/.test(data.market?.rows[0][4] ?? ''), true, `偏好分列必须是数值（如 0.50）：${data.market?.rows[0][4]}`)
  assert.equal(data.market?.rows[0][5], `${dPp > 0 ? '+' : ''}${dPp.toFixed(2)}pp`, '份额变化列 =（本日 − 前一序列日）× 100')
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

/** 造一条 `n` 个序列日的曲线（用于时间范围切档断言）：份额在 5 个市场间按固定比例分摊 */
function wideFixture(n: number): GlobalFlowPayloadDto {
  const base = payloadFixture()
  const w = [0.0172, 0.0175, 0.8917, 0.0258, 0.0264]
  const scale = (weights: number[]): number[] => {
    const sum = weights.reduce((a, b) => a + b, 0)
    return weights.map((x) => x / sum)
  }
  const points = Array.from({ length: n }, (_, i) => {
    const day = `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`
    // 最后一天抖一点，保证份额不是常数（曲线有形状）
    const tilt = 1 + (i % 7) * 0.0005
    return {
      day,
      origin: (i === n - 1 ? 'observed' : 'rebuilt') as 'observed' | 'rebuilt',
      aumUsd: w.map((x, k) => Math.round((x * tilt ** (k === 2 ? -1 : 1)) * 1e12)),
      share: scale(w.map((x, k) => x * (k === 2 ? 1 / tilt : tilt))),
      partial: false,
    }
  })
  return { ...base, curve: { ...base.curve, points, window: 365, windowOptions: [90, 180, 365], observedDays: 1, rebuiltDays: n - 1 } }
}

test('② 时间范围三档：切片后曲线点数与窗口一致，且切档只做本地切片（同一份载荷）', () => {
  const payload = wideFixture(365)
  const before = JSON.stringify(payload)
  for (const days of [90, 180, 365]) {
    const d = globalFlowToolData(payload, 0, days)
    assert.equal(d.rangeDays, days, `选中档要如实回报（${days}）`)
    assert.equal(d.curve?.days.length, days, `${days} 日档 ⇒ 曲线点数必须是 ${days}`)
    assert.equal(d.curve?.series.length, 5, '切档不许改变序列条数（仍是五个市场）')
    assert.equal(d.curve?.series[0].points.length, days, '每条序列的点数 = 窗口')
    assert.equal(d.curve?.days[days - 1], payload.curve.points[364].day, '窗口的最后一天必须是最新一天')
    assert.equal(d.curve?.days[0], payload.curve.points[365 - days].day, `窗口的第一天必须正好往前推 ${days} 天`)
    assert.deepEqual(d.rangeOptions, [90, 180, 365], '可选档位来自载荷（与工具声明同源）')
    // 份额仍是"有值市场"的合计 100%（切片后口径不变）
    const last = d.curve?.series.map((s) => s.points[s.points.length - 1] ?? null) ?? []
    const pct = last.reduce((acc: number, v) => acc + (v ?? 0), 0)
    assert.ok(Math.abs(pct - 100) < 0.11, `切片后份额合计仍应为 100%（实得 ${pct.toFixed(2)}%）`)
  }
  // 超过可用点数 ⇒ 如实给全部（不补齐、不编造）
  assert.equal(globalFlowToolData(payload, 0, 999).curve?.days.length, 365, '窗口大于可用点数 ⇒ 给全部，不编造')
  // 省略窗口 ⇒ 用宿主构建的整条曲线
  assert.equal(globalFlowToolData(payload, 0).curve?.days.length, 365, '省略窗口 ⇒ 整条曲线')
  // 纯函数：切档不许改动传入的载荷
  assert.equal(JSON.stringify(payload), before, '切档是纯函数（不许改传入的载荷）')
  // 饼图/市场表也跟着切片走（用切到 90 天的那一天算份额榜首）
  const narrow = globalFlowToolData(payload, 0, 90)
  const wide = globalFlowToolData(payload, 0, 365)
  assert.equal(narrow.pie?.center, payload.curve.points[364].day, '窄窗口的饼图中心仍是最新一天')
  assert.equal(narrow.kpi?.['偏好榜首']?.text, wide.kpi?.['偏好榜首']?.text, '同一天 ⇒ 榜首一致（切片不影响当天读数）')
})

test('④ 边界声明：含「风险偏好代理 ≠ 真实跨境资金净流入」，且条目不许重复', () => {
  for (const [label, payload] of [['有数据', payloadFixture()], ['缺数据', payloadFixture({ hkMissing: true })]] as const) {
    const model = detailModel(cakeTool, globalFlowToolData(payload, 0))
    const lines = model.boundary.lines
    // v0.85.0：底部改成**两段散文**（方法 + 边界）⇒ 判据从"条数"换成**事实并集**（见 toolFacts.ts）：
    // 散文可以把两句话并成一句，所以条数不再是判据；少一条事实则主题关键词找不到 ⇒ 红。
    // ⚠ 这个手工载荷的 `boundary` 只有一句（真正的口径数字在宿主 `FLOW_BOUNDARY` 里），
    //    所以"事实并集"这条在这里只核对**工具文件那两段**；含宿主口径的完整核对在
    //    `toolRegistry.test.ts`（那里把 FLOW_BOUNDARY 也拼进来，15/15 主题必须命中）。
    const toolOwnFacts = [...(cakeTool.method ?? []), ...cakeTool.boundary]
    assert.deepEqual(factCoverageProblems(toolOwnFacts.join('\n'), `${label}：工具文件的方法 + 边界`), [], `${label}：工具文件那两段不许少事实`)
    const all = [...model.method.lines, ...model.boundary.lines]
    assert.equal(all.length >= toolOwnFacts.length, true, `${label}：宿主口径行与工具两段都要出现在模型里`)
    assert.ok(lines.length >= 3, `${label}：边界段本身也不许被掏空（实际 ${lines.length} 条）`)
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
  assert.equal((view.market?.rowNotes[0] ?? '').includes('偏好份额不受影响'), true, `行级原因要说清"权重不受影响"：${view.market?.rowNotes[0]}`)
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
  assert.equal(last.market?.rows[0][6], '不适用（回放日）', '回放历史日不给动量（上游只留当下横截面）')
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

test('③ 市场横条：五行、当前最多的徽标、份额条、近5日升/降温 —— 且**诚实信息一条不丢**', () => {
  const payload = payloadFixture()
  const bars = flowBarsAt(payload, 0, true)
  assert.equal(bars.length, 5, `五个市场各一条横条（实得 ${bars.length}）`)
  assert.deepEqual(bars.map((b) => b.name), payload.markets.map((m) => m.name), '行序 = 载荷的市场顺序（展示顺序）')
  // 「当前最多」恰好一条（该日份额榜首）
  assert.equal(bars.filter((b) => b.top).length, 1, '「当前最多」徽标只能挂在份额最大的那一行')
  const maxIdx = payload.markets.reduce((best, m, i) => ((m.sharePct ?? -1) > (payload.markets[best].sharePct ?? -1) ? i : best), 0)
  assert.equal(bars[maxIdx].top, true, '最多徽标必须与载荷里的份额榜首一致')
  // 份额条：条长来自 sharePct（百分点），文本与载荷一致
  for (const [i, b] of bars.entries()) {
    assert.equal(b.shareText, fmtSharePct(payload.markets[i].sharePct), '份额文本必须来自载荷（不重算）')
    assert.equal(b.sharePct, payload.markets[i].sharePct)
  }
  // 近5日：宿主给了 delta5Pp ⇒ 用宿主值（升温/降温按符号）
  const up = bars.find((b) => b.deltaKind === 'warm')
  const down = bars.find((b) => b.deltaKind === 'cool')
  assert.ok(up !== undefined || down !== undefined, '至少有一行给出升/降温语义（否则横条右端没有信息）')
  for (const b of bars) assert.match(b.deltaText, /升温|降温|持平|未取到/, `右端文案必须可读：${b.deltaText}`)
  // 诚实信息：规模 / 偏好分 / 动量 / 横截面排名 全部在线
  for (const b of bars) {
    for (const key of ['规模', '偏好分', '动量', '横截面排名']) {
      assert.equal(b.detail.includes(key), true, `横条小字必须含「${key}」（表格里的信息不许丢）：${b.detail}`)
    }
    assert.equal(b.detail.includes('不适用（回放日）'), false, '最新交易日不该出现「不适用（回放日）」')
  }
})

test('③′ 横条：回放历史日 must 如实标「不适用（回放日）」；缺数据的行照旧「未取到」+ 原因', () => {
  const replay = flowBarsAt(payloadFixture(), 2, false)
  for (const b of replay) {
    assert.equal(b.detail.includes('不适用（回放日）'), true, `回放日的动量/排名必须标「不适用（回放日）」：${b.detail}`)
  }
  // 缺规模的市场（港股）⇒ 该行 note 非空；份额缺失时**不画条**且文本是「未取到」（绝不 0）
  const missing = flowBarsAt(payloadFixture({ hkMissing: true }), 0, true).find((b) => b.name === '港股')
  assert.ok(missing !== undefined)
  assert.equal(missing.note !== null, true, '缺数据的行必须给原因')
  for (const b of flowBarsAt(payloadFixture({ hkMissing: true }), 0, true)) {
    if (b.sharePct === null) {
      assert.equal(b.shareText, NOT_FETCHED, '缺份额必须写「未取到」')
      assert.equal(looksLikeZeroStandIn(b.shareText), false, '⚠ 缺份额绝不许写成 0')
    }
  }
})

test('⑤ 段末结论：最新日用宿主轮动结论原样透传；回放日如实说明轮动只对最新日给出', () => {
  const payload = payloadFixture()
  const latest = globalFlowToolData(payload, 0).conclusion
  assert.ok(latest !== null && latest.startsWith('→ 近5日资金偏好显示：'), `结论行必须以用户口径开头：${latest}`)
  assert.equal(latest.includes(payload.rotation.text), true, '结论必须原样透传宿主的轮动文案（视图不许改写/重算）')
  const replay = globalFlowToolData(payload, 2).conclusion
  assert.ok(replay !== null && replay.includes('回放历史日'), `回放日的结论必须如实说明：${replay}`)
})

test('⑤ 作废留痕：常驻行不再出现；悬停详情必须能读到（两处都删 ⇒ 必败）+ 旧四块不丢', () => {
  const payload = payloadFixture()
  const withPurged = {
    ...payload,
    snapshot: { ...payload.snapshot, purged: [{ day: '2026-09-30', scope: 'v1', reason: '旧口径快照（成分变更）' }] },
  }
  const data = globalFlowToolData(withPurged, 0)
  // ① 常驻行**不许**再出现这句（一次性迁移说明不该占常驻行）
  assert.equal((data.status ?? '').includes('旧口径快照已作废'), false, `常驻行不许出现作废提示：${data.status}`)
  assert.equal((data.status ?? '').includes('2026-09-30'), false, `常驻行不许出现作废日期：${data.status}`)
  // ② 事实不消失：悬停详情里必须能读到（含天数与日期示例）
  const detail = data.statusDetail ?? ''
  assert.ok(detail.includes('旧口径快照已作废'), `悬停里必须能读到作废这件事：${detail}`)
  assert.ok(detail.includes('2026-09-30'), `悬停里要给被作废的日期示例：${detail}`)
  // ③ 反例注入：两处都删 ⇒ 断言必须失败（证明这条判据不是恒真）
  const bothGone = { ...data, status: data.status.replace('旧口径快照已作废', ''), statusDetail: (data.statusDetail ?? '').replace('旧口径快照已作废', '') }
  assert.throws(() => {
    assert.equal((bothGone.status ?? '').includes('旧口径快照已作废'), false, '常驻行')
    assert.equal((bothGone.statusDetail ?? '').includes('旧口径快照已作废'), true, '悬停里必须能读到')
  }, /悬停里必须能读到/, '⚠ 反例（两处都删）必须让断言失败')
  // ④ 旧四块不许丢（它们仍是有用事实）
  for (const kept of ['偏好榜首', '五市场合计规模', '近五日轮动', '数据时刻']) {
    assert.ok((data.statusDetail ?? '').includes(kept), `旧四块「${kept}」必须在状态行悬停里保留`)
  }
})

test('⑥ 两块自定口径可追溯：公式/输入/阈值/判定规则都进悬停，且**不许**标成上游口径', () => {
  const payload = payloadFixture()
  const data = globalFlowToolData(payload, 0)
  const temp = data.kpi?.['蛋糕温度']
  const liq = data.kpi?.['流动性支持度']
  // 蛋糕温度：公式 + 同源 + 阈值 + 不可比
  const ts = temp?.source ?? ''
  assert.ok(ts.includes('五市场偏好分均值'), `温度公式：${ts}`)
  assert.ok(ts.includes('与权重同源'), '温度必须说明与权重同源')
  assert.ok(ts.includes('偏热') && ts.includes('偏冷') && ts.includes('平衡'), '状态词阈值必须写进悬停')
  assert.ok(ts.includes('不可比'), '不得声称与参考版可比')
  // ⚠ 红线：自定口径**不许**标成上游口径（把"我们自定"说成"上游发布"就是编造来源）
  const liqSrc = data.kpi?.['流动性支持度']?.source ?? ''
  for (const src of [ts, liqSrc]) {
    assert.equal(src.includes('上游口径'), false, `自定口径不许写成上游口径：${src.slice(0, 60)}`)
    assert.equal(src.includes('上游发布'), false, `自定口径不许暗示上游发布：${src.slice(0, 60)}`)
  }
  // 流动性支持度：公式 + 输入 + 判定 + 不可比
  const ls = liq?.source ?? ''
  assert.ok(ls.includes('5 − 2.5'), `支持度公式：${ls}`)
  assert.ok(ls.includes('美元指数') && ls.includes('10Y'), '支持度输入必须写清')
  assert.ok(ls.includes('压力是否已传导'), '判定规则必须写进悬停')
  assert.ok(ls.includes('不可比'), '不得声称与参考版可比')
  // ⚠ 反例：把自定口径标成"上游口径" ⇒ 判据必须挡住
  const claimed = { ...liq, source: (liq?.source ?? '').replace('自定口径', '上游口径') }
  assert.throws(() => assert.ok((claimed.source ?? '').includes('自定口径'), '自定口径必须写明「自定口径」'), /自定口径必须写明/, '⚠ 反例（标成上游口径）必须失败')
  // ⚠ 反例：把"蛋糕温度"写成上游符号（例如说成上游发布的指数）⇒ 判据必须挡住
  const upstreamish = { ...temp, source: '上游口径：蛋糕温度指数（由上游发布）' }
  assert.throws(() => assert.ok(!(upstreamish.source ?? '').includes('上游口径'), '自定口径不许写成上游口径'), /自定口径不许写成上游口径/, '⚠ 反例（写成上游符号）必须失败')
})

test('⑦ 两个自定口径的纯函数：方向/边界/缺数据（都不写 0）', () => {
  assert.equal(cakeTemperature([0.4, 0.5, 0.6, null, null]), 50, '只对有值市场求均值 ⇒ 0.5 × 100')
  assert.equal(cakeTemperature([null, null]), null, '一个都没有 ⇒ null（不写 0）')
  assert.equal(temperatureLabel(70), '偏热')
  assert.equal(temperatureLabel(30), '偏冷')
  assert.equal(temperatureLabel(69.9), '平衡')
  assert.equal(temperatureLabel(null), null)
  // 支持度：美元/美债同向走强 ⇒ 支持度下降；都走弱 ⇒ 上升；缺一侧 ⇒ null
  const up = liquiditySupport({ dxyChange: 1.0, us10yChangePp: 0.2, span: 5 })
  const down = liquiditySupport({ dxyChange: -1.0, us10yChangePp: -0.2, span: 5 })
  const flat = liquiditySupport({ dxyChange: 0, us10yChangePp: 0, span: 5 })
  assert.ok((flat?.score ?? -1) === 5, `都平 ⇒ 5（实得 ${flat?.score}）`)
  assert.ok((up?.score ?? 99) < 5 && (up?.score ?? 99) >= 0, `压力上升 ⇒ 支持度 < 5（实得 ${up?.score}）`)
  assert.ok((down?.score ?? -1) > 5 && (down?.score ?? -1) <= 10, `压力下降 ⇒ 支持度 > 5（实得 ${down?.score}）`)
  assert.equal(liquiditySupport({ dxyChange: null, us10yChangePp: 0.2, span: 5 }), null, '缺一侧 ⇒ null（不许单侧冒充）')
  // 判定：美元与美债同步走强 + 温度同期下降 ⇒ 传导；否则未传导；缺 ⇒ 数据不足
  assert.equal(stressVerdict({ dxyChange: 0.5, us10yChangePp: 0.2, tempChange: -3 }).verdict, '传导')
  assert.equal(stressVerdict({ dxyChange: 0.5, us10yChangePp: 0.2, tempChange: 3 }).verdict, '未传导')
  assert.equal(stressVerdict({ dxyChange: 0.5, us10yChangePp: -0.2, tempChange: -3 }).verdict, '未传导')
  assert.equal(stressVerdict({ dxyChange: null, us10yChangePp: 0.2, tempChange: -3 }).verdict, '数据不足')
  assert.equal(stressVerdict({ dxyChange: 0.5, us10yChangePp: 0.2, tempChange: null }).verdict, '数据不足')
})

test('⑧ 24 小时品种：休市/非交易时段也给最新真实读数（不套 A 股休市冻结）+ 缺数据不写 0', () => {
  const payload = payloadFixture()
  const data = globalFlowToolData(payload, 0)
  // 夹具的 A股 那条是非交易时段（北京时间 21:00）⇒ 宏观两块照样出真值
  for (const label of ['美国十年期国债收益率', '广义美元指数']) {
    const cell = data.kpi?.[label]
    assert.equal(typeof cell?.value, 'number', `${label} 必须给真实读数（不许因 A 股休市而冻结/置空）`)
    assert.notEqual(cell?.value, 0, '真值不许被 0 顶替')
  }
  // ⚠ 非交易日（周六）也必须照样给真值：这两个是 24 小时品种，**不许套 A 股休市冻结**
  const weekend = { ...payload, day: '2026-10-10', asOf: Date.UTC(2026, 9, 10, 13, 0, 0) }
  const dw = globalFlowToolData(weekend, 0)
  for (const label of ['美国十年期国债收益率', '广义美元指数']) {
    assert.equal(typeof dw.kpi?.[label]?.value, 'number', `非交易日也要给 ${label} 的真值（24 小时品种，不套 A 股休市冻结）`)
  }
  // 缺数据（macro = null）⇒ 未取到 + 原因，值 null（不写 0）
  const noMacro = { ...payload, macro: { us10y: null, dxy: null, notes: [{ what: '美国 10 年期国债收益率（新浪 globalbd_us10yt）', why: 'transient', note: '本次只读本地快照（零上游请求）⇒ 现值没有取到' }] } }
  const d2 = globalFlowToolData(noMacro as typeof payload, 0)
  const us = d2.kpi?.['美国十年期国债收益率']
  assert.equal(us?.text, NOT_FETCHED, '缺数据 ⇒ 未取到')
  assert.equal(us?.value, null, '缺数据 ⇒ 值 null（不许 0 顶替）')
  // 常驻只留短标记（原因进悬停）——口径 v0.90.0
  assert.equal(us?.delta, '较上日 —', `缺数据时常驻只留短标记：${us?.delta}`)
  assert.ok((us?.source ?? '').includes('未取到'), `原因必须能在悬停里读到：${us?.source}`)
  const lq = d2.kpi?.['流动性支持度']
  assert.equal(lq?.value, null, '支持度缺输入 ⇒ null（不许拿单侧或 0 冒充）')
  assert.equal(lq?.delta, '较上日 —', `常驻只留短标记：${lq?.delta}`)
  assert.ok((lq?.source ?? '').includes('未取到'), `支持度缺输入的原因必须进悬停：${lq?.source}`)
  // ⚠ 反例：把缺数据写成 0 ⇒ 判据必须挡住
  const zeroed = { ...noMacro, macro: { us10y: { value: 0, at: null, history: [], samples: 0, source: 'x' }, dxy: null, notes: [] } }
  const d3 = globalFlowToolData(zeroed as typeof payload, 0)
  assert.throws(() => assert.equal(d3.kpi?.['美国十年期国债收益率']?.value, null, '缺数据必须是 null'), /缺数据必须是 null/, '⚠ 反例（写 0）必须失败')
})

test('⑨ 两处常驻红框文案已删；事实必须留在悬停里（两处都删 ⇒ 必败）', () => {
  const payload = payloadFixture()
  const data = globalFlowToolData(payload, 0)
  // ① 说明段（工具文件）不得再出现限定语
  const hero = cakeTool.hero?.note ?? ''
  assert.equal(hero.includes('自定'), false, `说明段常驻文案不许再写"自定"：${hero}`)
  assert.equal(hero.includes('不可比'), false, `说明段常驻文案不许再写"不可比"：${hero}`)
  // ② 摘要卡的常驻 note 不得再出现"规模只作展示 / 不进权重"
  const cakeCard = (data.summary ?? []).find((x) => x.key === 'cake')
  for (const banned of ['规模只作展示', '不进权重']) {
    assert.equal((cakeCard?.note ?? '').includes(banned), false, `摘要卡常驻文案不许出现「${banned}」：${cakeCard?.note}`)
  }
  // ③ 但事实**不许丢**：悬停里必须能读到
  const cardTitle = cakeCard?.noteTitle ?? ''
  assert.ok(cardTitle.includes('不进权重'), `「规模不进权重」必须能在资金蛋糕卡的悬停里读到：${cardTitle}`)
  assert.ok(cardTitle.includes('不可比'), `「与参考版不可比」必须能在资金蛋糕卡的悬停里读到：${cardTitle}`)
  const tempSrc = data.kpi?.['蛋糕温度']?.source ?? ''
  const liqSrc = data.kpi?.['流动性支持度']?.source ?? ''
  for (const [name, src] of [['蛋糕温度', tempSrc], ['流动性支持度', liqSrc]] as const) {
    assert.ok(src.includes('自定口径'), `${name} 磁贴悬停必须写明自定口径`)
    assert.ok(src.includes('不可比'), `${name} 磁贴悬停必须写明与参考版不可比`)
  }
  // ④ 反例注入：把两处悬停都删掉 ⇒ 事实消失 ⇒ 断言必须失败
  const stripped = { ...data, summary: (data.summary ?? []).map((x) => (x.key === 'cake' ? { ...x, noteTitle: null } : x)), kpi: { 蛋糕温度: { ...(data.kpi?.['蛋糕温度'] ?? { text: '', value: null, delta: null, swatch: null }), source: '偏好分均值' } } }
  assert.throws(() => {
    const c = (stripped.summary ?? []).find((x) => x.key === 'cake')
    assert.ok((c?.noteTitle ?? '').includes('不进权重'), '资金蛋糕卡悬停要能读到')
    assert.ok((stripped.kpi?.['蛋糕温度']?.source ?? '').includes('不可比'), '温度磁贴悬停要能读到')
  }, /资金蛋糕卡悬停要能读到/, '⚠ 反例（两处悬停都删）必须失败')
})

test('⑩ 宏观缺字段（宿主未重载）时的原因必须可操作，且不写 0', () => {
  const payload = payloadFixture()
  const noField = { ...payload }
  delete (noField as { macro?: unknown }).macro
  const d = globalFlowToolData(noField as typeof payload, 0)
  for (const label of ['美国十年期国债收益率', '广义美元指数', '流动性支持度']) {
    const cell = d.kpi?.[label]
    assert.equal(cell?.text, NOT_FETCHED, `${label} 缺字段 ⇒ 未取到`)
    assert.equal(cell?.value, null, `${label} 缺字段 ⇒ null（不写 0）`)
  }
  assert.ok((d.kpi?.['美国十年期国债收益率']?.source ?? '').includes('宿主载荷里没有宏观两档字段'), `原因必须指出"宿主载荷缺字段"（可操作，且进悬停）：${d.kpi?.['美国十年期国债收益率']?.source}`)
})

const KPI_LABELS = ['蛋糕温度', '流动性支持度', '美国十年期国债收益率', '广义美元指数'] as const

test('⑪ 常驻文案不得出现括号解释与整句原因；原因进悬停；口径事实与边界声明不得消失', () => {
  const payload = payloadFixture()
  const data = globalFlowToolData(payload, 0)
  // ① 禁止出现的常驻片段（用户口径 v0.90.0）
  const banned = ['曲线序列不足两步', '自采样不足一条', '自采样不足两条', '自采样不足 5 条', '未取到：', '⇒']
  for (const label of KPI_LABELS) {
    const cell = data.kpi?.[label]
    assert.equal(cell !== undefined, true, `磁贴 ${label} 必须存在`)
    for (const b of banned) {
      assert.equal((cell?.delta ?? '').includes(b), false, `磁贴「${label}」常驻文案不许出现「${b}」：${cell?.delta}`)
    }
    // 常驻只允许：值 + 「较上日 <短标记>」（且不许括号）
    if (cell?.delta !== null && cell?.delta !== undefined) {
      assert.match(cell.delta, /^较上日 (—|[+-]?\d)/, `常驻 delta 只能是「较上日 + 短标记」：${label} → ${cell.delta}`)
      assert.equal(cell.delta.includes('（'), false, `常驻 delta 不许带括号解释：${label} → ${cell.delta}`)
    }
  }
  // ② 蛋糕温度：365 个序列日 ⇒ 「较上日」必须算得出来（不许显示 —）
  const longCurve = { ...payload, curve: { ...payload.curve, points: [...Array(20)].flatMap((_, i) => [{ ...payload.curve.points[2], day: `2026-09-${String(i + 1).padStart(2, '0')}` }]) } }
  const dLong = globalFlowToolData(longCurve as typeof payload, 0)
  assert.match(dLong.kpi?.['蛋糕温度']?.delta ?? '', /^较上日 [+-]?\d/, `曲线有历史时「较上日」必须可算：${dLong.kpi?.['蛋糕温度']?.delta}`)
  // ②b 回放窗口只有一天（曲线只有一个点）⇒ 常驻也只能是短标记「较上日 —」（不许带括号解释）
  const onePoint = { ...payload, curve: { ...payload.curve, points: [payload.curve.points[2]], window: 1, windowOptions: [1] } }
  const dOne = globalFlowToolData(onePoint as typeof payload, 0)
  for (const label of KPI_LABELS) {
    const cell = dOne.kpi?.[label]
    if (cell?.delta === null || cell?.delta === undefined) continue
    assert.match(cell.delta, /^较上日 (—|[+-]?\d)/, `单点曲线下常驻也只能是短标记：${label} → ${cell.delta}`)
    assert.equal(cell.delta.includes('（'), false, `单点曲线下不许出现括号解释：${label} → ${cell.delta}`)
  }
  // ③ 缺数据的整句原因必须能在悬停里读到（不是删掉事实）
  const noMacro = { ...payload }
  delete (noMacro as { macro?: unknown }).macro
  const dNo = globalFlowToolData(noMacro as typeof payload, 0)
  const us = dNo.kpi?.['美国十年期国债收益率']
  assert.equal(us?.delta, '较上日 —', '常驻只留短标记')
  assert.ok((us?.source ?? '').includes('宿主载荷里没有宏观两档字段'), `原因必须进悬停：${us?.source}`)
  // ④ 口径事实与边界声明不得消失
  assert.equal((data.curve?.marks?.length ?? 0) > 0, true, '曲线口径标记（实测日/重建日）不得消失')
  assert.ok((data.boundary ?? []).length > 0, '边界声明不得消失')
  assert.ok((data.status ?? '').length > 0, '状态行（数据时刻/降级标记）不得消失')
  // ⑤ 反例注入：把整句原因塞回常驻 ⇒ 断言必须失败
  const injected = { ...dNo, kpi: { ...(dNo.kpi ?? {}), 美国十年期国债收益率: { ...(us as NonNullable<typeof us>), delta: '未取到：宿主载荷里没有宏观两档字段（宿主插件尚未重载到本版）⇒ 稍后重试' } } }
  assert.throws(() => {
    for (const b of ['未取到：', '⇒']) assert.equal((injected.kpi?.['美国十年期国债收益率']?.delta ?? '').includes(b), false, `常驻不许出现「${b}」`)
  }, /常驻不许出现/, '⚠ 反例（整句原因回常驻）必须失败')
})
