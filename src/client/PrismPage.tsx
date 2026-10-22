/**
 * 【棱镜】第 9 行 / 第 8 个页签（批次 1–4）。
 *
 * 顶部四格（总资产/现金/当日盈亏/累计盈亏）+ 持仓/挂单/成交三张表 + 净值迷你折线 +
 * 研判区（四份分报告可展开 + 汇总决策 + 撤单/挂单清单 + token 用量）+ 时点/骨架/新闻编辑。
 * 不写声明性文案；缺数据 `—` + 一句原因；数字用等宽；参数常驻可见（不藏悬停）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import type { PrismRun, PrismState, PrismTradingState } from '../shared/prism.ts'
import { PRISM_DEFAULT_TIMES } from '../shared/prism.ts'
import { shClockText } from './marketTime.ts'
import {
  PRISM_FONT,
  PRISM_MONEY,
  analysisText,
  newsStatusText,
  orderStatusText,
  runSummaryText,
  sparklineOf,
  timesProblems,
  timesText,
  topCardsOf,
} from './prismView.ts'

function RippleButton(props: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; title?: string }): React.ReactElement {
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
  return (
    <button ref={ref} type="button" className="tw-prism-btn" onPointerDown={onPointerDown} onClick={props.onClick} disabled={props.disabled} title={props.title}>
      {props.children}
    </button>
  )
}

const card = (title: string, children: React.ReactNode, cls = ''): React.ReactElement => (
  <section className={`tw-prism-card ${cls}`}>
    <div className="tw-prism-card-title" style={{ fontSize: PRISM_FONT.title }}>{title}</div>
    {children}
  </section>
)

export function PrismPage(props: { active: boolean }): React.ReactElement {
  const [state, setState] = useState<PrismState | null>(null)
  const [trading, setTrading] = useState<PrismTradingState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [times, setTimes] = useState<string[]>([...PRISM_DEFAULT_TIMES])
  const [skeleton, setSkeleton] = useState('')
  const [capital, setCapital] = useState('1500000')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [selftest, setSelftest] = useState<{ ok: boolean; error: string | null; model: string | null; elapsedMs: number } | null>(null)

  const load = useCallback((): void => {
    setError(null)
    api.prismState()
      .then((r) => {
        setState(r.state)
        setTrading(r.trading)
        setTimes(r.state.settings.times)
        setSkeleton(r.state.skeleton)
        setCapital(String(r.trading.account.capitalLimit))
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
  const doCopy = (): void => act(api.prismCopy(), (r) => setNotice(r.ok ? '已按成本价复制持仓' : `复制失败：${r.error ?? '未知'}`))
  const doCancel = (id: string): void => act(api.prismCancel(id), () => setNotice('已撤销'))
  const saveCapital = (): void => act(api.prismCapital(Number(capital)), () => setNotice('资金上限已更新'))
  const selfTest = (): void => {
    setBusy(true)
    api.prismSelftest().then(setSelftest).catch((e: Error) => setSelftest({ ok: false, error: e.message, model: null, elapsedMs: 0 })).finally(() => setBusy(false))
  }

  const latest: PrismRun | null = state === null || state.runs.length === 0 ? null : (state.runs[state.runs.length - 1] as PrismRun)
  const cards = topCardsOf(trading, trading?.prices ?? {})
  const spark = trading === null ? null : sparklineOf(trading.equity)
  const modelText = state === null ? '—' : state.model.error !== null ? `—（${state.model.error}）` : `${state.model.provider ?? '—'} / ${state.model.model ?? '—'}`

  return (
    <div className="tw-prism">
      <div className="tw-prism-head">
        <span style={{ fontSize: PRISM_FONT.title }}>棱镜 · 模拟盘</span>
        <span className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>模型 {modelText}</span>
        <RippleButton onClick={load} disabled={busy}>刷新</RippleButton>
        <RippleButton onClick={selfTest} disabled={busy}>自检</RippleButton>
        {selftest !== null ? (
          <span className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>
            {selftest.ok ? `自检 OK（${selftest.elapsedMs}ms）` : `自检失败：${selftest.error ?? '未给原因'}（${selftest.elapsedMs}ms）`}
          </span>
        ) : null}
      </div>
      {error !== null ? <div className="tw-prism-error" style={{ fontSize: PRISM_FONT.body }}>—（{error}）</div> : null}
      {notice !== null ? <div className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>{notice}</div> : null}

      <div className="tw-prism-cards">
        {cards.map((c) => (
          <div key={c.key} className="tw-prism-card tw-prism-metric">
            <div className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>{c.label}</div>
            <div className="tw-prism-num" style={{ fontSize: PRISM_FONT.title }}>{c.value}</div>
            {c.hint !== null ? <div className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>{c.hint}</div> : null}
          </div>
        ))}
      </div>

      {card('资金与持仓', (
        <div className="tw-prism-stack">
          <div className="tw-prism-row">
            <label style={{ fontSize: PRISM_FONT.body }}>资金上限</label>
            <input className="tw-prism-time" value={capital} onChange={(e) => setCapital(e.target.value)} aria-label="资金上限" />
            <RippleButton onClick={saveCapital} disabled={busy}>入金/改上限</RippleButton>
            <RippleButton onClick={doCopy} disabled={busy}>按成本价复制持仓</RippleButton>
            <span className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>
              {trading?.account.copiedAt == null ? '—（尚未复制）' : `上次复制 ${shClockText(trading.account.copiedAt)}`}
            </span>
          </div>
          {trading === null || trading.account.positions.length === 0 ? (
            <div className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>—（没有模拟持仓）</div>
          ) : (
            <table className="tw-prism-table" style={{ fontSize: PRISM_FONT.body }}>
              <thead><tr><th>代码</th><th>名称</th><th className="tw-prism-num">数量</th><th className="tw-prism-num">成本</th><th className="tw-prism-num">现价</th><th className="tw-prism-num">市值</th><th className="tw-prism-num">浮盈</th></tr></thead>
              <tbody>
                {trading.account.positions.map((p) => {
                  const price = trading.prices?.[p.secid] ?? null
                  const mv = price === null ? null : price * p.qty
                  const pnl = price === null ? null : (price - p.cost) * p.qty
                  return (
                    <tr key={p.secid}>
                      <td className="tw-prism-mono">{p.secid}</td><td>{p.name}</td>
                      <td className="tw-prism-num tw-prism-mono">{p.qty}</td>
                      <td className="tw-prism-num tw-prism-mono">{PRISM_MONEY(p.cost)}</td>
                      <td className="tw-prism-num tw-prism-mono">{price === null ? '—（未取到行情）' : PRISM_MONEY(price)}</td>
                      <td className="tw-prism-num tw-prism-mono">{PRISM_MONEY(mv)}</td>
                      <td className="tw-prism-num tw-prism-mono">{pnl === null ? '—' : PRISM_MONEY(pnl)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      ))}

      {card('挂单（当日有效）', (
        trading === null || trading.orders.length === 0
          ? <div className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>—（没有挂单）</div>
          : (
            <table className="tw-prism-table" style={{ fontSize: PRISM_FONT.body }}>
              <thead><tr><th>方向</th><th className="tw-prism-num">价格</th><th className="tw-prism-num">数量</th><th>状态</th><th>原因</th><th /></tr></thead>
              <tbody>
                {trading.orders.slice(-30).reverse().map((o) => (
                  <tr key={o.id}>
                    <td>{o.side === 'buy' ? '买' : '卖'} {o.name}</td>
                    <td className="tw-prism-num tw-prism-mono">{PRISM_MONEY(o.price)}</td>
                    <td className="tw-prism-num tw-prism-mono">{o.shares}</td>
                    <td>{orderStatusText(o)}</td>
                    <td className="tw-muted">{o.reason}</td>
                    <td>{o.status === 'pending' ? <RippleButton onClick={() => doCancel(o.id)} disabled={busy}>撤</RippleButton> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      ))}

      {card('成交记录', (
        trading === null || trading.fills.length === 0
          ? <div className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>—（没有成交）</div>
          : (
            <table className="tw-prism-table" style={{ fontSize: PRISM_FONT.body }}>
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
      ))}

      {card('净值曲线（每日一点）', (
        <div className="tw-prism-stack">
          <div className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>口径：总资产 = 现金 + 持仓市值（缺价按成本）；一个交易日一个点</div>
          {spark === null
            ? <div className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>—（不足两个交易日的净值）</div>
            : <svg className="tw-prism-spark" viewBox="0 0 160 36" role="img" aria-label="净值曲线"><polyline points={spark} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>}
        </div>
      ))}

      {card('研判', (
        latest === null
          ? <div className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>—（还没有运行记录）</div>
          : (
            <div className="tw-prism-stack">
              <div className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>
                {latest.slot} · {shClockText(latest.startedAt)} · token 用量 —（未取到）
              </div>
              {latest.analyses.map((a) => (
                <details key={a.key} className="tw-prism-analysis">
                  <summary style={{ fontSize: PRISM_FONT.body }}>{a.label}</summary>
                  <div className="tw-prism-analysis-body" style={{ fontSize: PRISM_FONT.body }}>{analysisText(a)}</div>
                </details>
              ))}
              <div className="tw-prism-summary" style={{ fontSize: PRISM_FONT.body }}>汇总：{runSummaryText(latest)}</div>
              {latest.decision === undefined || latest.decision === null ? (
                <div className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>决策 JSON：—（本轮汇总未给可解析的决策块）</div>
              ) : (
                <div className="tw-prism-stack" style={{ fontSize: PRISM_FONT.body }}>
                  <div>仓位上限：单标的 {latest.decision.limits.singlePct ?? '—'}% / 总 {latest.decision.limits.totalPct ?? '—'}%（{latest.decision.limits.note ?? '未给依据'}）</div>
                  <div>挂单清单：{latest.decision.orders.length === 0 ? '无' : latest.decision.orders.map((o) => `${o.side === 'buy' ? '买' : '卖'} ${o.secid} ${o.shares}@${o.price}`).join('；')}</div>
                  <div>撤单清单：{latest.decision.cancel.length === 0 ? '无' : latest.decision.cancel.join('、')}</div>
                </div>
              )}
            </div>
          )
      ))}

      {card('时点 / 骨架 / 金十', (
        <div className="tw-prism-stack">
          <div className="tw-prism-times">
            {times.map((t, i) => (
              <span key={`${t}-${i}`} className="tw-prism-chip">
                <input className="tw-prism-time" type="time" value={t} aria-label={`时点 ${i + 1}`} onChange={(e) => setTimes((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))} />
                <RippleButton onClick={() => setTimes((prev) => prev.filter((_, j) => j !== i))}>✕</RippleButton>
              </span>
            ))}
            <RippleButton onClick={() => setTimes((prev) => [...prev, '10:00'])}>＋ 时点</RippleButton>
            <RippleButton onClick={saveTimes} disabled={busy}>保存</RippleButton>
            <span className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>{timesText(state?.settings ?? null)}</span>
          </div>
          <div className="tw-prism-row" style={{ fontSize: PRISM_FONT.body }}>
            <span>{newsStatusText(state?.news ?? null)}</span>
            <RippleButton onClick={syncNews} disabled={busy}>同步新闻</RippleButton>
          </div>
          <textarea className="tw-prism-skeleton" value={skeleton} onChange={(e) => setSkeleton(e.target.value)} rows={6} aria-label="研判骨架" style={{ fontSize: PRISM_FONT.body }} />
          <div className="tw-prism-row">
            <RippleButton onClick={saveSkeleton} disabled={busy}>保存骨架</RippleButton>
            <span className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>{skeleton.length} 字</span>
          </div>
          <div className="tw-prism-row">
            {(state?.settings.times ?? [...PRISM_DEFAULT_TIMES]).map((t) => <RippleButton key={t} onClick={() => run(t)} disabled={busy}>{t}</RippleButton>)}
            <RippleButton onClick={() => run('manual')} disabled={busy}>manual</RippleButton>
          </div>
        </div>
      ))}
    </div>
  )
}
