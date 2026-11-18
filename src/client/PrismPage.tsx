/**
 * 棱镜 · AGENT DESK（三栏骨架 + 人类列）
 * 规格：docs/SPEC-PRISM-REBUILD.md。中/右栏 B4/B5 接入，先占位。
 * 红线：数值全部来自 /tradewatcher/prism；缺失 ⇒ `—`（单元格）/ `—（一句原因）`（区块）；无说明长句。
 */
import * as React from 'react'
import { api } from './api.ts'
import { Field, Modal, Skeleton } from './ui'
import { missText, numText } from './uiText.ts'
import { shClockText } from './marketTime.ts'
import { actionLabelOf, pillClassOf, positionErrorOf, sourceOf } from './prismForm.ts'

interface DeskFlowItem { at?: number; action?: string; reason?: string; target?: number | null; status?: string; source?: string }
interface DeskOverview { total?: number | null; cash?: number | null; positionPct?: number | null; available?: number | null }
interface DeskPerformance { alpha?: number | null; maxDD?: number | null; decisions?: number | null; winRate?: number | null; tokenUsage?: number | null }
interface Desk { decisionFlow?: DeskFlowItem[]; overview?: DeskOverview; performance?: DeskPerformance }

const pctOf = (v: number | null | undefined): string => (typeof v === 'number' && Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(2)}%` : '—')


const LIMITS = [
  ['perStockPct', '单票权重上限', '%'],
  ['stopLossPct', '单票止损线', '%'],
  ['perOrderYuan', '单笔金额上限', '元'],
  ['maxPosPct', '最大总仓位', '%'],
  ['maxDDPct', '日回撤熔断', '%'],
  ['minCashPct', '最低现金留存', '%'],
] as const

export function PrismPage(): React.ReactElement {
  const [state, setState] = React.useState<Awaited<ReturnType<typeof api.prismState>> | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  const [self, setSelf] = React.useState<{ ok: boolean; ms: number } | null>(null)
  const [adding, setAdding] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [saveErr, setSaveErr] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState({ code: '510300', shares: '100', cost: '' })
  const [confirmDel, setConfirmDel] = React.useState<string | null>(null)
  const [cons, setCons] = React.useState({ perStockPct: '', stopLossPct: '', perOrderYuan: '', maxPosPct: '', maxDDPct: '', minCashPct: '' })

  const load = React.useCallback((): void => {
    setErr(null)
    api.prismState().then((r) => setState(r)).catch((e: Error) => setErr(e.message))
    api.prismSelftest().then((r) => setSelf({ ok: r.ok, ms: r.elapsedMs })).catch(() => setSelf(null))
  }, [])
  React.useEffect(() => { load() }, [load])

  const desk = (state?.state as unknown as { desk?: Desk } | undefined)?.desk
  const [picked, setPicked] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<{ price: number | null; pct: number | null; open: number | null; high: number | null; low: number | null; amount: number | null; turnover: number | null; name: string | null } | null>(null)
  React.useEffect(() => {
    if (picked === null) { setDetail(null); return }
    let alive = true
    api.detail(picked).then((r) => {
      if (!alive) return
      const q = r.detail as unknown as { price?: number; pct?: number; open?: number; high?: number; low?: number; amount?: number; turnover?: number; name?: string } | null
      setDetail(q === null ? null : { price: q.price ?? null, pct: q.pct ?? null, open: q.open ?? null, high: q.high ?? null, low: q.low ?? null, amount: q.amount ?? null, turnover: q.turnover ?? null, name: q.name ?? null })
    }).catch(() => { if (alive) setDetail(null) })
    return () => { alive = false }
  }, [picked])
  const acct = state?.state.account ?? null
  const positions = acct?.positions ?? []
  const capital = acct?.capital ?? acct?.capitalLimit ?? null
  const used = positions.reduce((a, p) => a + p.qty * p.cost, 0)
  const exceeded = (state?.state as unknown as { desk?: { limits?: { limitState?: string } } } | undefined)?.desk?.limits?.limitState === 'exceeded'
  const run = (p: Promise<{ ok: boolean; error?: string }>): void => {
    setSaving(true); setSaveErr(null)
    p.then((r) => { if (r.ok) { setAdding(false); setConfirmDel(null); load() } else setSaveErr(r.error ?? '保存失败') })
      .catch((e: Error) => setSaveErr(e.message))
      .finally(() => setSaving(false))
  }
  const submitAdd = (): void => {
    const bad = positionErrorOf(draft.code, Number(draft.shares))
    if (bad !== null) { setSaveErr(bad); return }
    run(api.prismPosition({ op: 'add', secid: draft.code, shares: Number(draft.shares), cost: draft.cost === '' ? undefined : Number(draft.cost) }))
  }
  const submitCons = (): void => {
    const nums = Object.values(cons).map((v) => Number(v))
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) { setSaveErr('约束必须是非负数'); return }
    run(api.prismConstraints({ perStockPct: nums[0]!, stopLossPct: nums[1]!, perOrderYuan: nums[2]!, maxPosPct: nums[3]!, maxDDPct: nums[4]!, minCashPct: nums[5]! }))
  }
  const removePos = (secid: string): void => { run(api.prismPosition({ op: 'remove', secid, confirm: true })) }
  const setCapital = (v: number): void => { api.prismCapital(v).then(load).catch((e: Error) => setErr(e.message)) }

  const status = React.createElement('div', { className: 'tw-ad-status', 'data-role': 'ad-status' },
    React.createElement('span', { className: 'tw-ad-dot', 'data-ok': self === null ? 'na' : self.ok ? 'ok' : 'bad', title: self === null ? '自检未取到' : `自检${self.ok ? '通过' : '失败'} · ${self.ms}ms` }, '自检'))

  const limits = React.createElement('div', { className: 'tw-ad-grid', 'data-role': 'ad-limits' },
    ...LIMITS.map(([key, label, suffix]) => React.createElement('label', { key, className: 'tw-ad-lim' },
      React.createElement('span', null, label),
      React.createElement('div', { className: 'tw-ad-f' },
        React.createElement('input', { type: 'number', 'aria-label': label, placeholder: '—', value: cons[key as keyof typeof cons], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setCons({ ...cons, [key]: e.target.value }) }),
        React.createElement('span', { className: 'tw-ad-suf' }, suffix)))))

  const cap = React.createElement('section', { className: 'tw-ad-card', 'data-role': 'ad-cap' },
    React.createElement('div', { className: 'tw-ad-card-head' }, React.createElement('h2', null, '资产上限')),
    React.createElement('label', { className: 'tw-ad-cap-lab' }, '总资产上限'),
    React.createElement('div', { className: 'tw-ad-cap-input' },
      React.createElement('span', { className: 'tw-ad-cur' }, '¥'),
      React.createElement('input', {
        type: 'number', 'aria-label': '总资产上限（万元）', placeholder: '—', disabled: true, title: '未接写入接口',
        value: capital === null ? '' : String(capital / 1e4),
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setCapital(Math.max(0, Number(e.target.value) || 0) * 1e4),
      }),
      React.createElement('span', { className: 'tw-ad-suf' }, '万')),
    React.createElement('div', { className: 'tw-ad-chips' },
      ...[100, 200, 300, 500].map((w) => React.createElement('button', { key: w, className: 'tw-ad-chip', onClick: () => setCapital(w * 1e4) }, `${w}万`))),
    React.createElement('div', { className: 'tw-ad-usage' },
      React.createElement('div', { className: `tw-ad-bar${exceeded ? ' is-over' : ''}` }, React.createElement('i', { style: { width: `${capital !== null && capital > 0 ? Math.min(100, (used / capital) * 100) : 0}%` } })),
      React.createElement('span', null, exceeded ? '已用超出上限' : `已用 ${numText(used / 1e8, 2)} / ${capital === null ? '—' : numText(capital / 1e8, 2)}`)),
    limits,
    React.createElement('button', { className: 'tw-ad-primary', onClick: submitCons, disabled: saving }, saving ? '保存中…' : '保存约束'),
    saveErr === null ? null : React.createElement('div', { className: 'tw-ad-err', 'data-role': 'ad-err' }, saveErr))

  const table = React.createElement('table', { className: 'tw-ad-table' },
    React.createElement('thead', null, React.createElement('tr', null,
      React.createElement('th', null, '名称'), React.createElement('th', { className: 'num' }, '持股数'),
      React.createElement('th', { className: 'num' }, '成本价'), React.createElement('th', null, ''))),
    React.createElement('tbody', null, ...positions.map((p) => React.createElement('tr', { key: p.secid, onClick: () => setPicked(p.secid), className: picked === p.secid ? 'is-on' : undefined },
      React.createElement('td', null, p.name),
      React.createElement('td', { className: 'num' }, numText(p.qty, 0)),
      React.createElement('td', { className: 'num' }, numText(p.cost, 3)),
      React.createElement('td', null, React.createElement('button', { className: 'tw-ad-chip', 'aria-label': `移除 ${p.name}`, onClick: () => setConfirmDel(p.secid) }, '移除'))))))

  const pos = React.createElement('section', { className: 'tw-ad-card', 'data-role': 'ad-positions' },
    React.createElement('div', { className: 'tw-ad-card-head' }, React.createElement('h2', null, '持仓明细'), React.createElement('span', { className: 'tw-ad-hint' }, '股数 / 成本可改')),
    positions.length === 0
      ? React.createElement('div', { className: 'tw-ad-empty', 'data-role': 'ad-pos-empty' }, missText('持仓'))
      : table)


  const kv = (items: Array<[string, string]>): React.ReactElement => React.createElement('div', { className: 'tw-ad-kv' },
    ...items.map(([k, v]) => React.createElement('span', { key: k }, `${k} ${v}`)))

  const detailCard = React.createElement('section', { className: 'tw-ad-card', 'data-role': 'ad-detail' },
    React.createElement('div', { className: 'tw-ad-card-head' }, React.createElement('h2', null, '个股详情')),
    picked === null
      ? React.createElement('div', { className: 'tw-ad-empty' }, missText('个股详情', '选择左侧持仓查看'))
      : detail === null
        ? React.createElement('div', { className: 'tw-ad-empty' }, missText('个股详情', '未取到'))
        : kv([['现价', numText(detail.price, 2)], ['涨跌', pctOf(detail.pct)], ['今开', numText(detail.open, 2)], ['最高', numText(detail.high, 2)], ['最低', numText(detail.low, 2)], ['成交额', `${numText(detail.amount === null ? null : detail.amount / 1e8, 2)} 亿`], ['换手', pctOf(detail.turnover)]]))

  const flow = desk?.decisionFlow ?? []
  const feedCard = React.createElement('section', { className: 'tw-ad-card', 'data-role': 'ad-flow' },
    React.createElement('div', { className: 'tw-ad-card-head' }, React.createElement('h2', null, '决策流')),
    flow.length === 0
      ? React.createElement('div', { className: 'tw-ad-empty' }, missText('决策记录'))
      : React.createElement('ul', { className: 'tw-ad-flow' }, ...flow.map((f, i) => React.createElement('li', { key: `${f.at ?? i}`, className: 'tw-ad-ev' },
          React.createElement('span', { className: 'tw-ad-time' }, f.at === undefined ? '—' : shClockText(f.at).slice(0, 5)),
          React.createElement('span', { className: `tw-ad-pill ${pillClassOf(f.action)}` }, actionLabelOf(f.action)),
          React.createElement('span', { className: 'tw-ad-reason' }, f.reason ?? '—'),
          React.createElement('span', null, f.target === null || f.target === undefined ? '—' : numText(f.target, 2)),
          React.createElement('span', null, f.status ?? '—'),
          React.createElement('span', null, sourceOf(f.source))))))

  const ov = desk?.overview
  const acctCard = React.createElement('section', { className: 'tw-ad-card', 'data-role': 'ad-overview' },
    React.createElement('div', { className: 'tw-ad-card-head' }, React.createElement('h2', null, '账户总览')),
    ov === undefined
      ? React.createElement('div', { className: 'tw-ad-empty' }, missText('账户数据'))
      : kv([['总资产', `${numText(ov.total === null || ov.total === undefined ? null : ov.total / 1e4, 2)} 万`], ['现金', `${numText(ov.cash === null || ov.cash === undefined ? null : ov.cash / 1e4, 2)} 万`], ['持仓占比', pctOf(ov.positionPct)], ['可用', `${numText(ov.available === null || ov.available === undefined ? null : ov.available / 1e4, 2)} 万`]]))

  const pf = desk?.performance
  const perfCard = React.createElement('section', { className: 'tw-ad-card', 'data-role': 'ad-perf' },
    React.createElement('div', { className: 'tw-ad-card-head' }, React.createElement('h2', null, 'Agent 绩效')),
    pf === undefined
      ? React.createElement('div', { className: 'tw-ad-empty' }, missText('Agent 绩效'))
      : kv([['超额收益', pctOf(pf.alpha)], ['最大回撤', pctOf(pf.maxDD)], ['决策数', numText(pf.decisions, 0)], ['胜率', pctOf(pf.winRate)], ['token 用量', pf.tokenUsage === null || pf.tokenUsage === undefined ? '—' : numText(pf.tokenUsage, 0)]]))

  const human = err !== null
    ? React.createElement('div', { className: 'tw-ad-empty' }, missText('棱镜数据', err))
    : state === null
      ? React.createElement(Skeleton, { lines: 5, height: 26 })
      : React.createElement(React.Fragment, null, cap, pos)

  return React.createElement('div', { className: 'tw-ad-root', 'data-role': 'prism-agentdesk' },
    status,
    React.createElement('div', { className: 'tw-ad-board' },
      React.createElement('div', { className: 'tw-ad-col' },
        React.createElement('div', { className: 'tw-ad-banner' }, '人类只设边界'), human,
        React.createElement('button', { className: 'tw-ad-add', onClick: () => setAdding(true) }, '＋ 添加持仓')),
      React.createElement('div', { className: 'tw-ad-col' }, state === null ? React.createElement(Skeleton, { lines: 3, height: 40 }) : detailCard, state === null ? null : feedCard),
      React.createElement('div', { className: 'tw-ad-col' }, state === null ? React.createElement(Skeleton, { lines: 2, height: 40 }) : acctCard, state === null ? null : perfCard)),
    adding
      ? React.createElement(Modal, { title: '添加持仓', onClose: () => setAdding(false) },
          React.createElement(Field, { label: '代码' }, React.createElement('input', { placeholder: '510300', 'aria-label': '代码', value: draft.code, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, code: e.target.value }) })),
          React.createElement(Field, { label: '股数' }, React.createElement('input', { type: 'number', 'aria-label': '股数', value: draft.shares, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, shares: e.target.value }) })),
          React.createElement(Field, { label: '成本价' }, React.createElement('input', { type: 'number', 'aria-label': '成本价', value: draft.cost, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, cost: e.target.value }) })),
          React.createElement('button', { className: 'tw-ad-primary', onClick: submitAdd, disabled: saving }, saving ? '保存中…' : '添加'))
      : null,
    confirmDel === null
      ? null
      : React.createElement(Modal, { title: '移除持仓', onClose: () => setConfirmDel(null) },
          React.createElement('div', { className: 'tw-ad-empty' }, '确认移除该持仓？'),
          React.createElement('button', { className: 'tw-ad-primary', onClick: () => removePos(confirmDel), disabled: saving }, saving ? '保存中…' : '确认移除')))
}
