/**
 * Right-side drawer with a fixed stock info header + chart tabs
 * (分时 / 五日 / 日K / 周K / 月K / 年K). Data is fetched lazily per tab and
 * memoized client-side (host caches back it anyway).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { KlineData, StockDetail, TradeMark, TrendData } from '../shared/model.ts'
import { api } from './api.ts'
import { dirClass, fmtAmt, fmtBig, fmtPct, fmtPrice, fmtSigned } from './format.ts'
import { Btn, ErrorNote, Skeleton } from './ui.tsx'
import { CandleChart, MultiDayTrend, Sparkline, type CandleBar, type CandleMarker, type SparkMarker } from './charts.tsx'

type ChartTab = 'trend' | '5d' | 'day' | 'week' | 'month' | 'year'

const TAB_LABEL: Record<ChartTab, string> = { trend: '分时', '5d': '五日', day: '日K', week: '周K', month: '月K', year: '年K' }

const KLINE_PLAN: Record<'day' | 'week' | 'month' | 'year', { klt: 101 | 102 | 103 | 104; lmt: number }> = {
  day: { klt: 101, lmt: 240 },
  week: { klt: 102, lmt: 200 },
  month: { klt: 103, lmt: 120 },
  year: { klt: 104, lmt: 20 },
}

type ChartPayload =
  | { kind: 'trend'; trend: TrendData }
  | { kind: 'kline'; kline: KlineData }

/** client-side memo: one resolved payload per secid+tab (host TTLs back it). */
const payloadCache = new Map<string, { exp: number; value: ChartPayload | null }>()

function fetchPayload(secid: string, tab: ChartTab): Promise<ChartPayload | null> {
  const cacheKey = `${secid}|${tab}`
  const hit = payloadCache.get(cacheKey)
  if (hit !== undefined && Date.now() < hit.exp) return Promise.resolve(hit.value)
  const p = (async (): Promise<ChartPayload | null> => {
    if (tab === 'trend') {
      const { trend } = await api.trend(secid, 1)
      if (trend === null) return null
      return { kind: 'trend', trend }
    }
    if (tab === '5d') {
      const { trend } = await api.trend(secid, 5)
      if (trend === null) return null
      return { kind: 'trend', trend }
    }
    const plan = KLINE_PLAN[tab as 'day' | 'week' | 'month' | 'year']
    const { kline } = await api.kline(secid, plan.klt, plan.lmt)
    if (kline === null) return null
    return { kind: 'kline', kline }
  })()
  void p.then((value) => {
    const ttl = tab === 'trend' || tab === '5d' ? 90_000 : 600_000
    payloadCache.set(cacheKey, { exp: Date.now() + ttl, value })
  })
  return p
}

function useContainerWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(620)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const update = (): void => setWidth(Math.max(320, Math.floor(el.clientWidth - 4)))
    update()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])
  return [ref, width]
}

