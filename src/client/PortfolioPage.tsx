/** 持仓 page: ledger-driven portfolio groups + group/position trade history. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CorporateAction,
  LedgerEntry,
  LedgerView,
  MutatePortBody,
  PortfolioView,
  PortPrefs,
  PositionRow,
  QuoteRow,
  SuggestItem,
  YtdRow,
} from '../shared/model.ts'
import { LEDGER_VERB_LABEL, DEFAULT_PREFS, realizedUnknownNote, realizedUnknownQtyOf, realizedUnknownRows, realizedUnknownShort } from '../shared/model.ts'
import { availableLockNote, feeShareNote, ytdBaseNote } from './portfolioMeta.ts'
import { api } from './api.ts'
import { fmtStamp, dirClass, fmtAmt, fmtMoneySigned, fmtPct, fmtPrice, fmtRaw } from './format.ts'
import { Btn, EmptyHint, ErrorNote, Field, Modal, MoreMenu, Skeleton, SuggestInput } from './ui.tsx'
import { MiniTrend } from './charts.tsx'
import { useMiniTrends, type MiniData } from './mini.ts'
import { NO_SOURCE_TITLE, NO_SOURCE_LABEL, PENDING_LABEL } from './quoteState.ts'
import { SortBar } from './SortBar.tsx'
import { SortHeader } from './SortHeader.tsx'
import { PORT_COLUMNS, PORT_SORT_HINT, PORT_SORT_KEYS, PORT_SORT_LABEL, normalizeSortState, sortPositions, weightOf, type PortSortKey } from './sort.ts'
import { useYtd } from './useYtd.ts'
import { useSortEntry, useWideLayout } from './useWide.ts'
import { ytdText, ytdTooltip } from './ytdView.ts'
import { isUsableBaseline } from './trendView.ts'

// 与宿主共用一份（shared/model.ts）——此前两边各写一份逐字相同的映射
const VERB_LABEL: Record<LedgerEntry['verb'], string> = LEDGER_VERB_LABEL

function verbLabel(verb: LedgerView['verb']): string {
  return VERB_LABEL[verb] ?? verb
}

export function PortfolioPage(props: {
  active: boolean
  refreshSec: number
  prefs: PortPrefs
  setPrefs: (patch: Partial<PortPrefs>) => void
  quotes: Record<string, QuoteRow>
  /** 没有任何源给出价格的标的（大写键） */
  missing?: Set<string>
  /** 共享行情引擎最近一次成功更新的时间戳（单一取数源用） */
  quoteTs?: number | null
  onSymbols: (ids: string[]) => void
  /** 打开详情抽屉（由 App 统一渲染，见 index.tsx） */
  onOpenDetail?: (secid: string, name: string) => void
  /** 一次性动作的说明（P0-6 成本口径切换等），由 App 的单实例 toast 承载 */
  notify?: (text: string) => void
}): React.ReactElement {
  const { active, refreshSec, prefs, setPrefs, quotes, missing, onSymbols, onOpenDetail } = props
  const redUp = prefs.redUp
  // 同自选页：宿主未重启时旧 /prefs 没有 portSort，回退默认避免整页崩
  const portSort = normalizeSortState(prefs.portSort, PORT_SORT_KEYS, DEFAULT_PREFS.portSort)
  const basis = prefs.costBasis
  const diluted = basis === 'diluted'

  /**
   * 成本口径切换（P0-6）。
   *
   * 摊薄/均价两口径并存，切换会让标题上的总盈亏整体跳一下 —— 不解释就只是"数字变了"。
   * 这里报出**差值**，且差值来自同一份 view（两口径共用同一套成本函数，只换参数），
   * 因此"切换后总额变化 == 逐项差值之和"是可复算的（见 selftest 的断言）。
   */
  const switchBasis = (next: 'diluted' | 'average'): void => {
    if (next === basis) return
    const g = view?.grand
    if (g === undefined) {
      setPrefs({ costBasis: next })
      return
    }
    const toName = next === 'diluted' ? '摊薄成本' : '买入均价'
    const fromName = next === 'diluted' ? '买入均价' : '摊薄成本'
    const fromVal = next === 'diluted' ? g.floatPnl : g.dilutedPnl
    const toVal = next === 'diluted' ? g.dilutedPnl : g.floatPnl
    const diff = toVal - fromVal
    const rows = view?.positions.length ?? 0
    props.notify?.(
      `口径切换：${fromName} → ${toName}。持仓总盈亏 ${fmtMoneySigned(fromVal)} → ${fmtMoneySigned(toVal)}` +
      `（差 ${diff >= 0 ? '+' : ''}${fmtAmt(diff)}；${rows} 只持仓逐项差值之和等于该数）` +
      '。两口径共用同一套成本函数，切换只换参数，不重算流水。',
    )
    setPrefs({ costBasis: next })
  }
  const [view, setView] = useState<PortfolioView | null>(null)
  /** 除权除息提示（P2-4）：来自已同步的日历事件，按持仓标的勾稽 */
  const [actions, setActions] = useState<CorporateAction[]>([])
  const [backupOpen, setBackupOpen] = useState(false)
  const [fxOpen, setFxOpen] = useState(false)
  const [unpricedOpen, setUnpricedOpen] = useState(false)
  const [stale, setStale] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [showArchived, setShowArchived] = useState(false)
  const [modal, setModal] = useState<ModalState>(null)
  const [ledgerTarget, setLedgerTarget] = useState<LedgerTarget>(null)
  const [ledgerEntries, setLedgerEntries] = useState<LedgerView[] | null>(null)
  const miniIds = React.useMemo(() => {
    const ids = new Set<string>()
    for (const p of view?.positions ?? []) ids.add(p.secid)
    return [...ids]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.positions.length ?? 0])
  const minis = useMiniTrends(miniIds, active)
  // 年初至今（YTD）：**标的**的年初至今涨幅（不是持仓收益），现价与其它面板同源、基准由宿主按日 memo
  const ytd = useYtd(miniIds, props.quoteTs ?? null, active)
  // M3：面板级不再写 YTD 缺失摘要（与行级 tooltip 重复）—— 缺失原因由每行的悬停承担
  // 宽窄判定：排序控件二选一挂载（详见 useWide.ts —— 此前两个都挂、靠 CSS 藏一个，实测会同时出现）
  const wide = useWideLayout()
 // 排序入口由**宽窄 + 列头是否真的可见**共同决定（样式表缺失时也不会一个入口都没有）
  const entry = useSortEntry(wide)

  useEffect(() => {
    if (view === null) return
    const ids = [...new Set(view.positions.map((p) => p.secid))]
    onSymbols(ids)
  }, [view, onSymbols])

  const lastAtRef = useRef<number | null>(null)

  const reload = useCallback(() => {
    api
      .portfolio()
      .then((r) => {
        setView(r.view)
        setStale(r.stale)
        setActions(r.corporateActions ?? [])
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  // 单一取数源：持仓明细依赖行情（市值/盈亏都按最新价算），因此**跟随共享行情引擎的
  // 更新节拍**刷新，而不是自己再跑一个定时器 —— 两路各自打上游会造成重复请求，
  // 且两路不同步时首屏数字会短暂不一致。仍保留"最迟 N 秒兜底"：上游持续失败时
  // 引擎的 ts 不更新，这里按 3×refreshSec 兜一次，避免持仓页停刷。
  const quoteTs = props.quoteTs ?? null
  useEffect(() => {
    if (!active) return
    reload()
    let last = Date.now()
    const t = setInterval(() => {
      if (quoteTs !== null && quoteTs !== lastAtRef.current) {
        lastAtRef.current = quoteTs
        last = Date.now()
        reload()
        return
      }
      if (Date.now() - last >= refreshSec * 3000) {
        last = Date.now()
        reload()
      }
    }, Math.max(1000, refreshSec * 1000))
    return () => clearInterval(t)
  }, [active, refreshSec, reload, quoteTs])

  const mutate = (body: MutatePortBody, done?: () => void): void => {
    setError(null)
    api
      .mutatePortfolio(body)
      .then((r) => {
        setView(r.view)
        setStale(r.stale)
        setActions(r.corporateActions ?? [])
        done?.()
      })
      .catch((e: Error) => setError(e.message))
  }

  const openLedger = (target: LedgerTarget): void => {
    setLedgerTarget(target)
    if (target === null) return
    setLedgerEntries(null)
    api
      .ledger(target.mode === 'group' ? target.id : undefined, target.mode === 'pos' ? target.id : undefined, 500)
      .then((r) => setLedgerEntries(r.entries))
      .catch((e: Error) => setError(e.message))
  }

  if (view === null && error === null) {
    return React.createElement('div', { className: 'tw-body' }, React.createElement(Skeleton, { lines: 5, height: 18 }))
  }

  const groups = [...view.groups].sort((a, b) => a.order - b.order)
  const activeGroups = groups.filter((g) => g.archived !== true)
  const archivedGroups = groups.filter((g) => g.archived === true)
  const grand = view.grand

  // 未计入总额的持仓（口径问题/无价），来自 host 的 assemblePortfolio（P0-1）
  const unpriced = view?.unpriced ?? []
  /**
   * 未录入成本的持仓（P1-10）：市值照算，但盈亏与盈亏率是 `—`，且**不计入**分组/总览的盈亏合计
   * （宿主侧对 null 盈亏按"跳过"处理）。这种事必须写在界面上，否则总额看起来完整、其实缺一块。
   */
  const costUnknownRows = view.positions.filter((p) => p.costUnknown === true && p.qty > 0)
  /**
   * 「累计已实现」少算的那些行（N1）：只数与股数都取自 `shared/model.ts` 的**同一份判定**
   * （与行内提示、`tradewatcher_portfolio` 同源），面板不自己 filter/reduce 一套 ——
   * 否则"合计少了多少、为什么少"会在两处给出不同答案。
   */
  const ruRows = realizedUnknownRows(view.positions)
  const ruQty = realizedUnknownQtyOf(ruRows)
  /**
   * 未能应用的流水（P1-5）：账本里有、快照却没算进来。**必须报出来** ——
   * 否则用户看到的是"账本 5 笔、持仓少一块"，而没有任何线索说明少了什么。
   */
  const skippedRows = view.positions.filter((p) => (p.skippedLedger ?? 0) > 0)
  const skippedTotal = skippedRows.reduce((a, p) => a + (p.skippedLedger ?? 0), 0)
  // 折算口径摘要（P1-11）：不折算 = 只含 A股；固定 = 列出实际使用的汇率
  const fxRatesText = Object.entries(view?.fxRates ?? {})
    .map(([c, r]) => `1 ${c} = ${r} CNY`)
    .join('，')
  const fxSummary = view?.fxMode === 'fixed'
    ? `固定汇率折算（${fxRatesText === '' ? '未填写汇率' : fxRatesText}，由你设定）`
    : '不折算（总额只含 A股）'

  const stat = (label: string, value: number, colored = true): React.ReactElement =>
    React.createElement('div', { className: 'tw-stat' },
      React.createElement('div', { className: 'k' }, label),
      React.createElement('div', { className: colored ? `v ${dirClass(value, redUp)}` : 'v' },
        colored ? fmtMoneySigned(value) : fmtRaw(value)),
    )

  return React.createElement(
    'div',
    { className: 'tw-body' },
    React.createElement(ErrorNote, { error }),
    React.createElement('div', { className: 'tw-panel' },
      // 这一行比自选页更挤（口径段控 + 排序键 + 汇率/备份/刷新）：7 个排序键把整行推到 900px+，
      // 不换行会把「汇率/刷新」顶出卡片右缘。自选页的面板头本来就 wrap，两页行为要一致。
      React.createElement('div', { className: 'tw-panel-h', style: { flexWrap: 'wrap' } },
        React.createElement('span', { className: 't' }, '持仓总览（实时行情）'),
        stale > 0
          ? React.createElement('span', {
              className: 'tw-badge',
              // 分组/总览的市值与盈亏把无价持仓按 0 计入 —— 只说"N 只行情暂缺"不够，
              // 必须说清"下面那些总额不含它们"，否则数字看着完整其实缺一块
              title: `有 ${stale} 只持仓当前没有价格（行情源未给出），它们在分组与总览的市值/盈亏里按 0 计入；具体标的见各行「${NO_SOURCE_LABEL}」标记`,
            }, `${stale} 只${NO_SOURCE_LABEL} · 总额不含`)
          : null,
        React.createElement('div', { className: 'tw-seg', title: '成本口径：摊薄=卖出冲减成本（多数券商 App 口径）；均价=买入移动加权' },
          React.createElement('button', { 'data-on': diluted, onClick: () => switchBasis('diluted') }, '摊薄口径'),
          React.createElement('button', { 'data-on': !diluted, onClick: () => switchBasis('average') }, '均价口径'),
        ),
        React.createElement('span', {
          className: 'tw-iconbtn',
          style: { cursor: 'help' },
          title: diluted
            ? '摊薄成本 = (累计买入含费 − 累计卖出净额) ÷ 剩余数量；持仓盈亏 = (现价 − 摊薄成本) × 数量（已把已实现盈亏计入）。当日盈亏 = 隔夜(现价−昨收)×数量 + 日内买卖差额 − 费用，与券商 App 一致。'
            : '买入均价（移动加权含费）；浮动盈亏 = (现价 − 均价) × 数量，已实现盈亏单列。当日盈亏 = 隔夜(现价−昨收)×数量 + 日内买卖差额 − 费用，与券商 App 一致。',
          'aria-label': '口径说明',
        }, 'ⓘ'),
        // 排序：分组内生效，存进 prefs（重开面板仍生效）
        // 互斥由 `useSortEntry` 决定（宽屏量过列头可见性；样式表缺失时退回段控，见 useWide.ts）
        entry === 'bar'
          ? React.createElement(SortBar<PortSortKey>, {
              keys: PORT_SORT_KEYS,
              labels: PORT_SORT_LABEL,
              hints: PORT_SORT_HINT,
              state: portSort,
              onChange: (next) => setPrefs({ portSort: next }),
              ariaLabel: '持仓排序',
            })
          : null,
        // P1-11：折算口径常显 —— "这个人民币数字怎么来的"必须答得上来
        React.createElement(Btn, {
          onClick: () => setFxOpen(true),
          title: '跨市场折算口径：不折算 / 固定汇率',
        }, view?.fxMode === 'fixed' ? '汇率：固定' : '汇率：不折算'),
        React.createElement(Btn, { onClick: () => setBackupOpen(true), title: '导出/导入 JSON（换机、备份）' }, '备份'),
        React.createElement(Btn, { onClick: reload }, '刷新'),
      ),
      fxOpen
        ? React.createElement(FxModal, {
            mode: (prefs.fxMode ?? 'none'),
            rates: prefs.fxRates ?? {},
            setPrefs,
            onClose: () => setFxOpen(false),
            notify: props.notify,
          })
        : null,
      backupOpen
        ? React.createElement(BackupModal, {
            onClose: () => setBackupOpen(false),
            notify: props.notify,
            onDone: () => { void reload() },
          })
        : null,
 // 除权除息提示。只提示"要变"，**不自动改账** —— 送转到账数量以券商为准
      // 自动改会把用户唯一的交易记录改成一个"看起来对但没人能核对"的状态。
      actions.length > 0
        ? React.createElement('div', { className: 'tw-hint', style: { padding: '2px 2px 0', color: '#e8a33d' } },
            `${actions.length} 条公司行为涉及你的持仓：${actions.slice(0, 3).map((a) => `${a.date} ${a.name}${a.kind === 'ex' ? '除权除息' : '股权登记'}`).join('、')}${actions.length > 3 ? ' 等' : ''}。` +
            '除权除息后数量与成本会变 —— 请在「调整」里按券商实际到账录入新数量与成本（本插件不自动改账：真实的送转/派息以券商为准，自动改出来的数字没人能核对）。',
          )
        : null,
      unpricedOpen && unpriced.length > 0
        ? React.createElement('div', { className: 'tw-hint', style: { padding: '4px 2px 0' } },
            `以下 ${unpriced.length} 项不计入总额与盈亏（口径：${fxSummary}；未计入的原币市值合计 ${fmtAmt(view?.unpricedMv ?? 0)}）：`,
            React.createElement('ul', { style: { margin: '4px 0 0 16px' } },
              ...unpriced.map((u) =>
                React.createElement('li', { key: u.posId },
                  React.createElement('b', null, u.name),
                  `（${u.secid}）${u.why === 'no-fx' ? '非人民币计价、未折算' : '无可用行情源'}：${u.note}`,
                ),
              ),
            ),
          )
        : null,
      React.createElement('div', { className: 'tw-statrow' },
        stat(unpriced.length > 0 ? '总市值（仅 A股）' : '总市值', grand.totalMv, false),
        // P0-1/P1-6：总额缺一块必须能点开看到缺的是谁、为什么
        unpriced.length > 0
          ? React.createElement('span', {
              className: 'tw-badge',
              style: { cursor: 'pointer', alignSelf: 'center' },
              title: '点击展开：这些持仓未计入上方的总额与盈亏',
              onClick: () => setUnpricedOpen((v) => !v),
            }, `不含 ${unpriced.length} 项${unpricedOpen ? ' ▲' : ' ▼'}`)
          : null,
        diluted ? stat('持仓盈亏', grand.dilutedPnl) : stat('浮动盈亏', grand.floatPnl),
        stat('当日盈亏', grand.dayPnl),
        stat('累计已实现', grand.realized),
      ),
    ),
    React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      React.createElement(Btn, { primary: true, onClick: () => setModal({ kind: 'addGroup' }) }, '+ 新建分组'),
      archivedGroups.length > 0
        ? React.createElement(Btn, { onClick: () => setShowArchived((v) => !v) }, `已归档 ${archivedGroups.length}`)
        : null,
      React.createElement('span', { className: 'tw-muted', style: { flex: 1, textAlign: 'right' } },
        new Date(view.generatedAt).toLocaleTimeString('zh-CN', { hour12: false }),
      ),
    ),
    // 列头排序（宽屏）：与面板顶部段控读写**同一份** `portSort` 偏好。两者由 `wide` 二选一挂载
    wide
      ? React.createElement(SortHeader<PortSortKey>, {
          columns: PORT_COLUMNS,
          state: portSort,
          onChange: (next) => setPrefs({ portSort: next }),
          ariaLabel: '持仓列头排序',
        })
      : null,
    ytd.error !== null
      ? React.createElement('div', {
          className: 'tw-hint',
          style: { color: 'var(--tw-up)' },
          tabIndex: 0,
          role: 'note',
          title: '已取到的数字保留上一次成功结果；取不到的显示 —（逐行原因见各行悬停）。',
        }, `YTD 本次未取到 · ${ytd.error}`)
      : null,
    ytd.truncated
      ? React.createElement('div', { className: 'tw-hint' },
          `年初至今（YTD）单次最多计算 ${ytd.limit} 项：超出的持仓 YTD 显示 —（不静默截断）。`)
      : null,
    costUnknownRows.length > 0
      ? React.createElement('div', {
          className: 'tw-hint',
          style: { padding: '2px 2px 0', color: '#e0a94a' },
          tabIndex: 0,
          role: 'note',
          'aria-label': `${costUnknownRows.length} 只未录入成本：市值照算，盈亏 —`,
          title: `${costUnknownRows.map((p) => p.name).join('、')}\n市值照算，但盈亏、盈亏率与已实现显示 —，且不计入分组与总览的盈亏合计（拿 0 当成本会把全部市值算成一笔盈利）。`,
        },
          `${costUnknownRows.length} 只未录入成本：市值照算，盈亏 —`,
        )
      : null,
    ruRows.length > 0
      ? React.createElement('div', {
          className: 'tw-hint',
          style: { padding: '2px 2px 0', color: 'var(--tw-muted)' },
          tabIndex: 0,
          role: 'note',
          'aria-label': `累计已实现不含 ${ruRows.length} 只（${ruRows.map((p) => p.name).join('、')}）：${realizedUnknownNote(ruQty)}`,
        },
          `累计已实现不含 ${ruRows.length} 只（${ruRows.map((p) => p.name).join('、')}）：${realizedUnknownNote(ruQty)}`,
        )
      : null,
    skippedTotal > 0
      ? React.createElement('div', {
          className: 'tw-hint',
          style: { padding: '2px 2px 0', color: 'var(--tw-up)' },
          tabIndex: 0,
          role: 'note',
          'aria-label': `${skippedTotal} 条流水未应用：用「交易明细」核对`,
          title: `账本里有、持仓快照没算进来：\n${skippedRows.flatMap((p) => (p.skippedNotes ?? []).map((n) => `${p.name} ${n}`)).join('\n')}`,
        },
          `${skippedTotal} 条流水未应用：用「交易明细」核对`,
        )
      : null,
    activeGroups.length === 0
      ? React.createElement(EmptyHint, { action: React.createElement(Btn, { primary: true, onClick: () => setModal({ kind: 'addGroup' }) }, '+ 新建分组') }, '暂无持仓分组：新建分组 → 添加持仓 → 用「买/卖」录入流水。')
      : null,
    activeGroups.map((grp) => {
      // 排序在分组内生效；盈亏键跟随当前口径（摊薄=持仓盈亏 / 均价=浮动盈亏），
      // 与表格里显示的那一列保持同一个数 —— 否则"按盈亏排序"看到的顺序会与列对不上
      const rows = sortPositions(
        view.positions.filter((p) => p.groupId === grp.id),
        portSort,
        (row) => ({
          mv: row.mv,
          pnl: diluted ? row.dilutedPnl : row.floatPnl,
          dayPnl: row.dayPnl,
          weight: weightOf(row.mv, grand.totalMv),
          // 成本键跟随当前口径：与「成本」列显示的是同一个数（否则按成本排出来的顺序与列对不上）
          price: row.price,
          cost: diluted ? row.dilutedCost : row.avgCost,
        }),
      )
      const isCollapsed = collapsed[grp.id] === true
      return React.createElement(
        'div',
        { key: grp.id, className: 'tw-group' },
        React.createElement('div', { className: 'tw-group-h' },
          React.createElement('div', { className: 'tw-gh-row' },
            React.createElement('button', { className: 'gname', title: isCollapsed ? '展开' : '折叠', 'aria-label': `${isCollapsed ? '展开' : '折叠'}分组 ${grp.name}`, onClick: () => setCollapsed((s) => ({ ...s, [grp.id]: !isCollapsed })) }, isCollapsed ? '▸ ' : '▾ '),
            React.createElement('span', { className: 'gname' }, grp.name),
            React.createElement('span', { className: 'tw-muted', style: { fontSize: 11 } }, `${rows.length} 只`),
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement(Btn, { onClick: () => setModal({ kind: 'addPos', groupId: grp.id, groupName: grp.name }) }, '+持仓'),
            React.createElement(MoreMenu, {
              ariaLabel: `分组 ${grp.name} 更多操作`,
              items: [
                { label: '流水记录', onClick: () => openLedger({ mode: 'group', id: grp.id, title: grp.name }) },
                { label: '编辑分组', onClick: () => setModal({ kind: 'groupEdit', groupId: grp.id, name: grp.name, note: grp.note ?? '' }) },
                {
                  label: '删除分组（归档）',
                  danger: true,
                  onClick: () => {
                    if (window.confirm(`删除分组「${grp.name}」？将归档处理：持仓与全部流水保留，可随时恢复。`)) mutate({ op: 'archiveGroup', groupId: grp.id })
                  },
                },
              ],
            }),
          ),
          React.createElement('div', { className: 'tw-gh-metrics' },
            React.createElement('span', null, '市值 ', React.createElement('b', null, fmtAmt(grp.totalMv))),
            diluted
              ? React.createElement('span', { className: dirClass(grp.dilutedPnl, redUp) }, '持仓盈亏 ', fmtMoneySigned(grp.dilutedPnl))
              : React.createElement('span', { className: dirClass(grp.floatPnl, redUp) }, '浮盈 ', fmtMoneySigned(grp.floatPnl)),
            React.createElement('span', { className: dirClass(grp.dayPnl, redUp) }, '当日 ', fmtMoneySigned(grp.dayPnl)),
            React.createElement('span', { className: 'tw-dim' }, '已实现 ', fmtMoneySigned(grp.realized)),
          ),
        ),
        isCollapsed
          ? null
          : rows.length === 0
            ? React.createElement('div', { className: 'tw-hint', style: { padding: 8 } }, '空分组：点「+持仓」添加证券，随后在行上「买/卖」录入。')
            : React.createElement('div', { className: 'tw-poslist' },
              ...rows.map((row) =>
                React.createElement(PosRow, {
                  key: row.posId,
                  row,
                  redUp,
                  diluted,
                  weight: weightOf(row.mv, grand.totalMv),
                  quote: quotes[row.secid],
                  noSource: missing?.has(row.secid.toUpperCase()) === true,
                  mini: minis[row.secid],
                  ytd: ytd.map[row.secid],
                  ytdLoaded: ytd.loaded,
                  ytdStale: ytd.stale,
                  ytdSource: ytd.source,
                  // 同一持仓可能有多条（登记日 + 除权日），取最近的一条提示
                  action: actions.filter((a) => a.posId === row.posId).sort((a, b) => a.date.localeCompare(b.date))[0],
                  onTrade: (verb) => setModal({ kind: 'trade', verb, pos: row, groupName: grp.name }),
                  onDetail: () => openLedger({ mode: 'pos', id: row.posId, title: `${row.name} 交易明细`, row }),
                  onOpenChart: () => onOpenDetail?.(row.secid, row.name),
                  onEdit: () => setModal({ kind: 'posEdit', pos: row, groupName: grp.name, groups: activeGroups }),
                  onRemove: () => {
                    if (row.qty > 0) {
                      window.alert(`请先在「卖」中卖出全部 ${row.qty} 后再移除（保证流水完整）。`)
                      return
                    }
                    if (window.confirm(`移除空仓「${row.name}」？交易流水将保留。`)) mutate({ op: 'removePos', posId: row.posId })
                  },
                }),
              ),
            ),
      )
    }),
    showArchived && archivedGroups.length > 0
      ? React.createElement('div', { className: 'tw-panel', style: { opacity: 0.75 } },
          archivedGroups.map((grp) =>
            React.createElement('div', { key: grp.id, className: 'tw-wrow' },
              React.createElement('div', { className: 'nm' },
                React.createElement('b', null, grp.name),
                React.createElement('small', null, `市值 ${fmtAmt(grp.totalMv)} · 浮盈 ${fmtMoneySigned(grp.floatPnl)} · 流水保留`),
              ),
              React.createElement(Btn, { onClick: () => mutate({ op: 'restoreGroup', groupId: grp.id }) }, '恢复'),
              React.createElement(Btn, { onClick: () => openLedger({ mode: 'group', id: grp.id, title: grp.name }) }, '流水'),
            ),
          ),
        )
      : null,
    ledgerTarget !== null
      ? React.createElement(LedgerModal, { target: ledgerTarget, entries: ledgerEntries, redUp, diluted, onClose: () => openLedger(null) })
      : null,
    modal !== null
      ? React.createElement(PortModalHost, { modal, key: `${modal.kind}-${'pos' in modal ? modal.pos.posId : 'groupId' in modal ? modal.groupId : 'n'}`, redUp, quotes, onClose: () => setModal(null), mutate })
      : null,
  )
}

type ModalState =
  | { kind: 'addGroup' }
  | { kind: 'groupEdit'; groupId: string; name: string; note: string }
  | { kind: 'addPos'; groupId: string; groupName: string }
  | { kind: 'trade'; verb: 'buy' | 'sell' | 'adjust'; pos: PositionRow; groupName: string }
  | { kind: 'posEdit'; pos: PositionRow; groupName: string; groups: Array<{ id: string; name: string }> }

type LedgerTarget = { mode: 'group' | 'pos'; id: string; title: string; row?: PositionRow } | null

/** Modal switch — every branch is its own component so hooks are stable. */
function PortModalHost(props: {
  modal: ModalState
  redUp: boolean
  quotes: Record<string, QuoteRow>
  onClose: () => void
  mutate: (body: MutatePortBody, done?: () => void) => void
}): React.ReactElement {
  const m = props.modal
  if (m.kind === 'addGroup') {
    return React.createElement(GroupFormModal, { mode: 'create', name: '', note: '', onClose: props.onClose, mutate: props.mutate })
  }
  if (m.kind === 'groupEdit') {
    return React.createElement(GroupFormModal, { mode: 'edit', groupId: m.groupId, name: m.name, note: m.note, onClose: props.onClose, mutate: props.mutate })
  }
  if (m.kind === 'addPos') {
    return React.createElement(AddPosModal, { groupId: m.groupId, groupName: m.groupName, onClose: props.onClose, mutate: props.mutate })
  }
  if (m.kind === 'trade') {
    return React.createElement(TradeModal, { verb: m.verb, pos: m.pos, groupName: m.groupName, quote: props.quotes[m.pos.secid], redUp: props.redUp, onClose: props.onClose, mutate: props.mutate })
  }
  return React.createElement(PosEditModal, { pos: m.pos, groupName: m.groupName, groups: m.groups, onClose: props.onClose, mutate: props.mutate })
}

/**
 * 备份 / 恢复（P0-9）。
 *
 * 流程刻意做成两段：选文件 → **预览**（校验 + 冲突差异）→ 确认覆盖。
 * 因为"导入"是不可逆的一步（覆盖本机账本），一次点击就写盘等于把误操作变成数据丢失；
 * 校验不通过时根本走不到确认按钮 —— 宿主侧会逐条拒绝并说明原因。
 */
function BackupModal(props: { onClose: () => void; notify?: (text: string) => void; onDone: () => void }): React.ReactElement {
  const [bundle, setBundle] = useState<unknown>(null)
  const [fileName, setFileName] = useState('')
  const [check, setCheck] = useState<{ ok: boolean; errors: string[]; conflicts: string[]; summary: Record<string, unknown> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const doExport = (): void => {
    setErr(null)
    setBusy(true)
    api
      .exportBackup()
      .then((r) => {
        const text = JSON.stringify(r.bundle, null, 1)
        const blob = new Blob([text], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `dsh-tradewatcher-backup-${new Date().toISOString().slice(0, 10)}.json`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        props.notify?.(`已导出备份（${(text.length / 1024).toFixed(1)} KB）${r.unreadable.length > 0 ? `；注意：${r.unreadable.join('、')} 读不到，已按空表导出` : ''}`)
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false))
  }

  const pickFile = (file: File): void => {
    setErr(null)
    setCheck(null)
    setBundle(null)
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result))
        setBundle(parsed)
        setBusy(true)
        api
          .importBackup('preview', parsed)
          .then((r) => setCheck({ ok: r.ok, errors: r.errors, conflicts: r.conflicts, summary: r.summary }))
          .catch((e: Error) => setCheck({ ok: false, errors: [e.message], conflicts: [], summary: {} }))
          .finally(() => setBusy(false))
      } catch (e) {
        setCheck({ ok: false, errors: [`文件不是合法 JSON：${e instanceof Error ? e.message : String(e)}`], conflicts: [], summary: {} })
      }
    }
    reader.onerror = () => setCheck({ ok: false, errors: ['文件读取失败'], conflicts: [], summary: {} })
    reader.readAsText(file)
  }

  const doApply = (): void => {
    if (bundle === null) return
    setErr(null)
    setBusy(true)
    api
      .importBackup('apply', bundle)
      .then((r) => {
        props.notify?.(`已导入：${r.conflicts.length > 0 ? r.conflicts.join('；') : '内容与校验全部通过'}。原文件已备份为 ${(r.backedUp ?? []).join('、') || '（无）'}`)
        props.onDone()
        props.onClose()
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false))
  }

  return React.createElement(Modal, { title: '备份 / 恢复（导出·导入 JSON）', onClose: props.onClose },
    React.createElement(ErrorNote, { error: err }),
    React.createElement('div', { className: 'tw-hint' },
      '导出把 watch/positions/ledger/prefs 打包成一份 JSON（含 schemaVersion 与校验和），用于换机或备份。' +
      '导入前会先校验并给出差异预览，确认后才覆盖；覆盖前本机原文件会写成 .bak。' +
      '账本重放不一致（引用缺失、负持仓、条目无法解析）一律拒绝导入 —— 宁可不导入，也不导入一份算不平的账。',
    ),
    React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
      React.createElement(Btn, { onClick: doExport, disabled: busy }, '导出 JSON'),
      React.createElement('label', { className: 'tw-iconbtn', style: { cursor: 'pointer' } },
        '选择备份文件…',
        React.createElement('input', {
          type: 'file',
          accept: '.json,application/json',
          style: { display: 'none' },
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            const f = e.target.files?.[0]
            if (f !== undefined) pickFile(f)
          },
        }),
      ),
      fileName !== '' ? React.createElement('span', { className: 'tw-muted', style: { fontSize: 11 } }, fileName) : null,
    ),
    check !== null
      ? React.createElement('div', { style: { marginTop: 10 } },
          React.createElement('div', { className: check.ok ? 'tw-ok' : 'tw-err', style: { fontSize: 12, fontWeight: 600 } },
            check.ok ? '校验通过，可以导入' : '拒绝导入'),
          check.errors.length > 0
            ? React.createElement('ul', { className: 'tw-hint', style: { margin: '4px 0 0 16px' } },
                ...check.errors.map((e, i) => React.createElement('li', { key: i }, e)),
              )
            : null,
          check.conflicts.length > 0
            ? React.createElement('div', { style: { marginTop: 6 } },
                React.createElement('div', { className: 'tw-muted', style: { fontSize: 11 } }, '覆盖前后差异预览：'),
                React.createElement('ul', { className: 'tw-hint', style: { margin: '4px 0 0 16px' } },
                  ...check.conflicts.map((c, i) => React.createElement('li', { key: i }, c)),
                ),
              )
            : null,
        )
      : null,
    React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 } },
      React.createElement(Btn, { onClick: props.onClose }, '取消'),
      React.createElement(Btn, {
        primary: true,
        disabled: busy || check === null || !check.ok || bundle === null,
        onClick: doApply,
      }, busy ? '处理中…' : '确认覆盖导入'),
    ),
  )
}

