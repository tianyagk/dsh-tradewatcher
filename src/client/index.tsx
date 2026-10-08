/**
 * dsh-tradewatcher — browser half. Registers a global panel through the
 * Harness Slots service（`sidebar.panellist` 图标 + 同名 `main` 面板键）and
 * renders the full dashboard: three-strip TopBar with hover intraday charts,
 * inner tabs (自选 / 持仓 / 大盘 / 云图 / 日历), all data served by the host
 * half over same-origin /tradewatcher/* routes.
 *
 * 注意：面板只在「被选中」时挂载（shell 用 renderSlot('main', …, {entryKey}) 只渲染
 * 当前 key），所以挂载即等价于旧版的 visible —— 未选中时组件卸载，轮询自然停止。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { DEFAULT_PREFS, TW_ROWS, type PortPrefs, type QuoteRow } from '../shared/model.ts'
import { api } from './api.ts'
import { useQuoteEngine } from './useQuotes.ts'
import { TopBar } from './TopBar.tsx'
import { WatchlistPage } from './WatchlistPage.tsx'
import { PortfolioPage } from './PortfolioPage.tsx'
import { MarketPage } from './MarketPage.tsx'
import { CloudMap } from './CloudMap.tsx'
import { CalendarPage } from './CalendarPage.tsx'
import { QuoteDrawer } from './QuoteDrawer.tsx'
import { ensureCss } from './styles.ts'

/** 侧栏图标与主面板共用的 id（`sidebar.panellist` 的 id == `main` 的 key）。 */
const PANEL_ID = 'tradewatcher'

/** Structural face of the client `slots` service（见 dsh-client-ui-slots 的 SlotCore）。 */
interface SlotRegistration {
  name: string
  /** list 槽位用 id；keyed 槽位用 key。 */
  id?: string
  key?: string
  order?: number
  label?: string | (() => string)
}
interface SlotsService {
  inject(key: string, callback: () => () => void): () => void
  register(options: SlotRegistration, component: (props: any) => React.ReactNode): () => void
}
interface ClientContext {
  slots: SlotsService
  effect(fn: () => void | (() => void), label?: string): void
}

/** Plugin identity for the client module table（必须等于包名）。 */
export const name = 'dsh-tradewatcher'

/** Services required before mounting. */
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ensureCss()
  try {
    console.log(`[dsh-tradewatcher] client v${__TW_VERSION__} loaded (board fallbacks: Tencent industry/concept + Sina ETF + LKG)`)
  } catch {
    /* console unavailable */
  }
  // 侧栏入口：图标组件收到 shell 的 ownerProps { size, active }，label 供 aria-label 与展开态标题
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: () => '盯盘' },
      PanelIcon,
    ),
  )
  // 主面板：key 与侧栏 id 相同，shell 依据 activePanelId 决定渲染哪一个
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Dashboard))
}

/** 侧栏图标：随主题着色的走势线（不引 Harness 组件库，保持零依赖）。 */
function PanelIcon(props: { size?: number; active?: boolean }): React.ReactElement {
  const size = props.size ?? 18
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: props.active === true ? 1.9 : 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: false,
      style: { display: 'block' },
    },
    React.createElement('path', { key: 'line', d: 'M1.6 10.4 5.9 5.6l2.7 2.4 5.4-5' }),
    React.createElement('path', { key: 'tip', d: 'M10.6 3h4.2v4.2' }),
  )
}

type PageKey = 'watch' | 'portfolio' | 'market' | 'cloud' | 'calendar'

