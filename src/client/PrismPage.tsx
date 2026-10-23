/*
 * 【棱镜】第 9 行 / 第 8 个页签（重设计：hybrid 配色 + 左栏分段 + 62:38 可拖拽）。
 *
 * 左：四格资产 → 分段（持仓/挂单/成交）→ 表格 → 净值曲线（MD dataviz 8 系列色）。
 * 右：研判（汇总常驻 + 四份报告 + limits/rejects）→ 时点配置 → 模型配置。
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
  analysisText,
  compositionItems,
  decisionErrorText,
  decisionRows,
  equityChartOf,
  equityLegendItems,
  newsStatusText,
  normalizeTradingState,
  orderStatusText,
  positionWeightPct,
  selftestText,
  summaryBullets,
  timesProblems,
  timesText,
  topCardsOf,
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
  const chart = equityChartOf(trading?.equity ?? [])
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
  const dRows = decisionRows(latest?.decision, { cash: trading?.account.cash, minPrice: lowPrice })
  const composition = trading === null
    ? []
    : compositionItems(trading.account.positions, trading.prices ?? {}, totalAssets, PRISM_SERIES_CSS)
  const equityLegend = equityLegendItems()

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
          <div className="tw-prism-seg" role="tablist" aria-label="交易视图">
            {TABS.map((t) => (
              <RippleButton
                key={t.key}
                className={`tw-prism-segbtn${tab === t.key ? ' on' : ''}`}
                role="tab"
                ariaSelected={tab === t.key}
                onClick={() => setTab(t.key)}
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
                      <thead><tr><th>标的</th><th className="tw-prism-num">数量</th><th className="tw-prism-num">摊薄成本</th><th className="tw-prism-num">现价</th><th className="tw-prism-num">市值</th><th className="tw-prism-num">仓位占比</th><th className="tw-prism-num">浮盈</th></tr></thead>
                      <tbody>
                        {trading.account.positions.map((p) => {
                          const price = trading.prices?.[p.secid] ?? null
                          const mv = price === null ? null : price * p.qty
                          const pnl = price === null ? null : (price - p.cost) * p.qty
                          return (
                            <tr key={p.secid}>
                              <td><span className="tw-prism-mono">{p.secid}</span> <span className="tw-prism-muted">{p.name}</span></td>
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
                          <td className="tw-prism-num tw-prism-mono">{o.shares}</td>
                          <td>{orderStatusText(o)}</td>
                          <td className="tw-prism-muted">{o.reason}</td>
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

          <section className="tw-prism-card tw-prism-equitycard">
            <div className="tw-prism-card-title">净值曲线 <span className="tw-prism-muted">每日一点 · 总资产 = 现金 + 持仓市值（缺价按成本）</span></div>
            {chart === null ? (
              <div className="tw-prism-muted">—（不足两个交易日的净值）</div>
            ) : (
              <div className="tw-prism-chart">
                <div className="tw-prism-legend">
                  {equityLegend.map((name) => <span key={name}><i style={{ background: PRISM_SERIES_CSS[0] }} />{name}</span>)}
                </div>
                <svg viewBox="0 0 560 128" preserveAspectRatio="none" role="img" aria-label="净值曲线">
                  <g className="tw-prism-gridline">
                    <line x1="0" y1="32" x2="560" y2="32" />
                    <line x1="0" y1="64" x2="560" y2="64" />
                    <line x1="0" y1="96" x2="560" y2="96" />
                  </g>
                  <polyline points={chart.line} fill="none" stroke={PRISM_SERIES_CSS[0]} strokeWidth="1.5" />
                  {chart.dots.map((d) => <circle key={`${d.x}-${d.value}`} className="tw-prism-dot" cx={d.x} cy={d.y} r="2.5" />)}
                  <text x="552" y="122" textAnchor="end" className="tw-prism-chart-label">{PRISM_MONEY(chart.last)}</text>
                </svg>
              </div>
            )}
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
          <section className="tw-prism-card">
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

          <section className="tw-prism-card">
            <div className="tw-prism-card-title">决策 <span className="tw-prism-muted">limits / orders / cancel</span></div>
            <table className="tw-prism-table tw-prism-decision"><tbody>
              {dRows.map((r) => <tr key={r.key}><td>{r.key}</td><td className={`tw-prism-num tw-prism-mono${r.muted === true ? ' zero' : ''}`}>{r.value}</td></tr>)}
            </tbody></table>
            {(latest?.decision?.parseError ?? null) === null ? null : <div className="tw-prism-error">决策 JSON 解析失败：{decisionErrorText(latest?.decision?.parseError)}</div>}
          </section>

          <section className="tw-prism-card">
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

          <section className="tw-prism-card">
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