function GroupFormModal(props: {
  mode: 'create' | 'edit'
  groupId?: string
  name: string
  note: string
  onClose: () => void
  mutate: (body: MutatePortBody, done?: () => void) => void
}): React.ReactElement {
  const [name, setName] = useState(props.name)
  const [note, setNote] = useState(props.note)
  const [err, setErr] = useState<string | null>(null)
  return React.createElement(Modal, { title: props.mode === 'create' ? '新建持仓分组' : '编辑分组', onClose: props.onClose },
    React.createElement(ErrorNote, { error: err }),
    React.createElement(Field, { label: '分组名' },
      React.createElement('input', { className: 'tw-input', value: name, onChange: (e) => setName(e.target.value), placeholder: '如：长期持有' }),
    ),
    React.createElement(Field, { label: '备注（可选）' },
      React.createElement('input', { className: 'tw-input', value: note, onChange: (e) => setNote(e.target.value) }),
    ),
    React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 } },
      React.createElement(Btn, { onClick: props.onClose }, '取消'),
      React.createElement(Btn, {
        primary: true,
        onClick: () => {
          if (name.trim() === '') { setErr('请输入分组名'); return }
          if (props.mode === 'create') props.mutate({ op: 'addGroup', name }, props.onClose)
          else props.mutate({ op: 'renameGroup', groupId: props.groupId, name, note }, props.onClose)
        },
      }, '保存'),
    ),
  )
}