export function QuoteDrawer(props: { secid: string; name: string; redUp: boolean; onClose: () => void }): React.ReactElement {
  const { secid, name, redUp, onClose } = props
  const [tab, setTab] = useState<ChartTab>('trend')
  const [payload, setPayload] = useState<ChartPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [detail, setDetail] = useState<StockDetail | null>(null)
  const [industry, setIndustry] = useState<{ name: string; pct: number | null } | null>(null)
  const [infoErr, setInfoErr] = useState(false)
  const [trades, setTrades] = useState<TradeMark[]>([])
  const [retry, setRetry] = useState(0)
  const [containerRef, width] = useContainerWidth()

  // header info
  useEffect(() => {
    let alive = true
    setInfoErr(false)
    api.detail(secid).then((r) => { if (alive) setDetail(r.detail) }).catch(() => { if (alive) setInfoErr(true) })
    api.industry(secid).then((r) => { if (alive) setIndustry(r.industry) }).catch(() => undefined)
    api.trades(secid).then((r) => { if (alive) setTrades(r.trades) }).catch(() => { if (alive) setTrades([]) })
    return () => { alive = false }
  }, [secid, retry])

  // chart payload per tab
  useEffect(() => {
    let alive = true
    setLoading(true)
    setErr(null)
    fetchPayload(secid, tab)
      .then((value) => {
        if (!alive) return
        setPayload(value)
        setErr(value === null ? '该周期暂无数据（停牌/新股/接口限流）' : null)
      })
      .catch((e: Error) => {
        if (alive) setErr(e.message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => { alive = false }
  }, [secid, tab, retry])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const priceCls = dirClass(detail?.chg ?? null, redUp)
  const chartHeight = 320

  const kv = (k: string, v: string, cls?: string, title?: string): React.ReactElement =>
    React.createElement('div', { className: 'tw-dkv', title },
      React.createElement('span', { className: 'k' }, k),
      React.createElement('span', { className: `v ${cls ?? ''}` }, v),
    )

  const headerRows = (): React.ReactNode => {
    if (detail === null) {
      if (infoErr) {
        return React.createElement('div', { className: 'tw-hint', style: { display: 'flex', alignItems: 'center', gap: 10 } },
          '详情加载失败', React.createElement(Btn, { onClick: () => setRetry((x) => x + 1) }, '重试'),
        )
      }
      return React.createElement(Skeleton, { lines: 3, height: 14, style: { maxWidth: 420 } })
    }
    const d = detail
    const volFmt = d.vol !== null && d.vol !== undefined ? fmtBig(d.vol) : null
    const amtFmt = d.amount !== null && d.amount !== undefined ? fmtAmt(d.amount) : null
    const board = industry
    return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
      React.createElement('div', { style: { display: 'flex', gap: 8 } },
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } },
          React.createElement('span', { style: { fontWeight: 700, fontSize: 15 } }, d.name ?? name),
          React.createElement('span', { className: 'tw-muted', style: { fontSize: 10.5 } }, `${secid}${d.code !== undefined && d.code !== '' ? ` · ${d.code}` : ''}`),
        ),
        React.createElement('div', { style: { flex: 1 } }),
        React.createElement('div', { style: { textAlign: 'right' } },
          React.createElement('div', { className: priceCls, style: { fontSize: 20, fontWeight: 700, fontFamily: 'var(--tw-mono)' } }, fmtPrice(d.price)),
          React.createElement('div', { className: priceCls, style: { fontSize: 11.5, fontFamily: 'var(--tw-mono)' } }, `${fmtSigned(d.chg)}  ${fmtPct(d.pct)}`),
        ),
        React.createElement(Btn, { onClick: onClose, title: '关闭 (Esc)', 'aria-label': '关闭明细' }, '✕'),
      ),
      React.createElement('div', { className: 'tw-dkv-grid', style: { marginTop: 6 } },
        kv('所属板块', board !== null ? (board.pct !== null ? `${board.name}  ${fmtPct(board.pct)}` : board.name) : '—',
          board !== null && board.pct !== null ? dirClass(board.pct, redUp) : undefined,
          board !== null ? '行业板块及当日涨跌幅' : '仅 A股 提供行业板块'),
        kv('今开', fmtPrice(d.open)),
        kv('昨收', fmtPrice(d.prev)),
        kv('换手率', d.turnover !== null ? `${d.turnover}%` : '—'),
        kv('最高', fmtPrice(d.high), dirClass(d.high !== null && d.prev !== null ? d.high - d.prev : 0, redUp)),
        kv('最低', fmtPrice(d.low), dirClass(d.low !== null && d.prev !== null ? d.low - d.prev : 0, redUp)),
        kv('成交量', volFmt ?? '—'),
        kv('成交额', amtFmt ?? '—'),
        kv('市盈率(动)', d.pe !== null ? String(d.pe) : '—'),
        kv('总市值', d.totalMv !== null ? fmtAmt(d.totalMv) : '—'),
      ),
    )
  }

  const chartBody = (): React.ReactNode => {
    if (loading) {
      return React.createElement('div', { 'aria-busy': true, 'aria-label': '图表加载中' },
        React.createElement('div', { className: 'tw-skel', style: { height: chartHeight, width: '100%' } }),
      )
    }
    if (err !== null) {
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 60 } },
        React.createElement('span', { className: 'tw-muted' }, err),
        React.createElement(Btn, { onClick: () => setRetry((x) => x + 1) }, '重试'),
      )
    }
    if (payload === null) return null
    if (payload.kind === 'trend') {
      const t = payload.trend
      const points = t.points.map((p) => ({ t: p.t, value: p.price, label: p.label.slice(11) }))
      const lastUp = points.length > 1 ? points[points.length - 1].value >= (t.prePrice ?? points[0].value) : null
      // 只在分时（当日）图上标 B/S：取交易时间落在当日区间内的流水
      const dayMarkers: SparkMarker[] = []
      if (tab === 'trend' && points.length > 0) {
        const t0 = points[0].t
        const t1 = points[points.length - 1].t
        for (const tr of trades) {
          if (tr.ts < t0 - 3_600_000 || tr.ts > t1 + 6 * 3_600_000) continue
          dayMarkers.push({
            t: tr.ts,
            value: tr.price,
            kind: tr.verb,
            title: `${tr.verb === 'buy' ? '买入' : '卖出'} ${tr.qty} @ ${tr.price}${tr.posName !== null ? ` · ${tr.posName}` : ''}`,
          })
        }
      }
      if (tab === 'trend') {
        return React.createElement(Sparkline, { points, markers: dayMarkers, baseline: t.prePrice, width, height: chartHeight, up: lastUp !== false, upColor: 'var(--tw-up)', downColor: 'var(--tw-down)', timeLabels: true })
      }
      // 五日：按日期分组绘制
      const dayMap = new Map<string, { label: string; values: number[] }>()
      for (const p of t.points) {
        const date = p.label.slice(0, 10)
        let d = dayMap.get(date)
        if (d === undefined) { d = { label: date, values: [] }; dayMap.set(date, d) }
        d.values.push(p.price)
      }
      return React.createElement(MultiDayTrend, { days: [...dayMap.values()], width, height: chartHeight, redUp })
    }
    const bars: CandleBar[] = payload.kline.days.map((d) => ({ date: d.date, open: d.open, close: d.close, high: d.high, low: d.low }))
    const klineMarkers: CandleMarker[] = trades
      .filter((tr) => bars.length > 0 && tr.ts >= Date.parse(`${bars[0].date}T00:00:00`) - 86_400_000 * 8)
      .map((tr) => ({ date: new Date(tr.ts).toISOString().slice(0, 10), kind: tr.verb, qty: tr.qty, price: tr.price }))
    return React.createElement(CandleChart, { bars, markers: klineMarkers, width, height: chartHeight, redUp })
  }

  // per-tab caption (period/range + baseline info)
  let note = ''
  const buys = trades.filter((t) => t.verb === 'buy').length
  const sells = trades.filter((t) => t.verb === 'sell').length
  const legend = trades.length > 0 && tab !== '5d' ? ` · B 买入 ${buys} 笔 / S 卖出 ${sells} 笔（来自持仓流水）` : ''
  if (payload !== null && err === null) {
    if (payload.kind === 'trend') {
      const t = payload.trend
      const dates = new Set(t.points.map((p) => p.label.slice(0, 10)))
      const first = t.points[0]
      const last = t.points[t.points.length - 1]
      if (first !== undefined && last !== undefined) {
        note = dates.size <= 1
          ? `昨收 ${fmtPrice(t.prePrice)} · ${first.label.slice(11)} ~ ${last.label.slice(11)}`
          : `共 ${dates.size} 个交易日 · ${first.label.slice(5, 10)} ~ ${last.label.slice(5, 10)}（末行为今日）`
      }
    } else {
      const k = payload.kline
      const first = k.days[0]
      const last = k.days[k.days.length - 1]
      if (first !== undefined && last !== undefined) {
        note = `共 ${k.days.length} 根 · ${first.date} ~ ${last.date}${k.stale === true ? ' · 缓存数据（上游暂不可用）' : ''}`
      }
    }
  }

  return React.createElement(
    'div',
    { className: 'tw-drawer-mask', onMouseDown: (e: React.MouseEvent) => { if (e.target === e.currentTarget) onClose() } },
    React.createElement(
      'div',
      { className: 'tw-drawer', onMouseDown: (e: React.MouseEvent) => e.stopPropagation() },
      React.createElement('div', { className: 'tw-drawer-head' }, headerRows()),
      React.createElement('div', { className: 'tw-tabs', style: { justifyContent: 'flex-start' } },
        (Object.keys(TAB_LABEL) as ChartTab[]).map((t) =>
          React.createElement('button', { key: t, className: 'tw-tab', title: TAB_LABEL[t], 'data-on': tab === t, onClick: () => setTab(t) }, TAB_LABEL[t]),
        ),
      ),
      React.createElement('div', { ref: containerRef, className: 'tw-drawer-body' },
        chartBody(),
        note !== '' || legend !== ''
          ? React.createElement('div', { className: 'tw-chartnote' }, `${note}${legend}`)
          : null,
      ),
      React.createElement('div', { className: 'tw-drawer-foot' },
        React.createElement('span', { className: 'tw-muted' }, `${name} · ${secid}`),
        React.createElement('span', { style: { flex: 1 } }),
        React.createElement('span', { className: 'tw-muted' }, '数据为延迟行情，仅作参考'),
      ),
    ),
  )
}
