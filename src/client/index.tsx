/**
 */
import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { DEFAULT_PREFS, TW_ROWS, VIEW_MODES, normalizePanelOpacity, type PortPrefs, type QuoteRow, type ViewMode } from '../shared/model.ts'
import { api } from './api.ts'
import { badgeView, type BadgeState } from './badgeView.ts'
import { useQuoteEngine } from './useQuotes.ts'
import { TopBar } from './TopBar.tsx'
import { WatchlistPage } from './WatchlistPage.tsx'
import { PortfolioPage } from './PortfolioPage.tsx'
import { MarketPage } from './MarketPage.tsx'
import { CloudMap } from './CloudMap.tsx'
import { CalendarPage } from './CalendarPage.tsx'
import { QuoteDrawer } from './QuoteDrawer.tsx'
import { ensureCss } from './styles.ts'
import { isMoneyMasked, setMoneyMask } from './format.ts'
import { Toast, useToast } from './ui.tsx'
import { BADGE_TONE_COLOR } from './theme.ts'

/** 侧栏图标与主面板共用的 id（`sidebar.panellist` 的 id == `main` 的 key）。 */
const PANEL_ID = 'tradewatcher'

/**
 * 侧栏徽标状态（P0-3）。
 *
 * 为什么放在模块级而不是 React state：图标组件（PanelIcon）与主面板（Dashboard）
 * 是**两条独立的注册链**，没有共同的 React 祖先可以传 props。模块级订阅是这两者
 * 之间唯一不引入新依赖的通道；而且这样"徽标数据"只有一份，天然满足
 * 「徽标数字与面板顶部数字同源」的要求。
 */
const badgeState: BadgeState = { text: '', tone: 'flat', detail: '' }
const badgeListeners = new Set<() => void>()

function setBadge(next: BadgeState): void {
  if (next.text === badgeState.text && next.tone === badgeState.tone && next.detail === badgeState.detail) return
  badgeState.text = next.text
  badgeState.tone = next.tone
  badgeState.detail = next.detail
  for (const fn of badgeListeners) fn()
}


/** 立即重取一次徽标（视图档位切换后必须马上反映，否则要等 60s 轮询） */
let badgeRefresh: (() => void) | null = null

/** 徽标轮询（60s）：侧栏常驻，必须比面板的行情轮询更省（只读汇总数） */
function startBadgePolling(): () => void {
  let alive = true
  const load = (): void => {
    api
      .badge()
      .then((b) => {
        if (alive) setBadge(badgeView(b, isMoneyMasked()))
      })
      .catch(() => undefined)
  }
  badgeRefresh = load
  load()
  const timer = window.setInterval(load, 60_000)
  return () => {
    alive = false
    badgeRefresh = null
    window.clearInterval(timer)
  }
}

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
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 60,
        // 展开态侧栏标题 / aria-label：图标放不下的完整语义（包括「已收盘」后缀）在这里
        label: () => (badgeState.detail === '' ? '盯盘' : `盯盘 · ${badgeState.detail}`),
      },
      PanelIcon,
    ),
  )
  // 徽标轮询跟随插件生命周期（disposer 由 effect 管理，卸载后不再请求）
  ctx.effect(() => startBadgePolling(), 'tradewatcher: sidebar badge')
  // 主面板：key 与侧栏 id 相同，shell 依据 activePanelId 决定渲染哪一个
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Dashboard))
}

/**
 * 侧栏图标：随主题着色的走势线 + 徽标（P0-3）。
 *
 * 不引 Harness 组件库（保持零依赖）；徽标数据走模块级订阅（见 badgeState 的说明），
 * 因为图标与主面板之间没有共同的 React 祖先。
 */
function PanelIcon(props: { size?: number; active?: boolean }): React.ReactElement {
  const size = props.size ?? 18
  const badge = useSyncExternalStore(
    (cb) => {
      badgeListeners.add(cb)
      return () => badgeListeners.delete(cb)
    },
    () => badgeState,
  )
  const tone = BADGE_TONE_COLOR[badge.tone]
  return React.createElement(
    'span',
    {
      style: { position: 'relative', display: 'inline-flex', width: size, height: size, alignItems: 'center', justifyContent: 'center' },
      title: badge.detail === '' ? '盯盘' : badge.detail,
    },
    React.createElement(
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
    ),
    badge.text === ''
      ? null
      : React.createElement('span', {
          'data-tone': badge.tone,
          style: {
            position: 'absolute',
            right: -7,
            bottom: -5,
            minWidth: 13,
            height: 11,
            padding: '0 2px',
            borderRadius: 6,
            background: tone,
            color: '#fff',
            fontSize: 8,
            lineHeight: '11px',
            fontFamily: 'var(--tw-mono)',
            fontWeight: 600,
            textAlign: 'center',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          },
        }, badge.text),
  )
}