function AddPosModal(props: {
  groupId: string
  groupName: string
  onClose: () => void
  mutate: (body: MutatePortBody, done?: () => void) => void
}): React.ReactElement {
  const [selected, setSelected] = useState<SuggestItem | null>(null)
  const [err, setErr] = useState<string | null>(null)
  return React.createElement(Modal, { title: `添加持仓到「${props.groupName}」`, onClose: props.onClose },
    React.createElement(ErrorNote, { error: err }),
    React.createElement(SuggestInput, { onPick: (it) => { setSelected(it); setErr(null) }, autoFocus: true }),
    selected !== null
      ? React.createElement('div', { className: 'tw-wrow', style: { border: '1px solid var(--tw-border)', borderRadius: 8, marginTop: 6 } },
          React.createElement('div', { className: 'nm' },
            React.createElement('b', null, selected.name),
            React.createElement('small', null, `${selected.code} · ${selected.kind} · ${selected.secid}`),
          ),
          React.createElement(Btn, { onClick: () => setSelected(null) }, '清除'),
        )
      : React.createElement('div', { className: 'tw-hint' }, '搜索并选择一个证券加入分组（A股/港股/美股/ETF/基金/指数/期货，数量 0 建仓后用「买」录入）。'),
    React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 } },
      React.createElement(Btn, { onClick: props.onClose }, '取消'),
      React.createElement(Btn, {
        primary: true,
        disabled: selected === null,
        onClick: () => {
          if (selected === null) return
          props.mutate({ op: 'addPos', groupId: props.groupId, secid: selected.secid, symbolName: selected.name }, props.onClose)
        },
      }, '加入分组'),
    ),
  )
}

