/*
 * 【棱镜】第 9 行 / 第 8 个页签（重设计：hybrid 配色 + 左栏分段 + 62:38 可拖拽）。
 *
 * 左：四格资产 → 分段（持仓/挂单/成交）→ 表格 → 净值曲线（MD dataviz 8 系列色）。
 * 右：研判（汇总常驻 + 四份报告）→ 时点配置 → 模型配置；决策卡在左栏净值卡之前。
 * 功能行为不变：摊薄成本、占比列、模型、自检文案、时点增删/补跑、缺数据 `—` + 原因、无声明性文案。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import type { PrismRun, PrismState, PrismTradingState } from '../shared/prism.ts'
import { PRISM_DEFAULT_TIMES } from '../shared/prism.ts'
import { shClockText } from './marketTime.ts'
import { clampSplit, PRISM_SEP_PX, splitPctFromDrag } from './prismLayout.ts'
import {
  PRISM_FONT,
  PRISM_MONEY,
  PRISM_PCT,
  PRISM_SERIES_CSS,
  adjustedReturnSeries,
  SEGMENT_GAP, SEGMENT_PADDING,
  basisBlocksOf,
  segmentItemWidthOf,
  analysisText,
  compositionItems,
  decisionErrorText,
  decisionRows,
  equityChartOf,
  equityLegendItems,
  evalCurveOf,
  unavailableEvaluation,
  unavailableExposure,
  newsStatusText,
  normalizeTradingState,
  orderStatusText,
  positionWeightPct,
  selftestText,
  summaryBullets,
  timesProblems,
  timesText,
  topCardsOf,
  versionSummaryOf,
} from './prismView.ts'

type TabKey = 'positions' | 'orders' | 'fills'
const REPORT_ROLES = ['A股宏观', '外盘', '大宗', '信息面'] as const
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'positions', label: '持仓' },
  { key: 'orders', label: '挂单' },
  { key: 'fills', label: '成交' },
]

function useRipple(): { ref: React.RefObject<HTMLButtonElement | null>; onPointerDown: (ev: React.PointerEvent<HTMLButtonElement>) => void } {
  const ref = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const obs = new MutationObserver(() => {
      if (document.querySelector('.tw-root')?.getAttribute('data-idle') === 'true') {
        ref.current?.querySelectorAll('.tw-prism-ripple').forEach((n) => n.remove())
      }
    })
    obs.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['data-idle'] })
    return () => obs.disconnect()
  }, [])
  const onPointerDown = (ev: React.PointerEvent<HTMLButtonElement>): void => {
    const el = ref.current
    if (el === null || document.querySelector('.tw-root')?.getAttribute('data-idle') === 'true') return
    const rect = el.getBoundingClientRect()
    const span = document.createElement('span')
    span.className = 'tw-prism-ripple'
    span.style.left = `${ev.clientX - rect.left - 50}px`
    span.style.top = `${ev.clientY - rect.top - 50}px`
    el.appendChild(span)
    span.addEventListener('animationend', () => span.remove(), { once: true })
    setTimeout(() => span.remove(), 800)
  }
  return { ref, onPointerDown }
}

function RippleButton(props: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  title?: string
  className?: string
  role?: string
  ariaSelected?: boolean
  style?: React.CSSProperties
}): React.ReactElement {
  const { ref, onPointerDown } = useRipple()
  return (
    <button
      ref={ref}
      type="button"
      className={props.className ?? 'tw-prism-btn'}
      onPointerDown={onPointerDown}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      role={props.role}
      aria-selected={props.ariaSelected}
      style={props.style}
    >
      {props.children}
    </button>
  )
}

export function PrismPage(props: { active: boolean }): React.ReactElement {
  const [state, setState] = useState<PrismState | null>(null)
  const [trading, setTrading] = useState<PrismTradingState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [times, setTimes] = useState<string[]>([...PRISM_DEFAULT_TIMES])
  const [skeleton, setSkeleton] = useState('')
  const [capital, setCapital] = useState('1500000')
  const [provider, setProvider] = useState('')
  const [modelName, setModelName] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>('positions')
  const [netMode, setNetMode] = useState<'nominal' | 'adjusted'>('adjusted')
  const [split, setSplit] = useState(62)
  const [selftest, setSelftest] = useState<{ ok: boolean; error: string | null; model: string | null; elapsedMs: number; text: string | null } | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startX: number; startPct: number } | null>(null)

  const load = useCallback((): void => {
    setError(null)
    api.prismState()
      .then((r) => {
        setState(r.state)
        const tradingState = normalizeTradingState(r)
        setTrading(tradingState)
        setTimes(r.state.settings.times)
        setSkeleton(r.state.skeleton)
        setCapital(String(tradingState?.account.capitalLimit ?? ''))
        setProvider(r.state.settings.model?.provider ?? r.state.model.provider ?? '')
        setModelName(r.state.settings.model?.model ?? r.state.model.model ?? '')
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
    if (props.active) load()
  }, [props.active, load])

  const act = <T,>(p: Promise<T>, then?: (v: T) => void): void => {
    setBusy(true)
    p.then((v) => { then?.(v); load() }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
  }

  const saveTimes = (): void => {
    const bad = timesProblems(times)
    if (bad.length > 0) { setError(bad[0] as string); return }
    act(api.prismSetTimes(times), () => setNotice('时点已保存'))
  }
  const saveSkeleton = (): void => act(api.prismSetSkeleton(skeleton), () => setNotice('骨架已保存'))
  const syncNews = (): void => act(api.prismNews())
  const run = (slot: string): void => act(api.prismRun(slot), () => setNotice(`已跑 ${slot}`))
  const doCopy = (): void => act(api.prismCopy(), (r) => setNotice(r.ok ? '已按摊薄成本复制持仓' : `复制失败：${r.error ?? '未知'}`))
  const doCancel = (id: string): void => act(api.prismCancel(id), () => setNotice('已撤销'))
  const saveCapital = (): void => act(api.prismCapital(Number(capital)), () => setNotice('资金上限已更新'))
  const saveModel = (): void => act(api.prismSetModel(provider, modelName), () => setNotice('模型已保存'))
  const saveIndustryLimit = (name: string, raw: string): void => {
    const value = Number(raw.replace('%', '').trim())
    if (!Number.isFinite(value) || value < 0 || value > 100) { setNotice(`行业上限非法：${raw}`); return }
    const next = { ...(state?.settings.industryLimits ?? {}), [name]: value }
    act(api.prismSetIndustryLimits(next), () => setNotice(`行业上限已保存：${name} ${value}%`))
  }
  const selfTest = (): void => {
    setBusy(true)
    api.prismSelftest().then(setSelftest).catch((e: Error) => setSelftest({ ok: false, error: `超时/网络错误（${e.message}）`, model: null, elapsedMs: 0, text: null })).finally(() => setBusy(false))
  }

  const onSeparatorDown = (ev: React.PointerEvent<HTMLDivElement>): void => {
    ev.preventDefault()
    dragRef.current = { startX: ev.clientX, startPct: split }
    const move = (e: PointerEvent): void => {
      const rect = bodyRef.current?.getBoundingClientRect()
      const start = dragRef.current
      if (rect === undefined || start === null) return
      setSplit(splitPctFromDrag(start.startPct, start.startX, e.clientX, rect.width))
    }
    const up = (): void => {
      dragRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onSeparatorKey = (ev: React.KeyboardEvent<HTMLDivElement>): void => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return
    ev.preventDefault()
    setSplit((cur) => clampSplit(cur + (ev.key === 'ArrowRight' ? 2 : -2)))
  }

  const latest: PrismRun | null = state === null || state.runs.length === 0 ? null : (state.runs[state.runs.length - 1] as PrismRun)
  const cards = topCardsOf(trading, trading?.prices ?? {})
  const totalAssets = trading === null
    ? null
    : trading.account.cash + trading.account.positions.reduce((sum, p) => sum + p.qty * (trading.prices?.[p.secid] ?? p.cost), 0)
  const equityPoints = trading?.equity ?? []
  const chart = equityChartOf(equityPoints, 560, 128, netMode)
  const adjustedLast = adjustedReturnSeries(equityPoints).at(-1)
  const equityWarnings = equityPoints.flatMap((p) => p.warnings ?? [])
  const netHead = netMode === 'adjusted'
    ? adjustedLast?.value === null || adjustedLast?.value === undefined ? '调整后 —' : `调整后 ${adjustedLast.value >= 0 ? '+' : ''}${adjustedLast.value.toFixed(2)}%`
    : `名义 ${PRISM_MONEY(chart?.last ?? null)}`
  const reports = latest === null
    ? []
    : (latest.reports ?? []).length > 0
      ? latest.reports
      : latest.analyses.map((a) => ({ role: a.label, text: a.text, error: a.error }))
  const modelCatalog = state?.modelCatalog
  const bullets = summaryBullets(latest?.summary)
  const reportRows = REPORT_ROLES.map((role) => reports.find((r) => r.role === role) ?? { role, text: null, error: latest === null ? '—（本轮未落盘）' : '—（该报告未落盘）' })
  const lowPrice = trading === null
    ? null
    : trading.account.positions.reduce<number | null>((min, p) => {
        const price = trading.prices?.[p.secid] ?? null
        return price === null ? min : min === null ? price : Math.min(min, price)
      }, null)
  const composition = trading === null
    ? []
    : compositionItems(trading.account.positions, trading.prices ?? {}, totalAssets, PRISM_SERIES_CSS)
  const equityLegend = equityLegendItems()
  const evaluation = trading?.evaluation ?? unavailableEvaluation('尚未取到评估数据')
  const evalCurve = evalCurveOf(evaluation.curve)
  const evalPct = (v: number | null): string => v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
  const metricText = (m: { value: number | null; reason: string | null }): string => m.value === null ? `—（${m.reason ?? '样本不足'}）` : evalPct(m.value)
  const exposure = trading?.exposure ?? unavailableExposure('尚未取到模拟盘行业暴露')
  const exposureOk = exposure.state === 'ok'
  const expClassified = exposureOk ? exposure.rows.filter((r) => r.kind === 'industry' || r.kind === 'wide') : []
  const expTop = expClassified.slice(0, 6)
  const expRest = expClassified.slice(6)
  const expFixed = exposureOk ? exposure.rows.filter((r) => r.kind === 'unpenetrated' || r.kind === 'cash') : []
  const expRestWeight = Math.round(expRest.reduce((sum, r) => sum + r.weight, 0) * 100) / 100
  const clampText = (latest?.decision?.clampEvents ?? []).length === 0
    ? '本次夹紧 —'
    : `本次夹紧 ${(latest?.decision?.clampEvents ?? []).map((e) => `${e.secid} ${e.before} → ${e.after}（${e.dimension}）`).join('；')}`
  const achieved = exposureOk ? exposure.rows.filter((r) => r.limitPct !== null && r.limitPct > 0).map((r) => `${r.name} ${Math.round((r.weight / r.limitPct!) * 100)}%`) : []
  const achievementReason = exposure.state === 'unavailable' ? '缺行业数据' : achieved.length === 0 ? '未配置行业上限' : null
  const basisParts = [
    `资金上限 ${PRISM_MONEY(trading?.account.capital ?? trading?.account.capitalLimit ?? null)} · 单票 ${latest?.decision?.limits.singlePct == null ? '—' : `${latest.decision.limits.singlePct}%`} · 总仓 ${latest?.decision?.limits.totalPct == null ? '—' : `${latest.decision.limits.totalPct}%`}` + (latest?.decision?.limits.note === null || latest?.decision?.limits.note === undefined || latest.decision.limits.note.trim() === '' ? '' : `（依据：${latest.decision.limits.note}）`),
    `达成度 ${achieved.length === 0 ? `—（${achievementReason ?? '未配置行业上限'}）` : achieved.join(' / ')}`,
    clampText,
  ]
  const basisBlocks = basisBlocksOf(basisParts)
  const segWidth = segmentItemWidthOf(TABS.map((t) => t.label))
  const dd = latest?.drawdown ?? null
  const ddText = dd === null
    ? '—（缺资本调整后净值，未计算回撤闸门）'
    : `单日 −3% / 累计 −10% / 状态 ${dd.status}\n当前 单日 ${evalPct(dd.dailyPct)} · 自高点 ${evalPct(dd.cumulativePct)} · 目标总仓 ≤${dd.targetTotalPct}% · 现金 ≥${dd.cashMinPct}% · 样本 n=${dd.n}${dd.freezeRound ? ' · 连续两次触发，本轮冻结新开仓' : ''}`
  const dRows = [...decisionRows(latest?.decision, { cash: trading?.account.cash, minPrice: lowPrice }).map((r) => r.key === '仓位上限依据' ? { ...r, value: basisBlocks[0] as string } : r), { key: '回撤闸门', value: ddText }]
  const versionInfo = versionSummaryOf(latest?.codeVersion, latest?.mandateHash)

  return (
    <div className="tw-prism">
      <div className="tw-prism-head">
        <span className="tw-prism-title" style={{ fontSize: PRISM_FONT.title }}>棱镜 · 模拟盘</span>
        <RippleButton onClick={load} disabled={busy}>刷新</RippleButton>
        <RippleButton onClick={selfTest} disabled={busy}>自检</RippleButton>
        <span className="tw-prism-muted">{selftestText(selftest)}</span>
        {notice !== null ? <span className="tw-prism-notice tw-prism-muted">{notice}</span> : null}
      </div>
      {error !== null ? <div className="tw-prism-error">—（{error}）</div> : null}

      <div
        ref={bodyRef}
        className="tw-prism-body"
        style={{ gridTemplateColumns: `${split}fr ${PRISM_SEP_PX}px ${100 - split}fr` }}
      >
        <div className="tw-prism-col tw-prism-left">

          <div className="tw-prism-seg" role="tablist" aria-label="交易视图" style={{ gap: `${SEGMENT_GAP}px`, padding: `${SEGMENT_PADDING}px` }}>
            {TABS.map((t) => (
              <RippleButton
                key={t.key}
                className={`tw-prism-segbtn${tab === t.key ? ' on' : ''}`}
                role="tab"
                ariaSelected={tab === t.key}
                onClick={() => setTab(t.key)}
                style={{ minWidth: `${segWidth}px` }}
              >{t.label}</RippleButton>
            ))}
          </div>
          <div className="tw-prism-cards" aria-label="总资产 现金 当日盈亏 累计盈亏">
            {cards.map((c) => (
              <div key={c.key} className="tw-prism-card tw-prism-metric">
                <div className="tw-prism-k">{c.label}</div>
                <div className="tw-prism-v">{c.value}</div>
                {c.hint !== null ? <div className="tw-prism-sub">{c.hint}</div> : null}
              </div>
            ))}
          </div>

          <div className="tw-prism-toolbar">
            <label className="tw-prism-muted" htmlFor="prism-capital">资金上限</label>
            <input id="prism-capital" className="tw-prism-time" value={capital} onChange={(e) => setCapital(e.target.value)} aria-label="资金上限" />
            <RippleButton onClick={saveCapital} disabled={busy}>入金/改上限</RippleButton>
            <RippleButton onClick={doCopy} disabled={busy}>按摊薄成本复制持仓</RippleButton>
            <span className="tw-prism-muted">{trading?.account.copiedAt == null ? '—（尚未复制）' : `上次复制 ${shClockText(trading.account.copiedAt)}`}</span>
          </div>

          <section className="tw-prism-card tw-prism-tablecard" aria-label="交易表（持仓 / 挂单 / 成交记录）">
            {tab === 'positions' ? (
              trading === null || trading.account.positions.length === 0
                ? <div className="tw-prism-muted">—（没有模拟持仓）</div>
                : (
                  <div className="tw-prism-stack">
                    <table className="tw-prism-table">
                      <thead><tr><th>代码</th><th>名称</th><th className="tw-prism-num">数量</th><th className="tw-prism-num">摊薄成本</th><th className="tw-prism-num">现价</th><th className="tw-prism-num">市值</th><th className="tw-prism-num">仓位占比</th><th className="tw-prism-num">浮盈</th></tr></thead>
                      <tbody>
                        {trading.account.positions.map((p) => {
                          const price = trading.prices?.[p.secid] ?? null
                          const mv = price === null ? null : price * p.qty
                          const pnl = price === null ? null : (price - p.cost) * p.qty
                          return (
                            <tr key={p.secid}>
                              <td className="tw-prism-code tw-prism-mono">{p.secid}</td><td className="tw-prism-name">{p.name}</td>
                              <td className="tw-prism-num tw-prism-mono">{p.qty}</td>
                              <td className="tw-prism-num tw-prism-mono">{PRISM_MONEY(p.cost)}</td>
                              <td className="tw-prism-num tw-prism-mono">{price === null ? '—（未取到行情）' : PRISM_MONEY(price)}</td>
                              <td className="tw-prism-num tw-prism-mono">{PRISM_MONEY(mv)}</td>
                              <td className="tw-prism-num tw-prism-mono">{PRISM_PCT(positionWeightPct(price, p.qty, totalAssets))}</td>
                              <td className={`tw-prism-num tw-prism-mono ${pnl === null ? '' : pnl >= 0 ? 'up' : 'down'}`}>{pnl === null ? '—（未取到行情）' : PRISM_MONEY(pnl)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    <div className="tw-prism-composition">
                      <div className="tw-prism-muted">持仓构成（市值 ÷ 总资产；现金留白）</div>
                      <div className="tw-prism-bar" aria-label="持仓构成">
                        {composition.map((c) => <span key={c.key} style={{ width: `${c.weight}%`, background: c.color }} />)}
                      </div>
                      <div className="tw-prism-composition-legend">
                        {composition.map((c) => <span key={c.key}><i style={{ background: c.color }} />{c.name}</span>)}
                      </div>
                    </div>
                  </div>
                )
            ) : null}

            {tab === 'orders' ? (
              trading === null || trading.orders.length === 0
                ? <div className="tw-prism-muted">—（没有挂单）</div>
                : (
                  <table className="tw-prism-table">
                    <thead><tr><th>方向</th><th className="tw-prism-num">价格</th><th className="tw-prism-num">数量</th><th>状态</th><th>原因</th><th /></tr></thead>
                    <tbody>
                      {trading.orders.slice(-30).reverse().map((o) => (
                        <tr key={o.id}>
                          <td>{o.side === 'buy' ? '买' : '卖'} {o.name}</td>
                          <td className="tw-prism-num tw-prism-mono">{PRISM_MONEY(o.price)}</td>
                          <td className="tw-prism-num tw-prism-mono">{o.filledShares !== undefined && o.filledShares > 0 ? `${o.filledShares}/${o.shares}` : o.shares}</td>
                          <td>{orderStatusText(o)}</td>
                          <td className="tw-prism-muted">{o.skipReason ?? o.rejectReason ?? o.reason}</td>
                          <td>{o.status === 'pending' ? <RippleButton onClick={() => doCancel(o.id)} disabled={busy}>撤</RippleButton> : null}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
            ) : null}

            {tab === 'fills' ? (
              trading === null || trading.fills.length === 0
                ? <div className="tw-prism-muted">—（没有成交）</div>
                : (
                  <table className="tw-prism-table">
                    <thead><tr><th>时间</th><th>方向</th><th className="tw-prism-num">价格</th><th className="tw-prism-num">数量</th><th className="tw-prism-num">费用</th><th>来源</th></tr></thead>
                    <tbody>
                      {trading.fills.slice(-30).reverse().map((f) => (
                        <tr key={`${f.orderId}-${f.at}`}>
                          <td className="tw-prism-mono">{shClockText(f.at)}</td>
                          <td>{f.side === 'buy' ? '买' : '卖'} {f.name}</td>
                          <td className="tw-prism-num tw-prism-mono">{PRISM_MONEY(f.price)}</td>
                          <td className="tw-prism-num tw-prism-mono">{f.shares}</td>
                          <td className="tw-prism-num tw-prism-mono">{PRISM_MONEY(f.fee)}</td>
                          <td>{f.source === '1min' ? '1 分钟' : '分时'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
            ) : null}
          </section>

          <section className="tw-prism-card tw-prism-exposurecard" aria-label="行业暴露">
              <div className="tw-prism-card-title">行业暴露 <span className="tw-prism-muted">{exposureOk ? `已归类 ${exposure.classifiedPct.toFixed(2)}% · 未归类 ${exposure.unclassifiedPct.toFixed(2)}%` : '—'}</span></div>
              {exposureOk ? <div className="tw-prism-bar tw-prism-exposurebar" aria-label="行业暴露堆叠条">
                {expTop.map((r, i) => <span key={r.name} style={{ width: `${r.weight}%`, background: PRISM_SERIES_CSS[i % PRISM_SERIES_CSS.length] }} title={`${r.name} ${r.weight.toFixed(2)}%`} />)}
                {expRest.length > 0 ? <span style={{ width: `${expRestWeight}%`, background: PRISM_SERIES_CSS[3] }} title={`其余 ${expRest.length} 行 ${expRestWeight.toFixed(2)}%`} /> : null}
                {expFixed.map((r) => <span key={r.name} style={{ width: `${r.weight}%`, background: r.kind === 'unpenetrated' ? PRISM_SERIES_CSS[4] : '#868E96' }} title={`${r.name} ${r.weight.toFixed(2)}%`} />)}
              </div> : null}
              {exposureOk ? <div className="tw-prism-composition-legend">
                {expTop.map((r, i) => <span key={r.name}><i style={{ background: PRISM_SERIES_CSS[i % PRISM_SERIES_CSS.length] }} />{r.name} {r.weight.toFixed(2)}%</span>)}
                {expRest.length > 0 ? <span><i style={{ background: PRISM_SERIES_CSS[3] }} />其余 {expRest.length} 行 {expRestWeight.toFixed(2)}%</span> : null}
                {expFixed.map((r) => <span key={r.name}><i style={{ background: r.kind === 'unpenetrated' ? PRISM_SERIES_CSS[4] : '#868E96' }} />{r.name} {r.weight.toFixed(2)}%</span>)}
              </div> : null}
              {exposureOk ? <div className="tw-prism-muted">已归类 {exposure.classifiedPct.toFixed(2)}% + 未归类 {exposure.unclassifiedPct.toFixed(2)}% = 100.00%<span>（未归类 = 未穿透 {exposure.unpenetratedPct.toFixed(2)}% + 现金 {exposure.cashPct.toFixed(2)}%；前 6 行 + 其余 {expRest.length} 行）</span></div> : null}
              <table className="tw-prism-table tw-prism-exposure-table">
                <thead><tr><th>行业</th><th className="tw-prism-num">市值</th><th className="tw-prism-num">占比</th><th className="tw-prism-num">上限</th><th>状态</th></tr></thead>
                <tbody>
                  {expTop.map((r) => <tr key={r.name}><td>{r.name}{r.family === null || r.family === undefined ? null : <span className="tw-prism-muted"> · {r.family}</span>}</td><td className="tw-prism-num tw-prism-mono">{PRISM_MONEY(r.value)}</td><td className="tw-prism-num tw-prism-mono">{r.weight.toFixed(2)}%</td><td className="tw-prism-num"><input key={`${r.name}:${r.limitPct ?? 'none'}`} className="tw-prism-limitinput" aria-label={`${r.name}行业上限`} defaultValue={r.limitPct === null ? '' : String(r.limitPct)} placeholder="—" onBlur={(e) => { if (e.target.value.trim() !== '') saveIndustryLimit(r.name, e.target.value) }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} /></td><td className={r.status === '超限' ? 'up' : ''}>{r.status}</td></tr>)}
                  {expRest.length > 0 ? <tr><td>其余 {expRest.length} 行</td><td className="tw-prism-num tw-prism-mono">{PRISM_MONEY(expRest.reduce((s, r) => s + r.value, 0))}</td><td className="tw-prism-num tw-prism-mono">{expRestWeight.toFixed(2)}%</td><td className="tw-prism-num">—</td><td>正常</td></tr> : null}
                  {expFixed.map((r) => <tr key={r.name}><td>{r.name}</td><td className="tw-prism-num tw-prism-mono">{PRISM_MONEY(r.value)}</td><td className="tw-prism-num tw-prism-mono">{r.weight.toFixed(2)}%</td><td className="tw-prism-num">—</td><td>{r.status}</td></tr>)}
                  {exposureOk ? null : <tr><td colSpan={5} className="tw-prism-muted">—（{exposure.reason ?? '行业数据不可用'}）</td></tr>}
                </tbody>
              </table>
            </section>

          <section className="tw-prism-card tw-prism-decisioncard">
            <div className="tw-prism-card-title">决策 <span className="tw-prism-muted">limits / orders / cancel</span></div>
            <table className="tw-prism-table tw-prism-decision"><tbody>
              {dRows.map((r) => <tr key={r.key}><td>{r.key}</td><td className={`tw-prism-num tw-prism-mono${r.muted === true ? ' zero' : ''}`}>{r.key === '仓位上限依据' ? <div className="tw-prism-basis">{basisBlocks.map((b, i) => <div key={i} className={`tw-prism-basis-block${i === 2 ? ' tw-prism-basis-clamp tw-prism-mono' : ''}`} title={b}>{b}</div>)}</div> : r.value}</td></tr>)}
            </tbody></table>
            {(latest?.decision?.parseError ?? null) === null ? null : <div className="tw-prism-error">决策 JSON 解析失败：{decisionErrorText(latest?.decision?.parseError)}</div>}
          </section>

        </div>

        <div
          className="tw-prism-sep"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整两栏宽度"
          aria-valuemin={40}
          aria-valuemax={75}
          aria-valuenow={Math.round(split)}
          tabIndex={0}
          onPointerDown={onSeparatorDown}
          onKeyDown={onSeparatorKey}
        />

        <div className="tw-prism-col tw-prism-right">
          <section className="tw-prism-card tw-prism-researchcard">
            <div className="tw-prism-card-title">研判 <span className="tw-prism-muted">{latest === null ? '—（还没有运行记录）' : `${latest.slot} · ${latest.day} · token 用量 —（未取到）`}</span></div>
            <div className="tw-prism-row tw-prism-muted">
              {state?.news === undefined ? '—（尚未取到新闻状态）' : newsStatusText(state.news)}
              <RippleButton onClick={syncNews} disabled={busy}>同步新闻</RippleButton>
            </div>
            <div className="tw-prism-card-title">汇总</div>
            {bullets.length === 0 ? <div className="tw-prism-muted">—（本轮没有可展示的汇总）</div> : (
              <ul className="tw-prism-points">{bullets.map((b, i) => <li key={`${i}-${b.slice(0, 8)}`}>{b}</li>)}</ul>
            )}
            {reportRows.map((a, i) => (
              <details key={a.role} className="tw-prism-analysis" style={{ borderLeftColor: PRISM_SERIES_CSS[i] }}>
                <summary>{a.role}</summary>
                <div className="tw-prism-analysis-body">{analysisText({ key: 'info', label: a.role, text: a.text, error: a.error })}</div>
              </details>
            ))}
          </section>

          <section className="tw-prism-card tw-prism-equitycard">
            <div className="tw-prism-card-title">净值曲线 <span className="tw-prism-muted">{netHead}</span><span className="tw-prism-netseg" style={{ marginLeft: 'auto' }}><RippleButton className={`tw-prism-segbtn${netMode === 'nominal' ? ' on' : ''}`} onClick={() => setNetMode('nominal')}>名义</RippleButton><RippleButton className={`tw-prism-segbtn${netMode === 'adjusted' ? ' on' : ''}`} onClick={() => setNetMode('adjusted')}>调整后</RippleButton></span></div>
            {equityWarnings.length > 0 ? <div className="tw-prism-error">净值口径告警：{equityWarnings.at(-1)}</div> : null}
            {chart === null ? (
              <div className="tw-prism-muted">{netMode === 'adjusted' ? '—（调整后净值缺 capital 或点数不足）' : '—（不足两个交易日的净值）'}</div>
            ) : (
              <div className="tw-prism-chart">
                <div className="tw-prism-legend">
                  <span><i style={{ background: PRISM_SERIES_CSS[0] }} />{netMode === 'adjusted' ? '调整后净值' : equityLegend[0]}</span>

                </div>
                <svg viewBox="0 0 560 128" preserveAspectRatio="none" role="img" aria-label="净值曲线">
                  <g className="tw-prism-gridline">
                    <line x1="0" y1="32" x2="560" y2="32" />
                    <line x1="0" y1="64" x2="560" y2="64" />
                    <line x1="0" y1="96" x2="560" y2="96" />
                  </g>
                  <polyline points={chart.line} fill="none" stroke={PRISM_SERIES_CSS[0]} strokeWidth="1.5" />
                  {chart.dots.map((d) => <circle key={`${d.x}-${d.value}`} className="tw-prism-dot" cx={d.x} cy={d.y} r="2.5" />)}
                  <text x="552" y="122" textAnchor="end" className="tw-prism-chart-label">{netMode === 'adjusted' ? (adjustedLast?.value === null || adjustedLast?.value === undefined ? '—' : `${adjustedLast.value >= 0 ? '+' : ''}${adjustedLast.value.toFixed(2)}%`) : PRISM_MONEY(chart.last)}</text>
                </svg>
              </div>
            )}
          </section>
          <section className="tw-prism-card tw-prism-evalcard" aria-label="评估">
            <div className="tw-prism-card-title">评估 <span className="tw-prism-muted">P-03 · P-02 · {evaluation.n} 个独立窗口</span></div>
            {evalCurve === null ? <div className="tw-prism-muted">—（累计超额曲线不足两点）</div> : (
              <div className="tw-prism-evalchart">
                <svg viewBox="0 0 320 64" preserveAspectRatio="none" role="img" aria-label={`累计超额（${evaluation.n} 个独立窗口）`}>
                  <line className="tw-prism-gridline" x1="0" y1="16" x2="320" y2="16" />
                  <line className="tw-prism-gridline" x1="0" y1="32" x2="320" y2="32" />
                  <line className="tw-prism-gridline" x1="0" y1="48" x2="320" y2="48" />
                  <polyline points={evalCurve} fill="none" stroke={PRISM_SERIES_CSS[0]} strokeWidth="1.4" />
                </svg>
              </div>
            )}
            <div className="tw-prism-evalrow"><span>超额（对 1.000300）</span><span>{evaluation.excess.withFee === null || evaluation.excess.withoutFee === null ? `—（${evaluation.excess.reason ?? '样本不足'}）` : `含费 ${evalPct(evaluation.excess.withFee)} ｜ 不含费 ${evalPct(evaluation.excess.withoutFee)}`}</span><span className="tw-prism-muted">n={evaluation.excess.n}</span></div>
            <div className="tw-prism-evalrow"><span>回撤（自高点）</span><span>{metricText(evaluation.drawdown)}</span><span className="tw-prism-muted">n={evaluation.drawdown.n}</span></div>
            <div className="tw-prism-evalrow"><span>命中率</span><span>{metricText(evaluation.hitRate)}</span><span className="tw-prism-muted">n={evaluation.hitRate.n}</span></div>
            <div className="tw-prism-muted">非重叠样本 · 不含 embargo 区间 · embargo {evaluation.embargoDays} 日</div>
          </section>

            <details className="tw-prism-verinfo">
              <summary>{versionInfo.summary}</summary>
              <div className="tw-prism-muted">{versionInfo.body}</div>
            </details>

          <section className="tw-prism-card tw-prism-timecard">
            <div className="tw-prism-card-title">时点配置 <span className="tw-prism-muted">Asia/Shanghai</span></div>
            <div className="tw-prism-times">
              {times.map((t, i) => (
                <span key={`${t}-${i}`} className="tw-prism-chip">
                  <input className="tw-prism-time" type="time" value={t} aria-label={`时点 ${i + 1}`} onChange={(e) => setTimes((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))} />
                  <RippleButton onClick={() => setTimes((prev) => prev.filter((_, j) => j !== i))}>删除</RippleButton>
                </span>
              ))}
              <RippleButton onClick={() => setTimes((prev) => [...prev, '10:00'])}>＋ 时点</RippleButton>
              <RippleButton onClick={saveTimes} disabled={busy}>保存</RippleButton>
              <span className="tw-prism-muted">{timesText(state?.settings ?? null)}</span>
            </div>
            <div className="tw-prism-row">
              {(state?.settings.times ?? [...PRISM_DEFAULT_TIMES]).map((t) => <RippleButton key={t} onClick={() => run(t)} disabled={busy}>重跑 {t}</RippleButton>)}
              <RippleButton onClick={() => run('manual')} disabled={busy}>补跑</RippleButton>
            </div>
            <textarea className="tw-prism-skeleton" value={skeleton} onChange={(e) => setSkeleton(e.target.value)} rows={4} aria-label="研判骨架" />
            <div className="tw-prism-row">
              <RippleButton onClick={saveSkeleton} disabled={busy}>保存骨架</RippleButton>
              <span className="tw-prism-muted">{skeleton.length} 字</span>
            </div>
          </section>

          <section className="tw-prism-card tw-prism-modelcard">
            <div className="tw-prism-card-title">模型配置 <span className="tw-prism-muted">{modelCatalog?.error ?? '宿主候选'}</span></div>
            <div className="tw-prism-field">
              <label htmlFor="prism-provider">provider</label>
              <input id="prism-provider" className="tw-prism-input" list="prism-providers" value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="模型 provider" placeholder="provider" />
            </div>
            <div className="tw-prism-field">
              <label htmlFor="prism-model">model</label>
              <input id="prism-model" className="tw-prism-input" list="prism-models" value={modelName} onChange={(e) => setModelName(e.target.value)} aria-label="模型 model" placeholder="model" />
            </div>
            <datalist id="prism-providers">{(modelCatalog?.providers ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</datalist>
            <datalist id="prism-models">{(modelCatalog?.models?.[provider] ?? []).slice(0, 80).map((m) => <option key={m} value={m} />)}</datalist>
            <div className="tw-prism-row">
              <RippleButton onClick={saveModel} disabled={busy} className="tw-prism-btn primary">保存模型</RippleButton>
              <span className="tw-prism-muted">缺省 {state?.model.provider ?? '—'} / {state?.model.model ?? '—'}</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