/** 徽标底色：护盘用等级色系，盈亏用涨跌语义色（隐身视图下 tone 恒为 flat） */

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

  // 单实例 toast：视图档位、成本口径等"一次性动作的说明"共用（见 ui.tsx 的说明）
  const toast = useToast()

  const viewMode: ViewMode = prefs?.viewMode ?? 'full'
 // 金额遮罩做在格式化出口里，因此这一行就够全局生效（取数/告警/工具返回不受影响）
  useEffect(() => {
    setMoneyMask(viewMode === 'incognito')
    // 徽标字形随视图档位变化（隐身档只显示点位），必须立刻重取一次
    badgeRefresh?.()
  }, [viewMode])

  // Alt+M 轮换视图档位：不抢输入框（在输入控件里按 Alt+M 不该被吃掉）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      if (e.key.toLowerCase() !== 'm') return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName ?? ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable === true) return
      e.preventDefault()
      const cur = prefs?.viewMode ?? 'full'
      const next = VIEW_MODES[(VIEW_MODES.indexOf(cur) + 1) % VIEW_MODES.length]
      setPrefsState((prev) => ({ ...(prev ?? DEFAULT_PREFS), viewMode: next }))
      api.setPrefs({ viewMode: next }).catch(() => undefined)
      toast.show(
        next === 'full'
          ? '视图：完整（恢复说明文字与全部金额）'
          : next === 'compact'
            ? '视图：紧凑（已隐藏说明文字与脚注；Alt+M 继续切换）'
            : // 隐身的两项"细化"（不透明度/数字模糊）在「▣ 截图」里，这里提示一句，否则没人知道还有这一层
              '视图：隐身（金额已模糊为 ¥••••、涨跌色转灰阶）。若要连价格/百分比一起糊住，见行情条右侧「▣ 截图」里的数字模糊。Alt+M 继续切换',
      )
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // prefs?.viewMode 是读当前档位的唯一来源，必须进依赖
  }, [prefs?.viewMode, toast])

 // 面板不透明度与数字模糊。两者都只作用于本面板（见 styles.ts 的说明）
  const panelOpacity = normalizePanelOpacity(prefs?.panelOpacity, 1)
  const blurDigits = prefs?.blurDigits === true

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
      return React.createElement(WatchlistPage, {
        quotes,
        missing: engine.missing,
        quotesReady: engine.ts !== null,
        // 异动判定跟着行情刷新走（行情没更新就重判等于白跑一轮 K 线）
        quoteTs: engine.ts,
        prefs: prefs ?? DEFAULT_PREFS,
        setPrefs,
        onSymbols: onWatchSymbols,
        onOpenDetail: openDetail,
      })
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
        notify: toast.show,
      })
    }
    if (page === 'market') {
      return React.createElement(MarketPage, { quotes, prefs: prefs ?? DEFAULT_PREFS, onPrefs: (p) => setPrefsState(p) })
    }
    if (page === 'calendar') {
      return React.createElement(CalendarPage, { prefs: prefs ?? DEFAULT_PREFS })
    }
    // 云图页的自绘热力图跟随全局涨跌配色（此前写死红涨绿跌，与大盘页/列表相反）
    return React.createElement(CloudMap, { redUp: (prefs ?? DEFAULT_PREFS).redUp })
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
    {
      className: 'tw-root',
      'data-theme': theme,
      'data-view': viewMode,
      'data-blur': blurDigits ? '1' : '0',
      style: {
        flex: 1, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', minWidth: 0,
        // 不透明度只挂在本面板根节点：宿主其余界面不受影响
        opacity: panelOpacity,
      },
    },
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
    React.createElement(Toast, { text: toast.text, onClose: toast.clear }),
  )
}
