/**
 * Host-half self-test: pure accounting + store round-trip + live Eastmoney
 * probes. Run:  npm run selftest   (node type-stripping; no build needed)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataStore, replayPosition, dataHome } from './store.ts'
import { assemblePortfolio, derivePosition, ledgerViews, shanghaiDayStart, verbLabel } from './portfolio.ts'
import * as em from './em.ts'
import { fillLastGood, mergeBars, resampleYearly } from './em.ts'
import { losslessJson } from './tools.ts'
import { canonicalEconomy, macroEventsFromEm, macroImportance, parseEmDate } from './calendar.ts'
import { RescueMonitor } from './rescue.ts'
import {
  CORE_OUTFLOW_VETO, PERSIST_ANCHORS, PULSE_HIT_SCORE, divergenceScore, interpScore, isTailElapsed,
  progressAt, pulseAnchorsFor, pulseBandLabel, quantile, resonanceScore, scoreRescue, sessionElapsed,
  phaseOf, pulseFactorLabel, timeCoefficient, windowFlowStats,
} from './rescue.ts'
import { RESCUE_CALIBRATION } from './rescue-thresholds.ts'
import { TW_ROWS } from '../shared/model.ts'
import type { QuoteRow } from '../shared/model.ts'

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
