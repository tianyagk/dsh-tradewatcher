/**
 * 工具②「杠杆温度计」的**专用详情页**（本仓库唯一不共享通用三段式骨架的详情页）。
 *
 * 为什么必须专用（用户口径的页面规格逐条落地）：
 *   · 通用详情页自带 Hero 说明段、区的口径行、方法/边界两段散文 —— 而本工具的规格是
 *     **页面上唯一的说明文字是 `截至 YYYY-MM-DD`**（多一个字都不要）⇒ 那些区块一个都不能渲染；
 *   · 通用详情页的时间范围控件是"本地切片 90/180/365 序列日"，本工具的窗口是**查询参数**
 *     （`range=250|750|all`），切档要重新取数 ⇒ 控件与语义都不一样。
 *
 * 页面元素（顺序即渲染顺序；`data-role` 是断言的锚点）：
 *   ⓪ 顶行：左上角回目录按钮 + 右上角窗口三档（原来放在大字区右侧，大字搬走后挪到这里 —— **不留空位**）；
 *   ① `leverage-cards`：**两行 × 四列、共 8 张**摘要卡 ——
 *      第一行：温度（原大字搬进卡片，带 `/ 100` 与 `截至 …`）/ 显性融资 / 杠杆率 / 当日融资净买入；
 *      第二行：融资余额 / 融券余额 / 流通市值 / 窗口累计净买入（随窗口变）；
 *   ② `leverage-chart-card`：图例（温度 / 显性融资比例 / 净买入）→ 主图
 *      （**双轴 + 两条线 + 阈值右端胶囊 + 水平网格线 + ≥6 个 X 刻度 + 柱区独立小轴**），
 *      悬停时给一个**紧凑读数框**（该日三个数），**没有十字光标、没有解释文字**。
 *
 * 数据：`api.leverage(range)`（宿主 `/tradewatcher/leverage`）。取数三件套沿用既有做法 ——
 *   · **单飞**：同一个窗口在飞时不再发第二次（`inFlight` 集合）；
 *   · **超时**：`api.ts` 的 `request()` 统一 15 秒上限；
 *   · **代号丢弃旧响应**：`createRequestGen()`（`requestGen.ts` 的既有实现），旧代响应整体丢弃。
 * 每个窗口取到后进本地缓存 ⇒ 切回去命中缓存、**零请求零闪烁**（画布不卸载、不重挂载）。
 *
 * 缺失：任何数值缺失 ⇒ `—`（破折号），不加文字、不写 0（判据见 `tools/leverageView.ts`）。
 * 失败：显示 `ErrorNote` + 可点的「重试」（`data-verb="leverage-retry"`），保留已取到的图。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { LeveragePayloadDto, LeverageRange } from './api.ts'
import { api } from './api.ts'
import { createRequestGen } from './requestGen.ts'
import {
  CARD_SURFACE,
  CHART_STACK,
  CHART_TYPE,
  LEGEND_DOT,
  LEGEND_ROW,
  PLOT,
  RANGE_BOX,
  RANGE_OFF,
  RANGE_ON,
  RANGE_TYPE,
  SUMMARY_TYPE,
  TOOL_SPACE,
} from './toolDetailTheme.ts'
import {
  DASH,
  LEVERAGE_DEFAULT_RANGE,
  LEVERAGE_LEGEND,
  LEVERAGE_PLOT_HEIGHT,
  LEVERAGE_RANGES,
  leverageCards,
  leverageChart,
  leverageIndexAt,
  leverageReadout,
  leverageXAt,
  type LeverageChart,
  type LeverageReadout,
} from './tools/leverageView.ts'
import { Btn, ErrorNote, Skeleton } from './ui.tsx'

/* ────────────────────────────── 取数（单飞 + 超时 + 代号） ────────────────────────────── */

interface LeverageFetch {
  payload: LeveragePayloadDto | null
  error: string | null
}

/**
 * 按窗口取数。`attempt` 变化 = 用户点了「重试」（清掉这一档的失败态重发）。
 *
 * ⚠ 这里**不**在切档时清空 `payload`：清空就是一次白屏/骨架闪烁，而用户口径明确要求"不得闪烁"。
 * 代价是切档瞬间画布仍是上一档的数据（通常一帧到几百毫秒），落地即替换；失败时上方有可点重试。
 */
