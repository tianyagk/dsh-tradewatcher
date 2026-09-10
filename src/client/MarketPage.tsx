/** A股大盘行情: index overview + breadth/amount stats, sector & ETF boards,
 *  money-flow ranking (boards sorted by main-capital inflow), stock search
 *  with detail card + intraday chart. */
import React, { useCallback, useEffect, useState } from 'react'
import type { BoardRow, QuoteRow, StockDetail, TrendData } from '../shared/model.ts'
import { api } from './api.ts'
import { dirClass, fmtAmt, fmtBig, fmtPct, fmtPrice, fmtSigned } from './format.ts'
import { Btn, ErrorNote, Modal, SuggestInput } from './ui.tsx'
import { Sparkline } from './charts.tsx'
import type { PortPrefs } from '../shared/model.ts'

type Scope = 'industry' | 'concept' | 'etf'
type Sort = 'pct' | 'money' | 'amount'

const SCOPE_LABEL: Record<Scope, string> = { industry: '行业板块', concept: '概念板块', etf: 'ETF排行' }

export function MarketPage(props: {
  quotes: Record<string, QuoteRow>
  prefs: PortPrefs
}): React.ReactElement {
  const { quotes, prefs } = props
  const redUp = prefs.redUp
  const [scope, setScope] = useState<Scope>('industry')
  const [sort, setSort] = useState<Sort>('pct')
  const [rows, setRows] = useState<BoardRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [boardLoading, setBoardLoading] = useState(false)
  const [boardError, setBoardError] = useState<string | null>(null)
  const [pick, setPick] = useState<{ secid: string } | null>(null)
  const [detail, setDetail] = useState<StockDetail | null>(null)
  const [trend, setTrend] = useState<TrendData | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const loadBoard = useCallback((s: Scope, sortBy: Sort, pn: number, append: boolean) => {
    setBoardLoading(true)
    api
      .board(s, sortBy, pn)
      .then((r) => {
        setBoardError(null)
        setTotal(r.total)
        setRows((prev) => (append ? [...prev, ...r.rows] : r.rows))
        setPage(pn)
      })
      .catch((e: Error) => setBoardError(e.message))
      .finally(() => setBoardLoading(false))
  }, [])

  useEffect(() => {
    setRows([])
    setPage(1)
    loadBoard(scope, sort, 1, false)
  }, [scope, sort, loadBoard])

  // Breadth & turnover from the two composite indices (full-market counters).
  const sh = quotes['1.000001']
  const sz = quotes['0.399001']
  const upSum = (sh?.up ?? 0) + (sz?.up ?? 0)
  const downSum = (sh?.down ?? 0) + (sz?.down ?? 0)
  const evenSum = (sh?.even ?? 0) + (sz?.even ?? 0)
  const amountSum = (sh?.amount ?? 0) + (sz?.amount ?? 0)
  const breadthOk = sh?.up !== null && sh?.up !== undefined && sh.up !== null

  const cnIndices: Array<{ secid: string; name: string }> = [
    { secid: '1.000001', name: '上证指数' },
    { secid: '0.399001', name: '深证成指' },
    { secid: '0.399006', name: '创业板指' },
    { secid: '1.000688', name: '科创50' },
    { secid: '1.000300', name: '沪深300' },
    { secid: '1.000905', name: '中证500' },
  ]

  const openDetail = (secid: string): void => {
    setPick({ secid })
    setDetail(null)
    setTrend(null)
    setDetailLoading(true)
    setDetailError(null)
    api
      .detail(secid)
      .then((r) => setDetail(r.detail))
      .catch((e: Error) => setDetailError(e.message))
    api
      .trend(secid)
      .then((r) => setTrend(r.trend))
      .catch(() => undefined)
      .finally(() => setDetailLoading(false))
  }

  const statCell = (label: string, v: React.ReactNode, cls?: string): React.ReactElement =>
    React.createElement('div', { className: 'tw-stat' },
      React.createElement('div', { className: 'k' }, label),
      React.createElement('div', { className: `v ${cls ?? ''}` }, v),
    )

  return React.createElement(
    'div',
    { className: 'tw-body' },
    React.createElement('div', { className: 'tw-panel' },
      React.createElement('div', { className: 'tw-panel-h' },
        React.createElement('span', { className: 't' }, 'A股全景'),
        React.createElement('span', { className: 'tw-muted' }, '沪深两市'),
      ),
      React.createElement('div', { className: 'tw-statrow' },
        statCell('上涨', upSum, breadthOk ? (redUp ? 'tw-up' : 'tw-down') : ''),
        statCell('下跌', downSum, breadthOk ? (redUp ? 'tw-down' : 'tw-up') : ''),
        statCell('平盘', evenSum),
        React.createElement('div', { className: 'tw-stat-sep' }),
        statCell('两市成交额', amountSum > 0 ? `${fmtAmt(amountSum)}` : '—'),
        statCell('上证', sh?.price !== undefined && sh?.price !== null ? fmtPrice(sh.price) : '—', dirClass(sh?.chg ?? null, redUp)),
        statCell('深成', sz?.price !== undefined && sz?.price !== null ? fmtPrice(sz.price) : '—', dirClass(sz?.chg ?? null, redUp)),
      ),
      React.createElement('div', { className: 'tw-tablewrap' },
        React.createElement('table', { className: 'tw-table', style: { minWidth: 560 } },
          React.createElement('thead', null,
            React.createElement('tr', null,
              React.createElement('th', null, '指数'),
              React.createElement('th', null, '现价'),
              React.createElement('th', null, '涨跌'),
              React.createElement('th', null, '幅度'),
              React.createElement('th', null, '上涨/下跌'),
              React.createElement('th', null, '成交额'),
            ),
          ),
          React.createElement('tbody', null,
            cnIndices.map((it) => {
              const q = quotes[it.secid]
              const cls = dirClass(q?.chg ?? null, redUp)
              return React.createElement('tr', {
                key: it.secid,
                className: 'tw-rowhover',
                style: { cursor: 'pointer' },
                tabIndex: 0,
                role: 'button',
                'aria-label': `${it.name} 详情`,
                onClick: () => openDetail(it.secid),
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openDetail(it.secid)
                  }
                },
              },
                React.createElement('td', { className: 'tl' }, it.name),
                React.createElement('td', null, fmtPrice(q?.price ?? null)),
                React.createElement('td', { className: cls }, fmtSigned(q?.chg ?? null)),
                React.createElement('td', null, React.createElement('span', { className: `tw-chg-chip ${q?.pct === null || q?.pct === undefined ? 'tw-chip-flat' : (q.pct >= 0) === redUp ? 'tw-chip-up' : 'tw-chip-down'}` }, fmtPct(q?.pct ?? null))),
                React.createElement('td', { className: 'tw-dim' },
                  q?.up !== null && q?.up !== undefined
                    ? React.createElement(React.Fragment, null,
                        React.createElement('span', { className: dirClass(1, redUp) }, String(q.up)),
                        ' / ',
                        React.createElement('span', { className: dirClass(-1, redUp) }, String(q.down ?? 0)),
                      )
                    : '—',
                ),
                React.createElement('td', null, fmtAmt(q?.amount ?? null)),
              )
            }),
          ),
        ),
      ),
    ),
    React.createElement('div', { className: 'tw-panel' },
      React.createElement('div', { className: 'tw-panel-h' },
        React.createElement('span', { className: 't' }, '板块 / 资金 / ETF'),
        React.createElement('div', { className: 'tw-seg' },
          (['industry', 'concept', 'etf'] as Scope[]).map((s) =>
            React.createElement('button', { key: s, 'data-on': scope === s, onClick: () => { setScope(s); setSort(s === 'etf' ? 'pct' : 'pct') } }, SCOPE_LABEL[s]),
          ),
        ),
        React.createElement('div', { style: { flex: 1 } }),
        scope === 'etf'
          ? React.createElement('div', { className: 'tw-seg' },
              React.createElement('button', { 'data-on': sort === 'pct', onClick: () => setSort('pct') }, '涨跌幅'),
              React.createElement('button', { 'data-on': sort === 'amount', onClick: () => setSort('amount') }, '成交额'),
            )
          : React.createElement('div', { className: 'tw-seg' },
              React.createElement('button', { 'data-on': sort === 'pct', onClick: () => setSort('pct') }, '涨跌幅'),
              React.createElement('button', { 'data-on': sort === 'money', onClick: () => setSort('money') }, '主力资金'),
            ),
      ),
      React.createElement(ErrorNote, { error: boardError }),
      React.createElement('div', { className: 'tw-tablewrap' },
        React.createElement('table', { className: 'tw-table', style: { minWidth: scope === 'etf' ? 500 : 640 } },
          React.createElement('thead', null,
            React.createElement('tr', null,
              React.createElement('th', null, scope === 'etf' ? '代码' : '#'),
              React.createElement('th', null, '名称'),
              React.createElement('th', null, scope === 'etf' ? '现价/涨跌' : '涨跌'),
              React.createElement('th', null, '幅度'),
              scope === 'etf'
                ? [React.createElement('th', { key: 'a' }, '成交额'), React.createElement('th', { key: 't' }, '换手')]
                : [React.createElement('th', { key: 'u' }, '上涨/下跌'), React.createElement('th', { key: 'l' }, '领涨股'), React.createElement('th', { key: 'm' }, '主力净流入')],
            ),
          ),
          React.createElement('tbody', null,
            rows.map((r, i) => {
              const cls = dirClass(r.pct ?? null, redUp)
              const clickable = scope === 'etf' && r.secid !== undefined
              return React.createElement('tr', {
                key: `${r.code}-${i}`,
                className: 'tw-rowhover',
                style: clickable ? { cursor: 'pointer' } : undefined,
                onClick: clickable && r.secid !== undefined ? () => openDetail(r.secid as string) : undefined,
                title: clickable ? '点击查看详情' : undefined,
                tabIndex: clickable ? 0 : undefined,
                role: clickable ? 'button' : undefined,
                'aria-label': clickable ? `${r.name} 详情` : undefined,
                onKeyDown: clickable
                  ? (e: React.KeyboardEvent) => {
                      if ((e.key === 'Enter' || e.key === ' ') && r.secid !== undefined) {
                        e.preventDefault()
                        openDetail(r.secid)
                      }
                    }
                  : undefined,
              },
                React.createElement('td', { className: 'tl tw-dim' }, scope === 'etf' ? r.code : String((page - 1) * 40 + i + 1)),
                React.createElement('td', { className: 'tl' }, r.name),
                React.createElement('td', { className: cls }, scope === 'etf' ? `${fmtPrice(r.price)} ${fmtSigned(r.chg)}` : fmtSigned(r.chg)),
                React.createElement('td', null, React.createElement('span', { className: `tw-chg-chip ${r.pct === null ? 'tw-chip-flat' : (r.pct >= 0) === redUp ? 'tw-chip-up' : 'tw-chip-down'}` }, fmtPct(r.pct ?? null))),
                scope === 'etf'
                  ? [React.createElement('td', { key: 'a' }, fmtAmt(r.amount ?? null)), React.createElement('td', { key: 't' }, r.leader !== null ? r.leader : '—')]
                  : [
                      React.createElement('td', { key: 'u', className: 'tw-dim' },
                        r.up !== null
                          ? React.createElement(React.Fragment, null,
                              React.createElement('span', { className: dirClass(1, redUp) }, String(r.up)),
                              ' / ',
                              React.createElement('span', { className: dirClass(-1, redUp) }, String(r.down ?? 0)),
                            )
                          : '—',
                      ),
                      React.createElement('td', { key: 'l', className: 'tl' }, r.leader ?? '—'),
                      React.createElement('td', { key: 'm', className: dirClass(r.money ?? null, redUp) }, fmtAmt(r.money ?? null)),
                    ],
              )
            }),
          ),
        ),
      ),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 } },
        boardLoading ? React.createElement('span', { className: 'tw-muted' }, '加载中…') : React.createElement('span', { className: 'tw-muted' }, `共 ${total} 个`),
        React.createElement('span', { style: { flex: 1 } }),
        page * 40 < total
          ? React.createElement(Btn, { onClick: () => loadBoard(scope, sort, page + 1, true) }, '加载更多')
          : null,
      ),
    ),
    React.createElement('div', { className: 'tw-panel' },
      React.createElement('div', { className: 'tw-panel-h' },
        React.createElement('span', { className: 't' }, '个股 / 基金查询'),
      ),
      React.createElement(SuggestInput, {
        onPick: (item) => openDetail(item.secid),
        placeholder: '搜索 A股/港股/ETF/基金/指数（600519、02155、茅台…）',
      }),
      detailLoading && pick !== null
        ? React.createElement('div', { className: 'tw-loading' }, '加载行情详情…')
        : detailError !== null
          ? React.createElement('div', { className: 'tw-error' }, detailError)
          : detail !== null
            ? React.createElement(DetailCard, { detail, trend, redUp })
            : React.createElement('div', { className: 'tw-hint', style: { marginTop: 6 } }, '点击指数、ETF 行或搜索后显示详情（价格/分时/基础数据）。'),
    ),
    pick !== null && detail !== null
      ? React.createElement(DetailModal, { detail, trend, redUp, onClose: () => { setPick(null); setDetail(null); setTrend(null) } })
      : null,
  )
}

