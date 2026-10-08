/** 持仓 page: ledger-driven portfolio groups + group/position trade history. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LedgerEntry,
  LedgerView,
  MutatePortBody,
  PortfolioView,
  PortPrefs,
  PositionRow,
  QuoteRow,
  SuggestItem,
} from '../shared/model.ts'
import { DEFAULT_PREFS } from '../shared/model.ts'
import { api } from './api.ts'
import { dirClass, fmtAmt, fmtMoneySigned, fmtPct, fmtPrice, fmtRaw } from './format.ts'
import { Btn, EmptyHint, ErrorNote, Field, Modal, MoreMenu, Skeleton, SuggestInput } from './ui.tsx'
import { MiniTrend } from './charts.tsx'
import { useMiniTrends, type MiniData } from './mini.ts'
import { SortBar } from './SortBar.tsx'
import { PORT_SORT_HINT, PORT_SORT_KEYS, PORT_SORT_LABEL, normalizeSortState, sortPositions, weightOf, type PortSortKey } from './sort.ts'

const VERB_LABEL: Record<LedgerEntry['verb'], string> = {
  buy: '买入',
  sell: '卖出',
  adjust: '调整',
  add: '新建持仓',
  remove: '移除持仓',
  gcreate: '新建分组',
  grename: '分组改名',
  gdelete: '归档分组',
  grestore: '还原分组',
  gmove: '移动/编辑',
  pnote: '备注',
}

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
  const [backupOpen, setBackupOpen] = useState(false)
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
      React.createElement('div', { className: 'tw-panel-h' },
        React.createElement('span', { className: 't' }, '持仓总览（实时行情）'),
        stale > 0
          ? React.createElement('span', {
              className: 'tw-badge',
              // 分组/总览的市值与盈亏把无价持仓按 0 计入 —— 只说"N 只行情暂缺"不够，
              // 必须说清"下面那些总额不含它们"，否则数字看着完整其实缺一块
              title: `有 ${stale} 只持仓当前没有价格（行情源未给出），它们在分组与总览的市值/盈亏里按 0 计入；具体标的见各行「暂无可用行情源」标记`,
            }, `${stale} 只无价 · 总额不含`)
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
        React.createElement(SortBar<PortSortKey>, {
          keys: PORT_SORT_KEYS,
          labels: PORT_SORT_LABEL,
          hints: PORT_SORT_HINT,
          state: portSort,
          onChange: (next) => setPrefs({ portSort: next }),
          ariaLabel: '持仓排序',
        }),
        React.createElement(Btn, { onClick: () => setBackupOpen(true), title: '导出/导入 JSON（换机、备份）' }, '备份'),
        React.createElement(Btn, { onClick: reload }, '刷新'),
      ),
      backupOpen
        ? React.createElement(BackupModal, {
            onClose: () => setBackupOpen(false),
            notify: props.notify,
            onDone: () => { void reload() },
          })
        : null,
      unpricedOpen && unpriced.length > 0
        ? React.createElement('div', { className: 'tw-hint', style: { padding: '4px 2px 0' } },
            `以下 ${unpriced.length} 项不计入总额与盈亏（口径：fxMode=${view?.fxMode ?? 'none'}，总额仅含 A股；未折算的市值合计 ${fmtAmt(view?.unpricedMv ?? 0)}）：`,
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
            : rows.map((row) =>
                React.createElement(PosRow, {
                  key: row.posId,
                  row,
                  redUp,
                  diluted,
                  weight: weightOf(row.mv, grand.totalMv),
                  quote: quotes[row.secid],
                  noSource: missing?.has(row.secid.toUpperCase()) === true,
                  mini: minis[row.secid],
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
  const hint =
    verb === 'buy'
      ? `预计投入 ≈ ${fmtAmt(qN * pN + fN)}（费用计入摊薄成本）`
      : verb === 'sell'
        ? `预计回收 ≈ ${fmtAmt(qN * pN - fN)} · 现持有 ${pos.qty}`
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
                    `${new Date(r.ts).toLocaleString('zh-CN', { hour12: false })}${r.groupName !== null && r.posName !== null ? ` · ${r.groupName}` : ''}${r.actor === 'tool' ? ' · 会话操作' : ''}`,
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
  const pps = (label: string, value: React.ReactNode, meta?: React.ReactNode): React.ReactElement =>
    React.createElement('div', { className: 'tw-pps' },
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
        // P1-1：开/高/低/振幅走 hover（缩略图太小，图上不加常驻文字）
        title: miniHover(row.name, props.mini),
        'aria-label': `${row.name} 分时明细`,
        onClick: props.onOpenChart,
      },
        React.createElement(MiniTrend, { values: props.mini?.values ?? [], avg: props.mini?.avg, up: props.mini?.up ?? null, width: 52, height: 20, redUp }),
      ),
      React.createElement('div', { className: 'tw-pos-title' },
        React.createElement('b', null, row.name),
        React.createElement('small', null, `${row.secid}${pct !== null ? ` · ${fmtPct(pct)}` : ''}`),
      ),
      React.createElement('div', { className: 'tw-pos-price' },
        React.createElement('span', { className: 'px ' + priceCls }, fmtPrice(price)),
        React.createElement('span', {
          className: 'meta',
          title: props.noSource ? '东财、腾讯、新浪三个源都没有返回该标的的可用价格；市值/盈亏在无价时按成本口径暂以 0 计' : undefined,
        }, `数量 ${fmtQty(row.qty)} · 成本 ${fmtPrice(showCost)}${
          price === null ? (props.noSource ? ' · 暂无可用行情源' : ' · 行情暂缺') : ''
        }`),
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
        `占比 ${props.weight === null ? '—' : (props.weight * 100).toFixed(2) + '%'} · 成本 ${fmtPrice(showCost)}`),
      pps(diluted ? '持仓盈亏' : '浮动盈亏',
        React.createElement('span', { className: dirClass(showPnl, redUp) }, fmtMoneySigned(showPnl)),
        React.createElement('span', { className: dirClass(showPnl, redUp) }, pctMeta(showPnlPct, showPnl))),
      pps('当日盈亏', React.createElement('span', { className: dirClass(row.dayPnl, redUp) }, fmtMoneySigned(row.dayPnl)),
        React.createElement('span', { className: dirClass(row.dayPnl, redUp) }, pctMeta(row.dayPnlPct, row.dayPnl))),
      pps(diluted ? '累计已实现（已计入上栏）' : '累计已实现',
        React.createElement('span', { className: 'tw-dim' }, fmtMoneySigned(row.realized))),
      // P1-5：可用（可卖）数量。A股 T+1（今日买入当日不可卖）/ ETF·港股·美股 T+0 —— 口径写在 title 里，
      // 否则"持有 1000 可卖 800"看起来就像算错了
      pps('可用（可卖）',
        React.createElement('span', { className: row.availableQty < row.qty ? 'tw-flat' : undefined },
          `${fmtQty(row.availableQty)}${row.availableQty < row.qty ? ` / ${fmtQty(row.qty)}` : ''}`),
        row.t0
          ? 'T+0：当日买入当日可卖（ETF/LOF、港股、美股等）'
          : `T+1：今日买入 ${fmtQty(Math.max(0, row.qty - row.availableQty))} 份当日不可卖，故可用少于持仓`),
      // P1-5：费用列。给绝对金额的同时给占比 —— 没有参照物的手续费数看不出贵不贵
      pps('累计费用',
        React.createElement('span', { className: 'tw-dim' }, fmtAmt(row.fees)),
        row.feeShare === null
          ? '尚无成交，占比不可算（不用 0 顶替）'
          : `占累计成交额 ${row.turnover > 0 ? fmtAmt(row.turnover) : '—'} 的 ${row.feeShare.toFixed(3)}%`),
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
  if (mini.prePrice != null && mini.prePrice > 0 && mini.high != null && mini.low != null) {
    parts.push(`振幅 ${(((mini.high - mini.low) / mini.prePrice) * 100).toFixed(2)}%`)
  } else {
    parts.push('振幅 —（上游未给昨收）')
  }
  return `${head}\n${parts.join(' · ')}`
}
