/**
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { shouldPollQuotes } from '../shared/pollGate.ts'
import { subscribeTicker } from './ticker.ts'
import { DEFAULT_PREFS, TW_ROWS, VIEW_MODES, normalizePanelOpacity, type PortPrefs, type QuoteRow, type ViewMode } from '../shared/model.ts'
import { api } from './api.ts'
import { badgeView, type BadgeState } from './badgeView.ts'
import { useQuoteEngine } from './useQuotes.ts'
import { usePageIdle, usePanelVisible } from './usePageIdle.ts'
import { pageExtraIds, quoteEngineIds } from './engineIds.ts'
import { TopBar } from './TopBar.tsx'
import { WatchlistPage } from './WatchlistPage.tsx'
import { PortfolioPage } from './PortfolioPage.tsx'
import { MarketPage } from './MarketPage.tsx'
import { CloudMap } from './CloudMap.tsx'
import { CalendarPage } from './CalendarPage.tsx'
import { ToolsPage } from './ToolsPage.tsx'
import { FupanPage } from './FupanPage.tsx'
import { PrismPage } from './PrismPage.tsx'
import { QuoteDrawer } from './QuoteDrawer.tsx'
import { tWindowPatchOf } from './tWindowView.ts'
import { ensureCss } from './styles.ts'
import { isMoneyMasked, setMoneyMask } from './format.ts'
import { Toast, useToast } from './ui.tsx'
import { badgeToneColor } from './theme.ts'
import { gateTabs } from './tabsGate.ts'
import { subscribeTradeJump } from './tradeJump.ts'

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

/**
 * 涨跌色义（`prefs.redUp`）的模块级通道 —— 与金额遮罩（`setMoneyMask`）同一模式。
 *
 * 为什么不能从 props 拿：`PanelIcon` 由宿主渲染在**主题容器之外**（见 `theme.ts` 文件头），
 * 与主面板之间没有共同的 React 祖先；面板读到 `prefs` 之后只能通过模块级状态把它送过来。
 * 存**布尔**而不是整个对象：`useSyncExternalStore` 的快照按 `Object.is` 比较，布尔值的变化
 * 一定能触发重渲染（存对象则要自己保证每次新建引用，踩过这个坑就会"改了色不生效"）。
 */
let badgeRedUp = true
const badgeRedUpListeners = new Set<() => void>()

