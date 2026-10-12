/**
 * 工具箱页（主面板里的一个页）：**目录页 + 工具详情页容器 + 左上角返回按钮**。
 *
 * 布局（用户 v0.74.0 的口径）：
 *   目录页 = **左上角一个最小返回控件（图标 + `返回`）** + 分类标签行（本轮只有「全部」）+ 搜索框（本地过滤）
 *            + 三列卡片网格；卡片 = 左上角标识 chip / 标题 / 一句话说明，**整卡可点**（阴影 + 圆角、原生 button）。
 *            ⚠ 页标题与计数那一行（`工具目录` / `本插件自带 N 个工具`）与卡片页脚那行入口文案已按用户要求删除，
 *              见 `docs/AUDIT-IMPL43.md` §7；`toolsPage.test.ts` 有"全页不许再出现该文案"的断言。
 *   详情页 = KPI 行（含 delta）/ 份额曲线 / **静态**饼图 / 市场表（份额 + 变化）/ 边界声明
 *            + 附加块（A股净流入单列）+ 回放滑块（最近 30 个交易日，本地切换、不发请求）。
 *
 * 数据：由工具自己的 `load()` 取一次（见 `tools/cake.ts` 与 `tools/globalFlowView.ts`），
 * 页面**只渲染** `detailModel()` 的输出 —— 页面里不算份额、不造数、不写第二份占位文案。
 * 主题：一切都用 `var(--tw-*)`（跟随 DSH 主题）与既有 class（`.tw-panel` / `.tw-tab` / `.tw-hint` / `.tw-empty`），
 * **不硬编码深色**；颜色取 `FLOW_SERIES_COLORS`（全部是主题 token）。
 */
import React, { useEffect, useMemo, useState } from 'react'
import {
  CATEGORY_TABS,
  NOT_FETCHED,
  PAGE_BACK_ACTION,
  TOOL_ENTRIES,
  catalogModel,
  detailModel,
  toolById,
  type DetailModel,
  type ToolData,
  type ToolPayload,
} from './toolRegistry.ts'
import { CARD_PROPS, CARD_STYLE, CARD_TAG } from './toolCardView.ts'
import { FLOW_SERIES_COLORS } from './tools/globalFlowView.ts'
import { Btn, EmptyHint } from './ui.tsx'

/**
 * 页头返回控件的图标（内联 SVG，跟主题 `currentColor` ⇒ 深浅色都对）。
 *
 * 为什么用图标 + 文字而不是纯文字：用户要的是"左上方一个小倒退按钮"，
 * `toolsPage.test.ts` 断言"图标与 `返回` 文案必须成对出现"（缺一个都算把控件做丢）。
 */
function BackIcon(): React.ReactElement {
  return React.createElement(
    'svg',
    { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false, style: { display: 'block', marginRight: 2 } },
    React.createElement('path', { key: 'shaft', d: 'M9.5 2.5 4 8l5.5 5.5' }),
  )
}

/** 无数据区的占位框（虚线，跟随主题 token） */
const PLACEHOLDER_BOX: React.CSSProperties = {
  minHeight: 120,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px dashed var(--tw-border-strong)',
  borderRadius: 10,
  background: 'var(--tw-bg2)',
  color: 'var(--tw-muted)',
  fontSize: 11.5,
  padding: '10px 12px',
  textAlign: 'center',
}

const GRID3: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }

