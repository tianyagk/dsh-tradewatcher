/**
 * 【棱镜】页（第 9 行 `prism`；只读推演 —— 不下单、不连券商）。
 *
 * 交付口径（用户裁决，断言见 `src/client/prismView.test.ts`）：
 *  · **六个块**：Bayes / Edge / Spread / Stoikov / Kelly / Monte Carlo，缺输入一律 `—` + 一句原因；
 *  · **注解类文案一律不上屏**（用户裁决）：页面只有数据事实与口径，没有免责/提示类文案；
 *  · **目标价必须带规则名**（`ATR×k` / `历史 P95`）+ 全部输入（可复算），不许只给裸数字；
 *  · 结论三态 `看多 / 看空 / 不下结论`，Edge 不达标必须走「不下结论」；
 *  · Kelly / Stoikov 的标题与数值固定带「模拟」（防误读为实盘仓位，属口径）；
 *  · **参数常驻可见**：每个参数一行 `标签 值 单位`（`prismParamRowText`）+ 紧凑行内控件；
 *  · 切换频率**只换 `freq` 查询参数**（同一个接口）。
 *
 * 极简：常驻区只留"值 + 规则名 + 原因"，口径/公式解释不铺在页面上（`PRISM_MODEL` 一行除外）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  PRISM_DEFAULT_PARAMS,
  PRISM_FREQS,
  PRISM_MODEL,
  type PrismBlockKey,
  type PrismBlocks,
  type PrismFreq,
  type PrismParams,
  type PrismPayload,
  type PrismStance,
} from '../shared/prism.ts'
import { api } from './api.ts'
import { createRequestGen } from './requestGen.ts'
import {
  DASH,
  PRISM_BLOCK_TITLE,
  PRISM_FREQ_LABEL,
  actionOf,
  asOfText,
  barsLine,
  dataLine,
  fallbackText,
  bookText,
  fmtBps,
  fmtNum,
  fmtP,
  fmtPct,
  fmtPrice,
  prismParamRowText,
  prismParamRows,
  prismQueryOf,
  quoteMidText,
  spreadStateText,
  type PrismParamRow,
} from './prismView.ts'
import { ErrorNote } from './ui.tsx'

/* ────────────────────────────── 小原子（字号一律在 12 / 12.5 / 13 / 14 阶梯内） ────────────────────────────── */

const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, padding: '2px 0' }
const kStyle: React.CSSProperties = { fontSize: 12, color: 'var(--tw-muted)', whiteSpace: 'nowrap' }
const vStyle: React.CSSProperties = { fontSize: 13, fontFamily: 'var(--tw-mono)', fontVariantNumeric: 'tabular-nums', textAlign: 'right', wordBreak: 'break-all' }

const KV = (props: { k: string; v: React.ReactNode; tone?: string }): React.ReactElement =>
  React.createElement(
    'div',
    // key 取标签（用于数组渲染，避免 React 的 key 警告；同一块内标签互不重复）
    { key: props.k, style: rowStyle },
    React.createElement('span', { style: kStyle }, props.k),
    React.createElement('span', { style: { ...vStyle, color: props.tone ?? 'var(--tw-text)' } }, props.v),
  )

/** 纯文本行（值走统一格式化；null ⇒ `—`，不写 0） */
const KText = (props: { k: string; v: string }): React.ReactElement => KV({ k: props.k, v: props.v })

/** 数值行：`null` ⇒ `—` */
const KNum = (props: { k: string; v: number | null; fmt: (v: number | null) => string }): React.ReactElement => KV({ k: props.k, v: props.fmt(props.v) })

/** 不可算块的内容：`—` + 原因（一句话，来自宿主回包） */
const Missing = (props: { block: { available: boolean; reason: string | null }; what: string }): React.ReactElement =>
  React.createElement(
    'div',
    { 'data-missing': props.what, style: { ...rowStyle, alignItems: 'flex-start' } },
    React.createElement('span', { style: { ...vStyle, textAlign: 'left', fontSize: 12 } }, `${DASH} ${props.block.reason ?? '未取到原因'}`),
  )

