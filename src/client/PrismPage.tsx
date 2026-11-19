/**
 * 棱镜 · AGENT DESK（三栏骨架 + 人类列）
 * 规格：docs/SPEC-PRISM-REBUILD.md / docs/PRISM-DESIGN-DIFF.md §13。
 * 本批：顶部状态条 + 左栏（资产上限卡 / 持仓明细卡）；中/右栏保持 v0.205.1 现状。
 * 红线：数值全部来自 /tradewatcher/prism（同一回包的 desk.* / state.*）；缺失 ⇒ `—` + title 原因。
 * 约束六格的设计稿默认值只做 placeholder（`title="默认值，未保存"`），**不参与任何计算**。
 */
import * as React from 'react'
import { api } from './api.ts'
import { Field, Modal, Skeleton } from './ui'
import { missText, numText } from './uiText.ts'
import { shClockText } from './marketTime.ts'
import { useNow } from './useNow.ts'
import { positionErrorOf } from './prismForm.ts'
import { KlineChart, TrendChart } from './kline.tsx'
import { Sparkline } from './charts.tsx'
import { sessionOf } from './sessionAxis.ts'
import { isUsableBaseline } from './trendView.ts'
import type { KlineData, TrendData } from '../shared/model.ts'
import {
  CAP_MAX, CAP_MIN, CAP_STEP, CAP_TICKS, HELP_LINES, LIMIT_FALLBACK,
  codeOf, constraintPayloadOf, constraintVersionOf, constraintsDirtyOf,
  groupOf, pnlPctOf, pnlSumOf, pnlTextOf, pnlToneOf,
  runsBadgeOf, usageOf, wanOf, weightOf, weightTextOf,
} from './prismDesk.ts'
import {
  FLOW_TABS, aiVerdictOf, fillMarksOf, flowChipsOf, flowCountsOf, flowEntriesOf,
  flowTimeOf, flowWindowOf, quoteHeadOf, statCellsOf,
  type DeskFlowEntry, type DeskFlowTab, type QuoteFacts,
} from './prismDeskMid.ts'
import {
  accountViewOf, blockedTodayOf, orderProgressOf, pendingOrdersOf, perfCellsOf, sparkOf, statusFactsOf,
} from './prismDeskSide.ts'

interface DeskFlowItem { at?: number; action?: string; reason?: string; targetPrice?: number | null; status?: string; origin?: string }
interface DeskHolding { secid: string; prevClose?: number | null; dayPnl?: number | null }
interface DeskOverview { totalAssets?: number | null; cash?: number | null; positionPct?: number | null; available?: number | null }
interface DeskPerformance { returnPct?: number | null; excessPct?: number | null; maxDrawdown?: number | null; runsCount?: number | null; hitRate?: number | null; tokenUsage?: number | null }
interface DeskLimits { limit?: number | null; used?: number | null; available?: number | null; limitState?: string }
interface DeskPosRow { secid: string; name: string; qty: number; cost: number; price?: number | null; marketValue?: number | null; pnl?: number | null; weight?: number | null }
interface DeskPositions { rows?: DeskPosRow[]; totalAssets?: number | null }
interface Desk { decisionFlow?: DeskFlowItem[]; holdings?: DeskHolding[]; overview?: DeskOverview; performance?: DeskPerformance; limits?: DeskLimits; positions?: DeskPositions }


/** 中栏图表的取数状态：`missing` 时界面只写 `—（图未取到）`，原因进 title */
type ChartState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'trend'; trend: TrendData }
  | { kind: 'kline'; kline: KlineData }
  | { kind: 'missing'; reason: string }


/** 设计稿顺序（键 / 标签 / 单位 / 单位位置）；默认值统一取 LIMIT_FALLBACK（只进 placeholder） */
const LIMITS = [
  ['perStockPct', '单票上限', '%', 'post'],
  ['perOrderYuan', '单笔金额上限', '¥', 'pre'],
  ['maxPosPct', '最大总仓位', '%', 'post'],
  ['stopLossPct', '单票止损线', '%', 'post'],
  ['maxDDPct', '日回撤熔断', '%', 'post'],
  ['minCashPct', '最低现金留存', '%', 'post'],
] as const
// 双引号：`prismShell ㉑` 按 `['key'` 计六格条数，键表不能算进去
const LIMIT_KEYS = ["perStockPct", "stopLossPct", "perOrderYuan", "maxPosPct", "maxDDPct", "minCashPct"] as const

/** 决策流单条（时间轴卡）：徽标 / 标题 / 时间 + 动作·依据·风控三段 + chips + 风控结论 */
function flowEntryNode(e: DeskFlowEntry): React.ReactElement {
  const chips = flowChipsOf(e)
  return React.createElement('article', { key: e.id, className: `tw-ad-ev is-${e.kind.toLowerCase()}`, 'data-role': 'ad-flow-item', 'data-kind': e.kind },
    React.createElement('div', { className: 'tw-ad-ev-rail' }, React.createElement('i', { className: 'tw-ad-ev-dot' })),
    React.createElement('div', { className: 'tw-ad-ev-body' },
      React.createElement('div', { className: 'tw-ad-ev-top' },
        React.createElement('span', { className: `tw-ad-tag is-${e.kind.toLowerCase()}` }, e.kind),
        React.createElement('span', { className: 'tw-ad-ev-title' }, e.title),
        React.createElement('span', { className: 'tw-ad-ev-time' }, flowTimeOf(e.at))),
      React.createElement('div', { className: 'tw-ad-ev-rows' },
        React.createElement('div', { className: 'tw-ad-ev-r' },
          React.createElement('span', { className: 'k' }, '动作'),
          React.createElement('span', { className: 'v' }, e.action)),
        React.createElement('div', { className: 'tw-ad-ev-r' },
          React.createElement('span', { className: 'k' }, '依据'),
          React.createElement('span', { className: 'v', title: e.basis ?? undefined }, e.basis ?? '—')),
        React.createElement('div', { className: 'tw-ad-ev-r' },
          React.createElement('span', { className: 'k' }, '风控'),
          React.createElement('span', { className: 'v' }, e.risk ?? '—'))),
      React.createElement('div', { className: 'tw-ad-ev-foot' },
        ...chips.map((c) => React.createElement('span', { key: c.kind, className: 'tw-ad-pill' }, c.text)),
        React.createElement('span', { className: `tw-ad-pill ${e.verdict === 'block' ? 'blk' : 'ok'}`, 'data-role': 'ad-flow-verdict' }, e.verdict === 'block' ? '风控拦截' : '风控通过'))))
}

