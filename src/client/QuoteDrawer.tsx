/**
 * Right-side drawer with a fixed stock info header + chart tabs
 * (分时 / 五日 / 日K / 周K / 月K / 年K). Data is fetched lazily per tab through
 * the shared client-side chart cache (see chartCache.ts): switching tabs or
 * reopening the same stock costs zero requests while the entry is fresh.
 */
import React, { useEffect, useRef, useState } from 'react'
import type { FqMode, MissingField, StockDetail, TradeMark } from '../shared/model.ts'
import { FQ_LABEL } from '../shared/model.ts'
import { api } from './api.ts'
import { dirClass, fmtAmt, fmtBig, fmtPct, fmtPrice, fmtSigned } from './format.ts'
import { Btn, Skeleton} from './ui.tsx'
import type { CandleMarker, SparkMarker } from './charts.tsx'
import { KlineChart, TrendChart } from './kline.tsx'
import { trendDayCount } from '../shared/model.ts'
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

import { sessionOf } from './sessionAxis.ts'
import { isUsableBaseline } from './trendView.ts'
import { trendCaliberOf } from '../shared/trendCaliber.ts'
import { ChipsPanel } from './ChipsPanel.tsx'
import { countMount } from './mounts.ts'
import { chartFrameOf } from './chartFrame.ts'
import { SPLIT_DEFAULT, klineHeightsOf, normalizeSplitRatio, splitDragRatio, splitHeights, splitKeyStep } from './splitDrag.ts'
import { NoteIcon } from './NoteIcon.tsx'
import { useChips } from './useChips.ts'

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

/**
 * 该标的是否支持前复权（与宿主 `em.fqSupported` 同一规则：指数/期货/板块不支持）。
 * 客户端只用它决定"要不要请求筹码分布"——**最终口径以宿主回包为准**（客户端不重算）。
 */
function fqSupportedOf(secid: string): boolean {
  const dot = secid.indexOf('.')
  if (dot <= 0) return false
  const market = secid.slice(0, dot)
  const code = secid.slice(dot + 1)
  if (market === '1' || market === '0') {
    if (market === '1' && code.startsWith('000')) return false
    if (market === '0' && (code.startsWith('399') || code.startsWith('159') === false && code.startsWith('39'))) return false
    return true
  }
  return false
}

