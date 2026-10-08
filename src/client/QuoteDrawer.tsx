/**
 * Right-side drawer with a fixed stock info header + chart tabs
 * (分时 / 五日 / 日K / 周K / 月K / 年K). Data is fetched lazily per tab through
 * the shared client-side chart cache (see chartCache.ts): switching tabs or
 * reopening the same stock costs zero requests while the entry is fresh.
 */
import React, { useEffect, useRef, useState } from 'react'
import type { FqMode, StockDetail, TradeMark } from '../shared/model.ts'
import { FQ_LABEL } from '../shared/model.ts'
import { api } from './api.ts'
import { dirClass, fmtAmt, fmtBig, fmtPct, fmtPrice, fmtSigned } from './format.ts'
import { Btn, Skeleton} from './ui.tsx'
import type { CandleMarker, SparkMarker } from './charts.tsx'
import { KlineChart, TrendChart } from './kline.tsx'
import {
  FQ_ORDER,
  KLINE_PLAN,
  TAB_LABEL,
  cacheNoteOf,
  chartCache,
  fqFor,
  fqNoteOf,
  isKlineTab,
  rememberedTab,
  rememberFq,
  rememberTab,
  type ChartPayload,
  type ChartTab,
} from './chartCache.ts'

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
  // 记住上次看的周期：关掉再打开、换一只标的时不必重新点一次
  const [tab, setTab] = useState<ChartTab>(rememberedTab())
  // 复权口径：默认前复权，按标的记忆（见 chartCache.ts 的 fqFor/rememberFq）
  const [fqt, setFqt] = useState<FqMode>(() => fqFor(secid))
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

  // chart payload per tab（走客户端图表缓存：命中即零请求，同键并发合并）
  useEffect(() => {
    let alive = true
    setErr(null)
    const peeked = chartCache.peek(secid, tab, fqt)
    if (peeked !== null) {
      // 有缓存：先出图，不闪骨架
      setPayload(peeked)
      setLoading(false)
    } else {
      setLoading(true)
      setPayload((prev) => (prev !== null && prev.tab === tab ? prev : null))
    }
    chartCache
      .get(secid, tab, fqt)
      .then((value) => {
        if (!alive) return
        setPayload(value)
        setErr(value === null ? '该周期暂无数据（停牌/新股/接口限流）' : null)
        // 宿主认定该标的不适用复权（指数/期货）：把口径归位到它实际用的 0，
        // 后续请求与缓存键都对齐，界面上也不会显示一个没生效的选择
        if (value !== null && value.kind === 'kline' && value.kline.fqSupported === false && fqt !== 0) {
          rememberFq(secid, 0)
          setFqt(0)
        }
      })
      .catch((e: Error) => {
        if (alive) setErr(e.message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => { alive = false }
  }, [secid, tab, fqt, retry])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const priceCls = dirClass(detail?.chg ?? null, redUp)
  // 三窗格（主图 + 成交量 + MACD）
  const chartHeight = 8 + 210 + 6 + 54 + 6 + 64 + 16

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
    if (payload === null || payload.tab !== tab) {
      // 旧周期的数据尚未被替换：显示骨架而不是拿它去渲染
      return React.createElement('div', { 'aria-busy': true, 'aria-label': '图表加载中' },
        React.createElement('div', { className: 'tw-skel', style: { height: chartHeight, width: '100%' } }))
    }
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
        return React.createElement(TrendChart, {
          points: t.points.map((p) => ({ t: p.t, value: p.price, vol: p.vol, avg: p.avg, label: p.label })),
          baseline: t.prePrice,
          markers: dayMarkers,
          width,
          redUp,
          mainH: 210,
          volH: 54,
          macdH: 64,
        })
      }
      if (tab !== '5d') return null
      // 五日：连续拼接（午休/隔夜已由压缩时间轴折叠），交易日之间画分隔线
      const pts = t.points.map((p) => ({ t: p.t, value: p.price, vol: p.vol, avg: p.avg, label: p.label }))
      const breaks: number[] = []
      for (let i = 1; i < pts.length; i += 1) {
        if (pts[i].label.slice(0, 10) !== pts[i - 1].label.slice(0, 10)) breaks.push(i)
      }
      void lastUp
      return React.createElement(TrendChart, {
        points: pts,
        baseline: null,
        width,
        redUp,
        dayBreaks: breaks,
        mainH: 200,
        volH: 52,
        macdH: 62,
      })
    }
    if (!isKlineTab(tab)) return null
    const plan = KLINE_PLAN[tab]
    const bars = payload.kline.days.map((d) => ({ date: d.date, open: d.open, close: d.close, high: d.high, low: d.low, vol: d.vol }))
    const klineMarkers: CandleMarker[] = trades
      .filter((tr) => bars.length > 0 && tr.ts >= Date.parse(`${bars[0].date}T00:00:00`) - 86_400_000 * 8)
      .map((tr) => ({ date: new Date(tr.ts).toISOString().slice(0, 10), kind: tr.verb, qty: tr.qty, price: tr.price }))
    return React.createElement(KlineChart, {
      key: tab,
      bars,
      markers: klineMarkers,
      width,
      redUp,
      klt: plan.klt,
      mainH: 230,
      volH: 54,
      macdH: 64,
    })
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
        note = `共 ${k.days.length} 根${fqNoteOf(k)} · ${first.date} ~ ${last.date} · MA5/10/30/60 · 滚轮或拖动滑块缩放日期区间${k.stale === true ? ' · 缓存数据（上游暂不可用）' : ''}`
      } else {
        note = fqNoteOf(k).replace(/^ · /, '')
      }
    }
    // 数据来源如实标注：本地缓存 / 休市定稿 / 本次刷新失败时的上次成功数据
    const cn = cacheNoteOf(payload)
    if (cn !== '') note = note === '' ? cn.replace(/^ · /, '') : note + cn
  }

  /**
   * 图表数据口径条（P0-5）。
   *
   * 每一个在图上的数都必须能被追问"哪根、什么口径、更新到几点"，因此这一行的**全部字段
   * 都取自实际取数参数**，不许手写死：
   *   - 周期：实际请求的 klt（来自 KLINE_PLAN，不是 tab 文字）；
   *   - 复权：宿主回包里的 `kline.fqt`（实际生效口径），**不是**界面上请求的那个
   *     （指数/期货会被宿主收敛为 0，用请求值会显示错口径）；
   *   - 截至：宿主给的 `kline.asOf`（本地最近一次成功取数时刻）；
   *   - 当根是否收盘：`kline.barOpen`，并明确告知 MA 是否含该根。
   */
  const caliberLine = (): string => {
    if (payload === null || payload.kind !== 'kline') {
      if (payload !== null && payload.kind === 'trend') {
        const t = payload.trend
        const last = t.points[t.points.length - 1]
        return `${TAB_LABEL[payload.tab]} · 不复权（分时序列无除权概念） · 截至 ${last !== undefined ? last.label.slice(5, 16) : '—'}`
      }
      return ''
    }
    const k = payload.kline
    const plan = KLINE_PLAN[payload.tab]
    const last = k.days[k.days.length - 1]
    const at = typeof k.asOf === 'number' && k.asOf > 0
      ? new Date(k.asOf).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '—'
    const mode = TAB_LABEL[payload.tab]
    const fq = k.fqSupported === false ? '不复权（该标的不适用）' : FQ_LABEL[(k.fqt ?? fqt) as FqMode]
    const tail = k.cached === true
      ? '已收盘定稿'
      : k.barOpen === true
        ? `当根未收盘，MA/MACD 已含未收盘当根（${last !== undefined ? last.date.slice(5) : '—'}）`
        : '当根已收盘'
    return `${mode} · klt ${plan.klt} · ${fq} · 截至 ${at}（${tail}）`
  }
  const caliber = caliberLine()

  // 复权段控：只在 K 线周期出现；宿主判定"不适用"时禁用，并把原因写在 title 与角标上
  const fqDisabled = payload !== null && payload.kind === 'kline' && payload.kline.fqSupported === false
  const fqControl = (): React.ReactNode => {
    if (!isKlineTab(tab)) return null
    const titleOf = (m: FqMode): string =>
      fqDisabled
        ? '该标的是指数/期货，价格本身没有除权除息，复权不适用'
        : `${FQ_LABEL[m]}${m === 0 ? '' : ' · 详情头的行情字段始终是真实成交价'}`
    return React.createElement('div', { className: 'tw-fq', role: 'group', 'aria-label': '复权口径' },
      React.createElement('span', { className: 'k' }, '复权'),
      FQ_ORDER.map((m) =>
        React.createElement('button', {
          key: m,
          type: 'button',
          className: 'tw-fq-btn',
          'data-on': !fqDisabled && fqt === m,
          'aria-pressed': !fqDisabled && fqt === m,
          disabled: fqDisabled,
          title: titleOf(m),
          onClick: () => {
            rememberFq(secid, m)
            setFqt(m)
          },
        }, FQ_LABEL[m]),
      ),
      fqDisabled
        ? React.createElement('span', { className: 'tw-fq-hint', title: '指数按点位、期货按合约价，都没有除权除息' }, '不适用')
        : null,
    )
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
          React.createElement('button', {
            key: t,
            className: 'tw-tab',
            title: TAB_LABEL[t],
            'data-on': tab === t,
            onClick: () => {
              rememberTab(t)
              setTab(t)
            },
          }, TAB_LABEL[t]),
        ),
        React.createElement('span', { style: { flex: 1, minWidth: 4 } }),
        fqControl(),
      ),
      React.createElement('div', { ref: containerRef, className: 'tw-drawer-body' },
        caliber !== ''
          ? React.createElement('div', {
              className: 'tw-caliber',
              title: '图上每个数都按这一行口径解释：周期 klt 来自实际请求参数，复权口径来自宿主回包的实际生效值；「截至」是本地最近一次成功取数时刻（未收盘当根在上游没有收盘时间，不用「现在」顶替）',
            }, caliber)
          : null,
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