function DetailCard(props: { detail: StockDetail; trend: TrendData | null; redUp: boolean }): React.ReactElement {
  const d = props.detail
  const cls = dirClass(d.chg ?? null, props.redUp)
  const t = props.trend
  const points = (t?.points ?? []).map((p) => ({ t: p.t, value: p.price }))
  const lastUp = points.length > 1 && t?.prePrice !== null && t?.prePrice !== undefined
    ? points[points.length - 1].value >= (t.prePrice as number)
    : null
  const kv = (k: string, v: string | null, extraCls?: string): React.ReactElement =>
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0', borderBottom: '1px solid var(--tw-border)' } },
      React.createElement('span', { className: 'tw-dim' }, k),
      React.createElement('span', { className: extraCls ?? '' }, v ?? '—'),
    )
  return React.createElement(
    'div',
    { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 } },
    React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
      React.createElement('b', { style: { fontSize: 15 } }, `${d.name}（${d.code}）`),
      React.createElement('span', { className: cls, style: { fontSize: 20, fontWeight: 700 } }, fmtPrice(d.price)),
      React.createElement('span', { className: cls }, `${fmtSigned(d.chg)}  ${fmtPct(d.pct)}`),
    ),
    t !== null && points.length > 1
      ? React.createElement(Sparkline, {
          points,
          baseline: t.prePrice,
          width: 560,
          height: 170,
          up: lastUp !== false,
          upColor: 'var(--tw-up)',
          downColor: 'var(--tw-down)',
          timeLabels: true,
        })
      : React.createElement('div', { className: 'tw-muted' }, '无当日分时数据'),
    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '0 18px', marginTop: 4 } },
      React.createElement('div', null,
        kv('今开', fmtPrice(d.open)),
        kv('最高', fmtPrice(d.high)),
        kv('最低', fmtPrice(d.low)),
        kv('昨收', fmtPrice(d.prev)),
        kv('成交量', fmtBig(d.vol)),
      ),
      React.createElement('div', null,
        kv('成交额', fmtAmt(d.amount)),
        kv('换手率', d.turnover !== null ? `${d.turnover}%` : null),
        kv('量比', d.volumeRatio !== null ? String(d.volumeRatio) : null),
        kv('市盈率(动)', d.pe !== null ? String(d.pe) : null),
        kv('市净率', d.pb !== null ? String(d.pb) : null),
      ),
      React.createElement('div', null,
        kv('总市值', fmtAmt(d.totalMv)),
        kv('流通市值', fmtAmt(d.floatMv)),
        kv('涨跌家数', d.up !== null && d.down !== null ? `${d.up} / ${d.down}` : null),
      ),
    ),
  )
}

function DetailModal(props: {
  detail: StockDetail
  trend: TrendData | null
  redUp: boolean
  onClose: () => void
}): React.ReactElement {
  return React.createElement(Modal, { title: '个股详情', onClose: props.onClose, width: 640 },
    React.createElement(DetailCard, { detail: props.detail, trend: props.trend, redUp: props.redUp }),
    React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 8 } },
      React.createElement(Btn, { onClick: props.onClose }, '关闭'),
    ),
  )
}
