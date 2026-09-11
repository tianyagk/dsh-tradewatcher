/**
 * dsh-tradewatcher — browser half. Registers the 「盯盘」 sidebar tab via the
 * `ctx.betterSidebar` service (provided by dsh-better-sidebar's client half)
 * and renders the full dashboard: three-strip TopBar with hover intraday
 * charts, inner tabs (自选 / 持仓 / 大盘 / 云图), all data served by the host
 * half over same-origin /tradewatcher/* routes.
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
import { ensureCss } from './styles.ts'

/** Structural face of ctx.betterSidebar (see dsh-better-sidebar service). */
interface SidebarTabDescriptor {
  id: string
  title: string | (() => string)
  icon?: React.ReactNode | ((size: number) => React.ReactNode)
  order?: number
  single?: boolean
  component: (props: TabProps) => React.ReactNode
}
interface BetterSidebarService {
  registerTab(d: SidebarTabDescriptor): () => void
}
interface TabProps {
  // ctx: unknown
  // store: unknown
  scope: { sessionId?: string; cwd?: string }
  tab: { id: string; type: string }
  visible: boolean
}

/** Plugin identity for the client module table. */
export const name = 'dsh-tradewatcher'

/** Services required before mounting. */
export const inject = ['betterSidebar']

export function apply(ctx: {
  betterSidebar: BetterSidebarService
  effect(fn: () => void | (() => void), label?: string): void
}): void {
  ensureCss()
  try {
    console.log('[dsh-tradewatcher] client v0.8.2 loaded (two-line rows + overflow menus + icon topbar)')
  } catch {
    /* console unavailable */
  }
  ctx.effect(
    () =>
      ctx.betterSidebar.registerTab({
        id: 'dsh-tradewatcher',
        title: () => '大盘概览',
        icon: (size: number): React.ReactNode =>
          React.createElement('span', { style: { fontSize: Math.round(size * 0.78), lineHeight: 1 } }, '📈'),
        order: 60,
        single: true,
        component: (props: TabProps): React.ReactNode => React.createElement(App, props),
      }),
    'dsh-tradewatcher: 盯盘 tab',
  )
}

type PageKey = 'watch' | 'portfolio' | 'market' | 'cloud'

function App(props: TabProps): React.ReactElement {
  const visible = props.visible
  const [page, setPage] = useState<PageKey>('watch')
  const [prefs, setPrefsState] = useState<PortPrefs | null>(null)
  const [watchIds, setWatchIds] = useState<string[]>([])
  const [posIds, setPosIds] = useState<string[]>([])

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
  const redUp = prefs?.redUp ?? true

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
      return React.createElement(WatchlistPage, { quotes, quotesReady: engine.ts !== null, prefs: { redUp }, onSymbols: onWatchSymbols })
    }
    if (page === 'portfolio') {
      return React.createElement(PortfolioPage, {
        active: visible,
        refreshSec,
        prefs: prefs ?? DEFAULT_PREFS,
        setPrefs,
        quotes,
        onSymbols: onPortSymbols,
      })
    }
    if (page === 'market') {
      return React.createElement(MarketPage, { quotes, prefs: prefs ?? DEFAULT_PREFS })
    }
    return React.createElement(CloudMap, null)
  }

  const tabs: Array<{ key: PageKey; label: string; full: string }> = [
    { key: 'watch', label: '自选', full: '自选关注（分组管理）' },
    { key: 'portfolio', label: '持仓', full: '持仓账本（分组/流水/盈亏）' },
    { key: 'market', label: '大盘', full: 'A股大盘行情' },
    { key: 'cloud', label: '云图', full: '大盘云图（52etf 热力图）' },
  ]

  return React.createElement(
    'div',
    { className: 'tw-root', 'data-theme': theme, style: { height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 } },
    React.createElement(TopBar, {
      quotes,
      ts: engine.ts,
      refreshing: engine.refreshing,
      onRefresh: engine.refresh,
      prefs: prefs ?? DEFAULT_PREFS,
      setPrefs,
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
  )
}
