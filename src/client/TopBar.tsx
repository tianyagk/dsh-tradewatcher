/** The three-strip TopBar with hover intraday/daily popups.
 *  The popup tracks the mouse cursor (flip/clamp vs viewport) and is measured
 *  after each content change so it never runs off screen. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { TW_ROWS, type QuoteRow, type TrendData, type KlineData } from '../shared/model.ts'
import { api } from './api.ts'
import { fmtClock, fmtPct, fmtPrice, fmtSigned, dirClass } from './format.ts'
import { Sparkline } from './charts.tsx'
import type { PortPrefs } from '../shared/model.ts'

interface HoverState {
  secid: string
  name: string
}

type PopKind = 'loading' | 'trend' | 'kline' | 'none' | 'error'

function HoverCard(props: {
  hover: HoverState
  quote: QuoteRow | undefined
  prefs: PortPrefs
  popRef: { current: HTMLDivElement | null }
  onSized: () => void
}): React.ReactElement {
  const { hover, quote, prefs, popRef, onSized } = props
  const [kind, setKind] = useState<PopKind>('loading')
  const [data, setData] = useState<TrendData | KlineData | null>(null)
  const req = useRef(0)

  useEffect(() => {
    const n = ++req.current
    setKind('loading')
    setData(null)
    api
      .trend(hover.secid)
      .then(async ({ trend }) => {
        if (n !== req.current) return
        if (trend !== null) {
          setKind('trend')
          setData(trend)
          return
        }
        const { kline } = await api.kline(hover.secid)
        if (n !== req.current) return
        if (kline !== null) {
          setKind('kline')
          setData(kline)
        } else {
          setKind('none')
        }
      })
      .catch(() => {
        if (n === req.current) setKind('error')
      })
    return () => {
      req.current += 1
    }
  }, [hover.secid])

  // 内容（加载→图表）尺寸变化后重新夹紧位置，避免溢出屏幕
  useEffect(() => {
    onSized()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, data])

  const upColor = prefs.redUp ? 'var(--tw-up)' : 'var(--tw-down)'
  const downColor = prefs.redUp ? 'var(--tw-down)' : 'var(--tw-up)'
  const price = quote?.price ?? null
  const dir = dirClass(quote?.chg ?? null, prefs.redUp)

  // points for SVG
  let sparkPoints: Array<{ t: number; value: number; label?: string }> = []
  let baseline: number | null = null
  let sub = ''
  if (kind === 'trend' && data !== null) {
    const t = data as TrendData
    baseline = t.prePrice
    sparkPoints = t.points.map((p) => ({ t: p.t, value: p.price, label: p.label.slice(11) }))
    const last = t.points[t.points.length - 1]
    sub = last !== undefined ? `${last.label.slice(5, 16)} 收盘` : ''
  } else if (kind === 'kline' && data !== null) {
    const k = data as KlineData
    const days = k.days
    if (days.length > 0) {
      const t0 = Date.parse(`${days[0].date}T00:00:00`)
      const step = days.length > 1 ? (Date.parse(`${days[1].date}T00:00:00`) - t0) : 86400000
      baseline = days.length > 1 ? days[days.length - 2].close : days[0].open
      sparkPoints = days.map((d, i) => ({
        t: t0 + step * i,
        value: d.close,
        label: d.date.slice(5).replace('-', '/'),
      }))
    }
    sub = '近5日收盘'
  }

  const lastUp = sparkPoints.length > 1
    ? (sparkPoints[sparkPoints.length - 1].value >= (baseline ?? sparkPoints[0].value))
    : null

  return React.createElement(
    'div',
    { ref: popRef, className: 'tw-pop', style: { left: 0, top: 0, visibility: 'hidden' } },
    React.createElement('div', { className: 'ph' },
      React.createElement('span', { className: 'nm' }, hover.name),
      React.createElement('span', { className: 'px ' + dir }, fmtPrice(price)),
      React.createElement('span', { className: 'tag ' + dir },
        `${fmtSigned(quote?.chg ?? null)}  ${fmtPct(quote?.pct ?? null)}`,
      ),
    ),
    kind === 'loading'
      ? React.createElement('div', { className: 'tw-loading', style: { height: 150 } }, '加载分时…')
      : kind === 'error'
        ? React.createElement('div', { className: 'tw-error', style: { height: 150 } }, '走势获取失败')
        : kind === 'none'
          ? React.createElement('div', { className: 'tw-loading', style: { height: 150 } }, '暂无当日走势数据')
          : React.createElement(Sparkline, {
              points: sparkPoints,
              baseline,
              width: 306,
              height: 150,
              up: lastUp !== false,
              upColor,
              downColor,
              timeLabels: true,
            }),
    React.createElement('div', { className: 'pl' },
      kind === 'trend' || kind === 'kline' ? React.createElement('span', null, sub) : null,
      quote?.time !== null && quote?.time !== undefined && quote.time > 0
        ? React.createElement('span', null, `行情 ${fmtClock(quote.time)}`)
        : null,
      quote?.amount !== null && quote?.amount !== undefined && quote.amount > 0
        ? React.createElement('span', null, `成交 ${(quote.amount / 1e8).toFixed(0)}亿`)
        : null,
    ),
  )
}

export function TopBar(props: {
  quotes: Record<string, QuoteRow>
  ts: number | null
  refreshing: boolean
  onRefresh: () => void
  prefs: PortPrefs
  setPrefs: (p: Partial<PortPrefs>) => void
}): React.ReactElement {
  const { quotes, ts, refreshing, onRefresh, prefs, setPrefs } = props
  const [hover, setHover] = useState<HoverState | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const cursor = useRef({ x: 0, y: 0 })

  /**
   * 定位悬浮卡：以 TopBar 为定位上下文（absolute），跟随鼠标，必要时左右/
   * 上下翻转，并夹紧到"真实裁剪区"——视口与所有 overflow 祖先矩形的交集。
   * 这样无论面板是否带 transform（会把 position:fixed 的包含块改成面板，
   * 导致视口坐标失效）都能正确显示，不会被右缘裁掉。
   */
  const applyPos = useCallback((): void => {
    const el = popRef.current
    const host = hostRef.current
    if (el === null || host === null) return
    const hr = host.getBoundingClientRect()
    const W = 330
    const H = Math.max(el.offsetHeight, 240)
    // 裁剪区 = 视口 ∩ 所有 overflow 祖先
    let cl = 0
    let ct = 0
    let cr = window.innerWidth
    let cb = window.innerHeight
    for (let n: HTMLElement | null = host.parentElement; n !== null; n = n.parentElement) {
      const st = window.getComputedStyle(n)
      const ov = `${st.overflow}${st.overflowX}${st.overflowY}`
      if (/(auto|scroll|hidden|clip)/.test(ov)) {
        const r = n.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          cl = Math.max(cl, r.left)
          ct = Math.max(ct, r.top)
          cr = Math.min(cr, r.right)
          cb = Math.min(cb, r.bottom)
        }
      }
    }
    const x = cursor.current.x
    const y = cursor.current.y
    let left = x + 14
    if (left + W + 8 > cr) left = x - W - 12
    left = Math.min(Math.max(cl + 8, left), Math.max(cl + 8, cr - W - 8))
    let top = y + 18
    if (top + H + 8 > cb) top = y - H - 12
    top = Math.min(Math.max(ct + 8, top), Math.max(ct + 8, cb - H - 8))
    el.style.left = `${left - hr.left}px`
    el.style.top = `${top - hr.top}px`
    el.style.visibility = 'visible'
  }, [])

  // 内容尺寸变化（加载→图表）后重新夹紧
  useEffect(() => {
    if (hover === null) return
    const el = popRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => applyPos())
    ro.observe(el)
    return () => ro.disconnect()
  }, [hover, applyPos])

  // 打开延迟 120ms / 关闭宽限 100ms：鼠标扫过时不闪烁
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const pending = useRef<HoverState | null>(null)
  const clearOpen = (): void => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }
  const clearClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  const hide = useCallback((): void => {
    clearOpen()
    clearClose()
    setHover(null)
  }, [])

  const scheduleOpen = (secid: string, name: string): void => {
    pending.current = { secid, name }
    if (hover !== null && hover.secid === secid) return
    if (openTimer.current !== null) return
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      const p = pending.current
      if (p !== null) setHover(p)
    }, 120)
  }

  const scheduleClose = (): void => {
    clearOpen()
    if (closeTimer.current !== null) return
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setHover(null)
    }, 100)
  }

  const enterCard = (e: React.MouseEvent, secid: string, name: string): void => {
    cursor.current = { x: e.clientX, y: e.clientY }
    clearClose()
    scheduleOpen(secid, name)
  }

  const moveCard = (e: React.MouseEvent, secid: string, name: string): void => {
    cursor.current = { x: e.clientX, y: e.clientY }
    clearClose()
    if (hover !== null && hover.secid === secid) applyPos()
    else scheduleOpen(secid, name)
  }

  const focusCard = (e: React.FocusEvent, secid: string, name: string): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    cursor.current = { x: r.left + r.width / 2, y: r.bottom }
    clearOpen()
    clearClose()
    setHover({ secid, name })
  }

  useEffect(() => {
    window.addEventListener('resize', hide)
    document.addEventListener('scroll', hide, true)
    return () => {
      window.removeEventListener('resize', hide)
      document.removeEventListener('scroll', hide, true)
      clearOpen()
      clearClose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hide])

  // 打开后等 DOM 就绪再定位
  useEffect(() => {
    if (hover === null) return
    const raf = requestAnimationFrame(applyPos)
    return () => cancelAnimationFrame(raf)
  }, [hover, applyPos])

  const themeBtn = (): void => {
    const next = prefs.theme === 'auto' ? 'light' : prefs.theme === 'light' ? 'dark' : 'auto'
    setPrefs({ theme: next as PortPrefs['theme'] })
  }

  return React.createElement(
    'div',
    { ref: hostRef, className: 'tw-topbar' },
    React.createElement('div', { className: 'tw-topmeta' },
      React.createElement('span', { className: 'tw-title', title: 'dsh-tradewatcher v0.10.0' }, '实时行情'),
      React.createElement('span', { className: 'tw-uptime' },
        ts !== null ? `更新 ${fmtClock(ts)} · 每 ${prefs.refreshSec}s` : '加载中…',
      ),
      React.createElement('button', {
        className: 'tw-iconbtn',
        onClick: themeBtn,
        title: `主题：${prefs.theme === 'auto' ? '自动' : prefs.theme === 'light' ? '浅色' : '深色'}（点击切换）`,
        'aria-label': '切换主题',
      }, prefs.theme === 'auto' ? '◐' : prefs.theme === 'light' ? '☀' : '☾'),
      React.createElement('button', {
        className: 'tw-iconbtn',
        onClick: onRefresh,
        disabled: refreshing,
        title: refreshing ? '刷新中…' : '手动刷新行情',
        'aria-label': '刷新行情',
      }, '⟳'),
    ),
    TW_ROWS.map((row) =>
      React.createElement(
        'div',
        { key: row.key, className: 'tw-strip' },
        React.createElement('div', { className: 'tw-strip-label' }, row.label),
        React.createElement(
          'div',
          { className: 'tw-strip-cards', onMouseLeave: scheduleClose },
          (row.items as ReadonlyArray<{ secid: string; name: string }>).map((it) => {
            const q = quotes[it.secid]
            const price = q?.price ?? null
            const cls = dirClass(q?.chg ?? null, prefs.redUp)
            const pctText = q?.pct ?? null
            return React.createElement(
              'div',
              {
                key: it.secid,
                className: 'tw-qcard',
                tabIndex: 0,
                role: 'button',
                'aria-label': `${it.name} 分时走势`,
                onMouseEnter: (e: React.MouseEvent) => enterCard(e, it.secid, it.name),
                onMouseMove: (e: React.MouseEvent) => moveCard(e, it.secid, it.name),
                onFocus: (e: React.FocusEvent) => focusCard(e, it.secid, it.name),
                onBlur: scheduleClose,
              },
              React.createElement('div', { className: 'nm' }, it.name),
              React.createElement('div', { className: 'px ' + (price === null ? 'tw-flat' : cls) }, fmtPrice(price)),
              React.createElement('div', { className: 'chg' },
                React.createElement('span', { className: 'chg ' + (q?.chg === null ? 'tw-flat' : cls) }, fmtSigned(q?.chg ?? null)),
                React.createElement('span', { className: `tw-chg-chip ${pctText === null ? 'tw-chip-flat' : pctText >= 0 ? (prefs.redUp ? 'tw-chip-up' : 'tw-chip-down') : (prefs.redUp ? 'tw-chip-down' : 'tw-chip-up')}` },
                  fmtPct(pctText),
                ),
              ),
            )
          }),
        ),
      ),
    ),
    hover !== null
      ? React.createElement(HoverCard, { hover, quote: quotes[hover.secid], prefs, popRef, onSized: applyPos })
      : null,
  )
}