function Dashboard(): React.ReactElement {
  const visible = true
  const [page, setPage] = useState<PageKey>('watch')
  const [prefs, setPrefsState] = useState<PortPrefs | null>(null)
  const [watchIds, setWatchIds] = useState<string[]>([])
  const [posIds, setPosIds] = useState<string[]>([])
  /** 详情抽屉：顶栏行情卡片、自选行、持仓行都走这一个入口（单一实例） */
  const [detail, setDetail] = useState<{ secid: string; name: string } | null>(null)
  const openDetail = useCallback((secid: string, name: string): void => setDetail({ secid, name }), [])
  const closeDetail = useCallback((): void => setDetail(null), [])
  // 切页时关掉抽屉：它按 secid 取数，跨页留着容易看成"新页面的图"
  useEffect(() => {
    setDetail(null)
  }, [page])

  // prefs
  useEffect(() => {
    let alive = true
    api
      .prefs()
      .then((r) => {
        if (alive) setPrefsState(r.prefs)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const setPrefs = (patch: Partial<PortPrefs>): void => {
    setPrefsState((prev) => ({ ...(prev ?? DEFAULT_PREFS), ...patch }))
    api.setPrefs(patch).catch(() => undefined)
  }

  const refreshSec = prefs?.refreshSec ?? 10

  // theme
  const [systemDark, setSystemDark] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemDark(mq.matches)
    const on = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  const theme = prefs === null ? (systemDark ? 'dark' : 'light')
    : prefs.theme === 'auto' ? (systemDark ? 'dark' : 'light') : prefs.theme

  // shared quote engine: topbar always, page symbols when their page is open.
  const baseIds = useMemo(() => TW_ROWS.flatMap((r) => (r.items as ReadonlyArray<{ secid: string }>).map((i) => i.secid)), [])
  const extraIds = page === 'watch' ? watchIds : page === 'portfolio' ? posIds : []
  const engineIds = useMemo(() => {
    const set = new Set<string>(baseIds)
    for (const id of extraIds) set.add(id)
    return [...set]
  }, [baseIds, extraIds])
  const engine = useQuoteEngine(engineIds, refreshSec * 1000, visible)

  const onWatchSymbols = useCallback((ids: string[]) => setWatchIds(ids), [])
  const onPortSymbols = useCallback((ids: string[]) => setPosIds(ids), [])

  const quotes: Record<string, QuoteRow> = engine.quotes

  const pageEl = (): React.ReactNode => {
    if (page === 'watch') {
      return React.createElement(WatchlistPage, { quotes, missing: engine.missing, quotesReady: engine.ts !== null, prefs: prefs ?? DEFAULT_PREFS, setPrefs, onSymbols: onWatchSymbols, onOpenDetail: openDetail })
    }
    if (page === 'portfolio') {
      return React.createElement(PortfolioPage, {
        active: visible,
        refreshSec,
        prefs: prefs ?? DEFAULT_PREFS,
        setPrefs,
        quotes,
        missing: engine.missing,
        onSymbols: onPortSymbols,
        quoteTs: engine.ts,
        onOpenDetail: openDetail,
      })
    }
    if (page === 'market') {
      return React.createElement(MarketPage, { quotes, prefs: prefs ?? DEFAULT_PREFS, onPrefs: (p) => setPrefsState(p) })
    }
    if (page === 'calendar') {
      return React.createElement(CalendarPage, { prefs: prefs ?? DEFAULT_PREFS })
    }
    return React.createElement(CloudMap, null)
  }

  const tabs: Array<{ key: PageKey; label: string; full: string }> = [
    { key: 'watch', label: '自选', full: '自选关注（分组管理）' },
    { key: 'portfolio', label: '持仓', full: '持仓账本（分组/流水/盈亏）' },
    { key: 'market', label: '大盘', full: 'A股大盘行情' },
    { key: 'cloud', label: '云图', full: '大盘云图（52etf 热力图）' },
    { key: 'calendar', label: '日历', full: '财经日历（宏观/IPO/财报/分红）' },
  ]

  return React.createElement(
    'div',
    { className: 'tw-root', 'data-theme': theme, style: { flex: 1, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', minWidth: 0 } },
    React.createElement(TopBar, {
      quotes,
      missing: engine.missing,
      truncated: engine.truncated,
      asOf: engine.asOf,
      stale: engine.stale,
      staleCount: engine.staleCount,
      sources: engine.sources,
      refreshing: engine.refreshing,
      onRefresh: engine.refresh,
      prefs: prefs ?? DEFAULT_PREFS,
      setPrefs,
      onOpenDetail: openDetail,
      popupDisabled: detail !== null,
    }),
    engine.error !== null
      ? React.createElement('div', { className: 'tw-hint', style: { padding: '0 10px 2px' } }, `行情接口暂时不可用：${engine.error}`)
      : null,
    React.createElement('div', { className: 'tw-tabs' },
      tabs.map((t) =>
        React.createElement(
          'button',
          { key: t.key, className: 'tw-tab', title: t.full, 'data-on': page === t.key, onClick: () => setPage(t.key) },
          t.label,
        ),
      ),
    ),
    React.createElement('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }, pageEl()),
    detail !== null
      ? React.createElement(QuoteDrawer, {
          key: detail.secid,
          secid: detail.secid,
          name: detail.name,
          redUp: (prefs ?? DEFAULT_PREFS).redUp,
          onClose: closeDetail,
        })
      : null,
  )
}