/** 参数值文本的样式（与 `ParamText` 分离，纯为让可见节点保持一行） */
const PARAM_TEXT_STYLE: React.CSSProperties = { fontSize: 12, color: 'var(--tw-text)', whiteSpace: 'nowrap' }

/** 参数值的**可见节点**（页面唯一出口；断言 ⑤ 锚它：值必须是 createElement 的子节点，不许进 title） */
const ParamText = (props: { row: PrismParamRow }): React.ReactElement =>
  React.createElement('span', { 'data-param-text': '1', style: PARAM_TEXT_STYLE }, prismParamRowText(props.row))

const Badge = (props: { text: string; on?: boolean }): React.ReactElement =>
  React.createElement(
    'span',
    {
      style: {
        fontSize: 12,
        padding: '1px 7px',
        borderRadius: 999,
        border: `1px solid ${props.on === true ? 'var(--tw-accent)' : 'var(--tw-border)'}`,
        color: props.on === true ? 'var(--tw-accent)' : 'var(--tw-dim)',
        whiteSpace: 'nowrap',
      },
    },
    props.text,
  )

/** 迷你折线（无图表库：一条 `<polyline>`；值不足 2 点 ⇒ 不画） */
function sparkline(values: readonly number[], width = 260, height = 34): React.ReactElement | null {
  if (values.length < 2) return null
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo === 0 ? 1 : hi - lo
  const step = width / (values.length - 1)
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - lo) / span) * height).toFixed(1)}`).join(' ')
  return React.createElement(
    'svg',
    { width, height: height + 2, viewBox: `0 0 ${width} ${height + 2}`, 'aria-hidden': true, style: { display: 'block', marginTop: 4 } },
    React.createElement('polyline', { points, fill: 'none', stroke: 'var(--tw-accent)', strokeWidth: 1.2 }),
  )
}

/* ────────────────────────────── 页面 ────────────────────────────── */

const BTN: React.CSSProperties = { fontSize: 12, padding: '1px 6px', border: '1px solid var(--tw-border)', borderRadius: 6, color: 'var(--tw-dim)' }
const BTN_ON: React.CSSProperties = { ...BTN, borderColor: 'var(--tw-accent)', color: 'var(--tw-accent)' }
const INPUT: React.CSSProperties = { width: 72, fontSize: 12, padding: '1px 5px' }

export function PrismPage(props: { active?: boolean }): React.ReactElement {
  const [params, setParams] = useState<PrismParams>(PRISM_DEFAULT_PARAMS)
  const [payload, setPayload] = useState<PrismPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const gen = useRef(createRequestGen())

  const query = useMemo(() => prismQueryOf(params), [params])

  // 取数：参数变化 ⇒ 只换 query（同一个接口）；250ms 去抖 + 代号丢弃旧响应。
  // 保活页在**未打开**时不取数（否则插件一启动就会回源 5 分钟线与五档）。
  useEffect(() => {
    if (props.active === false) return undefined
    const g = gen.current
    const mine = g.next()
    const timer = window.setTimeout(() => {
      api.prism(params).then(
        (p) => {
          if (g.stale(mine)) return
          setPayload(p)
          setError(null)
        },
        (e: unknown) => {
          if (g.stale(mine)) return
          setError(`棱镜取数失败：${String(e instanceof Error ? e.message : e).slice(0, 120)}`)
        },
      )
    }, 250)
    return () => window.clearTimeout(timer)
    // params 的语义由 query 表达（同一份 query ⇒ 不必重发）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, attempt, props.active])

  function set<K extends keyof PrismParams>(key: K, value: PrismParams[K]): void {
    setParams((prev) => ({ ...prev, [key]: value }))
  }

  // 宿主已做默认/回退解析：`payload.params.pairA` 是**实际使用**的标的（首次打开或选到无源市场时）。
  // 把它同步进参数框（断言 ③：回退但不更新显示 ⇒ 必败）；用户正在输入时不打扰。
  useEffect(() => {
    if (payload === null) return
    const actual = payload.params.pairA
    if (actual === '' || actual === params.pairA) return
    if (params.pairA === '' || payload.fallback !== null) {
      setParams((prev) => ({ ...prev, pairA: actual }))
    }
  }, [payload, params.pairA])

  const rows = prismParamRows(params)

  /** 一行参数：**常驻显示当前值**（`prismParamRowText`）+ 紧凑控件 */
  function param(key: keyof PrismParams, control: React.ReactNode): React.ReactElement {
    const row: PrismParamRow = rows.find((r) => r.key === key) ?? { key, label: String(key), value: DASH, unit: '' }
    return React.createElement(
      'div',
      { 'data-param': key, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '2px 0' } },
      React.createElement(ParamText, { row }),
      React.createElement('span', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' } }, control),
    )
  }

  const btn = (on: boolean, text: string, onClick: () => void, key?: string): React.ReactElement =>
    React.createElement('button', { key: key ?? text, style: on ? BTN_ON : BTN, onClick, 'data-on': on ? '1' : '0' }, text)
  const num = (key: keyof PrismParams, value: number, step = 1, min?: number, max?: number): React.ReactElement =>
    React.createElement('input', {
      style: INPUT,
      type: 'number',
      step,
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      value: String(value),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const n = Number(e.target.value)
        if (Number.isFinite(n)) set(key, n as never)
      },
    })
  const text = (key: 'pairA' | 'pairB', value: string): React.ReactElement =>
    React.createElement('input', {
      style: { ...INPUT, width: 118 },
      list: 'tw-prism-universe',
      value,
      placeholder: 'secid',
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value.trim() === '' && key === 'pairB' ? null : (e.target.value as never)),
    })

  const card = (key: PrismBlockKey, body: React.ReactNode, extra?: React.ReactNode): React.ReactElement =>
    React.createElement(
      'div',
      { className: 'tw-panel', 'data-block': key, key },
      React.createElement(
        'div',
        { className: 'tw-panel-h' },
        React.createElement('span', { style: { fontWeight: 600, fontSize: 13 } }, PRISM_BLOCK_TITLE[key]),
        extra ?? null,
      ),
      body,
    )

  const blocks: PrismBlocks | null = payload?.blocks ?? null
  const stance: PrismStance = blocks?.edge.stance ?? '不下结论'

  return React.createElement(
    'div',
    { className: 'tw-body', 'data-page': 'prism' },
    // 顶部：标题 + 数据时刻 + 频率口径 + 模型口径一行
    React.createElement(
      'div',
      { className: 'tw-panel' },
      React.createElement(
        'div',
        { className: 'tw-panel-h' },
        React.createElement('span', { style: { fontWeight: 600, fontSize: 14 } }, '棱镜'),
        React.createElement('span', { style: { fontSize: 12, color: 'var(--tw-muted)' } }, `数据 ${asOfText(payload)} · ${dataLine(payload)}`),
        React.createElement('span', { style: { flex: 1 } }),
        React.createElement('button', { className: 'tw-iconbtn', onClick: () => setAttempt((n) => n + 1) }, '重算'),
      ),
      // 顶部只留一行模型口径（数据口径，不是注解）
      React.createElement('div', { style: { fontSize: 12, color: 'var(--tw-muted)', padding: '2px 0' } }, PRISM_MODEL),
      error === null ? null : React.createElement(ErrorNote, { error }),
      React.createElement('datalist', { id: 'tw-prism-universe' },
        (payload?.universe ?? []).map((u) => React.createElement('option', { key: u.secid, value: u.secid }, u.name)),
      ),
      // 参数区（紧凑行内控件；每行常驻显示当前值）
      React.createElement(
        'div',
        { 'data-prism-params': '1', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0 14px', marginTop: 4 } },
        param('freq', PRISM_FREQS.map((f) => btn(params.freq === f, PRISM_FREQ_LABEL[f], () => set('freq', f as PrismFreq), String(f)))),
        param('pairA', text('pairA', params.pairA)),
        param('pairB', text('pairB', params.pairB ?? '')),
        param('zN', [20, 60, 120].map((n) => btn(params.zN === n, String(n), () => set('zN', n), String(n)))),
        param('zTh', [2, 3].map((n) => btn(params.zTh === n, String(n), () => set('zTh', n), String(n)))),
        param('prior', [
          btn(Math.abs(params.prior - 0.5) < 1e-9, '震荡 0.50', () => set('prior', 0.5), 'a'),
          btn(Math.abs(params.prior - 0.55) < 1e-9, '趋势 0.55', () => set('prior', 0.55), 'b'),
        ]),
        param('evMinBps', num('evMinBps', params.evMinBps, 0.5)),
        param('feeBps', num('feeBps', params.feeBps, 0.5)),
        param('slipBps', num('slipBps', params.slipBps, 0.5)),
        param('latencyMs', num('latencyMs', params.latencyMs, 50)),
        param('gamma', num('gamma', params.gamma, 0.05)),
        param('q', num('q', params.q, 10)),
        param('ttBars', num('ttBars', params.ttBars, 1)),
        param('kellyFrac', [0.25, 0.5, 1].map((n) => btn(Math.abs(params.kellyFrac - n) < 1e-9, n === 1 ? '1' : n === 0.5 ? '1/2' : '1/4', () => set('kellyFrac', n), String(n)))),
        param('tgtK', [1, 2, 3].map((n) => btn(params.tgtK === n, String(n), () => set('tgtK', n), String(n)))),
        param('mcRuns', [10000, 20000, 50000].map((n) => btn(params.mcRuns === n, String(n), () => set('mcRuns', n), String(n)))),
        param('mcFill', [0.5, 0.75, 1].map((n) => btn(Math.abs(params.mcFill - n) < 1e-9, `${Math.round(n * 100)}%`, () => set('mcFill', n), String(n)))),
        param('mcPErr', [0.02, 0.05, 0.1].map((n) => btn(Math.abs(params.mcPErr - n) < 1e-9, `±${n.toFixed(2)}`, () => set('mcPErr', n), String(n)))),
      ),
      React.createElement('div', { style: { fontSize: 12, color: 'var(--tw-muted)', marginTop: 2 } },
        `${barsLine(payload)}${fallbackText(payload) === '' ? '' : ` · ${fallbackText(payload)}`}`),
    ),

    // ① Bayes 认知
    card(
      'bayes',
      blocks === null || !blocks.bayes.available
        ? React.createElement(Missing, { block: blocks?.bayes ?? { available: false, reason: '回包未到' }, what: 'bayes' })
        : React.createElement(
            'div',
            null,
            KV({ k: '上涨 p', v: fmtP(blocks.bayes.p) }),
            KNum({ k: '先验', v: blocks.bayes.prior, fmt: (v) => (v === null ? DASH : v.toFixed(2)) }),
            KNum({ k: '量能 z', v: blocks.bayes.features.volZ, fmt: (v) => fmtNum(v, 2) }),
            KNum({ k: '价格位置', v: blocks.bayes.features.pos, fmt: (v) => fmtNum(v, 3) }),
            KNum({ k: '连续性', v: blocks.bayes.features.streak, fmt: (v) => fmtNum(v, 2) }),
            KText({ k: '样本', v: `${blocks.bayes.samples} 根` }),
            sparkline(blocks.bayes.series),
          ),
      React.createElement(Badge, { text: `p ${fmtP(blocks?.bayes.p ?? null)}` }),
    ),

    // ② Edge 优势（结论三态 + 目标价带规则名）
    card(
      'edge',
      blocks === null || !blocks.edge.available
        ? React.createElement(Missing, { block: blocks?.edge ?? { available: false, reason: '回包未到' }, what: 'edge' })
        : React.createElement(
            'div',
            null,
            KV({ k: '结论', v: stance, tone: stance === '不下结论' ? 'var(--tw-dim)' : 'var(--tw-accent)' }),
            KV({ k: '推演动作', v: actionOf(stance), tone: stance === '不下结论' ? 'var(--tw-dim)' : 'var(--tw-accent)' }),
            KText({ k: '判据', v: blocks.edge.stanceWhy }),
            KNum({ k: 'EV', v: blocks.edge.evBps, fmt: fmtBps }),
            KV({ k: 'EV 阈值', v: fmtBps(blocks.edge.thresholdBps) }),
            KNum({ k: '平均盈利', v: blocks.edge.avgWinBps, fmt: fmtBps }),
            KNum({ k: '平均亏损', v: blocks.edge.avgLossBps, fmt: fmtBps }),
            KNum({ k: '成本合计', v: blocks.edge.costBps, fmt: fmtBps }),
            KNum({ k: '其中延迟惩罚', v: blocks.edge.latencyPenaltyBps, fmt: fmtBps }),
            ...blocks.edge.targets.map((t) =>
              KV({
                k: `目标价（${t.ruleLabel}）`,
                v:
                  t.value === null
                    ? `${DASH} ${t.reason ?? ''}`
                    : `${fmtPrice(t.value)} · ${Object.entries(t.inputs)
                        .map(([k, v]) => `${k} ${v === null ? DASH : Number(v).toFixed(k === 'k' || k === 'dir' ? 0 : 2)}`)
                        .join(' · ')}`,
              }),
            ),
            blocks.edge.targets.length === 0 ? KText({ k: '目标价', v: `${DASH} 不下结论时不给目标价` }) : null,
          ),
      React.createElement(Badge, { text: stance, on: stance !== '不下结论' }),
    ),

    // ③ Spread 价差（只给 z / mid / 是否越阈，不给挂单价）
    card(
      'spread',
      blocks === null || !blocks.spread.available
        ? React.createElement(Missing, { block: blocks?.spread ?? { available: false, reason: '回包未到' }, what: 'spread' })
        : React.createElement(
            'div',
            null,
            KV({ k: '配对', v: `${payload?.symbols.a ?? DASH} / ${blocks.spread.pairB ?? DASH}` }),
            KNum({ k: 'z', v: blocks.spread.z, fmt: (v) => fmtNum(v, 2) }),
            KV({ k: '阈值', v: `|z| ${blocks.spread.threshold}` }),
            KText({ k: '状态', v: spreadStateText(blocks.spread) }),
            KNum({ k: 'mid（ln A/B）', v: blocks.spread.mid, fmt: (v) => fmtNum(v, 6) }),
            KText({ k: 'mid 输入', v: `mid：${blocks.spread.midSource}` }),
            blocks.spread.midReason === null ? null : KText({ k: 'mid 原因', v: blocks.spread.midReason }),
            KText({ k: '盘口价（1 档）', v: quoteMidText(blocks.spread.book) }),
            KText({ k: '样本', v: `${blocks.spread.samples} 根（N=${blocks.spread.n}）` }),
            KText({ k: '五档', v: bookText(blocks.spread.book) }),
          ),
      React.createElement(Badge, { text: blocks?.spread.beyond === null || blocks?.spread.beyond === undefined ? '未越阈' : '越阈' }),
    ),

    // ④ Stoikov 模拟保留价（T−t 保护必须可见）
    card(
      'stoikov',
      blocks === null || !blocks.stoikov.available
        ? React.createElement(Missing, { block: blocks?.stoikov ?? { available: false, reason: '回包未到' }, what: 'stoikov' })
        : React.createElement(
            'div',
            null,
            KNum({ k: '保留价 r（模拟）', v: blocks.stoikov.reserve, fmt: fmtPrice }),
            KNum({ k: '中间价 s', v: blocks.stoikov.s, fmt: fmtPrice }),
            KText({ k: 's 输入', v: `s：${blocks.stoikov.sSource}` }),
            KNum({ k: 'γ', v: blocks.stoikov.gamma, fmt: (v) => fmtNum(v, 2) }),
            KNum({ k: 'σ²', v: blocks.stoikov.sigmaSq, fmt: (v) => fmtNum(v, 4) }),
            KV({ k: '模拟库存 q', v: String(blocks.stoikov.q) }),
            KV({ k: 'T−t', v: `${blocks.stoikov.ttBars} 根` }),
            KText({ k: '保护', v: blocks.stoikov.protected ? `已生效：${blocks.stoikov.protectReason ?? ''}` : '未触发' }),
          ),
      React.createElement(Badge, { text: blocks?.stoikov.protected === true ? '保护已生效' : '模拟', on: blocks?.stoikov.protected === true }),
    ),

    // ⑤ Kelly 模拟仓位（固定「模拟」+「不是建议、不可下单」）
    card(
      'kelly',
      blocks === null || !blocks.kelly.available
        ? React.createElement(Missing, { block: blocks?.kelly ?? { available: false, reason: '回包未到' }, what: 'kelly' })
        : React.createElement(
            'div',
            null,
            KV({ k: '模拟仓位', v: `${fmtPct(blocks.kelly.fScaled === null ? null : blocks.kelly.fScaled * 100)} · 模拟值` }),
            KNum({ k: 'f* 原始', v: blocks.kelly.fStar, fmt: (v) => (v === null ? DASH : v.toFixed(3)) }),
            KNum({ k: '赔率 b', v: blocks.kelly.b, fmt: (v) => fmtNum(v, 3) }),
            KNum({ k: 'p', v: blocks.kelly.p, fmt: fmtP }),
            KV({ k: '分数系数', v: `${Math.round(blocks.kelly.frac * 100)}%` }),
            React.createElement('div', { style: { fontSize: 12, color: 'var(--tw-dim)', marginTop: 2 } }, '模拟值（f* × 分数系数）'),
          ),
      React.createElement(Badge, { text: '模拟' }),
    ),

    // ⑥ Monte Carlo 风控（四条假设全部上屏）
    card(
      'mc',
      blocks === null || !blocks.mc.available
        ? React.createElement(
            'div',
            null,
            React.createElement(Missing, { block: blocks?.mc ?? { available: false, reason: '回包未到' }, what: 'mc' }),
            // 即便整块不可算，四条假设也照样上屏（它们来自页面参数）
            ...(blocks?.mc.assumptions ?? []).map((a) =>
              KV({ k: `假设 ${a.label}`, v: `${a.value}${a.unit === '' ? '' : a.unit} · ${a.source}` }),
            ),
          )
        : React.createElement(
            'div',
            null,
            ...blocks.mc.assumptions.map((a) => KV({ k: `假设 ${a.label}`, v: `${a.value}${a.unit === '' ? '' : a.unit} · ${a.source}` })),
            KV({ k: '次数 / 笔数', v: `${blocks.mc.runs} 次 × ${blocks.mc.trades} 笔` }),
            KNum({ k: 'MDD P50', v: blocks.mc.mddP50, fmt: (v) => fmtPct(v) }),
            KNum({ k: 'MDD P95', v: blocks.mc.mddP95, fmt: (v) => fmtPct(v) }),
            KNum({ k: '破产概率', v: blocks.mc.ruinProb === null ? null : blocks.mc.ruinProb * 100, fmt: (v) => fmtPct(v) }),
            sparkline(blocks.mc.equity),
          ),
      React.createElement(Badge, { text: `MDD P95 ${fmtPct(blocks?.mc.mddP95 ?? null)}` }),
    ),
  )
}
