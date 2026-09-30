/**
 * Host-half self-test: pure accounting + store round-trip + live Eastmoney
 * probes. Run:  npm run selftest   (node type-stripping; no build needed)
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataStore, normalizeRescuePrefs, replayPosition, secidKey, sortLedger, dataHome } from './store.ts'
import { assemblePortfolio, derivePosition, ledgerViews, shanghaiDayStart, verbLabel } from './portfolio.ts'
import * as em from './em.ts'
import { fillLastGood, hasQuoteFallback, mergeBars, quoteFreshnessMs, quoteFromTencent, resampleYearly, setQuoteFreshnessMs, summarizeQuoteProvenance } from './em.ts'
import { parseTencentStamp, parseTencentSuggest, suggestKindFromTencent, tencentCode, unescapeUnicode } from './tencent.ts'
import { parseSinaEtfRanking, parseSinaHq, sinaCovered, sinaSymbol } from './sina.ts'
import { breakerFor, breakerSummary, hostsAllowed, minutesToFullyRecover, minutesToRecover } from './breaker.ts'
import { HttpError, httpStatusOf, retryAfterSecondsOf } from './http.ts'
import { SingleFlight } from './singleflight.ts'
import { losslessJson } from './tools.ts'
import { DEFAULT_PREFS } from '../shared/model.ts'
import { canonicalEconomy, macroEventsFromEm, macroImportance, parseEmDate } from './calendar.ts'
import { RescueMonitor, stripSnapshot } from './rescue.ts'
import { CircuitBreaker } from './breaker.ts'
import { calibratePooled, computePattern, computePosition, laneOutcomeStats, patternScore, positionScore, sanitizeBars } from './bottom.ts'
import {
  CORE_OUTFLOW_VETO, FLOW_WINDOW_MS, PERSIST_ANCHORS, PULSE_HIT_SCORE, divergenceScore, interpScore, isTailElapsed,
  pickPulseRef,
  progressAt, pulseAnchorsFor, pulseBandLabel, quantile, resonanceScore, scoreRescue, sessionElapsed,
  phaseOf, pulseFactorLabel, timeCoefficient, windowFlowStats,
} from './rescue.ts'
import { RESCUE_CALIBRATION } from './rescue-thresholds.ts'
import { TW_ALL_SECIDS, TW_ROWS, rescueUniverseMeta } from '../shared/model.ts'
import type { DailyBarLite, QuoteRow, RescueEtfView, RescueSnapshot } from '../shared/model.ts'

let failures = 0
const ok = (cond: boolean, msg: string): void => {
  if (cond) console.log('  PASS', msg)
  else {
    failures += 1
    console.error('  FAIL', msg)
  }
}
const softOk = (cond: boolean, msg: string, extra?: string): void => {
  if (cond) console.log('  PASS(soft)', msg)
  else console.log(`  WARN(soft) ${msg}${extra !== undefined ? ` — ${extra}` : ''}`)
}

function fakeQuote(secid: string, price: number, prev: number): QuoteRow {
  return { secid, code: secid, name: secid, price, chg: price - prev, pct: ((price - prev) / prev) * 100, prev, open: price, high: price, low: price, vol: 0, amount: 0, up: null, down: null, even: null, time: null }
}

async function main(): Promise<void> {
  // 隔离：本文件含真实网络探针，会触发 LKG / K线缓存落盘。若不重定向 DSH_HOME，
  // 会写进用户真实的数据目录（~/.dsh/dsh-tradewatcher）。所有落盘路径都经由
  // dataHome()，它在调用时读该环境变量，因此这里设置即可生效。
  process.env.DSH_HOME ??= mkdtempSync(join(tmpdir(), 'tw-selftest-home-'))
  console.log('== tradewatcher host selftest ==')
  console.log('dataHome:', dataHome())
  console.log('-- store & accounting --')
  const dir = mkdtempSync(join(tmpdir(), 'tw-selftest-'))
  try {
    const store = new DataStore(dir)
    await store.init()

    // watch groups
    await store.mutateWatch({ op: 'addGroup', name: '核心观察' })
    await store.mutateWatch({ op: 'addItem', groupId: store.watchData().groups[0].id, secid: '1.600519', symbolName: '贵州茅台' })
    ok(store.watchData().items.length === 1, 'watch item added')
    let dup = false
    try {
      await store.mutateWatch({ op: 'addItem', groupId: store.watchData().groups[0].id, secid: '1.600519', symbolName: '贵州茅台' })
    } catch {
      dup = true
    }
    ok(dup === true, 'duplicate watch item rejected')
    await store.mutateWatch({ op: 'archiveGroup', groupId: store.watchData().groups[0].id })
    ok(store.watchData().groups[0].archived === true, 'watch group archived')
    await store.mutateWatch({ op: 'restoreGroup', groupId: store.watchData().groups[0].id })

    // portfolio: group + position + trades
    await store.mutatePortfolio({ op: 'addGroup', name: '长期持有' })
    const pg = store.portData().groups[0]
    await store.mutatePortfolio({ op: 'addPos', groupId: pg.id, secid: '1.600519', symbolName: '贵州茅台' })
    const pos = store.portData().items[0]
    await store.mutatePortfolio({ op: 'buy', posId: pos.id, qty: 100, price: 10, fee: 5, note: '首建仓' })
    await store.mutatePortfolio({ op: 'sell', posId: pos.id, qty: 40, price: 12, fee: 3 })
    await store.mutatePortfolio({ op: 'adjust', posId: pos.id, qty: 30, price: 9, note: '成本修正' })

    // oversell rejected
    let over = false
    try {
      await store.mutatePortfolio({ op: 'sell', posId: pos.id, qty: 999, price: 12 })
    } catch {
      over = true
    }
    ok(over === true, 'oversell rejected')

    const entries = store.ledgerEntries()
    ok(entries.length === 5, `ledger has ${entries.length} entries (gcreate, add, buy, sell, adjust) got ${entries.map((e) => e.verb).join(',')}`)

    // replay state: buy 100@10 fee5 → avg 10.05; sell 40 → realized (12-10.05)*40-3 = 75; adjust → qty 30 avg 9
    const state = replayPosition(entries, pos.id)
    ok(Math.abs(state.qty - 30) < 1e-9, `adjust qty → 30 (got ${state.qty})`)
    ok(Math.abs(state.avgCost - 9) < 1e-9, `adjust avgCost → 9 (got ${state.avgCost})`)
    ok(Math.abs(state.realized - 75) < 1e-6, `realized → 75 (got ${state.realized})`)

    // assemble with fake quote
    const q = fakeQuote('1.600519', 15, 9)
    const { view } = assemblePortfolio(store.portData().groups, store.portData().items, entries, { '1.600519': q })
    const row = view.positions[0]
    ok(row !== undefined, 'position row derived')
    ok(Math.abs(row.qty - 30) < 1e-9 && Math.abs(row.avgCost - 9) < 1e-9, 'row qty/cost')
    ok(row.mv !== null && Math.abs(row.mv - 450) < 1e-6, `mv → 450 (got ${row.mv})`)
    ok(row.floatPnlPct !== null && Math.abs(row.floatPnlPct - 66.67) < 0.01, `floatPnlPct → 66.67 (got ${row.floatPnlPct})`)
    ok(row.dayPnlPct !== null && Math.abs(row.dayPnlPct - 37.2) < 0.01, `dayPnlPct → 37.2 (got ${row.dayPnlPct})`)
    ok(row.floatPnl !== null && Math.abs(row.floatPnl - 180) < 1e-6, `floatPnl → 180 (got ${row.floatPnl})`)
    // dayPnl: all entries today → buys 100@10 fee5: (15-10)*100-5 = 495; sells 40@12 fee3: (12-15)*40-3 = -123 → 372
    ok(row.dayPnl !== null && Math.abs(row.dayPnl - 372) < 1e-6, `dayPnl → 372 (got ${row.dayPnl})`)
    ok(Math.abs(view.grand.totalMv - 450) < 1e-6, 'grand mv')
    ok(Math.abs(view.grand.dayPnl - 372) < 1e-6, 'grand dayPnl')

    // backfill: a pre-day buy affects the day-open base
    await store.mutatePortfolio({ op: 'addGroup', name: '隔夜测试' })
    const g2 = store.portData().groups.find((x) => x.name === '隔夜测试')
    await store.mutatePortfolio({ op: 'addPos', groupId: g2?.id ?? '', secid: '0.300750', symbolName: '宁德时代' })
    const pos2 = store.portData().items.find((x) => x.groupId === g2?.id)
    const yesterday = shanghaiDayStart(Date.now()) - 2 * 86400000
    await store.mutatePortfolio({ op: 'buy', posId: pos2?.id ?? '', qty: 10, price: 100, fee: 0, ts: yesterday })
    await store.mutatePortfolio({ op: 'buy', posId: pos2?.id ?? '', qty: 5, price: 120, fee: 0 })
    const q2 = fakeQuote('0.300750', 130, 90)
    const port2 = store.portData()
    const { view: v2 } = assemblePortfolio(port2.groups, port2.items, store.ledgerEntries(), { '0.300750': q2 })
    const r2 = v2.positions.find((x) => x.secid === '0.300750')
    // base: 10*(130-90)=400; today buy: 5*(130-120)=50 → 450
    ok(r2?.dayPnl !== null && r2 !== undefined && Math.abs(r2.dayPnl - 450) < 1e-6, `dayPnl with overnight base → 450 (got ${r2?.dayPnl})`)
    ok(r2?.dayPnlPct !== null && r2 !== undefined && Math.abs(r2.dayPnlPct - 30) < 0.01, `dayPnlPct overnight → 30 (got ${r2?.dayPnlPct})`)

    // persist round-trip: new store on same dir
    const store2 = new DataStore(dir)
    await store2.init()
    ok(store2.ledgerEntries().length === store.ledgerEntries().length, 'ledger persisted & reloaded')
    ok(store2.portData().items.length === 2, 'positions persisted')
    ok(store2.watchData().groups.length === 1, 'watch persisted')

    const lv = ledgerViews(store2.ledgerEntries(), store2.portData().groups, store2.portData().items, { limit: 3 })
    ok(lv.length === 3 && typeof lv[0].ts === 'number', 'ledger views newest first')
    ok(verbLabel('buy') === '买入' && verbLabel('gcreate') === '新建分组', 'verb labels zh')

    // prefs
    await store2.setPrefs({ refreshSec: 30, theme: 'dark' })
    ok(store2.getPrefs().refreshSec === 30 && store2.getPrefs().theme === 'dark', 'prefs persisted')
    // 排序偏好：白名单校验（非法键抛错而不是静默写入），合法值落盘并在重载后保留
    ok(store2.getPrefs().watchSort.key === 'default' && store2.getPrefs().portSort.key === 'default', '排序偏好有默认值')
    await store2.setPrefs({ watchSort: { key: 'mv', desc: false }, portSort: { key: 'weight', desc: true } })
    ok(store2.getPrefs().watchSort.key === 'mv' && store2.getPrefs().watchSort.desc === false, '自选排序可写')
    ok(store2.getPrefs().portSort.key === 'weight' && store2.getPrefs().portSort.desc === true, '持仓排序可写')
    let sortRejected = 0
    for (const bad of [
      { watchSort: { key: 'nope', desc: true } },
      { watchSort: { key: 'mv', desc: 'yes' } },
      { portSort: 'mv' },
      { portSort: { key: 'pnl', desc: 1 } },
    ]) {
      try {
        await store2.setPrefs(bad as Parameters<typeof store2.setPrefs>[0])
      } catch {
        sortRejected += 1
      }
    }
    ok(sortRejected === 4, `非法排序偏好全部被拒（${sortRejected}/4）`)
    ok(store2.getPrefs().watchSort.key === 'mv', '被拒的写入不污染已有偏好')
    {
      // 重载（模拟重启）：明文文件里的排序偏好必须保留；手改成非法值时回退默认而不带进界面
      const store3 = new DataStore(dir)
      await store3.init()
      ok(store3.getPrefs().portSort.key === 'weight', '排序偏好跨重启保留')
      writeFileSync(join(dir, 'prefs.json'), JSON.stringify({ ...store3.getPrefs(), watchSort: { key: 'garbage' }, portSort: { key: 'dayPnl', desc: false } }), 'utf8')
      const store4 = new DataStore(dir)
      await store4.init()
      ok(store4.getPrefs().watchSort.key === 'default', '手改的非法排序键在装载时回退默认（不带到界面）')
      ok(store4.getPrefs().portSort.key === 'dayPnl' && store4.getPrefs().portSort.desc === false, '同一文件里的合法排序偏好保留')
      writeFileSync(join(dir, 'prefs.json'), JSON.stringify({ ...store3.getPrefs() }), 'utf8')
    }

    // 摊薄成本（券商口径）：买入 100@10，卖出 50@8 → 摊薄成本 = (1000-400)/50 = 12
    {
      const entries2 = [
        { id: 'd1', ts: 1, actor: 'web' as const, verb: 'buy' as const, posId: 'P1', secid: '1.000001', qty: 100, price: 10, fee: 0 },
        { id: 'd2', ts: 2, actor: 'web' as const, verb: 'sell' as const, posId: 'P1', secid: '1.000001', qty: 50, price: 8, fee: 0 },
      ]
      const item = { id: 'P1', groupId: 'G1', secid: '1.000001', name: '测试', createdAt: 0 }
      const row = derivePosition(entries2, item, { ...fakeQuote('1.000001', 11, 10) }, 3)
      ok(Math.abs(row.avgCost - 10) < 1e-9, `均价成本 → 10 (got ${row.avgCost})`)
      ok(row.dilutedCost !== null && Math.abs(row.dilutedCost - 12) < 1e-9, `摊薄成本 → 12 (got ${row.dilutedCost})`)
      ok(row.dilutedPnl !== null && Math.abs(row.dilutedPnl - -50) < 1e-6, `持仓盈亏(摊薄) → -50 (got ${row.dilutedPnl})`)
      ok(Math.abs((row.floatPnl + row.realized) - (row.dilutedPnl ?? 0)) < 1e-6, '摊薄盈亏 == 均价浮盈 + 已实现')
    }

    // 财经日历：东财宏观行解析（纯函数，fixture 取自真实返回）
    {
      const rows = [
        { STARTDATE: '2026/9/17 2:00:00', ENDDATE: '2026/9/17 0:00:00', FINCODE: '1', FINNAME: '美国:联邦基金利率目标:上限(报告期:2026年09月)' },
        { STARTDATE: '2026/9/16 2:00:00', ENDDATE: '2026/9/17 0:00:00', FINCODE: '2', FINNAME: '美联储议息会议' },
        { STARTDATE: '2026/9/9 9:30:00', ENDDATE: '2026/9/9 0:00:00', FINCODE: '3', FINNAME: '中国:CPI:同比(报告期:2026年08月)' },
        { STARTDATE: '2026/9/7 12:00:00', ENDDATE: '2026/9/7 0:00:00', FINCODE: '4', FINNAME: '泰国:CPI:同比(报告期:2026年08月)' },
        { STARTDATE: '2026/8/30 0:00:00', ENDDATE: '2026/9/3 0:00:00', FINCODE: '5', FINNAME: '8月30日至9月3日,国家主席习近平出席2026年上海合作组织峰会' },
      ]
      const evs = macroEventsFromEm(rows)
      const fed = evs.find((e) => e.title.includes('联邦基金利率'))!
      const fomc = evs.find((e) => e.title === '美联储议息会议')!
      const cn = evs.find((e) => e.title.startsWith('中国 CPI'))!
      const summit = evs.find((e) => e.title.includes('上海合作组织'))!
      ok(evs.length === 4, `非核心经济体被过滤 (got ${evs.length})`)
      ok(evs.every((e) => e.autoKey !== undefined && e.autoKey.startsWith('macro:')), '宏观事件 autoKey 前缀')
      ok(fed.category === 'macro-intl' && fed.time === '02:00' && fed.importance === 3, `美国利率决议 → 国际宏观/02:00/高 (got ${fed.category}/${String(fed.time)}/${fed.importance})`)
      ok(fomc.category === 'macro-intl' && fomc.endDate === '2026-09-17' && fomc.time === '02:00', `美联储议息会议跨日 (got ${String(fomc.endDate)})`)
      ok(cn.category === 'macro-cn' && cn.date === '2026-09-09', `中国 CPI → 国内宏观 (got ${cn.category})`)
      ok(summit.category === 'other' && summit.endDate === '2026-09-03' && summit.time === undefined, `无国家前缀事件 → 其他且 00:00 视为未定时刻`)
      ok(parseEmDate('2026/9/15 0:00:00', '2026/9/15 0:00:00')?.time === undefined, '00:00 省略时刻')
      ok(canonicalEconomy('美国EIA原油库存') === '美国' && canonicalEconomy('欧元区19国') === '欧元区' && canonicalEconomy('泰国') === null, '经济体归一化')
      ok(macroImportance('美国:非农就业人数:季调(报告期:2026年08月)') === 3 && macroImportance('中国：库存:铁矿石:46港') === 1, '重要性启发式')
    }

    // 护盘信号：阈值/评分纯函数
    {
      const curve = RESCUE_CALIBRATION.progressCurve
      const p10 = progressAt(curve, 30)
      const p1130 = progressAt(curve, 120)
      const p1430 = progressAt(curve, 210)
      ok(Math.abs(p1130 - 0.609) < 0.02 && p10 < p1130 && p1130 < p1430, `日内进度曲线单调且 11:30≈60.9% (got ${(p1130 * 100).toFixed(1)}%)`)
      ok(progressAt(curve, 240) === 1, '收盘进度 = 100%')
      ok(sessionElapsed('12:00') === 120 && sessionElapsed('09:00') === 0 && sessionElapsed('15:30') === 240, '交易时段分钟折算（含午休）')
      const anchors: [number, number, number] = [RESCUE_CALIBRATION.f1.mid, RESCUE_CALIBRATION.f1.high, RESCUE_CALIBRATION.f1.extreme]
      ok(interpScore(anchors[0], anchors) === 40 && interpScore(anchors[1], anchors) === 70 && interpScore(anchors[2], anchors) === 100, '量能倍数锚点 → 40/70/100')
      ok(interpScore(0, anchors) === 0 && interpScore(anchors[2] * 3, anchors) === 100, '量能倍数记分边界')
      ok(divergenceScore(-1.2) === 100 && divergenceScore(-0.5) === 80 && divergenceScore(0.2) === 35 && divergenceScore(2) === 20, '量价背离阶梯')
      ok(resonanceScore(0) === 0 && resonanceScore(1) === 40 && resonanceScore(2) === 70 && resonanceScore(3) === 100, '共振记分')
      ok(timeCoefficient(30) === 0.4 && timeCoefficient(200) === 1.1, '时点系数（早盘低/尾盘高）')
      ok(quantile([1, 2, 3, 4, 5], 50) === 3, '分位数取中位')

      // 脉冲锚点按时段分档（P0）：早盘锚点必须低于尾盘，且命中线为 P90
      const early = pulseAnchorsFor(20)
      const tailA = pulseAnchorsFor(225)
      ok(early[1] < tailA[1] && early[0] > 1 && tailA[2] > early[2], `脉冲锚点分档：早盘 P90 ${early[1].toFixed(2)}x < 尾盘 ${tailA[1].toFixed(2)}x`)
      ok(pulseBandLabel(20) === '早盘' && pulseBandLabel(225) === '尾盘' && isTailElapsed(190) === true && isTailElapsed(120) === false, '时段标签与尾盘判定')
      ok(interpScore(early[1], early) === 70 && interpScore(tailA[1], tailA) === 70, '分档锚点的 P90 均对应 70 分')

      const f2: [number, number, number] = [RESCUE_CALIBRATION.f2.watch, RESCUE_CALIBRATION.f2.mid, RESCUE_CALIBRATION.f2.strong]
      const base = {
        f2Anchors: f2, f2Source: 'empirical' as const, timeCoef: 1, pulseAnchors: tailA,
        isTail: true, bandLabel: '尾盘', retraceRatio: 0, coreResonance: 1, resonanceLanes: ['沪深300'],
      }
      const strongInput = {
        ...base, timeCoef: 1.1, timeAdjMult: 3, coreSuperVsAvg: 1.4, peripheralSuperVsAvg: 1.2,
        pulseMult: 5, persistShare: 0.4, indexPct: -1.4, resonance: 3, coreResonance: 2,
      }
      const calm = scoreRescue({ ...base, timeAdjMult: 0.9, coreSuperVsAvg: 0.05, peripheralSuperVsAvg: 0.04, pulseMult: 1, persistShare: 0.01, indexPct: 0.2, resonance: 0 })
      const typical = scoreRescue(strongInput)
      const capped = scoreRescue({ ...strongInput, indexPct: 2 })
      const thin = scoreRescue({ ...strongInput, coreSuperVsAvg: 0.3, peripheralSuperVsAvg: 0.3, persistShare: 0.3, indexPct: -1.2 })
      ok(calm.level === 0, `平淡日 → 平静 (got ${calm.level}, ${calm.score} 分)`)
      ok(typical.level === 3 && typical.score >= 75, `典型护盘日 → 强护盘信号 (got ${typical.level}, ${typical.score} 分)`)
      ok(capped.level === 1 && capped.summary.includes('追涨'), `指数+2% 的天量 → 封顶资金异动 (got ${capped.level})`)
      ok(thin.level === 2, `超大单偏弱 → 降为疑似护盘 (got ${thin.level})`)

      // P0-① 时点系数必须真正作用到评分（此前 tick 未传，运行时恒为 1）
      const sameButEarly = scoreRescue({ ...strongInput, timeCoef: 0.4 })
      ok(sameButEarly.score < typical.score && sameButEarly.score <= 40, `同一盘面在早盘被时点系数压到 ${sameButEarly.score} 分（尾盘 ${typical.score} 分）`)

      // P0-② 核心通道大额净流出 → 硬封顶「资金异动」（复现 9/24 沪深300 −38.9% 那类场景）
      const veto = scoreRescue({ ...strongInput, coreWorstShare: -0.389 })
      ok(veto.level === 1 && veto.summary.includes('与托底特征相反'), `核心通道净流出 ${(CORE_OUTFLOW_VETO * 100).toFixed(0)}% 阈值 → 封顶资金异动 (got ${veto.level})`)

      // P0-③ 强信号必须核心通道参与；④ 仅外围净流入时 F2 打折
      const periOnly = scoreRescue({ ...strongInput, coreResonance: 0, resonanceLanes: ['科创50'], coreSuperVsAvg: -0.1, peripheralSuperVsAvg: 0.3 })
      ok(periOnly.level <= 2 && periOnly.summary.includes('核心通道'), `核心未参与共振 → 至多疑似护盘 (got ${periOnly.level})`)
      // 同样的 0.3x 幅度：核心通道得 50 分，仅外围净流入打 0.7 折后 → 0.21x ≈ 41 分
      const coreSame = scoreRescue({ ...strongInput, coreSuperVsAvg: 0.3, peripheralSuperVsAvg: 0.3 })
      const f2Core = coreSame.factors.find((f) => f.id === 'superflow')!
      const f2Peri = periOnly.factors.find((f) => f.id === 'superflow')!
      ok(f2Core.score > f2Peri.score + 5, `同样 0.3x：核心通道 ${f2Core.score} 分 > 仅外围 ${f2Peri.score} 分（打 0.7 折）`)
      ok(typical.factors[0].id === 'volume' && typical.factors.length === 6 && Math.abs(typical.factors.reduce((a, f) => a + f.weight, 0) - 1) < 1e-9, '六因子权重合计 = 1')
      ok(typical.factors[2].label === '尾盘突袭' && typical.factors[2].score > 0 && !!typical.factors[3].threshold.includes('窗口成交额'), 'F3 尾盘命名与 F4 窗口口径')
      ok(PULSE_HIT_SCORE === 70 && PERSIST_ANCHORS[0] === 0.05, '脉冲命中线 = P90，持续性锚点以窗口成交额归一')

      // 阶段语义：收盘后不得再叫「尾盘突袭」，避免误读为刚发生
      ok(phaseOf('09:40') === 'am' && phaseOf('12:10') === 'noon' && phaseOf('13:30') === 'pm' && phaseOf('14:45') === 'tail' && phaseOf('15:30') === 'closed', '交易阶段判定')
      ok(pulseFactorLabel('tail') === '尾盘突袭' && pulseFactorLabel('am') === '盘中脉冲' && pulseFactorLabel('closed') === '脉冲（盘后）', '脉冲因子名称随阶段变化')

      // 完整度：因子缺失如实标注（冷启动回填失败时会出现）
      const partial = scoreRescue({ ...strongInput, pulseMult: null, persistShare: null })
      ok(partial.completeness.total === 6 && partial.completeness.available === 4, `脉冲与持续性缺失 → 因子 4/6（got ${partial.completeness.available}/${partial.completeness.total}）`)
      ok(partial.completeness.missing.join(',') === '脉冲,持续性', `缺失项列出：${partial.completeness.missing.join('、')}`)
      ok(partial.summary.includes('评分偏保守'), '归因里注明因子不完整且评分偏保守')
      ok(typical.completeness.available === 6 && typical.summary.includes('评分偏保守') === false, '因子齐全时不显示完整度说明')

      // F4 窗口统计（纯函数）：稳定净流入 / 无参考点 / 反复进出
      const t0 = 1_700_000_000_000
      const steady = [0, 60, 120, 180, 240, 300].map((m, i) => ({ ts: t0 + m * 1000, amount: (i + 1) * 1e8, superNet: i * 2e7 }))
      const steadyOut = windowFlowStats(steady, t0 + 300_000)
      ok(steadyOut.persistShare !== null && Math.abs(steadyOut.persistShare - 0.2) < 1e-9, `稳定净流入 → 净增/窗口成交额 = 20% (got ${steadyOut.persistShare?.toFixed(3)})`)
      ok(steadyOut.retraceRatio === 0, '单调净流入 → 无回撤')
      const fresh = [{ ts: t0, amount: 1e8, superNet: 1e7 }, { ts: t0 + 30_000, amount: 1.3e8, superNet: 1.4e7 }]
      ok(windowFlowStats(fresh, t0 + 30_000).persistShare === null, '窗口历史不足 → null（不拿 30 秒当 5 分钟）')
      const choppy = [
        { ts: t0, amount: 1e8, superNet: 0 },
        { ts: t0 + 60_000, amount: 2e8, superNet: 3e7 },
        { ts: t0 + 120_000, amount: 3e8, superNet: 1e7 },
        { ts: t0 + 300_000, amount: 6e8, superNet: 3.2e7 },
      ]
      const choppyOut = windowFlowStats(choppy, t0 + 300_000)
      ok(choppyOut.retraceRatio !== null && choppyOut.retraceRatio > 0.5, `反复进出 → 回撤比 ${choppyOut.retraceRatio?.toFixed(2)} > 0.5（触发打折）`)
      const choppyScore = scoreRescue({ ...strongInput, persistShare: choppyOut.persistShare, retraceRatio: choppyOut.retraceRatio })
      const cleanScore = scoreRescue({ ...strongInput, persistShare: choppyOut.persistShare, retraceRatio: 0 })
      ok(choppyScore.factors[3].score < cleanScore.factors[3].score, '回撤比 >0.5 时 F4 打折生效')
    }

    // 护盘快照 LKG：本会话没有数据时回落到落盘的上次成功快照
    {
      const lkgDir = mkdtempSync(join(tmpdir(), 'tw-lkg-'))
      const good = {
        ts: Date.now() - 3600_000, level: 2 as const, score: 63, summary: '（fixture）',
        factors: [], etfs: [{ secid: '1.510300', name: '沪深300ETF华泰柏瑞', index: '沪深300' }],
        indexPct: -1.2, indexName: '沪深300', timeCoef: 1.1,
        resonance: { lanes: ['沪深300'], core: 1, peripheral: 0, intensity: 'systemic' as const },
        pulseBand: { elapsed: 200, label: '尾盘', isTail: true, anchors: [1.26, 1.91, 2.43] as [number, number, number], phase: 'tail' as const },
        completeness: { available: 6, total: 6, missing: [] },
        thresholdSource: 'empirical' as const, selfSampleDays: 5,
        config: { enabled: true, intervalSec: 60, tailIntervalSec: 15, tailFrom: '14:30', universe: [] },
        activeIntervalSec: 15,
      }
      writeFileSync(join(lkgDir, 'rescue-log.json'), JSON.stringify({ v: 1, days: {}, baselines: {}, selfSamples: {}, lastSnapshot: good }), 'utf8')
      const mon = new RescueMonitor(lkgDir, { enabled: true, intervalSec: 60, tailIntervalSec: 15, tailFrom: '14:30', universe: [] })
      await mon.init()
      const snap = mon.snapshot()
      ok(snap.etfs.length === 1 && snap.level === 2 && snap.stale === true, `本会话无数据 → 回落落盘 LKG（etfs ${snap.etfs.length}，stale ${String(snap.stale)}）`)
      ok((snap.note ?? '').includes('上次成功采样'), 'LKG 快照注明为上次成功采样')
      ok(mon.hasFreshData === false, 'hasFreshData 反映本会话尚未采到数据')
      rmSync(lkgDir, { recursive: true, force: true })
    }

    // ── Commit A 回归用例（数据安全四项）────────────────────────────────
    // T-01 损坏但合法的账本文件：不崩、自愈、且隔离备份原文件（绝不静默覆盖）
    {
      const dir = mkdtempSync(join(tmpdir(), 'tw-corrupt-'))
      writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ v: 1 }), 'utf8') // 合法 JSON、缺 entries
      const bad = new DataStore(dir)
      await bad.init()
      ok(bad.ledgerEntries().length === 0, '损坏账本 → init 不抛错且流水为空')
      const files = readdirSync(dir)
      ok(files.some((f) => f.startsWith('ledger.json.corrupt-')), `原文件被隔离备份（${files.filter((f) => f.includes('corrupt')).join(',')}）`)
      // 写入后原损坏文件仍在（未被覆盖）
      await bad.mutatePortfolio({ op: 'addGroup', name: '自愈验证' } as never)
      const stillThere = readdirSync(dir).some((f) => f.startsWith('ledger.json.corrupt-'))
      ok(stillThere, '后续写盘不覆盖隔离备份')
      rmSync(dir, { recursive: true, force: true })
    }

    // T-02 乱序插入的同一组流水：校验口径与展示口径必须一致（此前差 100 股）
    {
      const entries = [
        { id: 'e2', ts: 2000, actor: 'web' as const, verb: 'sell' as const, posId: 'P1', secid: '1.600519', qty: 100, price: 12, fee: 0 },
        { id: 'e1', ts: 1000, actor: 'web' as const, verb: 'buy' as const, posId: 'P1', secid: '1.600519', qty: 100, price: 10, fee: 0 },
      ]
      const byInsert = replayPosition(entries, 'P1')
      const bySorted = replayPosition(sortLedger(entries), 'P1')
      ok(byInsert.qty !== bySorted.qty, `乱序插入的两口径确有分叉（插入序 qty=${byInsert.qty} / ts 序 qty=${bySorted.qty}）—— 用例锁住的是"必须统一"`)
      ok(sortLedger(entries).map((e) => e.id).join(',') === 'e1,e2', 'sortLedger 按 ts 升序、同 ts 按 id 稳定')
      const shuffled = [entries[1], entries[0]]
      ok(sortLedger(shuffled).map((e) => e.id).join(',') === sortLedger(entries).map((e) => e.id).join(','), '不同插入顺序 → 同一排序结果')
    }

    // T-03 并发落盘：文件仍可解析且无 .tmp 残留（rescue 从 1 处写者变成 4 处）
    {
      const dir = mkdtempSync(join(tmpdir(), 'tw-atomic-'))
      const mon = new RescueMonitor(dir, { enabled: false, intervalSec: 60, tailIntervalSec: 15, tailFrom: '14:30', universe: [] })
      await mon.init()
      await Promise.all([mon.flush(), mon.flush(), mon.flush()])
      const raw = readFileSync(join(dir, 'rescue-log.json'), 'utf8')
      let parsed = false
      try { JSON.parse(raw); parsed = true } catch { /* 失败 */ }
      ok(parsed, '并发落盘后文件仍可 JSON.parse')
      ok(!readdirSync(dir).some((f) => f.endsWith('.tmp')), '无 .tmp 残留（tmp+rename 生效）')
      rmSync(dir, { recursive: true, force: true })
    }

    // T-04 熔断打开时 rawQuotes 不再发请求（此前熔断器没接管这条主路径）
    {
      const quote = breakerFor('push2delay.eastmoney.com')
      const fallbackHost = breakerFor('push2.eastmoney.com')
      for (let i = 0; i < 3; i++) { quote.recordFailure(new Error('blocked')); fallbackHost.recordFailure(new Error('blocked')) }
      ok(quote.allow() === false && fallbackHost.allow() === false, '两台行情主机同时进入熔断')
      let emCalls = 0
      let otherCalls = 0
      const realFetch = globalThis.fetch
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as Request).url)
        if (/push2/.test(url)) emCalls += 1
        else otherCalls += 1
        return realFetch(input as RequestInfo, init)
      }) as typeof fetch
      try {
        await em.fetchQuotes(['1.600519']).catch(() => undefined)
      } finally {
        globalThis.fetch = realFetch
      }
      ok(emCalls === 0, `熔断期间对被封的东财主机零请求（实测 ${emCalls} 次）`)
      ok(otherCalls >= 0, `备用源（腾讯）不受东财熔断影响（本次 ${otherCalls} 次）`)
      quote.recordSuccess(); fallbackHost.recordSuccess()
    }

    // 排序归一：校验必须走 ts 序（直接构造乱序账本，绕过写入端的超卖守卫）
    {
      const dir = mkdtempSync(join(tmpdir(), 'tw-sort-'))
      const T1 = Date.now() - 86400_000
      const T2 = Date.now()
      // 插入序 = [sell(T2) 在前, buy(T1) 在后]；ts 序 = [buy(T1), sell(T2)]
      // 按 ts 序持有 200−100=100；若按插入序校验则会以为持有 100 之前就卖了 → 结论不同
      writeFileSync(join(dir, 'positions.json'), JSON.stringify({
        v: 1,
        groups: [{ id: 'G1', name: '统一排序', order: 0 }],
        items: [{ id: 'P1', groupId: 'G1', secid: '1.600519', name: '贵州茅台', createdAt: T1 }],
      }), 'utf8')
      writeFileSync(join(dir, 'ledger.json'), JSON.stringify({
        v: 1,
        entries: [
          { id: 'e-sell', ts: T2, actor: 'web', verb: 'sell', posId: 'P1', groupId: 'G1', secid: '1.600519', qty: 100, price: 12, fee: 0 },
          { id: 'e-buy', ts: T1, actor: 'web', verb: 'buy', posId: 'P1', groupId: 'G1', secid: '1.600519', qty: 200, price: 10, fee: 0 },
        ],
      }), 'utf8')
      const st = new DataStore(dir)
      await st.init()
      const entries = st.ledgerEntries()
      const sorted = sortLedger(entries)
      const replay = replayPosition(sorted, 'P1')
      ok(Math.abs(replay.qty - 100) < 1e-9, `ts 序口径：净持仓 100（实测 ${replay.qty}）`)

      // 展示口径（portfolio 内部同样用 sortLedger）应与之一致
      const view = assemblePortfolio(st.portData().groups, st.portData().items, entries, {})
      ok(Math.abs((view.view.positions[0]?.qty ?? -1) - 100) < 1e-9, `portfolio 展示与校验一致（${view.view.positions[0]?.qty}）`)

      // 校验口径验证：ts 序持有 100 → 卖 150 必须被拒（若按插入序会误判为可卖）
      let rejected = false
      try {
        await st.mutatePortfolio({ op: 'sell', posId: 'P1', qty: 150, price: 12 } as never)
      } catch {
        rejected = true
      }
      ok(rejected, '超卖守卫按 ts 序判定：卖 150 > 持有 100 → 拒绝')

      let accepted = false
      try {
        await st.mutatePortfolio({ op: 'sell', posId: 'P1', qty: 100, price: 12 } as never)
        accepted = true
      } catch (error) {
        ok(false, `卖 100 应放行，实际报错：${String(error)}`)
      }
      ok(accepted, '卖 100 = 持有 100 → 放行（校验/展示同口径）')
      rmSync(dir, { recursive: true, force: true })
    }

    // 备用源覆盖：国际指数与大宗商品必须有兜底（此前 17 只无任何兜底）
    {
      const presets = TW_ALL_SECIDS
      const covered = presets.filter((s) => sinaSymbol(s) !== null || tencentCode(s) !== null)
      ok(presets.length === 23, `预设标的数 ${presets.length}`)
      ok(covered.length >= 20, `可用兜底的预设数 ${covered.length}/23（要求 ≥20）`)
      ok(sinaCovered(presets) >= 13, `新浪专供（国际指数 + 期货/外盘商品）${sinaCovered(presets)} 只`)
      ok(sinaSymbol('113.rbm') === 'nf_RB0' && sinaSymbol('122.XAU') === 'hf_XAU' && sinaSymbol('100.N225') === 'int_nikkei', '商品/国际指数映射正确')
      ok(sinaSymbol('100.KOSPI200') === null, '韩国 KOSPI200 无兜底 → 如实返回 null（不编代码）')
      // 解析：int_ / nf_ / hf_ 三种布局（字段下标按实测）
      const payload = [
        'var hq_str_int_nikkei="日经指数,44946.64,-408.35,-0.90";',
        'var hq_str_nf_RB0="螺纹钢连续,150000,3110.000,3122.000,3096.000,3105.000,3105.000,3106.000,3108.000";',
        'var hq_str_hf_XAU="4157.83,4114.930,4157.83,4158.18,4161.20,4113.30,19:36:00,4114.93";',
      ].join('\n')
      const parsed = parseSinaHq(payload)
      ok(parsed.int_nikkei?.price === 44946.64 && parsed.int_nikkei?.pct === -0.9, 'int_* 布局：最新与涨跌幅')
      ok(parsed.nf_RB0?.price === 3108 && parsed.nf_RB0?.prev === 3105, 'nf_* 布局：最新取 [8]、昨收取 [5]')
      ok(parsed.hf_XAU?.price === 4157.83 && parsed.hf_XAU?.prev === 4114.93, 'hf_* 布局：最新取 [0]、昨收取 [7]')
      ok(parseSinaHq('var hq_str_hf_XAU="4157.83,4114.930,4157.83,4158.18,4161.20,4113.30,19:36:00,999999.0";').hf_XAU?.pct === null, '昨收异常（涨跌幅 >25%）→ 不给结论')
    }

    // 板块/排行的备用源解析（东财行情 CDN 被限流时仍能显示板块涨跌）
    {
      const payload = JSON.stringify([
        { symbol: 'sh511360', code: '511360', name: '短融ETF海富通', trade: '100.02', changepercent: '0.011', amount: '44987000000', turnoverratio: '53.52' },
        { symbol: 'sz159915', code: '159915', name: '创业板ETF易方达', trade: '3.31', changepercent: '-4.8', amount: '6019000000', turnoverratio: '9.57' },
        { symbol: 'bad', code: 'x', name: '无效行' },
      ])
      const rows = parseSinaEtfRanking(payload)
      ok(rows.length === 2, `新浪 ETF 排行解析：保留沪/深、丢弃无效行（${rows.length} 条）`)
      ok(rows[0]?.secid === '1.511360' && rows[0]?.code === '511360', '沪市 symbol → secid 1.xxxxxx')
      ok(rows[1]?.secid === '0.159915' && Math.abs((rows[1].pct ?? 0) + 4.8) < 1e-9, '深市映射与涨跌幅解析')
      ok(Math.abs((rows[0].turnover ?? 0) - 53.52) < 1e-9 && Math.abs((rows[0].amount ?? 0) - 4.4987e10) < 1, '成交额与换手率解析（ETF 排行两列）')
      ok(parseSinaEtfRanking('not json').length === 0 && parseSinaEtfRanking('{"a":1}').length === 0, '异常响应返回空数组（不抛错）')
    }

    // 底部：位置 / 形态 / 概率（含"跨品种污染"的回归断言）
    {
      const mk = (close: number, high: number, low: number, vol: number, i: number): { date: string; open: number; close: number; high: number; low: number; vol: number } =>
        ({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, open: close, close, high, low, vol })
      // 位置：价格落在区间底部
      // 前 57 根上行，最后 3 根连续下跌收在区间低位（这样既在底部、又有连跌）
      const rising = Array.from({ length: 60 }, (_, i) => {
        const close = i < 57 ? 100 + i : 156 - (i - 56) * 19
        return mk(close, close * 1.01, close * 0.99, 1e6, i)
      })
      const atLow = computePosition(rising, rising[rising.length - 1].close)
      ok(atLow.percentile60 !== null && atLow.percentile60 <= 0.05, `价格在区间底部 → 分位 ≈ 0（got ${atLow.percentile60?.toFixed(2)}）`)
      ok(atLow.downStreak >= 1 && atLow.aboveLow60 !== null && atLow.aboveLow60 <= 0.02, `贴近 60 日低点、含连跌 (got ${atLow.aboveLow60?.toFixed(3)})`)
      const atHigh = computePosition(rising, Math.max(...rising.map((b) => b.close)))
      ok(atHigh.percentile60 === 1, '价格在区间高点 → 分位 = 100%')
      ok(positionScore(atLow) > positionScore(atHigh), `位置分随位置走（低位 ${positionScore(atLow)} > 高位 ${positionScore(atHigh)}）`)

      // 形态：回升/下影线/收回前低
      const pat = computePattern({ price: 10, open: 10.5, high: 11, low: 9, prevLow20: 9.5, atNewLow60: true })
      ok(pat.bouncePct !== null && Math.abs(pat.bouncePct - 11.11) < 0.05, `日内回升 ${pat.bouncePct?.toFixed(2)}%`)
      ok(pat.lowerShadow !== null && Math.abs(pat.lowerShadow - 0.5) < 1e-9, `下影线比例 ${pat.lowerShadow}`)
      ok(pat.reclaimedPrevLow === true && pat.newLowReclaimed === true, '破前低后收回 / 创新低后收回')
      const weak = computePattern({ price: 9.05, open: 10, high: 10.1, low: 9, prevLow20: 8, atNewLow60: false })
      ok(patternScore(pat) > patternScore(weak), `形态分：强形态 ${patternScore(pat)} > 弱形态 ${patternScore(weak)}`)

      // 概率：只在"低位 + 放量"的样本上统计，并且必须逐通道计算（回归：合并多品种日线会得出 +105% 之类荒唐值）
      const laneA: ReturnType<typeof mk>[] = []
      const laneB: ReturnType<typeof mk>[] = []
      for (let i = 0; i < 120; i++) {
        const base = 10 + (i % 7 === 0 ? -1.2 : 0.3) // 制造低位形态
        const up = i % 7 === 0
        laneA.push(mk(up ? base : base, up ? base * 1.05 : base * 0.99, up ? base * 0.98 : base * 0.95, up ? 3e6 : 1e6, i))
        laneB.push(mk((up ? base : base) * 100, (up ? base * 1.05 : base * 0.99) * 100, (up ? base * 0.98 : base * 0.95) * 100, up ? 3e6 : 1e6, i))
      }
      const st = laneOutcomeStats(laneA, { percentileMax: 0.3, volumeMin: 1.0, horizon: 5, targets: [0.02] })
      ok(st.n > 0 && st.baseN > st.n, `逐通道样本：同类 ${st.n} / 基线 ${st.baseN}`)
      const pooled = calibratePooled([laneA, laneB], { horizon: 5, targets: [0.02] })
      ok(pooled.lanes === 2 && pooled.n === st.n * 2, `跨通道合并统计（覆盖 ${pooled.lanes} 通道，N=${pooled.n}）`)
      ok(pooled.medianForward !== null && Math.abs(pooled.medianForward) < 0.5, `前向收益中位数不被跨品种价格污染（got ${pooled.medianForward === null ? '—' : (pooled.medianForward * 100).toFixed(2) + '%'}）`)
      ok(pooled.targets[0]?.baseRate !== null && pooled.targets[0]?.prob !== null, '概率与无条件基线同时给出')
      const cal = calibratePooled([])
      ok(cal.n === 0 && cal.targets[0]?.prob === null, '无样本时概率为 null（不给伪结论）')
    }

    // 行情备用源（腾讯）：代码映射、时间戳解析、行转换（东财不可用时自选/持仓仍能刷新）
    {
      ok(tencentCode('1.510300') === 'sh510300' && tencentCode('0.159915') === 'sz159915', '沪/深 secid → 腾讯代码')
      ok(tencentCode('116.00148') === 'hk00148' && tencentCode('116.00100') === 'hk00100', '港股 secid → 腾讯代码（补零到 5 位）')
      ok(tencentCode('100.SX5E') === null && tencentCode('105.AAPL') === null, '国际指数/美股无腾讯映射（诚实返回 null）')
      const a = parseTencentStamp('20260924093817')
      const b = parseTencentStamp('2026/09/24 09:38:17')
      ok(a !== null && b !== null && Math.abs(a - b) < 1000, '两种时间戳格式解析一致（A股 14 位 / 港股带斜杠）')
      ok(parseTencentStamp('') === null, '空时间戳返回 null')
      const row = quoteFromTencent('1.510300', {
        secid: '1.510300', name: '沪深300ETF华泰柏瑞', price: 4.47, prev: 4.515, open: 4.51,
        pct: -1.0, high: 4.52, low: 4.46, vol: 1000, amount: 5.25e8, ts: 1_700_000_000_000,
        totalMv: 1067.7e8, floatMv: 1067.7e8,
      })
      ok(row !== null && row.source === 'tencent' && row.price === 4.47 && row.chg !== null && Math.abs(row.chg + 0.045) < 1e-9, '腾讯行转换：价/涨跌/来源标记正确')
      ok(row?.totalMv === 1067.7e8 && row?.floatMv === 1067.7e8, '腾讯行带上市值（供自选按总市值排序）')
      ok(quoteFromTencent('1.510300', { secid: '1.510300', name: '', price: null, prev: 1, open: null, pct: null, high: null, low: null, vol: null, amount: null, ts: null, totalMv: null, floatMv: null }) === null, '无有效价格的行被丢弃（不污染显示）')
    }

    // 搜索备用源（腾讯 smartbox）：转义还原、类型词表与解析
    {
      ok(unescapeUnicode('\\u6caa\\u6df1300ETF') === '沪深300ETF', 'smartbox 的 \\uXXXX 转义还原为中文')
      ok(suggestKindFromTencent('hk', 'GP') === '港股' && suggestKindFromTencent('sh', 'ETF') === 'ETF' && suggestKindFromTencent('sh', 'ZS') === '指数' && suggestKindFromTencent('sh', 'GP-A') === '股票', '类型词表对齐东财口径')
      const payload = 'v_hint="sh~510300~\\u6caa\\u6df1300ETF\\u534e\\u6cf0\\u67cf\\u745e~hs300etfhtbr~ETF^sz~159915~\\u521b\\u4e1a\\u677fETF\\u6613\\u65b9\\u8fbe~cybetf~ETF^us~AAPL~\\u82f9\\u679c~pg~GP"'
      const rows = parseTencentSuggest(payload)
      ok(rows.length === 2, `解析 smartbox：保留 A股/港股、丢弃无映射的美股（${rows.length} 条）`)
      ok(rows[0]?.secid === '1.510300' && rows[0]?.name === '沪深300ETF华泰柏瑞' && rows[0]?.kind === 'ETF', '首条：secid/中文名/类型正确')
      ok(rows[1]?.secid === '0.159915', '深市前缀映射为 0.')
      ok(parseTencentSuggest('v_hint=""').length === 0, '空结果返回空数组')
    }

    // 熔断按主机隔离：行情主机被限流不得连坐搜索
    {
      const quote = breakerFor('push2delay.eastmoney.com')
      for (let i = 0; i < 3; i++) quote.recordFailure(new Error('fetch failed'))
      ok(quote.allow() === false, '行情主机进入熔断')
      ok(hostsAllowed(['searchapi.eastmoney.com']).length === 1, '搜索主机不受行情熔断影响（关键修复）')
      ok(breakerFor('searchapi.eastmoney.com').allow() === true, '搜索主机自身仍放行')
      quote.recordSuccess()
      ok(quote.allow() === true, '行情恢复后复位')
    }

    // 自定义通道：解析、分组与评分离（板块 ETF 不计入护盘评分与共振）
    {
      const custom = [{ secid: '1.512480', name: '半导体ETF', index: '半导体' }, { secid: '1.512000', name: '券商ETF' }]
      const metas = rescueUniverseMeta([], custom)
      ok(metas.length === 8, `默认 6 只宽基 + 2 只自定义通道 (got ${metas.length})`)
      ok(metas.filter((m) => m.group === 'custom').length === 2, '自定义通道分组为 custom')
      ok(metas.filter((m) => m.group === 'core').length === 2 && metas.filter((m) => m.group === 'peripheral').length === 4, '宽基按核心/外围分组（核心 2 / 外围 4）')
      ok(rescueUniverseMeta([], []).length === 6, '未配置自定义通道时仍为默认 6 只')
      const dup = rescueUniverseMeta([], [{ secid: '1.510300', name: '重复的沪深300' }])
      ok(dup.length === 6 && dup.filter((m) => m.secid === '1.510300').length === 1, '与宽基重复的自定义通道被忽略')

      const parsed = normalizeRescuePrefs({ custom }, DEFAULT_PREFS.rescue)
      ok(parsed.custom?.length === 2 && parsed.custom[1].index === undefined, '自定义通道经 store 校验后入库')
      let rejected = 0
      for (const bad of [[{ secid: 'X1', name: 'ok' }], [{ secid: '1.510300', name: '' }], [{ secid: '1.510300', name: 'x'.repeat(30) }]]) {
        try { normalizeRescuePrefs({ custom: bad }, DEFAULT_PREFS.rescue) } catch { rejected += 1 }
      }
      ok(rejected === 3, `非法自定义通道全部被拒（${rejected}/3）`)
    }

    // 备用源（腾讯）只有量能与价格：资金流缺失时必须封顶，不能凭空判定"护盘"
    {
      const f2: [number, number, number] = [RESCUE_CALIBRATION.f2.watch, RESCUE_CALIBRATION.f2.mid, RESCUE_CALIBRATION.f2.strong]
      const strong = {
        f2Anchors: f2, f2Source: 'empirical' as const, timeCoef: 1.1, pulseAnchors: pulseAnchorsFor(225),
        isTail: true, bandLabel: '尾盘', retraceRatio: 0, coreResonance: 2, resonanceLanes: ['沪深300', '上证50'],
        timeAdjMult: 3, coreSuperVsAvg: 1.4, peripheralSuperVsAvg: 1.2, pulseMult: 5, persistShare: 0.4,
        indexPct: -1.4, resonance: 3,
      }
      const noFlow = scoreRescue({ ...strong, flowAvailable: false, coreSuperVsAvg: null, peripheralSuperVsAvg: null })
      ok(noFlow.level <= 1 && noFlow.summary.includes('分单资金流数据不可用'), `备用源下封顶为资金异动 (got ${noFlow.level})`)
      ok(noFlow.completeness.missing.includes('超大单强度'), '资金流缺失计入因子完整度')
      const withFlow = scoreRescue({ ...strong, flowAvailable: true })
      ok(withFlow.level === 3, '东财可用时不受该封顶影响')
    }

    // 上游熔断：连续失败即停手（避免把限流推成封锁），成功即复位
    {
      const b = new CircuitBreaker({ threshold: 3, baseMs: 60_000, maxMs: 900_000 })
      ok(b.allow() === true, '熔断器初始放行')
      b.recordFailure(new Error('fetch failed'))
      b.recordFailure(new Error('fetch failed'))
      ok(b.allow() === true, '未达阈值仍放行')
      b.recordFailure(new Error('fetch failed'))
      ok(b.allow() === false && b.state.trips === 1, '连续 3 次失败 → 打开熔断')
      ok(b.minutesLeft() >= 1 && (b.state.lastError ?? '').includes('fetch failed'), '熔断期间给出剩余时间与原因')
      b.recordSuccess()
      ok(b.allow() === true && b.state.trips === 0, '成功后完全复位')
    }

    // 半开探针失败 → 立即重熔并延长冷却（此前 until 停在过去时，主机每 2.5s 被探一次）
    {
      const b = new CircuitBreaker({ threshold: 3, baseMs: 50, maxMs: 1000 })
      for (let i = 0; i < 3; i++) b.recordFailure(new Error('blocked'))
      ok(b.allow() === false, '先打开熔断')
      await new Promise((r) => setTimeout(r, 70))
      ok(b.allow() === true && b.inHalfOpen === true, '冷却到期进入半开')
      ok(b.claimProbe() === true, '半开期领取探针')
      ok(b.claimProbe() === false, '半开期第二个调用不得并发探测')
      b.recordFailure(new Error('probe failed'))
      ok(b.allow() === false && b.minutesLeft() >= 1, `半开失败 → 立即重熔并延长冷却（trips=${b.state.trips}）`)
      b.recordSuccess()
      ok(b.allow() === true, '真正恢复后复位')
    }

    // 账本单条非法：隔离原件 + 保留可用条目（绝不静默丢数据）
    {
      const dir = mkdtempSync(join(tmpdir(), 'tw-badentry-'))
      writeFileSync(join(dir, 'ledger.json'), JSON.stringify({
        v: 1,
        entries: [
          { id: 'ok1', ts: 1000, actor: 'web', verb: 'add', posId: 'P1', secid: '1.600519', name: '贵州茅台' },
          { id: 'bad', actor: 'web', verb: 'buy' },                      // 缺 ts
          { id: 'future', ts: 3000, actor: 'web', verb: 'futuristic' },  // 未知 verb：保留不丢弃
        ],
      }), 'utf8')
      const st = new DataStore(dir)
      await st.init()
      const entries = st.ledgerEntries()
      ok(entries.length === 2, `保留可用条目 + 未知 verb（${entries.length} 条）`)
      ok(entries.some((e) => (e.verb as string) === 'futuristic'), '未知 verb 原样保留（避免降级丢数据）')
      ok(readdirSync(dir).some((f) => f.startsWith('ledger.json.corrupt-')), '单条非法同样隔离原件备份')
    }

    // 上游不可用时的当日复盘兜底：不再让标的卡整块消失
    {
      const fbDir = mkdtempSync(join(tmpdir(), 'tw-fb-'))
      const today = new Date().toISOString().slice(0, 10)
      const peaks = { '1.510300': -0.011, '1.510050': 0.245, '1.510500': 0.094, '1.512100': -0.001, '1.588000': 0.003, '0.159915': 0.004 }
      writeFileSync(join(fbDir, 'rescue-log.json'), JSON.stringify({
        v: 1, baselines: {}, selfSamples: {}, lastSnapshot: null, updatedAt: Date.now(),
        days: { [today]: { events: [], intraday: [], samples: 177, gap: false, etfPeak: peaks } },
      }), 'utf8')
      const mon = new RescueMonitor(fbDir, { enabled: true, intervalSec: 60, tailIntervalSec: 15, tailFrom: '14:30', universe: [] })
      await mon.init()
      const snap = mon.snapshot()
      ok(snap.etfs.length === 6 && snap.fallback !== undefined && snap.fallback.peaks.length === 6, `无 LKG 时按当日峰值合成 ${snap.etfs.length} 张复盘卡片（而非空白/表格）`)
      ok(snap.etfs.every((e) => e.provisional === true), '复盘卡片标记 provisional（与实时快照区分）')
      ok(snap.stale === true && (snap.note ?? '').includes('暂不可用'), '复盘兜底标注来源为上游不可用')
      const sh50 = snap.fallback?.peaks.find((p) => p.secid === '1.510050')
      ok(sh50 !== undefined && Math.abs((sh50.peakSuperVsAvg ?? 0) - 0.245) < 1e-9, '复盘表带当日真实峰值（上证50 0.245x）')
      rmSync(fbDir, { recursive: true, force: true })
    }

    // K线合并与年K重采样（纯函数）
    {
      const d = (date: string, close: number, extra: Partial<{ open: number; high: number; low: number }> = {}) =>
        ({ date, open: extra.open ?? close, close, high: extra.high ?? close, low: extra.low ?? close, vol: 1, pct: 0 })
      const merged = mergeBars([d('2024-01-01', 10), d('2024-01-02', 11)], [d('2024-01-02', 12), d('2024-01-03', 13)], 10)
      ok(merged.length === 3 && merged[1].close === 12 && merged[2].close === 13, `mergeBars 覆盖+追加 (got ${merged.map((b) => b.close).join(',')})`)
      const capped = mergeBars([d('2024-01-01', 1), d('2024-01-02', 2)], [d('2024-01-03', 3)], 2)
      ok(capped.length === 2 && capped[0].close === 2, 'mergeBars 截断保留最新')
      const months = [
        d('2025-01-31', 12, { open: 10, high: 13, low: 9 }),
        d('2025-02-28', 11, { open: 12, high: 12.5, low: 10.5 }),
        d('2026-01-30', 15, { open: 11, high: 16, low: 10 }),
      ]
      const years = resampleYearly(months)
      ok(years.length === 2, `年K 聚合为 2 根 (got ${years.length})`)
      ok(years[0].date === '2025-02-28' && years[0].open === 10 && years[0].close === 11 && years[0].high === 13 && years[0].low === 9,
        `年K 首根 OHLC 正确 (got ${JSON.stringify(years[0])})`)
      ok(years[1].close === 15 && years[1].pct !== null && Math.abs((years[1].pct as number) - 36.36) < 0.05,
        `年K 次根涨跌幅基于上年收盘 (got ${years[1].pct})`)
    }

    // lossless-JSON sanitizer (agent tool output contract)
    {
      const dirty = { a: 1, b: undefined, c: { d: NaN, e: -Infinity, f: 2 }, g: [1, undefined, 2] }
      const clean = losslessJson(dirty) as { a: number; c: { d: null; e: null; f: number }; g: Array<number | null> }
      ok(!('b' in (clean as object)) && clean.a === 1, 'lossless: undefined key dropped')
      ok(clean.c.d === null && clean.c.e === null && clean.c.f === 2, 'lossless: non-finite → null')
      ok(clean.g.length === 3 && clean.g[1] === null && clean.g[2] === 2, 'lossless: undefined array slot → null')
      const roundTrip = JSON.parse(JSON.stringify(clean))
      ok(JSON.stringify(roundTrip) === JSON.stringify(clean), 'lossless: JSON round-trip stable')
    }

    // last-known-good fill semantics (pure, custom bank)
    {
      const bank = new Map<string, QuoteRow>()
      const good = fakeQuote('1.600519', 1500, 1490)
      bank.set('1.600519', good)
      // 1) blank-price sample is field-filled from the bank
      const rows1 = new Map<string, QuoteRow>()
      const blank = { ...fakeQuote('1.600519', 1500, 1490), price: null, chg: null, pct: null, prev: null }
      rows1.set('1.600519', blank)
      fillLastGood(['1.600519'], rows1, bank)
      ok(rows1.get('1.600519')?.price === 1500 && rows1.get('1.600519')?.prev === 1490, 'lkg fills blank-price row')
      // 2) symbol missing from the feed entirely is restored from the bank
      const rows2 = new Map<string, QuoteRow>()
      fillLastGood(['1.600519'], rows2, bank)
      ok(rows2.get('1.600519')?.price === 1500, 'lkg restores missing symbol')
      // 3) a real price refreshes the bank
      const rows3 = new Map<string, QuoteRow>()
      rows3.set('1.600519', fakeQuote('1.600519', 1501, 1490))
      fillLastGood(['1.600519'], rows3, bank)
      ok(bank.get('1.600519')?.price === 1501, 'lkg bank updated by fresh price')
      // 4) 兜底行必须标 source='lkg'，并保留**原始观测时刻**：否则界面会把旧价
      //    当成"刚刚更新"（asOf 取的是行内 at，不是响应时刻）
      ok(rows1.get('1.600519')?.source === 'lkg', 'lkg 字段级填充标注 source=lkg')
      ok(rows2.get('1.600519')?.source === 'lkg', 'lkg 整行恢复标注 source=lkg')
      const bankAt = 1_700_000_000_000
      const bank2 = new Map<string, QuoteRow>()
      bank2.set('1.600519', { ...fakeQuote('1.600519', 1500, 1490), at: bankAt })
      const rows4 = new Map<string, QuoteRow>()
      fillLastGood(['1.600519'], rows4, bank2)
      ok(rows4.get('1.600519')?.at === bankAt, 'lkg 保留原始观测时刻 at（不伪装成刚刚更新）')
    }

    // 真实新鲜度（/quotes 的 asOf / stale）：由行内 at + source 推导，与响应时刻无关
    {
      const base = fakeQuote('1.600519', 1500, 1490)
      const now = 1_700_000_000_000
      const fresh = { ...base, at: now - 3_000 }
      const alt = { ...fakeQuote('1.000001', 3900, 3880), at: now - 5_000, source: 'tencent' as const }
      const lkg = { ...fakeQuote('100.KOSPI200', 300, 301), at: now - 3_600_000, source: 'lkg' as const }
      const old = { ...fakeQuote('122.XAU', 2400, 2390), at: now - 200_000 }
      const p = summarizeQuoteProvenance({ '1.600519': fresh, '1.000001': alt, '100.KOSPI200': lkg, '122.XAU': old }, now)
      ok(p.asOf === now - 3_000, `asOf 取最新观测时刻而非响应时刻 (got ${p.asOf})`)
      ok(p.stale === true && p.staleCount === 2, `stale 判定：lkg 行 + 超过 90s 的行 (got ${p.staleCount}/2)`)
      ok(p.priced === 4 && p.sources.tencent === 1 && p.sources.lkg === 1, '按来源计数正确')
      const allFresh = summarizeQuoteProvenance({ '1.600519': fresh, '1.000001': alt }, now)
      ok(allFresh.stale === false && allFresh.staleCount === 0, '全部新鲜时不报警')
      ok(summarizeQuoteProvenance({}, now).asOf === null, '空集 asOf 为 null')
      // 无 at 的行（老数据）不得被当成新鲜
      const noAt = { ...fakeQuote('1.600519', 1500, 1490) } as QuoteRow
      delete noAt.at
      ok(summarizeQuoteProvenance({ '1.600519': noAt }, now).stale === true, '缺少观测时刻的行按"不新鲜"处理')
    }

    // 错误语义分级：400 请求写错 / 413 体过大 / 503 上游不可用 / 500 本插件 bug
    {
      ok(httpStatusOf(new HttpError('请求体过大', 413)) === 413, 'HttpError 显式状态码优先')
      ok(httpStatusOf(new Error('secid 非法')) === 400, '参数非法 → 400')
      ok(httpStatusOf(new Error('请求体过大（上限 262144 字节）')) === 413, '体过大 → 413（兜底匹配）')
      ok(httpStatusOf(new Error('上游暂时不可用（熔断中，约 3 分钟后自动重试）')) === 503, '熔断 → 503')
      ok(httpStatusOf(new Error('HTTP 503 from push2delay.eastmoney.com')) === 503, '上游 5xx → 503')
      ok(httpStatusOf(new Error('HTTP 404 from push2his.eastmoney.com')) === 503, '上游 4xx 仍算上游不可用（不是调用方写错）')
      ok(httpStatusOf(new Error('non-JSON reply from push2.eastmoney.com: <html>')) === 503, '上游返回非 JSON → 503')
      ok(httpStatusOf(new Error('fetch failed')) === 503, 'fetch failed → 503')
      ok(httpStatusOf(new Error('socket hang up')) === 503, 'socket 断开 → 503')
      ok(httpStatusOf(new Error('The operation was aborted due to timeout')) === 503, '超时 → 503')
      ok(httpStatusOf(new Error('Cannot read properties of undefined (reading f13)')) === 500, '未归类错误 → 500（不再伪装成 400）')
      ok(retryAfterSecondsOf(new Error('fetch failed'), 2) === 120, '503 附带 retry-after 秒数')
      ok(retryAfterSecondsOf(new Error('secid 非法'), 2) === null, '非 503 不带 retry-after')
    }

    // tick 重入守卫：并发采样合并为一份，失败不锁死
    {
      const sf = new SingleFlight()
      let calls = 0
      let release: (() => void) | null = null
      const gate = new Promise<void>((r) => { release = r })
      const work = async (): Promise<void> => { calls += 1; await gate }
      const a = sf.run(work)
      const b = sf.run(work)
      const c = sf.run(work)
      ok(sf.busy === true, '采样进行中标记 busy')
      ok(calls === 1, `并发三次只跑一份工作 (got ${calls})`)
      release?.()
      await Promise.all([a, b, c])
      ok(sf.busy === false, '结算后释放')
      await sf.run(async () => { calls += 1 })
      ok(calls === 2, '结算后可再次运行（不被锁死）')
      let threw = 0
      await sf.run(async () => { throw new Error('boom') }).catch(() => { threw += 1 })
      ok(threw === 1 && sf.busy === false, '失败向上抛但不阻塞后续采样')
    }

    // 熔断聚合 + "最早恢复"语义
    {
      const hA = 'selftest-host-a.example'
      const hB = 'selftest-host-b.example'
      const ba = breakerFor(hA)
      const bb = breakerFor(hB)
      for (let i = 0; i < 3; i++) bb.recordFailure(new Error('boom-b'))
      ok(bb.allow() === false, 'host-b 熔断')
      const single = breakerSummary([hA, hB])
      ok(single.open === true && single.allOpen === false && single.openHosts === 1 && single.hosts === 2,
        '聚合：单主机熔断不等于整组不可用')
      // host-a 连续熔断两次 → 退避 4 分钟；host-b 只熔断一次 → 2 分钟
      for (let i = 0; i < 3; i++) ba.recordFailure(new Error('boom-a'))
      for (let i = 0; i < 3; i++) ba.recordFailure(new Error('boom-a'))
      ok(ba.allow() === false && ba.minutesLeft() >= 3, `host-a 二次熔断退避已加倍 (${ba.minutesLeft()}min)`)
      const both = breakerSummary([hA, hB])
      ok(both.allOpen === true && both.openHosts === 2, '两台都熔断时 allOpen')
      ok(minutesToRecover([hA, hB]) === 2, `minutesToRecover 取**最早**恢复（host-b 的 2 分钟），而非最晚的 4 分钟 (got ${minutesToRecover([hA, hB])})`)
      ok(minutesToFullyRecover([hA, hB]) === 4, `minutesToFullyRecover 取最晚（4 分钟）(got ${minutesToFullyRecover([hA, hB])})`)
      ok(both.minutesLeft === 2 && both.allMinutesLeft === 4, '聚合同时给出"最早可重试"与"全部恢复"')
      ok(both.detail.filter((h) => h.open).length === 2 && both.lastError !== null, '逐主机明细与最近失败原因')
      ba.recordSuccess()
      bb.recordSuccess()
      ok(breakerSummary([hA, hB]).open === false, '成功后聚合复位')
    }

    // 回测/标定路径同样要清洗日线：非法值不得把概率与中位数污染成 NaN
    {
      const mk = (n: number): DailyBarLite[] => {
        const out: DailyBarLite[] = []
        for (let i = 0; i < n; i++) {
          const close = 100 + Math.sin(i / 7) * 12 + (i % 13 === 0 ? -6 : 0)
          const mm = String(1 + Math.floor(i / 28) % 12).padStart(2, '0')
          const dd = String(1 + (i % 28)).padStart(2, '0')
          out.push({ date: `20${20 + Math.floor(i / 336)}-${mm}-${dd}`, open: close, close, high: close * 1.01, low: close * 0.99, vol: 1000 + (i % 5) * 100 })
        }
        return out
      }
      const clean = mk(320)
      const tailDirty = [...clean, { ...clean[clean.length - 1], high: Number.NaN, vol: 0 }]
      const a = calibratePooled([clean], { horizon: 5, targets: [0.01, 0.02] })
      const b = calibratePooled([tailDirty], { horizon: 5, targets: [0.01, 0.02] })
      ok(a.n > 0 && a.baseN > 0, `标定产出样本 (n=${a.n}, baseN=${a.baseN})`)
      ok(a.medianForward !== null && Number.isFinite(a.medianForward) && a.medianDrawdown !== null && Number.isFinite(a.medianDrawdown),
        '中位数/回撤为有限值（非 NaN）')
      ok(a.targets.every((t) => t.prob === null || Number.isFinite(t.prob)), '概率为有限值')
      ok(JSON.stringify(b) === JSON.stringify(a), '尾部非法日线被清洗：标定结果与干净序列逐字节一致')
      ok(sanitizeBars(tailDirty).length === clean.length, 'sanitizeBars 滤掉非法日线')
      // 中部非法日线无法被"直接丢弃后结果不变"检验，但必须仍然输出有限值
      const midDirty = clean.map((bar, i) => (i === 250 ? { ...bar, high: Number.NaN } : bar))
      const mid = calibratePooled([midDirty], { horizon: 5, targets: [0.01, 0.02] })
      ok(mid.baseN > 0 && mid.medianForward !== null && Number.isFinite(mid.medianForward)
        && mid.targets.every((t) => t.prob === null || Number.isFinite(t.prob)),
        '中部非法日线不再污染概率/中位数（NaN 免疫）')
      const st = laneOutcomeStats(midDirty, { percentileMax: 0.25, volumeMin: 1.0, horizon: 5, targets: [0.01] })
      ok(st.forwards.every((v) => Number.isFinite(v)) && st.draws.every((v) => Number.isFinite(v)),
        '单通道回测的前向收益/回撤均为有限值')
      const price = clean[clean.length - 1].close
      const posClean = computePosition(clean, price)
      const posDirty = computePosition(midDirty, price)
      ok(posDirty.percentile60 === posClean.percentile60 && posDirty.downStreak === posClean.downStreak,
        '位置特征不受非法日线影响')
    }

    // 脉冲参考点选择：过期序列不得被采用（v0.21.0 修的放大 bug：5.01x → 1.13x）
    {
      const t0 = 1_700_000_000_000
      const seriesOf = (n: number, stepMs: number, shiftMs: number): Array<{ ts: number; amount: number }> =>
        Array.from({ length: n }, (_, i) => ({ ts: t0 - (n - 1 - i) * stepMs + shiftMs, amount: 1e8 + i * 1e6 }))
      const fresh = seriesOf(30, 60_000, 0)
      const got = pickPulseRef(fresh, t0, t0)
      ok(got !== null, '新鲜 1 分钟序列：取到参考点')
      ok(got !== null && Math.abs(t0 - got.ref.ts - FLOW_WINDOW_MS) <= 30_000,
        `参考点落在 5 分钟窗口内（差 ${got === null ? 'n/a' : Math.round((t0 - got.ref.ts) / 1000)}s）`)
      const stale = seriesOf(30, 60_000, -30 * 60_000)
      ok(pickPulseRef(stale, t0, t0) === null, '过期序列（末端 30 分钟前）→ 拒绝，退回采样环口径')
      ok(pickPulseRef(stale, t0, stale[stale.length - 1].ts) === null, '即使把评估时点设成序列末端，过期序列仍被拒绝')
      const late = seriesOf(30, 60_000, -120_000)
      ok(pickPulseRef(late, t0, t0) === null, '序列末端落后 2 分钟 → 拒绝（容差 60s）')
      const holed = fresh.filter((p) => Math.abs(t0 - FLOW_WINDOW_MS - p.ts) > 120_000)
      ok(pickPulseRef(holed, t0, t0) === null, '窗口内恰好没有点（数据空洞）→ 拒绝')
      ok(pickPulseRef([], t0, t0) === null, '空序列 → null')
      // 收盘口径：评估时点取序列末端（tailRef），窗口应相对末端计算
      const tailEval = fresh[fresh.length - 1].ts
      const tailRef = pickPulseRef(fresh, tailEval, tailEval)
      ok(tailRef !== null && Math.abs(tailEval - tailRef.ref.ts - FLOW_WINDOW_MS) <= 30_000, '收盘口径：参考点相对序列末端前移 5 分钟')
    }

    // F2 口径：标注与数值必须一致（核心未达参与档时外围真打 0.7 折）
    {
      const anchors: [number, number, number] = [0.2, 0.6, 1.2]
      const common = {
        flowAvailable: true, f2Anchors: anchors, f2Source: 'empirical' as const, coreWorstShare: 0.3,
        coreResonance: 1, peripheralResonance: 1, resonanceLanes: ['沪深300'], isTail: true, timeCoef: 1,
        retraceRatio: 0, timeAdjMult: 1, pulseMult: 1, persistShare: 0, indexPct: -1, resonance: 1,
      }
      const shown = (f: { actual: string }): number => Number(String(f.actual).match(/^([\d.]+)x/)?.[1] ?? NaN)
      const micro = scoreRescue({ ...common, coreSuperVsAvg: 0.05, peripheralSuperVsAvg: 0.5 } as never)
      const f2micro = micro.factors.find((f) => f.id === 'superflow')!
      ok(Math.abs(shown(f2micro) - 0.35) < 0.011, `核心微幅正时取折算后的 0.35x（实际显示 ${shown(f2micro)}）`)
      ok(f2micro.actual.includes('打 0.7 折'), '标注写明"外围打 0.7 折"（与数值一致）')
      ok(f2micro.score === interpScore(0.35, anchors), '因子分按折算后的值计算')
      const meaningful = scoreRescue({ ...common, coreSuperVsAvg: 0.25, peripheralSuperVsAvg: 0.5 } as never)
      const f2core = meaningful.factors.find((f) => f.id === 'superflow')!
      ok(Math.abs(shown(f2core) - 0.5) < 0.011, `核心达标时取二者较强且不折算（实际显示 ${shown(f2core)}）`)
      ok(f2core.actual.includes('核心已参与'), '核心达标时标注为"核心已参与"（不再声称已折算）')
      const outflow = scoreRescue({ ...common, coreSuperVsAvg: -0.3, peripheralSuperVsAvg: 0.5 } as never)
      const f2out = outflow.factors.find((f) => f.id === 'superflow')!
      ok(Math.abs(shown(f2out) - 0.35) < 0.011, `核心净流出 + 外围在买 → 仍按折算后的 0.35x（实际 ${shown(f2out)}）`)
    }

    // 分组备注契约（客户端备注模态此前绑错状态，保存无效）
    {
      const store5 = new DataStore(dir)
      await store5.init()
      await store5.mutateWatch({ op: 'addGroup', name: 'G5' })
      const gid = store5.watchData().groups[0].id
      await store5.mutateWatch({ op: 'noteGroup', groupId: gid, note: '测试备注' } as never)
      ok(store5.watchData().groups[0].note === '测试备注', '自选分组备注可写入')
      await store5.mutateWatch({ op: 'noteGroup', groupId: gid, note: '' } as never)
      ok(store5.watchData().groups[0].note === undefined, '备注留空即清除')
    }

    // 大小写口径：入库存原样、上游映射大小写无关、LKG 库大小写无关
    {
      ok(secidKey('114.lhm') === secidKey('114.LHM'), 'secidKey 大小写无关于同一标的')
      ok(hasQuoteFallback('114.lhm') && hasQuoteFallback('114.LHM'), '商品主连有新浪兜底（大小写两种写法都认）')
      ok(!hasQuoteFallback('113.rb2610') && !hasQuoteFallback('107.SPY'), '月度合约/美股如实标注只有东财一条链路')
      ok(hasQuoteFallback('1.600519') && hasQuoteFallback('116.00700'), 'A股/港股有腾讯兜底')
      // LKG 库按大小写无关键取用：库里存大写、请求小写（或反之）都要命中
      const bank = new Map<string, QuoteRow>()
      bank.set('114.LHM', { ...fakeQuote('114.LHM', 10680, 10600), at: 1_700_000_000_000 })
      const rows = new Map<string, QuoteRow>()
      fillLastGood(['114.lhm'], rows, bank)
      ok(rows.get('114.lhm')?.price === 10680, 'LKG 大小写无关命中（库里大写、请求小写）')
      ok(rows.get('114.lhm')?.secid === '114.lhm', 'LKG 回填后把 secid 归位到本次请求的写法')
      const bank2 = new Map<string, QuoteRow>()
      const fresh = { ...fakeQuote('114.lhm', 10690, 10600), at: 1_700_000_001_000 }
      const rows2 = new Map<string, QuoteRow>()
      // rows 的键与"本次请求的写法"一致（loadQuotes 就是这么建的）
      rows2.set('114.LHM', fresh)
      fillLastGood(['114.LHM'], rows2, bank2)
      ok(bank2.has('114.LHM') && bank2.get('114.LHM')?.price === 10690, '新读数按大小写无关键写入 LKG 库')
    }

    // 行情新鲜度窗口：跟随刷新间隔且夹在 5–60 秒
    {
      setQuoteFreshnessMs(1_000)
      ok(quoteFreshnessMs() === 5_000, `低于下限夹到 5s (got ${quoteFreshnessMs()})`)
      setQuoteFreshnessMs(9_999_999)
      ok(quoteFreshnessMs() === 60_000, `高于上限夹到 60s (got ${quoteFreshnessMs()})`)
      setQuoteFreshnessMs(10_000)
      ok(quoteFreshnessMs() === 10_000, '正常值原样生效')
    }

    // 采样失败不得改写"数据时刻"（失败 ≠ 刚拿到数据），失败时刻单独记
    {
      const mon = new RescueMonitor(dir)
      const internals = mon as unknown as {
        lastSnapshot: RescueSnapshot | null
        lastFailTs: number | null
        noteSampleFailure: (at?: number) => void
      }
      const dataTs = 1_700_000_000_000
      internals.lastSnapshot = { ts: dataTs, lastSampleTs: dataTs, gap: false } as unknown as RescueSnapshot
      internals.noteSampleFailure(dataTs + 60_000)
      ok(internals.lastSnapshot?.ts === dataTs, `采样失败不改写数据时刻 ts (got ${internals.lastSnapshot?.ts})`)
      ok(internals.lastSnapshot?.gap === true && internals.lastSnapshot?.lastFailTs === dataTs + 60_000, '失败另记 lastFailTs 并置缺口')
      ok(internals.lastFailTs === dataTs + 60_000, 'monitor 记住失败时刻（成功后清空）')
      // 落盘也要保住这两个诚实性字段：收盘后重启的面板靠它说明"数据来自备用源""最近一次失败在何时"
      const stripped = stripSnapshot({ ts: dataTs, flowSource: 'tencent', lastFailTs: dataTs + 60_000 } as unknown as RescueSnapshot)
      ok(stripped.flowSource === 'tencent' && stripped.lastFailTs === dataTs + 60_000 && stripped.ts === dataTs, '持久化保留 flowSource / lastFailTs / ts')
    }

    // 校准不可用时保留上次底部视图（而不是整块面板消失）
    {
      const mon = new RescueMonitor(dir)
      const internals = mon as unknown as {
        bottomLast: { at: number; view: NonNullable<RescueSnapshot['bottom']> } | null
        buildBottom: (etfs: RescueEtfView[]) => RescueSnapshot['bottom']
      }
      ok(internals.buildBottom([]) === undefined, '从未算出过时不编造视图（面板显示空态提示）')
      const at = 1_700_000_000_000
      internals.bottomLast = { at, view: { lanes: [], model: '保留测试', asOf: '2026-09-28' } }
      const kept = internals.buildBottom([])
      ok(kept !== undefined && kept.stale === true, '无通道日线时保留上次视图并标 stale')
      ok(kept?.computedAt === at && kept?.asOf === '2026-09-28', '保留视图带原计算时刻与原口径')
      ok(kept?.model === '保留测试', '保留视图内容原样返回')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('-- live Eastmoney probes (soft — upstream rate limits may flicker) --')
  try {
    const quotes = await em.fetchQuotes(['1.000001', '100.KOSPI200', '114.lhm', '101.HG00Y', '122.XAU', '1.600519', '1.688825', '116.02155'])
    softOk(quotes['1.688825'] !== undefined && quotes['116.02155'] !== undefined, 'quotes 688825 & 116.02155 live', `长鑫=${quotes['1.688825']?.price} 森松=${quotes['116.02155']?.price}`)
    const names = Object.values(quotes).map((x) => x.name)
    softOk(names.length >= 5, `batch quotes resolved`, names.join(' / '))
  } catch (e) {
    softOk(false, 'quotes fetch', e instanceof Error ? e.message : String(e))
  }
  try {
    const t = await em.fetchTrend('1.000001')
    softOk(t !== null && t.points.length > 100, `trend points>100`, `points=${t?.points.length}`)
  } catch (e) {
    softOk(false, 'trend fetch', e instanceof Error ? e.message : String(e))
  }
  try {
    const k = await em.fetchKline('1.000001')
    softOk(k !== null && k.days.length >= 2, `kline days>=2`, `days=${k?.days.length}`)
    const k2 = await em.fetchKline('114.lhm')
    softOk(k2 !== null && k2.days.length >= 2, `futures kline days>=2`, `days=${k2?.days.length}`)
  } catch (e) {
    softOk(false, 'kline fetch', e instanceof Error ? e.message : String(e))
  }
  try {
    const star = await em.searchSymbols('长鑫科技')
    softOk(star.some((x) => x.code === '688825' && x.secid === '1.688825'), 'suggest 科创板 688825 长鑫科技', star.slice(0, 2).map((x) => `${x.name}(${x.secid})`).join(' '))
    const hk = await em.searchSymbols('森松国际')
    softOk(hk.some((x) => x.code === '02155' && x.secid === '116.02155'), 'suggest 港股 02155 森松国际', hk.slice(0, 2).map((x) => `${x.name}(${x.secid})`).join(' '))
    const hits = await em.searchSymbols('茅台')
    softOk(hits.length > 0 && hits[0].name.includes('茅台'), 'suggest 茅台', hits.slice(0, 2).map((x) => `${x.name}(${x.secid})`).join(' '))
  } catch (e) {
    softOk(false, 'suggest', e instanceof Error ? e.message : String(e))
  }
  try {
    const t5 = await em.fetchTrend('1.600519', 5)
    const dates = new Set((t5?.points ?? []).map((p) => p.label.slice(0, 10)))
    softOk(t5 !== null && dates.size >= 2, 'trend ndays=5 spans sessions', `days=${dates.size}`)
    const wk = await em.fetchKline('1.600519', 102, 6)
    softOk(wk !== null && wk.days.length >= 2, 'weekly kline klt=102', `bars=${wk?.days.length}`)
    const ind = await em.fetchIndustryOf('1.600519')
    softOk(ind !== null && ind.name !== '', 'industry-of A股 600519', JSON.stringify(ind))
    const indHk = await em.fetchIndustryOf('116.02155')
    softOk(indHk === null, 'industry-of HK → null')
  } catch (e) {
    softOk(false, 'drawer endpoints', e instanceof Error ? e.message : String(e))
  }
  try {
    // 预设代码回归：TopBar 三个行情条里的每个代码都必须能取到数据
    const all = TW_ROWS.flatMap((r) => (r.items as ReadonlyArray<{ secid: string }>).map((i) => i.secid))
    const quotes = await em.fetchQuotes(all)
    const missing = all.filter((s) => quotes[s] === undefined || quotes[s].price === null)
    softOk(missing.length === 0, `preset instruments ${all.length - missing.length}/${all.length} resolve`,
      missing.length > 0 ? `missing: ${missing.join(', ')}` : `全部可取`)
  } catch (e) {
    softOk(false, 'preset instrument sweep', e instanceof Error ? e.message : String(e))
  }
  try {
    const b = await em.fetchBoard('industry', 'pct', 1, 5)
    softOk(b.rows.length > 0 && b.rows[0].name !== '', 'industry board', `rows=${b.rows.length}`)
    const etf = await em.fetchBoard('etf', 'pct', 1, 5)
    softOk(etf.rows.length > 0, 'etf board', `rows=${etf.rows.length}`)
    const flow = await em.fetchBoard('concept', 'money', 1, 5)
    softOk(flow.rows.length > 0, 'concept money-flow board', `rows=${flow.rows.length}`)
  } catch (e) {
    softOk(false, 'board fetch', e instanceof Error ? e.message : String(e))
  }

  console.log(failures === 0 ? '\nALL HOST CHECKS PASSED (live probes soft)' : `\n${failures} FAILURES`)
  if (failures > 0) process.exitCode = 1
}

void main()