export function ToolsPage(props: {
  /** 返回上一个非 tools 页签；`null` ⇒ 没有可返回的页（按钮不渲染） */
  onBack: (() => void) | null
}): React.ReactElement {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  /** 打开的工具 id；null = 目录页 */
  const [openId, setOpenId] = useState<string | null>(null)
  /** 工具数据：一次取数（`load()`）+ 本地回放（`at(step)`，不发请求） */
  const [payload, setPayload] = useState<ToolPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [step, setStep] = useState(0)

  const model = useMemo(() => catalogModel(TOOL_ENTRIES, query, category, CATEGORY_TABS), [query, category])
  const entry = openId === null ? null : toolById(openId)
  const loader = entry?.load

  useEffect(() => {
    setPayload(null)
    setLoadError(null)
    setStep(0)
    if (loader === undefined) return
    let alive = true
    loader()
      .then((next) => {
        if (alive) setPayload(next)
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      alive = false
    }
  }, [loader])

  const data: ToolData | null = useMemo(() => {
    if (loader === undefined) return null
    if (loadError !== null) return { status: `${NOT_FETCHED}：${loadError}`, why: loadError }
    if (payload === null) return null
    return payload.at(step)
  }, [loader, loadError, payload, step])

  return React.createElement(
    'div',
    { className: 'tw-tools', style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' } },
    // 页头：**只有最小返回控件**（图标 + `返回`）。用户已明确删掉页标题与计数那一行 ——
    // 目录页不再有任何标题文案；详情页保留"当前工具是谁"（chip · 名称），否则进去以后认不出在哪个工具里。
    React.createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px 0', flexWrap: 'wrap' } },
      props.onBack === null
        ? null
        : React.createElement(
            Btn,
            { onClick: props.onBack, title: '返回上一个页签', 'aria-label': '返回上一个页签' },
            React.createElement(BackIcon, null),
            PAGE_BACK_ACTION,
          ),
      entry === null ? null : React.createElement('div', { style: { fontWeight: 600, fontSize: 13 } }, `${entry.chip} · ${entry.name}`),
      entry === null ? null : React.createElement('div', { className: 'tw-hint', style: { margin: 0 } }, entry.blurb),
    ),
    entry === null
      ? catalogView(model, { query, category, setQuery, setCategory, onOpen: setOpenId })
      : detailView(detailModel(entry, data), () => setOpenId(null), {
          loading: loader !== undefined && data === null && loadError === null,
          step,
          maxStep: payload === null ? 0 : payload.replayMax,
          onStep: setStep,
        }),
  )
}

/** 目录页：分类标签行 + 搜索框 + 三列卡片网格 */
function catalogView(
  model: ReturnType<typeof catalogModel>,
  io: { query: string; category: string; setQuery: (v: string) => void; setCategory: (v: string) => void; onOpen: (id: string) => void },
): React.ReactElement {
  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px 12px', minHeight: 0 } },
    // 分类标签行（本轮只有「全部」；工具条目自己的分类字段已落库，标签行下一批再加）
    React.createElement(
      'div',
      { className: 'tw-tabs', style: { border: 'none', background: 'transparent', padding: 0 }, role: 'tablist', 'aria-label': '工具分类' },
      model.categories.map((c) =>
        React.createElement(
          'button',
          { key: c.key, className: 'tw-tab', type: 'button', 'data-on': io.category === c.key, onClick: () => io.setCategory(c.key) },
          c.label,
        ),
      ),
    ),
    React.createElement('input', {
      type: 'search',
      value: io.query,
      placeholder: model.searchPlaceholder,
      'aria-label': model.searchPlaceholder,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => io.setQuery(e.target.value),
      style: { maxWidth: 320 },
    }),
    model.empty === null
      ? React.createElement(
          'div',
          { style: GRID3 },
          model.cards.map((card) =>
            // 整卡可点：**原生 button**（键盘可达）+ 阴影/圆角卡片（常量在 toolCardView.ts，断言直接读它）
            // 无障碍名 = 工具名（页脚那行入口文案已按用户要求移除，整卡即入口）
            React.createElement(
              CARD_TAG,
              {
                ...CARD_PROPS,
                key: card.id,
                className: 'tw-panel tw-tool-card',
                title: card.blurb,
                'aria-label': card.title,
                onClick: () => io.onOpen(card.id),
                style: CARD_STYLE,
              },
              React.createElement(
                'span',
                {
                  style: {
                    alignSelf: 'flex-start',
                    fontSize: 10.5,
                    lineHeight: '16px',
                    padding: '0 6px',
                    borderRadius: 6,
                    border: '1px solid var(--tw-border)',
                    background: 'var(--tw-accent-soft)',
                    color: 'var(--tw-accent)',
                  },
                },
                card.chip,
              ),
              React.createElement('div', { style: { fontWeight: 600, fontSize: 12.5 } }, card.title),
              React.createElement('div', { className: 'tw-hint', style: { margin: 0, flex: 1 } }, card.blurb),
            ),
          ),
        )
      : React.createElement(EmptyHint, null, model.empty),
  )
}