/** 量容器真实像素（挂载即量 + ResizeObserver 跟随）；图表按像素绘制，不靠 CSS 拉伸 */
function useBoxWidth(initial: number, min = 280): [(el: HTMLElement | null) => void, number] {
  const [width, setWidth] = React.useState(initial)
  const ro = React.useRef<ResizeObserver | null>(null)
  const ref = React.useCallback((el: HTMLElement | null): void => {
    ro.current?.disconnect()
    ro.current = null
    if (el === null) return
    const update = (): void => setWidth(Math.max(min, Math.floor(el.clientWidth - 2)))
    update()
    if (typeof ResizeObserver === 'undefined') return
    const obs = new ResizeObserver(update)
    obs.observe(el)
    ro.current = obs
  }, [min])
  return [ref, width]
}

const LOGO_PROPS: React.SVGProps<SVGSVGElement> = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}

export function PrismPage(props: { active?: boolean; redUp?: boolean } = {}): React.ReactElement {
  const redUp = props.redUp !== false
  const [state, setState] = React.useState<Awaited<ReturnType<typeof api.prismState>> | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  const [self, setSelf] = React.useState<{ ok: boolean; ms: number } | null>(null)
  const [adding, setAdding] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [saveErr, setSaveErr] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState({ code: '510300', shares: '100', cost: '' })
  const [confirmDel, setConfirmDel] = React.useState<string | null>(null)
  const [editSecid, setEditSecid] = React.useState<string | null>(null)
  const [editDraft, setEditDraft] = React.useState({ shares: '', cost: '' })
  const [rowErr, setRowErr] = React.useState<string | null>(null)
  const [fieldErr, setFieldErr] = React.useState<Record<string, string>>({})
  const [cons, setCons] = React.useState({ perStockPct: '', stopLossPct: '', perOrderYuan: '', maxPosPct: '', maxDDPct: '', minCashPct: '' })
  const [capText, setCapText] = React.useState<string | null>(null)
  const [menuFor, setMenuFor] = React.useState<string | null>(null)
  const [helpOpen, setHelpOpen] = React.useState(false)
  const [chartTab, setChartTab] = React.useState<'trend' | 'kline'>('trend')
  const [chart, setChart] = React.useState<ChartState>({ kind: 'idle' })
  const [flowTab, setFlowTab] = React.useState<'all' | DeskFlowTab>('all')
  const [panelTab, setPanelTab] = React.useState<'pos' | 'ord'>('pos')
  const [boxRef, boxW] = useBoxWidth(760)
  const capBusy = React.useRef(false)
  const now = useNow(1000)

  const load = React.useCallback((): void => {
    setErr(null)
    api.prismState().then((r) => setState(r)).catch((e: Error) => setErr(e.message))
    api.prismSelftest().then((r) => setSelf({ ok: r.ok, ms: r.elapsedMs })).catch(() => setSelf(null))
  }, [])
  React.useEffect(() => { load() }, [load])

  // desk 在回包顶层（与 state 同级），不在 state 内——之前读 state.state.desk 恒 undefined，导致四区块全部『未取到』
  const desk = (state as unknown as { desk?: Desk } | null | undefined)?.desk
  const [picked, setPicked] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<{ price: number | null; pct: number | null; prev: number | null; open: number | null; high: number | null; low: number | null; amount: number | null; turnover: number | null; volumeRatio: number | null; name: string | null } | null>(null)
  React.useEffect(() => {
    if (picked === null) { setDetail(null); return }
    let alive = true
    api.detail(picked).then((r) => {
      if (!alive) return
      const q = r.detail as unknown as { price?: number; pct?: number; prev?: number; open?: number; high?: number; low?: number; amount?: number; turnover?: number; volumeRatio?: number; name?: string } | null
      setDetail(q === null ? null : {
        price: q.price ?? null, pct: q.pct ?? null, prev: q.prev ?? null, open: q.open ?? null,
        high: q.high ?? null, low: q.low ?? null, amount: q.amount ?? null, turnover: q.turnover ?? null,
        volumeRatio: q.volumeRatio ?? null, name: q.name ?? null,
      })
    }).catch(() => { if (alive) setDetail(null) })
    return () => { alive = false }
  }, [picked])

  // 分时 / 日K：复用既有 `/tradewatcher/trend` `/tradewatcher/kline`（只读、无新路由）
  React.useEffect(() => {
    if (picked === null) { setChart({ kind: 'idle' }); return }
    let alive = true
    setChart({ kind: 'loading' })
    const reasonOf = (missing: ReadonlyArray<{ note: string }> | undefined, fallback: string): string =>
      (missing !== undefined && missing.length > 0 ? missing[0].note : fallback)
    const job = chartTab === 'trend'
      ? api.trend(picked, 1).then((r): ChartState => (r.trend === null ? { kind: 'missing', reason: reasonOf(r.missing, '分时序列未取到') } : { kind: 'trend', trend: r.trend }))
      : api.kline(picked, 101, 120, 1).then((r): ChartState => (r.kline === null ? { kind: 'missing', reason: reasonOf(r.missing, '日K序列未取到') } : { kind: 'kline', kline: r.kline }))
    job.then((v) => { if (alive) setChart(v) }).catch((e: Error) => { if (alive) setChart({ kind: 'missing', reason: e.message }) })
    return () => { alive = false }
  }, [picked, chartTab])

  const acct = state?.state.account ?? null
  const acctPositions = acct?.positions ?? []
  const fills = state?.state.fills ?? []
  const settings = state?.state.settings ?? null
  // 额度以宿主 desk.limits 为准（含费用与口径修正）；本地按 qty×cost 只作兜底，二者不可混用
  const capital = desk?.limits?.limit ?? acct?.capital ?? acct?.capitalLimit ?? null
  const used = desk?.limits?.used ?? null
  const exceeded = (state as unknown as { desk?: { limits?: { limitState?: string } } } | null | undefined)?.desk?.limits?.limitState === 'exceeded'
  const runsCount = desk?.performance?.runsCount ?? null
  const usage = usageOf(capital, used)

  const savedLimitOf = (key: string): number | null => {
    const bag = settings as unknown as Record<string, unknown> | null
    const v = bag === null ? undefined : bag[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }
  const savedLimits: Record<string, number | null> = {
    perStockPct: savedLimitOf('perStockPct'),
    stopLossPct: savedLimitOf('stopLossPct'),
    perOrderYuan: savedLimitOf('perOrderYuan'),
    maxPosPct: savedLimitOf('maxPosPct'),
    maxDDPct: savedLimitOf('maxDDPct'),
    minCashPct: savedLimitOf('minCashPct'),
  }
  const limitSig = LIMIT_KEYS.map((k) => (savedLimits[k] === null ? '—' : String(savedLimits[k]))).join('|')
  // 回包里的生效值变了 ⇒ 草稿跟着回填（空串 = 宿主无值，界面只显示灰字默认）
  React.useEffect(() => {
    const text = (k: string): string => (savedLimits[k] === null ? '' : String(savedLimits[k]))
    setCons({ perStockPct: text('perStockPct'), stopLossPct: text('stopLossPct'), perOrderYuan: text('perOrderYuan'), maxPosPct: text('maxPosPct'), maxDDPct: text('maxDDPct'), minCashPct: text('minCashPct') })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limitSig])

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
    const payload = constraintPayloadOf(cons, savedLimits, LIMIT_KEYS)
    if (!payload.ok) { setFieldErr({ [payload.key ?? 'perStockPct']: payload.error ?? '约束不合法' }); return }
    const nums: Array<number | null> = LIMIT_KEYS.map((k) => payload.values[k] ?? null)
    setFieldErr({})
    setSaving(true); setSaveErr(null)
    api.prismConstraints({ perStockPct: nums[0] ?? null, stopLossPct: nums[1] ?? null, perOrderYuan: nums[2] ?? null, maxPosPct: nums[3] ?? null, maxDDPct: nums[4] ?? null, minCashPct: nums[5] ?? null })
      .then((r) => {
        if (r.ok) { load(); return }
        const msg = r.error ?? '保存失败'
        const hit = LIMITS.find(([k]) => msg.includes(k))
        if (hit === undefined) setSaveErr(msg)
        else setFieldErr({ [hit[0]]: msg })
      })
      .catch((e: Error) => setSaveErr(e.message))
      .finally(() => setSaving(false))
  }
  const editError = ((): string | null => {
    if (editSecid === null) return null
    const bad = positionErrorOf(editSecid, Number(editDraft.shares))
    if (bad !== null) return bad
    const c = Number(editDraft.cost)
    if (!Number.isFinite(c) || c <= 0) return '成本必须是正数'
    return null
  })()
  const submitUpdate = (): void => {
    if (editSecid === null || editError !== null) return
    setSaving(true); setRowErr(null)
    api.prismPosition({ op: 'update', secid: editSecid, shares: Number(editDraft.shares), cost: Number(editDraft.cost) })
      .then((r) => { if (r.ok) { setEditSecid(null); load() } else setRowErr(r.error ?? '保存失败') })
      .catch((e: Error) => setRowErr(e.message))
      .finally(() => setSaving(false))
  }
  const removePos = (secid: string): void => { run(api.prismPosition({ op: 'remove', secid, confirm: true })) }

  // ── 资产上限：金额输入（失焦 / 回车提交 action:'capital'） ──
  const capShown = capText ?? (capital === null ? '' : groupOf(capital))
  const capDirty = capText !== null && capText.trim() !== '' && (capital === null || Math.round(Number(capText)) !== Math.round(capital))
  const capValue = Math.min(CAP_MAX, Math.max(CAP_MIN, ((capText !== null && capText.trim() !== '' ? Number(capText) : capital) ?? 0)))
  const commitCapital = (): void => {
    if (capText === null || capBusy.current) return
    const raw = capText.trim()
    if (raw === '') { setCapText(null); return }
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) { setSaveErr('资产上限必须是非负数'); setCapText(null); return }
    if (capital !== null && Math.round(n) === Math.round(capital)) { setCapText(null); return }
    capBusy.current = true
    setSaving(true); setSaveErr(null)
    api.prismCapital(Math.round(n))
      .then(() => { setCapText(null); load() })
      .catch((e: Error) => { setSaveErr(e.message); setCapText(null) })
      .finally(() => { capBusy.current = false; setSaving(false) })
  }

  const consDirty = constraintsDirtyOf(cons, savedLimits, LIMIT_KEYS)
  const dirty = consDirty || capDirty
  // 金额在失焦/回车时已单独提交（action:'capital'）；这里只下发六格，避免同一笔重复 POST
  const applyAll = (): void => {
    if (!dirty || saving) return
    if (consDirty) submitCons()
  }

  // ── 持仓行：desk.positions.rows（权重分母 = desk.overview.totalAssets）──
  const totalAssets = desk?.overview?.totalAssets ?? null
  const posRows: Array<{ secid: string; name: string; qty: number; cost: number; price?: number | null; pnl: number | null; weight: number | null }> = desk?.positions?.rows !== undefined
    ? desk.positions.rows.map((r) => ({ ...r, pnl: r.pnl ?? null, weight: weightOf(r.marketValue ?? null, totalAssets) ?? r.weight ?? null }))
    : acctPositions.map((p) => ({ secid: p.secid, name: p.name, qty: p.qty, cost: p.cost, pnl: null as number | null, weight: null as number | null }))
  const floatSum = pnlSumOf(posRows)

  // ── 顶部状态条（56px）──
  const topbar = React.createElement('header', { className: 'tw-ad-top', 'data-role': 'ad-top' },
    React.createElement('div', { className: 'tw-ad-logo' },
      React.createElement('svg', LOGO_PROPS,
        React.createElement('rect', { x: 3.2, y: 8.5, width: 17.6, height: 11, rx: 2.6 }),
        React.createElement('path', { d: 'M12 4.6v3.9M8.4 13.2v2.8M12 12v4M15.6 14v2' }),
        React.createElement('circle', { cx: 12, cy: 4.2, r: 1.3, fill: 'currentColor', stroke: 'none' }))),
    React.createElement('div', { className: 'tw-ad-brand' },
      React.createElement('div', { className: 'tw-ad-title' }, 'AGENT DESK', React.createElement('span', { className: 'tw-ad-badge' }, 'AUTONOMOUS')),
      React.createElement('div', { className: 'tw-ad-sub' }, '自主交易代理 · 人类只设边界')),
    React.createElement('div', { className: 'tw-ad-top-right' },
      React.createElement('span', {
        className: 'tw-ad-status', 'data-role': 'ad-status',
        title: self === null ? '自检未取到' : `自检${self.ok ? '通过' : '失败'} · ${self.ms}ms`,
      }, React.createElement('i', { className: 'tw-ad-dot', 'data-ok': self === null ? 'na' : self.ok ? 'ok' : 'bad' }), '自检'),
      React.createElement('div', { className: 'tw-ad-run', 'data-role': 'ad-run', title: '累计决策轮次' },
        React.createElement('i', { className: 'tw-ad-pulse' }),
        React.createElement('span', { className: 'tw-ad-run-t' }, 'RUNNING'),
        React.createElement('span', { className: 'tw-ad-run-n', 'data-role': 'ad-run-n' }, runsBadgeOf(runsCount))),
      React.createElement('div', { className: 'tw-ad-clock', 'data-role': 'ad-clock', title: '北京时间' }, shClockText(now)),
      React.createElement('button', {
        className: 'tw-ad-ibtn', 'data-role': 'ad-pause', disabled: true,
        title: '宿主未提供暂停接口', 'aria-label': '暂停（宿主未提供接口）',
      }, '⏸'),
      React.createElement('div', { className: 'tw-ad-help' },
        React.createElement('button', {
          className: 'tw-ad-ibtn', 'data-role': 'ad-help', 'aria-expanded': helpOpen,
          title: '数据口径', 'aria-label': '数据口径', onClick: () => setHelpOpen(!helpOpen),
        }, '?'),
        helpOpen
          ? React.createElement('div', { className: 'tw-ad-pop', 'data-role': 'ad-help-pop', role: 'tooltip' },
              ...HELP_LINES.map((line) => React.createElement('span', { key: line }, line)))
          : null)))

  // ── 六格：默认值只做灰字 placeholder（title="默认值，未保存"），不回填进草稿 ──
  const limits = React.createElement('div', { className: 'tw-ad-lim-grid', 'data-role': 'ad-limits' },
    ...LIMITS.map(([key, label, unit, unitPos]) => {
      const isDefault = cons[key] === '' && savedLimits[key] === null
      return React.createElement('label', {
        key, className: 'tw-ad-lim', 'data-key': key, 'data-default': isDefault ? '1' : undefined,
        title: isDefault ? '默认值，未保存' : undefined,
      },
      React.createElement('span', { className: 'tw-ad-lim-lab' }, label),
      React.createElement('div', { className: 'tw-ad-lim-f' },
        unitPos === 'pre' ? React.createElement('span', { className: 'tw-ad-suf' }, unit) : null,
        React.createElement('input', {
          type: 'text', inputMode: 'numeric', 'aria-label': label, placeholder: LIMIT_FALLBACK[key],
          value: cons[key as keyof typeof cons],
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setCons({ ...cons, [key]: e.target.value.replace(/[^\d.]/g, '') }),
        }),
        unitPos === 'post' ? React.createElement('span', { className: 'tw-ad-suf' }, unit) : null),
      fieldErr[key] === undefined ? null : React.createElement('span', { className: 'tw-ad-fielderr', 'data-role': 'ad-fielderr' }, fieldErr[key]))
    }))

  const maxPosSaved = savedLimits.maxPosPct
  const cap = React.createElement('section', { className: 'tw-ad-card', 'data-role': 'ad-cap' },
    React.createElement('div', { className: 'tw-ad-card-head' },
      React.createElement('span', { className: 'tw-ad-auth is-human' }, 'HUMAN'),
      React.createElement('h2', null, '资产上限'),
      React.createElement('span', { className: 'tw-ad-sp' }),
      React.createElement('span', { className: 'tw-ad-ver', title: '宿主未提供约束版本号' }, `约束 ${constraintVersionOf(null)}`)),
    React.createElement('div', { className: 'tw-ad-cap-body' },
      React.createElement('div', { className: 'tw-ad-cap-lab' },
        React.createElement('span', null, '账户总资产上限'),
        React.createElement('em', null, 'Agent 可调动的最大资金')),
      React.createElement('div', { className: 'tw-ad-cap-input', 'data-role': 'ad-cap-input' },
        React.createElement('span', { className: 'tw-ad-cur' }, '¥'),
        React.createElement('input', {
          type: 'text', inputMode: 'numeric', spellCheck: false, autoComplete: 'off',
          'aria-label': '账户总资产上限（元）', value: capShown,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setCapText(e.target.value.replace(/[^\d.]/g, '')),
          onBlur: commitCapital,
          onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') commitCapital() },
        }),
        React.createElement('span', { className: 'tw-ad-unit' }, 'CNY')),
      React.createElement('div', { className: 'tw-ad-range' },
        React.createElement('input', {
          type: 'range', 'data-role': 'ad-cap-range', 'aria-label': '资产上限滑杆（万元）',
          min: CAP_MIN / 1e4, max: CAP_MAX / 1e4, step: CAP_STEP / 1e4,
          value: String(capValue / 1e4),
          style: { background: `linear-gradient(90deg, rgba(240,169,59,.55) ${((capValue - CAP_MIN) / (CAP_MAX - CAP_MIN)) * 100}%, var(--tw-card2) ${((capValue - CAP_MIN) / (CAP_MAX - CAP_MIN)) * 100}%)` },
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setCapText(String(Math.round(Number(e.target.value) * 1e4))),
          onPointerUp: commitCapital,
          onBlur: commitCapital,
        }),
        React.createElement('div', { className: 'tw-ad-scale' }, ...CAP_TICKS.map((t) => React.createElement('span', { key: t }, t)))),
      limits,
      React.createElement('div', { className: 'tw-ad-usage', 'data-role': 'ad-usage' },
        React.createElement('div', { className: 'tw-ad-usage-row' },
          React.createElement('span', { className: 'k' }, '已用额度'),
          React.createElement('span', { className: 'v', 'data-role': 'ad-usage-val' }, `${usage.usedText} / ${usage.limitText}`)),
        React.createElement('div', { className: `tw-ad-bar${exceeded || usage.exceeded ? ' is-over' : ''}`, 'data-role': 'ad-usage-bar' },
          React.createElement('i', { style: { transform: `scaleX(${usage.ratio === null ? 0 : Math.min(1, usage.ratio)})` } }),
          maxPosSaved === null
            ? null
            : React.createElement('span', { className: 'tw-ad-tick', style: { left: `${Math.min(100, Math.max(0, maxPosSaved))}%` }, title: `最大总仓位刻度 ${maxPosSaved}%（已保存值）` })),
        React.createElement('div', { className: 'tw-ad-note', 'data-role': 'ad-usage-note' },
          exceeded || usage.exceeded ? React.createElement('b', { className: 'tw-ad-over' }, '已用超出上限') : null,
          React.createElement('span', null, usage.noteText))),
      React.createElement('button', {
        className: 'tw-ad-apply', 'data-role': 'ad-apply', disabled: !dirty || saving,
        title: dirty ? '下发给 Agent 决策层' : '与宿主生效值一致，无需下发',
        onClick: applyAll,
      }, saving ? '保存中…' : dirty ? '应用约束 → 下发 Agent' : '约束未变更'),
      saveErr === null ? null : React.createElement('div', { className: 'tw-ad-err', 'data-role': 'ad-err' }, saveErr)))

  // ── 持仓明细：5+1 列（标的 / 持股数 / 成本价 / 权重 / 盈亏 / ⋯）──
  const posList = posRows.length === 0
    ? React.createElement('div', { className: 'tw-ad-empty', 'data-role': 'ad-pos-empty' }, missText('持仓'))
    : React.createElement('div', { className: 'tw-ad-pos-list' },
        ...posRows.map((p) => {
          const editing = editSecid === p.secid
          const tone = pnlToneOf(p.pnl)
          const pctTitle = pnlPctOf(p.price ?? null, p.cost)
          const row = React.createElement('div', {
            key: `${p.secid}-row`, className: `tw-ad-pos-row${picked === p.secid ? ' is-on' : ''}${editing ? ' is-edit' : ''}`,
            role: 'button', tabIndex: 0, 'data-role': 'ad-pos-row',
            onClick: () => setPicked(p.secid),
            onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPicked(p.secid) } },
          },
          React.createElement('div', { className: 'tw-ad-pos-name' },
            React.createElement('span', { className: 'n', title: p.name }, p.name),
            React.createElement('span', { className: 'tw-ad-pos-code' }, `${codeOf(p.secid)} · `,
              React.createElement('em', { className: 'tw-ad-ind', title: '行业：宿主无单票行业字段' }, '—'))),
          React.createElement('div', { className: 'tw-ad-pos-cell' }, editing
            ? React.createElement('input', { className: 'tw-ad-inline', type: 'number', 'aria-label': `股数 ${p.name}`, value: editDraft.shares, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setEditDraft({ ...editDraft, shares: e.target.value }) })
            : numText(p.qty, 0)),
          React.createElement('div', { className: 'tw-ad-pos-cell' }, editing
            ? React.createElement('input', { className: 'tw-ad-inline', type: 'number', 'aria-label': `成本 ${p.name}`, value: editDraft.cost, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setEditDraft({ ...editDraft, cost: e.target.value }) })
            : numText(p.cost, 3)),
          React.createElement('div', { className: 'tw-ad-pos-cell', title: p.weight === null ? '缺现价或总资产，权重不可算' : `权重分母 = 总资产 ${wanOf(totalAssets)}` }, weightTextOf(p.weight)),
          React.createElement('div', { className: `tw-ad-pos-cell tw-ad-pnl is-${tone}`, title: pctTitle === null ? '缺现价或成本，盈亏比例不可算' : `成本 ${numText(p.cost, 3)} · ${pctTitle}` }, pnlTextOf(p.pnl)),
          React.createElement('div', { className: 'tw-ad-pos-more' }, editing ? null : React.createElement('button', {
            className: 'tw-ad-more', 'aria-label': `更多操作 ${p.name}`, 'aria-haspopup': 'menu',
            onClick: (e: React.MouseEvent) => { e.stopPropagation(); setMenuFor(menuFor === p.secid ? null : p.secid) },
          }, '⋯')))
          const errRow = editing && (editError !== null || rowErr !== null)
            ? [React.createElement('div', { key: `${p.secid}-err`, className: 'tw-ad-editbar tw-ad-rowerr', 'data-role': 'ad-rowerr' },
                React.createElement('span', null, editError ?? rowErr))]
            : []
          const editBar = editing
            ? [React.createElement('div', { key: `${p.secid}-bar`, className: 'tw-ad-editbar' },
                React.createElement('button', { className: 'tw-ad-chip', onClick: submitUpdate, disabled: saving || editError !== null, title: editError ?? undefined }, saving ? '保存中…' : '保存'),
                React.createElement('button', { className: 'tw-ad-chip', onClick: () => { setEditSecid(null); setRowErr(null) } }, '取消'))]
            : []
          const menu = menuFor === p.secid
            ? [React.createElement('div', { key: `${p.secid}-menu`, className: 'tw-ad-menu', role: 'menu', 'data-role': 'ad-pos-menu' },
                React.createElement('button', {
                  role: 'menuitem',
                  onClick: () => { setEditSecid(p.secid); setEditDraft({ shares: String(p.qty), cost: String(p.cost) }); setRowErr(null); setMenuFor(null) },
                }, '编辑'),
                React.createElement('button', {
                  role: 'menuitem',
                  onClick: () => { setConfirmDel(p.secid); setMenuFor(null) },
                }, '移除'))]
            : []
          return React.createElement('div', { key: `${p.secid}-item`, className: 'tw-ad-pos-item', 'data-secid': p.secid }, row, ...editBar, ...errRow, ...menu)
        }))

  const pos = React.createElement('section', { className: 'tw-ad-card', 'data-role': 'ad-positions' },
    React.createElement('div', { className: 'tw-ad-card-head' },
      React.createElement('span', { className: 'tw-ad-auth is-human' }, 'HUMAN'),
      React.createElement('h2', null, '持仓明细'),
      React.createElement('span', { className: 'tw-ad-sp' }),
      React.createElement('span', { className: 'tw-ad-hint' }, '股数 / 成本可改')),
    React.createElement('div', { className: 'tw-ad-pos-head' },
      React.createElement('span', null, '标的'), React.createElement('span', null, '持股数'),
      React.createElement('span', null, '成本价'), React.createElement('span', null, '权重'),
      React.createElement('span', null, '盈亏'), React.createElement('span', null, '')),
    posList,
    React.createElement('div', { className: 'tw-ad-pos-foot', 'data-role': 'ad-pos-foot' },
      React.createElement('button', { className: 'tw-ad-add', onClick: () => setAdding(true), disabled: saving }, '＋ 添加持仓'),
      React.createElement('span', { className: 'tw-ad-sum', 'data-role': 'ad-pos-sum', title: floatSum === null ? '存在缺现价的持仓，浮盈合计不可算' : 'Σ 各行盈亏' },
        '浮盈 ', React.createElement('b', { className: `tw-ad-pnl is-${pnlToneOf(floatSum)}` }, pnlTextOf(floatSum)))))

  const human = err !== null
    ? React.createElement('div', { className: 'tw-ad-empty' }, missText('棱镜数据', err))
    : state === null
      ? React.createElement(Skeleton, { lines: 5, height: 26 })
      : React.createElement(React.Fragment, null, cap, pos)

  // ── 中栏 · 个股详情（选中持仓后）──────────────────────────────
  const selRow = picked === null ? null : (posRows.find((p) => p.secid === picked) ?? null)
  const selHold = picked === null ? null : (desk?.holdings?.find((h) => h.secid === picked) ?? null)
  const facts: QuoteFacts = {
    price: detail?.price ?? null,
    prev: detail?.prev ?? selHold?.prevClose ?? null,
    pct: detail?.pct ?? null,
    open: detail?.open ?? null,
    high: detail?.high ?? null,
    low: detail?.low ?? null,
    amount: detail?.amount ?? null,
    turnover: detail?.turnover ?? null,
    volumeRatio: detail?.volumeRatio ?? null,
  }
  const head = quoteHeadOf(facts)
  const cells = statCellsOf(facts, selRow?.qty ?? null)
  const marks = picked === null ? [] : fillMarksOf(fills, picked)
  const latestRun = (state?.state.runs ?? []).at(-1) ?? null
  const ai = aiVerdictOf(latestRun as unknown as { verdict?: unknown; confidence?: unknown } | null)

  const chartNode = React.useMemo((): React.ReactElement | null => {
    if (picked === null) return null
    if (chart.kind === 'idle' || chart.kind === 'loading') {
      return React.createElement('div', { className: 'tw-ad-chart-load' }, React.createElement(Skeleton, { lines: 3, height: 40 }))
    }
    if (chart.kind === 'missing') {
      return React.createElement('div', { className: 'tw-ad-chart-miss', 'data-role': 'ad-chart-miss', title: chart.reason }, '—（图未取到）')
    }
    if (chart.kind === 'trend') {
      const t = chart.trend
      const points = t.points.map((p) => ({ t: p.t, value: p.price, vol: p.vol, avg: p.avg, label: p.label, amount: p.amount ?? null }))
      // 图上不再叠 B/S 点：本批的成交标记已经在图上方单独一行（同一条信息画两遍会糊住分时线）
      return React.createElement(TrendChart, {
        points,
        baseline: isUsableBaseline(t.prePrice) ? t.prePrice : null,
        session: sessionOf(picked),
        width: boxW,
        redUp,
        mainH: 138,
        volH: 34,
        macdH: 34,
      })
    }
    const bars = chart.kline.days.map((d) => ({ date: d.date, open: d.open, close: d.close, high: d.high, low: d.low, vol: d.vol }))
    return React.createElement(KlineChart, { bars, width: boxW, redUp, klt: 101, mainH: 190, volH: 40, macdH: 40 })
  }, [picked, chart, boxW, redUp])

  const detailCard = React.createElement('section', { className: 'tw-ad-card tw-ad-quote', 'data-role': 'ad-detail' },
    picked === null
      ? [React.createElement('div', { key: 'hd', className: 'tw-ad-card-head' }, React.createElement('h2', null, '个股详情')),
          React.createElement('div', { key: 'em', className: 'tw-ad-empty' }, missText('个股详情', '选择左侧持仓查看'))]
      : detail === null
        ? [React.createElement('div', { key: 'hd', className: 'tw-ad-card-head' }, React.createElement('h2', null, '个股详情')),
            React.createElement('div', { key: 'em', className: 'tw-ad-empty' }, missText('个股详情', '未取到'))]
        : [
            React.createElement('div', { key: 'head', className: 'tw-ad-q-head' },
              React.createElement('div', { className: 'tw-ad-q-id' },
                React.createElement('div', { className: 'tw-ad-q-name' },
                  React.createElement('h1', { title: detail.name ?? '' }, detail.name ?? selRow?.name ?? '—'),
                  React.createElement('span', { className: 'tw-ad-code' }, codeOf(picked)),
                  React.createElement('span', { className: 'tw-ad-ai' }, 'AI 持仓')),
                React.createElement('div', { className: 'tw-ad-q-sub' },
                  React.createElement('span', null, `成本 ${numText(selRow?.cost ?? null, 3)}`),
                  React.createElement('span', null, `持股 ${selRow === null ? '—' : groupOf(selRow.qty)}`),
                  React.createElement('span', null, `权重 ${weightTextOf(selRow?.weight ?? null)}`))),
              React.createElement('div', { className: 'tw-ad-q-px', 'data-role': 'ad-quote-head' },
                React.createElement('div', { className: `tw-ad-q-price is-${head.tone}`, 'data-role': 'ad-price', title: head.title }, head.priceText),
                React.createElement('div', { className: `tw-ad-q-chg is-${head.tone}` },
                  React.createElement('span', null, head.chgText),
                  React.createElement('span', null, head.pctText)))),
            React.createElement('div', { className: 'tw-ad-q-stats', 'data-role': 'ad-quote-stats' },
              ...cells.filter((c) => c.row === 'a').map((c) => React.createElement('div', { key: c.key, title: c.title },
                React.createElement('span', { className: 'k' }, c.label),
                React.createElement('span', { className: 'v' }, c.value))),
              React.createElement('div', { className: 'tw-ad-q-sep' }),
              ...cells.filter((c) => c.row === 'b').map((c) => React.createElement('div', { key: c.key, title: c.title },
                React.createElement('span', { className: 'k' }, c.label),
                React.createElement('span', { className: 'v' }, c.value)))),
            marks.length === 0
              ? null
              : React.createElement('div', { className: 'tw-ad-marks', 'data-role': 'ad-marks' },
                  ...marks.map((m) => React.createElement('span', { key: m.id, className: `tw-ad-mark is-${m.side}` }, m.text))),
            React.createElement('div', { key: 'chart', className: 'tw-ad-chart', ref: boxRef, 'data-role': 'ad-chart' },
              chartNode,
              React.createElement('div', { className: 'tw-ad-chart-tabs', role: 'tablist' },
                React.createElement('button', { role: 'tab', 'aria-selected': chartTab === 'trend', className: chartTab === 'trend' ? 'on' : '', onClick: () => setChartTab('trend') }, '分时'),
                React.createElement('button', { role: 'tab', 'aria-selected': chartTab === 'kline', className: chartTab === 'kline' ? 'on' : '', onClick: () => setChartTab('kline') }, '日K'))),
            React.createElement('div', { key: 'ai', className: 'tw-ad-verdict', 'data-role': 'ad-verdict' },
              React.createElement('span', { className: 'vb' }, 'AI 研判'),
              React.createElement('div', { className: 'vt', title: ai.title ?? undefined }, ai.text),
              React.createElement('div', { className: 'conf' }, '置信度', React.createElement('b', null, ai.confidence))),
          ])

  // ── 中栏 · 决策流（runs 派生；六 tab 计数真实；时间倒序）──
  const flowEntries = React.useMemo(
    () => flowEntriesOf({ runs: state?.state.runs ?? [], orders: state?.state.orders ?? [] }),
    [state],
  )
  const flowCounts = React.useMemo(() => flowCountsOf(flowEntries), [flowEntries])
  const flowView = React.useMemo(() => flowWindowOf(flowEntries, flowTab), [flowEntries, flowTab])

  // 决策流单屏最多 60 条：用 memo 锁住，避免顶部时钟每秒 tick 把整条时间轴重算一遍
  const feedCard = React.useMemo(() => React.createElement('section', { className: 'tw-ad-card tw-ad-feed', 'data-role': 'ad-flow' },
    React.createElement('div', { className: 'tw-ad-card-head' },
      React.createElement('span', { className: 'tw-ad-auth' }, 'AGENT'),
      React.createElement('h2', null, '决策流'),
      React.createElement('span', { className: 'tw-ad-flow-meta', 'data-role': 'ad-flow-meta' }, `只读 · ${flowCounts.all} 条留痕`),
      React.createElement('span', { className: 'tw-ad-sp' }),
      React.createElement('button', { className: 'tw-ad-fchip', 'data-role': 'ad-replay', disabled: true, title: '宿主未提供重放接口' }, '↺ 重放今日')),
    React.createElement('div', { className: 'tw-ad-flow-bar', role: 'tablist', 'data-role': 'ad-flow-bar' },
      ...FLOW_TABS.map((t) => React.createElement('button', {
        key: t.id, role: 'tab', 'aria-selected': flowTab === t.id, 'data-tab': t.id,
        className: `tw-ad-fchip${flowTab === t.id ? ' on' : ''}`,
        onClick: () => setFlowTab(t.id),
      }, t.label, React.createElement('span', { className: 'cn', 'data-role': `ad-flow-count-${t.id}` }, String(flowCounts[t.id]))))),
    flowEntries.length === 0
      ? React.createElement('div', { className: 'tw-ad-empty' }, missText('决策记录'))
      : React.createElement('div', { className: 'tw-ad-feed-list', 'data-role': 'ad-flow-list' },
          ...flowView.rows.map((e) => flowEntryNode(e)),
          flowView.truncated
            ? React.createElement('div', { key: 'more', className: 'tw-ad-feed-more' }, `仅显示最近 ${flowView.shown} 条 · 共 ${flowView.total} 条`)
            : null)), [flowView, flowCounts, flowTab, flowEntries])

  // ── 右栏 · 账户总览（大数 + 今日/累计 + 四格 + 仓位条）──
  const ov = desk?.overview
  const acctView = accountViewOf({
    totalAssets: ov?.totalAssets ?? null,
    capitalLimit: capital,
    dayStartEquity: acct?.dayStartEquity ?? null,
    cash: ov?.cash ?? null,
    positionPct: ov?.positionPct ?? null,
    rows: desk?.positions?.rows ?? [],
    equity: state?.state.equity ?? [],
    day: acct?.day ?? null,
  })
  const acctCard = React.createElement('section', { className: 'tw-ad-card tw-ad-acct', 'data-role': 'ad-overview' },
    React.createElement('div', { className: 'tw-ad-card-head' },
      React.createElement('h2', null, '账户总览'),
      React.createElement('span', { className: 'tw-ad-sp' }),
      React.createElement('span', { className: 'tw-ad-ro', 'data-role': 'ad-readonly' }, '只读')),
    ov === undefined
      ? React.createElement('div', { className: 'tw-ad-empty' }, missText('账户数据'))
      : [
          React.createElement('div', { key: 'top', className: 'tw-ad-acct-top' },
            React.createElement('div', { className: 'tw-ad-acct-lab' }, React.createElement('span', null, '总资产（元）')),
            React.createElement('div', { className: 'tw-ad-acct-total', 'data-role': 'ad-total' }, acctView.totalText),
            React.createElement('div', { className: 'tw-ad-acct-pnl', 'data-role': 'ad-daypnl' },
              React.createElement('span', { className: 'k' }, '今日盈亏'),
              React.createElement('span', { className: `d1 is-${acctView.dayTone}` }, acctView.dayText),
              React.createElement('span', { className: `d2 is-${acctView.dayTone}` }, `(${acctView.dayPctText})`),
              React.createElement('span', { className: 'd3', title: '总资产 − 资产上限' },
                '累计 ',
                React.createElement('b', { className: `is-${acctView.cumTone}` }, acctView.cumText),
                ` · ${acctView.cumPctText}`))),
          React.createElement('div', { key: 'grid', className: 'tw-ad-acct-grid', 'data-role': 'ad-acct-grid' },
            ...acctView.cells.map((c) => React.createElement('div', { key: c.key, title: c.title },
              React.createElement('span', null, c.label),
              React.createElement('b', { className: `is-${c.tone}` }, c.value)))),
          React.createElement('div', { key: 'bar', className: 'tw-ad-acct-bar-row' },
            React.createElement('span', { className: 'lb' }, '仓位'),
            React.createElement('div', { className: 'tw-ad-acct-bar', 'data-role': 'ad-pos-bar' },
              React.createElement('i', { style: { transform: `scaleX(${acctView.positionRatio === null ? 0 : Math.min(1, Math.max(0, acctView.positionRatio))})` } }),
              maxPosSaved === null ? null : React.createElement('span', { className: 'tick', style: { left: `${Math.min(100, Math.max(0, maxPosSaved))}%` }, title: `最大总仓位刻度 ${maxPosSaved}%（已保存值）` })),
            React.createElement('span', { className: 'pv', 'data-role': 'ad-pos-pct' }, acctView.positionText)),
        ])

  // ── 右栏 · 持仓 / 挂单（tab 卡）──
  const pending = pendingOrdersOf(state?.state.orders ?? [])
  const perStockSaved = savedLimits.perStockPct
  const panelPanes = panelTab === 'pos'
    ? [
        React.createElement('div', { key: 'h', className: 'tw-ad-rp-head' },
          React.createElement('span', null, '标的'), React.createElement('span', null, '权重'), React.createElement('span', null, '盈亏')),
        posRows.length === 0
          ? React.createElement('div', { key: 'e', className: 'tw-ad-empty' }, missText('持仓'))
          : React.createElement('div', { key: 'l', className: 'tw-ad-rp-list' },
              ...posRows.map((p) => {
                const pctText = pnlPctOf(p.price ?? null, p.cost) ?? '—'
                const over = p.weight !== null && perStockSaved !== null && p.weight * 100 > perStockSaved
                return React.createElement('div', {
                  key: p.secid, className: 'tw-ad-rp-row', role: 'button', tabIndex: 0, 'data-role': 'ad-rp-row', 'data-secid': p.secid,
                  onClick: () => setPicked(p.secid),
                  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPicked(p.secid) } },
                },
                React.createElement('div', { className: 'tw-ad-rp-n' },
                  React.createElement('span', { className: 'a', title: p.name }, p.name),
                  React.createElement('span', { className: 'b' }, codeOf(p.secid))),
                React.createElement('div', { className: `tw-ad-rp-w${over ? ' over' : ''}`, title: over ? `权重 ${weightTextOf(p.weight)} 超单票上限 ${perStockSaved}%` : `权重 = 市值 / 总资产` }, weightTextOf(p.weight)),
                React.createElement('div', { className: `tw-ad-rp-p is-${pnlToneOf(p.pnl)}`, title: `成本 ${numText(p.cost, 3)}` }, pctText))
              })),
      ]
    : [
        React.createElement('div', { key: 'h', className: 'tw-ad-ord-head' },
          React.createElement('span', null, '委托'), React.createElement('span', null, '进度')),
        pending.length === 0
          ? React.createElement('div', { key: 'e', className: 'tw-ad-empty' }, '—（当前无挂单）')
          : React.createElement('div', { key: 'l', className: 'tw-ad-ord-list' },
              ...pending.map((o) => {
                const ratio = orderProgressOf(o)
                return React.createElement('div', { key: o.id, className: 'tw-ad-ord', 'data-role': 'ad-ord-row' },
                  React.createElement('div', { className: 'tw-ad-ord-top' },
                    React.createElement('span', { className: `tw-ad-ord-side is-${o.side}` }, o.side === 'buy' ? 'BUY' : 'SELL'),
                    React.createElement('span', { className: 'tw-ad-ord-name', title: o.name }, o.name),
                    React.createElement('span', { className: 'tw-ad-ord-st' }, '待成交')),
                  React.createElement('div', { className: 'tw-ad-ord-sub' },
                    React.createElement('span', null, `限价 ${numText(o.price, 2)}`),
                    React.createElement('span', null, `数量 ${groupOf(o.shares)}`),
                    React.createElement('span', null, `已成 ${groupOf(o.filledShares ?? 0)}`),
                    React.createElement('span', null, shClockText(o.decidedAt).slice(0, 5))),
                  React.createElement('div', { className: 'tw-ad-ord-prog' }, React.createElement('i', { style: { transform: `scaleX(${ratio})` } })))
              })),
      ]

  const panelCard = React.createElement('section', { className: 'tw-ad-card tw-ad-panel', 'data-role': 'ad-panel' },
    React.createElement('div', { className: 'tw-ad-card-head' },
      React.createElement('div', { className: 'tw-ad-ptabs', role: 'tablist' },
        React.createElement('button', {
          role: 'tab', 'aria-selected': panelTab === 'pos', className: `tw-ad-pt${panelTab === 'pos' ? ' on' : ''}`,
          'data-role': 'ad-tab-pos', onClick: () => setPanelTab('pos'),
        }, '持仓 ', React.createElement('em', null, String(posRows.length))),
        React.createElement('button', {
          role: 'tab', 'aria-selected': panelTab === 'ord', className: `tw-ad-pt${panelTab === 'ord' ? ' on' : ''}`,
          'data-role': 'ad-tab-ord', onClick: () => setPanelTab('ord'),
        }, '挂单 ', React.createElement('em', null, String(pending.length)))),
      React.createElement('span', { className: 'tw-ad-sp' }),
      perStockSaved === null
        ? null
        : React.createElement('span', { className: 'tw-ad-panel-hint', 'data-role': 'ad-cap-hint', title: '单票上限（已保存约束）' }, `权重 / 上限 ${numText(perStockSaved, 0)}%`)),
    ...panelPanes)

  // ── 右栏 · Agent 绩效（四格 + 净值 sparkline）──
  const pf = desk?.performance
  const perfCells = perfCellsOf({
    runsCount: pf?.runsCount ?? null,
    hitRate: pf?.hitRate ?? null,
    maxDrawdown: pf?.maxDrawdown ?? null,
    excessPct: pf?.excessPct ?? null,
  })
  const spark = sparkOf(state?.state.equity ?? [])
  const [sparkRef, sparkW] = useBoxWidth(320, 120)
  const perfCard = React.createElement('section', { className: 'tw-ad-card tw-ad-perf', 'data-role': 'ad-perf' },
    React.createElement('div', { className: 'tw-ad-card-head' },
      React.createElement('h2', null, 'Agent 绩效'),
      React.createElement('span', { className: 'tw-ad-sp' }),
      React.createElement('span', { className: 'tw-ad-hint-2' }, '近 20 交易日')),
    pf === undefined
      ? React.createElement('div', { className: 'tw-ad-empty' }, missText('Agent 绩效'))
      : [
          React.createElement('div', { key: 'g', className: 'tw-ad-perf-row', 'data-role': 'ad-perf-row' },
            ...perfCells.map((c) => React.createElement('div', { key: c.key, title: c.title },
              React.createElement('span', null, c.label),
              React.createElement('b', null, c.value)))),
          spark.has
            ? React.createElement('div', { key: 's', className: 'tw-ad-spark', ref: sparkRef, 'data-role': 'ad-spark' },
                React.createElement(Sparkline, {
                  points: spark.points, width: sparkW, height: 40, up: spark.up,
                  upColor: 'var(--tw-up)', downColor: 'var(--tw-down)',
                }))
            : React.createElement('div', { key: 's', className: 'tw-ad-spark-miss', 'data-role': 'ad-spark-miss', title: '净值点不足 2 个，画不出曲线' }, '—（样本不足）'),
        ])

  // ── 底部状态条（28px）：行情源 / 决策引擎 / T / 决策周期 / 约束版本 / 风控 ──
  const statusFacts = statusFactsOf({
    feed: null,
    model: state?.state.model?.model ?? settings?.model?.model ?? null,
    modelProvider: state?.state.model?.provider ?? null,
    temperature: null,
    times: settings?.times ?? [],
    constraintVersion: null,
    blockedToday: blockedTodayOf(state?.state.orders ?? [], state?.state.runs ?? [], acct?.day ?? null),
  })
  const statusBar = React.createElement('footer', { className: 'tw-ad-sbar', 'data-role': 'ad-sbar' },
    ...statusFacts.flatMap((f, i) => (i === 0
      ? [React.createElement('span', { key: f.key, className: 'tw-ad-sb-item', 'data-fact': f.key, title: f.title ?? undefined },
          React.createElement('i', { className: 'tw-ad-sb-dot' }), f.label, ' ', React.createElement('b', null, f.value))]
      : [
          React.createElement('span', { key: `${f.key}-sep`, className: 'tw-ad-sb-sep' }),
          React.createElement('span', { key: f.key, className: 'tw-ad-sb-item', 'data-fact': f.key, title: f.title ?? undefined },
            f.label, ' ', React.createElement('b', null, f.value)),
        ])))

  return React.createElement('div', { className: 'tw-ad-root', 'data-role': 'prism-agentdesk' },
    topbar,
    React.createElement('div', { className: 'tw-ad-board' },
      React.createElement('div', { className: 'tw-ad-col tw-ad-col-human' },
        React.createElement('div', { className: 'tw-ad-banner' },
          React.createElement('svg', { ...LOGO_PROPS, className: 'tw-ad-lock' },
            React.createElement('rect', { x: 4, y: 10.5, width: 16, height: 10, rx: 2 }),
            React.createElement('path', { d: 'M8 10.5V7a4 4 0 1 1 8 0v3.5' })),
          React.createElement('span', null, '约束与持仓由人类设定，Agent 只执行')),
        human),
      React.createElement('div', { className: 'tw-ad-col' }, state === null ? React.createElement(Skeleton, { lines: 3, height: 40 }) : detailCard, state === null ? null : feedCard),
      React.createElement('div', { className: 'tw-ad-col' }, state === null ? React.createElement(Skeleton, { lines: 2, height: 40 }) : acctCard, state === null ? null : panelCard, state === null ? null : perfCard)),
    statusBar,
    menuFor === null ? null : React.createElement('button', { className: 'tw-ad-scrim', 'aria-label': '关闭菜单', onClick: () => setMenuFor(null) }),
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