function TradeModal(props: {
  verb: 'buy' | 'sell' | 'adjust'
  pos: PositionRow
  groupName: string
  quote: QuoteRow | undefined
  redUp: boolean
  onClose: () => void
  mutate: (body: MutatePortBody, done?: () => void) => void
}): React.ReactElement {
  const { verb, pos, groupName } = props
  const livePrice = props.quote?.price ?? pos.price
  const initialQty = verb === 'sell' || verb === 'adjust' ? String(pos.qty) : ''
  const [qty, setQty] = useState(initialQty)
  const [price, setPrice] = useState(verb === 'adjust' ? '' : String(livePrice ?? ''))
  const [fee, setFee] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const qN = Number(qty)
  const pN = Number(price)
  const fN = Number(fee) || 0
  const title = verb === 'buy' ? '买入' : verb === 'sell' ? '卖出' : '调整持仓'
 // 可用（可卖）口径的说明（T+1 品种今日买入的部分不可卖；T+0 不受限）
  const sellHint = pos.t0
    ? 'T+0：当日买入当日可卖（与本面板的可用数量口径一致）'
    : `可用（可卖）${pos.availableQty} —— A股 T+1：今日买入的部分当日不可卖`
  const hint =
    verb === 'buy'
      ? `预计投入 ≈ ${fmtAmt(qN * pN + fN)}（费用计入摊薄成本）`
      : verb === 'sell'
        ? `预计回收 ≈ ${fmtAmt(qN * pN - fN)} · 现持有 ${pos.qty} · ${sellHint}`
        : '数量=调整后目标数量（可 0）；价格=新摊薄成本，留空则保持现值'
  return React.createElement(Modal, { title: `${pos.name} · ${title}`, onClose: props.onClose },
    React.createElement(ErrorNote, { error: err }),
    React.createElement('div', { className: 'tw-hint' },
      `分组 ${groupName} · 持有 ${pos.qty} @ ${fmtPrice(pos.avgCost)} · 现价 ${fmtPrice(livePrice)}`,
    ),
    React.createElement(Field, { label: verb === 'adjust' ? '目标数量' : '数量' },
      React.createElement('input', { className: 'tw-input', value: qty, onChange: (e) => setQty(e.target.value), inputMode: 'decimal' }),
    ),
    React.createElement(Field, { label: verb === 'adjust' ? '新摊薄成本（可留空）' : '价格' },
      React.createElement('input', { className: 'tw-input', value: price, onChange: (e) => setPrice(e.target.value), inputMode: 'decimal' }),
    ),
    React.createElement(Field, { label: '费用（佣金/手续费，可 0）' },
      React.createElement('input', { className: 'tw-input', value: fee, onChange: (e) => setFee(e.target.value), inputMode: 'decimal' }),
    ),
    React.createElement(Field, { label: '备注（可选）' },
      React.createElement('input', { className: 'tw-input', value: note, onChange: (e) => setNote(e.target.value), placeholder: '如：加仓理由/调仓说明' }),
    ),
    React.createElement('div', { className: 'tw-hint' }, hint),
    React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 } },
      React.createElement(Btn, { onClick: props.onClose }, '取消'),
      React.createElement(Btn, {
        primary: true,
        onClick: () => {
          if (!Number.isFinite(qN) || qN <= 0) { setErr('请输入有效数量'); return }
          if (verb === 'sell' && qN > pos.qty + 1e-9) { setErr(`卖出数量超过持有（${pos.qty}）`); return }
 // 可用（可卖）数量。宿主侧有同一道校验（两处都不放行），这里先拦是为了
          // 不让用户填完一整张表才收到 400 —— 也顺带把"为什么不能卖"讲清楚
          if (verb === 'sell' && !pos.t0 && qN > pos.availableQty + 1e-9) {
            setErr(`可用（可卖）${pos.availableQty} 少于本次卖出 ${qN}：${sellHint}。请核对券商端的可用数量（本插件按流水推导，T+1 部分今日买入不可卖）`)
            return
          }
          if (verb !== 'adjust') {
            if (!Number.isFinite(pN) || pN <= 0) { setErr('请输入有效价格'); return }
            props.mutate({ op: verb, posId: pos.posId, qty: qN, price: pN, fee: fN, note: note.trim() === '' ? undefined : note.trim() }, props.onClose)
          } else {
            if (price.trim() !== '' && (!Number.isFinite(pN) || pN <= 0)) { setErr('请输入有效价格或留空'); return }
            const body: MutatePortBody = { op: 'adjust', posId: pos.posId, qty: qN, fee: fN, note: note.trim() === '' ? undefined : note.trim() }
            if (price.trim() !== '') body.price = pN
            props.mutate(body, props.onClose)
          }
        },
      }, '确认'),
    ),
  )
}

