/**
 * 工具箱页（主面板里的一个页）：**目录页 + 工具详情页容器**。
 *
 * 布局（用户 v0.81.0 的口径）：
 *   目录页 = 分类标签行（本轮只有「全部」）+ 三列卡片网格；卡片 = 左上角标识 chip / 标题 / 一句话说明，
 *            **整卡可点**（阴影 + 圆角、原生 button）。
 *            ⚠ 已按用户要求删掉的三样（`toolsPage.test.ts` 有"全页不许再出现"的断言）：
 *              页标题与计数那一行（`docs/AUDIT-IMPL43.md` §7）、卡片页脚入口文案、
 *              **页级返回控件**与**搜索框**（v0.81.0：工具页是顶层页签 ⇒ 返回无意义；搜索被判冗余）。
 *   详情页 = **三段式**（向用户参考版对齐）：
 *           ① Hero：kicker 小标签 + 大标题 + 一段说明，右上角**时间范围分段控件**（90 / 180 / 365 序列日）；
 *           ② 摘要卡 ×2：`资金蛋糕`（五市场合计规模 + 集中度状态词）｜`当前偏好`（份额榜首市场）；
 *           ③ 图表卡：标题 + 右侧 `AS OF <日期>` + **四个 KPI 磁贴**（名称 + 值 + delta）+ 主图
 *              （带图例、右侧纵轴）+ 本地回放滑块；
 *           其后仍是**功能块**：静态饼图 / 市场表（份额 + 变化）/ A股净流入单列 / 边界声明。
 *
 * 数据：由工具自己的 `load()` 取一次（见 `tools/cake.ts` 与 `tools/globalFlowView.ts`），
 * 页面**只渲染** `detailModel()` 的输出 —— 页面里不算份额、不造数、不写第二份占位文案。
 * 时间范围只做**本地切片**（宿主一次构建到最大窗口）⇒ 切档不发请求。
 * 主题：一切都用 `var(--tw-*)`（跟随 DSH 主题）与既有 class（`.tw-panel` / `.tw-tab` / `.tw-hint` / `.tw-empty`），
 * **不硬编码深色**；颜色取 `FLOW_SERIES_COLORS`（全部是主题 token）。
 */