/** 详情页：五块真实数据（缺数据区一律走模型里的 `未取到 + 原因` 占位） */
function detailView(
  model: DetailModel,
  backToCatalog: () => void,
  io: { loading: boolean; step: number; maxStep: number; onStep: (n: number) => void },
): React.ReactElement {
  const hasCurve = model.curve.series.length > 0 && model.curve.days.length > 0
  const hasPie = model.pie.slices.length > 0
  const hasRows = model.market.rows.length > 0
  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px 12px' } },
    React.createElement(Btn, { onClick: backToCatalog, title: '回到工具目录' }, model.backAction),
    // 状态行：数据时刻 / 来源 / 曲线构成（缺数据时它就是原因）。
    // ⚠ **不用 `tw-hint`**：紧凑/隐身档会把 `.tw-hint` 整类隐藏（styles.ts:90-98），
    // 而"这一屏的数据来自快照/回退"是诚实性信息，必须默认可见（AUDIT-IMPL46 §4）。
    React.createElement('div', { 'data-role': 'tool-status', style: { margin: 0, fontSize: 11.5, lineHeight: 1.6, color: 'var(--tw-muted)' } }, io.loading ? '正在取数…' : model.status),
    React.createElement(
      'div',
      { className: 'tw-panel' },
      React.createElement(
        'div',
        { className: 'tw-panel-h' },
        React.createElement('span', { className: 't' }, model.kpi.title),
        React.createElement('span', { className: 'tw-hint', style: { margin: 0 } }, model.kpi.note),
      ),
      React.createElement(
        'div',
        { style: { display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, model.kpi.cells.length)}, minmax(0, 1fr))`, gap: 8 } },
        model.kpi.cells.map((cell) =>
          React.createElement(
            'div',
            { key: cell.label, style: { border: '1px solid var(--tw-border)', borderRadius: 9, padding: '6px 9px', background: 'var(--tw-card2)', minWidth: 0 } },
            React.createElement('div', { className: 'tw-hint', style: { margin: 0 } }, cell.label),
            React.createElement('div', { style: { fontSize: 12.5, color: cell.value === null ? 'var(--tw-muted)' : 'var(--tw-text)', wordBreak: 'break-word' } }, cell.text),
            cell.delta === null ? null : React.createElement('div', { className: 'tw-hint', style: { margin: 0, color: 'var(--tw-accent)' } }, cell.delta),
          ),
        ),
      ),
    ),
    React.createElement(
      'div',
      { className: 'tw-panel' },
      sectionHead(model.curve.title, model.curve.note),
      // 回放滑块（本地切换：只换展示的那一天，不发请求）
      model.replay === null
        ? null
        : React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 6px', flexWrap: 'wrap' } },
            React.createElement('span', { className: 'tw-hint', style: { margin: 0 } }, '回放'),
            React.createElement('input', {
              type: 'range',
              min: 0,
              max: Math.max(0, io.maxStep),
              step: 1,
              value: Math.min(io.step, Math.max(0, io.maxStep)),
              'aria-label': '回放最近三十个交易日',
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => io.onStep(Number(e.target.value)),
              style: { flex: 1, minWidth: 160, maxWidth: 320 },
            }),
            React.createElement('span', { className: 'tw-hint', style: { margin: 0 } }, `第 ${io.step + 1} / ${Math.max(1, io.maxStep + 1)} 个交易日`),
            React.createElement('span', { style: { fontSize: 11.5 } }, model.replay.days[Math.min(io.step, model.replay.days.length - 1)] ?? '—'),
            React.createElement('span', { className: 'tw-hint', style: { margin: 0 } }, '（0 = 最新）'),
          ),
      hasCurve
        ? React.createElement(curveChart, { days: model.curve.days, series: model.curve.series, marks: model.curve.marks })
        : React.createElement('div', { style: PLACEHOLDER_BOX }, model.curve.empty),
      React.createElement('div', { className: 'tw-hint', style: { margin: '6px 0 0' } }, model.replay === null ? '' : model.replay.note),
    ),
    React.createElement(
      'div',
      { className: 'tw-panel' },
      sectionHead(model.pie.title, model.pie.note),
      hasPie
        ? React.createElement(
            'div',
            { style: { display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' } },
            React.createElement(pieChart, { slices: model.pie.slices, center: model.pie.center }),
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 } },
              model.pie.slices.map((slice) =>
                React.createElement(
                  'div',
                  { key: slice.label, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 } },
                  React.createElement('span', { style: { width: 10, height: 10, borderRadius: 2, background: FLOW_SERIES_COLORS[(slice.index ?? 0) % FLOW_SERIES_COLORS.length] } }),
                  React.createElement('span', null, slice.label),
                  React.createElement('span', { className: 'tw-hint', style: { margin: 0 } }, slice.text),
                ),
              ),
            ),
          )
        : React.createElement('div', { style: PLACEHOLDER_BOX }, model.pie.empty),
      model.pie.slices.length === 0 || model.pie.slices.length === model.market.rows.length
        ? null
        : React.createElement('div', { className: 'tw-hint', style: { margin: '6px 0 0' } }, `${NOT_FETCHED} 的市场未进饼图（原因见下表逐行说明）`),
    ),
    React.createElement(
      'div',
      { className: 'tw-panel' },
      sectionHead(model.market.title, model.market.note),
      React.createElement(
        'table',
        { style: { width: '100%', borderCollapse: 'collapse', fontSize: 11.5 } },
        React.createElement(
          'thead',
          null,
          React.createElement(
            'tr',
            null,
            model.market.columns.map((col) => React.createElement('th', { key: col, style: { textAlign: 'left', padding: '4px 6px', color: 'var(--tw-muted)', fontWeight: 500 } }, col)),
          ),
        ),
        React.createElement(
          'tbody',
          null,
          hasRows
            ? model.market.rows.flatMap((row, i) => {
                const cells = React.createElement(
                  'tr',
                  { key: `${i}-row`, className: 'tw-rowhover' },
                  row.map((text, j) =>
                    React.createElement(
                      'td',
                      { key: `${i}-${j}`, style: { padding: '4px 6px', color: text === NOT_FETCHED ? 'var(--tw-muted)' : 'var(--tw-text)', whiteSpace: 'nowrap' } },
                      text,
                    ),
                  ),
                )
                const note = model.market.rowNotes[i]
                if (note === null || note === undefined) return [cells]
                return [
                  cells,
                  React.createElement(
                    'tr',
                    { key: `${i}-note` },
                    // ⚠ 逐行缺口原因**不用 `tw-hint`**：红线是"缺数据必须给原因"，
                    // 而紧凑/隐身档会隐藏 `.tw-hint` ⇒ 那一行只剩「未取到」没有原因（AUDIT-IMPL46 §2）。
                    // 只有缺数据的行才有这行说明，正常情形零成本。
                    React.createElement(
                      'td',
                      { 'data-role': 'tool-row-note', colSpan: Math.max(1, model.market.columns.length), style: { padding: '0 6px 6px', color: 'var(--tw-muted)', fontSize: 10.5, lineHeight: 1.5 } },
                      `${NOT_FETCHED}：${note}`,
                    ),
                  ),
                ]
              })
            : React.createElement(
                'tr',
                null,
                React.createElement(
                  'td',
                  { colSpan: Math.max(1, model.market.columns.length), style: { padding: '8px 6px', color: 'var(--tw-muted)' } },
                  model.market.empty,
                ),
              ),
        ),
      ),
      model.market.footnotes.length === 0
        ? null
        : React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 } },
            model.market.footnotes.map((line) => React.createElement('div', { key: line, className: 'tw-hint', style: { margin: 0 } }, line)),
          ),
    ),
    // 附加块（A股净流入：单列，不参与份额计算）
    model.extras.map((extra) =>
      React.createElement(
        'div',
        { className: 'tw-panel', key: extra.title },
        sectionHead(extra.title, model.boundary.note),
        React.createElement('div', { style: { fontSize: 11.5, lineHeight: 1.6 } }, extra.text),
      ),
    ),
    React.createElement(
      'div',
      { className: 'tw-panel' },
      sectionHead(model.boundary.title, model.boundary.note),
      React.createElement(
        'ul',
        { 'data-role': 'tool-legal', style: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 } },
        // ⚠ 边界声明（含「不是真实跨境资金净流入」这条免责）**不许用 `tw-hint`**：
        // 那个类在紧凑/隐身视图下 display:none（styles.ts:90-98），会把免责声明整块藏掉。
        // 这里改用等价的内联样式 ⇒ 任何视图档下都默认可见（AUDIT-IMPL46 §4）。
        model.boundary.lines.map((line) =>
          React.createElement('li', { key: line, 'data-role': 'tool-legal-line', style: { margin: 0, fontSize: 11, lineHeight: 1.65, color: 'var(--tw-muted)' } }, line),
        ),
      ),
    ),
  )
}

/** 区块标题行（标题 + 口径/原因；口径行是 `未取到` 的原因，缺数据必须给原因） */
function sectionHead(title: string, note: string): React.ReactElement {
  return React.createElement(
    'div',
    { className: 'tw-panel-h' },
    React.createElement('span', { className: 't' }, title),
    React.createElement('span', { className: 'tw-hint', style: { margin: 0 } }, note),
  )
}

/**
 * 份额曲线（页面内联 SVG，无动画）。
 *
 * 缺的点画**断**（不连成假线）：某个市场某天没有值就断开，绝不插值补点。
 */
function curveChart(props: { days: string[]; series: Array<{ name: string; points: Array<number | null> }>; marks: Array<{ index: number; label: string }> }): React.ReactElement {
  const W = 720
  const H = 180
  const PAD_L = 34
  const PAD_B = 16
  const PAD_T = 8
  const values: number[] = []
  for (const s of props.series) for (const v of s.points) if (v !== null && Number.isFinite(v)) values.push(v)
  if (values.length === 0) return React.createElement('div', { style: PLACEHOLDER_BOX }, `${NOT_FETCHED}：曲线里没有任何可用份额`)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min < 0.05 ? 0.05 : max - min
  const x = (i: number): number => (props.days.length <= 1 ? PAD_L : PAD_L + (i * (W - PAD_L - 8)) / (props.days.length - 1))
  const y = (v: number): number => PAD_T + (1 - (v - min) / span) * (H - PAD_T - PAD_B)
  const paths: React.ReactElement[] = []
  props.series.forEach((s, si) => {
    let d = ''
    let open = false
    s.points.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        open = false
        return
      }
      d += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `
      open = true
    })
    if (d !== '') {
      paths.push(
        React.createElement('path', {
          key: `line-${si}`,
          d: d.trim(),
          fill: 'none',
          stroke: FLOW_SERIES_COLORS[si % FLOW_SERIES_COLORS.length],
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
      )
    }
  })
  const yTicks = [min, min + span / 2, max]
  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
    React.createElement(
      'svg',
      { viewBox: `0 0 ${W} ${H}`, style: { width: '100%', height: 180, overflow: 'visible' }, role: 'img', 'aria-label': `份额曲线（${props.days[0]} 至 ${props.days[props.days.length - 1]}）` },
      yTicks.map((t, i) =>
        React.createElement(
          'g',
          { key: `tick-${i}` },
          React.createElement('line', { x1: PAD_L, x2: W - 8, y1: y(t), y2: y(t), stroke: 'var(--tw-border)', strokeWidth: 0.7, strokeDasharray: i === 1 ? '3 3' : undefined }),
          React.createElement('text', { x: 2, y: y(t) + 3.5, fontSize: 9, fill: 'var(--tw-muted)' }, `${t.toFixed(1)}%`),
        ),
      ),
      props.marks.map((mk) =>
        React.createElement('circle', {
          key: `mark-${mk.index}`,
          cx: x(mk.index),
          cy: H - PAD_B,
          r: 2.2,
          fill: 'var(--tw-accent)',
          'aria-label': mk.label,
        }),
      ),
      paths,
      React.createElement('text', { x: PAD_L, y: H - 3, fontSize: 9, fill: 'var(--tw-muted)' }, props.days[0]),
      React.createElement('text', { x: W - 8, y: H - 3, fontSize: 9, fill: 'var(--tw-muted)', textAnchor: 'end' }, props.days[props.days.length - 1]),
    ),
    React.createElement(
      'div',
      { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
      props.series.map((s, i) =>
        React.createElement(
          'span',
          { key: s.name, style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--tw-muted)' } },
          React.createElement('span', { style: { width: 10, height: 3, background: FLOW_SERIES_COLORS[i % FLOW_SERIES_COLORS.length] } }),
          s.name,
        ),
      ),
    ),
    props.marks.length === 0
      ? null
      : React.createElement('div', { className: 'tw-hint', style: { margin: 0 } }, `曲线下方的圆点 = 实测日（${props.marks.map((m) => m.label.replace(' 实测', '')).slice(-3).join('、')}）；其余为重建日`),
  )
}

