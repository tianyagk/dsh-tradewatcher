/** 自选 page: grouped watchlist with live quotes from the shared engine. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { QuoteRow, SuggestItem, WatchData } from '../shared/model.ts'
import { api } from './api.ts'
import { dirClass, fmtAmt, fmtPct, fmtPrice, fmtSigned, pctArrow } from './format.ts'
import { Btn, EmptyHint, ErrorNote, Field, Modal, MoreMenu, Skeleton, SuggestInput } from './ui.tsx'
import { MiniTrend } from './charts.tsx'
import { useMiniTrends } from './mini.ts'
import { QuoteDrawer } from './QuoteDrawer.tsx'

type ModalState =
  | { kind: 'addGroup' }
  | { kind: 'renameGroup'; groupId: string; name: string }
  | { kind: 'noteGroup'; groupId: string; name: string; note: string }
  | { kind: 'addItem'; groupId: string; groupName: string }
  | { kind: 'moveItem'; groupId: string; groupName: string; itemId: string; itemName: string; secid: string }
  | null

export function WatchlistPage(props: {
  quotes: Record<string, QuoteRow>
  quotesReady: boolean
  prefs: { redUp: boolean }
  onSymbols: (ids: string[]) => void
}): React.ReactElement {
  const { quotes, quotesReady, prefs, onSymbols } = props
  const [watch, setWatch] = useState<WatchData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modal, setModal] = useState<ModalState>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [showArchived, setShowArchived] = useState(false)
  const [drawer, setDrawer] = useState<{ secid: string; name: string } | null>(null)
  const miniIds = React.useMemo(() => {
    const ids = new Set<string>()
    if (watch !== null) for (const it of watch.items) ids.add(it.secid)
    return [...ids]
  }, [watch])
  const minis = useMiniTrends(miniIds, true)
  const [inds, setInds] = useState<Record<string, { name: string; pct: number | null }>>({})
  const indSeq = useRef(0)
  useEffect(() => {
    if (watch === null) return
    const secs = [...new Set(watch.items.map((i) => i.secid))]
    if (secs.length === 0) {
      setInds({})
      return
    }
    const n = ++indSeq.current
    api
      .industries(secs)
      .then((r) => {
        if (n === indSeq.current) setInds(r.map)
      })
      .catch(() => undefined)
    // 依赖 quotes：每次行情轮询后同步刷新板块涨幅与 alpha
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch, quotes])

  const reload = useCallback(() => {
    api
      .watch()
      .then((r) => {
        setWatch(r.watch)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    if (watch === null) return
    const ids = [...new Set(watch.items.filter((i) => i.groupId !== undefined).map((i) => i.secid))]
    onSymbols(ids)
  }, [watch, onSymbols])

  const mutate = (body: Parameters<typeof api.mutateWatch>[0], done?: () => void): void => {
    setError(null)
    api
      .mutateWatch(body)
      .then((r) => {
        setWatch(r.watch)
        done?.()
      })
      .catch((e: Error) => setError(e.message))
  }

  if (watch === null) return React.createElement('div', { className: 'tw-body' }, React.createElement(Skeleton, { lines: 4, height: 16 }))

  const groups = [...watch.groups].sort((a, b) => a.order - b.order)
  const active = groups.filter((g) => g.archived !== true)
  const archived = groups.filter((g) => g.archived === true)

  const itemsOf = (groupId: string): Array<{ id: string; groupId: string; name: string; secid: string; note?: string }> =>
    watch.items.filter((i) => i.groupId === groupId)

  return React.createElement(
    'div',
    { className: 'tw-body' },
    React.createElement(ErrorNote, { error }),
    React.createElement(
      'div',
      { className: 'tw-panel', style: { display: 'flex', alignItems: 'center', gap: 8 } },
      React.createElement('span', { className: 't' }, '自选分组'),
      archived.length > 0
        ? React.createElement(Btn, { onClick: () => setShowArchived((v) => !v) }, `已归档 ${archived.length}`)
        : null,
      React.createElement(Btn, { primary: true, onClick: () => setModal({ kind: 'addGroup' }) }, '+ 新建分组'),
    ),
    active.length === 0
      ? React.createElement(EmptyHint, { action: React.createElement(Btn, { primary: true, onClick: () => setModal({ kind: 'addGroup' }) }, '+ 新建分组') }, '暂无自选分组：新建分组后，往组里添加证券（支持搜索代码/名称）。')
      : null,
    active.map((g) => {
      const items = itemsOf(g.id)
      const isCollapsed = collapsed[g.id] === true
      return React.createElement(
        'div',
        { key: g.id, className: 'tw-group' },
        React.createElement('div', { className: 'tw-group-h' },
          React.createElement('div', { className: 'tw-gh-row' },
          React.createElement('button', {
            className: 'gname',
            title: isCollapsed ? '展开' : '折叠',
            'aria-label': `${isCollapsed ? '展开' : '折叠'}分组 ${g.name}`,
            onClick: () => setCollapsed((s) => ({ ...s, [g.id]: !isCollapsed })),
          }, isCollapsed ? '▸ ' : '▾ '),
          React.createElement('span', { className: 'gname' }, g.name),
          React.createElement('span', { className: 'tw-muted', style: { fontSize: 11 } }, `${items.length} 只`),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement(Btn, { onClick: () => setModal({ kind: 'addItem', groupId: g.id, groupName: g.name }) }, '添加证券'),
          React.createElement(MoreMenu, {
            ariaLabel: `分组 ${g.name} 更多操作`,
            items: [
              { label: '重命名分组', onClick: () => setModal({ kind: 'renameGroup', groupId: g.id, name: g.name }) },
              { label: '编辑备注', onClick: () => setModal({ kind: 'noteGroup', groupId: g.id, name: g.name, note: g.note ?? '' }) },
              {
                label: '删除分组（归档）',
                danger: true,
                onClick: () => {
                  if (window.confirm(`归档删除分组「${g.name}」？组内条目保留并可随分组恢复。`)) mutate({ op: 'archiveGroup', groupId: g.id })
                },
              },
            ],
          }),
          ),
        ),
        isCollapsed || items.length === 0
          ? null
          : items.map((it) => {
              const q = quotes[it.secid]
              const cls = dirClass(q?.chg ?? null, prefs.redUp)
              const pct = q?.pct ?? null
              const mini = minis[it.secid]
              const ind = inds[it.secid]
              const stockPct = q?.pct ?? null
              const boardPct = ind?.pct ?? null
              const alpha =
                stockPct !== null && boardPct !== null ? Math.round((stockPct - boardPct) * 100) / 100 : null
              const hasQuote = q !== undefined && q.price !== null
              return React.createElement(
                'div',
                {
                  key: it.id,
                  className: 'tw-wrow',
                  tabIndex: 0,
                  role: 'button',
                  'aria-label': `${it.name} ${it.secid}，回车打开分时明细`,
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setDrawer({ secid: it.secid, name: it.name })
                    }
                  },
                },
                React.createElement('button', {
                  className: 'tw-mini',
                  title: `${it.name} 分时 · 点击打开明细`,
                  onClick: () => setDrawer({ secid: it.secid, name: it.name }),
                },
                  React.createElement(MiniTrend, { values: mini?.values ?? [], up: mini?.up ?? null, width: 56, height: 20, redUp: prefs.redUp }),
                ),
                React.createElement('div', { className: 'nm' },
                  React.createElement('div', null,
                    React.createElement('b', null, it.name),
                    React.createElement('span', { className: 'tw-code' }, it.secid),
                  ),
                  React.createElement('small', { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
                    q?.amount !== null && q?.amount !== undefined && q.amount > 0
                      ? React.createElement('span', null, `额 ${fmtAmt(q.amount)}`)
                      : null,
                    ind !== undefined
                      ? React.createElement(React.Fragment, null,
                          React.createElement('span', { className: 'tw-dim' }, `行业 ${ind.name}`),
                          ind.pct !== null
                            ? React.createElement('span', { className: dirClass(ind.pct, prefs.redUp) }, fmtPct(ind.pct))
                            : React.createElement('span', { className: 'tw-muted' }, '板块 —'),
                          React.createElement('span', { className: dirClass(alpha, prefs.redUp), style: { fontFamily: 'var(--tw-mono)' } },
                            `α ${alpha === null ? '—' : `${pctArrow(alpha)}${Math.abs(alpha).toFixed(2)}%`}`),
                        )
                      : null,
                    it.note !== undefined && it.note !== '' ? React.createElement('span', { className: 'tw-muted' }, it.note) : null,
                  ),
                ),
                hasQuote
                  ? React.createElement('div', { className: 'wq' },
                      React.createElement('span', { className: 'px ' + cls, style: { fontSize: 15, fontWeight: 650 } }, fmtPrice(q?.price ?? null)),
                      React.createElement('span', { className: 'chg ' + cls }, fmtSigned(q?.chg ?? null)),
                      React.createElement('span', { className: `tw-chg-chip ${pct === null ? 'tw-chip-flat' : pct >= 0 ? (prefs.redUp ? 'tw-chip-up' : 'tw-chip-down') : (prefs.redUp ? 'tw-chip-down' : 'tw-chip-up')}` }, fmtPct(pct)),
                    )
                  : quotesReady
                    ? React.createElement('div', { className: 'wq' }, React.createElement('span', { className: 'tw-muted' }, '暂无行情'))
                    : React.createElement('div', { className: 'wq' }, React.createElement('div', { className: 'tw-skel', style: { width: 76, height: 16 } })),
                React.createElement(MoreMenu, {
                  ariaLabel: `${it.name} 更多操作`,
                  title: '更多',
                  items: [
                    { label: '移动分组', onClick: () => setModal({ kind: 'moveItem', groupId: g.id, groupName: g.name, itemId: it.id, itemName: it.name, secid: it.secid }) },
                    { label: '移除', danger: true, onClick: () => mutate({ op: 'removeItem', itemId: it.id }) },
                  ],
                }),
              )
            }),
      )
    }),
    showArchived && archived.length > 0
      ? React.createElement('div', { className: 'tw-panel', style: { opacity: 0.72 } },
          React.createElement('div', { className: 'tw-panel-h' }, React.createElement('span', { className: 't tw-dim' }, '已归档分组')), 
          archived.map((g) =>
            React.createElement('div', { key: g.id, className: 'tw-wrow' },
              React.createElement('div', { className: 'nm' }, React.createElement('b', null, g.name), React.createElement('small', null, `${itemsOf(g.id).length} 只（原条目保留）`)),
              React.createElement(Btn, { onClick: () => mutate({ op: 'restoreGroup', groupId: g.id }) }, '恢复'),
            ),
          ),
        )
      : null,
    modal !== null ? React.createElement(WatchModal, { key: `${modal.kind}:${(modal as { groupId?: string }).groupId ?? (modal as { itemId?: string }).itemId ?? 'n'}`, modal, groups: active, onClose: () => setModal(null), mutate }) : null,
    drawer !== null
      ? React.createElement(QuoteDrawer, { secid: drawer.secid, name: drawer.name, redUp: prefs.redUp, onClose: () => setDrawer(null) })
      : null,
  )
}

function WatchModal(props: {
  modal: NonNullable<ModalState>
  groups: Array<{ id: string; name: string }>
  onClose: () => void
  mutate: (body: Parameters<typeof api.mutateWatch>[0], done?: () => void) => void
}): React.ReactElement {
  const { modal, groups, onClose, mutate } = props
  const [name, setName] = useState(modal.kind === 'renameGroup' ? modal.name : '')
  const [note, setNote] = useState(modal.kind === 'noteGroup' ? modal.note : '')
  const [err, setErr] = useState<string | null>(null)
  const [targetGroup, setTargetGroup] = useState<string | null>(null)

  if (modal.kind === 'addGroup' || modal.kind === 'renameGroup' || modal.kind === 'noteGroup') {
    const isNote = modal.kind === 'noteGroup'
    return React.createElement(
      Modal,
      { title: modal.kind === 'addGroup' ? '新建分组' : modal.kind === 'renameGroup' ? '重命名分组' : '分组备注', onClose },
      React.createElement(ErrorNote, { error: err }),
      React.createElement(
        Field,
        { label: isNote ? '备注（200 字内）' : '分组名' },
        React.createElement('input', {
          className: 'tw-input',
          value: name,
          autoFocus: true,
          placeholder: modal.kind === 'addGroup' ? '如：科技成长' : undefined,
          onChange: (e) => setName(e.target.value),
        }),
      ),
      React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 } },
        React.createElement(Btn, { onClick: onClose }, '取消'),
        React.createElement(Btn, {
          primary: true,
          onClick: () => {
            if (modal.kind === 'addGroup') {
              if (name.trim() === '') { setErr('请输入分组名'); return }
              mutate({ op: 'addGroup', name }, onClose)
            } else if (modal.kind === 'renameGroup') {
              if (name.trim() === '') { setErr('请输入分组名'); return }
              mutate({ op: 'renameGroup', groupId: modal.groupId, name }, onClose)
            } else {
              mutate({ op: 'noteGroup', groupId: modal.groupId, note }, onClose)
            }
          },
        }, '保存'),
      ),
    )
  }
  if (modal.kind === 'addItem') {
    const pick = (item: SuggestItem): void => {
      setErr(null)
      mutate({ op: 'addItem', groupId: modal.groupId, secid: item.secid, symbolName: item.name }, onClose)
    }
    return React.createElement(
      Modal,
      { title: `添加证券到「${modal.groupName}」`, onClose },
      React.createElement(ErrorNote, { error: err }),
      React.createElement(SuggestInput, { onPick: pick, autoFocus: true }),
      React.createElement('div', { className: 'tw-hint' }, '支持 A股/港股/美股/ETF/基金/指数/期货主连/现货，如 688825、02155、510300、114.lhm'),
    )
  }
  if (modal.kind === 'moveItem') {
    const targets = groups.filter((g) => g.id !== modal.groupId)
    return React.createElement(
      Modal,
      { title: `移动「${modal.itemName}」`, onClose },
      React.createElement(ErrorNote, { error: err }),
      targets.length === 0
        ? React.createElement('div', { className: 'tw-hint' }, '没有其他可选分组（目标分组需先创建）。')
        : React.createElement(
            Field,
            { label: '目标分组' },
            React.createElement('select', { className: 'tw-input', value: targetGroup ?? '', onChange: (e) => setTargetGroup(e.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>,
              React.createElement('option', { value: '', disabled: true }, '选择分组…'),
              targets.map((g) => React.createElement('option', { key: g.id, value: g.id }, g.name)),
            ),
          ),
      React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 } },
        React.createElement(Btn, { onClick: onClose }, '取消'),
        React.createElement(Btn, {
          primary: true,
          disabled: targets.length === 0 || targetGroup === null,
          onClick: () => { if (targetGroup !== null) mutate({ op: 'moveItem', itemId: modal.itemId, groupId: targetGroup }, onClose) },
        }, '移动'),
      ),
    )
  }
  return React.createElement('div', null)
}