import React, { useEffect, useMemo, useState } from 'react'
import {
  CATEGORY_TABS,
  NOT_FETCHED,
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

/**
 * 工具箱页。**不接任何 props**（v0.81.0：页级返回控件已删 ⇒ `onBack` 与 `toolsNav.ts` 一并删除）。
 */
export function ToolsPage(): React.ReactElement {
  const [category, setCategory] = useState('all')
  /** 打开的工具 id；null = 目录页 */
  const [openId, setOpenId] = useState<string | null>(null)
  /** 工具数据：一次取数（`load()`）+ 本地回放（`at(step, range)`，不发请求） */
  const [payload, setPayload] = useState<ToolPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [step, setStep] = useState(0)
  /** 曲线窗口档位；null = 用工具声明的默认档（本地切片，不发请求） */
  const [rangeDays, setRangeDays] = useState<number | null>(null)

  const model = useMemo(() => catalogModel(TOOL_ENTRIES, category, CATEGORY_TABS), [category])
  const entry = openId === null ? null : toolById(openId)
  const loader = entry?.load

  useEffect(() => {
    setPayload(null)
    setLoadError(null)
    setStep(0)
    setRangeDays(null)
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

  // 选中档 = 用户选过的档，否则工具声明的默认档
  const selectedRange = rangeDays ?? entry?.ranges?.initial ?? null
  const data: ToolData | null = useMemo(() => {
    if (loader === undefined) return null
    if (loadError !== null) return { status: `${NOT_FETCHED}：${loadError}`, why: loadError }
    if (payload === null) return null
    return payload.at(step, selectedRange ?? undefined)
  }, [loader, loadError, payload, step, selectedRange])

  return React.createElement(
    'div',
    { className: 'tw-tools', style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' } },
    entry === null
      ? catalogView(model, { category, setCategory, onOpen: setOpenId })
      : detailView(detailModel(entry, data), () => setOpenId(null), {
          loading: loader !== undefined && data === null && loadError === null,
          step,
          maxStep: payload === null ? 0 : payload.replayMax,
          onStep: setStep,
          onRange: setRangeDays,
        }),
  )
}

/** 目录页：分类标签行 + 三列卡片网格（搜索框已按用户要求删除） */
function catalogView(
  model: ReturnType<typeof catalogModel>,
  io: { category: string; setCategory: (v: string) => void; onOpen: (id: string) => void },
): React.ReactElement {
  return React.createElement(
    'div',
    { 'data-role': 'tool-catalog', style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px 12px', minHeight: 0 } },
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

/** 时间范围分段控件（Hero 右上角）：三档可切换，切档只做本地切片 */
function rangeControl(model: DetailModel, io: { onRange: (n: number) => void }): React.ReactElement | null {
  if (model.ranges.options.length === 0) return null
  return React.createElement(
    'div',
    { className: 'tw-tabs', 'data-role': 'tool-range', role: 'group', 'aria-label': '时间范围', style: { border: 'none', background: 'transparent', padding: 0 } },
    model.ranges.options.map((n) =>
      React.createElement(
        'button',
        {
          key: n,
          className: 'tw-tab',
          type: 'button',
          'data-role': 'tool-range-option',
          'data-value': n,
          'data-on': model.ranges.selected === n,
          'aria-pressed': model.ranges.selected === n,
          title: `曲线窗口：最近 ${n} 个序列日（本地切片，不发请求）`,
          onClick: () => io.onRange(n),
        },
        `${n}日`,
      ),
    ),
  )
}

/** Hero：kicker 小标签 + 大标题 + 一段说明（说明只留必要事实，细节在 title 里） */
function heroView(model: DetailModel, io: { onRange: (n: number) => void }): React.ReactElement {
  return React.createElement(
    'div',
    { 'data-role': 'tool-hero', style: { display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' } },
    React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 220, flex: 1 } },
      React.createElement(
        'span',
        {
          'data-role': 'tool-hero-kicker',
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
        model.hero.kicker,
      ),
      React.createElement('div', { style: { fontSize: 17, fontWeight: 600 } }, model.hero.title),
      React.createElement('div', { style: { fontSize: 11.5, lineHeight: 1.6, color: 'var(--tw-muted)' } }, model.hero.note),
    ),
    rangeControl(model, io),
  )
}

/** 两张摘要卡：值 + 状态词（值一律来自数据；取不到 ⇒ 未取到） */
function summaryCards(model: DetailModel): React.ReactElement | null {
  if (model.summary.length === 0) return null
  return React.createElement(
    'div',
    { 'data-role': 'tool-summary', style: { display: 'grid', gridTemplateColumns: `repeat(${Math.min(2, Math.max(1, model.summary.length))}, minmax(0, 1fr))`, gap: 8 } },
    model.summary.map((card) =>
      React.createElement(
        'div',
        { key: card.key, 'data-role': 'tool-summary-card', className: 'tw-panel', style: { padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 2 } },
        React.createElement('div', { className: 'tw-hint', style: { margin: 0 } }, card.label),
        React.createElement('div', { style: { fontSize: 16, fontWeight: 600, color: card.value === NOT_FETCHED ? 'var(--tw-muted)' : 'var(--tw-text)' } }, card.value),
        card.note === null ? null : React.createElement('div', { style: { fontSize: 11, color: 'var(--tw-muted)' } }, card.note),
      ),
    ),
  )
}

/** 详情页：三段式（Hero → 摘要卡 → 图表卡）+ 饼图 / 市场表 / 附加块 / 边界声明 */
function detailView(
  model: DetailModel,
  backToCatalog: () => void,
  io: { loading: boolean; step: number; maxStep: number; onStep: (n: number) => void; onRange: (n: number) => void },
): React.ReactElement {
  const hasCurve = model.curve.series.length > 0 && model.curve.days.length > 0
  const hasPie = model.pie.slices.length > 0
  const hasRows = model.market.rows.length > 0
  return React.createElement(
    'div',
    { 'data-role': 'tool-detail', style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px 12px' } },
    React.createElement(Btn, { onClick: backToCatalog, title: '回到工具目录' }, model.backAction),
    // ── ① Hero（右上角时间范围）② 摘要卡 ────────────────────────────────────────
    heroView(model, io),
    summaryCards(model),
    // ── ③ 图表卡的 KPI 磁贴：值/名称/delta 全部来自模型（工具数据），页面不造数 ─────────
    React.createElement(
      'div',
      { className: 'tw-panel', 'data-role': 'tool-chart-card' },
      React.createElement(
        'div',
        { className: 'tw-panel-h' },
        // 图表卡标题：口径/原因进 title（用户口径：常驻只留必要事实，长文案不占版面但必须可读）
        React.createElement(
          'span',
          { className: 't', 'data-role': 'tool-chart-title', title: `${model.kpi.title}｜${model.kpi.note}`, 'aria-label': `${model.kpi.title}：${model.kpi.note}` },
          model.curve.title,
        ),
        // 常驻状态行：只留必要事实（数据时刻 + 降级标记）；完整口径进 title/aria-label
        React.createElement(
          'span',
          {
            'data-role': 'tool-status',
            title: model.statusTitle,
            'aria-label': model.statusTitle,
            style: { margin: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--tw-muted)', textAlign: 'right', flex: 1 },
          },
          io.loading ? '正在取数…' : model.status,
        ),
        model.chartAsOf === null
          ? null
          : React.createElement('span', { 'data-role': 'tool-chart-asof', style: { fontSize: 11, color: 'var(--tw-muted)', whiteSpace: 'nowrap' } }, `AS OF ${model.chartAsOf}`),
      ),
      React.createElement(
        'div',
        { style: { display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, model.kpi.cells.length)}, minmax(0, 1fr))`, gap: 8, marginBottom: 6 } },
        model.kpi.cells.map((cell) =>
          React.createElement(
            'div',
            { key: cell.label, 'data-role': 'tool-kpi-tile', style: { border: '1px solid var(--tw-border)', borderRadius: 9, padding: '6px 9px', background: 'var(--tw-card2)', minWidth: 0 } },
            React.createElement('div', { className: 'tw-hint', style: { margin: 0 } }, cell.label),
            React.createElement('div', { style: { fontSize: 12.5, color: cell.value === null ? 'var(--tw-muted)' : 'var(--tw-text)', wordBreak: 'break-word' } }, cell.text),
            cell.delta === null ? null : React.createElement('div', { className: 'tw-hint', style: { margin: 0, color: 'var(--tw-accent)' } }, cell.delta),
          ),
        ),
      ),
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
 * 纵轴刻度在**右侧**（向用户参考版对齐）；图例在下方。
 */
function curveChart(props: { days: string[]; series: Array<{ name: string; points: Array<number | null> }>; marks: Array<{ index: number; label: string }> }): React.ReactElement {
  const W = 720
  const H = 180
  const PAD_L = 8
  const PAD_R = 40
  const PAD_B = 16
  const PAD_T = 8
  const values: number[] = []
  for (const s of props.series) for (const v of s.points) if (v !== null && Number.isFinite(v)) values.push(v)
  if (values.length === 0) return React.createElement('div', { style: PLACEHOLDER_BOX }, `${NOT_FETCHED}：曲线里没有任何可用份额`)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min < 0.05 ? 0.05 : max - min
  const x = (i: number): number => (props.days.length <= 1 ? PAD_L : PAD_L + (i * (W - PAD_L - PAD_R)) / (props.days.length - 1))
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
      { viewBox: `0 0 ${W} ${H}`, style: { width: '100%', height: 180, overflow: 'visible' }, role: 'img', 'aria-label': `份额曲线（${props.days[0]} 至 ${props.days[props.days.length - 1]}，共 ${props.days.length} 个序列日）` },
      // 纵轴在右侧：刻度线从左侧画到右轴，标签贴右边
      yTicks.map((t, i) =>
        React.createElement(
          'g',
          { key: `tick-${i}` },
          React.createElement('line', { x1: PAD_L, x2: W - PAD_R, y1: y(t), y2: y(t), stroke: 'var(--tw-border)', strokeWidth: 0.7, strokeDasharray: i === 1 ? '3 3' : undefined }),
          React.createElement('text', { x: W - PAD_R + 4, y: y(t) + 3.5, fontSize: 9, fill: 'var(--tw-muted)' }, `${t.toFixed(1)}%`),
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
      React.createElement('text', { x: W - PAD_R, y: H - 3, fontSize: 9, fill: 'var(--tw-muted)', textAnchor: 'end' }, props.days[props.days.length - 1]),
    ),
    React.createElement(
      'div',
      { 'data-role': 'tool-chart-legend', style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
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