/** 静态饼图（无动画、无自动播放）：缺份额的市场不进饼图，说明由模型给出 */
function pieChart(props: { slices: Array<{ label: string; text: string; value: number | null; index?: number }>; center: string | null }): React.ReactElement {
  const SIZE = 168
  const R = 78
  const CX = SIZE / 2
  const CY = SIZE / 2
  const total = props.slices.reduce((s, x) => s + (x.value ?? 0), 0)
  let angle = -Math.PI / 2
  const arcs: React.ReactElement[] = []
  props.slices.forEach((slice, i) => {
    const value = slice.value ?? 0
    if (!(value > 0) || total <= 0) return
    const sweep = (value / total) * Math.PI * 2
    const a1 = angle
    const a2 = angle + sweep
    angle = a2
    const x1 = CX + R * Math.cos(a1)
    const y1 = CY + R * Math.sin(a1)
    const x2 = CX + R * Math.cos(a2)
    const y2 = CY + R * Math.sin(a2)
    const large = sweep > Math.PI ? 1 : 0
    arcs.push(
      React.createElement('path', {
        key: `arc-${slice.label}`,
        d: `M ${CX} ${CY} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`,
        fill: FLOW_SERIES_COLORS[(slice.index ?? i) % FLOW_SERIES_COLORS.length],
        stroke: 'var(--tw-card)',
        strokeWidth: 1,
      }),
    )
  })
  return React.createElement(
    'svg',
    { viewBox: `0 0 ${SIZE} ${SIZE}`, width: SIZE, height: SIZE, role: 'img', 'aria-label': `份额饼图${props.center === null ? '' : `（${props.center}）`}` },
    arcs,
    // 中心留白（放选中的那一天；饼图本身是静态的，不做动画/自动播放）
    React.createElement('circle', { cx: CX, cy: CY, r: 30, fill: 'var(--tw-card)' }),
    React.createElement('text', { x: CX, y: CY + 3, fontSize: 10.5, fill: 'var(--tw-muted)', textAnchor: 'middle' }, props.center ?? ''),
  )
}