function useLeverageFetch(range: LeverageRange, attempt: number): LeverageFetch {
  const [payload, setPayload] = useState<LeveragePayloadDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 已取到的窗口（切回 ⇒ 直接命中，零请求） */
  const cache = useRef(new Map<LeverageRange, LeveragePayloadDto>())
  /** 在飞窗口集合（单飞：同一档不重复发） */
  const inFlight = useRef(new Set<LeverageRange>())
  /** 请求代号：旧代响应（含错误）整体丢弃 */
  const gen = useRef(createRequestGen())
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const hit = cache.current.get(range)
    if (hit !== undefined) {
      setPayload(hit)
      setError(null)
      return
    }
    if (inFlight.current.has(range)) return
    inFlight.current.add(range)
    const my = gen.current.next()
    setError(null)
    api
      .leverage(range)
      .then((next) => {
        cache.current.set(range, next)
        if (!alive.current || gen.current.stale(my)) return
        setPayload(next)
      })
      .catch((e: unknown) => {
        if (!alive.current || gen.current.stale(my)) return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        // ⚠ 无条件复位：只在 alive 时复位会让一次失败把该档永久卡在"在飞"
        inFlight.current.delete(range)
      })
  }, [range, attempt])

  return { payload, error }
}

/* ────────────────────────────── 绘图区尺寸 ────────────────────────────── */

/**
 * 绘图区尺寸 = **容器真实像素**（与详情页同一套做法：ResizeObserver 量盒子后按像素坐标绘制，
 * 线宽/文字不缩放；量不到时退回 `PLOT` 的回退画布 ⇒ 首帧就有合理画布，不塌陷）。
 *
 * 高度契约由 `LEVERAGE_PLOT_HEIGHT`（`min(58vh, 520px)`）给 —— 图 1 的绘图区约占整页 55–60%。
 */