function PosEditModal(props: {
  pos: PositionRow
  groupName: string
  groups: Array<{ id: string; name: string }>
  onClose: () => void
  mutate: (body: MutatePortBody, done?: () => void) => void
}): React.ReactElement {
  const [name, setName] = useState(props.pos.name)
  const [moveGroup, setMoveGroup] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const targets = props.groups.filter((x) => x.id !== props.pos.groupId)
  return React.createElement(Modal, { title: `编辑「${props.pos.name}」`, onClose: props.onClose },
    React.createElement(ErrorNote, { error: err }),
    React.createElement(Field, { label: '名称' },
      React.createElement('input', { className: 'tw-input', value: name, onChange: (e) => setName(e.target.value) }),
    ),
    targets.length > 0
      ? React.createElement(Field, { label: '移动到分组' },
          React.createElement('select', { className: 'tw-input', value: moveGroup, onChange: (e) => setMoveGroup(e.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>,
            React.createElement('option', { value: '' }, `不移动（当前：${props.groupName}）`),
            targets.map((x) => React.createElement('option', { key: x.id, value: x.id }, x.name)),
          ),
        )
      : null,
    React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 } },
      React.createElement(Btn, { onClick: props.onClose }, '取消'),
      React.createElement(Btn, {
        primary: true,
        onClick: () => {
          if (name.trim() === '') { setErr('请输入名称'); return }
          const body: MutatePortBody = { op: 'editPos', posId: props.pos.posId, symbolName: name }
          if (moveGroup !== '') body.groupId = moveGroup
          props.mutate(body, props.onClose)
        },
      }, '保存'),
    ),
  )
}

