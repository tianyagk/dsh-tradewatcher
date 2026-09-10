/** 持仓 page: ledger-driven portfolio groups + group/position trade history. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LedgerEntry,
  LedgerView,
  MutatePortBody,
  PortfolioView,
  PositionRow,
  QuoteRow,
  SuggestItem,
} from '../shared/model.ts'
import { api } from './api.ts'
import { dirClass, fmtAmt, fmtPct, fmtPrice, fmtSigned } from './format.ts'
import { Btn, EmptyHint, ErrorNote, Field, Modal, MoreMenu, Skeleton, SuggestInput } from './ui.tsx'
import { MiniTrend } from './charts.tsx'
import { useMiniTrends } from './mini.ts'
import { QuoteDrawer } from './QuoteDrawer.tsx'

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
  prefs: { redUp: boolean }
  quotes: Record<string, QuoteRow>
  onSymbols: (ids: string[]) => void
}): React.ReactElement {
  const { active, refreshSec, prefs, quotes, onSymbols } = props
  const redUp = prefs.redUp
  const [view, setView] = useState<PortfolioView | null>(null)
  const [stale, setStale] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [showArchived, setShowArchived] = useState(false)
  const [modal, setModal] = useState<ModalState>(null)
  const [ledgerTarget, setLedgerTarget] = useState<LedgerTarget>(null)
  const [ledgerEntries, setLedgerEntries] = useState<LedgerView[] | null>(null)
  const [drawer, setDrawer] = useState<{ secid: string; name: string } | null>(null)
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

  useEffect(() => {
    if (!active) return
    reload()
    const t = setInterval(reload, refreshSec * 1000)
    return () => clearInterval(t)
  }, [active, refreshSec, reload])

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

  const stat = (label: string, value: number, colored = true): React.ReactElement =>
    React.createElement('div', { className: 'tw-stat' },
      React.createElement('div', { className: 'k' }, label),
      React.createElement('div', { className: colored ? `v ${dirClass(value, redUp)}` : 'v' },
        colored ? fmtSigned(value) : value.toFixed(2)),
    )

  return React.createElement(
    'div',
    { className: 'tw-body' },
    React.createElement(ErrorNote, { error }),
    React.createElement('div', { className: 'tw-panel' },
      React.createElement('div', { className: 'tw-panel-h' },
        React.createElement('span', { className: 't' }, '持仓总览（实时行情）'),
        stale > 0 ? React.createElement('span', { className: 'tw-badge' }, `${stale} 只行情暂缺`) : null,
        React.createElement('span', {
          className: 'tw-iconbtn',
          style: { cursor: 'help' },
          title: '成本=移动加权含费用；当日盈亏=隔夜(现价−昨收)×数量+日内买卖差额，费用计入。分组可增删改，操作记录全部写入流水；会话中可用 tradewatcher_portfolio / tradewatcher_ledger 分析。',
          'aria-label': '口径说明',
        }, 'ⓘ'),
        React.createElement(Btn, { onClick: reload }, '刷新'),
      ),
      React.createElement('div', { className: 'tw-statrow' },
        stat('总市值', grand.totalMv, false),
        stat('浮动盈亏', grand.floatPnl),
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
      const rows = view.positions.filter((p) => p.groupId === grp.id)
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
            React.createElement('span', { className: dirClass(grp.floatPnl, redUp) }, '浮盈 ', fmtSigned(grp.floatPnl)),
            React.createElement('span', { className: dirClass(grp.dayPnl, redUp) }, '当日 ', fmtSigned(grp.dayPnl)),
            React.createElement('span', { className: 'tw-dim' }, '已实现 ', fmtSigned(grp.realized)),
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
                  quote: quotes[row.secid],
                  mini: minis[row.secid],
                  onTrade: (verb) => setModal({ kind: 'trade', verb, pos: row, groupName: grp.name }),
                  onDetail: () => openLedger({ mode: 'pos', id: row.posId, title: `${row.name} 交易明细`, row }),
                  onOpenChart: () => setDrawer({ secid: row.secid, name: row.name }),
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
                React.createElement('small', null, `市值 ${fmtAmt(grp.totalMv)} · 浮盈 ${fmtSigned(grp.floatPnl)} · 流水保留`),
              ),
              React.createElement(Btn, { onClick: () => mutate({ op: 'restoreGroup', groupId: grp.id }) }, '恢复'),
              React.createElement(Btn, { onClick: () => openLedger({ mode: 'group', id: grp.id, title: grp.name }) }, '流水'),
            ),
          ),
        )
      : null,
    ledgerTarget !== null
      ? React.createElement(LedgerModal, { target: ledgerTarget, entries: ledgerEntries, redUp, onClose: () => openLedger(null) })
      : null,
    modal !== null
      ? React.createElement(PortModalHost, { modal, key: `${modal.kind}-${'pos' in modal ? modal.pos.posId : 'groupId' in modal ? modal.groupId : 'n'}`, redUp, quotes, onClose: () => setModal(null), mutate })
      : null,
    drawer !== null
      ? React.createElement(QuoteDrawer, { secid: drawer.secid, name: drawer.name, redUp, onClose: () => setDrawer(null) })
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

function LedgerModal(props: { target: { mode: string; id: string; title: string; row?: PositionRow }; entries: LedgerView[] | null; redUp: boolean; onClose: () => void }): React.ReactElement {
  const rows = props.entries ?? []
  const r = props.target.row
  const redUp = props.redUp
  const chip = (verb: LedgerView['verb']): string =>
    verb === 'buy' ? 'tw-chip-up' : verb === 'sell' ? 'tw-chip-down' : 'tw-chip-flat'
  const pctStrip = (): React.ReactNode | null => {
    if (r === undefined) return null
    return React.createElement('div', { className: 'tw-hint', style: { display: 'flex', gap: 14, flexWrap: 'wrap', margin: '0 0 8px', fontFamily: 'var(--tw-mono)' } },
      React.createElement('span', null, `持仓 ${r.qty} · 成本 ${fmtPrice(r.avgCost)} · 现价 ${fmtPrice(r.price)}`),
      React.createElement('span', { className: dirClass(r.floatPnl, redUp) }, `总盈亏 ${r.floatPnlPct === null || r.floatPnlPct === undefined ? '—' : (r.floatPnlPct === 0 ? '' : r.floatPnlPct > 0 ? '▲' : '▼') + Math.abs(r.floatPnlPct).toFixed(2) + '%'}`),
      React.createElement('span', { className: dirClass(r.dayPnl, redUp) }, `当日 ${r.dayPnlPct === null || r.dayPnlPct === undefined ? '—' : (r.dayPnlPct === 0 ? '' : r.dayPnlPct > 0 ? '▲' : '▼') + Math.abs(r.dayPnlPct).toFixed(2) + '%'}`),
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
  mini: { values: number[]; up: boolean | null } | undefined
  onTrade: (verb: 'buy' | 'sell' | 'adjust') => void
  onDetail: () => void
  onOpenChart: () => void
  onEdit: () => void
  onRemove: () => void
}): React.ReactElement {
  const { row, redUp } = props
  const price = row.price
  const pct = row.pct
  const priceCls = dirClass(row.chg ?? null, redUp)
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
    },
    React.createElement('div', { className: 'tw-pos-main' },
      React.createElement('button', {
        className: 'tw-mini',
        title: `${row.name} 分时 · 点击打开明细`,
        'aria-label': `${row.name} 分时明细`,
        onClick: props.onOpenChart,
      },
        React.createElement(MiniTrend, { values: props.mini?.values ?? [], up: props.mini?.up ?? null, width: 52, height: 20, redUp }),
      ),
      React.createElement('div', { className: 'tw-pos-title' },
        React.createElement('b', null, row.name),
        React.createElement('small', null, `${row.secid}${pct !== null ? ` · ${fmtPct(pct)}` : ''}`),
      ),
      React.createElement('div', { className: 'tw-pos-price' },
        React.createElement('span', { className: 'px ' + priceCls }, fmtPrice(price)),
        React.createElement('span', { className: 'meta' }, `数量 ${fmtQty(row.qty)} · 成本 ${fmtPrice(row.avgCost)}${price === null ? ' · 行情暂缺' : ''}`),
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
      pps('市值', React.createElement('span', null, fmtAmt(row.mv))),
      pps('浮动盈亏', React.createElement('span', { className: dirClass(row.floatPnl, redUp) }, fmtSigned(row.floatPnl)),
        React.createElement('span', { className: dirClass(row.floatPnl, redUp) }, pctMeta(row.floatPnlPct, row.floatPnl))),
      pps('当日盈亏', React.createElement('span', { className: dirClass(row.dayPnl, redUp) }, fmtSigned(row.dayPnl)),
        React.createElement('span', { className: dirClass(row.dayPnl, redUp) }, pctMeta(row.dayPnlPct, row.dayPnl))),
      pps('累计已实现', React.createElement('span', { className: 'tw-dim' }, fmtSigned(row.realized))),
    ),
  )
}