function setBadgeRedUp(next: boolean): void {
  if (next === badgeRedUp) return
  badgeRedUp = next
  for (const fn of badgeRedUpListeners) fn()
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
  const timer = subscribeTicker(() => { if (!shouldPollQuotes(Date.now())) return; load() })
  return () => {
    alive = false
    badgeRefresh = null
    timer()
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
        /**
         * 展开态侧栏标题 / `aria-label`：**恒为「盯盘」**。
         *
         * ⚠ 用户 2026-10-16 明确要求：**不要后缀**（此前这里会拼成
         * `盯盘 · 数据 15:05:56 · 已收盘`，太长、也太吵）。
         * 数据时刻与「已收盘」没有丢，落点是：① 侧栏条目的**悬停 `title`**
         * （= `badgeState.detail`，见 `PanelIcon`）；② **面板内**本来就有
         * （页面级数据时刻、护盘面板收盘状态）。⇒ 这里**不许**再对它做字符串插值。
         */
        label: () => '盯盘',
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
 *
 * ⚠ 徽标内容**只有当日涨跌幅**（`badgeView` 的文件头写了为什么「护」被移除）：
 * 这个 18px 的位置不许再承载第二种语义。颜色跟随 `prefs.redUp`（见 `badgeToneColor`）。
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
  // 色义单独订阅（布尔快照）：`prefs.redUp` 变化后必须**立刻**换色，不能等下一次 60s 轮询
  const redUp = useSyncExternalStore(
    (cb) => {
      badgeRedUpListeners.add(cb)
      return () => badgeRedUpListeners.delete(cb)
    },
    () => badgeRedUp,
  )
  const tone = badgeToneColor(badge.tone, redUp)
  return React.createElement(
    'span',
    {
      style: { position: 'relative', display: 'inline-flex', width: size, height: size, alignItems: 'center', justifyContent: 'center' },
      /**
       * ⚠ 悬停 `title` 是**侧栏条目上唯一**的数据时刻/收盘状态出口（标签恒为「盯盘」，
       * 见 apply() 里 label 的说明）—— `detail` 里带着 `· 数据 HH:mm:ss[ · 已收盘]`，
       * **不要**把它挪回标签文本。
       */
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
            fontSize: 12,
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

/** 徽标底色在 `theme.ts` 的 `badgeToneColor`（按 `redUp` 取涨跌色；隐身视图下 tone 恒为 flat） */

type PageKey = 'watch' | 'portfolio' | 'market' | 'cloud' | 'calendar' | 'tools' | 'fupan' | 'prism'

/**
 * 保活页（P2-7）：切走不卸载。只放"无轮询、纯本地状态"的页 ——
 * 其余页涉及高频取数，必须先接 `active` 门控（下一批），否则会变成"多页同时轮询"。
 *
 * `fupan`（复盘）加入的判据与日历同款：它**零轮询** —— 只在挂载 / 换月 / 写成功后取一次，
 * 所以保活的收益（月份、选中的日期、正在写的草稿都不丢）明显大于风险。
 */
const KEEP_ALIVE: readonly PageKey[] = ['calendar', 'tools', 'fupan', 'prism']

function Dashboard(): React.ReactElement {
  /**
   * 面板**真实可见性**（P2-4）。
   *
   * 旧实现是 `const visible = true`（常量）⇒ `useQuoteEngine(..., enabled=true)` 与
   * `usePageIdle(true)` 都形同虚设：宿主把面板藏起来（display:none）时行情照打（每 10s）。
   * 现在由 `usePanelVisible(rootRef)` 给出：文档隐藏 **或** 本轮布局与视口不相交 ⇒ 不可见。
   * 取得不到信号时**失败放行**（`panelVisibleOf` 的 `intersecting === null`）——宁可按可见处理，
   * 也不要把数据停了。
   */
  const rootRef = useRef<HTMLDivElement | null>(null)
  const visible = usePanelVisible(rootRef)
  const [page, setPage] = useState<PageKey>('watch')
  /** 页签切换的**唯一入口**（v0.81.0 起只做 setPage：工具箱的页级返回按钮已按用户要求删除） */
  const goPage = useCallback((next: PageKey): void => {
    setPage(next)
  }, [])
  /**
   * 复盘页点某笔 ⇒ 切到持仓页的「交易流水」（用户口径：状态只在**内存**，不改 URL、不写偏好）。
   *
   * 分工：`FupanPage` 只发请求（`requestTradeJump`），这里只切页，`PortfolioPage` 挂载时
   * 自己把高亮目标取走 —— 谁也不需要知道对方的内部状态。
   */
  useEffect(() => subscribeTradeJump(() => goPage('portfolio')), [goPage])
  /** 活跃行（null = 端点不可达 ⇒ 失败放行）。core 行永远在，所以老 profile 里是 {'core'}。 */
  const [rowsEnabled, setRowsEnabled] = useState<Set<string> | null>(null)
  const [prefs, setPrefsState] = useState<PortPrefs | null>(null)
  const [watchIds, setWatchIds] = useState<string[]>([])
  const [posIds, setPosIds] = useState<string[]>([])
  /** 详情抽屉：行情条行情卡片、自选行、持仓行都走这一个入口（单一实例） */
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

  /**
   * 偏好写入的**唯一实现**（乐观更新 + 失败回滚 + 报原因），返回"是否真的落盘"。
   *
   * 此前是 `.catch(() => undefined)` —— 保存失败时本地看着一切正常、刷新后全丢，
   * 全程无提示（宿主白名单漏 `stripCfg` 就是这么被掩盖了整轮）。现在失败要①回滚②说一声。
   * 回滚基准取自**本次渲染闭包里的 `prefs`**（失败路径够用；连续多次写入后同时失败可能回滚到偏旧值，
   * 这是有意的取舍：宁可回到一个确定存在的旧配置，也不要留一个"看起来生效其实没落盘"的状态）。
   *
   * 返回 `true/false` 是为了让**有后续提示**的调用方（如 `cycleViewMode` 的"已切换"toast）
   * 在失败时**不要再盖掉失败原因**（toast 是单实例的，见 `ui.tsx` 的说明）。
   */
  // 单实例 toast：视图档位、成本口径等"一次性动作的说明"共用（见 ui.tsx 的说明）
  const toast = useToast()
  const applyPrefs = useCallback((patch: Partial<PortPrefs>): Promise<boolean> => {
    const before = prefs ?? DEFAULT_PREFS
    setPrefsState((prev) => ({ ...(prev ?? DEFAULT_PREFS), ...patch }))
    return api.setPrefs(patch).then(() => true, (err: unknown) => {
      setPrefsState(before)
      toast.show(`偏好保存失败（已回滚本次修改）：${String(err).slice(0, 60)}`)
      return false
    })
  }, [prefs, toast])
  const setPrefs = (patch: Partial<PortPrefs>): void => { void applyPrefs(patch) }

  const viewMode: ViewMode = prefs?.viewMode ?? 'full'
 // 金额遮罩做在格式化出口里，因此这一行就够全局生效（取数/告警/工具返回不受影响）
  useEffect(() => {
    setMoneyMask(viewMode === 'incognito')
    // 徽标字形随视图档位变化（隐身档只显示点位），必须立刻重取一次
    badgeRefresh?.()
  }, [viewMode])

  // 徽标色义跟随 `prefs.redUp`：面板是唯一读得到偏好的地方，徽标渲染在主题容器之外（见 setBadgeRedUp）
  const redUp = (prefs ?? DEFAULT_PREFS).redUp
  useEffect(() => {
    setBadgeRedUp(redUp !== false)
  }, [redUp])

  // Alt+M 轮换视图档位：不抢输入框（在输入控件里按 Alt+M 不该被吃掉）
  /**
   * 切换视图模式（**唯一实现**）：快捷键 `Alt+M` 与行情条上那个**可见**按钮共用它。
   * v0.91.1 之前只有快捷键 ⇒ 一级功能（隐身视图）的唯一入口是隐藏快捷键，用户找不到。
   */
  const cycleViewMode = useCallback((): void => {
    const cur = prefs?.viewMode ?? 'full'
    const next = VIEW_MODES[(VIEW_MODES.indexOf(cur) + 1) % VIEW_MODES.length]
    // 走**同一个** applyPrefs（乐观更新 + 失败回滚 + 报原因）；此前这里是
    // `api.setPrefs(...).catch(() => undefined)` —— 视图档位保存失败永远静默，
    // 与 `setPrefs` 上方注释里"静默吞错掩盖了整轮 bug"的教训自相矛盾（P2-5）。
    void applyPrefs({ viewMode: next }).then((ok) => {
      // 失败时 applyPrefs 已经报过原因；**不要再**报"已切换"把原因盖掉（toast 单实例）
      if (!ok) return
      toast.show(
          next === 'full'
            ? '视图：完整（恢复说明文字与全部金额）'
            : next === 'compact'
              ? '视图：紧凑（已隐藏说明文字与脚注；Alt+M 继续切换）'
              : // 隐身的两项"细化"（不透明度/数字模糊）在「▣ 截图」里，这里提示一句，否则没人知道还有这一层
                '视图：隐身（金额已模糊为 ¥••••、涨跌色转灰阶）。若要连价格/百分比一起糊住，见行情条右侧「▣ 截图」里的数字模糊。Alt+M 继续切换',
      )
    })
  }, [prefs?.viewMode, toast, applyPrefs])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      if (e.key.toLowerCase() !== 'm') return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName ?? ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable === true) return
      e.preventDefault()
      cycleViewMode()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cycleViewMode])

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
  //
  // 请求集合 = **会被渲染的卡片**（隐藏的卡不再每拍请求，见 engineIds.ts）+ **当前页面需要的标的**
  // （自选/持仓页的行、大盘页直接读的指数）。此前 baseIds 取的是 TW_ROWS **全量** ——
  // 用户已隐藏的标的（实测 1.000012）仍在每一拍被请求，而结果永远不会被渲染。
  const hiddenCards = prefs?.stripCfg?.hidden
  const hiddenKey = Array.isArray(hiddenCards) ? hiddenCards.join(',') : ''
  const extraIds = useMemo(
    () => pageExtraIds({ page, watchIds, posIds }),
    [page, watchIds, posIds],
  )
  const engineIds = useMemo(
    () => quoteEngineIds(TW_ROWS, hiddenCards, extraIds),
    // hiddenCards 用 join 出来的字符串当依赖：同一份配置不必因为数组 identity 变化而重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hiddenKey, extraIds],
  )
  const engine = useQuoteEngine(engineIds, refreshSec * 1000, visible)
  // 页面切后台 / 面板不可见 ⇒ data-idle=true：CSS 一条规则暂停全部动画（不动数据、不触发取数）
  const idle = usePageIdle(visible)

  const onWatchSymbols = useCallback((ids: string[]) => setWatchIds(ids), [])
  const onPortSymbols = useCallback((ids: string[]) => setPosIds(ids), [])

  const quotes: Record<string, QuoteRow> = engine.quotes

  const pageEl = (): React.ReactNode => {
    if (page === 'watch') {
      return React.createElement(WatchlistPage, {
        active: visible,
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
      // quoteTs：大盘页的 breadth/extras 用它当节拍信号（不再挂 quotes 的对象身份，见 pacing.ts）
      return React.createElement(MarketPage, { quotes, quoteTs: engine.ts, prefs: prefs ?? DEFAULT_PREFS, onPrefs: (p) => setPrefsState(p) })
    }
    if (KEEP_ALIVE.includes(page)) return null // 由保活容器渲染（见 keepAliveEl）
    // 云图页仍要 redUp：只用来判断第三方站点的色义是否与本插件**相反**（相反才出那个徽标）
    return React.createElement(CloudMap, { redUp: (prefs ?? DEFAULT_PREFS).redUp })
  }
  /**
   * 保活页（P2-7）：切走**不卸载**，用 `display:none` 切显隐（与"关闭即 display:none"的既有约定一致，不动画）。
   *
   * 先只保活 `calendar` + `tools`：这两页**没有轮询**（日历只在挂载/换月/点同步时取数，工具目录是本地状态），
   * 收益立刻可见（月份、工具详情页 id、滚动位置都保住），风险最低。其余四页涉及高频取数，
   * 需要先接 `active` 门控才安全，留待下一批（见报告未做项）。
   */
  const keepAliveEl = (key: PageKey): React.ReactNode => {
    if (key === 'calendar') return React.createElement(CalendarPage, { prefs: prefs ?? DEFAULT_PREFS })
    // 复盘：月历 + 当日笔记（第 7 个页签；零轮询，与日历同款保活）
    if (key === 'fupan') return React.createElement(FupanPage)
    // 棱镜（第 9 行 / 第 8 页签）：只在打开时取状态（active 门控，不轮询）
    if (key === 'prism') return React.createElement(PrismPage, { active: page === 'prism' })
    // 工具箱：目录页 + 工具详情页都在 ToolsPage 里（v0.81.0 起它不接 props）
    return React.createElement(ToolsPage)
  }

  // 每个 tab 归属**一行**（`GET /tradewatcher/rows` 的 gate 依据）：行被停用 ⇒ tab 直接不渲染。
  // `rowsEnabled === null` = 端点不可达 ⇒ **失败放行**（全部照常渲染，别让抖动把界面整块弄没）。
  const tabs: Array<{ key: PageKey; label: string; full: string; row: string }> = [
    { key: 'watch', label: '自选', full: '自选关注（分组管理）', row: 'watchlist' },
    { key: 'portfolio', label: '持仓', full: '持仓账本（分组/流水/盈亏）', row: 'portfolio' },
    { key: 'market', label: '大盘', full: 'A股大盘行情', row: 'market' },
    { key: 'cloud', label: '云图', full: '大盘云图（52etf 热力图）', row: 'cloudmap' },
    { key: 'calendar', label: '日历', full: '财经日历（宏观/IPO/财报/分红）', row: 'calendar' },
    // 工具箱（第 7 行）：工具目录 + 工具详情；行被停用 ⇒ 这个页签不渲染（门控与其余页签同一套）
    { key: 'tools', label: '工具', full: '工具箱（工具目录与工具详情）', row: 'tools' },
    // 复盘（第 8 行，第 7 个页签）：月历 + 当日笔记。行被停用 ⇒ 按既有门控隐藏；
    // 行在启用但路由取不到（宿主尚未落地/宿主报错）⇒ 页面本身给「原因 + 重试」，不空白。
    { key: 'fupan', label: '复盘', full: '复盘（月历 + 当日笔记）', row: 'fupan' },
    // 棱镜（第 9 行，第 8 个页签）：最右；行被停用 ⇒ 页签不渲染（与其余页签同一套门控）
    { key: 'prism', label: '棱镜', full: '棱镜（研判时点 + 金十快讯 + 4+1 研判）', row: 'prism' },
  ]
  useEffect(() => {
    let alive = true
    void api
      .rows()
      .then((r) => {
        if (alive) setRowsEnabled(new Set(r.rows))
      })
      .catch(() => {
        // 端点不可达/解析失败 ⇒ **失败放行**：保持 null，全部 tab 照常渲染（照抄参考实现的做法）
      })
    return () => {
      alive = false
    }
  }, [])

  // 门控逻辑是纯函数（`tabsGate.ts`，有断言）：缺失/失败放行、回落、整条隐藏都在那边定义一次
  const tabGate = gateTabs(tabs, rowsEnabled, page)
  const visibleTabs = tabGate.visible
  useEffect(() => {
    if (tabGate.fallback !== null) goPage(tabGate.fallback)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabGate.fallback])

  return React.createElement(
    'div',
    {
      ref: rootRef,
      className: 'tw-root',
      'data-theme': theme,
      'data-view': viewMode,
      'data-blur': blurDigits ? '1' : '0',
      'data-idle': idle ? 'true' : 'false',
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
      viewMode,
      onCycleViewMode: cycleViewMode,
    }),
    engine.error !== null
      ? React.createElement('div', { className: 'tw-hint', style: { padding: '0 10px 2px' } }, `行情接口暂时不可用：${engine.error}`)
      : null,
    // tab 全被关掉时**不渲染整个 tab 条**（不留空壳）
    visibleTabs.length === 0
      ? null
      : React.createElement('div', { className: 'tw-tabs' },
      visibleTabs.map((t) =>
        React.createElement(
          'button',
          { key: t.key, className: 'tw-tab', title: t.full, 'data-on': page === t.key, onClick: () => goPage(t.key) },
          t.label,
        ),
      ),
    ),
    React.createElement('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
      pageEl(),
      // 保活页（P2-7）：始终挂载、只切显隐；不渲染动画（display 切换不是动画）。
      // ⚠ 只挂"当前行被启用"的页：行被停用（tabsGate 隐藏）时不许因为保活又把它取数跑起来。
      ...KEEP_ALIVE.filter((key) => visibleTabs.some((t) => t.key === key)).map((key) => React.createElement(
        'div',
        {
          key,
          'data-keepalive': key,
          style: page === key
            ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }
            : { display: 'none' },
        },
        keepAliveEl(key),
      )),
    ),
    detail !== null
      ? React.createElement(QuoteDrawer, {
          key: detail.secid,
          secid: detail.secid,
          name: detail.name,
          redUp: (prefs ?? DEFAULT_PREFS).redUp,
          // 实时价那一行的来源（口径行要把"报价源"与"分钟源"分开写，见 chartNote.trendLagNote）
          quoteSource: engine.quotes[detail.secid]?.source ?? null,
          // 做T窗口：开关按标的记忆（prefs.tWindow），行情节拍变一次就重算一次网格
          tWindowOn: (prefs ?? DEFAULT_PREFS).tWindow?.[detail.secid.toUpperCase()] === true,
          onTWindowChange: (on: boolean) => setPrefs({ tWindow: tWindowPatchOf(prefs ?? DEFAULT_PREFS, detail.secid, on) }),
          quoteTs: engine.ts,
          // 上下分区比例：读写都走 prefs（老 profile 缺键 ⇒ 抽屉内用默认值）
          splitRatio: (prefs ?? DEFAULT_PREFS).splitRatio,
          onSplitRatio: (ratio: number) => setPrefs({ splitRatio: ratio }),
          onClose: closeDetail,
        })
      : null,
    React.createElement(Toast, { text: toast.text, onClose: toast.clear }),
  )
}