function LedgerModal(props: { target: { mode: string; id: string; title: string; row?: PositionRow }; entries: LedgerView[] | null; redUp: boolean; diluted: boolean; onClose: () => void }): React.ReactElement {
  const rows = props.entries ?? []
  const r = props.target.row
  const redUp = props.redUp
  const diluted = props.diluted
  const chip = (verb: LedgerView['verb']): string =>
    verb === 'buy' ? 'tw-chip-up' : verb === 'sell' ? 'tw-chip-down' : 'tw-chip-flat'
  const pctStrip = (): React.ReactNode | null => {
    if (r === undefined) return null
    const cost = diluted ? r.dilutedCost : r.avgCost
    const pnl = diluted ? r.dilutedPnl : r.floatPnl
    const pnlPct = diluted ? r.dilutedPnlPct : r.floatPnlPct
    const fmtRate = (v: number | null | undefined): string =>
      v === null || v === undefined ? '—' : `${v === 0 ? '' : v > 0 ? '▲' : '▼'}${Math.abs(v).toFixed(2)}%`
    return React.createElement('div', { className: 'tw-hint', style: { display: 'flex', gap: 14, flexWrap: 'wrap', margin: '0 0 8px', fontFamily: 'var(--tw-mono)' } },
      React.createElement('span', null, `持仓 ${r.qty} · ${diluted ? '摊薄成本' : '均价'} ${fmtPrice(cost)} · 现价 ${fmtPrice(r.price)}`),
      React.createElement('span', { className: dirClass(pnl, redUp) }, `${diluted ? '持仓盈亏' : '浮动盈亏'} ${fmtMoneySigned(pnl)} (${fmtRate(pnlPct)})`),
      React.createElement('span', { className: dirClass(r.dayPnl, redUp) }, `当日 ${fmtMoneySigned(r.dayPnl)} (${fmtRate(r.dayPnlPct)})`),
      // 「已实现 —」必须给原因（否则看起来像丢了数据）：短句 + 全文进 title（S18/S20：长句只留面板级一处）
      (r.realizedUnknownQty ?? 0) > 0
        ? React.createElement('span', { className: 'tw-muted', title: realizedUnknownNote(r.realizedUnknownQty ?? 0) },
            realizedUnknownShort(r.realizedUnknownQty ?? 0))
        : r.costUnknown === true
          ? React.createElement('span', { className: 'tw-muted', title: '成本未录入：市值照算，成本/盈亏/已实现都不给数' }, '成本未录入 → 盈亏不可算')
          : null,
    )
  }
  return React.createElement(
    Modal,
    { title: `${props.target.title} · 操作记录`, onClose: props.onClose, width: 640 },
    pctStrip(),
    props.entries === null
      ? React.createElement('div', { className: 'tw-loading' }, '加载流水…')
      : rows.length === 0
        ? React.createElement('div', { className: 'tw-muted' }, '暂无记录。')
        : React.createElement('div', { className: 'tw-scroll', style: { maxHeight: '58vh', overflow: 'auto' } },
            rows.map((r) =>
              React.createElement('div', { key: r.id, className: 'tw-wrow', style: { borderTop: '1px solid var(--tw-border)', padding: '5px 2px' } },
                React.createElement('div', { className: 'nm' },
                  React.createElement('b', null,
                    React.createElement('span', { className: `tw-chg-chip ${chip(r.verb)}` }, verbLabel(r.verb)),
                    r.posName !== null ? ` ${r.posName}` : r.groupName !== null ? ` ${r.groupName}` : '',
                  ),
                  React.createElement('small', null,
                    `${fmtStamp(r.ts)}${r.groupName !== null && r.posName !== null ? ` · ${r.groupName}` : ''}${r.actor === 'tool' ? ' · 会话操作' : ''}`,
                  ),
                ),
                React.createElement('div', { className: 'wq', style: { gap: 4 } },
                  r.qty !== undefined && r.qty !== null ? React.createElement('span', null, `${r.qty} 份`) : null,
                  r.price !== undefined && r.price !== null && r.price > 0 ? React.createElement('span', null, `@ ${fmtPrice(r.price)}`) : null,
                  r.fee !== undefined && r.fee !== null && r.fee !== 0 ? React.createElement('span', { className: 'tw-muted' }, `费 ${r.fee}`) : null,
                ),
                r.note !== undefined && r.note !== null && r.note !== ''
                  ? React.createElement('span', { className: 'tw-muted', style: { flex: 'none', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.note)
                  : null,
              ),
            ),
          ),
    React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 8 } },
      React.createElement(Btn, { onClick: props.onClose }, '关闭'),
    ),
  )
}