export function QuoteDrawer(props: {
  secid: string
  name: string
  redUp: boolean
  onClose: () => void
  /** 上下分区比例（上窗占比；不给则用默认值） */
  splitRatio?: number
  /** 比例变更回调（宿主写 prefs；不给则只在本次会话内生效） */
  onSplitRatio?: (ratio: number) => void
}): React.ReactElement {
  const { secid, name, redUp, onClose } = props
  // 记住上次看的周期：关掉再打开、换一只标的时不必重新点一次
  const [tab, setTab] = useState<ChartTab>(rememberedTab())
  // 复权口径：默认前复权，按标的记忆（见 chartCache.ts 的 fqFor/rememberFq）
  const [fqt, setFqt] = useState<FqMode>(() => fqFor(secid))
  const [payload, setPayload] = useState<ChartPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  /** 头部详情为 null 时的原因（宿主回的 missing[0]）；不为 null 就是"拿得到"或用不着解释 */
  const [infoNote, setInfoNote] = useState<MissingField | null>(null)
  const [detail, setDetail] = useState<StockDetail | null>(null)
  const [industry, setIndustry] = useState<{ name: string; pct: number | null } | null>(null)
  const [infoErr, setInfoErr] = useState(false)
  const [trades, setTrades] = useState<TradeMark[]>([])
  const [retry, setRetry] = useState(0)
  // 筹码分布：**只随 secid 取一次**（页签/复权/图表重试都不参与）——切页签不发请求、不闪；
  // 五日档只是"不显示"（面板给原因），数据照留 ⇒ 切回来立即可见。
  const [chipsRefresh, setChipsRefresh] = useState(0)
  // 上下分区：比例来自 prefs；拖拽期间只挪线（dragRatio），松手才提交并**重绘**一次图表
  const ratio = normalizeSplitRatio(props.splitRatio ?? SPLIT_DEFAULT).ratio
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const [avail, setAvail] = useState(0)
  const dragStart = useRef<{ ratio: number; y: number } | null>(null)
  const [chipsOpen, setChipsOpen] = useState(true)
  // 可用高度：量容器（拿不到时用 520 兜底，保证首帧也有合理高度）
  useEffect(() => {
    const el = containerRef.current
    if (el === null) return
    const read = (): void => setAvail(el.clientHeight)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const shownRatio = dragRatio ?? ratio
  const split = splitHeights(avail > 0 ? avail : 520, shownRatio)
  // 图表几何：由上窗高度**重算**（固定开销不变 ⇒ 不是等比缩放）；高度不足时按最小值夹住、不重绘空图
  const kh = klineHeightsOf(split.top)
  const commitRatio = (next: number): void => {
    setDragRatio(null)
    props.onSplitRatio?.(next)
  }
  // 抽屉自身的挂载计数：切页签不该把它重建（key 只绑在 secid 上）
  useEffect(() => {
    countMount('drawer')
  }, [])
  const chipsState = useChips(secid, true, chipsRefresh)
  const [containerRef, width] = useContainerWidth()

  // header info
  useEffect(() => {
    let alive = true
    setInfoErr(false)
    api.detail(secid).then((r) => {
      if (!alive) return
      setDetail(r.detail)
      setInfoNote(r.detail === null ? (r.missing?.[0] ?? null) : null)
    }).catch(() => { if (alive) setInfoErr(true) })
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
      // ⚠ 不再清空：切页签要**保留上一张图**（旧周期的数据不拿去当新周期渲染，
      //   但也不必把它丢掉 —— 骨架替换整块图正是"整个侧栏在刷新"的观感来源）
      setLoading(true)
    }
    chartCache
      .get(secid, tab, fqt)
      .then((value) => {
        if (!alive) return
        setPayload(value)
        setErr(value === null ? '该周期未取到（停牌/新股/接口限流）' : null)
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
  const chartHeight = kh.chartHeight

  const kv = (k: string, v: string, cls?: string, title?: string): React.ReactElement =>
    React.createElement('div', { className: 'tw-dkv', title },
      React.createElement('span', { className: 'k' }, k),
      React.createElement('span', { className: `v ${cls ?? ''}` }, v),
    )

  const headerRows = (): React.ReactNode => {
    if (detail === null) {
      if (infoErr) {
        // 宿主对上游熔断会回 503 + retry-after（快速失败，避免继续打上游）。
        // 这里只留**一行**（用户抱怨过红条把图挤掉）：长解释进 title/aria-label，
        // 红色只表示"故障"，结构性限制走下面的不红那一支。
        const long = '行情详情只有东财一个上游：东财熔断/限流时未取到。宿主已按熔断冷却快速失败并给了 retry-after，' +
          '稍等会自动重试；频繁点「重试」只会让本机 IP 的限流更严重。'
        // 用户第 1 条：长条 + 按钮压成右上角一个小圆形 icon（悬停给详情、点击=重试、键盘可达）
        return React.createElement('div', { className: 'tw-hint tw-hint-icon' },
          React.createElement(NoteIcon, {
            reason: '详情不可用 · 上游限流，稍后自动重试',
            detail: long,
            onRetry: () => setRetry((x) => x + 1),
          }),
          React.createElement('span', { className: 'tw-muted' }, '详情暂不可用'),
        )
      }
      // 拿不到详情时把**原因**显示出来（此前只会停在骨架屏，用户以为一直在加载）
      if (infoNote !== null) {
        return React.createElement('div', { className: 'tw-hint tw-hint-icon' },
          infoNote.why === 'no-source'
            ? React.createElement(NoteIcon, { reason: '该标的无详情字段（重试无用）', detail: infoNote.note })
            : React.createElement(NoteIcon, { reason: '上游限流，稍后自动重试', detail: infoNote.note, onRetry: () => setRetry((x) => x + 1) }),
          React.createElement('span', { className: 'tw-muted' }, infoNote.why === 'no-source' ? '详情不可用' : '详情暂不可用'),
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
      return React.createElement('div', { className: 'tw-hint tw-hint-icon' },
        React.createElement(NoteIcon, { reason: `图表取数失败：${err}`, detail: `${err}\n宿主会按熔断冷却自动重试；频繁点重试只会让限流更严重。`, onRetry: () => setRetry((x) => x + 1) }),
        React.createElement('span', { className: 'tw-muted' }, err),
      )
    }
    if (payload === null) {
      // 首帧（还没有任何上一张图可留）：允许骨架
      return React.createElement('div', { 'aria-busy': true, 'aria-label': '图表加载中' },
        React.createElement('div', { className: 'tw-skel', style: { height: chartHeight, width: '100%' } }))
    }
    // 注意：这里**不**再判 `payload.tab !== tab` —— 旧周期的最后一帧继续渲染，
    // 由外层叠一层加载态（`chartFrameOf`），避免切页签时整块图变骨架。
    /**
     * 宿主明确回"这份数据拿不到"（`trend/kline: null`）时会带 `missing[]` ——
     * 必须把原因显示出来：`no-source`（该市场本来就没有这个源，等也没用）与
     * `transient`（上游这会儿不可达，稍后自动重试）对用户的下一步动作完全不同。
     */
    if (payload.kind === 'unavailable') {
      const m = payload.missing[0]
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 56 } },
        React.createElement('span', { className: 'tw-muted' }, '该周期未取到'),
        m !== undefined
          ? React.createElement('span', {
              className: 'tw-hint',
              style: { maxWidth: 520, textAlign: 'center', color: m.why === 'no-source' ? 'var(--tw-muted)' : undefined },
              tabIndex: 0,
              role: 'note',
              'aria-label': `${m.what}不可用（${m.why === 'no-source' ? '上游无此数据' : '未取到'}）：${m.note}`,
            }, `${m.what}不可用（${m.why === 'no-source' ? '上游无此数据，重试无用' : '未取到，等它恢复'}）：${m.note}`)
          : null,
        React.createElement('span', { className: 'tw-muted' }, payload.missing[0]?.note ?? ''),
        React.createElement(NoteIcon, {
          reason: `数据拿不到：${m?.what ?? secid}`,
          detail: payload.missing.map((x) => `${x.what}：${x.note}（${x.why === 'no-source' ? '上游没有这份数据，重试无用' : '本次失败，稍后自动重试'}）`).join('\n'),
          ...(m?.why === 'no-source' ? {} : { onRetry: () => setRetry((x) => x + 1) }),
        }),
      )
    }
    if (payload.kind === 'trend') {
      const t = payload.trend
      const points = t.points.map((p) => ({ t: p.t, value: p.price, label: p.label.slice(11) }))
      const lastUp = points.length > 1
        ? points[points.length - 1].value >= (isUsableBaseline(t.prePrice) ? t.prePrice : points[0].value)
        : null
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
          points: t.points.map((p) => ({ t: p.t, value: p.price, vol: p.vol, avg: p.avg, label: p.label, amount: p.amount ?? null })),
          baseline: isUsableBaseline(t.prePrice) ? t.prePrice : null,
          markers: dayMarkers,
          // 交易时段网格：有表的市场横轴固定为完整时段（部分数据右侧留白），其余回落压缩轴
          session: sessionOf(secid),
          width,
          redUp,
          mainH: 210,
          volH: 54,
          macdH: 64,
        })
      }
      if (tab !== '5d') return null
      // 五日：连续拼接（午休/隔夜已由压缩时间轴折叠），交易日之间画分隔线
      // 日分隔线与"按天"底部标签由 TrendChart 内部的 trendDayAxis 从点的 label 切出来
      //（此前这里自算 breaks 传进去；现在统一在图表里算，避免两套口径）
      const pts = t.points.map((p) => ({ t: p.t, value: p.price, vol: p.vol, avg: p.avg, label: p.label, amount: p.amount ?? null }))
      void lastUp
      const chart = React.createElement(TrendChart, {
        points: pts,
        baseline: null,
        // 五日：每天各自套自己的时段网格（相邻两天之间仍用现有的日分隔线与按天标签）
        session: sessionOf(secid),
        width,
        redUp,
        mainH: 200,
        volH: 52,
        macdH: 62,
      })
      // 五日档的"只有当日/覆盖不足"**不再单独占一条横幅**（用户抱怨过两条红条把图挤掉）：
      // 统一并入上方口径条那一行（见 caliberLine），完整解释进它的 title。
      void trendDayCount(pts)
      return chart
    }
    if (!isKlineTab(tab)) return null
    if (payload.kind !== 'kline') return null
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
      // 几何由上窗高度算出 ⇒ 高度变化会**重绘**（比例尺/轴刻度重算），不是 CSS 拉伸
      mainH: kh.mainH,
      volH: kh.volH,
      macdH: kh.macdH,
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
          ? `昨收 ${isUsableBaseline(t.prePrice) ? fmtPrice(t.prePrice) : '—'} · ${first.label.slice(11)} ~ ${last.label.slice(11)}`
          : `共 ${dates.size} 个交易日 · ${first.label.slice(5, 10)} ~ ${last.label.slice(5, 10)}（末行为今日）`
      }
    } else if (payload.kind === 'kline') {
      const k = payload.kline
      const first = k.days[0]
      const last = k.days[k.days.length - 1]
      if (first !== undefined && last !== undefined) {
        // D4：降级说明只留一处（下面 `cacheNoteOf` 的统一写法）；这里不再各写一句
        note = `共 ${k.days.length} 根${fqNoteOf(k)} · ${first.date} ~ ${last.date} · MA5/10/30/60 · 滚轮或拖动滑块缩放日期区间`
      } else {
        note = fqNoteOf(k).replace(/^ · /, '')
      }
    }
    // 数据来源如实标注：本地缓存 / 休市定稿 / 本次刷新失败时的上次成功数据
    let cn = cacheNoteOf(payload)
    // 降级/快照必须说明"现在显示的是什么"（P1-10）：本地归档拼接时补上快照时刻，
    // 与口径行用同一个 snapshotLabel()，避免两处对不上。
    if (cn.includes('本地缓存') && payload !== null && payload.kind === 'trend' && payload.trend.source === 'local-stitch') {
      const snap = snapshotLabel()
      if (snap !== null && !cn.includes('快照')) cn = cn.replace('本地缓存', `本地缓存（最近一次成功快照 ${snap}）`)
    }
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

  /** 最近一次成功快照的短标签（`09-24 13:41`）——口径行与 footer 共用同一份，不各写一套 */
  // 用函数声明（会提升）：口径行与 footer 两处都要用，而 footer 的 note 组装在本函数**之前** ——
  // 写成 const 箭头函数会触发 "used before its declaration"（实测踩过）。
  function snapshotLabel(): string | null {
    if (payload === null || payload.kind !== 'trend') return null
    const t = payload.trend
    // 优先用宿主标注的 LKG 快照时刻（`staleAt`）；否则退回"最后一个真实点的时刻"
    // —— 两者都是"这份数据是什么时候成功取到的"，不是"现在几点"。
    const ts = typeof t.staleAt === 'number' && t.staleAt > 0 ? t.staleAt : null
    if (ts !== null) {
      return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
    const lastPoint = t.points[t.points.length - 1]
    return lastPoint === undefined ? null : lastPoint.label.slice(5, 16)
  }

  const caliberLine = (): string => {
    if (payload === null || payload.kind !== 'kline') {
      if (payload !== null && payload.kind === 'trend') {
        const t = payload.trend
        const last = t.points[t.points.length - 1]
        const base = `${TAB_LABEL[payload.tab]} · 不复权（分时序列无除权概念） · 截至 ${last !== undefined ? last.label.slice(5, 16) : '—'}`
        // 五日：覆盖情况写进**这一行**（结构性限制不配单独横幅）。
        // 本地拼接时给出 have/limit 与缺口；真实多日源只有 1 天时明说"仅当日（该市场无多日源）"。
        const cov = t.coverage
        // 五日档的诚实化（task-49）：**滞后优先** —— 最新一天不是最近预期交易日时，
        // 口径行先说"数据滞后 N 天（最近一次成功快照 …）"，再说"仅 N 天可画 / 归档 N 天 / 缺 N 天"。
        // 判据与文案都在 shared/trendCaliber.ts（纯函数、有断言）：自然日差 + **工作日近似**（无交易日历）。
        const fiveMarker = payload.tab !== '5d'
          ? ''
          : cov !== undefined
            ? ((): string => {
                const c = trendCaliberOf({
                  // 传原始 label（`2026-09-24 13:41` 或 `09-24`）：解析在 shared/trendCaliber.dayNumberOf 里做，
                  // 界面不要自己 slice —— 截错位置会让滞后判定静默失效（实测踩过：slice(0,5) 截出 `2026-`）
                  lastDay: last !== undefined ? last.label : null,
                  now: Date.now(),
                  have: cov.have.length,
                  limit: cov.limit,
                  missing: cov.missing,
                  snapshotAt: snapshotLabel(),
                })
                return c.text === '' ? '' : ` · ${c.text}`
              })()
            : trendDayCount(t.points) <= 1
              ? ' · 仅 1 天可画（该市场无多日源）'
              : ''
        // 归档失败属运维细节：正文不再占位，原因并入口径条的完整解释（见 caliberExplain）
        // 该标的不适用分时段网格（美股/国际指数/外盘商品/期货）⇒ 一句话如实说明
        const gridNote = sessionOf(secid) === null ? ' · 无固定交易时段' : ''
        return base + fiveMarker + gridNote
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
  /**
   * 口径条的**完整解释**（title/aria）：五日的"只有当日/本地拼接覆盖"属于**结构性限制**，
   * 因此按用户要求不单独占一条横幅，而是并入口径条 —— 但完整解释必须鼠标与键盘都能读到。
   */
  const caliberExplain = ((): string | null => {
    if (payload === null || payload.kind !== 'trend' || payload.tab !== '5d') return null
    const cov = payload.trend.coverage
    if (cov !== undefined) {
      return `五日是本地归档拼接出来的（不是上游给的）：当前有 ${cov.have.length} 天（${cov.have.join('、') || '—'}）` +
        (cov.missing.length > 0
          ? `，缺 ${cov.missing.join('、')}（工作日里没有归档的日子；本插件没有交易日历，节假日也会列在这里）`
          : '') +
        `。归档从本版起累积（每天打开一次该标的即可 +1 天），保留最近 12 个交易日，可在「截图/录屏」设置里关闭。` +
        // 归档失败属运维细节：正文不占位，原因写在这里（一次）
        (payload.trend.archive !== undefined && payload.trend.archive.skipped.length > 0
          ? `本次有 ${payload.trend.archive.skipped.length} 天未归档：${payload.trend.archive.skipped[0].reason}。`
          : '')
    }
    if (trendDayCount(payload.trend.points) <= 1) {
      // 国内期货（114.* 郑商所之外的期货主连 / 113.*）：**连当日都取不到** ⇒ 不要承诺"归档会变长"
      const mkt = secid.split('.')[0]
      if (mkt === '114' || mkt === '113') {
        return '该市场当前没有任何可用的分时源（东财 trends2 与备用源都不返回国内期货分时），' +
          '所以五日档为空 —— 不是本页故障，也不会随归档变长（归档的前提取到过当日分时）。'
      }
      return '我们的两条多日渠道（新浪 5 分钟线、腾讯 5 分钟线）只覆盖沪/深，' +
        '所以五日档改由本地归档逐日累积 —— 不是本页故障（这是"我们没覆盖"，不等于"上游没有"）。'
    }
    return null
  })()

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

  // 切页签时的帧决策：旧图继续渲染 + 叠加加载态；**只有首帧**才走骨架
  const frame = chartFrameOf({ hasPayload: payload !== null, payloadTab: payload?.tab ?? '', tab })

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
              // 有五日覆盖说明时把完整解释放进来，并让键盘也能读到（tabIndex/aria）——P1-5 的同一约定
              title: caliberExplain ?? '口径取自实际请求与宿主回包生效值',
              ...(caliberExplain !== null ? { tabIndex: 0, role: 'note', 'aria-label': `${caliber}。${caliberExplain}` } : {}),
            }, caliber)
          : null,
        // 上窗：固定高度（由分割线算出）——用**真实高度重绘**而不是拉伸
        React.createElement('div', { className: 'tw-chart-pane', style: { height: split.top, overflow: 'hidden' } },
          React.createElement('div', { className: 'tw-chart-wrap' },
            chartBody(),
          // 切页签时：旧图仍在渲染，上面叠半透明加载态（细进度条 + 淡遮罩，不盖住旧图内容）
          frame.overlay
            ? React.createElement('div', { className: 'tw-chart-loading', 'aria-busy': true, 'aria-label': `${TAB_LABEL[tab]} 加载中（显示的是上一张图）` },
                React.createElement('div', { className: 'tw-chart-loading-bar' }),
                React.createElement('span', { className: 'tw-chart-loading-text' }, '载入中 · 上图为上一周期'),
                )
              : null,
          ),
        ),
        // 分割线：1px 细线 + 上下各 4px 命中区（不要装饰把手）；折叠时**不渲染**
        chipsOpen
          ? React.createElement('div', {
              className: 'tw-split',
              role: 'separator',
              'aria-orientation': 'horizontal',
              'aria-valuenow': Math.round(shownRatio * 100),
              'aria-valuemin': 25,
              'aria-valuemax': 75,
              'aria-label': `上下分区比例 ${Math.round(shownRatio * 100)}%（上窗 ${split.top}px / 下窗 ${split.bottom}px）。上下方向键以 2% 调整；双击或回车恢复默认`,
              title: '拖动调整上下比例（双击或回车恢复默认）',
              tabIndex: 0,
              onDoubleClick: () => commitRatio(SPLIT_DEFAULT),
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                  e.preventDefault()
                  commitRatio(splitKeyStep(shownRatio, e.key))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  commitRatio(SPLIT_DEFAULT)
                }
              },
              onMouseDown: (e: React.MouseEvent) => {
                e.preventDefault()
                dragStart.current = { ratio: shownRatio, y: e.clientY }
                const move = (ev: MouseEvent): void => {
                  const st = dragStart.current
                  if (st === null) return
                  // 拖拽中只挪线（不重绘图表）；松手才提交
                  setDragRatio(splitDragRatio(st.ratio, st.y, ev.clientY, avail > 0 ? avail : 520))
                }
                const up = (ev: MouseEvent): void => {
                  window.removeEventListener('mousemove', move)
                  window.removeEventListener('mouseup', up)
                  const st = dragStart.current
                  dragStart.current = null
                  if (st !== null) commitRatio(splitDragRatio(st.ratio, st.y, ev.clientY, avail > 0 ? avail : 520))
                }
                window.addEventListener('mousemove', move)
                window.addEventListener('mouseup', up)
              },
            }, React.createElement('span', { className: 'tw-split-line' }))
          : null,
        // 筹码分布：**与页签无关**（它是标的的属性）。可折叠、默认展开；只有标的/样本/口径原因才给说明
        React.createElement(ChipsPanel, {
          state: chipsState,
          redUp,
          fqSupported: fqSupportedOf(secid),
          // 筹码的重试是**它自己的**计数器（与图表 retry 无关 ⇒ 切页签/重试图表都不会连带刷新筹码）
          onRetry: () => setChipsRefresh((x) => x + 1),
          // 高度上限由分割线决定（不再写死 160px）；折叠状态上报给抽屉 ⇒ 折叠时不渲染分割线
          maxBottom: split.bottom,
          onOpenChange: setChipsOpen,
        }),
        note !== '' || legend !== ''
          ? React.createElement('div', { className: 'tw-chartnote' }, `${note}${legend}`)
          : null,
      ),
      React.createElement('div', { className: 'tw-drawer-foot' },
        React.createElement('span', { className: 'tw-muted' }, `${name} · ${secid}`),
        React.createElement('span', { style: { flex: 1 } }),
        React.createElement('span', { className: 'tw-muted' }, '延迟行情'),
      ),
    ),
  )
}