function useChartBox(ref: React.RefObject<HTMLDivElement | null>): { w: number; h: number } {
  const [size, setSize] = useState<{ w: number; h: number }>({ w: PLOT.fallbackWidth, h: 520 })
  useEffect(() => {
    const el = ref.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box === undefined) return
      const w = Math.max(240, Math.round(box.width))
      const h = Math.max(PLOT.heightMin, Math.round(box.height))
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

/* ────────────────────────────── 主图 ────────────────────────────── */

/**
 * 读数框的**夹取用宽度**（px）：`minWidth` 176 + 左右内边距 16 + 4 余量。
 * 只用于把框夹在画布内（真实 DOM 宽度不参与计算 ⇒ 不会因为排版抖动而抖）。
 */
const READOUT_BOX_W = 196

/**
 * 主图：把 `leverageChart()` 的纯数据画成 SVG，并在悬停时叠一个**紧凑读数框**。
 *
 * · 双轴：左 = 温度 0–100（刻度 0 / 50 / 100），右 = 比例 %（由数据定域）；
 * · 水平线三种：网格（每 25，浅色虚线）/ 阈值（虚线 + 右端彩色胶囊）/ 柱图零轴（实线）；
 * · 柱色来自模型（正 = `--tw-up`、负 = `--tw-down`），此处不碰颜色语义；
 * · 悬停只给读数框（三个数 + 日期），**没有十字光标、没有解释文字**。
 */
function LeveragePlot(props: { payload: LeveragePayloadDto | null }): React.ReactElement {
  const box = useRef<HTMLDivElement | null>(null)
  const size = useChartBox(box)
  const [hover, setHover] = useState<number | null>(null)
  const chart: LeverageChart = useMemo(() => leverageChart(props.payload, size.w, size.h), [props.payload, size.w, size.h])
  const readout: LeverageReadout | null = hover === null ? null : leverageReadout(props.payload, hover)
  // 读数框跟随鼠标（x 与主图同一套映射）：靠右时夹在画布内（不越界、不压右轴刻度）
  const count = (props.payload?.dates ?? []).length
  const hoverX = hover === null ? 0 : leverageXAt(hover, count, chart.width)
  const readoutLeft = Math.min(Math.max(4, hoverX + 14), Math.max(4, chart.width - READOUT_BOX_W - 4))
  return React.createElement(
    'div',
    {
      'data-role': 'leverage-plot',
      ref: box,
      className: 'tw-tool-plot',
      // 高度契约：图 1 的绘图区约占整页 55–60%（判据 = leveragePlotHeightProblems）
      style: { position: 'relative', width: '100%', height: LEVERAGE_PLOT_HEIGHT },
      onMouseMove: (e: React.MouseEvent<HTMLDivElement>) => {
        const rect = e.currentTarget.getBoundingClientRect()
        setHover(leverageIndexAt(e.clientX - rect.left, count, chart.width))
      },
      onMouseLeave: () => setHover(null),
    },
    React.createElement(
      'svg',
      {
        'data-role': 'leverage-svg',
        width: chart.width,
        height: chart.height,
        viewBox: `0 0 ${chart.width} ${chart.height}`,
        style: { display: 'block', width: '100%', height: '100%' },
        role: 'img',
        'aria-label': '杠杆温度计',
      },
      // 水平线：网格（浅色虚线）/ 阈值（虚线）/ 柱图零轴（实线）—— 颜色与虚线与否都来自模型
      chart.lines.map((line, i) =>
        React.createElement('line', {
          key: `line-${line.role}-${i}`,
          'data-role': `leverage-${line.role}`,
          x1: line.x1,
          x2: line.x2,
          y1: line.y1,
          y2: line.y2,
          stroke: line.color,
          strokeWidth: line.role === 'zero' ? 1 : 0.8,
          strokeDasharray: line.dash ? (line.role === 'grid' ? '2 4' : '3 3') : undefined,
        }),
      ),
      chart.bars.map((bar, i) =>
        React.createElement('rect', {
          key: `bar-${i}`,
          'data-role': 'leverage-net-bar',
          x: bar.x,
          y: bar.y,
          width: bar.w,
          height: bar.h,
          fill: bar.color,
        }),
      ),
      // 阈值胶囊（右端彩色药丸）：数字写在它里面
      chart.capsules.map((cap, i) =>
        React.createElement('rect', {
          key: `cap-${i}`,
          'data-role': 'leverage-threshold-capsule',
          x: cap.x,
          y: cap.y,
          width: cap.w,
          height: cap.h,
          rx: cap.h / 2,
          ry: cap.h / 2,
          fill: cap.fill,
        }),
      ),
      chart.paths.map((path) =>
        React.createElement('path', {
          key: `path-${path.role}`,
          'data-role': `leverage-line-${path.role}`,
          d: path.d,
          fill: 'none',
          stroke: path.color,
          strokeWidth: 1.8,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
      ),
      chart.texts.map((text, i) =>
        React.createElement(
          'text',
          {
            key: `text-${text.role}-${i}`,
            'data-role': `leverage-${text.role}`,
            x: text.x,
            y: text.y,
            fontSize: 12,
            fill: text.role === 'threshold-label' ? 'var(--tw-card)' : 'var(--tw-muted)',
            fontWeight: text.role === 'threshold-label' ? 600 : undefined,
            textAnchor: text.anchor,
          },
          text.text,
        ),
      ),
    ),
    readout === null
      ? null
      : React.createElement(
          'div',
          {
            'data-role': 'leverage-readout',
            className: 'tw-chart-tip tw-glass',
            'data-open': 'true',
            style: { left: readoutLeft, top: 8, minWidth: 176 },
          },
          React.createElement(
            'div',
            { className: 'tw-chart-tip-row' },
            React.createElement('span', { className: 'tw-chart-tip-k' }, readout.day),
          ),
          readout.rows.map((row) =>
            React.createElement(
              'div',
              { key: row.name, className: 'tw-chart-tip-row' },
              React.createElement(
                'span',
                { className: 'tw-chart-tip-k', style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                React.createElement('span', { 'data-role': 'leverage-readout-dot', style: { ...LEGEND_DOT, width: 7, height: 7, background: row.color } }),
                row.name,
              ),
              React.createElement('span', { className: `tw-chart-tip-v${row.text === DASH ? ' tw-muted' : ''}` }, row.text),
            ),
          ),
        ),
  )
}


/* ────────────────────────────── 图例 / 窗口控件 ────────────────────────────── */

/** 图例（**居中**、圆点；名称与颜色来自模型，画出来的线取同一份颜色） */
function legendRow(): React.ReactElement {
  return React.createElement(
    'div',
    { 'data-role': 'leverage-legend', style: LEGEND_ROW },
    LEVERAGE_LEGEND.map((item) =>
      React.createElement(
        'span',
        { key: item.name, style: { display: 'inline-flex', alignItems: 'center', gap: 6, ...CHART_TYPE.legend } },
        React.createElement('span', { 'data-role': 'leverage-legend-dot', style: { ...LEGEND_DOT, background: item.color } }),
        item.name,
      ),
    ),
  )
}

/**
 * 窗口三档（`1 年 / 3 年 / 全历史`）：凹陷容器 + 选中档浅底圆角块（与详情页同一批令牌）。
 * 点击只改 `range` ⇒ 只换同一个接口的查询参数（不新增接口、不做本地切片）。
 */
function rangeSwitch(range: LeverageRange, onPick: (next: LeverageRange) => void): React.ReactElement {
  return React.createElement(
    'div',
    { 'data-role': 'leverage-range', className: 'tw-tool-range', role: 'group', 'aria-label': '窗口', style: RANGE_BOX },
    LEVERAGE_RANGES.map((option) =>
      React.createElement(
        'button',
        {
          key: option.range,
          type: 'button',
          'data-role': 'leverage-range-option',
          'data-range': option.range,
          'data-on': range === option.range,
          'aria-pressed': range === option.range,
          onClick: () => onPick(option.range),
          style: { ...RANGE_TYPE, ...(range === option.range ? RANGE_ON : RANGE_OFF) },
        },
        option.label,
      ),
    ),
  )
}

/* ────────────────────────────── 详情页 ────────────────────────────── */

/**
 * 详情页本体。`back` 是左上角的回目录控件（由工具箱页注入 ⇒ 回目录按钮仍然只有一份实现）。
 */
export function LeverageDetail(props: { back?: React.ReactNode }): React.ReactElement {
  const [range, setRange] = useState<LeverageRange>(LEVERAGE_DEFAULT_RANGE)
  const [attempt, setAttempt] = useState(0)
  const { payload, error } = useLeverageFetch(range, attempt)
  const cards = leverageCards(payload)
  const loading = payload === null && error === null

  return React.createElement(
    'div',
    {
      'data-role': 'leverage-detail',
      className: 'tw-tool-detail',
      style: { display: 'flex', flexDirection: 'column', gap: TOOL_SPACE.sectionGap, padding: '12px 16px 24px' },
    },
    // ── ⓪ 顶行：回目录 + 窗口三档（大字搬进卡片后不留空位）────────────────────
    React.createElement(
      'div',
      { 'data-role': 'leverage-top', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      props.back ?? null,
      React.createElement('span', { style: { marginLeft: 'auto' } }, rangeSwitch(range, setRange)),
    ),
    // ── ① 两行 × 四列、共 8 张卡（缺值就是 `—`）──────────────────────────────────
    React.createElement(
      'div',
      { 'data-role': 'leverage-cards', className: 'tw-lev-cards', style: { gap: TOOL_SPACE.tileGap } },
      cards.map((card) =>
        React.createElement(
          'div',
          { key: card.key, 'data-role': 'leverage-card', 'data-key': card.key, className: 'tw-tool-card', style: { ...CARD_SURFACE, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
          React.createElement('div', { 'data-role': 'leverage-card-label', style: SUMMARY_TYPE.label }, card.label),
          React.createElement(
            'div',
            {
              'data-role': 'leverage-card-value',
              style: {
                ...SUMMARY_TYPE.value,
                fontVariantNumeric: 'tabular-nums',
                color: card.value === DASH ? 'var(--tw-muted)' : 'var(--tw-text)',
                display: 'flex',
                alignItems: 'baseline',
                gap: 4,
                flexWrap: 'wrap',
              },
            },
            card.value,
            card.suffix === undefined
              ? null
              : React.createElement(
                  'span',
                  { 'data-role': 'leverage-card-suffix', style: { ...CHART_TYPE.tileValue, fontWeight: 500, color: 'var(--tw-muted)' } },
                  card.suffix,
                ),
          ),
          card.note === undefined
            ? null
            : React.createElement('div', { 'data-role': 'leverage-card-note', style: SUMMARY_TYPE.note }, card.note),
        ),
      ),
    ),
    // ── ② 主图卡：图例在上、画布在下（顺序的唯一来源 = CHART_STACK）────────────────
    React.createElement(
      'div',
      {
        'data-role': 'leverage-chart-card',
        className: 'tw-tool-card',
        style: { ...CARD_SURFACE, display: 'flex', flexDirection: 'column', gap: TOOL_SPACE.cardHeadGap },
      },
      ...CHART_STACK.map((slot) =>
        slot === 'legend'
          ? legendRow()
          : loading
            ? // 骨架也占住同一份高度契约 ⇒ 首屏与加载完成之间没有高度跳变（不闪）
              React.createElement(
                'div',
                { key: 'loading', style: { height: LEVERAGE_PLOT_HEIGHT, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
                React.createElement(Skeleton, { lines: 3 }),
              )
            : React.createElement(LeveragePlot, { key: 'plot', payload }),
      ),
      error === null
        ? null
        : React.createElement(
            'div',
            { 'data-role': 'leverage-error', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            React.createElement(ErrorNote, { error }),
            React.createElement(
              Btn,
              { onClick: () => setAttempt((n) => n + 1), 'data-verb': 'leverage-retry', 'aria-label': '重试' },
              '重试',
            ),
          ),
    ),
  )
}