function PosRow(props: {
  row: PositionRow
  quote: QuoteRow | undefined
  redUp: boolean
  diluted: boolean
  /** 仓位占比（个股市值 ÷ 组合总市值）；总市值为 0 时为 null */
  weight: number | null
  /** 三个源都没有该标的的可用价格（与"行情暂缺"区分） */
  noSource: boolean
  /** 分时缩略图数据（P1-1：含均价线与开/高/低） */
  mini: MiniData | undefined
  /** 标的的年初至今（YTD）行；尚未取到时 undefined */
  ytd: YtdRow | undefined
  /** 是否至少成功取到过一次 YTD（区分"还没结果"与"真的没有"） */
  ytdLoaded: boolean
  /** YTD 回包的降级信息（来源 / 是否旧基准）：进 tooltip 的一行 */
  ytdStale?: boolean
  ytdSource?: string
  /** 该标的最近的除权除息（P2-4）：只提示"要变"，不自动改账 */
  action: CorporateAction | undefined
  onTrade: (verb: 'buy' | 'sell' | 'adjust') => void
  onDetail: () => void
  onOpenChart: () => void
  onEdit: () => void
  onRemove: () => void
}): React.ReactElement {
  const { row, redUp, diluted } = props
  const price = row.price
  const pct = row.pct
  const priceCls = dirClass(row.chg ?? null, redUp)
  // 口径选择：摊薄（券商）/ 均价
  const showCost = diluted ? row.dilutedCost : row.avgCost
  const showPnl = diluted ? row.dilutedPnl : row.floatPnl
  const showPnlPct = diluted ? row.dilutedPnlPct : row.floatPnlPct
  const fmtQty = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10000) / 10000))
  // `title` 用来承载"口径"这类长解释：常驻正文只留一句短的（R1/R2）
  const pps = (label: string, value: React.ReactNode, meta?: React.ReactNode, title?: string): React.ReactElement =>
    React.createElement('div', { className: 'tw-pps', ...(title === undefined ? {} : { title }) },
      React.createElement('span', { className: 'k' }, label),
      React.createElement('span', { className: 'v' }, value),
      meta !== undefined ? React.createElement('span', { className: 'meta' }, meta) : null,
    )
  const pctMeta = (v: number | null, _direction: number | null): string =>
    v === null ? '率 —' : `率 ${v === 0 ? '' : v > 0 ? '▲' : '▼'}${Math.abs(v).toFixed(2)}%`
  return React.createElement(
    'div',
    {
      className: 'tw-posrow',
      tabIndex: 0,
      role: 'button',
      'aria-label': `${row.name} ${row.secid}，回车打开分时明细`,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          props.onOpenChart()
        }
      },
      onClick: (e: React.MouseEvent) => {
        // 行内还有 买/卖/明细/编辑/移除/迷你图 等按钮：点它们时不要连带触发整行
        if ((e.target as HTMLElement).closest('button,a,input,select,textarea') !== null) return
        props.onOpenChart()
      },
    },
    React.createElement('div', { className: 'tw-pos-main' },
      React.createElement('button', {
        className: 'tw-mini',
 // 开/高/低/振幅走 hover（缩略图太小，图上不加常驻文字）
        title: miniHover(row.name, props.mini),
        'aria-label': `${row.name} 分时明细`,
        onClick: props.onOpenChart,
      },
        React.createElement(MiniTrend, { values: props.mini?.values ?? [], avg: props.mini?.avg, up: props.mini?.up ?? null, width: 52, height: 20, redUp }),
      ),
      React.createElement('div', { className: 'tw-pos-title' },
        props.action !== undefined
          ? React.createElement('span', {
              className: 'tw-badge',
              style: { marginRight: 4, color: '#e8a33d', borderColor: '#e8a33d' },
              title: `${props.action.date} ${props.action.kind === 'ex' ? '除权除息' : '股权登记'}${props.action.note === '' ? '' : `：${props.action.note}`}\n` +
                '除权除息后数量与成本会变 —— 请在「调整」里按券商实际到账录入（本插件不自动改账）',
            }, `${props.action.daysUntil <= 0 ? '除权' : `${props.action.daysUntil} 天后除权`}`)
          : null,
        row.skippedLedger !== undefined && row.skippedLedger > 0
          ? React.createElement('span', {
              className: 'tw-badge',
              style: { marginRight: 4, color: 'var(--tw-up)', borderColor: 'var(--tw-up)' },
              title: `${row.skippedLedger} 条流水未能应用（账本里有、快照没算进来）：\n${(row.skippedNotes ?? []).join('\n')}`,
            }, `流水 ${row.skippedLedger} 条未应用`)
          : null,
        React.createElement('b', null, row.name),
        React.createElement('small', null, `${row.secid}${pct !== null ? ` · ${fmtPct(pct)}` : ''}`),
      ),
      React.createElement('div', { className: 'tw-pos-price' },
        React.createElement('span', { className: 'px ' + priceCls }, fmtPrice(price)),
        React.createElement('span', {
          className: 'meta',
          title: [
            // M6：全文只在 quoteState.ts 的常量里留一处，这里引用它；S4：删掉与徽标「总额不含」矛盾的"按 0 计"
            props.noSource ? NO_SOURCE_TITLE : null,
            row.costUnknown === true
              ? '成本未录入（新建持仓后只在「调整」里填了数量）：市值照算，但盈亏、盈亏率与已实现显示 —。用行内「调整」补上成本价即可。'
              : null,
          ].filter((x) => x !== null).join('\n') || undefined,
          // 有缺失时补可聚焦入口（title 是鼠标专属，键盘/触屏拿不到）——P1-5
          ...(props.noSource || row.costUnknown === true
            ? {
                tabIndex: 0,
                role: 'note',
                'aria-label': [
                  props.noSource ? NO_SOURCE_LABEL : null,
                  row.costUnknown === true ? '成本未录入：市值照算，盈亏与盈亏率显示 —' : null,
                ].filter((x) => x !== null).join('；'),
              }
            : {}),
        }, `数量 ${fmtQty(row.qty)} · ${row.costUnknown === true ? '成本 —（未录入）' : `成本 ${fmtPrice(showCost)}`}${
          price === null ? ` · ${props.noSource ? NO_SOURCE_LABEL : PENDING_LABEL}` : ''
        }`),
      // （"怎么补成本"只在成本格这一处给，S20）
      ),
      React.createElement('div', { className: 'tw-actions' },
        React.createElement(Btn, { onClick: () => props.onTrade('buy') }, '买'),
        React.createElement(Btn, { onClick: () => props.onTrade('sell') }, '卖'),
        React.createElement(Btn, { onClick: () => props.onTrade('adjust'), title: '调整数量/成本', 'data-verb': 'adjust' }, '调整'),
        React.createElement(MoreMenu, {
          ariaLabel: `${row.name} 更多操作`,
          title: '更多',
          items: [
            { label: '交易明细', onClick: props.onDetail },
            { label: '调整数量/成本', onClick: () => props.onTrade('adjust') },
            { label: '编辑 / 移动', onClick: props.onEdit },
            // 确认与数量校验统一由父级的 onRemove 处理，避免二次确认
            { label: '移除持仓', danger: true, onClick: props.onRemove },
          ],
        }),
      ),
    ),
    React.createElement('div', { className: 'tw-pos-grid' },
      pps('市值', React.createElement('span', null, fmtAmt(row.mv)),
        `占比 ${props.weight === null ? '—' : (props.weight * 100).toFixed(2) + '%'} · 成本 ${
          row.costUnknown === true ? '—（未录入）' : fmtPrice(showCost)
        }`),
      pps(diluted ? '持仓盈亏' : '浮动盈亏',
        React.createElement('span', { className: dirClass(showPnl, redUp) }, fmtMoneySigned(showPnl)),
        // 成本未录入时不给"率"（分母未知）；"怎么补成本"全局只说一处（S20：留在下面的成本格 title 里）
        row.costUnknown === true
          ? React.createElement('span', { className: 'tw-muted' }, '成本未录入，盈亏不可算')
          : React.createElement('span', { className: dirClass(showPnl, redUp) }, pctMeta(showPnlPct, showPnl))),
      pps('当日盈亏', React.createElement('span', { className: dirClass(row.dayPnl, redUp) }, fmtMoneySigned(row.dayPnl)),
        React.createElement('span', { className: dirClass(row.dayPnl, redUp) }, pctMeta(row.dayPnlPct, row.dayPnl))),
      // 年初至今（YTD）：这是**标的**的年内涨幅，不是这笔持仓的收益 —— 口径写在 tooltip 里
      // （前复权序列；指数/期货按原始价格）。取不到显示 — 并给原因，不用 0 顶替。
      pps('标的年初至今',
        React.createElement('span', {
          className: `tw-ytd ${dirClass(props.ytd?.ytd ?? null, redUp)}`,
          title: ytdTooltip(row.name, props.ytd, props.ytdLoaded, { stale: props.ytdStale, source: props.ytdSource }),
          // 算不出时才可聚焦：可计算的行不需要多一个 Tab 停靠点
          ...(props.ytd?.ytd == null
            ? { tabIndex: 0, role: 'note', 'aria-label': ytdTooltip(row.name, props.ytd, props.ytdLoaded, { stale: props.ytdStale, source: props.ytdSource }) }
            : {}),
        }, ytdText(props.ytd)),
        // M2：常态基准（年初）不占位 —— tooltip 里已写；只有"年内上市、基准是上市首日"必须常显
        //（否则这个数会被读成"年初至今"而高估）。基准缺失时也不再写"本轮未算（悬停看原因）"：
        // 那个字为零信息（R3），原因在 tooltip 里。
        ytdBaseNote(props.ytd?.baseDate, props.ytd?.baseKind)),
      pps(diluted ? '累计已实现（已计入上栏）' : '累计已实现',
        React.createElement('span', { className: 'tw-dim' }, fmtMoneySigned(row.realized)),
 // 行内只给短句（80 字解释只留面板级一处，避免同一句在每行重复）
        (row.realizedUnknownQty ?? 0) > 0
          ? React.createElement('span', { className: 'tw-muted', title: realizedUnknownNote(row.realizedUnknownQty ?? 0) },
              realizedUnknownShort(row.realizedUnknownQty ?? 0))
          : row.costUnknown === true
            ? React.createElement('span', { className: 'tw-muted', title: '成本未录入：市值照算，但盈亏、盈亏率与已实现显示 —（拿 0 当成本会把全部市值算成盈利）' },
                '成本未录入 → 已实现不可算')
            : undefined),
 // + M1：可用（可卖）数量。口径（T+1/T+0）进 title —— 此前两个分支**每只持仓都写一行**
      // 且今日无买入时"今日买入 0 份…故可用少于持仓"是假话（R3）。正文只在真有不可卖部分时给一句短的。
      pps('可用（可卖）',
        React.createElement('span', { className: row.availableQty < row.qty ? 'tw-flat' : undefined },
          `${fmtQty(row.availableQty)}${row.availableQty < row.qty ? ` / ${fmtQty(row.qty)}` : ''}`),
        availableLockNote(row.qty, row.availableQty),
        row.t0
          ? 'T+0：当日买入当日可卖（ETF/LOF、港股、美股等）'
          : 'T+1：今日买入的部分当日不可卖，所以"可用（可卖）"可能少于持仓'),
 // + M4：费用列。未录费用（fees=0）时整条说明不出（值列已有 0.00）；
      // 有费用时压成 `占成交额 X%`（"累计"与成交额列重复，R1）
      pps('累计费用',
        React.createElement('span', { className: 'tw-dim' }, fmtAmt(row.fees)),
        feeShareNote(row.fees, row.feeShare),
        '费用 ÷ 累计成交额（买卖双向，含佣金/手续费）'),
    ),
  )
}

/**
 * 持仓行缩略图的 hover 说明（P1-1）。与自选页同一口径：
 * 振幅 = (高 − 低) ÷ 昨收；缺昨收时不给振幅（分母不对等于给了一个错的波动幅度）。
 */
function miniHover(name: string, mini: { open?: number | null; high?: number | null; low?: number | null; prePrice?: number | null } | undefined): string {
  const head = `${name} 分时 · 点击打开明细`
  if (mini === undefined) return head
  const parts: string[] = []
  if (mini.open != null) parts.push(`开 ${mini.open.toFixed(3)}`)
  if (mini.high != null) parts.push(`高 ${mini.high.toFixed(3)}`)
  if (mini.low != null) parts.push(`低 ${mini.low.toFixed(3)}`)
  if (isUsableBaseline(mini.prePrice) && mini.high != null && mini.low != null) {
    parts.push(`振幅 ${(((mini.high - mini.low) / mini.prePrice) * 100).toFixed(2)}%`)
  } else {
    parts.push('振幅 —（上游未给昨收）')
  }
  return `${head}\n${parts.join(' · ')}`
}

/**
 * 折算口径设置（P1-11）。
 *
 * 只提供两种**可验证**的档位：
 *   - 不折算：总额只含 A股，港股/美股逐项进 `unpriced` 并说明原因（默认）；
 *   - 固定汇率：由用户填写 `1 外币 = N 人民币`，口径完全透明、离线可用。
 *
 * 「实时汇率」不出现在这里：汇率源尚未验证连通性与字段口径，摆一个点了没用的档位
 * 比不摆更坏（用户会以为开了实时折算，而数字其实没变）。宿主侧也会拒绝该档。
 */
function FxModal(props: {
  mode: 'none' | 'fixed' | 'live'
  rates: Partial<Record<'HKD' | 'USD', number>>
  setPrefs: (patch: Partial<PortPrefs>) => void
  onClose: () => void
  notify?: (text: string) => void
}): React.ReactElement {
  const [hkd, setHkd] = useState(props.rates.HKD === undefined ? '' : String(props.rates.HKD))
  const [usd, setUsd] = useState(props.rates.USD === undefined ? '' : String(props.rates.USD))
  const [err, setErr] = useState<string | null>(null)
  const fixed = props.mode === 'fixed'

  const save = (): void => {
    const rates: Partial<Record<'HKD' | 'USD', number>> = {}
    for (const [cur, raw] of [['HKD', hkd], ['USD', usd]] as const) {
      const t = raw.trim()
      if (t === '') continue
      const n = Number(t)
      if (!Number.isFinite(n) || n < 0.01 || n > 100) {
        setErr(`${cur === 'HKD' ? '港元' : '美元'}汇率需要在 0.01–100 之间（填错数量级会得到完全错误的人民币市值）`)
        return
      }
      rates[cur] = n
    }
    if (Object.keys(rates).length === 0) {
      setErr('固定汇率档至少要填一个币种的汇率（都不填就等于不折算，请直接选上一档）')
      return
    }
    props.setPrefs({ fxMode: 'fixed', fxRates: rates })
    props.notify?.(
      `折算口径：固定汇率（${Object.entries(rates).map(([c, r]) => `1 ${c} = ${r}`).join('，')}）。` +
      '港/美股按此汇率折成人民币计入总额 —— 汇率变了数字就会变，因此它写在总额旁边。',
    )
    props.onClose()
  }

  const chooseNone = (): void => {
    props.setPrefs({ fxMode: 'none', fxRates: {} })
    props.notify?.('折算口径：不折算。总额只含 A股，港/美股逐项列在「不含 N 项」里（不按 1:1 加进去）。')
    props.onClose()
  }

  return React.createElement(Modal, { title: '跨市场折算口径（港股 / 美股）', onClose: props.onClose },
    React.createElement(ErrorNote, { error: err }),
    React.createElement('div', { className: 'tw-hint' },
      '默认「不折算」：总额只含 A股，港/美股以原币种计价、逐项列在「不含 N 项」里。' +
      '按 1:1 悄悄加进去会让总额看起来完整、其实错了 —— 因此只有这两种档位，没有第三种。',
    ),
    React.createElement('div', { className: 'tw-seg', style: { margin: '8px 0' } },
      React.createElement('button', { 'data-on': !fixed, onClick: chooseNone }, '不折算（只含 A股）'),
      React.createElement('button', { 'data-on': fixed, onClick: () => setErr(null) }, '固定汇率折算'),
    ),
    fixed
      ? React.createElement('div', null,
          React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 4 } },
            React.createElement(Field, { label: '1 港元 = ? 人民币' },
              React.createElement('input', { className: 'tw-input', value: hkd, inputMode: 'decimal', placeholder: '如 0.92', onChange: (e) => setHkd(e.target.value) }),
            ),
            React.createElement(Field, { label: '1 美元 = ? 人民币' },
              React.createElement('input', { className: 'tw-input', value: usd, inputMode: 'decimal', placeholder: '如 7.15', onChange: (e) => setUsd(e.target.value) }),
            ),
          ),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 } },
            React.createElement(Btn, { primary: true, onClick: save }, '保存并折算'),
          ),
        )
      : null,
    React.createElement('div', { className: 'tw-hint' },
      '实时汇率暂不可用：汇率源尚未验证连通性与字段口径（中间价还是即期、符号怎么写都没有确认）。' +
      '本插件不猜字段 —— 填一个你认可的汇率，比拿一条可能解析错的数据去算人民币市值安全得多。',
    ),
  )
}
